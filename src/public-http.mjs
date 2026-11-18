import http from 'node:http';
import https from 'node:https';
import {lookup} from 'node:dns/promises';
import {BlockList, isIP} from 'node:net';
import {open, rm} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';
import {Transform} from 'node:stream';
import {EngineError} from './process.mjs';
import {siteForHost, sites} from './sites/index.mjs';

const excluded = new BlockList();
for (const [network, prefix] of [
	['0.0.0.0', 8],
	['10.0.0.0', 8],
	['100.64.0.0', 10],
	['127.0.0.0', 8],
	['169.254.0.0', 16],
	['172.16.0.0', 12],
	['192.0.0.0', 24],
	['192.0.2.0', 24],
	['192.88.99.0', 24],
	['192.168.0.0', 16],
	['198.18.0.0', 15],
	['198.51.100.0', 24],
	['203.0.113.0', 24],
	['224.0.0.0', 3],
])
	excluded.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
	['2001::', 23],
	['2001:db8::', 32],
	['2002::', 16],
])
	excluded.addSubnet(network, prefix, 'ipv6');

// Fake-IP proxies (Clash, Surge and similar) answer every name from 198.18.0.0/15
// and forward the connection by name. A name that resolves there could still be a
// private host, so the range is accepted only for supported sites and their media
// hosts, and never for an address literal in the URL.
const fakeIp = new BlockList();
fakeIp.addSubnet('198.18.0.0', 15, 'ipv4');
const knownDomains = [
	...new Set([
		...sites.flatMap((s) => [...s.hosts, ...(s.shortHosts ?? []), ...(s.thumbnailHosts ?? [])]),
		'xhscdn.com',
		'xhsimg.com',
		'zhimg.com',
		'zhihu.com',
		'twimg.com',
		'douyinvod.com',
		'zjcdn.com',
		'bilivideo.com',
		'bilivideo.cn',
		'hdslb.com',
		'googlevideo.com',
		'cdninstagram.com',
		'fbcdn.net',
		'threads.com',
		'threads.net',
		'kuaishou.com',
		'kwai.net',
		'kwaicdn.com',
		'yximgs.com',
		'kwimgs.com',
		'gifshow.com',
	]),
];
export function knownHost(host) {
	if (host === 'rednote.com' || host.endsWith('.rednote.com')) return Boolean(siteForHost(host));
	return knownDomains.some((d) => host === d || host.endsWith('.' + d));
}
export function publicAddress({address, family}, resolvedName = false) {
	if (family === 4)
		return !excluded.check(address, 'ipv4') || (resolvedName && fakeIp.check(address, 'ipv4'));
	return /^[23][a-f\d]{3}:/i.test(address) && !excluded.check(address, 'ipv6');
}
export function webUrl(value) {
	let url;
	try {
		url = new URL(value);
	} catch {}
	if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password)
		throw new EngineError('invalid_url', '请输入 HTTP 或 HTTPS 网页或媒体链接。');
	return url;
}
export function explicitLocalOrigin(input, allowLocal) {
	const url = webUrl(input);
	return allowLocal && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
		? url.origin
		: undefined;
}

// Cookies and Authorization are dropped whenever a redirect leaves the origin.
export const withoutCredentials = (headers) =>
	Object.fromEntries(
		Object.entries(headers).filter(
			([name]) => !['cookie', 'authorization'].includes(name.toLowerCase()),
		),
	);

// Resolve once and use the vetted address for the connection, including after a redirect.
export async function openWeb(input, {signal, localOrigin, headers = {}, cookieForUrl} = {}) {
	let url = webUrl(input);
	for (let hop = 0; hop < 7; hop++) {
		signal?.throwIfAborted();
		const host = url.hostname.replace(/^\[|\]$/g, '');
		const local = url.origin === localOrigin && ['127.0.0.1', '::1', 'localhost'].includes(host);
		if (
			!local &&
			(url.port || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local'))
		)
			throw new EngineError('invalid_url', '仅可读取公开网站；本机测试需明确指定回环地址。');
		let records;
		try {
			records = isIP(host)
				? [{address: host, family: isIP(host)}]
				: await lookup(host, {all: true, verbatim: false});
		} catch {
			throw new EngineError('network_error', '无法解析媒体主机。');
		}
		if (
			!records.length ||
			!records.every((r) =>
				local
					? ['127.0.0.1', '::1'].includes(r.address)
					: publicAddress(r, !isIP(host) && knownHost(host)),
			)
		)
			throw new EngineError('invalid_url', '此地址不属于允许读取的网络范围。');
		// A per-URL lookup applies only to this request. Never reuse its result on a redirect.
		const requestCookie = await cookieForUrl?.(url);
		const transport = url.protocol === 'https:' ? https : http;
		const response = await new Promise((resolve, reject) => {
			const req = transport.get(
				url,
				{
					agent: false,
					signal,
					headers: {
						'user-agent': 'Fetchy/1.0',
						'accept-encoding': 'identity',
						...headers,
						...(requestCookie ? {cookie: requestCookie} : {}),
					},
					lookup: (_name, options, done) =>
						options.all ? done(null, records) : done(null, records[0].address, records[0].family),
				},
				resolve,
			);
			req.on('error', () =>
				reject(
					new EngineError(signal?.aborted ? 'cancelled' : 'network_error', '读取网页或媒体失败。'),
				),
			);
		});
		if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
			response.destroy();
			const next = webUrl(new URL(response.headers.location, url));
			// A site's sign-in never follows a redirect to another origin or to plain HTTP.
			if (next.origin !== url.origin) headers = withoutCredentials(headers);
			url = next;
			continue;
		}
		if (response.statusCode < 200 || response.statusCode >= 300) {
			response.destroy();
			throw Object.assign(
				new EngineError(
					[401, 403].includes(response.statusCode) ? 'auth_required' : 'network_error',
					'该资源未允许下载。',
				),
				{httpStatus: response.statusCode},
			);
		}
		return {response, url};
	}
	throw new EngineError('network_error', '网页重定向次数过多。');
}

export async function readBounded(stream, maxBytes) {
	const chunks = [];
	let size = 0;
	for await (const chunk of stream) {
		size += chunk.length;
		if (size > maxBytes) throw new EngineError('size_limit', '资源超过大小上限。');
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}
export async function saveWebFile(input, filepath, options) {
	const {response} = await openWeb(input, options);
	let bytes = 0;
	const limit = options.maxBytes ?? 1024 ** 3;
	const bounded = new Transform({
		transform(chunk, _, done) {
			bytes += chunk.length;
			if (bytes > limit) done(new EngineError('size_limit', '媒体超过大小上限。'));
			else done(null, chunk);
		},
	});
	let file;
	try {
		file = await open(filepath, 'wx', 0o600);
		await pipeline(response, bounded, file.createWriteStream(), {signal: options.signal});
		if (!bytes) throw new EngineError('output_invalid', '媒体为空。');
	} catch (error) {
		response.destroy();
		if (file) {
			await file.close().catch(() => {});
			await rm(filepath, {force: true});
		}
		throw error;
	}

	return {bytes, mimeType: (response.headers['content-type'] ?? '').split(';')[0].toLowerCase()};
}
