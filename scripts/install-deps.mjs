#!/usr/bin/env node
import {access, lstat, realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {runProcess} from '../src/process.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const pythonInfo =
	'import json,sys; print(json.dumps({"version": list(sys.version_info[:2]), "prefix": sys.prefix, "basePrefix": sys.base_prefix}))';
const repairHint =
	'The existing .venv is not a working Python 3.10+ virtual environment. Repair or rename it, then rerun npm run deps:install.';

export async function installDependencies({
	root = projectRoot,
	pythonPath,
	platform = process.platform,
	signal,
	run = runProcess,
} = {}) {
	root = path.resolve(root);
	const venv = path.join(root, '.venv');
	const requirements = path.join(root, 'requirements.txt');
	const binaries = path.join(venv, platform === 'win32' ? 'Scripts' : 'bin');
	const python = path.join(binaries, platform === 'win32' ? 'python.exe' : 'python');
	const ytDlp = path.join(binaries, platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
	const cancelled = () => {
		if (signal?.aborted) throw new Error('Dependency installation cancelled.');
	};
	async function inspect(command, args = []) {
		cancelled();
		try {
			const result = await run(command, [...args, '-c', pythonInfo], {
				signal,
				timeoutMs: 10_000,
				maxOutputBytes: 16_384,
			});
			if (result.code !== 0) return null;
			const info = JSON.parse(result.stdout);
			if (
				!Array.isArray(info.version) ||
				!info.version.slice(0, 2).every(Number.isInteger) ||
				!(info.version[0] > 3 || (info.version[0] === 3 && info.version[1] >= 10)) ||
				typeof info.prefix !== 'string' ||
				typeof info.basePrefix !== 'string'
			)
				return null;
			return info;
		} catch {
			cancelled();
			return null;
		}
	}
	async function execute(command, args, timeoutMs, failure) {
		cancelled();
		try {
			const result = await run(command, args, {signal, timeoutMs, maxOutputBytes: 1_048_576});
			if (result.code !== 0) throw new Error();
			return result;
		} catch {
			cancelled();
			throw new Error(failure);
		}
	}
	try {
		await access(requirements, constants.R_OK);
	} catch {
		throw new Error(
			'Cannot read the project requirements.txt. Run this command from a complete checkout.',
		);
	}
	const existing = await lstat(venv).catch((error) => {
		if (error.code === 'ENOENT') return null;
		throw new Error('Cannot access the project .venv. Check its permissions and try again.');
	});
	if (!existing) {
		const candidates = pythonPath
			? [[pythonPath, []]]
			: platform === 'win32'
				? [
						['py', ['-3']],
						['python', []],
					]
				: [['python3', []]];
		let selected;
		for (const [command, args] of candidates) {
			if (await inspect(command, args)) {
				selected = [command, args];
				break;
			}
		}
		if (!selected)
			throw new Error(
				'Python 3.10+ is required. Install it or run npm run deps:install -- --python /path/to/python.',
			);
		await execute(
			selected[0],
			[...selected[1], '-m', 'venv', venv],
			120_000,
			'Could not create .venv. Check that Python includes venv/ensurepip; repair or rename any incomplete .venv before retrying.',
		);
	}
	const info = await inspect(python);
	if (!info || info.prefix === info.basePrefix) throw new Error(repairHint);
	const samePath = (left, right) =>
		platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
	try {
		if (!samePath(await realpath(info.prefix), await realpath(venv))) throw new Error();
	} catch {
		throw new Error(repairHint);
	}
	await execute(
		python,
		[
			'-m',
			'pip',
			'--disable-pip-version-check',
			'install',
			'--require-virtualenv',
			'--no-input',
			'--progress-bar',
			'off',
			'-r',
			requirements,
		],
		600_000,
		'Could not install the pinned yt-dlp dependencies. Check the network, pip configuration and .venv permissions, then rerun npm run deps:install.',
	);
	const checked = await execute(
		ytDlp,
		['--version'],
		10_000,
		'yt-dlp was installed but could not start. Repair .venv and rerun npm run deps:install.',
	);
	const version = checked.stdout.trim();
	if (!/^\d{4}\.\d{2}\.\d{2}(?:[\w.+-]*)?$/.test(version))
		throw new Error(
			'yt-dlp did not report a valid version. Repair .venv and rerun npm run deps:install.',
		);
	return {python, ytDlp, version};
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	const controller = new AbortController();
	let cancelledExit;
	const interrupt = () => {
		cancelledExit = 130;
		controller.abort();
	};
	const terminate = () => {
		cancelledExit = 143;
		controller.abort();
	};
	process.once('SIGINT', interrupt);
	process.once('SIGTERM', terminate);
	try {
		const args = process.argv.slice(2);
		if (args.length === 1 && args[0] === '--help') {
			console.log(
				'Usage: npm run deps:install -- [--python <executable>]\nInstall pinned yt-dlp dependencies into the project .venv.\n--python selects Python 3.10+ when creating a new .venv; existing environments are reused.',
			);
		} else {
			if (
				args.length &&
				!(args.length === 2 && args[0] === '--python' && !args[1].startsWith('--'))
			)
				throw new Error('Usage: npm run deps:install -- [--python <executable>]');
			console.log('Installing pinned yt-dlp dependencies into the project .venv…');
			const result = await installDependencies({pythonPath: args[1], signal: controller.signal});
			console.log(
				`Installed yt-dlp ${result.version}. Run npm run doctor to check the remaining tools.`,
			);
		}
	} catch (error) {
		console.error(error.message);
		process.exitCode = cancelledExit ?? 1;
	} finally {
		process.removeListener('SIGINT', interrupt);
		process.removeListener('SIGTERM', terminate);
	}
}
