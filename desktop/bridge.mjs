import {constants} from 'node:fs';
import {copyFile, link, mkdtemp, readFile, realpath, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {entryIdentity} from '../src/library/content.mjs';

async function readManifest(filename) {
	if (!filename || (await stat(filename)).size > 8 * 1024 * 1024) throw new Error();
	const manifest = JSON.parse(await readFile(filename, 'utf8'));
	if (manifest.version !== 1) throw new Error();
	const entries = [...(manifest.items ?? [])];
	for (const folder of manifest.folders ?? []) {
		const pages = folder.items !== undefined ? [{items: folder.items}] : (folder.pages ?? []);
		for (const page of pages) {
			for (const entry of page.items) {
				entry.platform ??= folder.platform;
				entries.push(entry);
			}
		}
	}
	if (entries.length > 5000) throw new Error();
	return {manifest, entries};
}

// Only manifests explicitly selected in the desktop picker may refer to local files.
async function prepareFromFile(manifest, entries, selected, folder) {
	const {prepareLibraryTask} = await import('../src/library/index.mjs');
	if (!entries.some((e) => e.attachments?.some((a) => a.url !== undefined)))
		return prepareLibraryTask(manifest, {sourceDir: folder, selected});
	const {stageAttachments} = await import('../native/library-bridge.mjs');
	const parent = await realpath(folder);
	const scratch = await mkdtemp(path.join(tmpdir(), 'fetchy-manifest-'));
	try {
		const selectedKeys = selected && new Set(selected);
		const included = selectedKeys
			? entries.filter((e) => selectedKeys.has(entryIdentity(e).key))
			: entries;
		let n = 0;
		const remote = [];
		for (const entry of included) {
			const attachments = [];
			for (const a of entry.attachments ?? []) {
				if (a.path === undefined) {
					if (a.url !== undefined) attachments.push(a);
					continue;
				}
				const source = a.path;
				delete a.path;
				delete a.url;
				if (typeof source !== 'string' || path.isAbsolute(source)) continue;
				let file;
				try {
					file = await realpath(path.resolve(parent, source));
				} catch (err) {
					if (['ENOENT', 'ENOTDIR'].includes(err.code)) continue;
					throw err;
				}
				if (!file.startsWith(parent + path.sep) || !(await stat(file)).isFile()) continue;
				const name = 'local-' + ++n + path.extname(file);
				const destination = path.join(scratch, name);
				try {
					await link(file, destination);
				} catch (error) {
					if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes(error.code))
						throw error;
					await copyFile(file, destination, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
				}
				a.path = name;
			}
			remote.push({attachments});
		}
		await stageAttachments(remote, scratch);
		return await prepareLibraryTask(manifest, {sourceDir: scratch, selected});
	} finally {
		await rm(scratch, {recursive: true, force: true});
	}
}

async function readStdin(limit) {
	let payload = '';
	for await (const chunk of process.stdin) {
		payload += chunk;
		if (payload.length > limit) throw new Error();
	}
	return payload;
}

try {
	const [command, ...args] = process.argv.slice(2);
	const {requestNative} = await import('../native/client.mjs');
	let result;
	switch (command) {
		case 'tasks':
			result = await requestNative('libraryTasks', {offset: Number(args[0]) || 0});
			break;
		case 'search': {
			const [query, platform, folder, topic, offset] = args;
			result = await requestNative('librarySearch', {
				filters: {query, platform, folder, topic},
				offset: Number(offset) || 0,
			});
			break;
		}
		case 'retry':
		case 'resume':
			result = await requestNative(command === 'retry' ? 'libraryRetry' : 'libraryResume', {
				id: args[0],
				...(command === 'retry' && args[1] ? {selected: [args[1]]} : {}),
			});
			break;
		case 'task':
			result = await requestNative('libraryTask', {
				id: args[0],
				offset: Number(args[1]) || 0,
				problems: args[2] === 'failed' ? 'failed' : args[2] === 'problems',
			});
			break;
		case 'site': {
			// The app opens each site with its own WebKit store; Node owns the site rules.
			const {findAccount} = await import('../bin/accounts.mjs');
			const {site, label, url, profile, hosts, session} = await findAccount(args[0]);
			result = {site, label, url, profile, hosts, session: session ?? []};
			break;
		}
		case 'account-add': {
			const {addAccount} = await import('../bin/accounts.mjs');
			const {site, label, url} = await addAccount(args[0]);
			result = {site, label, url};
			break;
		}
		case 'start': {
			// {manifest, selected, feed} from the app's side column.
			const payload = JSON.parse(await readStdin(48 * 1024 ** 2));
			const {submitArchive} = await import('../extension/archive-rpc.mjs');
			result = await submitArchive(
				payload.manifest,
				payload.selected,
				null,
				(method, params) => requestNative(method, params, {timeoutMs: 15 * 60_000}),
				{feed: payload.feed === true},
			);
			break;
		}
		case 'page':
			result = await requestNative('libraryPage', JSON.parse(await readStdin(1024 ** 2)));
			break;
		case 'feed-end':
			result = await requestNative('libraryFeed', {id: args[0], active: false});
			break;
		case 'web-save':
			result = await requestNative('webSave', {url: args[0]}, {timeoutMs: 31 * 60_000});
			break;
		case 'preview': {
			const {entries} = await readManifest(args[0]);
			const items = new Map();
			for (const entry of entries) {
				if (typeof entry.platform !== 'string' || typeof entry.id !== 'string') throw new Error();
				const {key} = entryIdentity(entry);
				if (!items.has(key))
					items.set(key, {
						key,
						title: String(entry.title || entry.body || entry.id).slice(0, 160),
						platform: entry.platform,
					});
			}
			result = [...items.values()];
			break;
		}
		case 'import': {
			const file = path.resolve(args[0]);
			const {manifest, entries} = await readManifest(file);
			const payload = await readStdin(1024 ** 2);
			const selected = payload ? JSON.parse(payload) : undefined;
			if (entries.some((entry) => entry.attachments?.some((a) => a.path !== undefined))) {
				const task = await prepareFromFile(manifest, entries, selected, path.dirname(file));
				result = await requestNative('libraryResume', {id: task.id});
			} else {
				const {submitArchive} = await import('../extension/archive-rpc.mjs');
				result = await submitArchive(manifest, selected, null, (method, params) =>
					requestNative(method, params, {timeoutMs: 15 * 60_000}),
				);
			}
			break;
		}
		default:
			throw new Error();
	}
	console.log(JSON.stringify(result));
} catch (error) {
	console.error(
		JSON.stringify({
			error: {
				code: error.code ?? 'unavailable',
				message: '无法读取收藏任务或清单，请检查服务和清单格式后重试。',
			},
		}),
	);
	process.exitCode = 1;
}
