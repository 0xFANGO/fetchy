import {createHash, randomUUID} from 'node:crypto';
import {readdir, rm, stat} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {
	cancelQueuedLibraryItem,
	dismissFailedLibraryItems,
	getLibraryTask,
	isEmptyPartialShell,
	libraryRoot,
	listFailedLibraryItems,
	listLibraryTasks,
	listQueuedLibraryItems,
	listRecoverableNativeTasks,
	markLibraryTaskInterrupted,
	markLibraryTaskQueued,
	prepareLibraryTask,
	removeLibraryWorks,
	renameLibraryWork,
	runLibraryTask,
	searchLibrary,
} from '../src/library/index.mjs';
import {downloadAttachment, entryIdentity} from '../src/library/content.mjs';
import {
	PAGE_LIMIT,
	browserHeaders,
	fetchPostPage,
	parsePostPage,
} from '../src/library/post-pages.mjs';
import {saveWebFile} from '../src/public-http.mjs';
import {siteForHost} from '../src/sites/index.mjs';
import {matchingTarget} from '../src/urls.mjs';
import {defaultOutputDirectory} from './settings.mjs';
import {LibraryUploads} from './library-upload.mjs';
import {EngineError, runProcess} from '../src/process.mjs';

const fail = () => {
	throw new EngineError('invalid_request', '收藏输入无效或过大。');
};
function checkEntry(entry) {
	if (
		!entry ||
		typeof entry !== 'object' ||
		typeof entry.id !== 'string' ||
		typeof entry.platform !== 'string'
	)
		fail();
	if (
		entry.attachments !== undefined &&
		(!Array.isArray(entry.attachments) || entry.attachments.length > 100)
	)
		fail();
}
function allEntries(manifest) {
	if (
		!manifest ||
		manifest.version !== 1 ||
		(manifest.folders !== undefined && !Array.isArray(manifest.folders))
	)
		fail();
	if (manifest.items !== undefined && !Array.isArray(manifest.items)) fail();
	const entries = [...(manifest.items ?? [])];
	for (const folder of manifest.folders ?? []) {
		if (!folder || folder.source) fail();
		if (Array.isArray(folder.items) && folder.pages === undefined) {
			entries.push(...folder.items);
			continue;
		}
		if (!Array.isArray(folder.pages) || folder.items !== undefined) fail();
		for (const page of folder.pages) {
			if (!Array.isArray(page.items)) fail();
			entries.push(...page.items);
		}
	}
	if (entries.length > 5000) fail();
	for (const entry of entries) checkEntry(entry);
	return entries;
}
function boundedRows(rows, budget) {
	let used = 0;
	return rows.filter((row) => {
		used += Buffer.byteLength(JSON.stringify(row)) + 1;
		return used <= budget;
	});
}
/** video, post (images and text) or article (long text), for the desktop filters. */
function desktopKind({kind, platform, bodyFormat, attachments}) {
	if (kind === 'video' || kind === 'audio') return kind;
	return bodyFormat === 'markdown' ||
		(platform === 'zhihu' && !attachments.some((a) => a.kind === 'video'))
		? 'article'
		: 'post';
}
function summary(task, offset = 0) {
	const {items, folders, ...record} = task;
	return {
		...record,
		totalFolders: folders.length,
		folders: boundedRows(folders.slice(offset, offset + 100), 100 * 1024),
	};
}
function stagingBudget(options = {}) {
	const deadline = AbortSignal.timeout(10 * 60_000);
	return {
		remaining: options.maxBytes ?? 1024 ** 3,
		sequence: 0,
		files: new Map(),
		signal: options.signal ? AbortSignal.any([deadline, options.signal]) : deadline,
	};
}
function checkAttachment(a) {
	if (!a || !['image', 'video', 'audio'].includes(a.kind) || a.path !== undefined) fail();
	if (a.url !== undefined && (typeof a.url !== 'string' || a.url.length > 16384)) fail();
}

export async function stageAttachments(entries, directory, selected, options = {}) {
	const state = options.staging ?? stagingBudget(options);
	for (const entry of entries) {
		if (selected && !selected.has(entryIdentity(entry).key)) continue;
		for (const attachment of entry.attachments ?? []) {
			checkAttachment(attachment);
			if (attachment.url === undefined) continue;
			const uri = attachment.url;
			delete attachment.url;
			try {
				if (!state.files.has(uri)) {
					if (state.remaining <= 0 || state.signal.aborted) throw Error('exhausted');
					const localName = 'attachment-' + ++state.sequence;
					const file = path.join(directory, localName);
					const limit = Math.min(state.remaining, 256 * 1024 ** 2);
					let mime;
					try {
						mime = await saveWebFile(uri, file, {
							signal: state.signal,
							localOrigin: options.localOrigin,
							headers: options.headers,
							maxBytes: limit,
						});
					} catch (error) {
						// A truncated transfer still consumes the same per-task budget.
						state.remaining -=
							error.code === 'size_limit'
								? limit
								: await stat(file).then(
										(s) => s.size,
										() => 0,
									);
						await rm(file, {force: true});
						throw error;
					}
					state.remaining -= mime.bytes;
					state.files.set(uri, {path: localName, mimeType: mime.mimeType});
				}
				const stored = state.files.get(uri);
				if (!stored.mimeType.startsWith(attachment.kind + '/')) throw Error('type');
				Object.assign(attachment, stored);
			} catch {
				options.signal?.throwIfAborted();
				attachment.missing = true;
			}
		}
	}
}

function captureTransfers(entries) {
	const urls = new WeakMap(),
		pending = new Map();
	for (const entry of entries) {
		for (const a of entry.attachments ?? []) {
			checkAttachment(a);
			if (a.url !== undefined) {
				urls.set(a, a.url);
				delete a.url;
			}
		}
	}
	return {
		pending,
		deferAttachment(a) {
			const url = urls.get(a);
			if (!url) return;
			const id = pending.size + 1;
			pending.set(id, url);
			return id;
		},
	};
}

async function clearAbandonedDownloads(root) {
	let entries;
	try {
		entries = await readdir(root, {withFileTypes: true});
	} catch (error) {
		if (error.code === 'ENOENT') return;
		throw error;
	}
	for (const entry of entries) {
		const match = /^\.download-(\d+)-[A-Za-z0-9]{6}$/.exec(entry.name);
		if (!match || !entry.isDirectory()) continue;
		try {
			process.kill(Number(match[1]), 0);
		} catch (error) {
			if (error.code === 'ESRCH')
				await rm(path.join(root, entry.name), {recursive: true, force: true});
		}
	}
}

async function clearAbandonedAttachments(directory) {
	let entries;
	try {
		entries = await readdir(directory, {withFileTypes: true});
	} catch (error) {
		if (error.code === 'ENOENT') return;
		throw error;
	}
	for (const entry of entries) {
		const match = /^\.native-attachments-(\d+)-[A-Za-z0-9]{6}$/.exec(entry.name);
		if (!match || !entry.isDirectory()) continue;
		try {
			process.kill(Number(match[1]), 0);
		} catch (error) {
			if (error.code === 'ESRCH')
				await rm(path.join(directory, entry.name), {recursive: true, force: true});
		}
	}
}

const FEED_IDLE_MS = 20_000;
const FEED_WAIT_MS = 120_000;
const sameSite = (a, b) => {
	const tail = (u) => new URL(u).hostname.split('.').slice(-2).join('.');
	try {
		return new URL(a).protocol === 'https:' && tail(a) === tail(b);
	} catch {
		return false;
	}
};

function extractHttpUrl(raw) {
	if (typeof raw !== 'string') return null;
	const trimmed = raw.trim();
	if (!trimmed || trimmed.length > 4096) return null;
	const match = /https?:\/\/[^\s<>'"\u3000\uFF0C\u3002\uFF01\uFF1F]+/i.exec(trimmed);
	const candidate = match ? match[0] : trimmed;
	try {
		const u = new URL(candidate);
		if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return null;
		return u;
	} catch {
		return null;
	}
}

function batchFingerprint(entries, selected) {
	const keys = selected ? [...selected].sort() : entries.map((e) => e.platform + ':' + e.id).sort();
	return createHash('sha256').update(JSON.stringify(keys)).digest('hex');
}

function workFiles(root, work) {
	if (Array.isArray(work.savedFiles) && work.savedFiles.length) return work.savedFiles;
	return (work.attachments ?? []).filter((a) => a.path).map((a) => path.join(root, a.path));
}

function primaryFileFor(root, work) {
	if (typeof work.savedDir === 'string' && work.savedDir) return work.savedDir;
	if (Array.isArray(work.savedFiles) && work.savedFiles.length) return work.savedFiles[0];
	const media = (work.attachments ?? []).find((a) => a.path);
	if (media) return path.join(root, media.path);
	return work.filepath;
}

export class LibraryBridge {
	constructor(directory, {session, getOutputDir} = {}) {
		this.directory = directory;
		this.options = {root: process.env.FETCHY_LIBRARY_DIR || path.join(directory, 'library')};
		this.getOutputDir = getOutputDir ?? null;
		this.active = new Map();
		this.preparing = 0;
		this.uploads = new LibraryUploads();
		this.tail = Promise.resolve();
		// Post pages read by the extension, parsed on arrival: task\nkey -> {entry|error|skip}.
		this.pages = new Map();
		// Last time the extension reported that it is still reading a task's pages.
		this.feeders = new Map();
		// Post links that carry a viewer token stay in memory only.
		this.visits = new Map();
		// Listing media URLs per task, kept in memory so a retry in this session can fetch them again.
		this.transfers = new Map();
		// Live per-item progress state for running library task items: taskId::key -> state.
		this.liveItems = new Map();
		this.itemControllers = new Map();
		this.cancelledItems = new Set();
		// Tracked single-URL / browser-sniffed media downloads.
		this.urlDownloads = new Map();
		this.urlFailures = new Map();
		// Deduplicate rapid repeated submissions of the exact same batch.
		this.recentStarts = new Map();
		this.nextXhsFetchAt = 0;
		this.sessionApi = session;
	}
	async resolveOutputDir() {
		if (this.options.outputDir) return this.options.outputDir;
		if (!this.getOutputDir) return undefined;
		try {
			return await this.getOutputDir();
		} catch {
			return undefined;
		}
	}
	async session() {
		if (!this.sessionApi) {
			const accounts = await import('../bin/accounts.mjs');
			this.sessionApi = {
				cookieHeader: (url) => accounts.siteCookieHeader(url),
				withCookies: (url, action) => accounts.withSiteCookies(url, action),
			};
		}
		return this.sessionApi;
	}
	updateLiveItem(event) {
		const id = event.taskId + '::' + event.key;
		if (['done', 'failed', 'cancelled'].includes(event.stage)) {
			this.liveItems.delete(id);
			this.itemControllers.delete(id);
			return;
		}
		const now = Date.now();
		const prev = this.liveItems.get(id);
		const downloadedBytes = Number.isFinite(event.downloadedBytes) ? event.downloadedBytes : 0;
		const totalBytes = Number.isFinite(event.totalBytes) ? event.totalBytes : 0;
		let speedBytesPerSec = prev?.speedBytesPerSec ?? 0;
		if (prev && downloadedBytes > prev._lastBytes && now - prev._lastAt >= 200) {
			speedBytesPerSec = Math.round(
				((downloadedBytes - prev._lastBytes) * 1000) / (now - prev._lastAt),
			);
		} else if (!prev || downloadedBytes < (prev._lastBytes ?? 0)) {
			speedBytesPerSec = 0;
		}
		this.liveItems.set(id, {
			id,
			taskId: event.taskId,
			key: event.key,
			title: event.title || prev?.title || event.key,
			platform: event.platform || prev?.platform || event.key.split(':')[0],
			kind: event.kind || prev?.kind || 'post',
			folder: event.folder ?? prev?.folder ?? '',
			sourceUrl: event.sourceUrl ?? prev?.sourceUrl ?? null,
			status: 'running',
			stage: event.stage || 'downloading',
			downloadedBytes,
			totalBytes,
			speedBytesPerSec,
			attachmentIndex: event.attachmentIndex ?? prev?.attachmentIndex ?? 0,
			attachmentTotal: event.attachmentTotal ?? prev?.attachmentTotal ?? 0,
			_lastBytes: downloadedBytes,
			_lastAt: prev && now - prev._lastAt < 200 ? prev._lastAt : now,
		});
	}
	publicLiveItem(item) {
		const {_lastBytes, _lastAt, controller, ...rest} = item;
		return rest;
	}
	async readDetails(taskId, item, signal) {
		const k = taskId + '\n' + item.key;
		const started = Date.now();
		for (;;) {
			const fed = this.pages.get(k);
			if (fed) {
				this.pages.delete(k);
				if (fed.error) throw new EngineError(fed.error, '无法读取原帖。');
				if (fed.entry) return fed.entry;
				break;
			}
			const last = this.feeders.get(taskId);
			if (!last || Date.now() - last > FEED_IDLE_MS || Date.now() - started > FEED_WAIT_MS) break;
			await delay(250, undefined, {signal});
		}
		if (item.platform === 'xiaohongshu' && !this.options.localOrigin) {
			const now = Date.now();
			const slot = Math.max(now, this.nextXhsFetchAt);
			this.nextXhsFetchAt = slot + 400;
			const waitMs = slot - now;
			if (waitMs > 0) await delay(waitMs, undefined, {signal});
		}
		const url = this.visits.get(k) ?? item.sourceUrl;
		const session = await this.session();
		return fetchPostPage(item, {
			url,
			cookieHeader: (href) => session.cookieHeader(href),
			signal,
			localOrigin: this.options.localOrigin,
		});
	}
	async run(task, options, pending) {
		const root = libraryRoot(options);
		const outputDir = await this.resolveOutputDir();
		const session = await this.session();
		const downloads = new Map();
		return runLibraryTask(task.id, {
			...options,
			outputDir,
			readDetails: (item, ctx) => this.readDetails(task.id, item, ctx?.signal ?? options.signal),
			isItemCancelled: (key) => this.cancelledItems.has(task.id + '::' + key),
			itemController: (key) => {
				const id = task.id + '::' + key;
				const controller = new AbortController();
				this.itemControllers.set(id, controller);
				return controller;
			},
			onItemEvent: (event) => this.updateLiveItem(event),
			// Whatever the worker did with an entry, a page fed for it is no longer needed.
			onItemDone: (key) => {
				this.pages.delete(task.id + '\n' + key);
				const id = task.id + '::' + key;
				this.liveItems.delete(id);
				this.itemControllers.delete(id);
				this.cancelledItems.delete(id);
			},
			withSiteCookies: (url, action) => session.withCookies(url, action),
			resolveAttachment: pending?.size
				? (id, kind, item, onProgress, itemSignal) => {
						const url = pending.get(id);
						if (!url) return;
						// One file can fill several slots; fetch it once per task.
						const key = kind + ' ' + url;
						if (!downloads.has(key))
							downloads.set(
								key,
								downloadAttachment(root, url, kind, {
									signal: itemSignal ?? options.signal,
									localOrigin: options.localOrigin,
									maxBytes: options.maxBytes,
									referer: new URL(item.sourceUrl).origin + '/',
									onProgress,
								}),
							);
						return downloads.get(key);
					}
				: undefined,
		});
	}
	queue(task, retryFailed, selected, pending = this.transfers.get(task.id)) {
		if (pending?.size) {
			// Most recent tasks only; the URLs are temporary and live in memory.
			this.transfers.delete(task.id);
			this.transfers.set(task.id, pending);
			while (this.transfers.size > 20) this.transfers.delete(this.transfers.keys().next().value);
		}
		if (!this.active.has(task.id)) {
			const work = this.tail.then(() =>
				this.run(task, {...this.options, retryFailed, selected}, pending),
			);
			this.tail = work
				.then((result) => {
					if (!result?.counts?.partial && !result?.counts?.failed) this.transfers.delete(task.id);
				})
				.catch(() => markLibraryTaskInterrupted(task.id, this.options).catch(() => {}))
				.finally(() => {
					this.active.delete(task.id);
					for (const k of this.pages.keys()) if (k.startsWith(task.id + '\n')) this.pages.delete(k);
					for (const k of this.liveItems.keys())
						if (k.startsWith(task.id + '::')) this.liveItems.delete(k);
					for (const k of this.itemControllers.keys())
						if (k.startsWith(task.id + '::')) this.itemControllers.delete(k);
				});
			this.active.set(task.id, work);
		}
		return summary(task);
	}
	async startUrlDownload(params) {
		const url = extractHttpUrl(params?.url);
		if (!url) throw new EngineError('invalid_url', '请输入有效的 HTTP 或 HTTPS 链接。');
		const href = url.href;
		// Deduplicate rapid clicks for the exact same active URL.
		for (const existing of this.urlDownloads.values()) {
			if (existing.sourceUrl === href) return this.publicLiveItem(existing);
		}
		const id = 'url::' + randomUUID();
		const key = 'url:' + createHash('sha256').update(href).digest('hex').slice(0, 16);
		const platform = siteForHost(url.hostname)?.platform ?? 'web';
		const cleanTitle =
			typeof params.title === 'string' && params.title.trim()
				? params.title.trim().slice(0, 200)
				: decodeURIComponent(path.basename(url.pathname) || url.hostname);
		const referer =
			typeof params.referer === 'string' && /^https?:\/\//i.test(params.referer)
				? params.referer
				: typeof params.pageUrl === 'string' && /^https?:\/\//i.test(params.pageUrl)
					? params.pageUrl
					: undefined;
		const controller = new AbortController();
		const state = {
			id,
			taskId: 'url',
			key,
			title: cleanTitle,
			platform,
			kind: params.kind === 'audio' ? 'audio' : 'video',
			folder: '',
			sourceUrl: href,
			referer: referer ?? null,
			status: 'running',
			stage: 'resolving',
			downloadedBytes: 0,
			totalBytes: 0,
			speedBytesPerSec: 0,
			attachmentIndex: 0,
			attachmentTotal: 0,
			_lastBytes: 0,
			_lastAt: Date.now(),
			controller,
		};
		this.urlDownloads.set(id, state);
		this.urlFailures.delete(key);
		const outputDir = (await this.resolveOutputDir()) || defaultOutputDirectory();
		const run = async () => {
			try {
				const {getOne} = await import('../bin/get.mjs');
				const headers = {
					'user-agent': browserHeaders()['user-agent'],
					...(referer ? {referer} : {}),
				};
				await getOne('get', href, {
					outputDir,
					root: libraryRoot(this.options),
					directFiles: true,
					title:
						typeof params.title === 'string' && params.title.trim()
							? params.title.trim()
							: undefined,
					headers,
					signal: controller.signal,
					onProgress: ({stage, bytes, downloadedBytes, totalBytes}) => {
						const cur = Number.isFinite(downloadedBytes)
							? downloadedBytes
							: Number.isFinite(bytes)
								? bytes
								: state.downloadedBytes;
						const now = Date.now();
						if (cur > state._lastBytes && now - state._lastAt >= 200) {
							state.speedBytesPerSec = Math.round(
								((cur - state._lastBytes) * 1000) / (now - state._lastAt),
							);
							state._lastBytes = cur;
							state._lastAt = now;
						}
						state.downloadedBytes = cur;
						if (Number.isFinite(totalBytes) && totalBytes > 0) state.totalBytes = totalBytes;
						if (stage === 'postprocessing') state.stage = 'merging';
						else if (stage === 'validating') state.stage = 'verifying';
						else if (stage === 'resolving') state.stage = 'resolving';
						else state.stage = 'downloading';
					},
				});
				this.urlFailures.delete(key);
			} catch (error) {
				if (!controller.signal.aborted && error?.code !== 'cancelled') {
					const reason =
						typeof error?.code === 'string' && !error.code.startsWith('ERR_')
							? error.code
							: 'save_failed';
					this.urlFailures.set(key, {
						id: 'url::' + key,
						taskId: 'url',
						key,
						title: state.title,
						author: '',
						platform,
						status: 'failed',
						reason,
						sourceUrl: href,
						referer: referer ?? null,
						createdAt: new Date().toISOString(),
					});
				}
			} finally {
				this.urlDownloads.delete(id);
			}
		};
		void run();
		return this.publicLiveItem(state);
	}
	feedPage(params) {
		const {id, key, url, html, userAgent, skip} = params;
		if (
			typeof id !== 'string' ||
			typeof key !== 'string' ||
			!/^[\w-]{1,61}:./.test(key) ||
			(!skip && (typeof url !== 'string' || typeof html !== 'string' || html.length > PAGE_LIMIT))
		)
			fail();
		// The task already finished or never ran here: nothing will read this page.
		if (!this.active.has(id)) return {ok: true, skipped: true};
		this.feeders.set(id, Date.now());
		if (this.pages.size >= 200) throw new EngineError('busy', '本机仍在处理之前读取的原帖。');
		const k = id + '\n' + key;
		if (skip) {
			this.pages.set(k, {skip: true});
			return {ok: true, skipped: true};
		}
		const at = key.indexOf(':');
		try {
			const entry = parsePostPage(
				{platform: key.slice(0, at), id: key.slice(at + 1), sourceUrl: url},
				html,
				url,
				{localOrigin: this.options.localOrigin},
			);
			this.pages.set(k, {entry: {...entry, userAgent}});
			return {
				ok: true,
				title: entry.title,
				bodyComplete: entry.bodyComplete,
				attachments: entry.attachments.length,
			};
		} catch (error) {
			const code = typeof error.code === 'string' ? error.code : 'source_unavailable';
			this.pages.set(k, {error: code});
			return {ok: false, code};
		}
	}
	async request(method, params) {
		if (!this.recovery) {
			this.recovery = clearAbandonedAttachments(this.directory)
				.then(() => clearAbandonedDownloads(libraryRoot(this.options)))
				.then(() => listRecoverableNativeTasks(this.options))
				.then((tasks) => {
					for (const task of tasks)
						this.queue(task, Boolean(task.retry), task.retry?.selected ?? undefined);
				})
				.catch((error) => {
					this.recovery = null;
					throw error;
				});
		}
		await this.recovery;
		switch (method) {
			case 'libraryPage':
				return this.feedPage(params);
			case 'libraryFeed':
				if (typeof params.id !== 'string') fail();
				if (params.active === true) this.feeders.set(params.id, Date.now());
				else {
					this.feeders.delete(params.id);
					if (!this.active.has(params.id))
						for (const k of this.pages.keys())
							if (k.startsWith(params.id + '\n')) this.pages.delete(k);
				}
				return {ok: true};
			case 'libraryUploadStart':
				return this.uploads.start();
			case 'libraryUploadPart':
				return this.uploads.part(params);
			case 'libraryUploadFinish':
				return this.request('libraryStart', this.uploads.finish(params));
			case 'libraryOpen': {
				if (typeof params.key !== 'string' || !params.key) fail();
				const [record] = await searchLibrary({key: params.key}, this.options);
				if (!record) fail();
				const target = primaryFileFor(libraryRoot(this.options), record);
				const result = await runProcess('/usr/bin/open', [target], {timeoutMs: 10000});
				if (result.code !== 0) throw new EngineError('file_missing', '未能打开文件。');
				return {opened: true};
			}
			case 'libraryDownloadUrl':
				return this.startUrlDownload(params);
			case 'libraryCancelItem': {
				const taskId = typeof params.taskId === 'string' ? params.taskId : '';
				const key = typeof params.key === 'string' ? params.key : '';
				const itemId = typeof params.id === 'string' ? params.id : taskId + '::' + key;
				if (this.urlDownloads.has(itemId)) {
					this.urlDownloads.get(itemId).controller.abort();
					this.urlDownloads.delete(itemId);
					return {cancelled: true};
				}
				if (!taskId || !key) fail();
				const fullId = taskId + '::' + key;
				this.cancelledItems.add(fullId);
				const running = this.itemControllers.get(fullId);
				if (running) {
					running.abort();
					return {cancelled: true};
				}
				return cancelQueuedLibraryItem(taskId, key, this.options);
			}
			case 'libraryDismissFailed': {
				const keys = Array.isArray(params.keys) ? params.keys : null;
				if (keys && keys.length) {
					for (const k of keys) this.urlFailures.delete(k);
				} else {
					this.urlFailures.clear();
				}
				return dismissFailedLibraryItems(keys, this.options);
			}
			case 'libraryDownloads': {
				const downloadsDir = (await this.resolveOutputDir()) || defaultOutputDirectory();
				const liveById = new Map();
				for (const item of this.urlDownloads.values()) {
					liveById.set(item.id, this.publicLiveItem(item));
				}
				for (const item of this.liveItems.values()) {
					liveById.set(item.id, this.publicLiveItem(item));
				}
				const queued = await listQueuedLibraryItems(this.options);
				const active = [...liveById.values()];
				const activeKeys = new Set(active.map((a) => a.key));
				for (const row of queued) {
					if (liveById.has(row.id) || this.cancelledItems.has(row.id)) continue;
					active.push(row);
					activeKeys.add(row.key);
				}
				const dbFailed = await listFailedLibraryItems(this.options);
				const failed = [
					...this.urlFailures.values(),
					...dbFailed.filter((f) => !activeKeys.has(f.key)),
				];
				const works = (await searchLibrary({}, this.options)).filter(
					(w) => !isEmptyPartialShell(w),
				);
				const kinds = {};
				const platforms = {};
				for (const w of works) {
					const k = desktopKind(w);
					kinds[k] = (kinds[k] ?? 0) + 1;
					platforms[w.platform] = (platforms[w.platform] ?? 0) + 1;
				}
				return {
					downloadsDir,
					active: boundedRows(active, 200 * 1024),
					failed: boundedRows(failed, 200 * 1024),
					stats: {
						total: works.length,
						activeCount: active.length,
						failedCount: failed.length,
						kinds,
						platforms,
					},
				};
			}
			case 'libraryTasks':
				return boundedRows(
					(await listLibraryTasks(this.options))
						.slice(params.offset || 0)
						.slice(0, 200)
						.map((t) => summary(t)),
					460 * 1024,
				);
			case 'libraryTask': {
				const task = await getLibraryTask(params.id, this.options);
				const offset = Math.max(0, Number(params.offset) || 0);
				// `problems`: 'failed' lists failed and partial entries; true also lists pending ones.
				const wanted =
					params.problems === 'failed'
						? ['failed', 'partial']
						: params.problems === true
							? ['failed', 'partial', 'pending']
							: null;
				const items = wanted ? task.items.filter((i) => wanted.includes(i.status)) : task.items;
				return {
					...summary(task, Math.max(0, Number(params.folderOffset) || 0)),
					totalItems: items.length,
					items: boundedRows(items.slice(offset, offset + 100), 350 * 1024),
				};
			}
			case 'librarySearch': {
				const results = (
					await searchLibrary(
						{...params.filters, limit: Math.min(100, Number(params.filters?.limit) || 50)},
						this.options,
					)
				).filter((w) => !isEmptyPartialShell(w));
				const root = libraryRoot(this.options);
				const kind = params.filters?.kind;
				return boundedRows(
					results
						.filter((work) => {
							const k = desktopKind(work);
							return !kind || k === kind || (kind === 'video' && k === 'audio');
						})
						.slice(params.offset || 0)
						.slice(0, Math.min(100, Number(params.filters?.limit) || 100))
						.map((work) => {
							const {
								platform,
								id,
								key,
								title,
								customTitle,
								author,
								filepath,
								status,
								sourceUrl,
								folders,
								topics,
								kind,
								bodyFormat,
								attachments,
								missing,
							} = work;
							const cover =
								attachments.find((a) => a.path && a.kind === 'image') ??
								attachments.find((a) => a.path && a.kind === 'video');
							const files = workFiles(root, work);
							return {
								platform,
								id,
								key,
								title: customTitle || title,
								author,
								filepath,
								primaryFile: primaryFileFor(root, work),
								savedDir: work.savedDir ?? null,
								status,
								sourceUrl,
								kind: desktopKind({kind, platform, bodyFormat, attachments}),
								cover: cover ? path.join(root, cover.path) : null,
								files,
								mediaCount: files.length,
								coverKind: cover?.kind ?? null,
								missing: missing ?? [],
								folders: boundedRows(folders, 32768),
								topics: boundedRows(topics, 8192),
							};
						}),
					460 * 1024,
				);
			}
			case 'libraryStats': {
				const stats = {
					root: libraryRoot(this.options),
					total: 0,
					kinds: {},
					platforms: {},
					folders: {},
				};
				const add = (map, name) => (map[name] = (map[name] ?? 0) + 1);
				for (const work of await searchLibrary({}, this.options)) {
					if (isEmptyPartialShell(work)) continue;
					stats.total++;
					add(stats.kinds, desktopKind(work));
					add(stats.platforms, work.platform);
					for (const name of new Set(work.folders.map((f) => f.name).filter(Boolean)))
						add(stats.folders, name);
				}
				return stats;
			}
			case 'libraryRemove':
				return removeLibraryWorks(params.keys, this.options);
			case 'libraryRename':
				return renameLibraryWork(params.key, params.title, this.options);
			case 'libraryRetry':
			case 'libraryResume': {
				if (params.id === 'url' && method === 'libraryRetry') {
					const key = Array.isArray(params.selected) ? params.selected[0] : null;
					const failed = key ? this.urlFailures.get(key) : [...this.urlFailures.values()][0];
					if (!failed) throw new EngineError('not_found', '找不到要重试的下载项。');
					return this.startUrlDownload({
						url: failed.sourceUrl,
						title: failed.title,
						referer: failed.referer,
					});
				}
				const task = await getLibraryTask(params.id, this.options);
				if (
					params.selected !== undefined &&
					(!Array.isArray(params.selected) || !params.selected.every((k) => typeof k === 'string'))
				)
					fail();
				if (this.active.has(task.id)) throw new EngineError('busy', '这个任务还在保存中。');
				await markLibraryTaskQueued(
					task.id,
					this.options,
					method === 'libraryRetry' ? {selected: params.selected} : undefined,
				);
				return this.queue({...task, status: 'queued'}, method === 'libraryRetry', params.selected);
			}
			case 'libraryStart': {
				this.preparing++;
				try {
					const manifest = structuredClone(params.manifest);
					const entries = allEntries(manifest);
					const selected = params.selected;
					if (
						selected !== undefined &&
						(!Array.isArray(selected) || !selected.every((key) => typeof key === 'string'))
					)
						fail();
					// Deduplicate rapid repeated clicks on the exact same selection while active.
					const fp = batchFingerprint(entries, selected);
					const recent = this.recentStarts.get(fp);
					if (
						recent &&
						(this.active.has(recent.taskId) || Date.now() - recent.createdAt < 10_000)
					) {
						try {
							const existing = await getLibraryTask(recent.taskId, this.options);
							if (['queued', 'running'].includes(existing.status)) return summary(existing);
						} catch {}
					}
					const transfers = captureTransfers(entries);
					const visits = new Map();
					for (const entry of entries) {
						const visit = entry.visitUrl;
						delete entry.visitUrl;
						if (typeof visit !== 'string' || visit.length > 4096) continue;
						const local =
							this.options.localOrigin && visit.startsWith(this.options.localOrigin + '/');
						const accepted =
							entry.platform === 'xiaohongshu'
								? matchingTarget(entry.sourceUrl, entry) && matchingTarget(visit, entry)
								: sameSite(visit, entry.sourceUrl);
						if (!local && !accepted) continue;
						try {
							visits.set(entryIdentity(entry).key, visit);
						} catch {
							/* prepareLibraryTask reports invalid entries */
						}
					}
					const task = await prepareLibraryTask(manifest, {
						...this.options,
						selected,
						nativeQueue: true,
						deferAttachment: transfers.deferAttachment,
					});
					this.recentStarts.set(fp, {taskId: task.id, createdAt: Date.now()});
					while (this.recentStarts.size > 32)
						this.recentStarts.delete(this.recentStarts.keys().next().value);
					for (const [key, visit] of visits) this.visits.set(task.id + '\n' + key, visit);
					// The extension reads pages after the task exists; the worker waits for them.
					if (params.feed === true) this.feeders.set(task.id, Date.now());
					return this.queue(task, false, undefined, transfers.pending);
				} finally {
					this.preparing--;
				}
			}
			default:
				fail();
		}
	}
}
