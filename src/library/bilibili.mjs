import {readFile, stat} from 'node:fs/promises';
import {problem} from './storage.mjs';

const host = 'api.bilibili.com';
async function headersFor(file) {
	const headers = {Accept: 'application/json', Referer: 'https://www.bilibili.com/'};
	if (!file) return headers;
	const info = await stat(file);
	if (!info.isFile() || info.size > 16 * 1024 * 1024)
		throw problem('invalid_options', 'Invalid Netscape cookie file.');
	const cookies = [];
	for (let line of (await readFile(file, 'utf8')).split(/\r?\n/)) {
		if (line.startsWith('#HttpOnly_')) line = line.slice(10);
		if (line.startsWith('#')) continue;
		const [domain, subdomains, p, , expires, k, v] = line.split('\t');
		const d = domain?.replace(/^\./, '').toLowerCase();
		if (
			!d ||
			!(d === host || (d === 'bilibili.com' && subdomains === 'TRUE')) ||
			p !== '/' ||
			(Number(expires) > 0 && Number(expires) * 1000 <= Date.now())
		)
			continue;
		if (/^[\w-]+$/.test(k || '') && typeof v === 'string' && !/[\p{Cc}\s;]/u.test(v))
			cookies.push(k + '=' + v);
	}
	if (cookies.length) headers.Cookie = cookies.join('; ');
	return headers;
}
async function api(path, params, options) {
	const url = new URL(path, 'https://' + host);
	url.search = new URLSearchParams(params);
	let r;
	try {
		r = await (options.fetchImpl || fetch)(url, {
			headers: await headersFor(options.cookiesFile),
			signal: AbortSignal.any([
				AbortSignal.timeout(18000),
				...(options.signal ? [options.signal] : []),
			]),
			redirect: 'error',
		});
	} catch (e) {
		if (options.signal?.aborted) throw e;
		throw problem('network_error', 'Bilibili collection request failed.');
	}
	if (!r.ok)
		throw problem(
			r.status === 401 || r.status === 403 ? 'access_restricted' : 'network_error',
			'Bilibili did not return this collection.',
		);
	let data;
	try {
		data = await r.json();
	} catch {
		throw problem('network_error', 'Invalid Bilibili collection response.');
	}
	if (data.code !== 0 || !data.data)
		throw problem(
			[-101, -403, -352, 7201002].includes(data.code) ? 'access_restricted' : 'unavailable',
			'Bilibili could not return the requested data.',
		);
	return data.data;
}
export function bilibiliFolderId(input) {
	if (typeof input !== 'string') return null;
	if (/^\d{1,18}$/.test(input)) return input;
	try {
		const u = new URL(input);
		if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
		let id;
		if (u.hostname === 'space.bilibili.com' && /^\/\d+\/favlist\/?$/.test(u.pathname))
			id = u.searchParams.get('fid');
		else if (['www.bilibili.com', 'bilibili.com'].includes(u.hostname))
			id = /^\/list\/ml(\d+)\/?$/.exec(u.pathname)?.[1];
		return /^\d{1,18}$/.test(id || '') ? id : null;
	} catch {
		return null;
	}
}
export async function readBilibiliPage(id, page, options = {}) {
	if (!/^\d{1,18}$/.test(id) || !Number.isSafeInteger(page) || page < 1)
		throw problem('invalid_folder', 'Invalid collection or page.');
	const d = await api(
		'/x/v3/fav/resource/list',
		{media_id: id, pn: String(page), ps: '20', platform: 'web'},
		options,
	);
	if (
		String(d.info?.id) !== id ||
		(d.medias !== null && d.medias !== undefined && !Array.isArray(d.medias)) ||
		typeof d.has_more !== 'boolean'
	)
		throw problem('invalid_page', 'Unexpected Bilibili collection response.');
	const entries = (d.medias || []).map((m) => {
		const bvid = typeof m.bvid === 'string' && /^BV[\w]{10}$/.test(m.bvid) ? m.bvid : null;
		// Preserve deleted/unsupported members so a partial collection can't look complete.
		const id = bvid || (m.type === 2 && Number.isSafeInteger(m.id) ? 'av' + m.id : null);
		if (!id || m.type !== 2)
			return {
				platform: 'bilibili',
				id: 'resource-' + String(m.type) + '-' + String(m.id),
				sourceUrl: 'https://www.bilibili.com/',
				title: m.title,
				coverage: 'unavailable_resource',
			};
		return {
			platform: 'bilibili',
			id,
			kind: 'video',
			sourceUrl: 'https://www.bilibili.com/video/' + id + '/',
			title: m.title,
			author: m.upper?.name,
			savedAt:
				Number.isSafeInteger(m.fav_time) && m.fav_time > 0
					? new Date(m.fav_time * 1000).toISOString()
					: null,
		};
	});
	return {
		name: d.info.title || id,
		total: Number.isSafeInteger(d.info.media_count) ? d.info.media_count : null,
		items: entries,
		next: d.has_more ? page + 1 : null,
	};
}
export async function discoverBilibiliFolders(options = {}) {
	const nav = await api('/x/web-interface/nav', {}, options);
	if (!nav.isLogin || !Number.isSafeInteger(nav.mid))
		throw problem('access_restricted', 'Sign in to your Bilibili account and supply its session.');
	const data = await api('/x/v3/fav/folder/created/list-all', {up_mid: String(nav.mid)}, options);
	if (!Array.isArray(data.list) && data.count !== 0)
		throw problem('invalid_page', 'Invalid Bilibili folder response.');
	const folders = (data.list || []).map((f) => ({
		platform: 'bilibili',
		id: String(f.id),
		name: f.title,
		total: f.media_count,
	}));
	return {
		scope: 'created',
		folders,
		complete: Number.isSafeInteger(data.count) && data.count === folders.length,
	};
}
