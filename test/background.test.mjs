import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveVideo} from '../src/index.mjs';
import {normalizeUrl} from '../src/urls.mjs';

function event() {
	return {
		addListener(listener) {
			this.listener = listener;
		},
	};
}

test('background forwards the browser-confirmed URL on resolve and start without persisting it', async () => {
	for (const target of [
		{
			platform: 'xiaohongshu',
			id: '6adb92b90000000031037a66',
			input: '分享 https://xhslink.com/example',
			url: 'https://www.xiaohongshu.com/explore/6adb92b90000000031037a66?xsec_token=BROWSER_ONLY_TOKEN',
			cdn: 'https://sns-video.xhscdn.com/a.mp4',
		},
		{
			platform: 'douyin',
			id: '7695202760953793827',
			input: 'https://v.douyin.com/example/',
			url: 'https://www.douyin.com/jingxuan?modal_id=7695202760953793827',
			cdn: 'https://v3.douyinvod.com/a.mp4',
		},
	]) {
		const media = {
			platform: target.platform,
			id: target.id,
			title: 'from browser',
			formats: [{hasVideo: true, hasAudio: true, width: 720, height: 1280, urls: [target.cdn]}],
		};
		const calls = [],
			saves = [],
			created = [],
			removed = [];
		const popup = {
			name: 'popup',
			onMessage: event(),
			onDisconnect: event(),
			postMessage() {},
		};
		const native = {
			onMessage: event(),
			onDisconnect: event(),
			postMessage(message) {
				calls.push(message);
				const state = {task: null, settings: {outputDir: '/tmp/downloads'}};
				const result =
					message.method === 'hello'
						? {state, dependencies: {node: {available: true}}}
						: message.method === 'resolve'
							? resolveVideo(message.params.input, {
									pageMedia: message.params.pageMedia,
									fetchImpl: async () => {
										throw new Error('must reuse the browser redirect');
									},
								})
							: {...state, task: {id: message.params.taskId, status: 'running'}};
				Promise.resolve(result).then(
					(value) => native.onMessage.listener({id: message.id, ok: true, result: value}),
					(error) =>
						native.onMessage.listener({id: message.id, ok: false, error: {code: error.code}}),
				);
			},
		};
		const chrome = {
			runtime: {onConnect: event(), onStartup: event(), connectNative: () => native},
			storage: {
				session: {
					get: async () => ({}),
					set: async (value) => saves.push(structuredClone(value)),
				},
			},
			action: {setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}},
			tabs: {
				onUpdated: event(),
				onActivated: event(),
				create: async (options) => {
					created.push(options);
					return {id: 42};
				},
				get: async () => ({id: 42, url: target.url, status: 'complete'}),
				remove: async (id) => {
					removed.push(id);
				},
			},
			scripting: {
				executeScript: async ({files}) =>
					files ? [{result: {ok: true, media, userAgent: 'fixture'}}] : [],
			},
		};
		const previous = globalThis.chrome;
		globalThis.chrome = chrome;
		try {
			await import(`../extension/background.mjs?shortlink-test=${target.platform}`);
			chrome.runtime.onConnect.listener(popup);
			const action = (name, data = {}) =>
				popup.onMessage.listener({type: 'action', action: name, ...data});
			await action('editInput', {input: target.input});
			await action('resolveInput');
			await action('start');
			const requests = calls.filter(({method}) => ['resolve', 'start'].includes(method));
			assert.deepEqual(
				requests.map(({method}) => method),
				['resolve', 'start'],
			);
			for (const {params} of requests) {
				assert.equal(params.input, target.input);
				assert.equal(params.pageMedia.resolvedUrl, normalizeUrl(target.url).url);
				assert.equal(params.pageMedia.media.id, target.id);
			}
			assert.deepEqual(
				created,
				Array.from({length: 2}, () => ({url: normalizeUrl(target.input).url, active: false})),
			);
			assert.deepEqual(removed, [42, 42]);
			assert.doesNotMatch(JSON.stringify(saves), /resolvedUrl|BROWSER_ONLY_TOKEN|xhscdn|douyinvod/);
		} finally {
			globalThis.chrome = previous;
		}
	}
});

for (const outcome of ['ready', 'error', 'cancel']) {
	test(`background refresh uses a new inactive tab and closes it on ${outcome}`, async () => {
		const input = 'https://www.xiaohongshu.com/explore/6adb92b90000000031037a66';
		const metadata = {platform: 'xiaohongshu', id: '6adb92b90000000031037a66'};
		const calls = [],
			created = [],
			removed = [],
			queries = [],
			saves = [];
		let finishGet;
		const pendingGet = new Promise((resolve) => {
			finishGet = resolve;
		});
		let state = {task: null};
		const popup = {name: 'popup', onMessage: event(), onDisconnect: event(), postMessage() {}};
		const native = {
			onMessage: event(),
			onDisconnect: event(),
			postMessage(message) {
				calls.push(message);
				let result;
				if (message.method === 'hello') result = {state, dependencies: {}};
				else if (message.method === 'start') {
					state = {
						task: {
							id: message.params.taskId,
							input,
							metadata,
							status: 'running',
							stage: 'downloading',
						},
					};
					result = state;
				} else if (message.method === 'cancel') {
					state = {task: {...state.task, status: 'cancelled'}};
					result = state;
				} else result = {accepted: true};
				queueMicrotask(() => native.onMessage.listener({id: message.id, ok: true, result}));
			},
		};
		const chrome = {
			runtime: {onConnect: event(), onStartup: event(), connectNative: () => native},
			storage: {
				session: {
					get: async () => ({
						session: {context: {mode: 'manual', input, metadata, status: 'ready'}},
					}),
					set: async (value) => saves.push(value),
				},
			},
			action: {setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}},
			tabs: {
				onUpdated: event(),
				onActivated: event(),
				query: async (options) => {
					queries.push(options);
					return [{id: 7, url: input}];
				},
				create: async (options) => {
					created.push(options);
					return {id: 42};
				},
				get: async () =>
					outcome === 'cancel' ? pendingGet : {id: 42, url: input, status: 'complete'},
				remove: async (id) => {
					removed.push(id);
				},
			},
			scripting: {
				executeScript: async ({files, target}) => {
					if (!files) return [];
					if (outcome === 'error' && target.tabId === 42)
						return [{result: {ok: false, code: 'no_formats'}}];
					return [
						{
							result: {
								ok: true,
								media: {
									...metadata,
									formats: [
										{
											urls: [
												`https://sns-video.xhscdn.com/${target.tabId === 42 ? 'FRESH' : 'OLD'}_SECRET.mp4`,
											],
										},
									],
								},
							},
						},
					];
				},
			},
		};
		const previous = globalThis.chrome;
		globalThis.chrome = chrome;
		try {
			await import(`../extension/background.mjs?refresh-test=${outcome}`);
			chrome.runtime.onConnect.listener(popup);
			await popup.onMessage.listener({type: 'action', action: 'start'});
			assert.equal(calls.find((c) => c.method === 'start').params.refreshOnValidationFailure, true);
			assert.equal(queries.length, 1);
			assert.equal(created.length, 0);
			state = {task: {...state.task, stage: 'refreshing'}};
			native.onMessage.listener({event: 'state', state});
			native.onMessage.listener({event: 'state', state});
			await new Promise(setImmediate);
			if (outcome === 'cancel') {
				await popup.onMessage.listener({type: 'action', action: 'cancel'});
				finishGet({id: 42, url: input, status: 'complete'});
				await new Promise(setImmediate);
			}
			const replies = calls.filter((c) => c.method === 'refreshMedia');
			assert.deepEqual(created, [{url: input, active: false}]);
			assert.deepEqual(removed, [42]);
			assert.equal(queries.length, 1);
			assert.equal(replies.length, outcome === 'cancel' ? 0 : 1);
			if (outcome === 'ready') assert.match(JSON.stringify(replies[0]), /FRESH_SECRET/);
			if (outcome === 'error') assert.equal(replies[0].params.errorCode, 'no_formats');
			assert.equal(calls.filter((c) => c.method === 'start').length, 1);
			assert.doesNotMatch(JSON.stringify(saves), /FRESH_SECRET|OLD_SECRET/);
		} finally {
			globalThis.chrome = previous;
		}
	});
}
