import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {LibraryBridge} from '../native/library-bridge.mjs';
import {searchLibrary} from '../src/library/index.mjs';
import {fetchPostPage, looseJson, parsePostPage} from '../src/library/post-pages.mjs';
import {downloadAttachment} from '../src/library/content.mjs';
import {knownHost, openWeb, publicAddress, withoutCredentials} from '../src/public-http.mjs';

const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
const ids = ['a'.repeat(24), 'b'.repeat(24), 'c'.repeat(24)];

function xhsPage(id, {images = [], desc = 'Full text ' + id} = {}) {
	const state = `{"note":{"noteDetailMap":{"${id}":{"note":{"noteId":"${id}","type":"normal","title":"Title ${id}","desc":${JSON.stringify(desc)},"user":{"nickname":"Author"},"imageList":[${images
		.map((u) => `{"urlDefault":"${u}","livePhoto":undefined}`)
		.join(',')}]}}}},"user":undefined}`;
	return `<html><body><script>window.__INITIAL_STATE__=${state}</script></body></html>`;
}
const listing = (id) => ({
	platform: 'xiaohongshu',
	id,
	sourceUrl: 'https://www.xiaohongshu.com/explore/' + id,
	visitUrl: 'https://www.xiaohongshu.com/explore/' + id + '?xsec_token=viewer-secret',
	title: 'Card ' + id,
});
async function fixture(t, handle) {
	const dir = await mkdtemp(path.join(tmpdir(), 'fy-batch-'));
	const http = createServer(handle);
	await new Promise((res) => http.listen(0, '127.0.0.1', res));
	t.after(async () => {
		http.closeAllConnections();
		await new Promise((r) => http.close(r));
		await rm(dir, {recursive: true, force: true});
	});
	return {dir, origin: 'http://127.0.0.1:' + http.address().port};
}

test('loose JSON keeps the word undefined inside strings', () => {
	assert.deepEqual(looseJson('{"a":undefined,"b":"undefined value","c":[undefined]}'), {
		a: null,
		b: 'undefined value',
		c: [null],
	});
});

test('a Xiaohongshu page yields text and ordered media from its initial state', () => {
	const id = ids[0];
	const entry = parsePostPage(
		{platform: 'xiaohongshu', id, sourceUrl: 'https://www.xiaohongshu.com/explore/' + id},
		xhsPage(id, {images: ['https://sns-img.xhscdn.com/1', 'https://evil.example/2']}),
		'https://www.xiaohongshu.com/explore/' + id,
	);
	assert.equal(entry.body, 'Full text ' + id);
	assert.equal(entry.bodyComplete, true);
	assert.equal(entry.author, 'Author');
	assert.deepEqual(
		entry.attachments.map((a) => a.url ?? 'missing'),
		['https://sns-img.xhscdn.com/1', 'missing'],
	);
});

test('a page for another note, a login wall and a captcha have distinct codes', () => {
	const item = {platform: 'xiaohongshu', id: ids[1], sourceUrl: 'https://www.xiaohongshu.com/'};
	assert.throws(
		() => parsePostPage(item, xhsPage(ids[0]), 'https://www.xiaohongshu.com/explore/x'),
		{
			code: 'source_unavailable',
		},
	);
	assert.throws(
		() => parsePostPage(item, '<html></html>', 'https://www.xiaohongshu.com/website-login/captcha'),
		{code: 'verification_required'},
	);
	assert.throws(() => parsePostPage(item, '<html></html>', 'https://www.xiaohongshu.com/login'), {
		code: 'login_required',
	});
});

test('a Zhihu answer page yields its text and images', () => {
	const data = {
		initialState: {
			entities: {
				answers: {
					42: {
						id: 42,
						content:
							'<p>First &amp; second</p><figure><img data-original="https://pic1.zhimg.com/v2-a.jpg"></figure><p>Third</p>',
						author: {name: 'Writer'},
						question: {title: 'A question'},
					},
				},
			},
		},
	};
	const entry = parsePostPage(
		{platform: 'zhihu', id: '42', sourceUrl: 'https://www.zhihu.com/question/1/answer/42'},
		`<script id="js-initialData" type="text/json">${JSON.stringify(data)}</script>`,
		'https://www.zhihu.com/question/1/answer/42',
	);
	assert.equal(entry.title, 'A question');
	assert.equal(entry.body, 'First & second\n\nThird');
	assert.deepEqual(
		entry.attachments.map((a) => a.url),
		['https://pic1.zhimg.com/v2-a.jpg'],
	);
});

test('other sites fall back to an OpenGraph preview marked incomplete', () => {
	const entry = parsePostPage(
		{platform: 'threads', id: 'p1', sourceUrl: 'https://www.threads.com/@a/post/p1'},
		'<meta property="og:title" content="Post"><meta property="og:image" content="https://cdn.example/i.jpg">',
		'https://www.threads.com/@a/post/p1',
	);
	assert.equal(entry.bodyComplete, false);
	assert.equal(entry.coverage, 'preview');
	assert.equal(entry.attachments[0].url, 'https://cdn.example/i.jpg');
});

test('a fake-IP proxy answer is accepted only for supported sites and their media hosts', async () => {
	assert.equal(publicAddress({address: '198.18.0.5', family: 4}, true), true);
	assert.equal(publicAddress({address: '198.18.0.5', family: 4}, false), false);
	assert.equal(publicAddress({address: '192.168.1.2', family: 4}, true), false);
	assert.equal(knownHost('sns-img-qc.xhscdn.com'), true);
	assert.equal(knownHost('www.bilibili.com'), true);
	assert.equal(knownHost('192-168-1-1.nip.io'), false);
	assert.equal(knownHost('evil-xhscdn.com'), false);
	await assert.rejects(openWeb('https://198.18.0.5/a'), {code: 'invalid_url'});
});

test('a sign-in cookie follows a same-origin redirect and is dropped for any other origin', async (t) => {
	const seen = [];
	const {origin} = await fixture(t, (req, res) => {
		seen.push(req.headers.cookie);
		if (req.url === '/same') return res.writeHead(302, {location: '/next'}).end();
		res.writeHead(200).end('ok');
	});
	const {response} = await openWeb(origin + '/same', {
		localOrigin: origin,
		headers: {cookie: 'web_session=secret'},
	});
	response.destroy();
	assert.deepEqual(seen, ['web_session=secret', 'web_session=secret']);
	assert.deepEqual(
		withoutCredentials({
			Cookie: 'a=1',
			authorization: 'x',
			referer: 'https://www.xiaohongshu.com/',
		}),
		{referer: 'https://www.xiaohongshu.com/'},
	);
});

test('a post page that never answers times out instead of holding the queue', async (t) => {
	const {origin} = await fixture(t, () => {});
	const started = Date.now();
	await assert.rejects(
		fetchPostPage(
			{platform: 'xiaohongshu', id: ids[0], sourceUrl: origin + '/explore/' + ids[0]},
			{url: origin + '/explore/' + ids[0], localOrigin: origin, timeoutMs: 200},
		),
		{code: 'timeout'},
	);
	assert.ok(Date.now() - started < 5000);
});

test('a bare row merged with a full copy of the same post keeps the full text', async (t) => {
	const {dir} = await fixture(t, (_req, res) => res.writeHead(404).end());
	let reads = 0;
	const bridge = new LibraryBridge(dir, {
		session: {cookieHeader: async () => '', withCookies: (_url, action) => action()},
	});
	bridge.readDetails = async () => {
		reads++;
		return {title: '', body: '', attachments: []};
	};
	const full = {...listing(ids[0]), body: 'The full text', bodyComplete: true, visitUrl: undefined};
	const bare = {...listing(ids[0]), visitUrl: undefined};
	const task = await bridge.request('libraryStart', {
		manifest: {
			version: 1,
			folders: [
				{platform: 'xiaohongshu', id: 'a', items: [full]},
				{platform: 'xiaohongshu', id: 'b', items: [bare]},
			],
		},
	});
	await bridge.tail;
	assert.equal(reads, 0);
	const [saved] = await searchLibrary({key: 'xiaohongshu:' + ids[0]}, bridge.options);
	assert.equal(saved.body, 'The full text');
	assert.equal((await bridge.request('libraryTask', {id: task.id})).items[0].status, 'added');
});

test('a retry in the same session fetches listing media again; feeds after the task ended are dropped', async (t) => {
	let up = false;
	const {dir, origin} = await fixture(t, (_req, res) => {
		if (!up) return res.writeHead(404).end();
		res.writeHead(200, {'content-type': 'image/gif'}).end(gif);
	});
	const bridge = new LibraryBridge(dir, {
		session: {cookieHeader: async () => '', withCookies: (_url, action) => action()},
	});
	bridge.options.localOrigin = origin;
	const entry = {
		platform: 'x',
		id: '123',
		sourceUrl: 'https://x.com/a/status/123',
		body: 'hello',
		bodyComplete: true,
		attachments: [{kind: 'image', url: origin + '/one.gif'}],
	};
	const task = await bridge.request('libraryStart', {manifest: {version: 1, items: [entry]}});
	await bridge.tail;
	let done = await bridge.request('libraryTask', {id: task.id, problems: true});
	assert.deepEqual(
		done.items.map((i) => [i.status, i.reason]),
		[['partial', 'network_error']],
	);
	assert.deepEqual(await bridge.request('libraryPage', {id: task.id, key: 'x:123', skip: true}), {
		ok: true,
		skipped: true,
	});
	assert.equal(bridge.pages.size, 0);
	up = true;
	const queued = await bridge.request('libraryRetry', {id: task.id, selected: ['x:123']});
	assert.equal(queued.status, 'queued');
	await assert.rejects(bridge.request('libraryRetry', {id: task.id}), {code: 'busy'});
	await bridge.tail;
	done = await bridge.request('libraryTask', {id: task.id});
	assert.equal(done.items[0].status, 'added');
	assert.equal((await bridge.request('libraryTask', {id: task.id, problems: true})).totalItems, 0);
});

test('attachment downloads retry a transient failure and recognise a mislabelled type', async (t) => {
	let calls = 0;
	const {dir, origin} = await fixture(t, (req, res) => {
		calls++;
		if (calls === 1) return res.writeHead(503).end();
		res.writeHead(200, {'content-type': 'application/octet-stream'}).end(gif);
	});
	const file = await downloadAttachment(path.join(dir, 'lib'), origin + '/img', 'image', {
		localOrigin: origin,
		backoffMs: 1,
	});
	assert.match(file, /^media[/\\][a-f0-9]{64}\.gif$/);
	assert.equal(calls, 2);
});

test(
	'saving selected cards creates the task at once, uses pages read by the extension and downloads media natively',
	{timeout: 15000},
	async (t) => {
		const seen = [];
		const {dir, origin} = await fixture(t, (req, res) => {
			seen.push({path: req.url, referer: req.headers.referer, cookie: req.headers.cookie});
			if (req.url === '/missing.gif') return res.writeHead(404).end();
			if (req.url.startsWith('/explore/')) return res.writeHead(403).end();
			res.writeHead(200, {'content-type': 'image/gif'}).end(gif);
		});
		const bridge = new LibraryBridge(dir, {
			session: {cookieHeader: async () => '', withCookies: (_url, action) => action()},
		});
		bridge.options.localOrigin = origin;
		const items = ids.map(listing);
		items[2].visitUrl = origin + '/explore/' + ids[2];
		const task = await bridge.request('libraryStart', {
			manifest: {version: 1, folders: [{platform: 'xiaohongshu', id: 'saved', items}]},
			feed: true,
		});
		assert.equal(task.status, 'queued');
		// No page has been read yet; the task already lists every selected entry.
		assert.equal((await bridge.request('libraryTask', {id: task.id})).totalItems, 3);
		const fed = await bridge.request('libraryPage', {
			id: task.id,
			key: 'xiaohongshu:' + ids[0],
			url: items[0].visitUrl,
			html: xhsPage(ids[0], {images: [origin + '/one.gif', origin + '/two.gif']}),
			userAgent: 'TestBrowser/1',
		});
		assert.deepEqual(fed, {ok: true, title: 'Title ' + ids[0], bodyComplete: true, attachments: 2});
		await bridge.request('libraryPage', {
			id: task.id,
			key: 'xiaohongshu:' + ids[1],
			url: items[1].visitUrl,
			html: xhsPage(ids[1], {images: [origin + '/one.gif', origin + '/missing.gif']}),
		});
		// The extension could not read this one; the native worker tries the page itself.
		await bridge.request('libraryPage', {id: task.id, key: 'xiaohongshu:' + ids[2], skip: true});
		await bridge.request('libraryFeed', {id: task.id, active: false});
		await bridge.tail;
		const done = await bridge.request('libraryTask', {id: task.id});
		assert.deepEqual(
			done.items.map((i) => [i.status, i.reason]),
			[
				['added', null],
				['partial', 'network_error'],
				// Unreadable post: its listing title and link are kept, with the reason.
				['partial', 'login_required'],
			],
		);
		const [first] = await searchLibrary({key: 'xiaohongshu:' + ids[0]}, bridge.options);
		assert.equal(first.body, 'Full text ' + ids[0]);
		assert.equal(first.attachments.filter((a) => a.path).length, 2);
		const [second] = await searchLibrary({key: 'xiaohongshu:' + ids[1]}, bridge.options);
		assert.deepEqual(
			second.attachments.map((a) => a.error ?? 'saved'),
			['saved', 'network_error'],
		);
		const media = seen.filter((r) => r.path.endsWith('.gif'));
		assert.ok(media.every((r) => r.referer === 'https://www.xiaohongshu.com/' && !r.cookie));
		assert.ok(!JSON.stringify(await searchLibrary({}, bridge.options)).includes('viewer-secret'));
	},
);

test('a retry reads a partial entry again and fills its missing file', async (t) => {
	let broken = true;
	const {dir, origin} = await fixture(t, (req, res) => {
		if (req.url.startsWith('/explore/'))
			return res
				.writeHead(200, {'content-type': 'text/html'})
				.end(xhsPage(ids[0], {images: [origin + '/one.gif']}));
		if (broken) return res.writeHead(403).end();
		res.writeHead(200, {'content-type': 'image/gif'}).end(gif);
	});
	const cookies = [];
	const bridge = new LibraryBridge(dir, {
		session: {
			cookieHeader: async (url) => {
				cookies.push(url);
				return 'web_session=s';
			},
			withCookies: (_url, action) => action(),
		},
	});
	bridge.options.localOrigin = origin;
	const item = {...listing(ids[0]), visitUrl: origin + '/explore/' + ids[0]};
	const task = await bridge.request('libraryStart', {manifest: {version: 1, items: [item]}});
	await bridge.tail;
	let done = await bridge.request('libraryTask', {id: task.id});
	assert.deepEqual([done.items[0].status, done.items[0].reason], ['partial', 'auth_required']);
	broken = false;
	await bridge.request('libraryRetry', {id: task.id, selected: ['xiaohongshu:' + ids[0]]});
	await bridge.tail;
	done = await bridge.request('libraryTask', {id: task.id});
	assert.equal(done.items[0].status, 'added');
	assert.deepEqual(cookies, [item.visitUrl, item.visitUrl]);
});

test('a retry that never starts leaves the task resumable instead of stuck as queued', async (t) => {
	const {dir} = await fixture(t, (_req, res) => res.writeHead(404).end());
	const bridge = new LibraryBridge(dir, {
		session: {cookieHeader: async () => '', withCookies: (_url, action) => action()},
	});
	const entry = {
		platform: 'x',
		id: '9',
		sourceUrl: 'https://x.com/a/status/9',
		body: 'b',
		bodyComplete: true,
	};
	const task = await bridge.request('libraryStart', {manifest: {version: 1, items: [entry]}});
	await bridge.tail;
	bridge.run = async () => {
		throw new Error('worker could not start');
	};
	await bridge.request('libraryRetry', {id: task.id});
	await bridge.tail;
	assert.equal((await bridge.request('libraryTask', {id: task.id})).status, 'interrupted');
	const failed = await bridge.request('libraryTask', {id: task.id, problems: 'failed'});
	assert.equal(failed.totalItems, 0);
});
