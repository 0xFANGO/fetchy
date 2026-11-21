import {siteForHost, unsupportedPlatformMessage} from './sites/index.mjs';

function fail(code, message) {
	throw Object.assign(new Error(message), {code});
}

function readUrl(input) {
	if (typeof input !== 'string' || input.length > 16384)
		fail('invalid_url', '请提供一个视频链接或分享文案。');
	const links = input.trim().match(/https?:\/\/[^\s<>"\u3000]+/g) || [];
	// Accept ordinary share prose and Markdown links without eating URL query values.
	const unique = [
		...new Set(links.map((s) => s.replace(/[)\]，。！；、]+$/g, '').replace(/\\&/g, '&'))),
	];
	if (unique.length !== 1) fail('invalid_url', '每次请提供一个视频链接。');
	let url;
	try {
		url = new URL(unique[0]);
	} catch {
		fail('invalid_url', '链接格式不正确。');
	}
	return url;
}

function targetForUrl(url) {
	if (url.protocol !== 'https:' || url.username || url.password || url.port)
		fail('invalid_url', '仅接受不含凭据和自定义端口的 HTTPS 链接。');
	const site = siteForHost(url.hostname);
	if (!site) fail('unsupported_platform', unsupportedPlatformMessage);
	if (site.shortHosts?.includes(url.hostname)) {
		return {
			platform: site.id,
			id: null,
			url: url.href,
			needsRedirect: true,
			startTimeSeconds: null,
		};
	}
	return {platform: site.id, startTimeSeconds: null, ...site.parse(url)};
}

export function normalizeUrl(input) {
	return targetForUrl(readUrl(input));
}

export function matchingTarget(input, target) {
	try {
		const resolved = targetForUrl(new URL(input));
		return resolved.id && resolved.id === target.id && resolved.platform === target.platform
			? resolved
			: null;
	} catch {
		return null;
	}
}

export async function resolveTarget(input, {signal, fetchImpl = fetch} = {}) {
	let target = normalizeUrl(input);
	if (!target.needsRedirect) return target;
	const expectedPlatform = target.platform;
	for (let hop = 0; hop < 5; hop++) {
		let response;
		try {
			response = await fetchImpl(target.url, {
				redirect: 'manual',
				signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]),
			});
		} catch {
			fail(
				signal?.aborted ? 'cancelled' : 'network_error',
				'短链接展开失败，请使用视频详情页链接。',
			);
		}
		await response.body?.cancel();
		if (![301, 302, 303, 307, 308].includes(response.status))
			fail('redirect_required', '此短链接需要浏览器展开，请复制打开后的具体视频链接。');
		const location = response.headers.get('location');
		if (!location) fail('invalid_url', '短链接缺少跳转地址。');
		target = normalizeUrl(new URL(location, target.url).href);
		if (target.platform !== expectedPlatform) fail('invalid_url', '短链接跳转到了其他平台。');
		if (!target.needsRedirect) return target;
	}
	fail('invalid_url', '短链接跳转次数过多，请使用视频详情页链接。');
}
