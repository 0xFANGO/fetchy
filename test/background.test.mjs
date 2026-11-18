import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {resolveVideo} from '../src/index.mjs';
import {normalizeUrl} from '../src/urls.mjs';
import {extractPageMedia} from '../src/page-extract.mjs';
import {pageExtractInjection} from '../scripts/page-extract-inject.mjs';

function event() {
	return {
		addListener(listener) {
			this.listener = listener;
		},
	};
}

test('background reads page media only from an open tab of the exact video and never opens a tab', async () => {
	for (const target of [
		{
			platform: 'xiaohongshu',
			id: '6adb92b90000000031037a66',
			input: '分享 https://xhslink.com/example',
			url: 'https://www.xiaohongshu.com/explore/6adb92b90000000031037a66?xsec_token=BROWSER_ONLY_TOKEN',
			cdn: 'https://sns-video.xhscdn.com/a.mp4',
			shortLink: true,
		},
		{
			platform: 'xiaohongshu',
			id: '6adb92b90000000031037a66',
			input: 'https://www.xiaohongshu.com/explore/6adb92b90000000031037a66',
			url: 'https://www.xiaohongshu.com/explore/6adb92b90000000031037a66?xsec_token=BROWSER_ONLY_TOKEN',
			cdn: 'https://sns-video.xhscdn.com/a.mp4',
		},
		{
			platform: 'douyin',
			id: '7695202760953793827',
			input: 'https://www.douyin.com/video/7695202760953793827',
			url: 'https://www.douyin.com/video/7695202760953793827',
			cdn: 'https://v3-dy-o.zjcdn.com/a.mp4',
			reuse: true,
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
			name: 'panel',
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
				// A short link has no open page of its own.
				query: async () => (target.shortLink ? [] : [{id: 42, url: target.url}]),
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
				executeScript: async ({files, target: injectionTarget}) => {
					if (!files) return [];
					assert.equal(injectionTarget.tabId, 42);
					if (!target.reuse) return [{result: {ok: true, media, userAgent: 'fixture'}}];
					return [
						{
							result: vm.runInNewContext(pageExtractInjection(extractPageMedia), {
								URL,
								navigator: {userAgent: 'fixture'},
								__fetchyPageExtractArgs: {platform: target.platform, expectedId: target.id},
								document: {
									getElementById: () => null,
									querySelectorAll: () => [
										{
											readyState: 4,
											parentElement: {
												__reactFiber$fixture: {
													memoizedProps: {
														awemeInfo: {
															awemeId: target.id,
															video: {
																bitRateList: [
																	{
																		audioFileId: undefined,
																		width: 720,
																		height: 1280,
																		playAddr: [{src: target.cdn}],
																	},
																],
															},
														},
													},
												},
											},
										},
									],
								},
							}),
						},
					];
				},
			},
		};
		const previous = globalThis.chrome;
		globalThis.chrome = chrome;
		try {
			await import(
				`../extension/background.mjs?tab-test=${target.platform}-${target.reuse}-${target.shortLink}`
			);
			chrome.runtime.onConnect.listener(popup);
			const action = (name, data = {}) =>
				popup.onMessage.listener({type: 'action', action: name, ...data});
			await action('editInput', {input: target.input});
			await action('resolveInput');
			await action('start');
			const requests = calls.filter(({method}) => ['resolve', 'start'].includes(method));
			assert.deepEqual(created, []);
			assert.deepEqual(removed, []);
			if (target.shortLink) {
				assert.deepEqual(requests, []);
				continue;
			}
			assert.deepEqual(
				requests.map(({method}) => method),
				['resolve', 'start'],
			);
			for (const {params} of requests) {
				assert.equal(params.input, target.input);
				assert.equal(params.pageMedia.resolvedUrl, normalizeUrl(target.input).url);
				assert.equal(params.pageMedia.media.id, target.id);
			}
			assert.doesNotMatch(
				JSON.stringify(saves),
				/resolvedUrl|BROWSER_ONLY_TOKEN|xhscdn|douyinvod|zjcdn/,
			);
		} finally {
			globalThis.chrome = previous;
		}
	}
});

for (const outcome of ['ready', 'error', 'cancel']) {
	test(`background refresh reads the open page again without a new tab on ${outcome}`, async () => {
		const input = 'https://www.xiaohongshu.com/explore/6adb92b90000000031037a66';
		const metadata = {platform: 'xiaohongshu', id: '6adb92b90000000031037a66'};
		const calls = [],
			created = [],
			saves = [];
		let extractions = 0,
			queries = 0,
			finishQuery;
		const pendingQuery = new Promise((resolve) => {
			finishQuery = resolve;
		});
		let state = {task: null};
		const panel = {name: 'panel', onMessage: event(), onDisconnect: event(), postMessage() {}};
		const native = {
			onMessage: event(),
			onDisconnect: event(),
			postMessage(message) {
				calls.push(message);
				let result;
				if (message.method === 'hello') result = {state};
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
				query: async () => {
					queries++;
					if (outcome === 'cancel' && queries === 2) await pendingQuery;
					return [{id: 7, url: input}];
				},
				create: async (options) => {
					created.push(options);
					return {id: 42};
				},
			},
			scripting: {
				executeScript: async ({files}) => {
					if (!files) return [];
					extractions++;
					if (outcome === 'error' && extractions > 1)
						return [{result: {ok: false, code: 'no_formats'}}];
					const name = extractions > 1 ? 'FRESH_SECRET' : 'OLD_SECRET';
					return [
						{
							result: {
								ok: true,
								media: {
									...metadata,
									formats: [{urls: [`https://sns-video.xhscdn.com/${name}.mp4`]}],
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
			chrome.runtime.onConnect.listener(panel);
			await panel.onMessage.listener({type: 'action', action: 'start'});
			assert.equal(calls.find((c) => c.method === 'start').params.refreshOnValidationFailure, true);
			assert.equal(queries, 1);
			state = {task: {...state.task, stage: 'refreshing'}};
			native.onMessage.listener({event: 'state', state});
			native.onMessage.listener({event: 'state', state});
			await new Promise(setImmediate);
			if (outcome === 'cancel') {
				await panel.onMessage.listener({type: 'action', action: 'cancel'});
				finishQuery();
				await new Promise(setImmediate);
			}
			await new Promise((resolve) => setTimeout(resolve, 20));
			const replies = calls.filter((c) => c.method === 'refreshMedia');
			assert.deepEqual(created, []);
			assert.equal(queries, 2);
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
