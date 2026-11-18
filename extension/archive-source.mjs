import {
	advanceArchivePage,
	discoverArchiveMedia,
	hydrateArchiveEntry,
	captureArchivePage,
	readBilibiliCollectionPage,
} from './capture-page.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const error = (code) => Object.assign(new Error(code), {code});
const key = (item) => item.platform + ':' + item.id;
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
async function capture(tabId, attempts = 10) {
	let snap;
	for (let i = 0; i < attempts; i++) {
		try {
			snap = await inject(tabId, captureArchivePage);
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
function mayVisit(raw, platform, sourceOrigin) {
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
async function withTab(url, action) {
	const tab = await chrome.tabs.create({url, active: false});
	try {
		for (let i = 0; i < 70; i++) {
			const t = await chrome.tabs.get(tab.id);
			if (t.status === 'complete' && t.url && t.url !== 'about:blank') return await action(tab.id);
			await pause(250);
		}
		throw error('timeout');
	} finally {
		await chrome.tabs.remove(tab.id).catch(() => {});
	}
}
export async function listVisibleMedia(tabId) {
	return inject(tabId, discoverArchiveMedia);
}
export async function hydrateOriginal(tabId, entry) {
	return inject(tabId, hydrateArchiveEntry, [entry]);
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

export async function collectArchivePages(tabId, sourceOrigin, initial, onProgress, signal) {
	const pages = [],
		items = new Map(),
		urls = new Set();
	let complete = false,
		reason = null,
		total = initial.total,
		stalled = 0;
	let page = initial;
	let tempTab;
	try {
		for (let turn = 0; turn < 300; turn++) {
			signal?.throwIfAborted();
			if (page.type !== 'collection' || key(page.folder) !== key(initial.folder)) {
				reason = 'identity_mismatch';
				break;
			}
			const added = [];
			for (const item of page.items || []) {
				const k = key(item);
				if (items.has(k)) continue;
				items.set(k, item);
				added.push(item);
			}
			if (added.length || !pages.length) pages.push(added);
			total = page.total ?? total;
			onProgress?.(items.size, total);
			if (page.complete && (!Number.isSafeInteger(total) || items.size === total)) {
				complete = true;
				break;
			}
			if (items.size >= 5000) {
				reason = 'item_limit';
				break;
			}
			if (page.provider === 'bilibili' || initial.provider === 'bilibili') {
				if (!page.nextPage) {
					reason = 'count_mismatch';
					break;
				}
				if (!added.length && items.size) {
					reason = 'repeated_page';
					break;
				}
				page = await inject(tabId, readBilibiliCollectionPage, [initial.folder.id, page.nextPage]);
				if (page.error) {
					reason = page.error;
					break;
				}
			} else if (page.nextUrl) {
				if (
					!mayVisit(page.nextUrl, initial.folder.platform, sourceOrigin) ||
					urls.has(page.nextUrl)
				) {
					reason = 'repeated_cursor';
					break;
				}
				urls.add(page.nextUrl);
				if (!tempTab) tempTab = await chrome.tabs.create({url: page.nextUrl, active: false});
				else await chrome.tabs.update(tempTab.id, {url: page.nextUrl});
				for (let i = 0; i < 60; i++) {
					const tab = await chrome.tabs.get(tempTab.id);
					if (tab.url === page.nextUrl && tab.status === 'complete') break;
					await pause(250);
				}
				page = await capture(tempTab.id);
			} else {
				if (!added.length) stalled++;
				else stalled = 0;
				if (stalled >= 3) {
					complete = Number.isSafeInteger(total) && items.size === total;
					reason = complete ? null : 'end_unconfirmed';
					break;
				}
				await inject(tempTab?.id || tabId, advanceArchivePage);
				await pause(850);
				page = await capture(tempTab?.id || tabId, 2);
			}
		}
	} catch (e) {
		if (signal?.aborted) throw e;
		reason = e.code || 'network_error';
	} finally {
		if (tempTab) await chrome.tabs.remove(tempTab.id).catch(() => {});
	}
	return {
		folder: initial.folder,
		pages,
		items: [...items.values()],
		total,
		complete,
		reason: complete ? null : reason || 'page_limit',
	};
}

export async function hydrateArchivePages(collection, selected, origin, onProgress, signal) {
	const chosen = new Set(selected),
		byKey = new Map();
	let count = 0;
	for (const item of collection.items) {
		if (!chosen.has(key(item))) continue;
		signal?.throwIfAborted();
		let entry = item;
		if (item.visitUrl && mayVisit(item.visitUrl, item.platform, origin)) {
			try {
				const data = await withTab(item.visitUrl, async (tabId) => {
					const snap = await capture(tabId);
					if (snap.type === 'post' && key(snap.entry) === key(item))
						snap.entry = await hydrateOriginal(tabId, snap.entry);
					return snap;
				});
				if (data.type === 'post' && key(data.entry) === key(item))
					entry = {...data.entry, savedAt: item.savedAt || data.entry.savedAt};
				else entry = {...item, missing: ['original post unavailable']};
			} catch {
				entry = {...item, missing: ['original post unavailable']};
			}
		}
		const {visitUrl, ...safe} = entry;
		byKey.set(key(item), safe);
		onProgress?.(++count, chosen.size);
	}
	const pages = collection.pages.map((list, i) => ({
		cursor: i ? 'page-' + i : null,
		nextCursor:
			i + 1 < collection.pages.length ? 'page-' + (i + 1) : collection.complete ? null : 'unread',
		items: list.map((item) => {
			if (byKey.has(key(item))) return byKey.get(key(item));
			const {visitUrl, ...safe} = item;
			return safe;
		}),
	}));
	return {version: 1, folders: [{...collection.folder, total: collection.total, pages}]};
}
export async function captureFolderLink(folder, origin, action) {
	if (!mayVisit(folder.url, folder.platform, origin)) throw error('identity_mismatch');
	return withTab(folder.url, async (tab) => {
		const first = await readArchiveSource(tab);
		if (first.type !== 'collection' || key(first.folder) !== key(folder))
			throw error('identity_mismatch');
		return action(tab, first);
	});
}
