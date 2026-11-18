import http from 'node:http';
import https from 'node:https';
import {lookup} from 'node:dns/promises';
import {BlockList, isIP} from 'node:net';
import {createWriteStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {Transform} from 'node:stream';
import {EngineError} from './process.mjs';

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

function publicAddress({address, family}) {
	if (family === 4) return !excluded.check(address, 'ipv4');
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

// Resolve once and use the vetted address for the connection, including after a redirect.
export async function openWeb(input, {signal, localOrigin, headers = {}} = {}) {
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
			!records.every((r) => (local ? ['127.0.0.1', '::1'].includes(r.address) : publicAddress(r)))
		)
			throw new EngineError('invalid_url', '此地址不属于允许读取的网络范围。');
		const transport = url.protocol === 'https:' ? https : http;
		const response = await new Promise((resolve, reject) => {
			const req = transport.get(
				url,
				{
					agent: false,
					signal,
					headers: {'user-agent': 'Fetchy/1.0', 'accept-encoding': 'identity', ...headers},
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
			url = webUrl(new URL(response.headers.location, url));
			continue;
		}
		if (response.statusCode < 200 || response.statusCode >= 300) {
			response.destroy();
			throw new EngineError(
				[401, 403].includes(response.statusCode) ? 'auth_required' : 'network_error',
				'该资源未允许下载。',
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
	await pipeline(response, bounded, createWriteStream(filepath, {flags: 'wx', mode: 0o600}), {
		signal: options.signal,
	});
	if (!bytes) throw new EngineError('output_invalid', '媒体为空。');
	return {bytes, mimeType: (response.headers['content-type'] ?? '').split(';')[0].toLowerCase()};
}
