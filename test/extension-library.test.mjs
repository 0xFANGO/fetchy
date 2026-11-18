import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {
	captureArchivePage,
	hydrateArchiveEntry,
	readBilibiliCollectionPage,
} from '../extension/capture-page.mjs';
import {submitArchive} from '../extension/archive-rpc.mjs';
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
test('untrusted attachment URLs cannot trigger page fetches even on the original note', async () => {
	const entry = {
		platform: 'xiaohongshu',
		id,
		sourceUrl: url,
		attachments: [
			{kind: 'image', url: 'https://a.xhscdn.com/unlisted'},
			{kind: 'image', url: 'http://127.0.0.1/'},
		],
	};
	const calls = [];
	const globals = {
		location: {href: url},
		window: {
			__INITIAL_STATE__: {
				note: {
					noteDetailMap: {
						[id]: {note: {noteId: id, imageList: [{urlDefault: 'https://a.xhscdn.com/allowed'}]}},
					},
				},
			},
		},
		fetch: (u) => calls.push(u),
	};
	const out = await invoke(hydrateArchiveEntry, [entry], globals);
	assert.equal(out.attachments.length, 2);
	assert.equal(calls.length, 0);
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

test('one transfer keeps every selected row while replacing excess inline media with original URLs', async () => {
	const {ArchiveTransfer, manifestFolder} = await import('../extension/archive-transfer.mjs');
	const one = (id) => ({
		platform: 'x',
		id,
		title: 'item ' + id,
		sourceUrl: 'https://x.com/archive/status/' + id,
		attachments: [],
	});
	const rows = ['1', '2', '3'].map(one),
		group = {
			folder: {id: 'fav', platform: 'x', name: 'F'},
			pages: [rows],
			items: rows,
			total: 3,
			complete: true,
		};
	const chosen = rows.map((i) => 'x:' + i.id);
	const budget = new ArchiveTransfer([group], chosen, {wireLimit: 2500, inlineLimit: 600});
	const entries = new Map();
	for (const row of rows) {
		const url = 'https://example.org/' + row.id + '.png',
			original = {...row, body: '原文', attachments: [{kind: 'image', url}]};
		const filled = {
			...original,
			attachments: [{kind: 'image', data: 'A'.repeat(600), mimeType: 'image/png'}],
		};
		entries.set('x:' + row.id, budget.record(row, original, filled));
	}
	const output = manifestFolder(group, entries).pages[0].items;
	assert.equal(output.length, 3);
	assert.ok(output[0].attachments[0].data);
	assert.equal(output[1].attachments[0].url, 'https://example.org/2.png');
	assert.equal(output[2].attachments[0].url, 'https://example.org/3.png');
	assert.equal(budget.urlCount, 2);
	assert.equal(budget.missingCount, 0);
	assert.ok(output.every((v) => v.body === '原文'));
});

test('late text reclaims inline media space, and data-only slots report missing explicitly', async () => {
	const {ArchiveTransfer} = await import('../extension/archive-transfer.mjs');
	const first = {
		platform: 'x',
		id: '1',
		body: '',
		attachments: [{kind: 'image', url: 'https://example.org/one'}],
	};
	const second = {platform: 'x', id: '2', body: 'b'.repeat(600), attachments: []};
	const q = new ArchiveTransfer([], undefined, {wireLimit: 1200, inlineLimit: 1000});
	const original = q.record({}, first, {
		...first,
		attachments: [{kind: 'image', data: 'A'.repeat(650)}],
	});
	q.record({}, second, second);
	assert.equal(original.attachments[0].url, first.attachments[0].url);
	assert.equal(q.urlCount, 1);
	const noUrl = {platform: 'x', id: '3', attachments: [{kind: 'image', data: 'A'.repeat(2000)}]};
	assert.equal(q.record({}, noUrl, noUrl).attachments[0].missing, true);
	assert.equal(q.missingCount, 1);
});

test('virtualized collections return to the top and keep moving through overlapping viewports', async (t) => {
	const {advanceArchivePage} = await import('../extension/capture-page.mjs');
	const {collectArchivePages} = await import('../extension/archive-source.mjs');
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
	const original = snapshot();
	const realSetTimeout = setTimeout;
	t.mock.method(globalThis, 'setTimeout', (callback) => realSetTimeout(callback, 0));
	const mockChrome = {
		tabs: {get: async () => ({url: 'https://www.xiaohongshu.com/board/album'})},
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
	const previous = globalThis.chrome;
	globalThis.chrome = mockChrome;
	t.after(() => {
		if (previous === undefined) delete globalThis.chrome;
		else globalThis.chrome = previous;
	});
	const result = await collectArchivePages(1, 'https://www.xiaohongshu.com', original);
	assert.deepEqual(calls, ['top']);
	assert.equal(result.complete, true);
	assert.deepEqual(
		result.items.map((x) => x.id),
		['1', '2', '3', '4'],
	);
});
