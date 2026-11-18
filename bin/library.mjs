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

export async function runLibraryCommand(args) {
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
	const options = {root: values.root, cookiesFile: values['cookies-file'], selected: values.select};
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
