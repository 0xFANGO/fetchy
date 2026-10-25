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
