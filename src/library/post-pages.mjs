import {openWeb, readBounded} from '../public-http.mjs';
import {problem} from './storage.mjs';
import {matchingTarget} from '../urls.mjs';

// Post pages are read as HTML, either by the extension with a same-site request
// from the user's tab or by the native worker with the desktop sign-in. Parsing
// happens only here so both routes produce the same entry.
export const PAGE_LIMIT = 8 * 1024 * 1024;
const MEDIA_HOSTS = {
	xiaohongshu: ['xhscdn.com', 'xhsimg.com', 'xiaohongshu.com'],
	zhihu: ['zhimg.com'],
};
const isHost = (host, domain) => host === domain || host.endsWith('.' + domain);

// Only a test may name a loopback origin, as with the other page readers.
function mediaUrl(raw, platform, loopback) {
	if (typeof raw !== 'string' || !raw) return null;
	let u;
	try {
		if (loopback && raw.startsWith(loopback + '/')) return new URL(raw).href;
		u = new URL(raw.replace(/^\/\//, 'https://').replace(/^http:\/\//i, 'https://'));
	} catch {
		return null;
	}
	if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
	const hosts = MEDIA_HOSTS[platform];
	const regionalMedia =
		platform === 'xiaohongshu' &&
		['sns-web-i10.rednotecdn.com', 'sns-v8.rednotecdn.com', 'sns-v8-ae.rednotecdn.com'].includes(
			u.hostname,
		);
	if (hosts && !regionalMedia && !hosts.some((d) => isHost(u.hostname, d))) return null;
	u.hash = '';
	return u.href;
}
const mediaFor =
	(loopback) =>
	(kind, raw, platform, alt = '') => {
		const url = mediaUrl(raw, platform, loopback);
		return url ? {kind, url, alt} : {kind, missing: true, alt};
	};

// Some sites serialise their state as a JavaScript literal with bare `undefined`,
// `NaN`/`Infinity`, or constructors like `new Map([])` / `new Set([])`.
export function looseJson(source) {
	let out = '',
		inString = false,
		quote = '';
	const skipBalancedParens = (start) => {
		let depth = 0,
			str = false,
			q = '';
		for (let j = start; j < source.length; j++) {
			const ch = source[j];
			if (str) {
				if (ch === '\\') j++;
				else if (ch === q) str = false;
				continue;
			}
			if (ch === '"' || ch === "'") {
				str = true;
				q = ch;
			} else if (ch === '(') {
				depth++;
			} else if (ch === ')') {
				depth--;
				if (depth === 0) return j;
			}
		}
		return -1;
	};
	for (let i = 0; i < source.length; i++) {
		const c = source[i];
		if (inString) {
			out += c;
			if (c === '\\') out += source[++i] ?? '';
			else if (c === quote) inString = false;
			continue;
		}
		if (c === '"' || c === "'") {
			inString = true;
			quote = c;
			out += c;
			continue;
		}
		const prev = source[i - 1] ?? '';
		if (!/[\w$]/.test(prev)) {
			if (source.startsWith('undefined', i) && !/[\w$]/.test(source[i + 9] ?? '')) {
				out += 'null';
				i += 8;
				continue;
			}
			if (source.startsWith('NaN', i) && !/[\w$]/.test(source[i + 3] ?? '')) {
				out += 'null';
				i += 2;
				continue;
			}
			if (source.startsWith('Infinity', i) && !/[\w$]/.test(source[i + 8] ?? '')) {
				if (out.endsWith('-')) out = out.slice(0, -1);
				out += 'null';
				i += 7;
				continue;
			}
			if (source.startsWith('new ', i)) {
				const ctor = /^new\s+(?:Map|Set|Date)\s*\(/.exec(source.slice(i));
				if (ctor) {
					const end = skipBalancedParens(i + ctor[0].length - 1);
					if (end !== -1) {
						out += 'null';
						i = end;
						continue;
					}
				}
			}
		}
		out += c;
	}
	return JSON.parse(out);
}

function scriptAfter(html, marker) {
	const start = html.indexOf(marker);
	if (start === -1) return null;
	const end = html.indexOf('</script>', start);
	if (end === -1) return null;
	return html
		.slice(start + marker.length, end)
		.trim()
		.replace(/;$/, '');
}
const decode = (s) =>
	s
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
		.replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
		.replaceAll('&quot;', '"')
		.replaceAll('&#39;', "'")
		.replaceAll('&lt;', '<')
		.replaceAll('&gt;', '>')
		.replaceAll('&nbsp;', ' ')
		.replaceAll('&amp;', '&');

function postPageError(finalUrl) {
	const path = (() => {
		try {
			return new URL(finalUrl).pathname;
		} catch {
			return '';
		}
	})();
	if (/captcha|verify|security-check/i.test(path))
		return problem('verification_required', 'The site asked for verification.');
	if (/(?:^|\/)(?:website-)?login|signin|passport/i.test(path))
		return problem('login_required', 'The site asked for sign-in.');
	return problem('source_unavailable', 'The page did not contain this post.');
}

function entry(platform, id, sourceUrl, fields) {
	return {
		platform,
		id,
		sourceUrl,
		title: '',
		author: '',
		body: '',
		bodyFormat: 'text',
		bodyComplete: false,
		attachments: [],
		...fields,
	};
}

function xiaohongshu(id, html, sourceUrl, media) {
	const raw = scriptAfter(html, 'window.__INITIAL_STATE__=');
	if (!raw) return null;
	let state;
	try {
		state = looseJson(raw);
	} catch {
		return null;
	}
	const note = state?.note?.noteDetailMap?.[id]?.note;
	if (!note || note.noteId !== id) return null;
	const attachments = [];
	if (note.type === 'video') {
		const streams = Object.values(note.video?.media?.stream || {})
			.flat()
			.filter((v) => v?.masterUrl);
		streams.sort((a, b) => Number(b.width) * Number(b.height) - Number(a.width) * Number(a.height));
		attachments.push(media('video', streams[0]?.masterUrl, 'xiaohongshu'));
	} else {
		for (const img of Array.isArray(note.imageList) ? note.imageList : []) {
			const original =
				img.urlDefault || img.url || img.infoList?.find((x) => x.imageScene === 'WB_DFT')?.url;
			attachments.push(media('image', original, 'xiaohongshu'));
			if (img.livePhoto || img.livePhotoUrl)
				attachments.push(media('video', img.livePhotoUrl || img.videoUrl, 'xiaohongshu'));
		}
	}
	return entry('xiaohongshu', id, sourceUrl, {
		kind: note.type === 'video' ? 'video' : 'post',
		title: String(note.title || ''),
		author: String(note.user?.nickname || ''),
		body: typeof note.desc === 'string' ? note.desc : '',
		bodyComplete: typeof note.desc === 'string',
		attachments,
		...(note.type !== 'video' && !Array.isArray(note.imageList) ? {missing: ['image list']} : {}),
	});
}

function htmlText(fragment, platform, media) {
	const attachments = [];
	const text = fragment
		.replace(/<img\b[^>]*>/gi, (tag) => {
			const src =
				/\bdata-original="([^"]+)"/i.exec(tag)?.[1] ||
				/\bdata-actualsrc="([^"]+)"/i.exec(tag)?.[1] ||
				/\bsrc="([^"]+)"/i.exec(tag)?.[1];
			if (src && !src.startsWith('data:')) attachments.push(media('image', decode(src), platform));
			return '';
		})
		.replace(/<(?:br|\/p|\/h\d|\/li|\/blockquote|\/figure)\b[^>]*>/gi, '\n')
		.replace(/<[^>]+>/g, '');
	return {
		body: decode(text)
			.replace(/\n{3,}/g, '\n\n')
			.trim(),
		attachments,
	};
}

function zhihu(id, html, sourceUrl, media) {
	const raw = /<script id="js-initialData" type="text\/json">([\s\S]*?)<\/script>/.exec(html)?.[1];
	if (!raw) return null;
	let data;
	try {
		data = JSON.parse(raw);
	} catch {
		return null;
	}
	const entities = data?.initialState?.entities;
	const answer = entities?.answers?.[id];
	const record = answer || entities?.articles?.[id];
	if (!record || String(record.id) !== id || typeof record.content !== 'string') return null;
	const {body, attachments} = htmlText(record.content, 'zhihu', media);
	return entry('zhihu', id, sourceUrl, {
		title: String((answer ? answer.question?.title : record.title) || ''),
		author: String(record.author?.name || ''),
		body,
		bodyComplete: body.length > 0,
		attachments,
	});
}

function metaContent(html, name) {
	for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
		const tag = m[0];
		const key = /\b(?:property|name)="([^"]+)"/i.exec(tag)?.[1];
		if (key?.toLowerCase() !== name) continue;
		const content = /\bcontent="([^"]*)"/i.exec(tag)?.[1];
		if (content !== undefined) return decode(content);
	}
	return '';
}

// Without a site reader, OpenGraph only gives a preview; the entry stays partial.
function openGraph(platform, id, html, sourceUrl, media) {
	const title = metaContent(html, 'og:title');
	const description = metaContent(html, 'og:description');
	const video = metaContent(html, 'og:video:secure_url') || metaContent(html, 'og:video');
	const image = metaContent(html, 'og:image');
	if (!title && !description && !video && !image) return null;
	const attachments = [];
	if (video) attachments.push(media('video', video, platform));
	else if (image) attachments.push(media('image', image, platform));
	return entry(platform, id, sourceUrl, {
		title,
		body: description,
		bodyComplete: false,
		attachments: attachments.filter((a) => !a.missing),
		coverage: 'preview',
	});
}

export const readablePlatforms = new Set(['xiaohongshu', 'zhihu']);

/**
 * Turn one post page into a library entry. `pageUrl` is where the HTML came
 * from after redirects. Throws with a stable code when the page is not the post.
 */
export function parsePostPage({platform, id, sourceUrl}, html, pageUrl, {localOrigin} = {}) {
	if (typeof html !== 'string' || html.length > PAGE_LIMIT)
		throw problem('source_unavailable', 'The post page is empty or too large.');
	if (platform === 'xiaohongshu' && !(localOrigin && pageUrl?.startsWith(localOrigin + '/'))) {
		const served = matchingTarget(pageUrl, {platform, id});
		if (!served) throw postPageError(pageUrl);
		sourceUrl = new URL('/explore/' + id, served.url).href;
	}
	const reader = {xiaohongshu, zhihu}[platform];
	const media = mediaFor(localOrigin);
	const parsed = reader
		? reader(id, html, sourceUrl, media)
		: openGraph(platform, id, html, sourceUrl, media);
	if (parsed) return parsed;
	throw postPageError(pageUrl);
}

const BROWSER_UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
export const browserHeaders = (userAgent) => ({
	'user-agent': typeof userAgent === 'string' && userAgent.length < 512 ? userAgent : BROWSER_UA,
	accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
	'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
});

/** Read a post page from the native side. `cookie` belongs to this site only. */
export function normalizeXiaohongshuPostUrl(rawUrl, localOrigin) {
	if (typeof rawUrl !== 'string' || !rawUrl) return rawUrl;
	if (localOrigin && rawUrl.startsWith(localOrigin + '/')) return rawUrl;
	try {
		const u = new URL(rawUrl);
		const m =
			/^\/(?:user\/profile\/[a-f\d]+|board\/[\w-]+|discovery\/item)\/([a-f\d]{24})\/?$/i.exec(
				u.pathname,
			);
		if (!m) return rawUrl;
		const next = new URL('/explore/' + m[1], u.origin);
		for (const key of ['xsec_token', 'xsec_source']) {
			if (u.searchParams.has(key)) next.searchParams.set(key, u.searchParams.get(key));
		}
		return next.href;
	} catch {
		return rawUrl;
	}
}

export async function fetchPostPage(
	item,
	{
		url = item.sourceUrl,
		cookie,
		cookieHeader,
		userAgent,
		signal,
		localOrigin,
		timeoutMs = 60_000,
	} = {},
) {
	if (item.platform === 'xiaohongshu') {
		url = normalizeXiaohongshuPostUrl(url, localOrigin);
	}
	const headers = browserHeaders(userAgent);
	if (item.platform === 'xiaohongshu' && !(localOrigin && url?.startsWith(localOrigin + '/'))) {
		try {
			headers.referer = new URL('/explore', url).href;
		} catch {}
	}
	// A regional redirect can lead to the same note on another site with its own sign-in.
	let cookieForUrl;
	if (item.platform === 'xiaohongshu' && cookieHeader) {
		cookieForUrl = (next) => {
			if (matchingTarget(next.href, item) || next.origin === localOrigin)
				return cookieHeader(next.href);
			return '';
		};
	} else {
		const initialCookie = cookie ?? (await cookieHeader?.(url));
		if (initialCookie) headers.cookie = initialCookie;
	}
	// One stalled site must not hold the serial native queue.
	const deadline = AbortSignal.timeout(timeoutMs);
	const limit = signal ? AbortSignal.any([deadline, signal]) : deadline;
	try {
		const {response, url: finalUrl} = await openWeb(url, {
			cookieForUrl,
			signal: limit,
			localOrigin,
			headers,
		});
		const stop = () => response.destroy();
		limit.addEventListener('abort', stop, {once: true});
		try {
			const html = (await readBounded(response, PAGE_LIMIT)).toString('utf8');
			return parsePostPage(item, html, finalUrl.href, {localOrigin});
		} finally {
			limit.removeEventListener('abort', stop);
		}
	} catch (error) {
		signal?.throwIfAborted();
		if (deadline.aborted) throw problem('timeout', 'The post page did not load in time.');
		if (error.code === 'auth_required')
			throw problem('login_required', 'The site asked for sign-in.');
		throw error;
	}
}
