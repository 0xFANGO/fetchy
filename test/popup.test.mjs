import test from 'node:test';
import assert from 'node:assert/strict';
import {
	deriveView,
	displayPath,
	errorMessage,
	formatDuration,
	safeThumbnail,
	withPendingDraft,
} from '../extension/view-model.mjs';

const connected = {status: 'connected'};
const context = {
	mode: 'manual',
	input: 'https://youtu.be/AAAAAAAAAAA',
	status: 'ready',
	metadata: {title: 'A video', platform: 'youtube'},
};
const result = {
	filepath: '/Downloads/Fetchy/video-one/media.mp4',
	bytes: 20,
	validation: {video: true, audio: true, durationSeconds: 12},
};

test('popup prioritizes active and unread tasks without changing their target', () => {
	const task = {
		id: 'a',
		status: 'running',
		stage: 'validating',
		unread: false,
		metadata: {title: 'Original target'},
	};
	const view = deriveView({connection: connected, context, task});
	assert.equal(view.title, 'Original target');
	assert.equal(view.status, '正在校验文件…');
	assert.equal(view.showInput, false);
	assert.equal(view.primary, null);
	assert.deepEqual(
		view.secondary.map((a) => a.action),
		['cancel'],
	);
	const done = deriveView({
		connection: connected,
		context,
		task: {...task, status: 'completed', unread: true, result},
	});
	assert.equal(done.primary.action, 'reveal');
	const acknowledged = deriveView({
		connection: connected,
		context,
		task: {...task, status: 'completed', result},
	});
	assert.equal(acknowledged.title, 'A video');
	assert.equal(acknowledged.primary.action, 'start');
	const restored = deriveView({connection: connected, context, task: {status: 'running'}});
	assert.equal(restored.title, '未命名视频');
	assert.equal(restored.thumbnail, null);
});

test('popup only shows saved after a complete validated file result', () => {
	for (const invalid of [
		null,
		{},
		{...result, bytes: 0},
		{...result, validation: {video: true}},
		{...result, filepath: ''},
	]) {
		const view = deriveView({connection: connected, task: {status: 'completed', result: invalid}});
		assert.notEqual(view.status, '已保存');
		assert.equal(view.primary.action, 'retry');
		assert.equal(view.actualPath, '');
	}
	const view = deriveView({connection: connected, task: {status: 'completed', result}});
	assert.equal(view.actualPath, result.filepath);
	assert.equal(view.status, '已保存');
});

test('cancellation waits for confirmation and loses determinate progress on disconnect', () => {
	const task = {
		status: 'cancelling',
		stage: 'downloading',
		progress: {downloadedBytes: 5, totalBytes: 10},
	};
	const view = deriveView({connection: connected, task});
	assert.equal(view.status, '正在取消…');
	assert.deepEqual(view.secondary, []);
	const offline = deriveView({connection: {status: 'disconnected'}, task});
	assert.equal(offline.status, '连接恢复后确认取消结果');
	assert.equal(offline.primary.action, 'reconnect');
	assert.equal(offline.progress, null);
});

test('percentages require real valid counts and only apply to transfer stage', () => {
	const state = {connection: connected, task: {status: 'running', stage: 'downloading'}};
	assert.equal(deriveView(state).progress, null);
	for (const progress of [
		{downloadedBytes: 12},
		{downloadedBytes: -1, totalBytes: 10},
		{downloadedBytes: 11, totalBytes: 10},
		{downloadedBytes: 2, totalBytes: 0},
	]) {
		assert.equal(deriveView({...state, task: {...state.task, progress}}).progress, null);
	}
	const progress = {downloadedBytes: 5, totalBytes: 10};
	assert.equal(deriveView({...state, task: {...state.task, progress}}).progress, 50);
	assert.equal(
		deriveView({...state, task: {...state.task, stage: 'postprocessing', progress}}).progress,
		null,
	);
});

test('manual input remains visible during resolution and failed input remains editable', () => {
	const resolving = deriveView({
		connection: connected,
		context: {...context, status: 'resolving', editing: true},
	});
	assert.equal(resolving.showInput, true);
	assert.equal(resolving.input, context.input);
	assert.equal(resolving.showCard, false);
	assert.equal(resolving.primary, null);
	const invalid = deriveView({
		connection: connected,
		context: {...context, status: 'error', error: {code: 'invalid_url'}},
	});
	assert.equal(invalid.showInput, true);
	assert.equal(invalid.input, context.input);
	assert.equal(invalid.primary.action, 'resolveInput');
});

test('directory selection survives settings display and current task retains pinned path', () => {
	const view = deriveView({
		connection: connected,
		view: 'settings',
		settings: {outputDir: '/old'},
		pendingDirectory: '/new',
		choosingDirectory: true,
		task: {status: 'running', outputDir: '/original'},
	});
	assert.equal(view.isSettings, true);
	assert.equal(view.directory, '/new');
	assert.equal(view.directoryPending, true);
	assert.equal(view.outputDir, '/original');
	assert.equal(view.choosingDirectory, true);
});

test('footer directory shortens home and only switches between tasks', () => {
	assert.equal(displayPath('/Users/me/Downloads/Fetchy'), '~/Downloads/Fetchy');
	assert.equal(displayPath('/home/me'), '~');
	assert.equal(displayPath('/Volumes/Media/Users/me'), '/Volumes/Media/Users/me');
	const idle = {connection: connected, context, settings: {outputDir: '/a'}};
	assert.equal(deriveView(idle).canChangeDirectory, true);
	assert.equal(deriveView({...idle, choosingDirectory: true}).canChangeDirectory, false);
	assert.equal(
		deriveView({...idle, connection: {status: 'disconnected'}}).canChangeDirectory,
		false,
	);
	assert.equal(
		deriveView({...idle, task: {status: 'running', outputDir: '/a'}}).canChangeDirectory,
		false,
	);
});

test('unknown duration and unsafe covers use honest fallbacks', () => {
	for (const value of [undefined, null, 0, -1, NaN, Infinity, '42'])
		assert.equal(formatDuration(value), '');
	assert.equal(formatDuration(65.9), '1:05');
	assert.equal(formatDuration(3665), '1:01:05');
	for (const value of [
		'javascript:alert(1)',
		'data:image/png;base64,a',
		'http://example.com/a',
		'https://user:password@example.com/image',
	])
		assert.equal(safeThumbnail(value), null);
	assert.equal(safeThumbnail('https://example.com/image.png'), 'https://example.com/image.png');
	const view = deriveView({connection: connected, context: {...context, metadata: {}}});
	assert.equal(view.title, '未命名视频');
	assert.equal(view.subtitle, '视频');
});

test('errors hide credential-bearing URLs and raw token values', () => {
	const message = errorMessage({
		message: 'Failed https://example.com/v?token=secret token=supersecret',
	});
	assert.ok(!message.includes('secret'));
	assert.ok(!message.includes('https://'));
});

test('a late ready state cannot replace a newer edit before the background acknowledges it', () => {
	const staleState = {connection: connected, context};
	const input = 'https://youtu.be/BBBBBBBBBBB';
	const protectedState = withPendingDraft(staleState, input);
	const view = deriveView(protectedState);
	assert.equal(view.input, input);
	assert.equal(view.showInput, true);
	assert.equal(view.showCard, false);
	assert.equal(view.primary, null);
	const acknowledged = {...staleState, context: {...context, input, status: 'resolving'}};
	assert.equal(withPendingDraft(acknowledged, input), acknowledged);
});

test('starting reservation disables buttons while a native start response is pending', () => {
	const view = deriveView({connection: connected, context, starting: true});
	assert.equal(view.primary.disabled, true);
	assert.equal(view.primary.label, '正在连接下载任务…');
	assert.ok(view.secondary.every((action) => action.disabled));
});

test('dependency repair is visible without preventing unrelated platform downloads', () => {
	const view = deriveView({
		connection: {...connected, dependencies: {ffmpeg: {available: false}}},
		context,
	});
	assert.match(view.connectionNotice, /FFmpeg/);
	assert.equal(view.showConnectionHelp, true);
	assert.equal(view.primary.action, 'start');
	assert.equal(view.primary.disabled, false);
});
