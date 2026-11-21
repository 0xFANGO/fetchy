import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp, readdir, readFile, realpath, rm, stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {isCollectionRoute} from '../extension/archive-source.mjs';
import {advanceArchivePage, captureArchivePage} from '../extension/capture-page.mjs';
import {captureSocialPost} from '../extension/social-post.mjs';
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
		body: '',
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
	assert.deepEqual(galleryEntries, ['01.gif', '02.gif', 'Gallery Post.md']);
	const galleryMd = await readFile(path.join(outputDir, 'Gallery Post', 'Gallery Post.md'), 'utf8');
	assert.match(galleryMd, /two images/);

	// Search exposes published primaryFile & files in outputDir
	const listed = await bridge.request('librarySearch', {});
	const rowSingle = listed.find((i) => i.key === 'xiaohongshu:single1');
	const rowMulti = listed.find((i) => i.key === 'xiaohongshu:multi2');
	assert.equal(rowSingle.primaryFile, path.join(realOut, 'Single Photo.gif'));
	assert.deepEqual(rowSingle.files, [path.join(realOut, 'Single Photo.gif')]);
	assert.equal(rowMulti.primaryFile, path.join(realOut, 'Gallery Post'));
	assert.equal(rowMulti.files.length, 3);

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

test('installMediaSniffer deduplicates X/HLS sub-playlists, enriches X tweet titles/posters, hides manifest sizes, and clears on SPA navigation', async () => {
	const masterUrl = 'https://video.twimg.com/amplify_video/198765432100/pl/master.m3u8?tag=16';
	const variant720 =
		'https://video.twimg.com/amplify_video/198765432100/pl/avc1/1280x720/v720.m3u8';
	const variantAudio = 'https://video.twimg.com/amplify_video/198765432100/pl/mp4a/128000/aud.m3u8';
	const genericMaster = 'https://cdn.example.com/v1/master.m3u8';
	const genericChild = 'https://cdn.example.com/v1/720p.m3u8';
	const perfEntries = [
		{name: variant720, transferSize: 18432},
		{name: variantAudio, transferSize: 3072},
		{name: masterUrl, transferSize: 4096},
	];
	let currentHref = 'https://x.com/home';
	const mockTweetArticle = {
		querySelector(sel) {
			if (sel === 'video')
				return {
					poster: 'https://pbs.twimg.com/amplify_video_thumb/198765432100/img/thumb.jpg',
					duration: 42,
					videoWidth: 1280,
					videoHeight: 720,
				};
			if (sel === '[data-testid="User-Name"]') return {textContent: 'Alice\n@alice·2h'};
			if (sel === '[data-testid="tweetText"]') return {textContent: 'Check out this demo clip!'};
			if (sel === 'a[href*="/status/"] time') return null;
			if (sel === 'a[href*="/status/"]') return {getAttribute: () => '/alice/status/999888777'};
			return null;
		},
		querySelectorAll() {
			return [];
		},
	};
	const mockWindow = {
		top: null,
		addEventListener() {},
		async fetch(url) {
			const bodies = {
				[genericMaster]:
					'#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1920x1080\n720p.m3u8\n',
				[genericChild]: '#EXTM3U\n#EXTINF:4.0,\nseg0.ts\n',
			};
			const body = bodies[url] || '';
			const headers = new Map([
				['content-type', 'application/vnd.apple.mpegurl'],
				['content-length', String(body.length)],
			]);
			return {
				ok: true,
				url,
				headers,
				clone() {
					return {text: async () => body};
				},
			};
		},
	};
	mockWindow.top = mockWindow;
	const mockHistory = {
		pushState(_s, _t, nextUrl) {
			currentHref = new URL(nextUrl, currentHref).href;
		},
		replaceState(_s, _t, nextUrl) {
			currentHref = new URL(nextUrl, currentHref).href;
		},
	};
	const prev = {
		window: globalThis.window,
		document: globalThis.document,
		location: globalThis.location,
		history: globalThis.history,
		performance: globalThis.performance,
		PerformanceObserver: globalThis.PerformanceObserver,
		XMLHttpRequest: globalThis.XMLHttpRequest,
		setInterval: globalThis.setInterval,
	};
	try {
		globalThis.window = mockWindow;
		globalThis.location = {
			get href() {
				return currentHref;
			},
			get origin() {
				return new URL(currentHref).origin;
			},
			get hostname() {
				return new URL(currentHref).hostname;
			},
		};
		globalThis.history = mockHistory;
		globalThis.document = {
			title: '(1) Home / X',
			querySelector: () => null,
			querySelectorAll: (sel) => (sel === 'article[data-testid="tweet"]' ? [mockTweetArticle] : []),
			addEventListener() {},
		};
		globalThis.performance = {getEntriesByType: () => perfEntries};
		globalThis.PerformanceObserver = class {
			observe() {}
		};
		globalThis.XMLHttpRequest = undefined;
		globalThis.setInterval = () => 1;

		installMediaSniffer();
		await mockWindow.fetch(genericMaster);
		await mockWindow.fetch(genericChild);
		await new Promise((r) => setTimeout(r, 15));

		const list = mockWindow.__fetchySniffer.list();
		// Only 1 X video (variants filtered) + 1 generic master (child playlist suppressed)
		assert.equal(list.length, 2);
		const xItem = list.find((i) => i.url === masterUrl);
		assert.ok(xItem, 'expected master X HLS entry');
		assert.equal(xItem.size, 0);
		assert.equal(xItem.title, 'Alice：Check out this demo clip!');
		assert.equal(
			xItem.poster,
			'https://pbs.twimg.com/amplify_video_thumb/198765432100/img/thumb.jpg',
		);
		assert.equal(xItem.pageUrl, 'https://x.com/alice/status/999888777');
		assert.equal(xItem.duration, 42);
		assert.equal(xItem.width, 1280);
		assert.equal(xItem.height, 720);

		const genItem = list.find((i) => i.url === genericMaster);
		assert.ok(genItem, 'expected generic master HLS entry');
		assert.equal(genItem.width, 1920);
		assert.equal(genItem.height, 1080);
		assert.equal(genItem.size, 0);

		// Navigating to another X SPA route clears old entries and does not resurrect old perf entries.
		mockHistory.pushState({}, '', '/i/bookmarks');
		assert.equal(mockWindow.__fetchySniffer.list().length, 0);
	} finally {
		Object.assign(globalThis, prev);
	}
});

test('captureArchivePage returns only viewport-visible tweets on X timeline with clean authors and content types', () => {
	const makeTweet = (id, author, body, rect, {hasVideo = false, hasImage = false} = {}) => ({
		getBoundingClientRect: () => rect,
		querySelector(sel) {
			if (sel === 'time') return {closest: () => ({href: `https://x.com/u/status/${id}`})};
			if (sel === '[data-testid="tweetText"]') return {innerText: body, textContent: body};
			if (sel === '[data-testid="User-Name"]') return {innerText: author, textContent: author};
			if (sel === 'video') return hasVideo ? {getAttribute: () => null, closest: () => null} : null;
			return null;
		},
		querySelectorAll(sel) {
			if (sel === 'video') return hasVideo ? [{closest: () => null}] : [];
			if (sel.includes('tweetPhoto'))
				return hasImage
					? [
							{
								tagName: 'IMG',
								currentSrc: 'https://pbs.twimg.com/media/abc.jpg',
								src: 'https://pbs.twimg.com/media/abc.jpg',
								getAttribute: () => '',
								closest: () => null,
							},
						]
					: [];
			return [];
		},
	});
	const visibleText = makeTweet(
		'1111111111111111111',
		'宝玉\n@dotey · 3h',
		'Sean Goedecke 在个人博客发文说',
		{top: 80, bottom: 420, height: 340},
	);
	const visibleImg = makeTweet(
		'2222222222222222222',
		'Alice\n@alice',
		'Photos from today',
		{top: 440, bottom: 780, height: 340},
		{hasImage: true},
	);
	const offscreenVideo = makeTweet(
		'3333333333333333333',
		'Bob\n@bob',
		'Preloaded offscreen video',
		{top: 1400, bottom: 1800, height: 400},
		{hasVideo: true},
	);
	const primary = {
		querySelector: () => null,
		querySelectorAll: (sel) =>
			sel === 'article[data-testid="tweet"]' ? [visibleText, visibleImg, offscreenVideo] : [],
	};
	const snap = vm.runInNewContext('(' + captureArchivePage.toString() + ')(false)', {
		URL,
		URLSearchParams,
		location: {href: 'https://x.com/home'},
		window: {innerWidth: 1200, innerHeight: 800},
		document: {
			querySelector: (sel) => (sel === '[data-testid="primaryColumn"]' ? primary : null),
			querySelectorAll: () => [],
		},
	});
	assert.equal(snap.type, 'feed');
	assert.equal(snap.items.length, 2);
	assert.equal(snap.items[0].id, '1111111111111111111');
	assert.equal(snap.items[0].author, '宝玉 @dotey');
	assert.equal(snap.items[0].mediaHint, 'text');
	assert.equal(snap.items[1].id, '2222222222222222222');
	assert.equal(snap.items[1].mediaHint, 'images');
});

test('X text and image+text posts publish Markdown files directly into outputDir', async (t) => {
	const {dir, origin} = await fixture(t, (_req, res) => {
		res.writeHead(200, {'content-type': 'image/gif'}).end(gif);
	});
	const outputDir = path.join(dir, 'Downloads', 'Fetchy');
	const bridge = new LibraryBridge(dir, {
		session: {cookieHeader: async () => '', withCookies: (_url, action) => action()},
		getOutputDir: async () => outputDir,
	});
	bridge.options.localOrigin = origin;

	const textPost = {
		platform: 'x',
		id: '9000000000000000001',
		title: 'AI 会员不要年付',
		author: 'Jackywine @Jackywine',
		sourceUrl: 'https://x.com/Jackywine/status/9000000000000000001',
		body: '因为模型迭代很快，建议按月订阅。',
		bodyComplete: true,
		attachments: [],
	};
	const imgPost = {
		platform: 'x',
		id: '9000000000000000002',
		title: 'X Photo Thread',
		author: 'Alice @alice',
		sourceUrl: 'https://x.com/alice/status/9000000000000000002',
		body: 'Look at these two shots.',
		bodyComplete: true,
		attachments: [
			{kind: 'image', url: origin + '/p1.gif'},
			{kind: 'image', url: origin + '/p2.gif'},
		],
	};

	await bridge.request('libraryStart', {
		manifest: {version: 1, items: [textPost, imgPost]},
	});
	await bridge.tail;

	const realOut = await realpath(outputDir);
	const mdPath = path.join(realOut, 'AI 会员不要年付.md');
	const mdContent = await readFile(mdPath, 'utf8');
	assert.match(mdContent, /# AI 会员不要年付/);
	assert.match(mdContent, /Jackywine @Jackywine/);
	assert.match(mdContent, /因为模型迭代很快/);

	const threadDir = path.join(realOut, 'X Photo Thread');
	const threadFiles = (await readdir(threadDir)).sort();
	assert.deepEqual(threadFiles, ['01.gif', '02.gif', 'X Photo Thread.md']);
	const threadMd = await readFile(path.join(threadDir, 'X Photo Thread.md'), 'utf8');
	assert.match(threadMd, /!\[图片 1\]\(\.\/01\.gif\)/);
	assert.match(threadMd, /!\[图片 2\]\(\.\/02\.gif\)/);

	const listed = await bridge.request('librarySearch', {});
	const rowText = listed.find((i) => i.key === 'x:9000000000000000001');
	assert.equal(rowText.primaryFile, mdPath);
});

test('captureArchivePage recognizes single video pages for Bilibili, YouTube, Douyin and TikTok', () => {
	// Bilibili multi-part video
	const biliSnap = vm.runInNewContext('(' + captureArchivePage.toString() + ')(false)', {
		URL,
		URLSearchParams,
		location: {href: 'https://www.bilibili.com/video/BV1xx411c7mD/?p=2'},
		window: {innerHeight: 900},
		document: {
			title: '深入理解浏览器架构_哔哩哔哩_bilibili',
			querySelector: (sel) => {
				if (sel.includes('h1.video-title')) return {innerText: '深入理解浏览器架构'};
				if (sel.includes('.up-name')) return {innerText: '技术UP主'};
				return null;
			},
			querySelectorAll: () => [],
		},
	});
	assert.equal(biliSnap.type, 'post');
	assert.equal(biliSnap.entry.platform, 'bilibili');
	assert.equal(biliSnap.entry.id, 'BV1xx411c7mD_p2');
	assert.equal(biliSnap.entry.kind, 'video');
	assert.equal(biliSnap.entry.sourceUrl, 'https://www.bilibili.com/video/BV1xx411c7mD/?p=2');
	assert.equal(biliSnap.entry.title, '深入理解浏览器架构');
	assert.equal(biliSnap.entry.author, '技术UP主');

	// YouTube watch & shorts
	const ytSnap = vm.runInNewContext('(' + captureArchivePage.toString() + ')(false)', {
		URL,
		URLSearchParams,
		location: {href: 'https://www.youtube.com/shorts/dQw4w9WgXcQ'},
		window: {innerHeight: 900},
		document: {
			title: '(2) Short Clip - YouTube',
			querySelector: (sel) => {
				if (sel.includes('ytd-reel-video-renderer[is-active] h2')) return {innerText: 'Short Clip'};
				if (sel.includes('#channel-name')) return {innerText: 'Creator'};
				return null;
			},
			querySelectorAll: () => [],
		},
	});
	assert.equal(ytSnap.type, 'post');
	assert.equal(ytSnap.entry.platform, 'youtube');
	assert.equal(ytSnap.entry.id, 'dQw4w9WgXcQ');
	assert.equal(ytSnap.entry.kind, 'video');
	assert.equal(ytSnap.entry.sourceUrl, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');

	// Douyin modal_id is excluded from collection route and captured as single video
	assert.equal(
		isCollectionRoute(new URL('https://www.douyin.com/user/self?modal_id=7345678901234567890')),
		false,
	);
	assert.equal(isCollectionRoute(new URL('https://www.douyin.com/user/self')), true);
	const dySnap = vm.runInNewContext('(' + captureArchivePage.toString() + ')(false)', {
		URL,
		URLSearchParams,
		location: {href: 'https://www.douyin.com/user/self?modal_id=7345678901234567890'},
		window: {innerHeight: 900},
		document: {
			title: '周末露营vlog - 抖音',
			querySelector: (sel) => {
				if (sel.includes('video-desc')) return {innerText: '周末露营vlog'};
				if (sel.includes('video-author-name')) return {innerText: '@阿明'};
				return null;
			},
			querySelectorAll: () => [],
		},
	});
	assert.equal(dySnap.type, 'post');
	assert.equal(dySnap.entry.platform, 'douyin');
	assert.equal(dySnap.entry.id, '7345678901234567890');
	assert.equal(dySnap.entry.kind, 'video');
	assert.equal(dySnap.entry.author, '阿明');

	// TikTok single video
	const tkSnap = vm.runInNewContext('(' + captureArchivePage.toString() + ')(false)', {
		URL,
		URLSearchParams,
		location: {href: 'https://www.tiktok.com/@chef/video/7345678901234567891'},
		window: {innerHeight: 900},
		document: {
			title: 'Quick ramen | TikTok',
			querySelector: (sel) => {
				if (sel.includes('browse-video-desc')) return {innerText: 'Quick ramen recipe'};
				return null;
			},
			querySelectorAll: () => [],
		},
	});
	assert.equal(tkSnap.type, 'post');
	assert.equal(tkSnap.entry.platform, 'tiktok');
	assert.equal(tkSnap.entry.id, '7345678901234567891');
	assert.equal(tkSnap.entry.kind, 'video');
	assert.equal(tkSnap.entry.author, '@chef');
});

test('captureArchivePage returns viewport-synced feed for Xiaohongshu explore, Douyin home, Threads feed and Zhihu question', () => {
	// Xiaohongshu /explore -> feed (viewport visible only, not collection)
	const mkXhsCard = (id, title, top, bottom) => ({
		getBoundingClientRect: () => ({top, bottom, left: 20, right: 240}),
		querySelectorAll: (sel) =>
			sel === 'a[href]' ? [{href: `https://www.xiaohongshu.com/explore/${id}?xsec_token=TOK`}] : [],
		querySelector: (sel) => {
			if (sel.includes('a.cover[href]'))
				return {href: `https://www.xiaohongshu.com/explore/${id}?xsec_token=TOK`};
			if (sel.includes('.title')) return {innerText: title};
			if (sel.includes('.name')) return {innerText: '作者A'};
			return null;
		},
	});
	const xhsVis = mkXhsCard('111111111111111111111111', '可见笔记', 120, 420);
	const xhsOff = mkXhsCard('222222222222222222222222', '屏外笔记', 1200, 1500);
	const xhsScope = {
		querySelectorAll: (sel) => (sel === '.note-item' ? [xhsVis, xhsOff] : []),
	};
	const xhsSnap = vm.runInNewContext('(' + captureArchivePage.toString() + ')(false)', {
		URL,
		URLSearchParams,
		location: {href: 'https://www.xiaohongshu.com/explore'},
		window: {innerHeight: 800},
		document: {
			title: '小红书 - 你的生活兴趣社区',
			querySelector: (sel) => {
				if (sel.includes('#exploreFeeds')) return xhsScope;
				return null;
			},
			querySelectorAll: () => [],
		},
	});
	assert.equal(xhsSnap.type, 'feed');
	assert.equal(xhsSnap.platform, 'xiaohongshu');
	assert.deepEqual(
		[...xhsSnap.items].map((i) => i.id),
		['111111111111111111111111'],
	);

	// Douyin home feed -> only viewport-active video, ignoring offscreen preloaded slides
	const dyActive = {
		tagName: 'DIV',
		getBoundingClientRect: () => ({top: 0, bottom: 800, left: 0, right: 1200}),
		getAttribute: (k) => (k === 'data-e2e-vid' ? '7345678901234567899' : null),
		querySelector: (sel) => {
			if (sel.includes('video-desc')) return {innerText: '当前正在看的抖音'};
			if (sel.includes('feed-video-nickname')) return {innerText: '@创作者'};
			return null;
		},
	};
	const dyOff = {
		tagName: 'DIV',
		getBoundingClientRect: () => ({top: 900, bottom: 1700, left: 0, right: 1200}),
		getAttribute: (k) => (k === 'data-e2e-vid' ? '7345678901234567800' : null),
		querySelector: () => null,
	};
	const dyFeedSnap = vm.runInNewContext('(' + captureArchivePage.toString() + ')(false)', {
		URL,
		URLSearchParams,
		location: {href: 'https://www.douyin.com/'},
		window: {innerHeight: 800},
		document: {
			title: '抖音',
			querySelector: () => null,
			querySelectorAll: (sel) => (sel.includes('feed-active-video') ? [dyActive, dyOff] : []),
		},
	});
	assert.equal(dyFeedSnap.type, 'feed');
	assert.equal(dyFeedSnap.platform, 'douyin');
	assert.deepEqual(
		[...dyFeedSnap.items].map((i) => i.id),
		['7345678901234567899'],
	);

	// Threads home feed -> viewport-synced feed
	const thCard = {
		contains: () => false,
		getBoundingClientRect: () => ({top: 80, bottom: 380, left: 0, right: 600}),
		querySelector: (sel) => {
			if (sel === '[data-testid="post-text"]') return {innerText: 'Threads 上的纯文字思考'};
			return null;
		},
		querySelectorAll: (sel) => {
			if (sel === 'a[href]')
				return [
					{
						href: 'https://www.threads.com/@builder/post/C9abc123',
						closest: () => thCard,
						querySelector: (s) => (s === 'time' ? {} : null),
					},
				];
			return [];
		},
	};
	const thSnap = vm.runInNewContext('(' + captureArchivePage.toString() + ')(false)', {
		URL,
		URLSearchParams,
		location: {href: 'https://www.threads.com/'},
		window: {innerHeight: 800},
		document: {
			title: 'Threads',
			querySelector: () => null,
			querySelectorAll: (sel) => (sel.includes('data-pressable-container') ? [thCard] : []),
		},
	});
	assert.equal(thSnap.type, 'feed');
	assert.equal(thSnap.platform, 'threads');
	assert.equal(thSnap.items.length, 1);
	assert.equal(thSnap.items[0].id, 'C9abc123');
	assert.equal(thSnap.items[0].mediaHint, 'text');

	// Zhihu question page -> viewport-synced answers
	const richNode = {
		childNodes: [{nodeType: 3, textContent: '这是一段完整的知乎回答内容。'}],
		querySelectorAll: () => [],
	};
	const zhCard = {
		getBoundingClientRect: () => ({top: 100, bottom: 500, left: 0, right: 700}),
		getAttribute: () => null,
		querySelector: (sel) => {
			if (sel === 'meta[itemprop="url"]')
				return {getAttribute: () => 'https://www.zhihu.com/question/555/answer/999'};
			if (sel.includes('.AuthorInfo-name')) return {innerText: '答主甲'};
			if (sel.includes('.RichContent-inner')) return richNode;
			return null;
		},
		querySelectorAll: () => [],
	};
	const zhSnap = vm.runInNewContext('(' + captureArchivePage.toString() + ')(false)', {
		URL,
		URLSearchParams,
		location: {href: 'https://www.zhihu.com/question/555'},
		window: {innerHeight: 800},
		document: {
			title: '如何评价某技术 - 知乎',
			querySelector: (sel) =>
				sel.includes('QuestionHeader-title') ? {innerText: '如何评价某技术'} : null,
			querySelectorAll: (sel) => (sel.includes('.AnswerItem') ? [zhCard] : []),
		},
	});
	assert.equal(zhSnap.type, 'feed');
	assert.equal(zhSnap.platform, 'zhihu');
	assert.equal(zhSnap.items.length, 1);
	assert.equal(zhSnap.items[0].id, '999');
	assert.equal(zhSnap.items[0].sourceUrl, 'https://www.zhihu.com/question/555/answer/999');
	assert.equal(zhSnap.items[0].bodyComplete, true);
});

test('media sniffer ignores batch-preloaded Douyin home feed JSON APIs', async () => {
	const mockWindow = {
		top: null,
		location: {href: 'https://www.douyin.com/', hostname: 'www.douyin.com'},
		addEventListener: () => {},
		fetch: async () => ({
			ok: true,
			url: 'https://www.douyin.com/aweme/v1/web/tab/feed/',
			headers: {
				get: (k) => (k.toLowerCase() === 'content-type' ? 'application/json' : ''),
			},
			clone() {
				return {
					text: async () =>
						JSON.stringify({
							aweme_list: [
								{
									desc: '未看过的预加载视频',
									video: {play_addr: {url_list: ['https://v26.douyinvod.com/preloaded/video.mp4']}},
								},
							],
						}),
				};
			},
		}),
	};
	mockWindow.top = mockWindow;
	vm.runInNewContext('(' + installMediaSniffer.toString() + ')()', {
		window: mockWindow,
		location: mockWindow.location,
		document: {title: '抖音', querySelectorAll: () => [], addEventListener: () => {}},
		performance: {getEntriesByType: () => []},
		URL,
		setInterval: () => 0,
	});
	await mockWindow.fetch('https://www.douyin.com/aweme/v1/web/tab/feed/');
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(mockWindow.__fetchySniffer.list().length, 0);
});

test('captureSocialPost does not flag non-carousel single-image posts as missing attachments', () => {
	const makeImg = () => ({
		tagName: 'IMG',
		currentSrc: 'https://scontent.cdninstagram.com/v/single.jpg',
		alt: 'Photo caption',
		naturalWidth: 1080,
		closest: () => null,
		getBoundingClientRect: () => ({x: 0, y: 0, width: 600, height: 600}),
		getAttribute: () => null,
	});
	const runWith = (hasCarousel) => {
		const postEl = {
			matches: () => true,
			querySelector: (sel) => {
				if (sel.includes('post-text')) return {innerText: 'Single photo post'};
				if (sel.includes('carousel') && hasCarousel) return {};
				return null;
			},
			querySelectorAll: (sel) => {
				if (sel === 'a[href]') return [{href: 'https://www.instagram.com/p/ABC123/'}];
				if (sel === 'img,video') return [makeImg()];
				return [];
			},
		};
		return vm.runInNewContext('(' + captureSocialPost.toString() + ')()', {
			URL,
			location: new URL('https://www.instagram.com/p/ABC123/'),
			document: {
				querySelector: (sel) => {
					if (sel === 'link[rel=canonical]') return {href: 'https://www.instagram.com/p/ABC123/'};
					if (sel === 'meta[property="og:description"]') return {content: 'Single photo post'};
					return null;
				},
				querySelectorAll: (sel) => (sel.includes('article') ? [postEl] : []),
			},
		});
	};
	const single = runWith(false);
	assert.equal(single.type, 'post');
	assert.equal(single.entry.missing.length, 0);
	const carousel = runWith(true);
	assert.equal(carousel.type, 'post');
	assert.ok(carousel.entry.missing.includes('original attachment count and quality unconfirmed'));
});
