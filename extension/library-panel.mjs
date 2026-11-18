import {
	atEnd,
	capture,
	key,
	listVisibleMedia,
	manifestFolder,
	readArchiveSource,
	readMore,
	startCollection,
	mergePage,
} from './archive-source.mjs';
import {libraryNotify, libraryRpc, submitArchive} from './archive-rpc.mjs';

// The side panel follows the active tab. Reading a page happens in that tab in
// the foreground; saving is handed to the native worker and continues without
// the panel. This file never opens a tab.
const byId = (id) => document.getElementById(id);
const node = (tag, text, cls) => {
	const n = document.createElement(tag);
	if (text !== undefined) n.textContent = text;
	if (cls) n.className = cls;
	return n;
};
const show = (id, visible) => (byId(id).hidden = !visible);

export const reasons = {
	login_required: '需要登录：在 Fetchy 桌面端「账号」登录该站后重试',
	login_expired: '登录已过期：在 Fetchy 桌面端「账号」重新登录后重试',
	verification_required: '网站要求验证：在浏览器打开原帖完成验证后重试',
	source_unavailable: '原帖不可用或已删除',
	unavailable: '原帖不可用或已删除',
	auth_required: '媒体拒绝访问：登录该站后重试',
	network_error: '网络中断：稍后重试',
	timeout: '读取超时：稍后重试',
	size_limit: '文件超过单个文件上限',
	invalid_attachment: '下载到的文件无法识别',
	invalid_url: '媒体地址无法访问',
	full_text: '正文可能不完整',
	attachments: '部分图片或视频缺失',
	selection_missing: '收藏夹里已找不到这条',
	wrong_video: '下载到的视频与原帖不一致',
	no_formats: '没有可下载的视频格式',
	open_page_required: '请先在浏览器打开原帖',
	save_failed: '保存失败：稍后重试',
};
const pageErrors = {
	unsupported_page: '',
	page_access: '没有读取此页面的权限。',
	source_not_ready: '页面还在加载，稍后会自动重试。',
	identity_mismatch: '页面已切换，请重新读取。',
	access_restricted: '来源页面当前无权读取。',
	unavailable: '无法连接本机组件。请确认已安装 Fetchy。',
	archive_update_required: '本机组件版本较旧，请更新后重启组件。',
	upload_limit: '所选内容过多，请分批保存。',
	permission: '读取此网站需要你允许。',
};
const collectionReasons = {
	end_unconfirmed: '没有更多了，但网站未显示末尾',
	identity_mismatch: '页面已切换到别的收藏夹',
	item_limit: '已读到 5000 条上限',
	repeated_cursor: '分页链接异常，已停止',
	count_mismatch: '读到的条数与网站总数不符',
	network_error: '读取下一页失败',
};
const statusText = {
	queued: '等待中',
	pending: '等待中',
	running: '保存中',
	completed: '已完成',
	partial: '部分完成',
	failed: '失败',
	interrupted: '已中断',
	added: '已保存',
	skipped: '已有，跳过',
};

let tabId = null,
	origin = null,
	source = null,
	collection = null,
	selected = new Set(),
	autoReading = false,
	stopRequested = false,
	reading = false,
	syncTimer = null,
	taskId = null,
	taskTimer = null,
	generation = 0;

function notice(text) {
	show('page-notice', Boolean(text));
	byId('page-notice').textContent = text || '';
}
function setPage(kind) {
	document.body.dataset.page = kind;
	show('post-card', kind === 'post');
	show('collection-card', kind === 'collection');
	show('folders-card', kind === 'folders');
}

async function permit() {
	const optional = chrome.runtime.getManifest().optional_host_permissions || [];
	const origins =
		origin === 'https://www.zhihu.com' || origin === 'https://zhuanlan.zhihu.com'
			? optional.filter((s) => s.includes('zhihu.com/'))
			: optional.filter((s) => s === origin + '/*');
	if (!origins.length) return false;
	return chrome.permissions.request({origins});
}

function renderPost(entry) {
	byId('post-title').textContent = entry.title || entry.id;
	const images = entry.attachments.filter((a) => a.kind === 'image').length;
	const videos = entry.attachments.filter((a) => a.kind === 'video').length;
	byId('post-meta').textContent = [
		entry.author,
		entry.bodyComplete ? '正文完整' : '正文可能不完整',
		images + ' 张图片',
		videos + ' 个视频',
	]
		.filter(Boolean)
		.join(' · ');
	byId('post-preview').textContent = (entry.body || '').slice(0, 280);
}

function selectedCount() {
	return [...selected].filter((k) => collection?.items.has(k)).length;
}
function renderCollection() {
	if (!collection) return;
	byId('collection-title').textContent = collection.folder.name || collection.folder.id;
	const total = Number.isSafeInteger(collection.total) ? collection.total : '未知';
	const state = collection.complete
		? '已读到末尾'
		: collection.reason
			? collectionReasons[collection.reason] || '读取已停止'
			: '还可以继续读';
	byId('collection-count').textContent =
		'已读到 ' + collection.items.size + ' 条 · 网站显示 ' + total + ' 条 · ' + state;
	const done = atEnd(collection);
	byId('read-more').disabled = reading || done;
	byId('read-all').disabled = reading || done;
	show('read-all', !autoReading);
	show('read-stop', autoReading);
	const list = byId('collection-items');
	const rendered = new Set([...list.children].map((li) => li.dataset.key));
	for (const item of collection.items.values()) {
		const k = key(item);
		if (rendered.has(k)) continue;
		const li = node('li');
		li.dataset.key = k;
		const label = node('label', undefined, 'check');
		const box = node('input');
		box.type = 'checkbox';
		box.checked = selected.has(k);
		box.addEventListener('change', () => {
			if (box.checked) selected.add(k);
			else selected.delete(k);
			renderSelection();
		});
		const text = node('span', item.title || item.id);
		if (item.kind === 'video') text.append(node('small', '视频'));
		label.append(box, text);
		li.append(label);
		list.append(li);
	}
	renderSelection();
}
function renderSelection() {
	const count = selectedCount();
	byId('selected-count').textContent = '已选 ' + count + ' 条';
	byId('save-selected').disabled = !count;
	byId('save-selected-label').textContent = count ? '保存所选 ' + count + ' 条' : '保存所选';
	byId('select-all').checked = Boolean(collection?.items.size) && count === collection.items.size;
}

function renderFolders(folders) {
	const list = byId('folder-links');
	list.replaceChildren(
		...folders.map((folder) => {
			const li = node('li');
			const button = node('button', folder.name || folder.id, 'text-button');
			button.type = 'button';
			button.disabled = !folder.url;
			button.addEventListener('click', () =>
				act(async () => {
					await chrome.tabs.update(tabId, {url: folder.url});
				}),
			);
			li.append(button);
			return li;
		}),
	);
}

async function renderMedia() {
	let found;
	try {
		found = await listVisibleMedia(tabId);
	} catch {
		found = {items: []};
	}
	show('media-card', found.items.length > 0);
	byId('media-items').replaceChildren(
		...found.items.map((media, index) => {
			const li = node('li');
			li.append(node('span', media.type + ' ' + (index + 1) + ' · ' + media.host));
			const button = node('button', '下载', 'text-button');
			button.type = 'button';
			button.addEventListener('click', () =>
				act(async () => {
					const fresh = await listVisibleMedia(tabId);
					if (found.page !== fresh.page || !fresh.items.some((i) => i.url === media.url))
						throw Object.assign(new Error(), {code: 'identity_mismatch'});
					notice('正在交给本机保存…');
					const saved = await libraryRpc('webSave', {url: media.url});
					if (saved.taskId) watchTask(saved.taskId);
					notice(saved.filepath ? '已保存到 ' + saved.filepath : '');
				}),
			);
			li.append(button);
			return li;
		}),
	);
}

let busy = false;
async function act(fn) {
	if (busy) return;
	busy = true;
	try {
		notice('');
		await fn();
	} catch (e) {
		const code = e?.code || e?.message;
		notice(pageErrors[code] ?? reasons[code] ?? '操作未完成，请重试。');
		if (code === 'page_access' || code === 'permission') show('grant-site', true);
	} finally {
		busy = false;
	}
}

async function loadPage() {
	const mine = ++generation;
	stopRequested = true;
	clearTimeout(syncTimer);
	collection = null;
	selected = new Set();
	source = null;
	byId('collection-items').replaceChildren();
	show('grant-site', false);
	show('media-card', false);
	notice('');
	const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
	if (mine !== generation) return;
	tabId = tab?.id ?? null;
	try {
		origin = tab?.url ? new URL(tab.url).origin : null;
	} catch {
		origin = null;
	}
	if (!Number.isInteger(tabId) || !origin?.startsWith('https:')) {
		setPage('none');
		return;
	}
	let read;
	try {
		read = await readArchiveSource(tabId);
	} catch (e) {
		read = {type: 'unsupported', reason: e.code || 'page_access'};
	}
	if (mine !== generation) return;
	source = read;
	if (read.type === 'post') {
		setPage('post');
		renderPost(read.entry);
	} else if (read.type === 'collection') {
		setPage('collection');
		collection = startCollection(read);
		// Everything read is selected; the user unticks what to leave out.
		selected = new Set(collection.items.keys());
		renderCollection();
		scheduleSync(mine);
	} else if (read.type === 'folders') {
		setPage('folders');
		renderFolders(read.folders || []);
	} else {
		setPage('none');
		if (read.reason && pageErrors[read.reason]) notice(pageErrors[read.reason]);
		if (read.reason === 'page_access') show('grant-site', true);
	}
	if (read.type !== 'collection') await renderMedia();
}

// Follow the user's own scrolling: re-read the visible list now and then.
function scheduleSync(mine) {
	clearTimeout(syncTimer);
	syncTimer = setTimeout(async () => {
		if (mine !== generation || !collection) return;
		if (!reading) {
			try {
				const added = mergePage(collection, await capture(tabId, 1));
				if (added) {
					for (const item of [...collection.items.values()].slice(-added)) selected.add(key(item));
					renderCollection();
				}
			} catch {
				/* the page may be navigating */
			}
		}
		scheduleSync(mine);
	}, 1500);
}

async function readStep(options) {
	reading = true;
	renderCollection();
	try {
		const before = collection.items.size;
		await readMore(tabId, collection, origin, options);
		for (const item of [...collection.items.values()].slice(before)) selected.add(key(item));
	} finally {
		reading = false;
		renderCollection();
	}
}

async function saveSelected() {
	const keys = [...selected].filter((k) => collection.items.has(k));
	const manifest = {version: 1, folders: [manifestFolder(collection)]};
	notice('正在建立保存任务…');
	const task = await submitArchive(manifest, keys, null, libraryRpc, {feed: true});
	// The background worker reads each post page from this tab and hands it over.
	const items = keys
		.map((k) => collection.items.get(k))
		.filter((item) => item.kind !== 'video')
		.map((item) => ({
			key: key(item),
			platform: item.platform,
			url: item.visitUrl || item.sourceUrl,
		}));
	libraryNotify('feed', {taskId: task.id, tabId, origin, items});
	notice('');
	watchTask(task.id);
}

async function savePost() {
	const fresh = await readArchiveSource(tabId);
	if (fresh.type !== 'post' || key(fresh.entry) !== key(source.entry))
		throw Object.assign(new Error(), {code: 'identity_mismatch'});
	notice('正在建立保存任务…');
	const task = await submitArchive({version: 1, items: [fresh.entry]}, undefined);
	notice('');
	watchTask(task.id);
}

function watchTask(id) {
	taskId = id;
	clearTimeout(taskTimer);
	void refreshTask();
}
async function refreshTask() {
	if (!taskId) return;
	const id = taskId;
	let task;
	try {
		task = await libraryRpc('libraryTask', {id});
	} catch {
		taskTimer = setTimeout(refreshTask, 4000);
		return;
	}
	if (id !== taskId) return;
	show('task-card', true);
	byId('task-title').textContent = '保存进度 · ' + (statusText[task.status] || task.status);
	const c = task.counts || {};
	byId('task-counts').textContent = [
		['added', '已保存'],
		['skipped', '已有'],
		['partial', '部分'],
		['failed', '失败'],
		['pending', '等待'],
	]
		.filter(([k]) => c[k])
		.map(([k, label]) => label + ' ' + c[k])
		.join(' · ');
	show(
		'task-retry',
		Boolean(c.failed || c.partial) && !['running', 'queued'].includes(task.status),
	);
	byId('task-items').replaceChildren(
		...(task.items || [])
			.filter((i) => ['failed', 'partial'].includes(i.status))
			.map((i) => {
				const li = node('li');
				li.append(
					node('span', collection?.items.get(i.key)?.title || i.key, 'task-item-title'),
					node(
						'span',
						(statusText[i.status] || i.status) +
							(i.reason ? ' · ' + (reasons[i.reason] || i.reason) : ''),
						'task-item-reason',
					),
				);
				const retry = node('button', '重试', 'text-button');
				retry.type = 'button';
				retry.addEventListener('click', () =>
					act(async () => {
						await libraryRpc('libraryRetry', {id, selected: [i.key]});
						watchTask(id);
					}),
				);
				li.append(retry);
				return li;
			}),
	);
	if (['running', 'queued', 'pending'].includes(task.status))
		taskTimer = setTimeout(refreshTask, 1500);
}

byId('save-post').addEventListener('click', () => act(savePost));
byId('save-selected').addEventListener('click', () => act(saveSelected));
byId('read-more').addEventListener('click', () => act(() => readStep()));
byId('read-all').addEventListener('click', () =>
	act(async () => {
		autoReading = true;
		stopRequested = false;
		renderCollection();
		try {
			if (!collection.nextUrl && collection.provider !== 'bilibili')
				await readStep({fromTop: true});
			while (!stopRequested && collection && !atEnd(collection)) await readStep();
		} finally {
			autoReading = false;
			renderCollection();
		}
	}),
);
byId('read-stop').addEventListener('click', () => {
	stopRequested = true;
});
byId('select-all').addEventListener('change', (event) => {
	selected = event.target.checked ? new Set(collection.items.keys()) : new Set();
	for (const box of byId('collection-items').querySelectorAll('input[type=checkbox]'))
		box.checked = event.target.checked;
	renderSelection();
});
byId('grant-site').addEventListener('click', () =>
	act(async () => {
		if (!(await permit())) throw Object.assign(new Error(), {code: 'permission'});
		await loadPage();
	}),
);
byId('task-retry').addEventListener('click', () =>
	act(async () => {
		await libraryRpc('libraryRetry', {id: taskId});
		watchTask(taskId);
	}),
);

chrome.tabs.onActivated.addListener(() => void loadPage());
chrome.tabs.onUpdated.addListener((id, change) => {
	if (id !== tabId || change.status !== 'complete' || reading) return;
	void loadPage();
});
libraryRpc('libraryTasks')
	.then((tasks) => {
		const recent = tasks.find((t) => ['running', 'queued', 'interrupted'].includes(t.status));
		if (recent && !taskId) watchTask(recent.id);
	})
	.catch(() => {});
void loadPage();
