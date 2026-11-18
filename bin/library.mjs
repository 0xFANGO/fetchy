import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {
	bilibiliFolderId,
	discoverBilibiliFolders,
	exportLibrary,
	getLibraryTask,
	importLibrary,
	listLibraryTasks,
	prepareLibraryTask,
	readBilibiliPage,
	runLibraryTask,
	searchLibrary,
} from '../src/library/index.mjs';
import {problem} from '../src/library/storage.mjs';
import {fetchPostPage} from '../src/library/post-pages.mjs';
import {siteCookieHeader, withSiteCookies} from './accounts.mjs';

// A worker in this process reads post pages itself, with that site's desktop sign-in.
const workerOptions = {
	readDetails: (item, {signal} = {}) =>
		fetchPostPage(item, {signal, cookieHeader: siteCookieHeader}),
	withSiteCookies,
};

export async function runLibraryCommand(args, {signal} = {}) {
	const {values, positionals} = parseArgs({
		args,
		strict: true,
		allowPositionals: true,
		options: {
			root: {type: 'string'},
			platform: {type: 'string'},
			folder: {type: 'string'},
			topic: {type: 'string'},
			select: {type: 'string', multiple: true},
			'cookies-file': {type: 'string'},
			queue: {type: 'boolean'},
			query: {type: 'string'},
			page: {type: 'string'},
		},
	});
	const [action, input, ...extra] = positionals;
	if (extra.length) throw problem('invalid_arguments', 'Too many arguments for library command.');
	const options = {
		...workerOptions,
		signal,
		root: values.root,
		cookiesFile: values['cookies-file'],
		selected: values.select,
	};
	const filters = {
		platform: values.platform,
		folder: values.folder,
		topic: values.topic,
		query: values.query,
	};
	let output;
	switch (action) {
		case 'tasks':
			output = await listLibraryTasks(options);
			break;
		case 'task':
			output = await getLibraryTask(input, options);
			break;
		case 'search':
			output = await searchLibrary({...filters, query: input ?? filters.query}, options);
			break;
		case 'export':
			output = await exportLibrary(filters, options);
			break;
		case 'page': {
			const id = bilibiliFolderId(input);
			if (!id)
				throw problem('invalid_folder', 'Use library page with a Bilibili folder ID or URL.');
			output = await readBilibiliPage(id, Number(values.page ?? 1), options);
			break;
		}
		case 'folders':
			if (input !== 'bilibili') throw problem('invalid_arguments', 'Use library folders bilibili.');
			output = await discoverBilibiliFolders(options);
			break;
		case 'resume':
		case 'retry':
			output = await runLibraryTask(input, {...options, retryFailed: action === 'retry'});
			break;
		case 'import':
		case 'sync': {
			if (!input)
				throw problem(
					'invalid_arguments',
					'Supply a local JSON manifest or a Bilibili collection URL.',
				);
			const id = bilibiliFolderId(input);
			let manifest;
			if (input === 'bilibili' && action === 'sync') {
				const result = await discoverBilibiliFolders(options);
				manifest = {
					version: 1,
					folders: result.folders.map((f) => ({...f, source: {type: 'bilibili', id: f.id}})),
				};
				if (!result.complete)
					manifest.folders.push({
						id: 'undiscovered',
						platform: 'bilibili',
						name: 'Incomplete folder discovery',
						items: [],
						complete: false,
					});
			} else if (id)
				manifest = {
					version: 1,
					folders: [{id, platform: 'bilibili', source: {type: 'bilibili', id}}],
				};
			else {
				if (/^https?:\/\//i.test(input))
					throw problem(
						'invalid_arguments',
						'Expected a supported collection URL or a local manifest.',
					);
				let data;
				try {
					data = await readFile(input, 'utf8');
				} catch {
					throw problem('invalid_manifest', 'Cannot read the manifest.');
				}
				try {
					manifest = JSON.parse(data);
				} catch {
					throw problem('invalid_manifest', 'Invalid manifest JSON.');
				}
				options.sourceDir = path.dirname(path.resolve(input));
			}
			output = values.queue
				? await prepareLibraryTask(manifest, options)
				: await importLibrary(manifest, options);
			break;
		}
		default:
			throw problem(
				'invalid_arguments',
				'Use library import, sync, resume, retry, tasks, task, search, export, folders, or page.',
			);
	}
	console.log(JSON.stringify(output, null, 2));
	if (
		['import', 'sync', 'resume', 'retry'].includes(action) &&
		['partial', 'failed', 'interrupted'].includes(output.status)
	)
		process.exitCode = 1;
	return output;
}

const brief = ({key, platform, title, author, status, filepath, folders}) => ({
	key,
	platform,
	title,
	author,
	status,
	folders: folders.map((f) => f.name),
	filepath,
});

// Ctrl+C aborts the work instead of exiting at once, so a lent cookies file is still deleted.
async function cancellable(work) {
	const controller = new AbortController();
	const cancel = () => controller.abort();
	process.once('SIGINT', cancel);
	try {
		return await work(controller.signal);
	} catch (error) {
		if (!controller.signal.aborted) throw error;
		// Cancelled by the user: no error report, the shell's usual exit status.
		process.exitCode = 130;
	} finally {
		process.removeListener('SIGINT', cancel);
	}
}

/** The short commands on the help's first screen. */
export async function runShortCommand(action, args) {
	const [input, ...extra] = args;
	if (extra.length) throw problem('invalid_arguments', 'Too many arguments.');
	switch (action) {
		case 'list':
			if (input) throw problem('invalid_arguments', 'fetchy list takes no arguments.');
			console.log(JSON.stringify((await searchLibrary({})).map(brief), null, 2));
			return;
		case 'search':
			if (!input) throw problem('invalid_arguments', '请提供关键词。');
			console.log(JSON.stringify((await searchLibrary({query: input})).map(brief), null, 2));
			return;
		case 'retry': {
			let id = input;
			if (!id) {
				const recent = (await listLibraryTasks()).find((t) => t.counts.failed || t.counts.partial);
				if (!recent) throw problem('not_found', '没有需要重试的任务。');
				id = recent.id;
			}
			await cancellable((signal) => runLibraryCommand(['retry', id], {signal}));
			return;
		}
		case 'folders':
		case 'sync': {
			const bilibili =
				input === 'bilibili' || (action === 'sync' && Boolean(bilibiliFolderId(input ?? '')));
			if (!bilibili)
				throw problem(
					'unsupported_platform',
					action === 'folders'
						? '命令行目前只能列出 B站收藏夹。其他网站请在浏览器打开收藏夹，用 Fetchy 右侧栏读取。'
						: '命令行目前只能同步 B站收藏夹。其他网站请在浏览器打开收藏夹，用 Fetchy 右侧栏保存。',
				);
			await cancellable((signal) =>
				withSiteCookies('https://www.bilibili.com/', (file) =>
					runLibraryCommand([action, input, ...(file ? ['--cookies-file', file] : [])], {signal}),
				),
			);
			return;
		}
	}
}
