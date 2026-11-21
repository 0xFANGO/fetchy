import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readdir, readFile} from 'node:fs/promises';
import {captureArchivePage, readBilibiliCollectionPage} from '../extension/capture-page.mjs';
import {submitArchive} from '../extension/archive-rpc.mjs';
import {extractPageMedia} from '../src/page-extract.mjs';
function invoke(func, args, globals) {
	const ctx = {URL, URLSearchParams, AbortSignal, ...globals, args};
	return vm.runInNewContext('(' + func.toString() + ')(...args)', ctx);
}
const id = '0123456789abcdef01234567',
	url = 'https://www.xiaohongshu.com/explore/' + id;
test('capture takes original images from exactly the requested note and retains missing slots', () => {
	const note = {
		noteId: id,
		title: 'Triptych',
		desc: 'full text',
		imageList: [
			{urlDefault: 'https://a.xhscdn.com/one'},
			{url: 'http://127.0.0.1/local'},
			{urlDefault: 'https://b.xhscdn.com/three'},
		],
	};
	const state = {
		location: {href: url + '?xsec_token=ephemeral'},
		window: {__INITIAL_STATE__: {note: {noteDetailMap: {[id]: {note}}}}},
	};
	const {entry} = invoke(captureArchivePage, [], state);
	assert.equal(entry.sourceUrl, url);
	assert.equal(entry.bodyComplete, true);
	assert.deepEqual(
		Array.from(entry.attachments, (a) => a.url || 'missing'),
		['https://a.xhscdn.com/one', 'missing', 'https://b.xhscdn.com/three'],
	);
	note.noteId = 'other';
	assert.equal(invoke(captureArchivePage, [], state).type, 'unsupported');
});
test('rednote notes and board cards keep their origin and use the Xiaohongshu identity', () => {
	const image = 'https://sns-web-i10.rednotecdn.com/cover';
	const note = {
		noteId: id,
		title: 'Rednote title',
		desc: 'Body',
		imageList: [{url: image}, {url: 'https://unverified.rednotecdn.com/other'}],
	};
	const window = {__INITIAL_STATE__: {note: {noteDetailMap: {[id]: {note}}}}};
	for (const origin of ['https://rednote.com', 'https://www.rednote.com']) {
		const canonical = origin + '/explore/' + id;
		const href = canonical + '?xsec_token=ephemeral';
		const {entry} = invoke(captureArchivePage, [], {location: {href}, window});
		assert.equal(entry.platform, 'xiaohongshu');
		assert.equal(entry.sourceUrl, canonical);
		assert.equal(entry.attachments[0].url, image);
		assert.equal(entry.attachments[1].missing, true);

		const card = {querySelectorAll: () => [{href}], querySelector: () => null};
		const board = invoke(captureArchivePage, [], {
			location: {href: origin + '/board/alpha'},
			document: {
				querySelector: () => null,
				querySelectorAll: (selector) => (selector === '.note-item' ? [card] : []),
			},
		});
		assert.equal(board.folder.platform, 'xiaohongshu');
		assert.equal(board.items[0].sourceUrl, canonical);
		assert.equal(board.items[0].visitUrl, href);
	}
	for (const host of ['fake.rednote.com', 'rednote.com.example']) {
		const result = invoke(captureArchivePage, [], {
			location: {href: 'https://' + host + '/explore/' + id},
			window,
			document: {querySelector: () => null},
		});
		assert.equal(result.type, 'unsupported');
	}
});
test('archive and video readers select the requested note from live Pinia or ref-wrapped SSR', () => {
	const ref = (value) => ({__v_isRef: true, value});
	const makeNote = (title) => ({
		title,
		noteId: id,
		type: 'video',
		video: {media: {stream: {h264: [{masterUrl: 'https://sns-v8.rednotecdn.com/n.mp4'}]}}},
	});
	const liveNote = makeNote('from navigation');
	const initial = {noteDetailMap: ref({[id]: {note: makeNote('from initial page')}})};
	const args = [{platform: 'xiaohongshu', expectedId: id}];
	const location = {href: 'https://www.rednote.com/explore/' + id};
	for (const [live, title] of [
		[{noteDetailMap: {[id]: {note: liveNote}}}, liveNote.title],
		[{noteDetailMap: {}}, 'from initial page'],
	]) {
		const app = {config: {globalProperties: {$pinia: {state: {value: {note: live}}}}}};
		const globals = {
			location,
			window: {__INITIAL_STATE__: {note: initial}},
			document: {
				querySelector: (selector) => (selector === '[data-v-app]' ? {__vue_app__: app} : null),
			},
		};
		assert.equal(invoke(captureArchivePage, [], globals).entry.title, title);
		assert.equal(invoke(extractPageMedia, args, globals).title, title);
	}
	for (const href of [
		'https://outside.rednote.com/explore/' + id,
		'https://www.rednote.com/explore/aaaaaaaaaaaaaaaaaaaaaaaa',
	]) {
		assert.throws(
			() =>
				invoke(extractPageMedia, args, {
					location: {href},
					window: {__INITIAL_STATE__: {note: initial}},
				}),
			{code: 'identity_mismatch'},
		);
	}
});
test('album discovery deduplicates repeated carousel cards and checks the active album tab count', () => {
	const origin = 'https://www.xiaohongshu.com',
		card = (id) => ({href: origin + '/board/' + id, querySelector: () => ({textContent: id})});
	const doc = {
		querySelectorAll: (sel) =>
			sel.startsWith('a.board')
				? [card('alpha'), card('beta'), card('alpha')]
				: [{textContent: '收藏'}, {textContent: '专辑・2'}],
	};
	const snap = invoke(captureArchivePage, [], {
		location: {href: origin + '/user/profile/012abc'},
		document: doc,
	});
	assert.equal(snap.type, 'folders');
	assert.equal(snap.complete, true);
	assert.equal(snap.total, 2);
	assert.deepEqual(
		Array.from(snap.folders, (x) => x.id),
		['alpha', 'beta'],
	);
});
test('official Bilibili requests are scoped to the active favorite page and account', async () => {
	const calls = [],
		f = (...args) => {
			calls.push(args);
			return {ok: true, json: () => ({code: 0, data: {count: 0, list: []}})};
		};
	const location = new URL('https://space.bilibili.com/123/favlist');
	assert.equal(
		(await invoke(readBilibiliCollectionPage, [null, 1, '456'], {location, fetch: f})).error,
		'identity_mismatch',
	);
	assert.equal(calls.length, 0);
	const folders = await invoke(readBilibiliCollectionPage, [null, 1, '123'], {location, fetch: f});
	assert.equal(folders.complete, true);
	assert.equal(calls.length, 1);
	assert.equal(new URL(calls[0][0]).hostname, 'api.bilibili.com');
	assert.equal(calls[0][1].credentials, 'include');
});
test('large UTF-8 manifests round-trip through bounded native chunks in order', async () => {
	const manifest = {version: 1, items: [{body: '彩色 📖'.repeat(100000)}]},
		chunks = [],
		selected = ['web:one'];
	let finished = false;
	const result = await submitArchive(manifest, selected, undefined, async (method, p) => {
		if (method === 'libraryUploadStart') return {uploadId: 'u'};
		assert.equal(p.uploadId, 'u');
		if (method === 'libraryUploadPart') {
			assert.equal(p.index, chunks.length);
			const data = Buffer.from(p.data, 'base64');
			assert.ok(data.length <= 192 * 1024);
			chunks.push(data);
			return;
		}
		assert.equal(method, 'libraryUploadFinish');
		assert.equal(p.count, chunks.length);
		finished = true;
		return {id: 'task'};
	});
	assert.equal(finished, true);
	assert.equal(result.id, 'task');
	assert.deepEqual(JSON.parse(Buffer.concat(chunks)), {manifest, selected});
});

test('runtime media discovery keeps relevant HTTPS files and manifests from the selected document', async () => {
	const {discoverArchiveMedia} = await import('../extension/capture-page.mjs');
	const urls = [
		'https://cdn.example/clip.m3u8?signature=temporary',
		'https://cdn.example/clip.mpd',
		'https://cdn.example/clip.mpd',
		'https://cdn.example/segment.m4s',
		'http://127.0.0.1/local.mp4',
		'https://user:secret@cdn.example/clip.mp4',
	];
	const capture = invoke(discoverArchiveMedia, [], {
		location: {href: 'https://example.org/read'},
		document: {querySelectorAll: () => []},
		performance: {getEntriesByType: () => urls.map((name) => ({name, initiatorType: 'fetch'}))},
	});
	assert.deepEqual(
		Array.from(capture.items, (x) => x.type),
		['HLS', 'DASH'],
	);
	assert.equal(capture.items[0].host, 'cdn.example');
	assert.equal(capture.page, 'https://example.org/read');
});

test('reading a virtualized collection starts at the top and moves through overlapping screens', async (t) => {
	const {advanceArchivePage} = await import('../extension/capture-page.mjs');
	const {readMore, startCollection, atEnd} = await import('../extension/archive-source.mjs');
	const folder = {id: 'album', platform: 'xiaohongshu'},
		calls = [];
	let offset = 4;
	const snapshot = () => ({
		type: 'collection',
		folder,
		total: 4,
		complete: false,
		items: [{platform: 'xiaohongshu', id: String([1, 1, 1, 1, 2, 3, 4][offset])}],
	});
	const realSetTimeout = setTimeout;
	t.mock.method(globalThis, 'setTimeout', (callback) => realSetTimeout(callback, 0));
	const previous = globalThis.chrome;
	globalThis.chrome = {
		tabs: {
			get: async () => ({url: 'https://www.xiaohongshu.com/board/album'}),
			create: () => assert.fail('reading never opens a tab'),
		},
		scripting: {
			async executeScript({func, args}) {
				if (func === advanceArchivePage) {
					const before = offset;
					if (args?.[0]) {
						calls.push('top');
						offset = 0;
					} else offset = Math.min(6, offset + 1);
					return [{result: {before: before * 100, position: offset * 100}}];
				}
				return [{result: snapshot()}];
			},
		},
	};
	t.after(() => {
		if (previous === undefined) delete globalThis.chrome;
		else globalThis.chrome = previous;
	});
	const collection = startCollection(snapshot());
	await readMore(1, collection, 'https://www.xiaohongshu.com', {fromTop: true});
	for (let i = 0; i < 20 && !atEnd(collection); i++)
		await readMore(1, collection, 'https://www.xiaohongshu.com');
	assert.deepEqual(calls, ['top']);
	assert.equal(collection.complete, true);
	assert.deepEqual([...collection.items.values()].map((x) => x.id).sort(), ['1', '2', '3', '4']);
});

test('a scrolled list that stops growing ends as unconfirmed instead of complete', async (t) => {
	const {readMore, startCollection, atEnd} = await import('../extension/archive-source.mjs');
	const folder = {id: 'f', platform: 'xiaohongshu'};
	const page = {type: 'collection', folder, total: 9, items: [{platform: 'xiaohongshu', id: 'a'}]};
	const realSetTimeout = setTimeout;
	t.mock.method(globalThis, 'setTimeout', (callback) => realSetTimeout(callback, 0));
	const previous = globalThis.chrome;
	globalThis.chrome = {
		tabs: {get: async () => ({url: 'https://www.xiaohongshu.com/board/f'})},
		scripting: {
			executeScript: async ({args}) => [{result: args?.length ? {before: 0, position: 0} : page}],
		},
	};
	t.after(() => (globalThis.chrome = previous));
	const collection = startCollection(page);
	for (let i = 0; i < 5 && !atEnd(collection); i++)
		await readMore(1, collection, 'https://www.xiaohongshu.com');
	assert.equal(collection.complete, false);
	assert.equal(collection.reason, 'end_unconfirmed');
});

test('a post page read for the native worker keeps only state scripts and meta tags', async () => {
	const {readPostPage} = await import('../extension/archive-source.mjs');
	const html =
		'<html><head><meta property="og:title" content="T"><script src="/app.js"></script></head>' +
		'<body>' +
		'x'.repeat(5000) +
		'<script>window.__INITIAL_STATE__={"note":1}</script><script>other()</script></body></html>';
	const fetch = async (url, init) => {
		assert.equal(init.credentials, 'include');
		return {ok: true, status: 200, url: url + '#final', text: async () => html};
	};
	const result = await invoke(readPostPage, ['https://www.xiaohongshu.com/explore/x', 100000], {
		fetch,
		TextEncoder,
		navigator: {userAgent: 'UA'},
		JSON,
	});
	assert.equal(
		result.html,
		'<meta property="og:title" content="T">\n<script>window.__INITIAL_STATE__={"note":1}</script>',
	);
	assert.equal(result.userAgent, 'UA');
	const small = await invoke(readPostPage, ['https://www.xiaohongshu.com/explore/x', 10], {
		fetch,
		TextEncoder,
		navigator: {userAgent: 'UA'},
		JSON,
	});
	assert.equal(small.error, 'too_large');
});

test('the extension opens no tab for reading or saving; only the help page uses tabs.create', async () => {
	const dir = new URL('../extension/', import.meta.url);
	const uses = [];
	for (const name of await readdir(dir)) {
		if (!name.endsWith('.mjs')) continue;
		const source = await readFile(new URL(name, dir), 'utf8');
		for (const line of source.split('\n'))
			if (/tabs\.create\s*\(/.test(line)) uses.push(name + ': ' + line.trim());
	}
	assert.deepEqual(uses, [
		"background.mjs: openHelp: () => chrome.tabs.create({url: chrome.runtime.getURL('help.html')}),",
	]);
});

test('the service worker imports everything statically; Chrome forbids import() there', async () => {
	const source = await readFile(new URL('../extension/background.mjs', import.meta.url), 'utf8');
	assert.doesNotMatch(source, /\bimport\s*\(/);
});
