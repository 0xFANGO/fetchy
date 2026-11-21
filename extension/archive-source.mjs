import {
	advanceArchivePage,
	discoverArchiveMedia,
	captureArchivePage,
	readBilibiliCollectionPage,
} from './capture-page.mjs';

// Everything here works on the tab the user is looking at. Fetchy reads more of
// a collection by scrolling or paging that tab in the foreground and never opens
// another tab; post pages for a saved batch are read with same-site requests.
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const error = (code) => Object.assign(new Error(code), {code});
export const key = (item) => item.platform + ':' + item.id;
async function inject(tabId, func, args = []) {
	const [execution] = await chrome.scripting.executeScript({
		target: {tabId},
		world: 'MAIN',
		func,
		args,
	});
	if (!execution?.result) throw error('source_not_ready');
	return execution.result;
}
export function isCollectionRoute(url) {
	const host = url.hostname.replace(/^www\./, '');
	if (host === 'instagram.com') return /^\/[\w.]+\/saved(?:\/|$)/.test(url.pathname);
	if (['threads.com', 'threads.net'].includes(host)) return /^\/saved\/?$/.test(url.pathname);
	if (host === 'tiktok.com') return /^\/@[\w.]+(?:\/collection\/[^/]+)?\/?$/.test(url.pathname);
	return (
		host === 'douyin.com' &&
		!url.searchParams.has('modal_id') &&
		/^\/(?:user\/self|(?:collection|mix)\/\d+)\/?$/.test(url.pathname)
	);
}
export async function capture(tabId, attempts = 10) {
	let snap;
	for (let i = 0; i < attempts; i++) {
		try {
			const tab = await chrome.tabs.get(tabId);
			if (tab.url && isCollectionRoute(new URL(tab.url))) {
				const {captureSocialCollection} = await import('./collection-page.mjs');
				snap = await inject(tabId, captureSocialCollection);
			} else {
				snap = await inject(tabId, captureArchivePage);
			}
		} catch {
			snap = {type: 'unsupported', reason: 'page_access'};
		}
		if (snap.type === 'unsupported' && snap.reason === 'unsupported_page') {
			const t = await chrome.tabs.get(tabId);
			const hosts = [
				'www.kuaishou.com',
				'kuaishou.com',
				'www.threads.com',
				'threads.com',
				'www.threads.net',
				'threads.net',
				'www.instagram.com',
				'instagram.com',
			];
			if (t.url && hosts.includes(new URL(t.url).hostname)) {
				const {captureSocialPost} = await import('./social-post.mjs');
				snap = await inject(tabId, captureSocialPost);
			}
		}
		if (snap.type !== 'unsupported' || !['source_not_ready', 'page_access'].includes(snap.reason))
			break;
		await pause(350);
	}
	return snap;
}
export function mayVisit(raw, platform, sourceOrigin) {
	try {
		const u = new URL(raw);
		if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
		if (platform === 'zhihu')
			return (
				['www.zhihu.com', 'zhuanlan.zhihu.com'].includes(u.hostname) &&
				['https://www.zhihu.com', 'https://zhuanlan.zhihu.com'].includes(sourceOrigin)
			);
		return u.origin === sourceOrigin;
	} catch {
		return false;
	}
}
export async function listVisibleMedia(tabId) {
	return inject(tabId, discoverArchiveMedia);
}
export async function readArchiveSource(tabId) {
	const result = await capture(tabId);
	if (result.type === 'folders' && result.provider === 'bilibili') {
		const data = await inject(tabId, readBilibiliCollectionPage, [null, 1, result.ownerId]);
		if (data.error) throw error(data.error);
		return data;
	}
	if (result.type === 'collection' && result.provider === 'bilibili') {
		const data = await inject(tabId, readBilibiliCollectionPage, [result.folder.id, 1]);
		if (data.error) throw error(data.error);
		return {...data, provider: 'bilibili'};
	}
	return result;
}

/** What the panel has read of one collection so far, in page order. */
export function startCollection(first) {
	const collection = {
		folder: first.folder,
		provider: first.provider,
		items: new Map(),
		pages: [],
		total: first.total ?? null,
		complete: false,
		reason: null,
		nextUrl: null,
		nextPage: null,
		stalled: 0,
	};
	mergePage(collection, first);
	return collection;
}
/** Add a newly read page; returns how many entries were new. */
export function mergePage(collection, page) {
	if (page?.type !== 'collection' || key(page.folder) !== key(collection.folder)) {
		collection.reason = 'identity_mismatch';
		return 0;
	}
	const added = [];
	for (const item of page.items || []) {
		if (collection.items.has(key(item))) continue;
		collection.items.set(key(item), item);
		added.push(item);
	}
	if (added.length || !collection.pages.length) collection.pages.push(added);
	collection.total = page.total ?? collection.total;
	collection.nextUrl = page.nextUrl ?? null;
	collection.nextPage = page.nextPage ?? null;
	const total = collection.total;
	if (page.complete && (!Number.isSafeInteger(total) || collection.items.size === total)) {
		collection.complete = true;
		collection.reason = null;
	}
	if (collection.items.size >= 5000 && !collection.complete) collection.reason = 'item_limit';
	return added.length;
}

async function waitForLoad(tabId, url) {
	for (let i = 0; i < 80; i++) {
		const tab = await chrome.tabs.get(tabId);
		if (tab.url === url && tab.status === 'complete') return;
		await pause(250);
	}
	throw error('timeout');
}

/**
 * Read one more screen of the collection in the user's tab: scroll it, load
 * the site's next page in place, or ask Bilibili's API for the next page.
 * The user sees every step and can stop between steps.
 */
export async function readMore(tabId, collection, origin, {fromTop = false} = {}) {
	if (collection.provider === 'bilibili') {
		if (!collection.nextPage) {
			collection.reason = 'count_mismatch';
			return 0;
		}
		const page = await inject(tabId, readBilibiliCollectionPage, [
			collection.folder.id,
			collection.nextPage,
		]);
		if (page.error) {
			collection.reason = page.error;
			return 0;
		}
		return mergePage(collection, {...page, provider: 'bilibili'});
	}
	if (collection.nextUrl) {
		const next = collection.nextUrl;
		if (!mayVisit(next, collection.folder.platform, origin)) {
			collection.reason = 'repeated_cursor';
			return 0;
		}
		await chrome.tabs.update(tabId, {url: next});
		await waitForLoad(tabId, next);
		return mergePage(collection, await capture(tabId));
	}
	// A virtualised list drops rows the user scrolled past: a full read starts at the top.
	const scroll = await inject(tabId, advanceArchivePage, [fromTop]);
	await pause(850);
	const added = mergePage(collection, await capture(tabId, 2));
	const moved = fromTop || scroll.position > scroll.before + 1;
	collection.stalled = added || moved ? 0 : collection.stalled + 1;
	if (collection.stalled >= 3 && !collection.complete) {
		const total = collection.total;
		collection.complete = Number.isSafeInteger(total) && collection.items.size === total;
		collection.reason = collection.complete ? null : 'end_unconfirmed';
	}
	return added;
}

/** Whether reading more cannot add anything. */
export const atEnd = (collection) =>
	collection.complete ||
	[
		'end_unconfirmed',
		'item_limit',
		'identity_mismatch',
		'repeated_cursor',
		'count_mismatch',
	].includes(collection.reason);

/** The library manifest for a collection, in the order its entries were read. */
export function manifestFolder(collection) {
	return {
		...collection.folder,
		total: collection.total,
		pages: collection.pages.map((list, i) => ({
			cursor: i ? 'page-' + i : null,
			nextCursor:
				i + 1 < collection.pages.length ? 'page-' + (i + 1) : collection.complete ? null : 'unread',
			items: list,
		})),
	};
}

// Injected into the user's tab: read one post page with the site's own session
// and keep only what the native parser reads (state scripts and meta tags), so
// the request fits one native message.
export async function readPostPage(url, maxBytes) {
	let response;
	try {
		response = await fetch(url, {
			credentials: 'include',
			redirect: 'follow',
			headers: {Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'},
		});
	} catch {
		return {error: 'network_error'};
	}
	if ([401, 403].includes(response.status)) return {error: 'login_required'};
	if (!response.ok) return {error: 'network_error'};
	try {
		const finalPath = new URL(response.url).pathname;
		if (/^\/404(?:\/|$)|captcha|security-check|(?:^|\/)(?:website-)?login(?:\/|$)/i.test(finalPath))
			return {error: 'redirected', url: response.url};
	} catch {}
	const text = await response.text();
	const parts = [];
	for (const m of text.matchAll(/<meta\b[^>]*>/gi)) parts.push(m[0]);
	for (const m of text.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/gi))
		if (/window\.__INITIAL_STATE__=|id="js-initialData"/.test(m[0])) parts.push(m[0]);
	const html = parts.join('\n');
	if (new TextEncoder().encode(JSON.stringify(html)).length > maxBytes) return {error: 'too_large'};
	return {html, url: response.url, userAgent: navigator.userAgent};
}
export const readPostPageInTab = (tabId, url, maxBytes = 440 * 1024) =>
	inject(tabId, readPostPage, [url, maxBytes]);
