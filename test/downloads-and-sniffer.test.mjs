import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp, readdir, realpath, rm, stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {advanceArchivePage, captureArchivePage} from '../extension/capture-page.mjs';
import {LibraryBridge} from '../native/library-bridge.mjs';
import {installBrowserCompat} from '../src/browser-compat.mjs';
import {installMediaSniffer} from '../src/browser-sniffer.mjs';
import {looseJson, normalizeXiaohongshuPostUrl} from '../src/library/post-pages.mjs';
import {
	importLibrary,
	prepareLibraryTask,
	runLibraryTask,
	isEmptyPartialShell,
	removeLibraryWorks,
	renameLibraryWork,
	searchLibrary,
} from '../src/library/index.mjs';

const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

async function fixture(t, handle) {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'fetchy-downbit-'));
	const server = http.createServer(handle);
	await new Promise((done) => server.listen(0, '127.0.0.1', done));
	t.after(async () => {
		await new Promise((done) => server.close(done));
		await rm(dir, {recursive: true, force: true});
	});
	return {dir, origin: 'http://127.0.0.1:' + server.address().port};
}

test('direct outputDir publishes single file as <title>.<ext> and multi-file as <title>/01.<ext>, supporting rename and remove', async (t) => {
	const {dir, origin} = await fixture(t, (_req, res) => {
		res.writeHead(200, {'content-type': 'image/gif'}).end(gif);
	});
	const outputDir = path.join(dir, 'Downloads', 'Fetchy');
	const bridge = new LibraryBridge(dir, {
		session: {cookieHeader: async () => '', withCookies: (_url, action) => action()},
		getOutputDir: async () => outputDir,
	});
	bridge.options.localOrigin = origin;

	const single = {
		platform: 'xiaohongshu',
		id: 'single1',
		title: 'Single Photo',
		sourceUrl: 'https://www.xiaohongshu.com/explore/single1',
		body: 'one image',
		bodyComplete: true,
		attachments: [{kind: 'image', url: origin + '/a.gif'}],
	};
	const multi = {
		platform: 'xiaohongshu',
		id: 'multi2',
		title: 'Gallery Post',
		sourceUrl: 'https://www.xiaohongshu.com/explore/multi2',
		body: 'two images',
		bodyComplete: true,
		attachments: [
			{kind: 'image', url: origin + '/b1.gif'},
			{kind: 'image', url: origin + '/b2.gif'},
		],
	};

	const task = await bridge.request('libraryStart', {
		manifest: {version: 1, items: [single, multi]},
	});
	await bridge.tail;
	const done = await bridge.request('libraryTask', {id: task.id});
	assert.deepEqual(
		done.items.map((i) => i.status),
		['added', 'added'],
	);

	// Single file lands directly in outputDir as Single Photo.gif
	const realOut = await realpath(outputDir);
	const topEntries = (await readdir(realOut)).sort();
	assert.ok(topEntries.includes('Single Photo.gif'), `expected Single Photo.gif in ${topEntries}`);
	assert.ok(topEntries.includes('Gallery Post'), `expected Gallery Post dir in ${topEntries}`);

	const galleryEntries = (await readdir(path.join(outputDir, 'Gallery Post'))).sort();
	assert.deepEqual(galleryEntries, ['01.gif', '02.gif']);

	// Search exposes published primaryFile & files in outputDir
	const listed = await bridge.request('librarySearch', {});
	const rowSingle = listed.find((i) => i.key === 'xiaohongshu:single1');
	const rowMulti = listed.find((i) => i.key === 'xiaohongshu:multi2');
	assert.equal(rowSingle.primaryFile, path.join(realOut, 'Single Photo.gif'));
	assert.deepEqual(rowSingle.files, [path.join(realOut, 'Single Photo.gif')]);
	assert.equal(rowMulti.primaryFile, path.join(realOut, 'Gallery Post'));
	assert.equal(rowMulti.files.length, 2);

	// Rename updates published file in outputDir
	await renameLibraryWork('xiaohongshu:single1', 'Renamed Photo', bridge.options);
	const renamedStat = await stat(path.join(outputDir, 'Renamed Photo.gif'));
	assert.equal(renamedStat.size, gif.length);
	await assert.rejects(stat(path.join(outputDir, 'Single Photo.gif')));

	// Remove returns the published paths for Trashing
	const removed = await removeLibraryWorks(
		['xiaohongshu:single1', 'xiaohongshu:multi2'],
		bridge.options,
	);
	assert.ok(removed.files.includes(path.join(realOut, 'Renamed Photo.gif')));
	assert.ok(removed.files.includes(path.join(realOut, 'Gallery Post')));
});

test('libraryDownloads hides legacy empty partial shells, deduplicates rapid starts, and supports dismissing failures', async (t) => {
	const {dir, origin} = await fixture(t, (_req, res) => {
		res.writeHead(403).end();
	});
	const outputDir = path.join(dir, 'Downloads', 'Fetchy');
	const bridge = new LibraryBridge(dir, {
		session: {cookieHeader: async () => '', withCookies: (_url, action) => action()},
		getOutputDir: async () => outputDir,
	});
	bridge.options.localOrigin = origin;

	// Seed a legacy broken 0-media partial shell directly in the library DB
	await importLibrary(
		{
			version: 1,
			items: [
				{
					platform: 'xiaohongshu',
					id: 'legacy-shell',
					title: 'Broken Shell',
					sourceUrl: 'https://www.xiaohongshu.com/explore/legacy-shell',
					body: '',
					bodyComplete: false,
					attachments: [{kind: 'image', missing: true}],
				},
			],
		},
		bridge.options,
	);
	const [seeded] = await searchLibrary({key: 'xiaohongshu:legacy-shell'}, bridge.options);
	assert.equal(isEmptyPartialShell(seeded), true);

	// librarySearch and libraryStats both hide empty partial shells
	const search = await bridge.request('librarySearch', {});
	assert.equal(search.length, 0);
	const stats = await bridge.request('libraryStats', {});
	assert.equal(stats.total, 0);

	// Start a failing item (403 attachment) -> fails cleanly into failed list, not works
	const failingEntry = {
		platform: 'x',
		id: 'fail-1',
		title: 'Needs Login Post',
		sourceUrl: 'https://x.com/u/status/fail-1',
		body: 'hello',
		bodyComplete: true,
		attachments: [{kind: 'image', url: origin + '/denied.gif'}],
	};
	const t1 = await bridge.request('libraryStart', {manifest: {version: 1, items: [failingEntry]}});
	// Immediate duplicate submit of the same batch reuses the active task
	const t2 = await bridge.request('libraryStart', {manifest: {version: 1, items: [failingEntry]}});
	assert.equal(t2.id, t1.id);
	await bridge.tail;

	let state = await bridge.request('libraryDownloads', {});
	assert.equal(state.downloadsDir, outputDir);
	assert.equal(state.active.length, 0);
	assert.equal(state.failed.length, 2);
	const failedRow = state.failed.find((f) => f.key === 'x:fail-1');
	assert.ok(failedRow);
	assert.equal(failedRow.reason, 'auth_required');
	assert.ok(state.failed.some((f) => f.key === 'xiaohongshu:legacy-shell'));
	assert.equal(state.stats.total, 0);

	// Dismissing by key removes that item; dismissing with empty list clears all remaining failures
	await bridge.request('libraryDismissFailed', {keys: ['x:fail-1']});
	state = await bridge.request('libraryDownloads', {});
	assert.equal(state.failed.length, 1);
	await bridge.request('libraryDismissFailed', {keys: []});
	state = await bridge.request('libraryDownloads', {});
	assert.equal(state.failed.length, 0);
});

test('libraryCancelItem cancels a queued item before it executes', async (t) => {
	let releaseFirst;
	const firstStarted = new Promise((r) => {
		releaseFirst = r;
	});
	let unblockFirst;
	const waitFirst = new Promise((r) => {
		unblockFirst = r;
	});
	const {dir, origin} = await fixture(t, async (req, res) => {
		if (req.url === '/slow.gif') {
			releaseFirst();
			await waitFirst;
		}
		res.writeHead(200, {'content-type': 'image/gif'}).end(gif);
	});
	const outputDir = path.join(dir, 'Downloads', 'Fetchy');
	const bridge = new LibraryBridge(dir, {
		session: {cookieHeader: async () => '', withCookies: (_url, action) => action()},
		getOutputDir: async () => outputDir,
	});
	bridge.options.localOrigin = origin;

	const task = await bridge.request('libraryStart', {
		manifest: {
			version: 1,
			items: [
				{
					platform: 'x',
					id: 'item-1',
					title: 'First Item',
					sourceUrl: 'https://x.com/u/status/1',
					body: 'a',
					bodyComplete: true,
					attachments: [{kind: 'image', url: origin + '/slow.gif'}],
				},
				{
					platform: 'x',
					id: 'item-2',
					title: 'Second Item',
					sourceUrl: 'https://x.com/u/status/2',
					body: 'b',
					bodyComplete: true,
					attachments: [{kind: 'image', url: origin + '/fast.gif'}],
				},
			],
		},
	});
	await firstStarted;
	const activeNow = await bridge.request('libraryDownloads', {});
	assert.ok(activeNow.active.length >= 1);
	await bridge.request('libraryCancelItem', {taskId: task.id, key: 'x:item-2'});
	unblockFirst();
	await bridge.tail;

	const search = await bridge.request('librarySearch', {});
	assert.deepEqual(
		search.map((i) => i.key),
		['x:item-1'],
	);
});

test('installMediaSniffer detects MP4/HLS/DASH/JSON/DOM/iframe media, deduplicates, and filters ads & segments', async () => {
	const listeners = new Map();
	const docListeners = new Map();
	const timers = [];
	const mediaElements = [
		{
			tagName: 'VIDEO',
			currentSrc: 'https://cdn.example.com/videos/demo-clip.mp4',
			duration: 42.3,
			videoWidth: 1920,
			videoHeight: 1080,
			getAttribute: () => null,
			querySelectorAll: () => [],
		},
	];
	const perfEntries = [
		{name: 'https://cdn.example.com/hls/seg-0001.ts', transferSize: 50000},
		{name: 'https://cdn.example.com/dash/chunk-1.m4s', transferSize: 50000},
		{name: 'https://googleads.g.doubleclick.net/video/ad.mp4', transferSize: 99999},
		{name: 'https://cdn.example.com/videos/demo-clip.mp4', transferSize: 1234567},
		{name: 'https://cdn.example.com/audio/podcast.m4a', transferSize: 800000},
	];

	const mockWindow = {
		top: null,
		addEventListener(type, fn) {
			listeners.set(type, fn);
		},
		async fetch(url) {
			if (url.includes('stream-hls')) {
				return {
					ok: true,
					url,
					headers: new Map([
						['content-type', 'text/plain'],
						['content-length', '128'],
					]),
					clone() {
						return {text: async () => '#EXTM3U\n#EXT-X-VERSION:3\nchunk.ts'};
					},
				};
			}
			if (url.includes('douyin-feed')) {
				return {
					ok: true,
					url,
					headers: new Map([['content-type', 'application/json']]),
					clone() {
						return {
							text: async () =>
								JSON.stringify({
									aweme: {
										play_addr: {
											width: 720,
											height: 1280,
											url_list: ['https://v26.douyinvod.com/abc123/video.mp4'],
										},
									},
								}),
						};
					},
				};
			}
			return {ok: true, url, headers: new Map(), clone: () => ({text: async () => ''})};
		},
	};
	mockWindow.top = mockWindow;

	class MockXHR {
		constructor() {
			this._handlers = {};
			this.responseType = '';
			this.responseURL = '';
			this.responseText = '';
			this._headers = {};
		}
		open(_method, url) {
			this._url = url;
		}
		addEventListener(type, fn) {
			this._handlers[type] = fn;
		}
		getResponseHeader(name) {
			return this._headers[name.toLowerCase()] || '';
		}
		send() {
			this.responseURL = this._url;
			this._headers = {'content-type': 'application/xml'};
			this.responseText = '<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011"></MPD>';
			this._handlers.load?.call(this);
		}
	}

	const prev = {
		window: globalThis.window,
		document: globalThis.document,
		location: globalThis.location,
		performance: globalThis.performance,
		PerformanceObserver: globalThis.PerformanceObserver,
		XMLHttpRequest: globalThis.XMLHttpRequest,
		setInterval: globalThis.setInterval,
	};
	try {
		globalThis.window = mockWindow;
		globalThis.location = {
			href: 'https://www.douyin.com/video/123',
			hostname: 'www.douyin.com',
		};
		globalThis.document = {
			title: 'Demo Video Title',
			querySelectorAll(sel) {
				if (sel.includes('video')) return mediaElements;
				return [];
			},
			addEventListener(type, fn) {
				docListeners.set(type, fn);
			},
		};
		globalThis.performance = {
			getEntriesByType: () => perfEntries,
		};
		globalThis.PerformanceObserver = class {
			observe() {}
		};
		globalThis.XMLHttpRequest = MockXHR;
		globalThis.setInterval = (fn) => {
			timers.push(fn);
			return timers.length;
		};

		installMediaSniffer();
		assert.ok(mockWindow.__fetchySniffer);

		// Trigger hooked fetch for HLS + Douyin JSON
		await mockWindow.fetch('https://cdn.example.com/live/stream-hls');
		await mockWindow.fetch('https://www.douyin.com/aweme/v1/douyin-feed');
		await new Promise((r) => setTimeout(r, 10));

		// Trigger hooked XHR for DASH manifest
		const xhr = new MockXHR();
		xhr.open('GET', 'https://cdn.example.com/dash/manifest');
		xhr.send();

		// Trigger cross-iframe message
		listeners.get('message')?.({
			data: {
				__fetchyMedia: true,
				item: {
					url: 'https://iframe.example.com/embed/clip.mp4',
					type: 'video',
					title: 'Iframe Clip',
					host: 'iframe.example.com',
					size: 2048000,
					ts: Date.now(),
				},
			},
		});

		const items = mockWindow.__fetchySniffer.list();
		const urls = items.map((i) => i.url);
		// HLS and DASH ranked ahead of MP4/audio
		assert.equal(items[0].type, 'hls');
		assert.equal(items[1].type, 'dash');
		// All valid media detected & deduplicated
		assert.ok(urls.includes('https://cdn.example.com/live/stream-hls'));
		assert.ok(urls.includes('https://cdn.example.com/dash/manifest'));
		assert.ok(urls.includes('https://cdn.example.com/videos/demo-clip.mp4'));
		assert.ok(urls.includes('https://v26.douyinvod.com/abc123/video.mp4'));
		assert.ok(urls.includes('https://iframe.example.com/embed/clip.mp4'));
		assert.ok(urls.includes('https://cdn.example.com/audio/podcast.m4a'));
		// Demo video merged size from performance + dimensions from DOM
		const demo = items.find((i) => i.url === 'https://cdn.example.com/videos/demo-clip.mp4');
		assert.equal(demo.width, 1920);
		assert.equal(demo.height, 1080);
		assert.equal(demo.size, 1234567);
		// Ads and .ts/.m4s segments filtered out
		assert.ok(!urls.some((u) => u.includes('doubleclick')));
		assert.ok(!urls.some((u) => u.endsWith('.ts')));
		assert.ok(!urls.some((u) => u.endsWith('.m4s')));
		// No duplicates
		assert.equal(new Set(urls).size, urls.length);
	} finally {
		for (const [k, v] of Object.entries(prev)) {
			if (v === undefined) delete globalThis[k];
			else globalThis[k] = v;
		}
	}
});

test('looseJson parses Xiaohongshu INITIAL_STATE with new Map/Set/undefined while preserving strings', () => {
	const raw =
		'{"AiNoteDetailStore":{"noteDetailMap":new Map([])},"extra":new Set(["x"]),"u":undefined,"n":NaN,"inf":-Infinity,"keep":"new Map([]) and undefined"}';
	const parsed = looseJson(raw);
	assert.deepEqual(parsed, {
		AiNoteDetailStore: {noteDetailMap: null},
		extra: null,
		u: null,
		n: null,
		inf: null,
		keep: 'new Map([]) and undefined',
	});
});

test('normalizeXiaohongshuPostUrl rewrites profile/board note links to /explore while preserving xsec_token', () => {
	const input =
		'https://www.xiaohongshu.com/user/profile/0123456789abcdef01234567/fedcba9876543210fedcba98?xsec_token=AB123%3D&xsec_source=pc_user&extra=1';
	assert.equal(
		normalizeXiaohongshuPostUrl(input),
		'https://www.xiaohongshu.com/explore/fedcba9876543210fedcba98?xsec_token=AB123%3D&xsec_source=pc_user',
	);
	const boardInput =
		'https://www.rednote.com/board/my-board/fedcba9876543210fedcba98?xsec_token=TOK';
	assert.equal(
		normalizeXiaohongshuPostUrl(boardInput),
		'https://www.rednote.com/explore/fedcba9876543210fedcba98?xsec_token=TOK',
	);
});

test('runLibraryTask runs up to 3 items concurrently and isolates single-item cancellation', async (t) => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'fetchy-concurrent-'));
	t.after(() => rm(dir, {recursive: true, force: true}));
	const root = path.join(dir, 'lib');
	const items = Array.from({length: 5}, (_, i) => ({
		platform: 'xiaohongshu',
		id: String(100000000000000000000000n + BigInt(i)),
		title: 'Note ' + i,
		sourceUrl:
			'https://www.xiaohongshu.com/explore/' + String(100000000000000000000000n + BigInt(i)),
		body: '',
		bodyComplete: false,
	}));
	const task = await prepareLibraryTask({version: 1, items}, {root});
	let inFlight = 0;
	let maxInFlight = 0;
	const cancelKey = 'xiaohongshu:' + items[1].id;
	const controllers = new Map();
	const result = await runLibraryTask(task.id, {
		root,
		itemController: (key) => {
			const c = new AbortController();
			controllers.set(key, c);
			return c;
		},
		readDetails: async (item, {signal}) => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			try {
				await new Promise((resolve, reject) => {
					const timer = setTimeout(resolve, 60);
					if (item.key === cancelKey) {
						setTimeout(() => controllers.get(cancelKey)?.abort(), 15);
					}
					signal?.addEventListener(
						'abort',
						() => {
							clearTimeout(timer);
							reject(Object.assign(new Error('aborted'), {name: 'AbortError'}));
						},
						{once: true},
					);
				});
				return {
					title: item.title,
					author: 'Tester',
					body: 'Body ' + item.id,
					bodyComplete: true,
					attachments: [],
				};
			} finally {
				inFlight--;
			}
		},
	});
	assert.equal(maxInFlight, 3);
	assert.equal(result.counts.added, 4);
	assert.equal(result.counts.cancelled, 1);
});

test('captureArchivePage picks visible Xiaohongshu profile panel by height and captures non-favorites tabs', () => {
	const uid = '0123456789abcdef01234567';
	const noteId = 'fedcba9876543210fedcba98';
	const card = {
		querySelectorAll: (sel) =>
			sel === 'a[href]'
				? [
						{
							href:
								'https://www.xiaohongshu.com/user/profile/' + uid + '/' + noteId + '?xsec_token=T',
						},
					]
				: [],
		querySelector: (sel) => (sel.includes('.title') ? {textContent: 'Demo Note'} : null),
	};
	const makePanel = (height, hasNotes) => ({
		getBoundingClientRect: () => ({left: 0, right: 800, height}),
		querySelector: (sel) =>
			sel === '.feeds-container'
				? {
						querySelector: () => null,
						querySelectorAll: (s) => (s === '.note-item' && hasNotes ? [card] : []),
					}
				: null,
	});
	const hiddenPanel = makePanel(0, false);
	const visiblePanel = makePanel(1800, true);
	const invoke = (tabs) =>
		vm.runInNewContext('(' + captureArchivePage.toString() + ')(false)', {
			URL,
			URLSearchParams,
			location: {href: 'https://www.xiaohongshu.com/user/profile/' + uid + '?tab=fav&subTab=note'},
			window: {innerWidth: 800},
			document: {
				querySelector: () => null,
				querySelectorAll: (sel) => {
					if (sel === '.reds-tab-item.active') return tabs.map((t) => ({textContent: t}));
					if (sel === '.tab-content-item') return [hiddenPanel, visiblePanel];
					return [];
				},
			},
		});
	const fav = invoke(['收藏', '笔记・120']);
	assert.equal(fav.type, 'collection');
	assert.equal(fav.folder.id, 'saved-' + uid);
	assert.equal(fav.total, 120);
	assert.equal(fav.items.length, 1);
	assert.equal(
		fav.items[0].visitUrl,
		'https://www.xiaohongshu.com/explore/' + noteId + '?xsec_token=T',
	);

	// Non-favorites profile tab (e.g. 笔记 / 点赞) also captures cards instead of dead-ending.
	const likes = invoke(['点赞']);
	assert.equal(likes.type, 'collection');
	assert.equal(likes.folder.name, '点赞');
	assert.equal(likes.items.length, 1);
});

test('advanceArchivePage falls back to document.scrollingElement when inner scroll container is at bottom', () => {
	let docTop = 0;
	const docEl = {
		scrollHeight: 3000,
		clientHeight: 700,
		get scrollTop() {
			return docTop;
		},
		scrollTo({top}) {
			docTop = top;
		},
		dispatchEvent() {},
	};
	const innerAtBottom = {
		nodeType: 1,
		scrollHeight: 800,
		clientHeight: 700,
		scrollTop: 100,
		parentElement: null,
		scrollTo() {
			assert.fail('should not re-scroll an already-bottomed inner container');
		},
		dispatchEvent() {},
	};
	const feeds = {nodeType: 1, scrollHeight: 100, clientHeight: 100, parentElement: innerAtBottom};
	const panel = {
		getBoundingClientRect: () => ({left: 0, right: 800, height: 1500}),
		querySelector: () => feeds,
	};
	const res = vm.runInNewContext('(' + advanceArchivePage.toString() + ')(false)', {
		Event,
		window: {innerWidth: 800, innerHeight: 700, dispatchEvent() {}},
		getComputedStyle: (el) => ({overflowY: el === innerAtBottom ? 'scroll' : 'visible'}),
		document: {
			scrollingElement: docEl,
			documentElement: docEl,
			querySelectorAll: () => [panel],
			querySelector: () => feeds,
		},
	});
	assert.equal(res.before, 0);
	assert.equal(res.position, 560);
});

test('installMediaSniffer never clones JSON or streaming responses on unrelated/auth endpoints', async () => {
	const clonedUrls = [];
	const mockWindow = {
		top: null,
		addEventListener() {},
		async fetch(url, opts = {}) {
			const headers = new Map(Object.entries(opts.headers || {}));
			return {
				ok: true,
				url,
				headers,
				clone() {
					clonedUrls.push(url);
					return {text: async () => '{}'};
				},
			};
		},
	};
	mockWindow.top = mockWindow;

	const prev = {
		window: globalThis.window,
		document: globalThis.document,
		location: globalThis.location,
		performance: globalThis.performance,
		PerformanceObserver: globalThis.PerformanceObserver,
		XMLHttpRequest: globalThis.XMLHttpRequest,
		setInterval: globalThis.setInterval,
	};
	try {
		globalThis.window = mockWindow;
		globalThis.location = {href: 'https://x.com/i/flow/login', hostname: 'x.com'};
		globalThis.document = {
			title: 'Log in to X',
			querySelectorAll: () => [],
			addEventListener() {},
		};
		globalThis.performance = {getEntriesByType: () => []};
		globalThis.PerformanceObserver = class {
			observe() {}
		};
		globalThis.XMLHttpRequest = undefined;
		globalThis.setInterval = () => 1;

		installMediaSniffer();

		// Unrelated JSON (Google/X login, GraphQL), missing Content-Length, oversized text, HTML
		await mockWindow.fetch('https://accounts.google.com/v3/signin/_/AccountsSignInUi/data', {
			headers: {'content-type': 'application/json', 'content-length': '2048'},
		});
		await mockWindow.fetch('https://x.com/i/api/graphql/abc/TweetDetail', {
			headers: {'content-type': 'application/json', 'content-length': '4096'},
		});
		await mockWindow.fetch('https://x.com/i/events/stream', {
			headers: {'content-type': 'text/plain'},
		});
		await mockWindow.fetch('https://x.com/assets/large.txt', {
			headers: {'content-type': 'text/plain', 'content-length': String(2 * 1024 * 1024)},
		});
		await mockWindow.fetch('https://x.com/home', {
			headers: {'content-type': 'text/html; charset=utf-8', 'content-length': '1024'},
		});
		// Explicit 0 < Content-Length <= 1MB plain text IS allowed to be inspected for HLS/DASH
		await mockWindow.fetch('https://cdn.example.com/playlist/probe', {
			headers: {'content-type': 'text/plain', 'content-length': '256'},
		});
		await new Promise((r) => setTimeout(r, 10));

		assert.deepEqual(clonedUrls, ['https://cdn.example.com/playlist/probe']);
	} finally {
		Object.assign(globalThis, prev);
	}
});

test('installBrowserCompat removes WebAuthn globals and rejects publicKey calls while preserving non-publicKey credentials', async () => {
	let passthroughCalled = false;
	class FakePublicKeyCredential {}
	class FakeAuthenticatorResponse {}
	const fakeCredentials = {
		async get(options) {
			passthroughCalled = options?.password === true;
			return {type: 'password'};
		},
		async create() {
			return {type: 'password'};
		},
	};
	const sandbox = {
		DOMException,
		PublicKeyCredential: FakePublicKeyCredential,
		AuthenticatorResponse: FakeAuthenticatorResponse,
		AuthenticatorAttestationResponse: FakeAuthenticatorResponse,
		AuthenticatorAssertionResponse: FakeAuthenticatorResponse,
		navigator: {credentials: fakeCredentials},
	};
	sandbox.window = sandbox;
	vm.runInNewContext('(' + installBrowserCompat.toString() + ')()', sandbox);

	assert.equal('PublicKeyCredential' in sandbox, false);
	assert.equal(typeof sandbox.PublicKeyCredential, 'undefined');
	assert.equal('AuthenticatorResponse' in sandbox, false);
	assert.equal('AuthenticatorAttestationResponse' in sandbox, false);
	assert.equal('AuthenticatorAssertionResponse' in sandbox, false);

	await assert.rejects(
		() => sandbox.navigator.credentials.get({publicKey: {challenge: new Uint8Array(8)}}),
		{name: 'NotSupportedError'},
	);
	await assert.rejects(
		() => sandbox.navigator.credentials.create({publicKey: {challenge: new Uint8Array(8)}}),
		{name: 'NotSupportedError'},
	);
	const res = await sandbox.navigator.credentials.get({password: true});
	assert.equal(passthroughCalled, true);
	assert.equal(res.type, 'password');
});
