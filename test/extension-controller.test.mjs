import test from 'node:test';
import assert from 'node:assert/strict';
import {Controller, initialState, displayError} from '../extension/controller.mjs';

const A = 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
	B = 'https://www.youtube.com/watch?v=bbbbbbbbbbb';
const info = (id) => ({
	platform: 'youtube',
	id,
	title: id,
	thumbnailUrl: null,
	durationSeconds: null,
});
const deferred = () => {
	let resolve, reject;
	const promise = new Promise((a, b) => {
		resolve = a;
		reject = b;
	});
	return {promise, resolve, reject};
};
function harness(overrides = {}) {
	const calls = [],
		saves = [];
	let serial = 0;
	const controller = new Controller({
		rpc: async (method, params) => {
			calls.push({method, params});
			if (method === 'resolve') return info(params.input);
			return {task: null};
		},
		readActiveTab: async () => ({id: 1, url: A}),
		saveSession: async (state) => saves.push(structuredClone(state)),
		uuid: () => `id-${++serial}`,
		debounceMs: 100000,
		...overrides,
	});
	return {controller, calls, saves};
}
test('normal webpages are empty states without a native resolve request', async () => {
	const {controller, calls} = harness({
		readActiveTab: async () => ({id: 1, url: 'https://www.youtube.com/'}),
	});
	await controller.initialize();
	assert.equal(controller.state.context.status, 'empty');
	assert.equal(calls.length, 0);
});
test('only latest manual input may publish metadata, including a late rejected response', async () => {
	const responses = [deferred(), deferred()];
	let count = 0;
	const {controller} = harness({
		rpc: (method) => (method === 'resolve' ? responses[count++].promise : Promise.resolve({})),
	});
	controller.editInput(A);
	const first = controller.resolveInput();
	controller.editInput(B);
	const second = controller.resolveInput();
	responses[1].resolve(info('B'));
	await second;
	responses[0].reject({code: 'network_error'});
	await first;
	assert.equal(controller.state.context.metadata.id, 'B');
	assert.equal(controller.state.context.input, B);
	assert.equal(controller.state.context.status, 'ready');
	controller.invalidate();
});
test('slow active-tab query cannot override a manual edit', async () => {
	const tab = deferred();
	const {controller} = harness({readActiveTab: () => tab.promise});
	const pending = controller.initialize();
	controller.editInput(B);
	tab.resolve({id: 1, url: A});
	await pending;
	assert.equal(controller.state.context.input, B);
	assert.equal(controller.state.context.mode, 'manual');
	controller.invalidate();
});
test('manual link validation preserves text and never sends multiple targets', async () => {
	const {controller, calls} = harness();
	controller.editInput(`${A} ${B}`);
	await controller.resolveInput();
	assert.equal(controller.state.context.error.code, 'invalid_url');
	assert.match(controller.state.context.input, /bbbb/);
	assert.equal(
		calls.some((c) => c.method === 'resolve'),
		false,
	);
	controller.invalidate();
});
test('a navigation invalidates auto results but a running download retains original identity', async () => {
	let url = A;
	const {controller} = harness({readActiveTab: async () => ({id: 1, url})});
	await controller.initialize();
	url = B;
	await controller.navigation(1, B);
	assert.equal(controller.state.context.input, B);
	controller.state.task = {
		id: 'task-a',
		input: A,
		status: 'running',
		metadata: info('A'),
		unread: true,
	};
	url = 'https://example.com';
	await controller.navigation(1, url);
	assert.equal(controller.state.context.metadata, null);
	assert.equal(controller.state.task.input, A);
});
test('duplicate start clicks reserve one stable ID, and a restored popup only queries state', async () => {
	const started = deferred();
	const calls = [];
	const {controller, saves} = harness({
		rpc: (method, params) => {
			calls.push({method, params});
			return method === 'start' ? started.promise : Promise.resolve({});
		},
	});
	controller.state.context = {
		...initialState().context,
		input: A,
		status: 'ready',
		metadata: info('A'),
	};
	const first = controller.start();
	await controller.persist;
	await controller.start();
	const start = calls.find((c) => c.method === 'start');
	assert.ok(start);
	assert.equal(calls.filter((c) => c.method === 'start').length, 1);
	started.resolve({
		task: {id: start.params.taskId, status: 'running', input: A, metadata: info('A'), unread: true},
	});
	await first;
	await controller.persist;
	const second = harness();
	second.controller.restore(saves.at(-1));
	await second.controller.initialize();
	assert.equal(second.calls.length, 0);
	assert.equal(second.controller.state.task.id, start.params.taskId);
});
test('cross-origin loading without URL permission immediately clears old automatic card', async () => {
	const {controller} = harness();
	await controller.initialize();
	assert.equal(controller.state.context.status, 'ready');
	await controller.navigation(1, undefined, {loading: true});
	assert.equal(controller.state.context.metadata, null);
	assert.equal(controller.state.context.status, 'empty');
});
test('reconnect reconciles an unacknowledged start without creating a second download', async () => {
	const {controller, calls} = harness();
	controller.pendingStart = {taskId: 'stable', input: A, metadata: info('A')};
	controller.receiveNative({task: {id: 'stable', status: 'running', input: A, unread: true}});
	assert.equal(controller.pendingStart, null);
	await controller.initialize();
	assert.equal(calls.length, 0);
});
test('lost native reservation becomes interrupted instead of loading forever', () => {
	const {controller} = harness();
	controller.pendingStart = {taskId: 'lost', input: A, metadata: info('A'), ambiguous: true};
	controller.receiveNative({task: null}, {authoritative: true});
	assert.equal(controller.state.task.status, 'interrupted');
	assert.equal(controller.pendingStart, null);
});
test('older daemon task after ambiguous start releases reservation without resubmitting', async () => {
	const {controller, calls} = harness({
		rpc: async () => {
			throw {code: 'task_not_found'};
		},
	});
	controller.pendingStart = {taskId: 'lost-b', input: B, metadata: info('B'), ambiguous: true};
	controller.receiveNative(
		{task: {id: 'old-a', status: 'completed', unread: false}},
		{authoritative: true},
	);
	assert.equal(controller.pendingStart, null);
	assert.equal(controller.state.task.id, 'lost-b');
	await controller.action('changeLink');
	assert.equal(controller.state.context.mode, 'manual');
	assert.equal(calls.length, 0);
});
test('initial hello cannot adjudicate a reservation that has not been sent yet', () => {
	const {controller} = harness();
	controller.pendingStart = {taskId: 'prepared', input: A};
	controller.receiveNative({task: null}, {authoritative: true});
	assert.equal(controller.pendingStart.taskId, 'prepared');
});
test('latest tab activation wins even when older query resolves first', async () => {
	const tabs = [deferred(), deferred()];
	let i = 0;
	const {controller} = harness({readActiveTab: () => tabs[i++].promise});
	const first = controller.detectCurrentPage(),
		second = controller.detectCurrentPage();
	tabs[0].resolve({id: 1, url: A});
	await first;
	tabs[1].resolve({id: 2, url: B});
	await second;
	assert.equal(controller.state.context.input, B);
	assert.equal(controller.tabId, 2);
});
test('matching in-memory session restores retry input but another task cannot inherit it', () => {
	const {controller} = harness();
	controller.state.task = {id: 'a', input: A, metadata: info('A')};
	controller.receiveNative({task: {id: 'a', status: 'interrupted', metadata: null}});
	assert.equal(controller.state.task.input, A);
	controller.receiveNative({task: {id: 'b', status: 'interrupted', metadata: null}});
	assert.equal(controller.state.task.input, undefined);
});
test('retry after a full browser restart requests original input rather than resolving unrelated context', async () => {
	const {controller, calls} = harness();
	controller.state.task = {id: 'restored', status: 'interrupted', unread: true};
	controller.state.context = {
		...initialState().context,
		input: B,
		status: 'ready',
		metadata: info('B'),
	};
	await controller.action('retry');
	assert.equal(controller.state.context.input, '');
	assert.equal(controller.state.context.mode, 'manual');
	assert.equal(
		calls.some((c) => c.method === 'resolve' || c.method === 'start'),
		false,
	);
});
test('cancel waits for execution confirmation and does not fabricate a cancelled task', async () => {
	const cancel = deferred();
	const {controller} = harness({rpc: () => cancel.promise});
	controller.state.task = {id: 't', status: 'running', input: A};
	const action = controller.action('cancel');
	assert.equal(controller.state.task.status, 'running');
	cancel.resolve({task: {id: 't', status: 'cancelling', input: A}});
	await action;
	assert.equal(controller.state.task.status, 'cancelling');
	controller.receiveNative({task: {id: 't', status: 'cancelled', input: A, unread: true}});
	assert.equal(controller.state.task.status, 'cancelled');
});
test('pending directory survives loss of popup and current task keeps its destination', async () => {
	const {controller} = harness({
		rpc: async () => ({
			settings: {outputDir: '/new'},
			pendingDirectory: null,
			task: {id: 't', status: 'running', outputDir: '/old'},
		}),
	});
	controller.receiveNative({settings: {outputDir: '/old'}, pendingDirectory: '/new'});
	await controller.action('openSettings');
	await controller.action('saveSettings', {outputDir: '/new'});
	assert.equal(controller.state.settings.outputDir, '/new');
	assert.equal(controller.state.task.outputDir, '/old');
	assert.equal(controller.state.settingsNotice, '已保存');
});
test('footer directory change saves a new pick and ignores a cancelled picker', async () => {
	let pick = '/picked';
	const {controller, calls} = harness({
		rpc: async (method, params) => {
			calls.push({method, params});
			if (method === 'chooseDirectory') return {pendingDirectory: pick, choosingDirectory: false};
			if (method === 'saveSettings')
				return {settings: {outputDir: params.outputDir}, pendingDirectory: null};
			return {};
		},
	});
	controller.receiveNative({settings: {outputDir: '/old'}, pendingDirectory: null});
	await controller.action('changeDirectory');
	assert.equal(controller.state.settings.outputDir, '/picked');
	assert.equal(controller.state.choosingDirectory, false);
	assert.equal(controller.state.view, 'main');
	pick = null;
	calls.length = 0;
	await controller.action('changeDirectory');
	assert.deepEqual(
		calls.map((c) => c.method),
		['chooseDirectory'],
	);
	assert.equal(controller.state.settings.outputDir, '/picked');
});
test('untrusted runtime exceptions do not expose URLs or credentials to popup', () => {
	assert.doesNotMatch(
		displayError({message: 'https://example.com/?token=secret'}).message,
		/secret/,
	);
	assert.equal(
		displayError({code: 'safe_error', message: '可操作提示', safe: true}).message,
		'可操作提示',
	);
});
test('confirmed native task survives a lost start receipt', async () => {
	const receipt = deferred();
	const {controller} = harness({rpc: () => receipt.promise});
	controller.state.context = {
		...initialState().context,
		input: A,
		status: 'ready',
		metadata: info('A'),
	};
	const started = controller.start();
	await controller.persist;
	const id = controller.pendingStart.taskId;
	controller.receiveNative({
		task: {id, status: 'completed', input: A, unread: true, result: {filepath: '/validated'}},
	});
	receipt.reject({code: 'timeout'});
	await started;
	assert.equal(controller.state.task.status, 'completed');
	assert.equal(controller.pendingStart, null);
});
test('session persistence failure releases startup lock without sending a download', async () => {
	let requests = 0;
	const {controller} = harness({
		saveSession: async () => {
			throw new Error('quota');
		},
		rpc: async () => {
			requests++;
		},
	});
	controller.state.context = {
		...initialState().context,
		input: A,
		status: 'ready',
		metadata: info('A'),
	};
	await controller.start();
	await controller.persist.catch(() => {});
	assert.equal(requests, 0);
	assert.equal(controller.starting, false);
	assert.equal(controller.pendingStart, null);
});

test('page media collected from the tab travels with resolve and start; collection errors stay local', async () => {
	const X = 'https://www.xiaohongshu.com/explore/6adb92b90000000031037a66';
	const pageMedia = {media: {platform: 'xiaohongshu', id: '6adb92b90000000031037a66'}};
	let fail = false;
	const {controller, calls} = harness({
		readActiveTab: async () => ({id: 1, url: X}),
		collectPageMedia: async (input) => {
			if (fail) throw {code: 'browser_state_missing'};
			return input === X ? pageMedia : undefined;
		},
	});
	await controller.initialize();
	assert.equal(controller.state.context.status, 'ready');
	assert.deepEqual(calls[0].params.pageMedia, pageMedia);
	await controller.start();
	assert.deepEqual(calls.at(-1).params.pageMedia, pageMedia);
	assert.equal(calls.at(-1).method, 'start');
	fail = true;
	controller.state.task = null;
	await controller.start();
	assert.equal(calls.at(-1).method, 'start');
	assert.match(controller.state.notice, /页面还没有加载出/);
	assert.equal(controller.state.starting, false);
});
