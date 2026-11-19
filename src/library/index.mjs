import {randomUUID, createHash} from 'node:crypto';
import {mkdtemp, realpath, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {downloadVideo as defaultDownload} from '../index.mjs';
import {
	displayTitle,
	downloadAttachment,
	entryIdentity,
	folderOf,
	normalizeEntry,
	publishLibraryMedia,
	renamePublishedMedia,
	stashFile,
	workFile,
	renderWork,
} from './content.mjs';
import {browserHeaders} from './post-pages.mjs';
import {matchingTarget} from '../urls.mjs';
import {bilibiliFolderId, readBilibiliPage} from './bilibili.mjs';
import {libraryRoot, openLibrary, problem, transaction, withWorker} from './storage.mjs';
export {libraryRoot};
export {discoverBilibiliFolders, bilibiliFolderId, readBilibiliPage} from './bilibili.mjs';

const unique = (xs) => [...new Set(xs)];
function memberships(a = [], b = []) {
	const folders = new Map();
	for (const f of [...a, ...b]) {
		const key = JSON.stringify([f.platform, f.id]),
			previous = folders.get(key);
		folders.set(key, {...f, savedAt: f.savedAt || previous?.savedAt || null});
	}
	return [...folders.values()];
}
function isMediaOnly(entry) {
	return ['video', 'audio'].includes(entry.kind) && !entry.body;
}

// The richer post supplies the sequence. A separate media download can fill a
// unique video/audio slot, including one in the middle of a photo gallery.
function mergeAttachments(primary, other) {
	const ordered = primary.attachments.map((a) => ({...a}));
	const used = new Set();
	const aligned =
		ordered.length === other.attachments.length &&
		ordered.every((a, i) => a.kind === other.attachments[i].kind);
	const positions = other.attachments.map((a) => {
		if (!a.path) return -1;
		const match = ordered.findIndex(
			(v, j) => !used.has(j) && v.path === a.path && v.kind === a.kind,
		);
		if (match !== -1) used.add(match);
		return match;
	});
	for (const [i, a] of other.attachments.entries()) {
		let at = positions[i];
		if (at === -1) {
			const candidates = ordered.flatMap((v, j) => (!used.has(j) && v.kind === a.kind ? [j] : []));
			const labelled = candidates.filter(
				(j) => (a.alt && a.alt === ordered[j].alt) || (a.name && a.name === ordered[j].name),
			);
			if (labelled.length === 1) at = labelled[0];
			else if (aligned && !used.has(i)) at = i;
			else if (
				candidates.length === 1 &&
				(isMediaOnly(other) || !a.path || !ordered[candidates[0]].path)
			)
				at = candidates[0];
		}
		if (at === -1) {
			ordered.push({...a});
			used.add(ordered.length - 1);
			continue;
		}
		used.add(at);
		const slot = ordered[at];
		if (!slot.path && a.path) {
			slot.path = a.path;
			delete slot.missing;
			delete slot.needsSource;
			delete slot.pendingAttachment;
		}
		if (!slot.path && a.pendingAttachment && !slot.pendingAttachment)
			slot.pendingAttachment = a.pendingAttachment;
		slot.alt ||= a.alt || '';
		slot.name ||= a.name || '';
	}
	return ordered;
}

function mergeInput(old, item) {
	if (!old || !old.sourceUrl || !item.sourceUrl) return item;
	const latestIsMetadata = !item.body && !item.attachments.length;
	const oldPost = old.kind === 'post' && (old.body || old.attachments.length);
	const itemPost = item.kind === 'post' && (item.body || item.attachments.length);
	const keepPost = latestIsMetadata || (oldPost && isMediaOnly(item));
	const details = keepPost ? old : item;
	const other = keepPost ? item : old;
	let primary = details;
	if (
		!keepPost &&
		!(itemPost && isMediaOnly(old)) &&
		old.attachments.length > item.attachments.length
	)
		primary = old;
	const supplement = primary === old ? item : old;
	let body = old;
	if (!old.body && !item.body) body = primary;
	else if (
		item.body &&
		(!old.body || item.bodyComplete || (!old.bodyComplete && item.body.length >= old.body.length))
	)
		body = item;
	return {
		...old,
		...item,
		kind: details.kind,
		title: details.title || other.title,
		author: details.author || other.author,
		body: body.body,
		bodyFormat: body.bodyFormat,
		bodyComplete: body.bodyComplete,
		savedAt: item.savedAt || old.savedAt,
		// Only the latest read's failure explains this save.
		readError: item.readError,
		notes: item.notes || old.notes,
		summary: item.summary || old.summary,
		translation: item.translation || old.translation,
		coverage: details.coverage || other.coverage,
		missing: primary.missing.filter((reason) => reason !== 'full text' && reason !== 'attachments'),
		folders: memberships(old.folders, item.folders),
		topics: unique([...old.topics, ...item.topics]),
		attachments: mergeAttachments(primary, supplement),
		...(item.savedFiles?.length
			? {savedFiles: item.savedFiles}
			: old.savedFiles?.length
				? {savedFiles: old.savedFiles}
				: {}),
		...(item.savedDir ? {savedDir: item.savedDir} : old.savedDir ? {savedDir: old.savedDir} : {}),
	};
}
const stmtItem =
	'INSERT INTO items(task,key,input,status,reason) VALUES(?,?,?,?,?) ON CONFLICT(task,key) DO UPDATE SET input=excluded.input';
function insertItem(db, task, item, status = 'pending', reason = null) {
	const old = db.prepare('SELECT input FROM items WHERE task=? AND key=?').get(task, item.key);
	const merged = old ? mergeInput(JSON.parse(old.input), item) : item;
	db.prepare(stmtItem).run(task, item.key, JSON.stringify(merged), status, reason);
}
async function inputsFor(items, folder, root, options, seed) {
	const result = [];
	for (const [n, raw] of items.entries()) {
		try {
			const {key} = entryIdentity(raw, folder);
			if (options.selected && !options.selected.has(key)) continue;
			const item = await normalizeEntry(raw, folder, root, options);
			// A listing row without text or files is read from its post page when
			// the worker has a reader (see options.readDetails).
			if (
				!item.body &&
				!item.attachments.length &&
				item.kind !== 'video' &&
				item.coverage !== 'unavailable_resource'
			)
				item.needsDetails = true;
			for (const [i, a] of item.attachments.entries()) {
				if (a.path) continue;
				const pending = options.deferAttachment?.(raw.attachments[i]);
				if (pending) a.pendingAttachment = pending;
			}
			result.push([item]);
		} catch (e) {
			if (!['invalid_entry', 'invalid_folder'].includes(e.code)) throw e;
			result.push([{key: 'invalid:' + seed + '-' + n}, 'failed', e.code]);
		}
	}
	return result;
}
function localPages(folder, items) {
	const state = {
		id: folder?.id || 'input',
		name: folder?.name || 'Single items',
		platform: folder?.platform || '',
		pagesRead: 0,
		read: 0,
		total: null,
		complete: true,
	};
	if (Array.isArray(items)) {
		state.read = items.length;
		state.pagesRead = 1;
		state.total = Number.isSafeInteger(folder?.total) ? folder.total : null;
		if (folder?.complete === false || (state.total !== null && state.read !== state.total)) {
			state.complete = false;
			state.reason = folder?.complete === false ? 'declared_partial' : 'count_mismatch';
		}
		return {state, pages: [items]};
	}
	if (!Array.isArray(folder.pages))
		throw problem('invalid_manifest', 'A collection must supply pages or a Bilibili source.');
	const pages = [],
		seen = new Set(),
		members = new Set();
	let overlap = false;
	let expected = null;
	state.complete = false;
	for (const page of folder.pages) {
		const cursor = page?.cursor ?? null;
		if (cursor !== expected || seen.has(cursor)) {
			state.reason = 'cursor_mismatch';
			break;
		}
		if (!Array.isArray(page?.items))
			throw problem('invalid_page', 'A page must supply an array of items.');
		seen.add(cursor);
		pages.push(page.items);
		state.read += page.items.length;
		for (const input of page.items) {
			if (typeof input?.id !== 'string') continue;
			const key = (input.platform || folder.platform) + ':' + input.id;
			if (members.has(key)) overlap = true;
			members.add(key);
		}
		state.pagesRead++;
		if (page.nextCursor === null) {
			state.complete = true;
			break;
		}
		expected = page.nextCursor;
		state.nextCursor = expected ?? null;
		if (typeof expected !== 'string' || !expected || seen.has(expected)) {
			state.reason = 'incomplete_cursor';
			break;
		}
	}
	state.total = Number.isSafeInteger(folder.total) ? folder.total : null;
	if (state.complete && pages.length < folder.pages.length) {
		state.complete = false;
		state.reason = 'unexpected_page_after_end';
	}
	if (state.complete && overlap) {
		state.complete = false;
		state.reason = 'overlapping_pages';
	}
	if (state.complete && state.total !== null && state.read !== state.total) {
		state.complete = false;
		state.reason = 'count_mismatch';
	}
	if (!state.complete && !state.reason) state.reason = 'missing_page';
	if (state.complete) delete state.nextCursor;
	return {state, pages};
}
function countsFor(db, id) {
	const counts = {added: 0, skipped: 0, partial: 0, failed: 0, pending: 0};
	for (const {status, n} of db
		.prepare('SELECT status,count(*) AS n FROM items WHERE task=? GROUP BY status')
		.all(id))
		counts[status] = n;
	return counts;
}
function taskResult(ctx, id, details = true) {
	const {db, root} = ctx;
	const row = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
	if (!row) throw problem('not_found', 'No such library task.');
	const cfg = JSON.parse(row.config);
	let status = row.status;
	if (status === 'running' && cfg.runnerPid) {
		try {
			process.kill(cfg.runnerPid, 0);
		} catch (e) {
			if (e.code === 'ESRCH') status = 'interrupted';
		}
	}
	const task = {
		id,
		createdAt: row.created,
		status,
		counts: countsFor(db, id),
		folders: cfg.folders.map(({seen, ...folder}) => folder),
	};
	if (details)
		task.items = db
			.prepare(
				'SELECT i.key,i.status,i.reason,i.input,w.record FROM items i LEFT JOIN works w ON i.key=w.key WHERE i.task=? ORDER BY i.rowid',
			)
			.all(id)
			.map(({key, status, reason, input, record}) => {
				const work = record ? JSON.parse(record) : null;
				const entry = work ?? JSON.parse(input);
				return {
					key,
					status,
					reason,
					title: entry.customTitle || entry.title || '',
					author: entry.author ?? '',
					platform: entry.platform ?? key.split(':')[0],
					sourceUrl: entry.sourceUrl ?? null,
					filepath: work ? workFile(root, work) : null,
				};
			});
	return task;
}
export async function prepareLibraryTask(manifest, options = {}) {
	if (
		manifest?.version !== 1 ||
		(manifest.items !== undefined && !Array.isArray(manifest.items)) ||
		(manifest.folders !== undefined && !Array.isArray(manifest.folders)) ||
		(!Array.isArray(manifest.folders) && !Array.isArray(manifest.items))
	)
		throw problem('invalid_manifest', 'Use a version 1 manifest with items or folders.');
	const ctx = await openLibrary(options),
		id = randomUUID(),
		cfg = {
			folders: [],
			selected: options.selected ?? null,
			nativeQueue: options.nativeQueue === true,
		};
	try {
		if (
			cfg.selected !== null &&
			(!Array.isArray(cfg.selected) || cfg.selected.some((k) => typeof k !== 'string'))
		)
			throw problem('invalid_options', 'Selection must contain platform:id keys.');
		const opts = {...options, selected: cfg.selected === null ? null : new Set(cfg.selected)};
		const rows = [];
		const add = async (folder, items, rawFolder) => {
			const bId =
				rawFolder?.source?.type === 'bilibili' ? bilibiliFolderId(rawFolder.source.id) : null;
			if (rawFolder?.source && (!bId || folder.platform !== 'bilibili'))
				throw problem('invalid_folder', 'Unknown live collection source.');
			if (bId) {
				cfg.folders.push({
					...folder,
					bilibiliId: bId,
					nextPage: 1,
					pagesRead: 0,
					read: 0,
					total: null,
					complete: false,
				});
				return;
			}
			const {state, pages} = localPages(rawFolder, items);
			cfg.folders.push(state);
			for (const [i, page] of pages.entries()) {
				for (const entry of await inputsFor(
					page,
					folder,
					ctx.root,
					opts,
					cfg.folders.length + '-' + i,
				))
					rows.push(entry);
			}
		};
		if (Array.isArray(manifest.items)) await add(null, manifest.items, null);
		for (const f of manifest.folders || []) await add(folderOf(f), f.items, f);
		transaction(ctx.db, () => {
			ctx.db
				.prepare('INSERT INTO tasks VALUES(?,?,?,?)')
				.run(id, new Date().toISOString(), 'queued', JSON.stringify(cfg));
			for (const args of rows) insertItem(ctx.db, id, ...args);
		});
		return taskResult(ctx, id);
	} finally {
		ctx.db.close();
	}
}
async function fetchPages(ctx, id, cfg, options) {
	const opts = {...options, selected: cfg.selected === null ? null : new Set(cfg.selected)};
	for (const f of cfg.folders.filter(
		(x) => x.bilibiliId && !x.complete && Number.isSafeInteger(x.nextPage),
	)) {
		while (Number.isSafeInteger(f.nextPage)) {
			options.signal?.throwIfAborted();
			const pageNo = f.nextPage;
			let page;
			try {
				page = await readBilibiliPage(f.bilibiliId, pageNo, options);
			} catch (e) {
				if (options.signal?.aborted) throw e;
				f.reason = typeof e.code === 'string' ? e.code : 'network_error';
				break;
			}
			{
				const signature = createHash('sha256')
					.update(JSON.stringify(page.items.map((x) => x.id)))
					.digest('hex');
				// Absence of progress is partial even when a service keeps returning has_more.
				if ((f.seen || []).includes(signature) || (!page.items.length && page.next !== null)) {
					f.reason = 'repeated_page';
					break;
				}
				const dir = {id: f.id, name: page.name, platform: 'bilibili'};
				const rows = await inputsFor(page.items, dir, ctx.root, opts, f.id + '-' + pageNo);
				f.name = page.name;
				f.total = page.total;
				f.pagesRead++;
				f.read += page.items.length;
				f.seen = [...(f.seen || []), signature];
				f.nextPage = page.next;
				f.complete = page.next === null;
				delete f.reason;
				if (f.complete && f.total !== null && f.read !== f.total) {
					f.complete = false;
					f.reason = 'count_mismatch';
				}
				transaction(ctx.db, () => {
					const insert = ctx.db.prepare('INSERT OR IGNORE INTO folder_members VALUES(?,?,?)');
					for (const item of page.items)
						if (!insert.run(id, f.id, item.platform + ':' + item.id).changes) f.overlap = true;
					if (f.complete && f.overlap) {
						f.complete = false;
						f.reason = 'overlapping_pages';
					}
					for (const args of rows) insertItem(ctx.db, id, ...args);
					ctx.db.prepare('UPDATE tasks SET config=? WHERE id=?').run(JSON.stringify(cfg), id);
				});
			}
		}
		ctx.db.prepare('UPDATE tasks SET config=? WHERE id=?').run(JSON.stringify(cfg), id);
	}
}
const errorCode = (e) =>
	typeof e?.code === 'string' && !e.code.startsWith('ERR_') ? e.code : 'save_failed';
// Media bytes are always fetched here, never relayed through the browser, so a
// batch has no combined size limit. A failed file keeps its slot and reason.
async function fillDetails(ctx, item, details, options) {
	const served =
		item.platform === 'xiaohongshu' && details.sourceUrl
			? matchingTarget(details.sourceUrl, item)
			: null;
	const read = await normalizeEntry(
		{
			...details,
			platform: item.platform,
			id: item.id,
			sourceUrl: served?.url ?? item.sourceUrl,
			attachments: (details.attachments ?? []).map(({kind, alt}) => ({kind, alt})),
		},
		null,
		ctx.root,
	);
	const headers = {'user-agent': browserHeaders(details.userAgent)['user-agent']};
	const referer = new URL(read.sourceUrl).origin + '/';
	const totalAttachments = read.attachments.length;
	const attachmentBytes = Array.from({length: totalAttachments}, () => 0);
	const attachmentTotals = Array.from({length: totalAttachments}, () => 0);
	let completedAttachments = 0;
	const emitAttachmentProgress = () => {
		let downloadedBytes = 0;
		let totalBytes = 0;
		for (let j = 0; j < totalAttachments; j++) {
			downloadedBytes += attachmentBytes[j];
			totalBytes += attachmentTotals[j];
		}
		options.onItemEvent?.({
			stage: 'downloading',
			title: read.title || item.title,
			kind: details.kind === 'video' ? 'video' : item.kind,
			attachmentIndex: Math.min(totalAttachments, completedAttachments + 1),
			attachmentTotal: totalAttachments,
			downloadedBytes,
			totalBytes,
		});
	};
	const attachmentConcurrency = Math.min(3, totalAttachments);
	let nextAttachment = 0;
	if (totalAttachments > 0) emitAttachmentProgress();
	await Promise.all(
		Array.from({length: attachmentConcurrency}, async () => {
			while (nextAttachment < totalAttachments) {
				options.signal?.throwIfAborted();
				const i = nextAttachment++;
				const a = read.attachments[i];
				const url = details.attachments[i]?.url;
				delete a.missing;
				try {
					if (typeof url !== 'string') throw problem('source_unavailable', 'No media address.');
					a.path = await downloadAttachment(ctx.root, url, a.kind, {
						signal: options.signal,
						localOrigin: options.localOrigin,
						maxBytes: options.maxBytes,
						referer,
						headers,
						onProgress: ({downloadedBytes, totalBytes}) => {
							attachmentBytes[i] = downloadedBytes;
							attachmentTotals[i] = totalBytes;
							emitAttachmentProgress();
						},
					});
				} catch (e) {
					options.signal?.throwIfAborted();
					a.missing = true;
					a.needsSource = true;
					a.error = errorCode(e);
				} finally {
					completedAttachments++;
					emitAttachmentProgress();
				}
			}
		}),
	);
	delete item.readError;
	Object.assign(item, {
		sourceUrl: read.sourceUrl,
		kind: details.kind === 'video' ? 'video' : item.kind,
		title: read.title || item.title,
		author: read.author || item.author,
		body: read.body,
		bodyFormat: read.bodyFormat,
		bodyComplete: read.bodyComplete,
		attachments: read.attachments,
		missing: unique([...item.missing, ...read.missing]),
		coverage: read.coverage || item.coverage,
	});
}
function partialReason(record) {
	return (
		record.readError ||
		record.attachments.find((a) => a.error)?.error ||
		(record.missing.includes('attachments')
			? 'attachments'
			: record.missing.includes('full text')
				? 'full_text'
				: 'partial')
	);
}
async function saveItem(ctx, input, old, options) {
	const item = mergeInput(old, input);
	let missingFile = false;
	for (const a of item.attachments) {
		if (!a.path) continue;
		try {
			if ((await stat(path.join(ctx.root, a.path))).isFile()) continue;
		} catch (e) {
			if (e.code !== 'ENOENT') throw e;
		}
		delete a.path;
		a.missing = true;
		missingFile = true;
	}
	if (old?.status === 'complete' && !missingFile && !input.body && !input.attachments.length) {
		item.missing = old.missing;
		item.status = old.status;
		return {record: item, outcome: 'skipped'};
	}
	if (input.coverage === 'unavailable_resource')
		throw problem('unavailable', 'The collection member is unavailable.');
	if (
		item.kind === 'video' &&
		!item.attachments.some((a) => a.kind === 'video' && (a.path || a.needsSource))
	) {
		const tmp = await mkdtemp(path.join(tmpdir(), 'fetchy-library-'));
		try {
			options.onItemEvent?.({
				stage: 'downloading',
				title: item.title,
				kind: 'video',
				downloadedBytes: 0,
				totalBytes: 0,
			});
			const download = (cookiesFile) =>
				(options.downloadVideo || defaultDownload)(item.sourceUrl, {
					outputDir: tmp,
					signal: options.signal,
					cookiesFile,
					onProgress: ({stage, bytes, totalBytes}) =>
						options.onItemEvent?.({
							stage:
								stage === 'postprocessing'
									? 'merging'
									: stage === 'validating'
										? 'verifying'
										: 'downloading',
							title: item.title,
							kind: 'video',
							downloadedBytes: Number.isFinite(bytes) ? bytes : 0,
							totalBytes: Number.isFinite(totalBytes) ? totalBytes : 0,
						}),
				});
			const res =
				!options.cookiesFile && options.withSiteCookies
					? await options.withSiteCookies(item.sourceUrl, download)
					: await download(options.cookiesFile);
			const downloadId =
				item.platform === 'bilibili' && /_p\d+$/.test(item.id)
					? item.id.replace(/_p\d+$/, '')
					: item.id;
			if (res.platform !== item.platform || String(res.id) !== downloadId)
				throw problem('wrong_video', 'Saved media does not match the collection member.');
			const source = await realpath(res.filepath);
			const actualTmp = await realpath(tmp);
			if (!source.startsWith(actualTmp + path.sep))
				throw problem('invalid_attachment', 'Unexpected download location.');
			const attachment = {
				kind: 'video',
				name: path.basename(res.filepath),
				path: await stashFile(ctx.root, source, 'video', 'video/mp4'),
			};
			const slot = item.attachments.findIndex((a) => a.kind === 'video');
			if (slot === -1) item.attachments.push(attachment);
			else item.attachments[slot] = attachment;
			item.title ||= res.title;
		} finally {
			await rm(tmp, {recursive: true, force: true});
		}
	}
	const missing = [...item.missing];
	if (!item.bodyComplete && item.kind !== 'video') missing.push('full text');
	if (item.attachments.some((a) => !a.path)) missing.push('attachments');
	item.missing = unique(missing);
	item.status = missing.length ? 'partial' : 'complete';
	if (options.outputDir && item.attachments.some((a) => a.path)) {
		const published = await publishLibraryMedia(ctx.root, item, options.outputDir);
		if (published.savedFiles.length) {
			item.savedFiles = published.savedFiles;
			if (published.savedDir) item.savedDir = published.savedDir;
			else delete item.savedDir;
		}
	}
	const changed =
		!old ||
		JSON.stringify({...item, folders: [], savedAt: null, topics: [], notes: ''}) !==
			JSON.stringify({...old, folders: [], savedAt: null, topics: [], notes: ''});
	return {
		record: item,
		outcome: item.status === 'partial' ? 'partial' : changed ? 'added' : 'skipped',
	};
}
export async function runLibraryTask(id, options = {}) {
	let retryKeys;
	if (options.retryFailed && options.selected !== undefined) {
		if (
			!Array.isArray(options.selected) ||
			!options.selected.every((key) => typeof key === 'string')
		)
			throw problem('invalid_options', 'Select failed entries by platform:id keys.');
		retryKeys = new Set(options.selected);
	}
	const ctx = await openLibrary(options),
		{db} = ctx;
	try {
		taskResult(ctx, id, false);
		const runId = randomUUID();
		let owned = false;
		return await withWorker(ctx.root, options.signal, async () => {
			const cfg = JSON.parse(db.prepare('SELECT config FROM tasks WHERE id=?').get(id).config);
			owned = true;
			cfg.runnerPid = process.pid;
			cfg.runId = runId;
			db.prepare('UPDATE tasks SET config=? WHERE id=?').run(JSON.stringify(cfg), id);
			db.prepare("UPDATE tasks SET status='running' WHERE id=?").run(id);
			if (!options.retryFailed) await fetchPages(ctx, id, cfg, options);
			// A retry reads partial entries again too: their missing files keep the slot.
			const list = db
				.prepare(
					options.retryFailed
						? "SELECT key,input FROM items WHERE task=? AND status IN ('failed','partial') ORDER BY rowid"
						: "SELECT key,input FROM items WHERE task=? AND status='pending' ORDER BY rowid",
				)
				.all(id);
			const runnable = list.filter((row) => !retryKeys || retryKeys.has(row.key));
			const requestedConcurrency = options.concurrency ?? 3;
			const concurrency = Math.max(
				1,
				Math.min(8, Number.isSafeInteger(requestedConcurrency) ? requestedConcurrency : 3),
			);
			let cursor = 0;
			let fatalError = null;
			const processRow = async (row) => {
				options.signal?.throwIfAborted();
				const item = JSON.parse(row.input);
				if (!item.sourceUrl) return;
				if (options.isItemCancelled?.(row.key)) {
					db.prepare(
						"UPDATE items SET status='cancelled',reason='cancelled' WHERE task=? AND key=?",
					).run(id, row.key);
					options.onItemDone?.(row.key);
					return;
				}
				const itemController = options.itemController?.(row.key);
				const itemSignal =
					itemController && options.signal
						? AbortSignal.any([options.signal, itemController.signal])
						: (itemController?.signal ?? options.signal);
				const emitItem = (patch) =>
					options.onItemEvent?.({
						taskId: id,
						key: row.key,
						title: item.title || row.key,
						platform: item.platform,
						kind: item.kind,
						folder: item.folders?.[0]?.name || '',
						sourceUrl: item.sourceUrl,
						...patch,
					});
				const itemOptions = {
					...options,
					signal: itemSignal,
					onItemEvent: emitItem,
				};
				let fetchedOverNetwork = false;
				let usedResolver = false;
				try {
					// Temporary URLs live only in the native worker. The durable input
					// already has the text, inline files, and ordered slots for remote files.
					if (item.attachments.some((a) => a.pendingAttachment)) {
						const pendingList = item.attachments.filter((a) => a.pendingAttachment);
						let idx = 0;
						for (const a of item.attachments) {
							if (!a.pendingAttachment) continue;
							idx++;
							if (options.resolveAttachment) {
								usedResolver = true;
								emitItem({
									stage: 'downloading',
									attachmentIndex: idx,
									attachmentTotal: pendingList.length,
									downloadedBytes: 0,
									totalBytes: 0,
								});
							}
							let file;
							try {
								file = await options.resolveAttachment?.(
									a.pendingAttachment,
									a.kind,
									item,
									({downloadedBytes, totalBytes}) =>
										emitItem({
											stage: 'downloading',
											attachmentIndex: idx,
											attachmentTotal: pendingList.length,
											downloadedBytes,
											totalBytes,
										}),
									itemSignal,
								);
							} catch (e) {
								options.signal?.throwIfAborted();
								if (itemController?.signal.aborted) throw e;
								a.error = errorCode(e);
							}
							// The id stays until a file arrives, so a retry in this session can fetch it again.
							if (file) {
								delete a.pendingAttachment;
								a.path = file;
								delete a.missing;
								delete a.needsSource;
								delete a.error;
							} else {
								a.missing = true;
								a.needsSource = true;
							}
						}
						db.prepare('UPDATE items SET input=? WHERE task=? AND key=?').run(
							JSON.stringify(item),
							id,
							row.key,
						);
					}
					for (const a of item.attachments) delete a.pendingAttachment;
					const oldRow = db.prepare('SELECT record FROM works WHERE key=?').get(row.key);
					const old = oldRow && JSON.parse(oldRow.record);
					// A row merged with a fuller copy of the same post keeps that copy's text and files.
					if (
						item.needsDetails &&
						!item.body &&
						!item.attachments.length &&
						options.readDetails &&
						old?.status !== 'complete'
					) {
						emitItem({stage: 'reading_post', downloadedBytes: 0, totalBytes: 0});
						const details = await options.readDetails(item, {taskId: id, signal: itemSignal});
						if (!details) throw problem('source_unavailable', 'Could not read original post.');
						fetchedOverNetwork = true;
						await fillDetails(ctx, item, details, itemOptions);
						if (
							item.coverage === 'preview' &&
							!item.bodyComplete &&
							item.attachments.every((a) => !a.path)
						)
							throw problem('source_unavailable', 'Only an incomplete preview was available.');
					}
					// Never save an empty media-less shell into works when every expected media download failed.
					if (
						(fetchedOverNetwork || usedResolver) &&
						item.attachments.length > 0 &&
						item.attachments.every((a) => !a.path) &&
						!old?.attachments?.some((a) => a.path)
					) {
						const code = item.attachments.find((a) => a.error)?.error || 'network_error';
						throw problem(code, 'Failed to download media attachments.');
					}
					delete item.needsDetails;
					const {record, outcome} = await saveItem(ctx, item, old, itemOptions);
					await renderWork(ctx.root, record);
					options.signal?.throwIfAborted();
					if (itemController?.signal.aborted) throw problem('cancelled', 'Item cancelled.');
					transaction(db, () => {
						db.prepare(
							'INSERT INTO works VALUES(?,?) ON CONFLICT(key) DO UPDATE SET record=excluded.record',
						).run(row.key, JSON.stringify(record));
						db.prepare('UPDATE items SET status=?,reason=? WHERE task=? AND key=?').run(
							outcome,
							outcome === 'partial' ? partialReason(record) : null,
							id,
							row.key,
						);
					});
					emitItem({stage: 'done'});
				} catch (e) {
					if (options.signal?.aborted) throw e;
					if (itemController?.signal.aborted) {
						db.prepare(
							"UPDATE items SET status='cancelled',reason='cancelled' WHERE task=? AND key=?",
						).run(id, row.key);
						emitItem({stage: 'cancelled'});
					} else {
						const reason = errorCode(e);
						db.prepare("UPDATE items SET status='failed',reason=? WHERE task=? AND key=?").run(
							reason,
							id,
							row.key,
						);
						emitItem({stage: 'failed', reason});
					}
				}
				options.onItemDone?.(row.key);
				await options.onProgress?.(taskResult(ctx, id, false));
			};
			await Promise.all(
				Array.from({length: Math.min(concurrency, runnable.length)}, async () => {
					while (!fatalError) {
						if (options.signal?.aborted) break;
						const idx = cursor++;
						if (idx >= runnable.length) break;
						try {
							await processRow(runnable[idx]);
						} catch (e) {
							if (!fatalError) fatalError = e;
							break;
						}
					}
				}),
			);
			if (fatalError) throw fatalError;
			options.signal?.throwIfAborted();
			if (cfg.selected && cfg.folders.every((f) => f.complete)) {
				transaction(db, () => {
					const missing = db.prepare(
						"INSERT OR IGNORE INTO items(task,key,input,status,reason) VALUES(?,?,?,'failed','selection_missing')",
					);
					for (const key of cfg.selected) missing.run(id, key, JSON.stringify({key}));
				});
			}
			const c = countsFor(db, id);
			const partial = c.partial > 0 || cfg.folders.some((f) => !f.complete) || c.pending > 0;
			const status =
				c.failed && !partial && !c.added && !c.skipped
					? 'failed'
					: partial || c.failed
						? 'partial'
						: 'completed';
			// A finished run has carried out any pending retry.
			db.prepare("UPDATE tasks SET status=?, config=json_remove(config,'$.retry') WHERE id=?").run(
				status,
				id,
			);
			return taskResult(ctx, id);
		}).catch((err) => {
			// Cancelled by its caller (the CLI's Ctrl+C): the native worker must not resume it on its own.
			if (owned)
				db.prepare(
					options.signal?.aborted
						? "UPDATE tasks SET status='interrupted', config=json_set(config,'$.nativeQueue',json('false')) WHERE id=? AND status='running' AND json_extract(config,'$.runId')=?"
						: "UPDATE tasks SET status='interrupted' WHERE id=? AND status='running' AND json_extract(config,'$.runId')=?",
				).run(id, runId);
			throw err;
		});
	} finally {
		db.close();
	}
}
export async function importLibrary(manifest, options = {}) {
	const task = await prepareLibraryTask(manifest, options);
	return runLibraryTask(task.id, options);
}
/** Show a task as waiting while a retry or resume sits in the native queue. */
export async function markLibraryTaskQueued(id, options = {}, retry) {
	const ctx = await openLibrary(options);
	try {
		// Native-owned from now on, so a restart picks it up again, as a retry when it was one.
		ctx.db
			.prepare(
				"UPDATE tasks SET status='queued', config=json_set(config,'$.nativeQueue',json('true'),'$.retry',json(?)) WHERE id=? AND status<>'running'",
			)
			.run(JSON.stringify(retry ? {selected: retry.selected ?? null} : null), id);
	} finally {
		ctx.db.close();
	}
}
/** A queued run that never started is shown as interrupted, so it can be resumed. */
export async function markLibraryTaskInterrupted(id, options = {}) {
	const ctx = await openLibrary(options);
	try {
		ctx.db.prepare("UPDATE tasks SET status='interrupted' WHERE id=? AND status='queued'").run(id);
	} finally {
		ctx.db.close();
	}
}
export async function getLibraryTask(id, options = {}) {
	const ctx = await openLibrary(options);
	try {
		return taskResult(ctx, id);
	} finally {
		ctx.db.close();
	}
}
export async function listRecoverableNativeTasks(options = {}) {
	const ctx = await openLibrary(options);
	try {
		return ctx.db
			.prepare(
				"SELECT id, json_extract(config,'$.retry') AS retry FROM tasks WHERE status IN ('queued','running','interrupted') AND json_extract(config,'$.nativeQueue') = 1 ORDER BY created",
			)
			.all()
			.map(({id, retry}) => ({
				...taskResult(ctx, id, false),
				retry: retry ? JSON.parse(retry) : null,
			}))
			.filter((task) => task.status !== 'running');
	} finally {
		ctx.db.close();
	}
}
export async function listLibraryTasks(options = {}) {
	const ctx = await openLibrary(options);
	try {
		return ctx.db
			.prepare('SELECT id FROM tasks ORDER BY created DESC')
			.all()
			.map((r) => taskResult(ctx, r.id, false));
	} finally {
		ctx.db.close();
	}
}
export async function searchLibrary(filters = {}, options = {}) {
	const ctx = await openLibrary(options);
	try {
		const q = String(filters.query ?? '').toLocaleLowerCase();
		return ctx.db
			.prepare('SELECT record FROM works ORDER BY rowid DESC')
			.all()
			.map((r) => JSON.parse(r.record))
			.filter(
				(x) =>
					(!filters.platform || filters.platform === x.platform) &&
					(!filters.key || filters.key === x.key) &&
					(!filters.folder || x.folders.some((f) => [f.id, f.name].includes(filters.folder))) &&
					(!filters.topic || x.topics.includes(filters.topic)) &&
					(!q ||
						[
							x.customTitle,
							x.title,
							x.author,
							x.body,
							x.notes,
							x.sourceUrl,
							...x.topics,
							...x.folders.map((f) => f.name),
						].some((v) => String(v).toLocaleLowerCase().includes(q))),
			)
			.map((x) => ({...x, filepath: workFile(ctx.root, x)}));
	} finally {
		ctx.db.close();
	}
}
export async function exportLibrary(filters = {}, options = {}) {
	const rows = await searchLibrary(filters, options);
	return {version: 1, items: rows.map(({filepath, ...record}) => record)};
}

const ownMedia = (root, relative) => {
	const file = path.resolve(root, relative);
	return file.startsWith(path.join(root, 'media') + path.sep) ? file : null;
};
/**
 * Forget saved works. Returns the files that belonged only to them, for the caller to
 * move to the Trash; media shared with another work stays. Task history is kept, and
 * saving the same entry again downloads it afresh.
 */
export async function removeLibraryWorks(keys, options = {}) {
	if (!Array.isArray(keys) || !keys.every((k) => typeof k === 'string' && k))
		throw problem('invalid_options', 'Pass the platform:id keys to remove.');
	const ctx = await openLibrary(options);
	try {
		const wanted = new Set(keys);
		const removed = [];
		const kept = new Set();
		transaction(ctx.db, () => {
			for (const {key, record} of ctx.db.prepare('SELECT key, record FROM works').all()) {
				const work = JSON.parse(record);
				if (!wanted.has(key)) {
					for (const a of work.attachments) if (a.path) kept.add(path.resolve(ctx.root, a.path));
					continue;
				}
				removed.push(work);
				ctx.db.prepare('DELETE FROM works WHERE key=?').run(key);
			}
		});
		const files = new Set();
		for (const work of removed) {
			files.add(path.dirname(workFile(ctx.root, work)));
			if (typeof work.savedDir === 'string' && work.savedDir) {
				files.add(work.savedDir);
			} else {
				for (const f of work.savedFiles ?? []) {
					if (typeof f === 'string' && f) files.add(f);
				}
			}
			for (const a of work.attachments) {
				const file = a.path && ownMedia(ctx.root, a.path);
				if (file && !kept.has(file)) files.add(file);
			}
		}
		return {removed: removed.map((w) => w.key), files: [...files]};
	} finally {
		ctx.db.close();
	}
}
/** Give a saved work its own title; an empty title returns to the one read from the site. */
export async function renameLibraryWork(key, title, options = {}) {
	if (typeof key !== 'string' || typeof title !== 'string' || title.length > 512)
		throw problem('invalid_options', 'Pass a key and a title of at most 512 characters.');
	const ctx = await openLibrary(options);
	try {
		const row = ctx.db.prepare('SELECT record FROM works WHERE key=?').get(key);
		if (!row) throw problem('not_found', 'No such saved work.');
		const work = JSON.parse(row.record);
		const value = title.replace(/\s+/g, ' ').trim();
		if (value && value !== work.title) work.customTitle = value;
		else delete work.customTitle;
		await renamePublishedMedia(work);
		await renderWork(ctx.root, work);
		ctx.db.prepare('UPDATE works SET record=? WHERE key=?').run(JSON.stringify(work), key);
		return {key, title: displayTitle(work)};
	} finally {
		ctx.db.close();
	}
}

/** Legacy empty partial shells created when post reads used to be swallowed. */
export function isEmptyPartialShell(work) {
	return (
		work?.status === 'partial' &&
		!work.body &&
		!(work.attachments ?? []).some((a) => typeof a.path === 'string' && a.path)
	);
}

/** Pending items across active/interrupted tasks, for displaying a flat per-item download queue. */
export async function listQueuedLibraryItems(options = {}) {
	const ctx = await openLibrary(options);
	try {
		const rows = ctx.db
			.prepare(
				`SELECT i.task, i.key, i.input, i.status, t.status AS taskStatus, t.created
				 FROM items i JOIN tasks t ON t.id = i.task
				 WHERE t.status IN ('queued','running','interrupted') AND i.status = 'pending'
				 ORDER BY t.created ASC, i.rowid ASC
				 LIMIT 300`,
			)
			.all();
		return rows.map((r) => {
			const entry = JSON.parse(r.input);
			return {
				id: r.task + '::' + r.key,
				taskId: r.task,
				key: r.key,
				title: entry.customTitle || entry.title || r.key,
				platform: entry.platform ?? r.key.split(':')[0],
				kind: entry.kind || 'post',
				folder: entry.folders?.[0]?.name || '',
				sourceUrl: entry.sourceUrl ?? null,
				status: r.taskStatus === 'interrupted' ? 'interrupted' : 'queued',
				stage: r.taskStatus === 'interrupted' ? 'interrupted' : 'waiting',
				downloadedBytes: 0,
				totalBytes: 0,
			};
		});
	} finally {
		ctx.db.close();
	}
}

/** Deduplicated failed (or legacy partial) items whose key is not already cleanly saved in works. */
export async function listFailedLibraryItems(options = {}) {
	const ctx = await openLibrary(options);
	try {
		const rows = ctx.db
			.prepare(
				`SELECT i.task, i.key, i.input, i.status, i.reason, t.created, w.record
				 FROM items i
				 JOIN tasks t ON t.id = i.task
				 LEFT JOIN works w ON w.key = i.key
				 WHERE i.status IN ('failed','partial')
				 ORDER BY t.created DESC, i.rowid DESC
				 LIMIT 500`,
			)
			.all();
		const seen = new Set();
		const failed = [];
		for (const r of rows) {
			if (seen.has(r.key)) continue;
			seen.add(r.key);
			const work = r.record ? JSON.parse(r.record) : null;
			if (work && work.status === 'complete') continue;
			const entry = work ?? JSON.parse(r.input);
			failed.push({
				id: r.task + '::' + r.key,
				taskId: r.task,
				key: r.key,
				title: entry.customTitle || entry.title || '',
				author: entry.author ?? '',
				platform: entry.platform ?? r.key.split(':')[0],
				status: r.status,
				reason: r.reason || 'save_failed',
				sourceUrl: entry.sourceUrl ?? null,
				createdAt: r.created ?? null,
			});
		}
		return failed;
	} finally {
		ctx.db.close();
	}
}

/** Dismiss failed items so they leave the Failed view without deleting completed works. */
export async function dismissFailedLibraryItems(keys, options = {}) {
	const ctx = await openLibrary(options);
	try {
		transaction(ctx.db, () => {
			if (Array.isArray(keys) && keys.length > 0) {
				const stmt = ctx.db.prepare(
					"UPDATE items SET status='dismissed' WHERE key=? AND status IN ('failed','partial')",
				);
				for (const key of keys) {
					if (typeof key === 'string' && key) stmt.run(key);
				}
			} else {
				ctx.db
					.prepare("UPDATE items SET status='dismissed' WHERE status IN ('failed','partial')")
					.run();
			}
		});
		return {ok: true};
	} finally {
		ctx.db.close();
	}
}

/** Mark one queued/pending item as cancelled in SQLite; if no pending items remain, close the task. */
export async function cancelQueuedLibraryItem(taskId, key, options = {}) {
	const ctx = await openLibrary(options);
	try {
		transaction(ctx.db, () => {
			ctx.db
				.prepare(
					"UPDATE items SET status='cancelled', reason='cancelled' WHERE task=? AND key=? AND status='pending'",
				)
				.run(taskId, key);
			const left = ctx.db
				.prepare("SELECT count(*) AS n FROM items WHERE task=? AND status='pending'")
				.get(taskId).n;
			if (left === 0) {
				ctx.db
					.prepare(
						"UPDATE tasks SET status='completed' WHERE id=? AND status IN ('queued','interrupted')",
					)
					.run(taskId);
			}
		});
		return {cancelled: true};
	} finally {
		ctx.db.close();
	}
}
