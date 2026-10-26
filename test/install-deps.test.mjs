import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {installDependencies} from '../scripts/install-deps.mjs';

async function fixture(t, {existing = false, platform = 'darwin', intercept} = {}) {
	const root = await mkdtemp(path.join(tmpdir(), 'fetchy dependency setup '));
	t.after(() => rm(root, {recursive: true, force: true}));
	await writeFile(path.join(root, 'requirements.txt'), 'yt-dlp[default]==2026.10.21\n');
	const venv = path.join(root, '.venv');
	const binaries = path.join(venv, platform === 'win32' ? 'Scripts' : 'bin');
	const python = path.join(binaries, platform === 'win32' ? 'python.exe' : 'python');
	const ytDlp = path.join(binaries, platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
	if (existing) await mkdir(binaries, {recursive: true});
	const calls = [];
	const result = (stdout = '') => ({code: 0, stdout, stderr: ''});
	const run = async (command, args, options) => {
		calls.push({command, args, options});
		const intercepted = await intercept?.({command, args, options, root, venv, python, ytDlp});
		if (intercepted) return intercepted;
		if (args.includes('-c'))
			return result(
				JSON.stringify({
					version: [3, 11],
					prefix: command === python ? venv : root,
					basePrefix: root,
				}),
			);
		if (args.includes('venv')) {
			await mkdir(binaries, {recursive: true});
			return result();
		}
		if (args.includes('pip')) return result();
		assert.equal(command, ytDlp);
		assert.deepEqual(args, ['--version']);
		return result('2026.10.21\n');
	};
	return {root, venv, python, ytDlp, calls, options: {root, platform, run}};
}

test('dependency setup uses project paths with spaces and installs only into its venv', async (t) => {
	const setup = await fixture(t);
	assert.notEqual(process.cwd(), setup.root);
	const result = await installDependencies(setup.options);
	assert.deepEqual(result, {python: setup.python, ytDlp: setup.ytDlp, version: '2026.10.21'});
	assert.deepEqual(
		setup.calls.map(({command}) => command),
		['python3', 'python3', setup.python, setup.python, setup.ytDlp],
	);
	assert.deepEqual(setup.calls[1].args, ['-m', 'venv', setup.venv]);
	const pip = setup.calls.find(({args}) => args.includes('pip'));
	assert.equal(pip.command, setup.python);
	assert.ok(pip.args.includes('--require-virtualenv'));
	assert.equal(pip.args.at(-1), path.join(setup.root, 'requirements.txt'));
	for (const {options} of setup.calls) {
		assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 600_000);
		assert.ok(options.maxOutputBytes > 0 && options.maxOutputBytes <= 1_048_576);
	}
});

test('dependency setup reuses an existing venv and preserves its files on rerun', async (t) => {
	const setup = await fixture(t, {existing: true});
	const existingFile = path.join(setup.venv, 'keep.txt');
	await writeFile(existingFile, 'existing environment');
	await installDependencies({...setup.options, pythonPath: '/a different/python'});
	await installDependencies(setup.options);
	assert.equal(await readFile(existingFile, 'utf8'), 'existing environment');
	assert.equal(setup.calls.filter(({args}) => args.includes('pip')).length, 2);
	assert.equal(
		setup.calls.some(({args}) => args.includes('venv')),
		false,
	);
	assert.equal(
		setup.calls.some(({command}) => command === '/a different/python'),
		false,
	);
});

test('dependency setup can select a Python executable outside PATH', async (t) => {
	const setup = await fixture(t);
	const selected = path.join(setup.root, 'custom python');
	await installDependencies({...setup.options, pythonPath: selected});
	assert.equal(setup.calls[0].command, selected);
	assert.equal(setup.calls[1].command, selected);
});

test('dependency setup rejects old or missing Python before creating a venv', async (t) => {
	for (const unavailable of [false, true]) {
		const setup = await fixture(t, {
			intercept({args, root}) {
				if (args.includes('-c')) {
					if (unavailable) throw new Error('untrusted process error');
					return {
						code: 0,
						stdout: JSON.stringify({version: [3, 9], prefix: root, basePrefix: root}),
					};
				}
			},
		});
		await assert.rejects(installDependencies(setup.options), /Python 3\.10\+ is required/);
		assert.equal(setup.calls.length, 1);
	}
});

test('dependency setup refuses to overwrite a broken or non-virtual existing environment', async (t) => {
	for (const mode of ['broken', 'system', 'outside']) {
		const setup = await fixture(t, {
			existing: true,
			intercept({args, root}) {
				if (args.includes('-c')) {
					if (mode === 'broken') return {code: 1, stdout: '', stderr: 'private output'};
					return {
						code: 0,
						stdout: JSON.stringify({
							version: [3, 11],
							prefix: root,
							basePrefix: mode === 'system' ? root : '/another-python',
						}),
					};
				}
			},
		});
		await writeFile(path.join(setup.venv, 'keep.txt'), 'do not delete');
		await assert.rejects(installDependencies(setup.options), /Repair or rename it/);
		assert.equal(setup.calls.length, 1);
		assert.equal(await readFile(path.join(setup.venv, 'keep.txt'), 'utf8'), 'do not delete');
	}
});

test('dependency setup does not report success or expose tool output when pip fails', async (t) => {
	const setup = await fixture(t, {
		intercept({args}) {
			if (args.includes('pip'))
				return {code: 1, stdout: '', stderr: 'https://user:SECRET@example.test/index'};
		},
	});
	await assert.rejects(installDependencies(setup.options), (error) => {
		assert.match(error.message, /Could not install the pinned yt-dlp/);
		assert.doesNotMatch(error.message, /SECRET|example\.test/);
		return true;
	});
	assert.equal(
		setup.calls.some(({command}) => command === setup.ytDlp),
		false,
	);
});

test('dependency setup verifies the installed CLI before reporting success', async (t) => {
	for (const code of [0, 1]) {
		const setup = await fixture(t, {
			intercept({command, ytDlp}) {
				if (command === ytDlp) return {code, stdout: 'SECRET', stderr: 'SECRET'};
			},
		});
		await assert.rejects(installDependencies(setup.options), (error) => {
			assert.match(error.message, /yt-dlp/);
			assert.doesNotMatch(error.message, /SECRET/);
			return true;
		});
	}
});

test('Windows setup supports py -3 and falls back to python with Scripts executable paths', async (t) => {
	for (const launcherAvailable of [true, false]) {
		const setup = await fixture(t, {
			platform: 'win32',
			intercept({command}) {
				if (command === 'py' && !launcherAvailable) throw new Error('not found');
			},
		});
		await installDependencies(setup.options);
		assert.equal(setup.calls[0].command, 'py');
		assert.equal(setup.calls[0].args[0], '-3');
		const creation = setup.calls.find(({args}) => args.includes('venv'));
		assert.equal(creation.command, launcherAvailable ? 'py' : 'python');
		assert.deepEqual(creation.args, [
			...(launcherAvailable ? ['-3'] : []),
			'-m',
			'venv',
			setup.venv,
		]);
		assert.equal(setup.python, path.join(setup.venv, 'Scripts', 'python.exe'));
		assert.equal(setup.ytDlp, path.join(setup.venv, 'Scripts', 'yt-dlp.exe'));
	}
});

test('dependency setup stops after cancellation without exposing process output', async (t) => {
	const controller = new AbortController();
	const setup = await fixture(t, {
		intercept({args, options}) {
			assert.equal(options.signal, controller.signal);
			if (args.includes('pip')) {
				controller.abort();
				throw new Error('SECRET');
			}
		},
	});
	await assert.rejects(
		installDependencies({...setup.options, signal: controller.signal}),
		/Dependency installation cancelled/,
	);
	assert.equal(
		setup.calls.some(({command}) => command === setup.ytDlp),
		false,
	);
	const untouched = await fixture(t);
	await assert.rejects(
		installDependencies({...untouched.options, signal: controller.signal}),
		/Dependency installation cancelled/,
	);
	assert.equal(untouched.calls.length, 0);
});
