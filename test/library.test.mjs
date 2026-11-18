import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {runProcess} from '../src/process.mjs';
import {tmpdir} from 'node:os';
import {mkdtemp, rm, writeFile, readFile, readdir} from 'node:fs/promises';
import {
	importLibrary,
	prepareLibraryTask,
	runLibraryTask,
	getLibraryTask,
	searchLibrary,
	exportLibrary,
	readBilibiliPage,
	discoverBilibiliFolders,
} from '../src/library/index.mjs';

const png =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/w8AAgMBgSeYB6kAAAAASUVORK5CYII=';
async function shortVideo(opts) {
	const f = path.join(path.dirname(opts.root), 'fixture.mp4');
	const r = await runProcess('ffmpeg', [
		'-v',
		'error',
		'-y',
		'-f',
		'lavfi',
		'-i',
		'color=size=16x16:rate=4',
		'-t',
		'0.5',
		'-c:v',
		'mpeg4',
		f,
	]);
	assert.equal(r.code, 0);
	return readFile(f);
}
const post = (id, extra = {}) => ({
	platform: 'x',
	id,
	sourceUrl: 'https://x.com/sample/status/' + id,
	title: 'Title ' + id,
	author: 'Author',
	body: 'Post ' + id,
	bodyComplete: true,
	...extra,
});
const manifest = (items) => ({version: 1, items});
const folder = (id, items) => ({id, name: 'Folder ' + id, platform: 'x', items});
async function setup(t) {
	const dir = await mkdtemp(path.join(tmpdir(), 'fetchy-library-test-'));
	t.after(() => rm(dir, {recursive: true, force: true}));
	return {root: path.join(dir, 'library')};
}
test('full backfill selects across pages, keeps all memberships and skips previously saved work', async (t) => {
	const opts = await setup(t);
	const image = {kind: 'image', mimeType: 'image/png', data: png};
	const full = {
		version: 1,
		folders: [
			{
				...folder('a'),
				total: 3,
				pages: [
					{
						cursor: null,
						nextCursor: 'older',
						items: [post('1', {attachments: [image]}), post('2')],
					},
					{cursor: 'older', nextCursor: null, items: [post('3')]},
				],
			},
			folder('b', [
				post('1', {attachments: [image], savedAt: '2026-01-01T00:00:00Z', topics: ['volcanoes']}),
			]),
		],
	};
	const selected = await importLibrary(full, {...opts, selected: ['x:1', 'x:3']});
	assert.deepEqual(selected.counts, {added: 2, skipped: 0, partial: 0, failed: 0, pending: 0});
	assert.equal(selected.folders[0].pagesRead, 2);
	assert.equal(selected.folders[0].complete, true);
	const [first] = await searchLibrary({folder: 'b', topic: 'volcanoes', query: 'Author'}, opts);
	assert.deepEqual(
		first.folders.map((f) => f.id),
		['a', 'b'],
	);
	assert.equal(first.folders[1].savedAt, '2026-01-01T00:00:00Z');
	assert.equal((await readdir(path.join(opts.root, 'media'))).length, 1);
	const all = await importLibrary(full, opts);
	assert.equal(all.counts.added, 1);
	assert.equal(all.counts.skipped, 2);
	const rerun = await importLibrary(full, opts);
	assert.equal(rerun.counts.skipped, 3);
	full.folders[1].items.push(post('4'));
	const later = await importLibrary(full, opts);
	assert.equal(later.counts.added, 1);
	assert.equal(later.counts.skipped, 3);
	const out = await exportLibrary({key: 'x:1'}, opts);
	assert.equal(out.items[0].savedAt, '2026-01-01T00:00:00Z');
	assert.ok(!('filepath' in out.items[0]));
	const importedInto = await setup(t);
	const reimport = await importLibrary(out, {...importedInto, sourceDir: opts.root});
	assert.equal(reimport.status, 'completed');
	assert.deepEqual((await searchLibrary({}, importedInto))[0].attachments, first.attachments);
});
test('original body, text-only posts, Markdown links, missing items and attachment order survive offline', async (t) => {
	const opts = await setup(t);
	const file = await importLibrary(
		manifest([
			post('11', {
				body: '# Beginning\n\nmiddle [original](https://example.org/post)\n\nend <unsafe>',
				bodyFormat: 'markdown',
				attachments: [
					{kind: 'image', mimeType: 'image/png', data: png, alt: 'First'},
					{kind: 'video', missing: true},
					{kind: 'image', mimeType: 'image/png', data: png, alt: 'Last'},
				],
				notes: 'personal',
				translation: 'translated',
			}),
			post('12'),
			post('13', {body: '', bodyComplete: false}),
		]),
		opts,
	);
	assert.equal(file.counts.partial, 2);
	assert.equal(file.counts.added, 1);
	const html = await readFile(file.items[0].filepath, 'utf8');
	for (const part of [
		'<h1>Beginning</h1>',
		'middle <a',
		'end &lt;unsafe&gt;',
		'Notes',
		'personal',
		'Translation',
	])
		assert.ok(html.includes(part));
	assert.ok(html.indexOf('alt="First"') < html.indexOf('Missing video'));
	assert.ok(html.indexOf('Missing video') < html.indexOf('alt="Last"'));
	const article = await importLibrary(
		manifest([
			post('11', {
				body: '# More complete',
				bodyFormat: 'markdown',
				attachments: [
					{kind: 'image', mimeType: 'image/png', data: png},
					{
						kind: 'video',
						mimeType: 'video/mp4',
						data: (await shortVideo(opts)).toString('base64'),
					},
					{kind: 'image', mimeType: 'image/png', data: png},
				],
			}),
		]),
		opts,
	);
	assert.equal(article.counts.added, 1);
	assert.equal((await searchLibrary({key: 'x:11'}, opts))[0].status, 'complete');
});
test('worker interruption resumes pending entries; failure-only retries and malformed entries do not erase successes', async (t) => {
	const opts = await setup(t);
	const signal = new AbortController();
	const task = await prepareLibraryTask(manifest([post('1'), post('2'), post('3')]), opts);
	await assert.rejects(
		runLibraryTask(task.id, {...opts, signal: signal.signal, onProgress: () => signal.abort()}),
		{name: 'AbortError'},
	);
	assert.equal((await getLibraryTask(task.id, opts)).status, 'interrupted');
	const result = await runLibraryTask(task.id, opts);
	assert.equal(result.counts.added, 3);
	const input = manifest([
		{...post('100'), kind: 'video', body: '', bodyComplete: false},
		post('5'),
		{},
	]);
	const failed = await importLibrary(input, {
		...opts,
		downloadVideo: async () => {
			throw Object.assign(new Error(), {code: 'network_error'});
		},
	});
	assert.equal(failed.counts.failed, 2);
	assert.equal(failed.counts.added, 1);
	let n = 0;
	const fixed = await runLibraryTask(failed.id, {
		...opts,
		retryFailed: true,
		downloadVideo: async (_url, options) => {
			n++;
			const filepath = path.join(options.outputDir, 'clip.mp4');
			await writeFile(filepath, await shortVideo(opts));
			return {platform: 'x', id: '100', filepath, title: 'new'};
		},
	});
	assert.equal(n, 1);
	assert.equal(fixed.counts.added, 2);
	assert.equal(fixed.counts.failed, 1);
});
test('separate task handles save the same video once; a preview-only manifest never reads arbitrary local paths', async (t) => {
	const opts = await setup(t);
	const src = manifest([{...post('10'), kind: 'video', body: ''}]);
	let calls = 0;
	const downloadVideo = async (_, options) => {
		calls++;
		await new Promise((r) => setTimeout(r, 40));
		const filepath = path.join(options.outputDir, 'x.mp4');
		await writeFile(filepath, await shortVideo(opts));
		return {id: '10', platform: 'x', filepath};
	};
	const [a, b] = await Promise.all([
		importLibrary(src, {...opts, downloadVideo}),
		importLibrary(src, {...opts, downloadVideo}),
	]);
	assert.equal(calls, 1);
	assert.equal(a.counts.skipped + b.counts.skipped, 1);
	const p = await importLibrary(
		manifest([
			post('6', {
				attachments: [
					{kind: 'image', path: '/outside.png'},
					{kind: 'image', path: '../outside.png'},
					{
						kind: 'image',
						mimeType: 'image/png',
						data: Buffer.from('this is not an image').toString('base64'),
					},
				],
			}),
		]),
		{...opts, sourceDir: opts.root},
	);
	assert.equal(p.counts.partial, 1);
});
test('duplicate offline cursor is marked partial; a Bilibili page failure resumes from the first unread page', async (t) => {
	const opts = await setup(t);
	const malformed = await importLibrary(
		{
			version: 1,
			folders: [
				{
					...folder('x'),
					pages: [
						{cursor: null, nextCursor: 'a', items: [post('a')]},
						{cursor: 'a', nextCursor: 'a', items: [post('b')]},
					],
				},
			],
		},
		opts,
	);
	assert.equal(malformed.folders[0].reason, 'incomplete_cursor');
	assert.equal(malformed.status, 'partial');
	const fav = {
		version: 1,
		folders: [{id: '123', platform: 'bilibili', source: {type: 'bilibili', id: '123'}}],
	};
	const calls = [];
	let allow = false;
	const fetchImpl = async (u) => {
		const n = Number(u.searchParams.get('pn'));
		calls.push(n);
		if (n === 2 && !allow) throw new Error('network');
		return Response.json({
			code: 0,
			data: {
				info: {id: 123, media_count: 2, title: 'Fav'},
				has_more: n === 1,
				medias: [
					{
						type: 2,
						bvid: n === 1 ? 'BV1TeJ96EE5t' : 'BV19Pnb6REhD',
						title: 'Video',
						fav_time: 1720000000,
					},
				],
			},
		});
	};
	const limited = await importLibrary(fav, {...opts, selected: [], fetchImpl});
	assert.equal(limited.status, 'partial');
	assert.equal(limited.folders[0].nextPage, 2);
	assert.deepEqual(calls, [1, 2]);
	allow = true;
	const ok = await runLibraryTask(limited.id, {...opts, fetchImpl});
	assert.equal(ok.status, 'completed');
	assert.deepEqual(calls, [1, 2, 2]);
	assert.equal(ok.folders[0].read, 2);
	const page = await readBilibiliPage('123', 2, {fetchImpl});
	assert.equal(page.items[0].savedAt, '2024-07-03T09:46:40.000Z');
});
test('Bilibili account discovery scopes cookies to its HTTPS API and reports partial list counts', async (t) => {
	const opts = await setup(t),
		file = path.join(path.dirname(opts.root), 'test-cookies.txt');
	await writeFile(
		file,
		'.bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\tfake-test\n.other.example\tTRUE\t/\tTRUE\t0\tprivate\twrong',
	);
	const result = await discoverBilibiliFolders({
		cookiesFile: file,
		fetchImpl: async (url, options) => {
			assert.equal(url.origin, 'https://api.bilibili.com');
			assert.equal(options.redirect, 'error');
			assert.equal(options.headers.Cookie, 'SESSDATA=fake-test');
			return Response.json({
				code: 0,
				data: url.pathname.endsWith('nav')
					? {mid: 55, isLogin: true}
					: {count: 2, list: [{id: 1, title: 'one', media_count: 4}]},
			});
		},
	});
	assert.equal(result.scope, 'created');
	assert.equal(result.complete, false);
	assert.equal(result.folders[0].id, '1');
});

test('different Bilibili parts have different archive identities, and absent selections stay visible', async (t) => {
	const opts = await setup(t),
		platform = 'bilibili',
		id = 'BV1TeJ96EE5t';
	const base = {
		platform,
		id,
		sourceUrl: 'https://www.bilibili.com/video/' + id + '/',
		body: 'part one',
		bodyComplete: true,
	};
	const result = await importLibrary(
		manifest([base, {...base, sourceUrl: base.sourceUrl + '?p=2', body: 'part two'}]),
		{...opts, selected: ['bilibili:' + id, 'bilibili:' + id + '_p2', 'bilibili:gone']},
	);
	assert.equal(result.counts.added, 2);
	assert.equal(result.counts.failed, 1);
	assert.equal(result.items.find((x) => x.key === 'bilibili:gone').reason, 'selection_missing');
	const rows = await searchLibrary({platform}, opts);
	assert.notEqual(rows[0].filepath, rows[1].filepath);
});

test('a standalone download fills its slot in a post and preserves the body and adjacent images in either import order', async (t) => {
	const mp4 = await shortVideo(await setup(t));
	const media = {kind: 'video', mimeType: 'video/mp4', data: mp4.toString('base64')};
	const first = {kind: 'image', mimeType: 'image/png', data: png, alt: 'First photo'};
	const last = {...first, alt: 'Last photo'};
	const original = post('655', {
		title: 'Original title',
		body: '# First\nMiddle\nLast',
		bodyFormat: 'markdown',
		attachments: [first, {kind: 'video', missing: true, alt: 'The clip'}, last],
		notes: 'My own notes',
		topics: ['research'],
	});
	const standalone = post('655', {
		kind: 'video',
		body: '',
		author: '',
		title: 'clip.mp4',
		bodyComplete: true,
		attachments: [media],
	});
	for (const inputs of [
		[original, standalone],
		[standalone, original],
	]) {
		const opts = await setup(t);
		for (const item of inputs) await importLibrary(manifest([item]), opts);
		for (const item of inputs) {
			const repeated = await importLibrary(manifest([item]), opts);
			assert.equal(repeated.counts.skipped, 1);
		}
		const [entry] = await searchLibrary({key: 'x:655'}, opts);
		assert.equal(entry.body, original.body);
		assert.equal(entry.bodyFormat, 'markdown');
		assert.equal(entry.title, original.title);
		assert.equal(entry.author, original.author);
		assert.equal(entry.notes, original.notes);
		assert.deepEqual(entry.topics, original.topics);
		assert.deepEqual(
			entry.attachments.map((a) => [a.kind, a.alt, !!a.path]),
			[
				['image', 'First photo', true],
				['video', 'The clip', true],
				['image', 'Last photo', true],
			],
		);
		assert.equal(entry.status, 'complete');
	}
});

test('a media-only refresh preserves missing original text and specific partial coverage', async (t) => {
	const opts = await setup(t);
	const data = (await shortVideo(opts)).toString('base64');
	const attachment = {kind: 'video', mimeType: 'video/mp4', data};
	await importLibrary(
		manifest([
			post('656', {
				body: 'Caption preview',
				bodyComplete: false,
				attachments: [{kind: 'video', missing: true}],
				missing: ['album coverage unknown'],
			}),
		]),
		opts,
	);
	const updated = await importLibrary(
		manifest([
			post('656', {kind: 'video', body: '', bodyComplete: true, attachments: [attachment]}),
		]),
		opts,
	);
	assert.equal(updated.counts.partial, 1);
	const [record] = await searchLibrary({key: 'x:656'}, opts);
	assert.equal(record.body, 'Caption preview');
	assert.equal(record.bodyComplete, false);
	assert.deepEqual(record.missing, ['album coverage unknown', 'full text']);
	const full = await importLibrary(
		manifest([
			post('656', {body: 'All original text', bodyComplete: true, attachments: [attachment]}),
		]),
		opts,
	);
	assert.equal(full.counts.added, 1);
	assert.deepEqual((await searchLibrary({key: 'x:656'}, opts))[0].missing, []);
});

test('retry selection only touches requested failed items and leaves completed rows alone', async (t) => {
	const opts = await setup(t);
	const selected = ['701', '702'].map((id) =>
		post(id, {kind: 'video', body: '', bodyComplete: false}),
	);
	const failed = await importLibrary(manifest([...selected, post('703')]), {
		...opts,
		downloadVideo: async () => {
			throw Object.assign(new Error(), {code: 'unavailable'});
		},
	});
	const attempted = [];
	const fixture = await shortVideo(opts);
	const downloadVideo = async (url, {outputDir}) => {
		const id = new URL(url).pathname.split('/').pop();
		attempted.push(id);
		const filepath = path.join(outputDir, 'fixture.mp4');
		await writeFile(filepath, fixture);
		return {id, platform: 'x', filepath};
	};
	await assert.rejects(runLibraryTask(failed.id, {...opts, retryFailed: true, selected: 'x:701'}), {
		code: 'invalid_options',
	});
	const one = await runLibraryTask(failed.id, {
		...opts,
		retryFailed: true,
		selected: ['x:702', 'x:703'],
		downloadVideo,
	});
	assert.deepEqual(attempted, ['702']);
	assert.deepEqual(one.counts, {added: 2, skipped: 0, partial: 0, failed: 1, pending: 0});
	assert.equal(one.items.find((x) => x.key === 'x:701').reason, 'unavailable');
	await runLibraryTask(failed.id, {...opts, retryFailed: true, selected: [], downloadVideo});
	assert.deepEqual(attempted, ['702']);
	const rest = await runLibraryTask(failed.id, {...opts, retryFailed: true, downloadVideo});
	assert.equal(rest.counts.failed, 0);
	assert.deepEqual(attempted, ['702', '701']);
});
