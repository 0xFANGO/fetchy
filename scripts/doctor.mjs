#!/usr/bin/env node
// Reports which local dependencies the download core and the extension can
// find, with an install hint for each missing one. Exit code 1 when a
// required tool is missing so it can gate setup scripts.
import {execFile} from 'node:child_process';
import {access, constants} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {manifestDirectories} from '../native/install-paths.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const mac = process.platform === 'darwin';
const win = process.platform === 'win32';

async function executable(candidate) {
	try {
		await access(candidate, constants.X_OK);
		return candidate;
	} catch {
		return null;
	}
}

async function onPath(name) {
	const names = win ? [`${name}.exe`, `${name}.cmd`, name] : [name];
	for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
		for (const file of names) {
			const found = await executable(path.join(directory, file));
			if (found) return found;
		}
	}
	return null;
}

async function version(command, args = ['-version']) {
	try {
		const {stdout} = await run(command, args, {timeout: 10_000, maxBuffer: 1 << 16});
		return stdout.split('\n')[0].trim().split(' ').slice(0, 3).join(' ');
	} catch {
		return '';
	}
}

const hint = (brew, other) => (mac ? `brew install ${brew}` : other);

const checks = [
	{
		name: 'Node.js',
		required: true,
		async find() {
			const major = Number(process.versions.node.split('.')[0]);
			return major >= 22
				? {where: process.execPath, detail: `v${process.versions.node}`}
				: {error: `v${process.versions.node} found, 22+ required`};
		},
		hint: hint('node', 'https://nodejs.org/en/download'),
	},
	{
		name: 'yt-dlp',
		required: true,
		async find() {
			const local = path.join(
				root,
				'.venv',
				win ? 'Scripts' : 'bin',
				win ? 'yt-dlp.exe' : 'yt-dlp',
			);
			const where = (await executable(local)) ?? (await onPath('yt-dlp'));
			return where ? {where, detail: await version(where, ['--version'])} : null;
		},
		hint: hint(
			'yt-dlp',
			'python3 -m venv .venv && .venv/bin/python -m pip install -r requirements.txt',
		),
	},
	{
		name: 'FFmpeg',
		required: true,
		async find() {
			const where = await onPath('ffmpeg');
			return where ? {where, detail: await version(where)} : null;
		},
		hint: hint('ffmpeg', 'https://ffmpeg.org/download.html'),
	},
	{
		name: 'ffprobe',
		required: true,
		async find() {
			const where = await onPath('ffprobe');
			return where ? {where, detail: await version(where)} : null;
		},
		hint: hint('ffmpeg', 'ships with FFmpeg'),
	},
	{
		name: 'Native host',
		required: false,
		async find() {
			if (!mac) return {where: 'n/a', detail: 'installer supports macOS only'};
			for (const directory of manifestDirectories('all', homedir())) {
				const manifest = path.join(directory, 'com.fetchy.video_downloader.json');
				try {
					await access(manifest, constants.R_OK);
					return {where: manifest, detail: 'registered'};
				} catch {}
			}
			return null;
		},
		hint: 'npm run extension:build && npm run native:install -- --browser chrome',
	},
];

let failed = false;
for (const check of checks) {
	const found = await check.find();
	const ok = found && !found.error;
	if (!ok && check.required) failed = true;
	const mark = ok ? 'OK ' : check.required ? 'MISSING' : 'optional';
	console.log(
		`${mark.padEnd(8)} ${check.name.padEnd(12)} ${ok ? found.where : (found?.error ?? '')}`,
	);
	if (ok && found.detail) console.log(`${''.padEnd(21)}${found.detail}`);
	if (!ok) console.log(`${''.padEnd(21)}→ ${check.hint}`);
}
console.log(
	failed
		? '\nInstall the missing tools above, then run `npm run doctor` again.'
		: '\nAll required tools found.',
);
process.exitCode = failed ? 1 : 0;
