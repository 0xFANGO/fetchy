/** Browser-independent platform routing. Platform IDs are always strings. */
const SHORT_HOSTS = new Set(['b23.tv', 'xhslink.com', 'www.xhslink.com', 'v.douyin.com']);
const DOUYIN_SHARE_HOSTS = new Set(['www.iesdouyin.com', 'iesdouyin.com']);
const HOSTS = new Set([
	...SHORT_HOSTS,
	...DOUYIN_SHARE_HOSTS,
	'youtube.com',
	'www.youtube.com',
	'm.youtube.com',
	'music.youtube.com',
	'youtu.be',
	'www.bilibili.com',
	'bilibili.com',
	'm.bilibili.com',
	'www.douyin.com',
	'douyin.com',
	'www.xiaohongshu.com',
	'xiaohongshu.com',
]);

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
	if (url.protocol !== 'https:' || url.username || url.password || url.port)
		fail('invalid_url', '仅接受不含凭据和自定义端口的 HTTPS 链接。');
	if (!HOSTS.has(url.hostname))
		fail('unsupported_platform', '当前仅支持 YouTube、小红书、抖音和 B 站视频链接。');
	return url;
}

function startTime(value) {
	if (!value) return null;
	if (/^\d+(?:\.\d+)?s?$/.test(value)) return Number(value.replace(/s$/, ''));
	const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
	return m && m[0] ? Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0) : null;
}

export function normalizeUrl(input) {
	const u = readUrl(input),
		host = u.hostname;
	if (SHORT_HOSTS.has(host))
		return {
			platform: host.includes('douyin')
				? 'douyin'
				: host.includes('xhs')
					? 'xiaohongshu'
					: 'bilibili',
			id: null,
			url: u.href,
			needsRedirect: true,
			startTimeSeconds: null,
		};
	if (host.includes('youtube') || host === 'youtu.be') {
		const id =
			host === 'youtu.be'
				? u.pathname.split('/')[1]
				: u.pathname === '/watch'
					? u.searchParams.get('v')
					: /^\/(?:shorts|embed|live)\/([^/]+)/.exec(u.pathname)?.[1];
		if (!/^[\w-]{11}$/.test(id || ''))
			fail('invalid_url', '需要具体 YouTube 视频链接，暂不支持频道或播放列表。');
		return {
			platform: 'youtube',
			id,
			url: `https://www.youtube.com/watch?v=${id}`,
			startTimeSeconds: startTime(
				u.searchParams.get('t') ||
					u.searchParams.get('start') ||
					new URLSearchParams(u.hash.slice(1)).get('t'),
			),
		};
	}
	if (host.includes('bilibili')) {
		const id = /^\/video\/(BV[\w]{10}|av\d+)\/?$/.exec(u.pathname)?.[1];
		if (!id) fail('invalid_url', '需要具体 B 站 BV/av 视频链接。');
		const rawPage = u.searchParams.get('p'),
			page = rawPage === null ? 1 : Number(rawPage);
		if (!Number.isSafeInteger(page) || page < 1) fail('invalid_url', 'B 站分 P 参数必须为正整数。');
		return {
			platform: 'bilibili',
			id,
			page,
			url: `https://www.bilibili.com/video/${id}/${page === 1 ? '' : `?p=${page}`}`,
			startTimeSeconds: startTime(u.searchParams.get('t')),
		};
	}
	if (host.includes('douyin')) {
		const id = DOUYIN_SHARE_HOSTS.has(host)
			? /^\/share\/video\/(\d+)\/?$/.exec(u.pathname)?.[1]
			: /^\/video\/(\d+)\/?$/.exec(u.pathname)?.[1] || u.searchParams.get('modal_id');
		if (!/^\d{10,25}$/.test(id || ''))
			fail('invalid_url', '需要具体抖音视频链接或含 modal_id 的页面。');
		return {
			platform: 'douyin',
			id,
			url: `https://www.douyin.com/video/${id}`,
			startTimeSeconds: null,
		};
	}
	const id = /^\/(?:explore|discovery\/item)\/([a-f\d]{24})\/?$/i.exec(u.pathname)?.[1];
	if (!id) fail('invalid_url', '需要具体小红书笔记链接。');
	const canonical = new URL(`https://www.xiaohongshu.com/explore/${id}`);
	for (const key of ['xsec_token', 'xsec_source'])
		if (u.searchParams.has(key)) canonical.searchParams.set(key, u.searchParams.get(key));
	return {platform: 'xiaohongshu', id, url: canonical.href, startTimeSeconds: null};
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
