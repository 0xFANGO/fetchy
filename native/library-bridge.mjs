import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import path from 'node:path';
import {
	getLibraryTask,
	listLibraryTasks,
	prepareLibraryTask,
	runLibraryTask,
	searchLibrary,
} from '../src/library/index.mjs';
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
export async function stageAttachments(entries, directory, selected, options = {}) {
	let sequence = 0;
	const files = new Map();
	let budget = 1024 ** 3;
	const deadline = AbortSignal.timeout(10 * 60_000);
	const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
	for (const entry of entries) {
		if (selected && !selected.has(entry.platform + ':' + entry.id)) continue;
		for (const attachment of entry.attachments ?? []) {
			if (
				!attachment ||
				!['image', 'video', 'audio'].includes(attachment.kind) ||
				attachment.path !== undefined
			)
				fail();
			if (attachment.url === undefined) continue;
			const uri = attachment.url;
			delete attachment.url;
			if (typeof uri !== 'string' || uri.length > 16384) fail();
			try {
				if (!files.has(uri)) {
					const localName = 'attachment-' + ++sequence;
					const mime = await saveWebFile(uri, path.join(directory, localName), {
						signal,
						localOrigin: options.localOrigin,
						maxBytes: Math.min(budget, 256 * 1024 ** 2),
					});
					budget -= mime.bytes;
					if (!mime.mimeType.startsWith(attachment.kind + '/')) throw Error('type');
					files.set(uri, {path: localName, mimeType: mime.mimeType});
				}
				const stored = files.get(uri);
				if (!stored.mimeType.startsWith(attachment.kind + '/')) throw Error('type');
				Object.assign(attachment, stored);
			} catch {
				attachment.missing = true;
			}
		}
	}
}
export class LibraryBridge {
	constructor(directory) {
		this.directory = directory;
		this.options = {root: process.env.FETCHY_LIBRARY_DIR || path.join(directory, 'library')};
		this.active = new Map();
		this.preparing = 0;
		this.uploads = new LibraryUploads();
		this.tail = Promise.resolve();
	}
	queue(task, retryFailed) {
		if (!this.active.has(task.id)) {
			const work = this.tail.then(() => runLibraryTask(task.id, {...this.options, retryFailed}));
			this.tail = work.catch(() => {}).finally(() => this.active.delete(task.id));
			this.active.set(task.id, work);
		}
		return summary(task);
	}
	async request(method, params) {
		switch (method) {
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
				return this.queue(task, method === 'libraryRetry');
			}
			case 'libraryStart': {
				this.preparing++;
				let scratch;
				try {
					const manifest = structuredClone(params.manifest);
					const entries = allEntries(manifest);
					const selected = params.selected;
					if (
						selected !== undefined &&
						(!Array.isArray(selected) || !selected.every((key) => typeof key === 'string'))
					)
						fail();
					// IPC callers may supply public media or bytes, never paths on the host.
					for (const e of entries)
						for (const a of e.attachments ?? []) if (a?.path !== undefined) fail();
					await mkdir(this.directory, {recursive: true, mode: 0o700});
					scratch = await mkdtemp(path.join(this.directory, '.import-'));
					await stageAttachments(entries, scratch, selected && new Set(selected));
					const task = await prepareLibraryTask(manifest, {
						...this.options,
						selected,
						sourceDir: scratch,
					});
					return this.queue(task, false);
				} finally {
					this.preparing--;
					if (scratch) await rm(scratch, {recursive: true, force: true});
				}
			}
			default:
				fail();
		}
	}
}
