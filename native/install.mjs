#!/usr/bin/env node
import {access, chmod, mkdir, readFile, writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {dataDirectory, privateDirectory, writeJson} from './settings.mjs';
import {extensionIdFromKey, manifestDirectories} from './install-paths.mjs';

const args = process.argv.slice(2);
function option(name, fallback) {
	const index = args.indexOf(name);
	if (index < 0) return fallback;
	if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} 缺少参数`);
	return args[index + 1];
}
async function executable(name) {
	for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
		const candidate = path.join(directory, name);
		try {
			await access(candidate, constants.X_OK);
			return path.resolve(candidate);
		} catch {}
	}
	return null;
}
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
try {
	if (args.includes('--help')) {
		console.log(
			'用法：node native/install.mjs [--browser ego|chrome|all] [--extension-id <id>] [--manifest-dir <绝对路径>]\nmacOS 本地开发安装；默认同时注册 Ego Lite 和 Chrome。',
		);
		process.exit(0);
	}
	if (process.platform !== 'darwin') throw new Error('本地组件安装脚本目前只支持 macOS。');
	if (Number(process.versions.node.split('.')[0]) < 22)
		throw new Error('需要 Node.js 22 或更高版本。');
	const root = fileURLToPath(new URL('../', import.meta.url));
	const manifest = JSON.parse(
		await readFile(path.join(root, 'extension', 'manifest.json'), 'utf8'),
	);
	const defaultId = manifest.key ? extensionIdFromKey(manifest.key) : '';
	const extensionId = option('--extension-id', defaultId);
	if (!/^[a-p]{32}$/.test(extensionId))
		throw new Error('扩展 ID 无效，请传入 --extension-id 或提供 manifest.key。');
	const browser = option('--browser', 'all');
	if (!['ego', 'chrome', 'all'].includes(browser))
		throw new Error('--browser 仅接受 ego、chrome 或 all。');
	const directory = dataDirectory();
	await privateDirectory(directory);
	const launcher = path.join(directory, 'fango-native-host');
	const hostPath = path.join(root, 'native', 'host.mjs');
	await writeFile(
		launcher,
		`#!/bin/sh\nexport FANGO_DATA_DIR=${quote(directory)}\nexec ${quote(process.execPath)} ${quote(hostPath)} "$@"\n`,
		{mode: 0o700},
	);
	await chmod(launcher, 0o700);
	const engineOptions = {};
	const localYtDlp = path.join(root, '.venv', 'bin', 'yt-dlp');
	try {
		await access(localYtDlp, constants.X_OK);
		engineOptions.ytDlpPath = localYtDlp;
	} catch {
		engineOptions.ytDlpPath = await executable('yt-dlp');
	}
	engineOptions.ffmpegLocation = await executable('ffmpeg');
	engineOptions.ffprobePath = await executable('ffprobe');
	engineOptions.egoBrowserPath = await executable('ego-browser');
	for (const name of Object.keys(engineOptions))
		if (!engineOptions[name]) delete engineOptions[name];
	await writeJson(path.join(directory, 'runtime.json'), {
		extensionId,
		nodePath: process.execPath,
		path: process.env.PATH ?? '/usr/bin:/bin',
		engineOptions,
	});
	const manifestDirectory = option('--manifest-dir', null);
	const directories = manifestDirectories(browser, homedir(), manifestDirectory);
	for (const target of directories) {
		if (!path.isAbsolute(target)) throw new Error('--manifest-dir 必须是绝对路径。');
		await mkdir(target, {recursive: true});
		await writeFile(
			path.join(target, 'com.fango.video_downloader.json'),
			JSON.stringify(
				{
					name: 'com.fango.video_downloader',
					description: 'Fango Video Downloader local component',
					path: launcher,
					type: 'stdio',
					allowed_origins: [`chrome-extension://${extensionId}/`],
				},
				null,
				2,
			),
			{mode: 0o600},
		);
	}
	console.log(
		JSON.stringify(
			{
				installed: true,
				extensionId,
				browser,
				hostName: 'com.fango.video_downloader',
				manifestDirectories: directories,
				extensionDirectory: path.join(root, 'dist', 'extension'),
				missingDependencies: [
					'ytDlpPath',
					'ffmpegLocation',
					'ffprobePath',
					'egoBrowserPath',
				].filter((key) => !engineOptions[key]),
			},
			null,
			2,
		),
	);
} catch (error) {
	console.error(error.message);
	process.exitCode = 1;
}
