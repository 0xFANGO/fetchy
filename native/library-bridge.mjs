import {readdir, rm, stat} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {
	getLibraryTask,
	libraryRoot,
	listLibraryTasks,
	listRecoverableNativeTasks,
	prepareLibraryTask,
	runLibraryTask,
	searchLibrary,
} from '../src/library/index.mjs';
import {downloadAttachment, entryIdentity} from '../src/library/content.mjs';
import {PAGE_LIMIT, fetchPostPage, parsePostPage} from '../src/library/post-pages.mjs';
import {saveWebFile} from '../src/public-http.mjs';
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

export class LibraryBridge {
	constructor(directory, {session} = {}) {
		this.directory = directory;
		this.options = {root: process.env.FETCHY_LIBRARY_DIR || path.join(directory, 'library')};
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
		this.sessionApi = session;
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
		const url = this.visits.get(k) ?? item.sourceUrl;
		const cookie = await (await this.session()).cookieHeader(url);
		return fetchPostPage(item, {url, cookie, signal, localOrigin: this.options.localOrigin});
	}
	async run(task, options, pending) {
		const root = libraryRoot(options);
		const session = await this.session();
		const downloads = new Map();
		return runLibraryTask(task.id, {
			...options,
			readDetails: (item) => this.readDetails(task.id, item, options.signal),
			withSiteCookies: (url, action) => session.withCookies(url, action),
			resolveAttachment: pending?.size
				? (id, kind, item) => {
						const url = pending.get(id);
						if (!url) return;
						// One file can fill several slots; fetch it once per task.
						const key = kind + ' ' + url;
						if (!downloads.has(key))
							downloads.set(
								key,
								downloadAttachment(root, url, kind, {
									signal: options.signal,
									localOrigin: options.localOrigin,
									maxBytes: options.maxBytes,
									referer: new URL(item.sourceUrl).origin + '/',
								}),
							);
						return downloads.get(key);
					}
				: undefined,
		});
	}
	queue(task, retryFailed, selected, pending) {
		if (!this.active.has(task.id)) {
			const work = this.tail.then(() =>
				this.run(task, {...this.options, retryFailed, selected}, pending),
			);
			this.tail = work
				.catch(() => {})
				.finally(() => {
					this.active.delete(task.id);
					for (const k of this.pages.keys()) if (k.startsWith(task.id + '\n')) this.pages.delete(k);
				});
			this.active.set(task.id, work);
		}
		return summary(task);
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
		if (this.pages.size >= 200) throw new EngineError('busy', '本机仍在处理之前读取的原帖。');
		this.feeders.set(id, Date.now());
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
					for (const task of tasks) this.queue(task, false);
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
				else this.feeders.delete(params.id);
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
				const result = await runProcess('/usr/bin/open', [record.filepath], {timeoutMs: 10000});
				if (result.code !== 0) throw new EngineError('file_missing', '未能打开归档。');
				return {opened: true};
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
				return {
					...summary(task, Math.max(0, Number(params.folderOffset) || 0)),
					totalItems: task.items?.length ?? 0,
					items: boundedRows(task.items.slice(offset, offset + 100), 350 * 1024),
				};
			}
			case 'librarySearch': {
				const results = await searchLibrary(
					{...params.filters, limit: Math.min(100, Number(params.filters?.limit) || 50)},
					this.options,
				);
				return boundedRows(
					results
						.slice(params.offset || 0)
						.slice(0, Math.min(100, Number(params.filters?.limit) || 100))
						.map(
							({
								platform,
								id,
								key,
								title,
								author,
								filepath,
								status,
								sourceUrl,
								folders,
								topics,
							}) => ({
								platform,
								id,
								key,
								title,
								author,
								filepath,
								status,
								sourceUrl,
								folders: boundedRows(folders, 32768),
								topics: boundedRows(topics, 8192),
							}),
						),
					460 * 1024,
				);
			}
			case 'libraryRetry':
			case 'libraryResume': {
				const task = await getLibraryTask(params.id, this.options);
				if (
					params.selected !== undefined &&
					(!Array.isArray(params.selected) || !params.selected.every((k) => typeof k === 'string'))
				)
					fail();
				return this.queue(task, method === 'libraryRetry', params.selected);
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
					const transfers = captureTransfers(entries);
					const visits = new Map();
					for (const entry of entries) {
						const visit = entry.visitUrl;
						delete entry.visitUrl;
						if (typeof visit !== 'string' || visit.length > 4096) continue;
						const local =
							this.options.localOrigin && visit.startsWith(this.options.localOrigin + '/');
						if (!local && !sameSite(visit, entry.sourceUrl)) continue;
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
