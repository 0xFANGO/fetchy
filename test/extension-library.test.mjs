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
