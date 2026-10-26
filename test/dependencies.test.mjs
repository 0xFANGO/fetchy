import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod, copyFile, mkdir, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {findExecutable, ytDlpCommand} from '../src/dependencies.mjs';
import {runProcess} from '../src/process.mjs';

async function sandbox(t) {
	const root = await realpath(await mkdtemp(path.join(tmpdir(), 'fetchy-dependencies-')));
	t.after(() => rm(root, {recursive: true, force: true}));
	return root;
}

async function command(filename, body = "console.log('fixture version');") {
	await mkdir(path.dirname(filename), {recursive: true});
	await writeFile(filename, `#!${process.execPath}\n${body}\n`);
	await chmod(filename, 0o755);
	return filename;
}

test('project yt-dlp takes precedence over a usable PATH installation', async (t) => {
	const root = await sandbox(t);
	const local = await command(path.join(root, '.venv', 'bin', 'yt-dlp'));
	const bin = path.join(root, 'tools');
	await command(path.join(bin, 'yt-dlp'));
	assert.equal(ytDlpCommand({root, envPath: bin, platform: 'linux'}), local);
});

for (const kind of ['non-executable file', 'directory']) {
	test(`${kind} does not shadow usable yt-dlp on PATH`, async (t) => {
		const root = await sandbox(t);
		const badBin = path.join(root, 'broken-tools');
		const goodBin = path.join(root, 'tools');
		const local = path.join(root, '.venv', 'bin', 'yt-dlp');
		for (const filename of [local, path.join(badBin, 'yt-dlp')]) {
			if (kind === 'directory') await mkdir(filename, {recursive: true});
			else {
				await command(filename);
				await chmod(filename, 0o644);
			}
		}
		const installed = await command(path.join(goodBin, 'yt-dlp'));
		const options = {root, envPath: `${badBin}:${goodBin}`, platform: 'linux'};
		assert.equal(findExecutable('yt-dlp', options), installed);
		assert.equal(ytDlpCommand(options), installed);
	});
}

test('explicit yt-dlp paths remain authoritative even if not executable', async (t) => {
	const root = await sandbox(t);
	await command(path.join(root, '.venv', 'bin', 'yt-dlp'));
	const bin = path.join(root, 'tools');
	await command(path.join(bin, 'yt-dlp'));
	for (const ytDlpPath of [path.join(root, 'missing-override'), 'custom-yt-dlp']) {
		assert.equal(ytDlpCommand({root, envPath: bin, platform: 'linux', ytDlpPath}), ytDlpPath);
	}
});

test('Windows lookup uses .venv Scripts and .exe candidates on semicolon-separated PATH', async (t) => {
	const root = await sandbox(t);
	const local = await command(path.join(root, '.venv', 'Scripts', 'yt-dlp.exe'));
	const bin = path.join(root, 'tools');
	const installed = await command(path.join(bin, 'yt-dlp.exe'));
	await command(path.join(bin, 'yt-dlp'));
	const options = {root, envPath: `${path.join(root, 'missing')};${bin}`, platform: 'win32'};
	assert.equal(ytDlpCommand(options), local);
	assert.equal(findExecutable('yt-dlp', options), installed);
	assert.equal(findExecutable('yt-dlp.exe', options), installed);
	await rm(local);
	assert.equal(ytDlpCommand(options), installed);
});

test('missing yt-dlp retains the command name for the normal dependency error path', async (t) => {
	const root = await sandbox(t);
	assert.equal(findExecutable('yt-dlp', {envPath: root, platform: 'linux'}), null);
	assert.equal(ytDlpCommand({root, envPath: root, platform: 'linux'}), 'yt-dlp');
});

async function doctorFixture(t) {
	const root = await sandbox(t);
	for (const relative of [
		'scripts/doctor.mjs',
		'src/dependencies.mjs',
		'src/process.mjs',
		'native/install-paths.mjs',
	]) {
		const target = path.join(root, relative);
		await mkdir(path.dirname(target), {recursive: true});
		await copyFile(fileURLToPath(new URL(`../${relative}`, import.meta.url)), target);
	}
	await writeFile(path.join(root, 'package.json'), JSON.stringify({type: 'module'}));
	const bin = path.join(root, 'tools');
	const local = await command(
		path.join(root, '.venv', 'bin', 'yt-dlp'),
		"console.log('2026.10.21');",
	);
	for (const name of ['yt-dlp', 'ffmpeg', 'ffprobe']) {
		await command(
			path.join(bin, name),
			`console.log(${JSON.stringify(`${name} fixture version`)});`,
		);
	}
	const doctorUrl = pathToFileURL(path.join(root, 'scripts', 'doctor.mjs')).href;
	return {
		root,
		bin,
		local,
		run: () =>
			runProcess(
				process.execPath,
				[
					'--input-type=module',
					'-e',
					`process.env.PATH = ${JSON.stringify(bin)}; await import(${JSON.stringify(doctorUrl)});`,
				],
				{timeoutMs: 15_000, maxOutputBytes: 1 << 16},
			),
	};
}

const doctorOptions = {
	skip: process.platform === 'win32' ? 'Fake tools use POSIX shebang execution' : false,
};

test(
	'doctor succeeds only when the required tools run and report their versions',
	doctorOptions,
	async (t) => {
		const fixture = await doctorFixture(t);
		const result = await fixture.run();
		assert.equal(result.code, 0, result.stdout);
		assert.match(result.stdout, /All required tools found/);
		for (const name of ['Node.js', 'yt-dlp', 'FFmpeg', 'ffprobe']) {
			assert.ok(
				result.stdout.split('\n').some((line) => line.startsWith('OK ') && line.includes(name)),
			);
		}
		assert.ok(result.stdout.includes(fixture.local));
		assert.match(result.stdout, /2026\.10\.21/);
	},
);

test(
	'doctor fails a nonzero version probe even if it printed a version',
	doctorOptions,
	async (t) => {
		const fixture = await doctorFixture(t);
		await command(
			path.join(fixture.bin, 'ffprobe'),
			"console.log('ffprobe version fixture'); process.exit(7);",
		);
		const result = await fixture.run();
		assert.equal(result.code, 1);
		assert.match(result.stdout, /MISSING\s+ffprobe\s+.*version check failed/);
		assert.doesNotMatch(result.stdout, /All required tools found/);
	},
);

test(
	'doctor rejects an executable yt-dlp whose interpreter no longer exists',
	doctorOptions,
	async (t) => {
		const fixture = await doctorFixture(t);
		await writeFile(fixture.local, `#!${path.join(fixture.root, 'missing-python')}\n`);
		await chmod(fixture.local, 0o755);
		const result = await fixture.run();
		assert.equal(result.code, 1);
		assert.match(result.stdout, /MISSING\s+yt-dlp\s+.*cannot run/);
		assert.match(result.stdout, /npm run deps:install/);
		assert.doesNotMatch(result.stdout, /All required tools found/);
	},
);

test('doctor rejects a successful process that reports no version', doctorOptions, async (t) => {
	const fixture = await doctorFixture(t);
	await command(path.join(fixture.bin, 'ffmpeg'), 'process.exit(0);');
	const result = await fixture.run();
	assert.equal(result.code, 1);
	assert.match(result.stdout, /MISSING\s+FFmpeg\s+.*no version reported/);
});
