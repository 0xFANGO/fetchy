import {stat, readFile} from 'node:fs/promises';
import path from 'node:path';

async function readManifest(filename) {
	if (!filename || (await stat(filename)).size > 8 * 1024 * 1024) throw new Error();
	const manifest = JSON.parse(await readFile(filename, 'utf8'));
	if (manifest.version !== 1) throw new Error();
	const entries = [...(manifest.items ?? [])];
	for (const folder of manifest.folders ?? [])
		for (const page of folder.pages ?? []) entries.push(...page.items);
	if (entries.length > 5000) throw new Error();
	return {manifest, entries};
}

try {
	const [command, ...args] = process.argv.slice(2);
	const {requestNative} = await import('../native/client.mjs');
	let result;
	switch (command) {
		case 'tasks':
			result = await requestNative('libraryTasks', {});
			break;
		case 'search': {
			const [query, platform, folder, topic] = args;
			result = await requestNative('librarySearch', {filters: {query, platform, folder, topic}});
			break;
		}
		case 'retry':
		case 'resume':
			result = await requestNative(command === 'retry' ? 'libraryRetry' : 'libraryResume', {
				id: args[0],
			});
			break;
		case 'preview': {
			const {entries} = await readManifest(args[0]);
			const items = new Map();
			for (const entry of entries) {
				if (typeof entry.platform !== 'string' || typeof entry.id !== 'string') throw new Error();
				const key = entry.platform + ':' + entry.id;
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
			let payload = '';
			for await (const chunk of process.stdin) {
				payload += chunk;
				if (payload.length > 1024 ** 2) throw new Error();
			}
			const selected = payload ? JSON.parse(payload) : undefined;
			if (entries.some((entry) => entry.attachments?.some((a) => a.path !== undefined))) {
				if (entries.some((entry) => entry.attachments?.some((a) => a.url !== undefined)))
					throw new Error();
				const {prepareLibraryTask} = await import('../src/library/index.mjs');
				const task = await prepareLibraryTask(manifest, {sourceDir: path.dirname(file), selected});
				result = await requestNative('libraryResume', {id: task.id});
			} else {
				result = await requestNative('libraryStart', {manifest, selected});
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
