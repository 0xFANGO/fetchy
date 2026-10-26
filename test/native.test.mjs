import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {NativeController} from '../native/controller.mjs';
import {MessageDecoder, encodeMessage, MAX_MESSAGE_BYTES} from '../native/protocol.mjs';
import {startServer} from '../native/server.mjs';
import {publicError} from '../native/errors.mjs';
import {shouldStopIdle} from '../native/lifecycle.mjs';
import {manifestDirectories} from '../native/install-paths.mjs';

const metadata = {
	platform: 'youtube',
	id: 'test-video',
	title: 'Test video',
	thumbnailUrl: 'https://i.ytimg.com/image.jpg?token=secret',
	durationSeconds: 2,
	engine: 'yt-dlp',
	formats: [
		{
			width: 320,
			height: 240,
			hasVideo: true,
			hasAudio: true,
			url: 'https://example.test/?token=secret',
		},
	],
};
const deferred = () => {
	let resolve, reject;
	const promise = new Promise((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return {promise, resolve, reject};
};
async function fixture(t, options = {}) {
	const directory = await mkdtemp('/tmp/fetchy-native-');
	const outputDir = path.join(directory, 'downloads');
	const controller = await new NativeController({
		directory,
		defaultDirectory: outputDir,
		core: {
			resolveVideo: async () => metadata,
			downloadVideo: async (_input, settings) => output(settings.outputDir),
			...options.core,
		},
		runProcess: options.runProcess ?? (async () => ({code: 0, stdout: ''})),
	}).initialize();
	t.after(async () => {
		await controller.close();
		await rm(directory, {recursive: true, force: true});
	});
	return {directory, outputDir, controller};
}
async function output(directory) {
	const taskDir = await mkdtemp(path.join(directory, 'video-'));
	const filepath = path.join(taskDir, 'media.mp4');
	await writeFile(filepath, 'video');
	return {
		filepath,
		bytes: 5,
		platform: 'youtube',
		id: 'test-video',
		validation: {video: true, audio: true, durationSeconds: 2, method: 'ffprobe'},
	};
}

test('native framing supports split/coalesced packets and rejects oversize/invalid/truncated packets', async () => {
	const decoder = new MessageDecoder(),
		messages = [];
	decoder.on('data', (value) => messages.push(value));
	const wire = Buffer.concat([encodeMessage({id: 'a'}), encodeMessage({id: 'b'})]);
	decoder.write(wire.subarray(0, 2));
	decoder.write(wire.subarray(2, 7));
	decoder.end(wire.subarray(7));
	await once(decoder, 'end');
	assert.deepEqual(messages, [{id: 'a'}, {id: 'b'}]);
	for (const bytes of [
		Buffer.from([255, 255, 255, 127]),
		Buffer.from([1, 0, 0, 0, 123]),
		Buffer.from([10, 0, 0, 0, 123]),
	]) {
		const invalid = new MessageDecoder();
		invalid.resume();
		const error = once(invalid, 'error');
		invalid.end(bytes);
		await error;
	}
	assert.throws(() => encodeMessage({text: 'x'.repeat(MAX_MESSAGE_BYTES)}));
});

test('start is idempotent under concurrency, reserves one task, and completion verifies actual output', async (t) => {
	const gate = deferred();
	let starts = 0;
	const {controller, outputDir} = await fixture(t, {
		core: {
			downloadVideo: async (_input, settings) => {
				starts++;
				await gate.promise;
				return output(settings.outputDir);
			},
		},
	});
	const params = {input: 'https://youtu.be/test-video', taskId: 'job-1', metadata};
	const [first, duplicate] = await Promise.all([
		controller.request('start', params),
		controller.request('start', params),
	]);
	assert.equal(first.task.id, duplicate.task.id);
	assert.equal(starts, 1);
	await assert.rejects(controller.request('start', {...params, taskId: 'job-2'}), {
		code: 'task_busy',
	});
	assert.equal(first.task.outputDir, outputDir);
	assert.equal(first.task.status, 'running');
	gate.resolve();
	await controller.downloadPromise;
	assert.equal(controller.snapshot().task.status, 'completed');
	assert.equal((await stat(controller.snapshot().task.result.filepath)).size, 5);
	await controller.request('start', params);
	assert.equal(starts, 1);
});

test('cancellation remains cancelling until core confirms cleanup and completion is not inferred from progress', async (t) => {
	const cleanup = deferred(),
		entered = deferred();
	const {controller} = await fixture(t, {
		core: {
			downloadVideo: async (_input, settings) => {
				settings.onProgress({stage: 'complete', bytes: 100, totalBytes: 100});
				entered.resolve();
				await once(settings.signal, 'abort');
				await cleanup.promise;
				throw Object.assign(new Error('signed secret URL'), {code: 'cancelled'});
			},
		},
	});
	await controller.request('start', {
		input: 'https://youtu.be/test-video',
		taskId: 'job-cancel',
		metadata,
	});
	await entered.promise;
	assert.equal(controller.snapshot().task.status, 'running');
	await controller.request('cancel', {taskId: 'job-cancel'});
	assert.equal(controller.snapshot().task.status, 'cancelling');
	cleanup.resolve();
	await controller.downloadPromise;
	assert.equal(controller.snapshot().task.status, 'cancelled');
});

test('persistence excludes inputs, thumbnails and arbitrary title text; restart marks unfinished task interrupted', async (t) => {
	const gate = deferred();
	const {controller, directory} = await fixture(t, {
		core: {
			downloadVideo: async () => {
				await gate.promise;
				throw Object.assign(new Error(), {code: 'cancelled'});
			},
		},
	});
	await controller.request('start', {
		input: 'https://www.xiaohongshu.com/explore/abc?xsec_token=SECRET_INPUT',
		taskId: 'job-secret',
		metadata: {...metadata, title: 'SECRET_TITLE https://example/?token=SECRET_TITLE'},
	});
	const saved = await readFile(path.join(directory, 'state.json'), 'utf8');
	assert.doesNotMatch(saved, /SECRET|token=secret|thumbnailUrl":"https/);
	const restart = await new NativeController({directory, core: {}}).initialize();
	assert.equal(restart.snapshot().task.status, 'interrupted');
	assert.equal(restart.snapshot().task.input, undefined);
	gate.resolve();
	await controller.downloadPromise;
});

test('directory picker result persists across clients, cancelled choice preserves it, settings pin running task directory', async (t) => {
	const gate = deferred();
	let selected = '';
	const {controller, directory, outputDir} = await fixture(t, {
		runProcess: async () => ({code: 0, stdout: selected}),
		core: {
			downloadVideo: async (_input, settings) => {
				await gate.promise;
				return output(settings.outputDir);
			},
		},
	});
	const next = path.join(directory, 'chosen');
	await mkdir(next);
	selected = `${next}/\n`;
	let state = await controller.request('chooseDirectory');
	assert.equal(state.pendingDirectory, next);
	assert.equal(state.choosingDirectory, false);
	selected = '';
	await controller.request('chooseDirectory');
	assert.equal(controller.snapshot().pendingDirectory, next);
	await controller.request('start', {
		input: 'https://youtu.be/test-video',
		taskId: 'job-path',
		metadata,
	});
	await controller.request('saveSettings', {outputDir: next});
	assert.equal(controller.snapshot().settings.outputDir, next);
	assert.equal(controller.snapshot().task.outputDir, outputDir);
	gate.resolve();
	await controller.downloadPromise;
	assert.ok(
		controller.snapshot().task.result.filepath.startsWith((await realpath(outputDir)) + path.sep),
	);
	await rm(next, {recursive: true});
	state = await controller.request('start', {
		input: 'https://youtu.be/test-video',
		taskId: 'job-missing-path',
		metadata,
	});
	assert.equal(state.task.status, 'failed');
	assert.equal(state.task.error.code, 'directory_invalid');
	await assert.rejects(controller.request('saveSettings', {outputDir: '/tmp'}), {
		code: 'directory_invalid',
	});
});

test('result must validate, exist, match byte count and remain within selected root; reveal uses only recorded file', async (t) => {
	let result, revealed;
	const {controller, directory, outputDir} = await fixture(t, {
		core: {downloadVideo: async () => result},
		runProcess: async (command, args) => {
			revealed = {command, args};
			return {code: 0, stdout: ''};
		},
	});
	await mkdir(outputDir);
	const outside = await output(directory);
	result = outside;
	await controller.request('start', {
		input: 'https://youtu.be/test-video',
		taskId: 'bad-output',
		metadata,
	});
	await controller.downloadPromise;
	assert.equal(controller.snapshot().task.status, 'failed');
	assert.equal(controller.snapshot().task.error.code, 'output_invalid');
	const valid = {...outside, filepath: path.join(outputDir, 'Test video.mp4')};
	await writeFile(valid.filepath, 'video');
	const invalidResults = [
		{...valid, validation: {video: true}},
		{...valid, filepath: path.join(outputDir, 'missing.mp4')},
		{...valid, bytes: 99},
	];
	for (const [index, invalid] of invalidResults.entries()) {
		result = invalid;
		await controller.request('start', {
			input: 'https://youtu.be/test-video',
			taskId: `invalid-result-${index}`,
			metadata,
		});
		await controller.downloadPromise;
		assert.equal(controller.snapshot().task.status, 'failed');
		assert.equal(controller.snapshot().task.error.code, 'output_invalid');
	}
	result = valid;
	await controller.request('start', {
		input: 'https://youtu.be/test-video',
		taskId: 'good-output',
		metadata,
	});
	await controller.downloadPromise;
	assert.equal(controller.snapshot().task.status, 'completed');
	assert.equal(path.dirname(controller.snapshot().task.result.filepath), await realpath(outputDir));
	await controller.request('reveal', {taskId: 'good-output', filepath: '/etc/passwd'});
	assert.deepEqual(revealed, {
		command: '/usr/bin/open',
		args: ['-R', await realpath(result.filepath)],
	});
	await rm(result.filepath);
	await assert.rejects(controller.request('reveal', {taskId: 'good-output'}), {
		code: 'file_missing',
	});
});

test('resolver cancellation suppresses completed stale result; metadata and errors never expose raw media secrets', async (t) => {
	const gate = deferred();
	const {controller} = await fixture(t, {
		core: {
			resolveVideo: async () => {
				await gate.promise;
				return {...metadata, token: 'secret', privateUrls: ['secret']};
			},
		},
	});
	const resolving = controller.request('resolve', {
		input: 'https://youtu.be/test-video',
		requestId: 'resolve-1',
	});
	await controller.request('cancelResolve', {requestId: 'resolve-1'});
	gate.resolve();
	await assert.rejects(resolving, {code: 'cancelled'});
	const resolved = await controller.request('resolve', {
		input: 'https://youtu.be/test-video',
		requestId: 'resolve-2',
	});
	assert.equal(resolved.token, undefined);
	assert.equal(resolved.formats[0].url, undefined);
	assert.deepEqual(publicError({code: 'network_error', message: 'https://signed/?token=secret'}), {
		code: 'network_error',
		message: '连接失败，请检查网络后重试。',
	});
});

function client(socketPath) {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(socketPath),
			decoder = new MessageDecoder(),
			waiting = new Map();
		socket.pipe(decoder);
		socket.on('error', reject);
		decoder.on('data', (value) => {
			if (value.id && waiting.has(value.id)) {
				waiting.get(value.id)(value);
				waiting.delete(value.id);
			}
		});
		socket.once('connect', () =>
			resolve({
				socket,
				call(id, method, params = {}) {
					return new Promise((done) => {
						waiting.set(id, done);
						socket.write(encodeMessage({id, method, params}));
					});
				},
			}),
		);
	});
}

test('native socket disconnect and reconnect recover the same task without starting it twice', async (t) => {
	const gate = deferred();
	let starts = 0;
	const {controller, directory} = await fixture(t, {
		core: {
			downloadVideo: async (_input, settings) => {
				starts++;
				await gate.promise;
				return output(settings.outputDir);
			},
		},
	});
	const socketPath = path.join(directory, 'bridge.sock'),
		server = await startServer(controller, socketPath);
	t.after(() => server.close());
	const first = await client(socketPath);
	const start = await first.call('request-a', 'start', {
		input: 'https://youtu.be/test-video',
		taskId: 'bridge-job',
		metadata,
	});
	first.socket.destroy();
	const second = await client(socketPath);
	const restored = await second.call('request-b', 'getState');
	assert.equal(restored.result.task.id, start.result.task.id);
	assert.equal(restored.result.task.status, 'running');
	assert.equal(starts, 1);
	gate.resolve();
	await controller.downloadPromise;
	const done = await second.call('request-c', 'getState');
	assert.equal(done.result.task.status, 'completed');
	second.socket.destroy();
});

test('installed host framing and detached daemon survive native host exit', async (t) => {
	const directory = await mkdtemp('/tmp/fetchy-host-');
	const extensionId = 'a'.repeat(32),
		origin = `chrome-extension://${extensionId}/`;
	await writeFile(
		path.join(directory, 'runtime.json'),
		JSON.stringify({extensionId, path: process.env.PATH}),
		{mode: 0o600},
	);
	t.after(async () => {
		try {
			const pid = Number(await readFile(path.join(directory, 'daemon.lock', 'pid'), 'utf8'));
			process.kill(pid, 'SIGTERM');
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 150));
		await rm(directory, {recursive: true, force: true});
	});
	const hostFile = fileURLToPath(new URL('../native/host.mjs', import.meta.url));
	async function callHost(originArg) {
		const host = spawn(process.execPath, [hostFile, originArg], {
			env: {...process.env, FETCHY_DATA_DIR: directory},
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		const decoder = new MessageDecoder();
		host.stdout.pipe(decoder);
		const response = new Promise((resolve) =>
			decoder.on('data', (message) => {
				if (message.id === 'state') resolve(message);
			}),
		);
		host.stdin.write(encodeMessage({id: 'state', method: 'getState'}));
		const value = await response;
		host.stdin.end();
		await once(host, 'exit');
		return value;
	}
	assert.equal((await callHost(origin)).ok, true);
	const pid = await readFile(path.join(directory, 'daemon.lock', 'pid'), 'utf8');
	assert.equal((await callHost(origin)).ok, true);
	assert.equal(await readFile(path.join(directory, 'daemon.lock', 'pid'), 'utf8'), pid);
	const bad = spawn(process.execPath, [hostFile, 'chrome-extension://' + 'b'.repeat(32) + '/'], {
		env: {...process.env, FETCHY_DATA_DIR: directory},
		stdio: 'ignore',
	});
	const [code] = await once(bad, 'exit');
	assert.equal(code, 1);
});

test('reliable progress uses downloadedBytes; a validated core output wins a late cancellation', async (t) => {
	const gate = deferred();
	const {controller, outputDir} = await fixture(t, {
		core: {
			downloadVideo: async (_input, settings) => {
				settings.onProgress({stage: 'downloading', bytes: 5, totalBytes: 10});
				return gate.promise;
			},
		},
	});
	await controller.request('start', {
		input: 'https://youtu.be/test-video',
		taskId: 'late-cancel',
		metadata,
	});
	assert.deepEqual(controller.snapshot().task.progress, {downloadedBytes: 5, totalBytes: 10});
	const valid = await output(outputDir);
	gate.resolve(valid);
	await Promise.resolve();
	await Promise.resolve();
	await controller.request('cancel', {taskId: 'late-cancel'});
	await controller.downloadPromise;
	assert.equal(controller.snapshot().task.status, 'completed');
	assert.equal((await stat(controller.snapshot().task.result.filepath)).size, 5);
});

test('idle daemon exits only after five minutes without clients or active work', () => {
	const controller = {task: null, choosingDirectory: false, resolvers: new Map()};
	const bridge = {clientCount: 0, lastActivity: 1000};
	assert.equal(shouldStopIdle(controller, bridge, 300999), false);
	assert.equal(shouldStopIdle(controller, bridge, 301001), true);
	bridge.clientCount = 1;
	assert.equal(shouldStopIdle(controller, bridge, 900000), false);
	bridge.clientCount = 0;
	bridge.lastActivity = 899999;
	assert.equal(shouldStopIdle(controller, bridge, 900000), false);
	bridge.lastActivity = 1000;
	for (const status of ['running', 'cancelling']) {
		controller.task = {status};
		assert.equal(shouldStopIdle(controller, bridge, 900000), false);
	}
	controller.task = {status: 'completed'};
	controller.choosingDirectory = true;
	assert.equal(shouldStopIdle(controller, bridge, 900000), false);
	controller.choosingDirectory = false;
	controller.resolvers.set('pending', {});
	assert.equal(shouldStopIdle(controller, bridge, 900000), false);
	controller.resolvers.clear();
	assert.equal(shouldStopIdle(controller, bridge, 900000), true);
});

test('Ego installer includes verified Chrome compatibility registration without duplicate paths', () => {
	const home = '/Users/test-user';
	const ego = `${home}/Library/Application Support/Citro Labs/ego lite/NativeMessagingHosts`;
	const chrome = `${home}/Library/Application Support/Google/Chrome/NativeMessagingHosts`;
	assert.deepEqual(manifestDirectories('ego', home), [ego, chrome]);
	assert.deepEqual(manifestDirectories('chrome', home), [chrome]);
	assert.deepEqual(manifestDirectories('all', home), [ego, chrome]);
	assert.deepEqual(manifestDirectories('ego', home, '/tmp/custom-hosts'), ['/tmp/custom-hosts']);
	assert.throws(() => manifestDirectories('ego', home, 'relative-path'));
	assert.throws(() => manifestDirectories('unknown', home));
});

test('directory chooser activates itself and shutdown aborts its process and clears choosing state', async (t) => {
	let called,
		abortObserved = false;
	const {controller} = await fixture(t, {
		runProcess: async (command, args, options) => {
			called = {command, args, options};
			await once(options.signal, 'abort');
			abortObserved = true;
			throw Object.assign(new Error('picker stopped'), {code: 'cancelled'});
		},
	});
	const chooser = controller.request('chooseDirectory');
	const rejection = assert.rejects(chooser, {code: 'cancelled'});
	assert.equal(controller.snapshot().choosingDirectory, true);
	assert.equal(called.command, '/usr/bin/osascript');
	assert.match(called.args[1], /^activate\ntry\n/);
	assert.doesNotMatch(called.args[1], /System Events/);
	assert.ok(called.options.signal instanceof AbortSignal);
	await controller.close();
	await rejection;
	assert.equal(abortObserved, true);
	assert.equal(controller.snapshot().choosingDirectory, false);
	assert.equal(controller.snapshot().pendingDirectory, null);
});

test('page media reaches the core for resolve and start but never a snapshot or the state file', async (t) => {
	const seen = [];
	const gate = deferred();
	const {controller, directory} = await fixture(t, {
		core: {
			resolveVideo: async (_input, settings) => {
				seen.push(settings.pageMedia);
				return metadata;
			},
			downloadVideo: async (_input, settings) => {
				seen.push(settings.pageMedia);
				await gate.promise;
				return output(settings.outputDir);
			},
		},
	});
	const pageMedia = {
		resolvedUrl:
			'https://www.xiaohongshu.com/explore/6adb92b90000000031037a66?xsec_token=RESOLVED_SECRET',
		media: {
			platform: 'xiaohongshu',
			id: '6adb92b90000000031037a66',
			formats: [{urls: ['https://sns-video.xhscdn.com/a.mp4?sign=SECRET']}],
		},
		userAgent: 'UA',
	};
	await controller.request('resolve', {
		input: 'https://youtu.be/test-video',
		requestId: 'r1',
		pageMedia,
	});
	await controller.request('start', {
		input: 'https://youtu.be/test-video',
		taskId: 'job-page-media',
		metadata,
		pageMedia,
	});
	assert.doesNotMatch(JSON.stringify(controller.snapshot()), /SECRET|pageMedia/);
	gate.resolve();
	await controller.downloadPromise;
	assert.deepEqual(seen, [pageMedia, pageMedia]);
	assert.doesNotMatch(
		await readFile(path.join(directory, 'state.json'), 'utf8'),
		/SECRET|pageMedia/,
	);
	await assert.rejects(
		controller.request('resolve', {input: 'https://youtu.be/x', requestId: 'r2', pageMedia: []}),
		{code: 'invalid_request'},
	);
});
