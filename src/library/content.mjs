import {createHash, randomUUID} from 'node:crypto';
import {constants, createReadStream, createWriteStream} from 'node:fs';
import {
	copyFile,
	link,
	mkdir,
	mkdtemp,
	open,
	realpath,
	rename,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {Readable, Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {problem} from './storage.mjs';
import {runProcess} from '../process.mjs';
import {saveWebFile} from '../public-http.mjs';
import {videoFilename} from '../filenames.mjs';
import {normalizeUrl} from '../urls.mjs';

const text = (v, max = 4096) => (typeof v === 'string' ? v.slice(0, max) : '');
const digest = (s) => createHash('sha256').update(s).digest('hex');
const html = (s) =>
	String(s ?? '')
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
export function publicUrl(value) {
	try {
		const u = new URL(value);
		if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return '';
		// Most tracking or playback queries expire. Keep only stable content selectors.
		const qs = new URLSearchParams();
		for (const name of ['v', 'p', 'id', 'fid', 'modal_id', 'bvid']) {
			const v = u.searchParams.get(name);
			if (v && /^[\w-]{1,128}$/.test(v)) qs.set(name, v);
		}
		u.hash = '';
		u.search = qs.toString();
		return u.href;
	} catch {
		return '';
	}
}
export function keyFor(platform, id) {
	if (
		!/^[a-z0-9][a-z0-9_-]{0,60}$/i.test(platform ?? '') ||
		typeof platform !== 'string' ||
		typeof id !== 'string' ||
		!id.trim() ||
		id.length > 256 ||
		/\p{Cc}/u.test(id)
	)
		throw problem('invalid_entry', 'Each item needs a platform and stable string ID.');
	return platform + ':' + id;
}
export function entryIdentity(raw, folder) {
	const platform = raw?.platform || folder?.platform;
	let id = raw?.id;
	// Bilibili represents parts of one BV/av URL with different video files.
	if (platform === 'bilibili') {
		let target;
		try {
			target = normalizeUrl(raw.sourceUrl);
		} catch {
			/* Imported articles need not be video URLs. */
		}
		if (target?.platform === 'bilibili' && target.page > 1) {
			const partId = target.id + '_p' + target.page;
			if (id !== target.id && id !== partId)
				throw problem('invalid_entry', 'Bilibili part ID does not match its source.');
			id = partId;
		}
	}
	return {platform, id, key: keyFor(platform, id)};
}
export function folderOf(f) {
	if (!f || typeof f.id !== 'string' || !f.id || f.id.length > 256)
		throw problem('invalid_folder', 'A collection needs a stable ID.');
	return {
		platform: text(f.platform, 61),
		id: f.id,
		name: text(f.name, 1024) || f.id,
		savedAt: text(f.savedAt, 64) || null,
	};
}
const MIME = {
	'image/jpeg': '.jpg',
	'image/png': '.png',
	'image/webp': '.webp',
	'image/gif': '.gif',
	'image/avif': '.avif',
	'audio/mp4': '.m4a',
	'video/mp4': '.mp4',
	'video/webm': '.webm',
	'video/quicktime': '.mov',
};
function matchesMediaHeader(bytes, ext) {
	const sig = bytes.subarray(0, 12);
	const brand = bytes.subarray(4, 8).toString('ascii');
	switch (ext) {
		case '.png':
			return sig.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
		case '.jpg':
			return sig[0] === 255 && sig[1] === 216 && sig[2] === 255;
		case '.gif':
			return ['GIF87a', 'GIF89a'].includes(sig.subarray(0, 6).toString('ascii'));
		case '.webp':
			return sig.subarray(0, 4).toString() === 'RIFF' && sig.subarray(8, 12).toString() === 'WEBP';
		case '.avif':
			return brand === 'ftyp' && /avif|avis/.test(bytes.toString('latin1'));
		case '.webm':
			return sig.readUInt32BE(0) === 0x1a45dfa3;
		case '.m4a':
		case '.mp4':
		case '.mov':
			return ['ftyp', 'moov', 'mdat', 'wide', 'free'].includes(brand);
		default:
			return false;
	}
}
async function stash(root, stream, ext) {
	const hash = createHash('sha256');
	const dir = path.join(root, 'media');
	await mkdir(dir, {recursive: true, mode: 0o700});
	const tmp = path.join(dir, '.incoming-' + randomUUID());
	try {
		let size = 0;
		let head = Buffer.alloc(0);
		await pipeline(
			stream,
			new Transform({
				transform(chunk, enc, cb) {
					size += chunk.length;
					if (head.length < 64) head = Buffer.concat([head, chunk.subarray(0, 64 - head.length)]);
					hash.update(chunk);
					cb(null, chunk);
				},
			}),
			createWriteStream(tmp, {flags: 'wx', mode: 0o600}),
		);
		if (!size) throw problem('empty_attachment', 'Attachment is empty.');
		if (head.length < 8 || !matchesMediaHeader(head, ext))
			throw problem('invalid_attachment', 'Media header differs from its declared type.');
		const relative = path.join('media', hash.digest('hex') + ext);
		try {
			await stat(path.join(root, relative));
			return relative;
		} catch (e) {
			if (e.code !== 'ENOENT') throw e;
		}
		const probe = await runProcess(
			'ffprobe',
			[
				'-v',
				'error',
				'-protocol_whitelist',
				'file,pipe',
				'-show_entries',
				'stream=codec_type,width,height:format=duration',
				'-of',
				'json',
				tmp,
			],
			{timeoutMs: 20_000, maxOutputBytes: 32_768},
		);
		let metadata;
		try {
			metadata = JSON.parse(probe.stdout);
		} catch {
			/* an invalid attachment has no usable stream */
		}
		if (
			probe.code !== 0 ||
			!metadata?.streams?.some((v) =>
				ext === '.m4a'
					? v.codec_type === 'audio'
					: v.codec_type === 'video' && v.width > 0 && v.height > 0,
			) ||
			(['.mp4', '.mov', '.webm', '.m4a'].includes(ext) && !(Number(metadata.format?.duration) > 0))
		)
			throw problem('invalid_attachment', 'Media could not be verified.');
		try {
			await link(tmp, path.join(root, relative));
		} catch (e) {
			if (e.code !== 'EEXIST') throw e;
		}
		return relative;
	} finally {
		await rm(tmp, {force: true});
	}
}
export async function stashFile(root, file, kind, mimeType) {
	const suffix = path.extname(file).toLowerCase();
	const ext =
		MIME[mimeType] ||
		Object.values(MIME).find((v) => v === suffix) ||
		(suffix === '.jpeg' ? '.jpg' : null);
	if (!ext || !(await stat(file)).isFile())
		throw problem('invalid_attachment', 'Unsupported attachment file.');
	const valid = Object.entries(MIME).some(
		([mime, suffix]) => mime.startsWith(kind + '/') && suffix === ext,
	);
	if (!valid) throw problem('invalid_attachment', 'Attachment type differs from its file type.');
	return stash(root, createReadStream(file), ext);
}
async function sniffMime(file, kind) {
	const handle = await open(file, 'r');
	try {
		const bytes = Buffer.alloc(64);
		const {bytesRead} = await handle.read(bytes, 0, 64, 0);
		const head = bytes.subarray(0, bytesRead);
		for (const [mime, ext] of Object.entries(MIME))
			if (mime.startsWith(kind + '/') && head.length >= 8 && matchesMediaHeader(head, ext))
				return mime;
	} finally {
		await handle.close();
	}
	return '';
}

// A refused or missing file does not come back by asking again.
const retryable = (e) =>
	e.code === 'timeout' ||
	(e.code === 'network_error' && (!e.httpStatus || e.httpStatus === 429 || e.httpStatus >= 500));
/**
 * Download one attachment from its media URL into the library. The page that
 * listed it is sent as Referer; no site cookies are sent to media hosts.
 * Throws an error with a stable code; transient network failures are retried.
 */
export async function downloadAttachment(root, url, kind, options = {}) {
	const attempts = options.attempts ?? 3;
	const headers = {...options.headers};
	if (options.referer) headers.referer = options.referer;
	await mkdir(root, {recursive: true, mode: 0o700});
	for (let attempt = 0; ; attempt++) {
		const dir = await mkdtemp(path.join(root, '.download-' + process.pid + '-'));
		const file = path.join(dir, 'media');
		try {
			const signal = AbortSignal.any([
				AbortSignal.timeout(options.timeoutMs ?? 30 * 60_000),
				...(options.signal ? [options.signal] : []),
			]);
			let {mimeType} = await saveWebFile(url, file, {
				signal,
				headers,
				localOrigin: options.localOrigin,
				maxBytes: options.maxBytes ?? 8 * 1024 ** 3,
				onProgress: options.onProgress,
			}).catch((error) => {
				if (signal.aborted && !options.signal?.aborted)
					throw problem('timeout', 'Attachment download timed out.');
				throw error;
			});
			if (!MIME[mimeType] || !mimeType.startsWith(kind + '/'))
				mimeType = await sniffMime(file, kind);
			if (!mimeType.startsWith(kind + '/'))
				throw problem('invalid_attachment', 'Downloaded media has another type.');
			return await stashFile(root, file, kind, mimeType);
		} catch (error) {
			options.signal?.throwIfAborted();
			if (!retryable(error) || attempt + 1 >= attempts) throw error;
			await delay((options.backoffMs ?? 1000) * 3 ** attempt, undefined, {signal: options.signal});
		} finally {
			await rm(dir, {recursive: true, force: true});
		}
	}
}
export async function normalizeEntry(raw, folder, root, options = {}) {
	if (!raw || typeof raw !== 'object') throw problem('invalid_entry', 'Expected an item object.');
	const {platform, id, key} = entryIdentity(raw, folder);
	const sourceUrl = publicUrl(raw.sourceUrl);
	if (!sourceUrl) throw problem('invalid_entry', 'A source URL is required.');
	const attachments = [];
	if (raw.attachments !== undefined && raw.attachments !== null && !Array.isArray(raw.attachments))
		throw problem('invalid_entry', 'Attachments must be ordered in an array.');
	for (const a of raw.attachments ?? []) {
		const kind = ['audio', 'video'].includes(a?.kind) ? a.kind : 'image';
		const item = {kind, name: text(a?.name, 256), alt: text(a?.alt, 1024)};
		// Import manifests can reference files only beneath a caller-selected export directory.
		try {
			if (
				a?.data &&
				typeof a.data === 'string' &&
				a.data.length <= 24 * 1024 * 1024 &&
				/^[a-zA-Z0-9+/]*={0,2}$/.test(a.data)
			) {
				const ext = MIME[a.mimeType];
				if (typeof ext !== 'string' || !a.mimeType.startsWith(kind + '/'))
					throw problem('invalid_attachment', 'Unsupported inline media type.');
				item.path = await stash(root, Readable.from([Buffer.from(a.data, 'base64')]), ext);
			} else if (typeof a?.path === 'string' && options.sourceDir && !path.isAbsolute(a.path)) {
				const parent = await realpath(options.sourceDir),
					file = await realpath(path.resolve(parent, a.path));
				if (!file.startsWith(parent + path.sep))
					throw problem('invalid_attachment', 'Attachment leaves the selected directory.');
				item.path = await stashFile(root, file, kind, a.mimeType);
			} else item.missing = true;
		} catch (e) {
			if (!['ENOENT', 'invalid_attachment', 'empty_attachment', 'ENOTDIR'].includes(e.code))
				throw e;
			item.missing = true;
		}
		attachments.push(item);
	}
	const folders = [
		...(folder ? [{...folder, savedAt: text(raw.savedAt, 64) || null}] : []),
		...(Array.isArray(raw.folders) ? raw.folders.map(folderOf) : []),
	];
	const body = text(raw.body, 4_000_000);
	return {
		platform,
		id,
		key,
		sourceUrl,
		title: text(raw.title),
		author: text(raw.author),
		kind: ['audio', 'video'].includes(raw.kind) ? raw.kind : 'post',
		body,
		bodyFormat: raw.bodyFormat === 'markdown' ? 'markdown' : 'text',
		bodyComplete:
			raw.bodyComplete === true &&
			typeof raw.body === 'string' &&
			body.length === raw.body.length &&
			(body.length > 0 || attachments.length > 0),
		savedAt: text(raw.savedAt, 64) || null,
		topics: [
			...new Set(
				(Array.isArray(raw.topics) ? raw.topics : []).map((v) => text(v, 256)).filter(Boolean),
			),
		],
		notes: text(raw.notes, 65536),
		summary: text(raw.summary, 65536),
		translation: text(raw.translation, 1_000_000),
		attachments,
		folders,
		coverage: text(raw.coverage, 256),
		missing: (Array.isArray(raw.missing) ? raw.missing : [])
			.map((v) => text(v, 256))
			.filter(Boolean),
	};
}
/** A title the owner gave in the library outlives later saves of the same entry. */
export const displayTitle = (item) => item.customTitle || item.title || item.id;
export function workFile(root, item) {
	return path.join(root, 'works', item.platform, digest(item.id), 'index.html');
}
const inlineMarkdown = (value) => {
	let out = '',
		last = 0;
	for (const m of value.matchAll(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g)) {
		out += html(value.slice(last, m.index));
		let valid = false;
		try {
			const u = new URL(m[2]);
			valid = !u.username && !u.password;
		} catch {}
		out += valid
			? '<a rel="noreferrer" href="' + html(m[2]) + '">' + html(m[1]) + '</a>'
			: html(m[0]);
		last = m.index + m[0].length;
	}
	return out + html(value.slice(last));
};
export async function renderWork(root, item, file = workFile(root, item)) {
	const dir = path.dirname(file);
	await mkdir(dir, {recursive: true, mode: 0o700});
	const body = item.body
		.split(/\n/)
		.map((line) => {
			const h = item.bodyFormat === 'markdown' && /^(#{1,6})\s+(.+)$/.exec(line);
			return h
				? '<h' + h[1].length + '>' + inlineMarkdown(h[2]) + '</h' + h[1].length + '>'
				: '<p>' + (item.bodyFormat === 'markdown' ? inlineMarkdown(line) : html(line)) + '</p>';
		})
		.join('\n');
	const media = item.attachments
		.map((a) => {
			if (!a.path) return '<p>Missing ' + html(a.kind) + ': ' + html(a.name || a.alt) + '</p>';
			const url = path
				.relative(dir, path.join(root, a.path))
				.split(path.sep)
				.map(encodeURIComponent)
				.join('/');
			if (a.kind === 'audio')
				return '<audio controls preload="metadata" src="' + url + '"></audio>';
			return a.kind === 'video'
				? '<video controls preload="metadata" src="' + url + '"></video>'
				: '<img loading="lazy" alt="' + html(a.alt || a.name) + '" src="' + url + '">';
		})
		.join('\n');
	const extra = [
		['Summary', item.summary],
		['Translation', item.translation],
		['Notes', item.notes],
	]
		.filter(([, v]) => v)
		.map(([k, v]) => '<section><h2>' + k + '</h2><p>' + html(v) + '</p></section>')
		.join('');
	const markup =
		'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>' +
		html(displayTitle(item)) +
		'</title><style>body{font:18px/1.55 system-ui;max-width:48rem;margin:2rem auto;padding:0 1rem}img,video{max-width:100%;height:auto;display:block;margin:1rem 0}p{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body><article><h1>' +
		html(displayTitle(item)) +
		'</h1><p>' +
		html(item.author) +
		' · <a rel="noreferrer" href="' +
		html(item.sourceUrl) +
		'">Original</a></p>' +
		(item.status === 'partial'
			? '<p>Partially saved: ' + html(item.missing.join(', ')) + '</p>'
			: '') +
		body +
		media +
		'</article>' +
		extra +
		'</body></html>';
	const tmp = file + '.' + randomUUID() + '.tmp';
	try {
		await writeFile(tmp, markup, {mode: 0o600});
		await rename(tmp, file);
	} finally {
		await rm(tmp, {force: true});
	}
	return file;
}

const NO_HARDLINK = new Set(['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV']);

function mediaStem(item) {
	return videoFilename(displayTitle(item), {platform: item.platform, id: item.id}).slice(0, -4);
}

async function placeFile(source, destination) {
	try {
		await link(source, destination);
	} catch (error) {
		if (!NO_HARDLINK.has(error.code)) throw error;
		await copyFile(source, destination, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
	}
}

async function uniqueFile(directory, stem, ext) {
	for (let index = 1; index <= 1000; index++) {
		const name = index === 1 ? stem + ext : `${stem} (${index})${ext}`;
		const target = path.join(directory, name);
		try {
			await stat(target);
		} catch (error) {
			if (error.code === 'ENOENT') return target;
			throw error;
		}
	}
	return path.join(directory, `${stem}-${randomUUID().slice(0, 8)}${ext}`);
}

async function uniqueDir(directory, stem) {
	for (let index = 1; index <= 1000; index++) {
		const name = index === 1 ? stem : `${stem} (${index})`;
		const target = path.join(directory, name);
		try {
			await mkdir(target);
			return target;
		} catch (error) {
			if (error.code === 'EEXIST') continue;
			throw error;
		}
	}
	const fallback = path.join(directory, `${stem}-${randomUUID().slice(0, 8)}`);
	await mkdir(fallback, {recursive: true});
	return fallback;
}

export function renderPostMarkdown(item, attachmentRelNames = []) {
	const title = displayTitle(item);
	const author = String(item.author || '')
		.replace(/\s*\n+\s*/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	const lines = [`# ${title}`, ''];
	if (author) lines.push(`- 作者：${author}`);
	if (item.sourceUrl) lines.push(`- 来源：${item.sourceUrl}`);
	if (item.savedAt) lines.push(`- 保存时间：${item.savedAt}`);
	if (lines.length > 2) lines.push('', '---', '');
	const body = String(item.body || '').trim();
	if (body) lines.push(body, '');
	if (attachmentRelNames.length) {
		for (const [idx, rel] of attachmentRelNames.entries()) {
			const ext = path.extname(rel).toLowerCase();
			if (['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif'].includes(ext)) {
				lines.push(`![图片 ${idx + 1}](./${rel})`, '');
			} else {
				lines.push(`[附件 ${idx + 1}: ${rel}](./${rel})`, '');
			}
		}
	}
	return lines.join('\n').trimEnd() + '\n';
}

/**
 * Materialize verified media attachments and text/article posts directly into the user's
 * downloads folder with readable filenames:
 * - Pure text/article posts (e.g. X text/article) -> `<outputDir>/<title>.md`
 * - X/Threads/Zhihu image+text posts -> `<outputDir>/<title>/<title>.md` + `01.<ext>...`
 * - Single-media items (video/audio/photo) -> `<outputDir>/<title>.<ext>`
 * - Multi-media galleries (e.g. Xiaohongshu) -> `<outputDir>/<title>/01.<ext>, 02.<ext>...`
 */
export async function publishLibraryMedia(root, item, outputDir) {
	if (!outputDir) return {savedFiles: [], savedDir: null};
	const ready = (item.attachments ?? []).filter((a) => typeof a.path === 'string' && a.path);
	const hasBody = Boolean(typeof item.body === 'string' && item.body.trim());
	if (!ready.length && !hasBody) return {savedFiles: [], savedDir: null};
	await mkdir(outputDir, {recursive: true});
	const baseDir = await realpath(outputDir);
	const stem = mediaStem(item);

	// Pure text / article post with no media attachments -> direct Markdown file.
	if (!ready.length) {
		const prev = Array.isArray(item.savedFiles) ? item.savedFiles[0] : null;
		if (typeof prev === 'string' && prev.endsWith('.md') && prev.startsWith(baseDir + path.sep)) {
			try {
				if ((await stat(prev)).isFile()) {
					await writeFile(prev, renderPostMarkdown(item, []), 'utf8');
					return {savedFiles: [prev], savedDir: null};
				}
			} catch {}
		}
		const target = await uniqueFile(baseDir, stem, '.md');
		await writeFile(target, renderPostMarkdown(item, []), 'utf8');
		return {savedFiles: [target], savedDir: null};
	}

	const includeMarkdown =
		['x', 'threads', 'zhihu'].includes(item.platform) &&
		hasBody &&
		ready.every((a) => a.kind === 'image');

	// Reuse already-published files if every attachment (and markdown if needed) still exists.
	const existing = [];
	let allPresent = ready.length > 0;
	for (const a of ready) {
		if (typeof a.savedPath === 'string' && a.savedPath.startsWith(baseDir + path.sep)) {
			try {
				if ((await stat(a.savedPath)).isFile()) {
					existing.push(a.savedPath);
					continue;
				}
			} catch {}
		}
		allPresent = false;
		break;
	}
	if (allPresent) {
		const savedDir =
			(ready.length > 1 || includeMarkdown) &&
			typeof item.savedDir === 'string' &&
			item.savedDir.startsWith(baseDir + path.sep)
				? item.savedDir
				: null;
		if (includeMarkdown && savedDir) {
			const mdTarget = path.join(savedDir, stem + '.md');
			const rels = existing.map((f) => path.basename(f));
			await writeFile(mdTarget, renderPostMarkdown(item, rels), 'utf8');
			return {savedFiles: [mdTarget, ...existing], savedDir};
		}
		return {savedFiles: existing, savedDir};
	}

	if (ready.length === 1 && !includeMarkdown) {
		const a = ready[0];
		const src = path.join(root, a.path);
		const ext =
			path.extname(a.path) || (a.kind === 'audio' ? '.m4a' : a.kind === 'video' ? '.mp4' : '.jpg');
		let target;
		for (let attempt = 0; attempt < 5; attempt++) {
			target = await uniqueFile(baseDir, stem, ext);
			try {
				await placeFile(src, target);
				break;
			} catch (error) {
				if (error.code === 'EEXIST' && attempt < 4) continue;
				throw error;
			}
		}
		a.savedPath = target;
		return {savedFiles: [target], savedDir: null};
	}

	const folder = await uniqueDir(baseDir, stem);
	const savedFiles = [];
	const relNames = [];
	const pad = String(ready.length).length < 2 ? 2 : String(ready.length).length;
	for (const [i, a] of ready.entries()) {
		const src = path.join(root, a.path);
		const ext =
			path.extname(a.path) || (a.kind === 'audio' ? '.m4a' : a.kind === 'video' ? '.mp4' : '.jpg');
		const name = String(i + 1).padStart(pad, '0') + ext;
		const target = path.join(folder, name);
		await placeFile(src, target);
		a.savedPath = target;
		savedFiles.push(target);
		relNames.push(name);
	}
	if (includeMarkdown) {
		const mdTarget = path.join(folder, stem + '.md');
		await writeFile(mdTarget, renderPostMarkdown(item, relNames), 'utf8');
		savedFiles.unshift(mdTarget);
	}
	return {savedFiles, savedDir: folder};
}

/** Rename materialized files/folder in the downloads directory when the user renames a work. */
export async function renamePublishedMedia(item) {
	const stem = mediaStem(item);
	if (item.savedDir) {
		try {
			if ((await stat(item.savedDir)).isDirectory()) {
				const parent = path.dirname(item.savedDir);
				const desired = path.join(parent, stem);
				if (desired !== item.savedDir) {
					let target = desired;
					for (let i = 2; i <= 1000; i++) {
						try {
							await stat(target);
							target = path.join(parent, `${stem} (${i})`);
						} catch (e) {
							if (e.code === 'ENOENT') break;
							throw e;
						}
					}
					await rename(item.savedDir, target);
					const prevPrefix = item.savedDir + path.sep;
					item.savedDir = target;
					item.savedFiles = (item.savedFiles ?? []).map((f) =>
						f.startsWith(prevPrefix) ? path.join(target, f.slice(prevPrefix.length)) : f,
					);
					for (const a of item.attachments ?? []) {
						if (a.savedPath?.startsWith(prevPrefix))
							a.savedPath = path.join(target, a.savedPath.slice(prevPrefix.length));
					}
				}
			}
		} catch {}
		return;
	}
	if (Array.isArray(item.savedFiles) && item.savedFiles.length === 1) {
		const current = item.savedFiles[0];
		try {
			if ((await stat(current)).isFile()) {
				const parent = path.dirname(current);
				const ext = path.extname(current);
				const desired = path.join(parent, stem + ext);
				if (desired !== current) {
					const target = await uniqueFile(parent, stem, ext);
					await rename(current, target);
					item.savedFiles = [target];
					for (const a of item.attachments ?? []) {
						if (a.savedPath === current) a.savedPath = target;
					}
				}
			}
		} catch {}
	}
}
