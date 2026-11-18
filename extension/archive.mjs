import {
	readArchiveSource,
	collectArchivePages,
	hydrateArchivePages,
	captureFolderLink,
	hydrateOriginal,
	listVisibleMedia,
} from './archive-source.mjs';
import {ArchiveTransfer} from './archive-transfer.mjs';
import {libraryRpc, submitArchive} from './archive-rpc.mjs';

const el = (id) => document.getElementById(id);
const node = (tag, text, cls) => {
	const n = document.createElement(tag);
	if (text !== undefined) n.textContent = text;
	if (cls) n.className = cls;
	return n;
};
const key = (o) => o.platform + ':' + o.id;
const statuses = {
	pending: '等待中',
	queued: '等待中',
	running: '进行中',
	completed: '已完成',
	complete: '完整',
	interrupted: '已中断',
	partial: '部分完成',
	failed: '失败',
	skipped: '已跳过',
	added: '已保存',
};
const errors = {
	archive_update_required:
		'当前本机组件版本较旧。请更新组件，待下载结束后重新启动组件，再打开收藏库。',
	metadata_limit: '作品正文与收藏夹清单超过 48 MiB，请分批选择作品。',
	invalid_url: '媒体地址无法由本机公开访问。',
	auth_required: '此媒体需要站点授权。',
	network_error: '本机无法读取此媒体。',
	unsupported_content: '本机无法保存这种媒体格式。',
	unsupported_page: '当前页面没有可识别的作品或收藏夹。',
	source_not_ready: '原帖正文尚未加载，请在原页面展开后重新读取。',
	identity_mismatch: '页面与选中的原帖不一致。',
	page_access: '请在来源页面的工具栏打开 Fetchy，再进入收藏库。',
	access_restricted: '来源页面当前无权读取。',
	upload_limit: '本次内容超过 48 MiB，请分批选择作品。',
	permission: '读取所选原帖需要你允许此站点。',
	unavailable: '无法连接本机组件。请确认已安装 Fetchy，并重新打开收藏库。',
};
const message = (text) => (el('message').textContent = text);
function button(label, handler, cls) {
	const b = node('button', label, cls);
	b.type = 'button';
	b.addEventListener('click', () => act(handler));
	return b;
}
let busy = false;
async function act(fn) {
	if (busy) return;
	busy = true;
	el('save').disabled = true;
	try {
		message('');
		await fn();
	} catch (e) {
		message(errors[e.code || e.message] || '操作未完成，请重新读取或检查本机组件。');
	} finally {
		busy = false;
		updateSave();
	}
}
const fields = new URLSearchParams(location.search),
	tabId = fields.has('tab') ? Number(fields.get('tab')) : null;
const chosenFolders = new Set();
let source,
	origin,
	collections = [],
	selected = new Set(),
	page = 0,
	view = 'capture',
	activeId = null,
	poll;
let selectedPost = false;
function setView(name) {
	view = name;
	clearTimeout(poll);
	message('');
	for (const b of document.querySelectorAll('[data-view]')) {
		if (b.dataset.view === name) b.setAttribute('aria-current', 'page');
		else b.removeAttribute('aria-current');
		el('view-' + b.dataset.view).hidden = b.dataset.view !== name;
	}
}
function showSummary(title, meta, preview) {
	const n = node('div', undefined, 'summary');
	n.append(node('h2', title), node('p', meta, 'meta'));
	if (preview) n.append(node('p', preview.slice(0, 1800), 'body-preview'));
	return n;
}
function updateSave() {
	const count = source?.type === 'post' && selectedPost ? 1 : selected.size;
	el('save-bar').hidden = !count;
	el('save').disabled = busy || !count;
	el('selection-count').textContent = '已选 ' + count + ' 项';
}
function entries() {
	return [...new Map(collections.flatMap((c) => c.items.map((v) => [key(v), v]))).values()];
}
function renderItems() {
	const root = el('capture-items');
	root.replaceChildren();
	if (!collections.length) {
		updateSave();
		return;
	}
	const rows = entries();
	for (const c of collections)
		root.append(
			showSummary(
				c.folder.name || c.folder.id,
				'已读 ' +
					c.items.length +
					' / ' +
					(c.total ?? '未知') +
					' 项 · ' +
					(c.complete ? '已到末页' : '尚未确认完整') +
					(c.reason
						? ' · ' +
							({
								repeated_cursor: '分页链接重复或跨站',
								identity_mismatch: '分页身份不符',
								access_restricted: '页面不可访问',
								end_unconfirmed: '未显示末页标记',
								network_error: '分页读取失败',
								count_mismatch: '总数不符',
								page_limit: '已达页数上限',
								item_limit: '已达条目上限',
							}[c.reason] || '分页已中断')
						: ''),
			),
		);
	if (!rows.length) {
		updateSave();
		return;
	}
	const actions = node('div', undefined, 'actions');
	actions.append(
		button('全选已读取的作品', () => {
			selected = new Set(rows.map(key));
			renderItems();
		}),
		button('取消全选', () => {
			selected.clear();
			renderItems();
		}),
	);
	root.append(actions);
	const size = 50;
	page = Math.min(page, Math.max(0, Math.ceil(rows.length / size) - 1));
	for (const item of rows.slice(page * size, (page + 1) * size)) {
		const label = node('label', undefined, 'check'),
			box = node('input'),
			copy = node('span', item.title || item.id);
		box.type = 'checkbox';
		box.checked = selected.has(key(item));
		box.addEventListener('change', () => {
			if (box.checked) selected.add(key(item));
			else selected.delete(key(item));
			updateSave();
		});
		copy.append(node('small', [item.platform, item.author].filter(Boolean).join(' · ')));
		label.append(box, copy);
		root.append(label);
	}
	if (rows.length > size) {
		const nav = node('div', undefined, 'pager'),
			prev = button('上一页', () => {
				page--;
				renderItems();
			}),
			next = button('下一页', () => {
				page++;
				renderItems();
			});
		prev.disabled = !page;
		next.disabled = (page + 1) * size >= rows.length;
		nav.append(prev, node('span', page + 1 + ' / ' + Math.ceil(rows.length / size)), next);
		root.append(nav);
	}
	updateSave();
}
async function permit() {
	const optional = chrome.runtime.getManifest().optional_host_permissions || [];
	const origins =
		origin === 'https://www.zhihu.com'
			? optional.filter((s) => s.includes('zhihu.com/'))
			: optional.filter((s) => s === origin + '/*');
	if (origins.length && !(await chrome.permissions.request({origins})))
		throw new Error('permission');
}
const progress = (n, total) => message('已读取 ' + n + ' / ' + (total ?? '未知') + ' 项…');
function onePage(first) {
	return {
		folder: first.folder,
		pages: [first.items],
		items: first.items,
		total: first.total,
		complete: first.complete,
	};
}
function folderPicker(folders, complete) {
	const holder = el('folder-picker');
	if (!folders?.length) return;
	holder.append(
		node('h2', '选择收藏夹'),
		node(
			'p',
			'已发现 ' +
				folders.length +
				' 个' +
				(complete ? ' · 已核对总数' : ' · 仅列出页面可见的收藏夹'),
			'meta',
		),
	);
	const selectAll = button('全选已发现的收藏夹', () => {
		for (const box of holder.querySelectorAll('input[type=checkbox]')) box.checked = true;
		for (const f of folders) chosenFolders.add(key(f));
	});
	holder.append(selectAll);
	for (const f of folders) {
		const label = node('label', undefined, 'check'),
			box = node('input');
		box.type = 'checkbox';
		box.addEventListener('change', () => {
			if (box.checked) chosenFolders.add(key(f));
			else chosenFolders.delete(key(f));
		});
		label.append(box, node('span', f.name || f.id));
		holder.append(label);
	}
	holder.append(
		button('读取所选收藏夹的全部页面', async () => {
			if (!chosenFolders.size) {
				message('请先选择收藏夹。');
				return;
			}
			await permit();
			const loaded = [];
			for (const f of folders.filter((f) => chosenFolders.has(key(f)))) {
				loaded.push(
					await captureFolderLink(f, origin, (id, data) =>
						collectArchivePages(id, origin, data, progress),
					),
				);
			}
			collections = loaded;
			selected = new Set(entries().map(key));
			page = 0;
			renderItems();
			message('');
		}),
	);
}
async function loadSource() {
	source = null;
	el('media-results').replaceChildren();
	el('media-discovery').hidden = !Number.isInteger(tabId) || tabId < 0;
	collections = [];
	selected.clear();
	chosenFolders.clear();
	selectedPost = false;
	page = 0;
	const ctx = el('capture-context');
	ctx.replaceChildren();
	el('folder-picker').replaceChildren();
	renderItems();
	if (!Number.isInteger(tabId) || tabId < 0) {
		ctx.append(node('p', '请在需要保存的来源页面打开 Fetchy 工具栏，点击「收藏库」。', 'hint'));
		return;
	}
	message('正在读取来源页面…');
	source = await readArchiveSource(tabId);
	if (source.type === 'unsupported') {
		message(errors[source.reason] || errors.unsupported_page);
		return;
	}
	const tab = await chrome.tabs.get(tabId);
	origin = tab.url ? new URL(tab.url).origin : null;
	if (source.type === 'post') {
		const e = source.entry;
		selectedPost = true;
		ctx.append(
			showSummary(
				e.title || e.id,
				[
					e.platform,
					e.author,
					e.bodyComplete ? '正文已读取' : '正文可能不完整',
					e.attachments.length + ' 个附件',
				]
					.filter(Boolean)
					.join(' · '),
				e.body,
			),
		);
	} else if (source.type === 'collection') {
		ctx.append(
			button('读取全部页面', async () => {
				await permit();
				collections = [await collectArchivePages(tabId, origin, source, progress)];
				selected = new Set(entries().map(key));
				renderItems();
				message('');
			}),
		);
		collections = [onePage(source)];
		renderItems();
		folderPicker(source.folders, false);
	} else folderPicker(source.folders, source.complete);
	message('');
	updateSave();
}
async function save() {
	let manifest, keys, transfer;
	if (source?.type === 'post') {
		message('正在原页面读取附件…');
		const fresh = await readArchiveSource(tabId);
		if (fresh.type !== 'post' || key(fresh.entry) !== key(source.entry))
			throw new Error('identity_mismatch');
		transfer = new ArchiveTransfer();
		const read = await hydrateOriginal(tabId, fresh.entry, transfer.readLimit);
		manifest = {version: 1, items: [transfer.record({}, fresh.entry, read)]};
	} else {
		await permit();
		keys = [...selected];
		const folders = [];
		const groups = collections.filter((c) => c.items.some((row) => selected.has(key(row))));
		transfer = new ArchiveTransfer(groups, keys);
		for (const group of groups) {
			const data = await hydrateArchivePages(
				group,
				keys,
				origin,
				(n, t, urls) =>
					message(
						'正在读取原帖 ' +
							n +
							' / ' +
							t +
							'…' +
							(urls ? ' · ' + urls + ' 个附件使用原地址' : ''),
					),
				undefined,
				transfer,
			);
			folders.push(...data.folders);
		}
		manifest = {version: 1, folders};
	}
	message('正在交给本机组件…');
	const task = await submitArchive(manifest, keys, (n, t) =>
		message('正在传送到本机 ' + n + ' / ' + t + '…'),
	);
	activeId = task.id;
	setView('tasks');
	await loadTasks();
	const details = [];
	if (transfer.urlCount) details.push(transfer.urlCount + ' 个附件交由本机从原地址读取');
	if (transfer.missingCount)
		details.push(transfer.missingCount + ' 个仅有页面内数据的附件超出容量，保留为缺项');
	if (details.length) message(details.join('。') + '。结果以任务状态为准。');
}
function itemRow(title, meta, btn) {
	const row = node('div', undefined, 'row'),
		text = node('div');
	text.append(node('h3', title), node('p', meta, 'meta'));
	row.append(text);
	if (btn) row.append(btn);
	return row;
}
function openButton(k) {
	return button('打开离线页', () => libraryRpc('libraryOpen', {key: k}), 'quiet');
}
async function search() {
	const results = await libraryRpc('librarySearch', {
		filters: Object.fromEntries(new FormData(el('search-form'))),
	});
	el('results').replaceChildren(
		...results.map((v) =>
			itemRow(
				v.title || v.id,
				[
					v.platform,
					v.author,
					statuses[v.status] || v.status,
					...(v.folders || []).map((f) => f.name),
				]
					.filter(Boolean)
					.join(' · '),
				v.filepath ? openButton(v.key) : null,
			),
		),
	);
	if (!results.length) el('results').append(node('p', '没有匹配的离线收藏。', 'hint'));
}
const stats = (t) =>
	['added', 'skipped', 'partial', 'failed', 'pending']
		.filter((k) => t.counts?.[k])
		.map((k) => statuses[k] + ' ' + t.counts[k])
		.join(' · ');
async function showTask(id, offset = 0) {
	activeId = id;
	const t = await libraryRpc('libraryTask', {id, offset});
	if (view !== 'tasks' || id !== activeId) return;
	const panel = node('div', undefined, 'panel');
	panel.dataset.taskId = id;
	panel.dataset.status = t.status;
	panel.append(
		node('h2', statuses[t.status] || t.status),
		node('p', id, 'meta'),
		node('p', stats(t)),
	);
	for (const f of (t.folders || []).filter((f) => f.id !== 'single' && f.name !== 'Single items'))
		panel.append(
			node('p', (f.name || f.id) + ' · ' + (f.complete ? '已到末页' : '读取未完整'), 'meta'),
		);
	const actions = node('div', undefined, 'actions');
	if (t.status === 'interrupted' || t.status === 'queued')
		actions.append(
			button('继续任务', async () => {
				await libraryRpc('libraryResume', {id});
				await showTask(id);
			}),
		);
	if (t.counts?.failed)
		actions.append(
			button('仅重试失败项', async () => {
				await libraryRpc('libraryRetry', {id});
				await showTask(id);
			}),
		);
	panel.append(actions);
	for (const i of t.items || [])
		panel.append(
			itemRow(
				i.key,
				[statuses[i.status] || i.status, i.reason].filter(Boolean).join(' · '),
				i.filepath ? openButton(i.key) : null,
			),
		);
	if (offset || offset + 100 < t.totalItems) {
		const nav = node('div', undefined, 'pager');
		if (offset) nav.append(button('前 100 项', () => showTask(id, offset - 100)));
		if (offset + 100 < t.totalItems)
			nav.append(button('后 100 项', () => showTask(id, offset + 100)));
		panel.append(nav);
	}
	el('task-detail').replaceChildren(panel);
	clearTimeout(poll);
	if (['running', 'queued', 'pending'].includes(t.status))
		poll = setTimeout(() => showTask(id, offset).catch(() => message(errors.unavailable)), 1400);
}
async function loadTasks() {
	const list = await libraryRpc('libraryTasks');
	el('tasks').replaceChildren(
		...list
			.filter((t) => t.id !== activeId)
			.map((t) =>
				itemRow(
					statuses[t.status] || t.status,
					[t.id, stats(t)].join(' · '),
					button('查看任务', () => showTask(t.id), 'quiet'),
				),
			),
	);
	if (!list.length) el('tasks').append(node('p', '还没有归档任务。', 'hint'));
	if (activeId) await showTask(activeId);
}
for (const b of document.querySelectorAll('[data-view]'))
	b.addEventListener('click', () =>
		act(async () => {
			setView(b.dataset.view);
			if (view === 'library') await search();
			else if (view === 'tasks') await loadTasks();
		}),
	);
el('save').addEventListener('click', () => act(save));
el('reload-source').addEventListener('click', () => act(loadSource));
el('refresh-tasks').addEventListener('click', () => act(loadTasks));
el('search-form').addEventListener('submit', (e) => {
	e.preventDefault();
	act(search);
});
el('discover-media').addEventListener('click', () =>
	act(async () => {
		const {items, page} = await listVisibleMedia(tabId),
			root = el('media-results');
		root.replaceChildren();
		if (!items.length) {
			root.append(node('p', '此页尚未加载可识别的媒体。', 'hint'));
			return;
		}
		for (const [index, media] of items.entries()) {
			root.append(
				itemRow(
					media.type + ' ' + (index + 1),
					media.host,
					button('保存此媒体', async () => {
						const fresh = await listVisibleMedia(tabId);
						if (page !== fresh.page || !fresh.items.some((i) => i.url === media.url))
							throw new Error('identity_mismatch');
						message('正在保存媒体…');
						const saved = await libraryRpc('webSave', {url: media.url});
						if (saved.taskId) {
							activeId = saved.taskId;
							setView('tasks');
							await loadTasks();
						} else message(saved.filepath ? '已保存到 ' + saved.filepath : '已保存');
					}),
				),
			);
		}
	}),
);
act(loadSource);
