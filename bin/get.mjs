import {constants} from 'node:fs';
import {copyFile, link, mkdir, mkdtemp, open, realpath, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {downloadVideo, resolveVideo, resolveTarget, EngineError} from '../src/index.mjs';
import {downloadAudio, resolveAudio} from '../src/audio.mjs';
import {
	downloadGeneric,
	resolveGeneric,
	readWebArticle,
	webIdentity,
} from '../src/generic-media.mjs';
import {explicitLocalOrigin, webUrl} from '../src/public-http.mjs';
import {siteForHost, siteForPlatform} from '../src/sites/index.mjs';
import {videoFilename} from '../src/filenames.mjs';
import {importLibrary, libraryRoot, searchLibrary} from '../src/library/index.mjs';
import {entryIdentity, publicUrl} from '../src/library/content.mjs';
import {hasSession, downloadWithSession, captureWithSession} from './desktop.mjs';

const invalid = (message) => new EngineError('invalid_arguments', message);
async function targetFor(input, options) {
	const u = webUrl(input);
	const host = u.hostname.replace(/^www\./, '');
	const browserPosts = {
		'threads.com': ['threads', /^\/@[\w.]+\/post\/([\w-]+)\/?$/],
		'threads.net': ['threads', /^\/@[\w.]+\/post\/([\w-]+)\/?$/],
		'kuaishou.com': ['kuaishou', /^\/short-video\/([\w-]+)\/?$/],
		'instagram.com': ['instagram', /^\/(?:[\w.]+\/)?p\/([\w-]+)\/?$/],
		'zhihu.com': ['zhihu', /^\/question\/\d+\/answer\/(\d+)\/?$/],
		'zhuanlan.zhihu.com': ['zhihu', /^\/p\/(\d+)\/?$/],
	};
	const route = browserPosts[host];
	const post = u.protocol === 'https:' && !u.port && route?.[1].exec(u.pathname);
	if (post) return {platform: route[0], id: post[1], url: u.href, pageOnly: true};
	if (siteForHost(u.hostname) && !u.port) return resolveTarget(input, options);
	return {platform: 'web', id: webIdentity(u), url: u.href};
}
async function media(action, target, input, options) {
	const downloading = action === 'get';
	if (target.pageOnly)
		throw new EngineError('no_formats', '请在扩展或 Fetchy 专属浏览器打开此帖以读取图文。');
	const category = siteForPlatform(target.platform)?.kind;
	const authenticated =
		downloading && !options.publicOnly && !options.cookiesFile && (await hasSession(input));
	// A previously opened site gets its own WebKit storage, even in a new process.
	if (authenticated) {
		try {
			return await downloadWithSession(input, options);
		} catch (error) {
			if (!['no_formats', 'network_error', 'unavailable'].includes(error.code)) throw error;
		}
	}
	if (target.platform === 'web') {
		try {
			return await (downloading ? downloadGeneric : resolveGeneric)(input, options);
		} catch (e) {
			if (e.code === 'auth_required')
				throw new EngineError(e.code, '该页面要求登录。运行 fetchy browse <原链接> 登录后重试。');
			throw e;
		}
	}
	const asAudio = () => (downloading ? downloadAudio : resolveAudio)(target.url, options);
	if (category === 'audio') return asAudio();
	try {
		return await (downloading ? downloadVideo : resolveVideo)(target.url, options);
	} catch (e) {
		if (category === 'mixed' && e.code === 'no_video') return asAudio();
		throw e;
	}
}

async function copyResult(source, dir, record, ext) {
	await mkdir(dir, {recursive: true});
	const name = videoFilename(record.title, {platform: record.platform, id: record.id}).slice(0, -4);
	const info = await stat(source);
	for (let n = 1; n <= 1000; n++) {
		const filename = path.resolve(dir, name + (n === 1 ? '' : ' (' + n + ')') + ext);
		try {
			try {
				await link(source, filename);
			} catch (e) {
				if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes(e.code)) throw e;
				await copyFile(source, filename, constants.COPYFILE_EXCL);
			}
			return filename;
		} catch (e) {
			if (e.code !== 'EEXIST') throw e;
			const current = await stat(filename);
			if (current.dev === info.dev && current.ino === info.ino) return filename;
		}
	}
	throw new EngineError('output_exists', '保存目录有过多同名文件。');
}

async function postFor(target, input, settings, error) {
	let entry;
	if (
		!settings.publicOnly &&
		!settings.cookiesFile &&
		((await hasSession(input)) || target.pageOnly)
	) {
		const page = await captureWithSession(input, settings);
		if (page?.type === 'post') entry = page.entry;
	} else if (target.platform === 'web' && error.code === 'no_formats') {
		entry = await readWebArticle(input, {
			...settings,
			signal: AbortSignal.any([
				AbortSignal.timeout(settings.timeoutMs || 30000),
				...(settings.signal ? [settings.signal] : []),
			]),
		});
	}
	if (!entry || (!entry.body && !entry.attachments?.length)) throw error;
	if (target.platform !== 'web' && (entry.platform !== target.platform || entry.id !== target.id))
		throw new EngineError('identity_mismatch', '页面与所请求的作品不符。');
	return entry;
}

/** The durable archive owns one copy. A user-selected output directory gets a named file. */
export async function getOne(action, input, options = {}) {
	const localOrigin = explicitLocalOrigin(input, options.allowLocal);
	const target = await targetFor(input, options);
	const settings = {...options, localOrigin};
	if (action === 'info') {
		try {
			return await media(action, target, input, settings);
		} catch (error) {
			if (error.code !== 'no_formats') throw error;
			const entry = await postFor(target, input, settings, error);
			return {
				platform: entry.platform,
				id: entry.id,
				title: entry.title,
				kind: 'post',
				bodyComplete: entry.bodyComplete,
				attachments: entry.attachments.map((a) => ({kind: a.kind})),
				formats: [],
			};
		}
	}
	const root = libraryRoot(options);
	const tmp = await realpath(await mkdtemp(path.join(tmpdir(), 'fetchy-get-')));
	try {
		let result;
		try {
			result = await media(action, target, input, {...settings, outputDir: tmp});
		} catch (error) {
			if (
				options.publicOnly ||
				![
					'no_formats',
					'no_video',
					'unsupported_content',
					'not_video',
					'session_required',
					'auth_required',
					'unavailable',
					'verification_required',
					'network_error',
				].includes(error.code)
			)
				throw error;
			const entry = await postFor(target, input, settings, error);
			const {stageAttachments} = await import('../native/library-bridge.mjs');
			await stageAttachments([entry], tmp, null, settings);
			const task = await importLibrary(
				{version: 1, items: [entry]},
				{root, sourceDir: tmp, signal: options.signal},
			);
			if (!task.items[0]?.filepath) throw new EngineError('output_invalid', '无法写入离线正文。');
			return {
				platform: entry.platform,
				id: entry.id,
				title: entry.title,
				kind: 'post',
				engine: 'article',
				filepath: task.items[0].filepath,
				offlinePage: task.items[0].filepath,
				taskId: task.id,
				status: task.items[0].status,
			};
		}
		if (
			target.platform !== 'web' &&
			(result.platform !== target.platform || result.id !== target.id)
		)
			throw new EngineError('identity_mismatch', '媒体与所请求的作品不符。');
		const isAudio = result.kind === 'audio',
			kind = isAudio ? 'audio' : 'video';
		const entry = {
			platform: target.platform,
			id: target.id,
			sourceUrl: target.url,
			title: result.title || path.basename(result.filepath, path.extname(result.filepath)),
			kind,
			body: '',
			bodyComplete: true,
			attachments: [
				{
					kind,
					mimeType: isAudio ? 'audio/mp4' : 'video/mp4',
					name: path.basename(result.filepath),
					path: path.relative(tmp, result.filepath),
				},
			],
		};
		const task = await importLibrary(
			{version: 1, items: [entry]},
			{root, sourceDir: tmp, signal: options.signal},
		);
		const {key} = entryIdentity(entry);
		const [record] = await searchLibrary({key}, {root});
		const saved = record?.attachments.find((a) => a.kind === kind && a.path);
		if (!saved) throw new EngineError('output_invalid', '媒体未能写入资料库。');
		const archivePath = path.join(root, saved.path);
		const filepath = options.outputDir
			? await copyResult(archivePath, options.outputDir, record, isAudio ? '.m4a' : '.mp4')
			: archivePath;
		return {
			...result,
			platform: entry.platform,
			id: record.id,
			filepath,
			taskId: task.id,
			offlinePage: record.filepath,
			status: task.items[0].status,
		};
	} finally {
		await rm(tmp, {recursive: true, force: true});
	}
}

async function readInputs(filename) {
	const handle = filename === '-' ? null : await open(filename, 'r');
	const stream = handle ? handle.createReadStream() : process.stdin;
	let len = 0;
	const chunks = [];
	try {
		for await (const chunk of stream) {
			len += Buffer.byteLength(chunk);
			if (len > 8 * 1024 ** 2) throw invalid('输入文件过大。');
			chunks.push(Buffer.from(chunk));
		}
	} finally {
		await handle?.close();
	}
	const s = Buffer.concat(chunks).toString('utf8').trim();
	if (s.startsWith('[')) {
		let a;
		try {
			a = JSON.parse(s);
		} catch {
			throw invalid('请输入 JSON URL 数组或每行一个链接。');
		}
		if (!Array.isArray(a) || !a.every((v) => typeof v === 'string'))
			throw invalid('需要 URL 字符串数组。');
		return a;
	}
	return s
		.split(/\r?\n/)
		.map((v) => v.trim())
		.filter(Boolean);
}

export async function runGetCommand(action, args) {
	const {values, positionals} = parseArgs({
		args,
		allowPositionals: true,
		options: {
			input: {type: 'string', short: 'i'},
			output: {type: 'string'},
			'allow-local': {type: 'boolean'},
			'max-height': {type: 'string'},
			'cookies-file': {type: 'string'},
			'timeout-ms': {type: 'string'},
			transport: {type: 'string'},
			json: {type: 'boolean'},
		},
	});
	const inputs = [...positionals, ...(values.input ? await readInputs(values.input) : [])];
	if (!inputs.length || inputs.length > 10000 || (action === 'info' && inputs.length !== 1))
		throw invalid('需要有效的链接或 -i 输入文件。');
	const controller = new AbortController();
	const cancel = () => controller.abort();
	process.once('SIGINT', cancel);
	try {
		for (const [i, input] of inputs.entries()) {
			try {
				const opt = {
					outputDir: values.output,
					allowLocal: values['allow-local'],
					cookiesFile: values['cookies-file'],
					transport: values.transport,
					signal: controller.signal,
				};
				for (const [name, key] of [
					['timeout-ms', 'timeoutMs'],
					['max-height', 'maxHeight'],
				])
					if (values[name] !== undefined) {
						const n = Number(values[name]);
						if (!Number.isSafeInteger(n) || n < 1 || n > 2147483647)
							throw invalid('超时和高度必须为正整数。');
						opt[key] = n;
					}
				const result = await getOne(action === 'info' ? 'info' : 'get', input, opt);
				console.log(JSON.stringify(result));
				if (result.status === 'partial') process.exitCode = 1;
			} catch (e) {
				const known = e instanceof EngineError || /^[a-z][a-z_]+$/.test(e?.code);
				const error = {
					code: known ? e.code : 'engine_error',
					message: known ? e.message : '无法完成此任务。',
				};
				if (inputs.length === 1 && action !== 'batch')
					throw new EngineError(error.code, error.message);
				console.log(JSON.stringify({index: i, sourceUrl: publicUrl(input), error}));
				process.exitCode = 1;
			}
			if (controller.signal.aborted) {
				process.exitCode = 130;
				break;
			}
		}
	} finally {
		process.removeListener('SIGINT', cancel);
	}
}
