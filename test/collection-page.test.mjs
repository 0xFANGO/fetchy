import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync} from 'node:fs';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import vm from 'node:vm';
import {runProcess} from '../src/process.mjs';
import {captureSocialCollection} from '../extension/collection-page.mjs';

const invoke = (href, document) =>
	vm.runInNewContext('(' + captureSocialCollection.toString() + ')()', {
		URL,
		location: {href},
		document,
	});
test('unrelated URLs cannot read a social collection', () => {
	for (const href of [
		'https://www.threads.com/',
		'https://example.com/saved',
		'https://www.douyin.com/follow',
		'https://www.instagram.com.evil.example/test/saved/',
		'https://www.instagram.com/test/',
		'https://user:pass@www.instagram.com/test/saved/',
		'https://www.instagram.com:8443/test/saved/',
	]) {
		assert.equal(invoke(href).type, 'unsupported', href);
	}
});
test('Instagram directory requires same-owner collection links and preserves its partial status', () => {
	const main = {closest: () => null, querySelectorAll: (sel) => (sel === 'a[href]' ? anchors : [])};
	const anchors = [
		'https://www.instagram.com/artist/saved/travel/123/?tracking=ignored',
		'https://www.instagram.com/artist/saved/travel/123/',
		'https://www.instagram.com/other/saved/travel/999/',
		'https://outside.example/artist/saved/travel/123/',
		'https://www.instagram.com/p/recommend/',
	].map((href) => ({href, innerText: 'Travel', closest: () => null}));
	const doc = {querySelectorAll: (sel) => (sel === 'main,[role=main]' ? [main] : [])};
	const result = invoke('https://www.instagram.com/artist/saved/', doc);
	assert.deepEqual(
		Array.from(result.folders, (f) => [f.id, f.name, f.url]),
		[['123', 'Travel', 'https://www.instagram.com/artist/saved/travel/123/']],
	);
	assert.equal(result.complete, false);
	assert.equal(result.total, null);
});
const chrome = [
	process.env.FETCHY_TEST_CHROME,
	'/usr/bin/google-chrome',
	'/usr/bin/chromium',
	'/usr/bin/chromium-browser',
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((file) => file && existsSync(file));
const link = (href, t = 'item') => '<a href="' + href + '">' + t + '</a>';
const ig = 'https://www.instagram.com/artist/saved/travel/123/';
const tt = 'https://www.tiktok.com/@artist';
const dy = 'https://www.douyin.com/user/self?showTab=favorite_collection';
const th = 'https://www.threads.com/saved';
const marker = (role, label, inside) =>
	'<div role="' + role + '" aria-label="' + label + '">' + inside + '</div>';
function douyin(mode, items, {active = true, owner = true} = {}) {
	const top =
		'<div role="tab" aria-selected="' +
		active +
		'" aria-controls="fav">收藏</div><div role="tabpanel" id="fav" data-e2e="user-favorite-tab"></div>';
	const tabs = ['视频', '作品', '合集', '收藏夹', '音乐']
		.map(
			(v) =>
				'<div role="tab" aria-selected="' + (v === mode) + '" aria-controls="sub">' + v + '</div>',
		)
		.join('');
	const nested =
		'<div><div><div role="tablist">' +
		tabs +
		'</div><div role="tabpanel" id="sub"></div></div><div>' +
		items +
		'</div></div>';
	return (
		(owner ? '<link rel="canonical" href="https://www.douyin.com/user/MS4wLjABexample">' : '') +
		top +
		nested
	);
}
const card = (author, id, quote = '') =>
	'<article>' + link('/@' + author + '/post/' + id, '<time>now</time>') + quote + '</article>';
const cases = [
	[
		ig,
		marker(
			'grid',
			'Travel',
			'<div role="status">2 saved posts</div>' + link('/p/one') + link('/p/two'),
		),
		{type: 'collection', id: '123', items: ['one', 'two'], complete: true},
	],
	[
		ig,
		marker('grid', 'Travel', '<div role="status">3 saved posts</div>' + link('/p/one')),
		{type: 'collection', id: '123', items: ['one'], complete: false},
	],
	[
		ig,
		'<form><input type="password"></form>' + marker('grid', 'Travel', link('/p/one')),
		{type: 'unsupported'},
	],
	[
		ig,
		marker(
			'grid',
			'Travel',
			link('/p/one/?sig=sensitive') +
				link('/reel/two/') +
				link('/p/one/') +
				link('https://wrong.example/p/not-this/'),
		) + marker('region', 'Suggested', link('/p/else/')),
		{
			type: 'collection',
			id: '123',
			items: ['one', 'two'],
			kinds: ['post', 'video'],
			complete: false,
		},
	],
	[
		ig,
		'<main><h1>Travel</h1><h2>Suggested</h2>' + link('/p/wrong/') + '</main>',
		{type: 'unsupported'},
	],
	[
		ig,
		marker('grid', 'Travel', '<p>No saved posts</p>'),
		{type: 'collection', id: '123', items: [], complete: true},
	],
	[
		tt,
		'<div role="tab" aria-selected="false" aria-controls="posts">Favorites</div><div role="tabpanel" id="posts">' +
			link('/@abc/video/9') +
			'</div>',
		{type: 'unsupported'},
	],
	[
		tt,
		'<div role="tab" aria-selected="true" aria-controls="saved">Favorites</div><div role="tabpanel" id="saved">' +
			link('/@abc/photo/12') +
			link('/@abc/video/13') +
			'</div><div role="tabpanel">' +
			link('/@abc/video/99') +
			'</div>',
		{type: 'collection', id: 'artist/favorites', items: ['12', '13'], kinds: ['post', 'video']},
	],
	[
		tt + '/collection/Field-notes-888',
		marker('list', 'Field notes', link('/@abc/video/13')),
		{type: 'collection', id: '888', items: ['13']},
	],
	[
		th,
		marker('feed', 'Saved', card('a', 'first', card('b', 'quoted'))) +
			marker('feed', 'For You', card('c', 'wrong')),
		{type: 'unsupported'},
	],
	[
		th,
		'<nav><a href="/@reader" aria-label="Profile">Me</a></nav>' +
			marker('feed', 'Saved', card('a', 'first', card('b', 'quoted'))) +
			marker('feed', 'For You', card('c', 'wrong')),
		{type: 'collection', id: 'reader/saved', items: ['first']},
	],
	[
		dy,
		douyin(
			'视频',
			'<div data-e2e="user-favorite-list">' +
				link('/video/11?tracking=private') +
				link('/note/22') +
				'</div>',
		) + link('/video/33'),
		{
			type: 'collection',
			id: 'MS4wLjABexample/favorites',
			items: ['11', '22'],
			kinds: ['video', 'post'],
		},
	],
	[
		dy,
		douyin('视频', '<div data-e2e="user-favorite-list">' + link('/video/11') + '</div>', {
			active: false,
		}),
		{type: 'unsupported'},
	],
	[dy, douyin('视频', link('/video/11'), {owner: false}), {type: 'unsupported'}],
	[dy, douyin('音乐', link('/video/11')), {type: 'unsupported'}],
	[
		dy,
		douyin('合集', link('/collection/123', 'Tour') + link('/mix/123', 'Tour') + link('/video/990')),
		{type: 'folders', folders: ['mix/123'], complete: false},
	],
	[dy, douyin('收藏夹', '<p>暂无收藏夹</p>'), {type: 'folders', folders: [], complete: true}],
	[
		dy,
		douyin('收藏夹', '<button>Travel</button>'),
		{type: 'folders', folders: [], complete: false},
	],
];

test(
	'rendered collection routes scope cards, tabs, ownership, empty states and partial lists',
	{skip: !chrome && 'Requires Chromium or FETCHY_TEST_CHROME'},
	async (t) => {
		const root = await mkdtemp(path.join(tmpdir(), 'fetchy-collection-dom-'));
		t.after(() => rm(root, {recursive: true, force: true}));
		const page = path.join(root, 'fixture.html');
		// Exercise the selectors in Chromium using local HTML and a simulated location.
		const driver =
			'const capture=(location)=>(' +
			captureSocialCollection.toString() +
			')();const results=[];' +
			'for(const [uri,html] of ' +
			JSON.stringify(cases.map(([uri, html]) => [uri, html])) +
			'){document.querySelector("base").href=new URL(uri).origin+"/";document.body.innerHTML=html;results.push(capture(new URL(uri)));}' +
			'document.body.replaceChildren();const data=document.createElement("pre");data.id="results";data.textContent=btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(results))));document.body.append(data);';
		await writeFile(
			page,
			'<!doctype html><meta charset="utf-8"><base><body><script>' + driver + '</script></body>',
		);
		const r = await runProcess(
			chrome,
			[
				'--headless',
				'--disable-gpu',
				'--disable-dev-shm-usage',
				'--disable-background-networking',
				'--no-first-run',
				...(process.platform === 'darwin' ? ['--use-mock-keychain', '--password-store=basic'] : []),
				'--user-data-dir=' + path.join(root, 'profile'),
				'--dump-dom',
				pathToFileURL(page).href,
			],
			{timeoutMs: 30000},
		);
		assert.equal(r.code, 0, r.stderr);
		const data = r.stdout.match(/<pre id="results">([A-Za-z0-9+/=]+)<\/pre>/)?.[1];
		assert.ok(data, 'browser returned fixture results');
		const results = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
		for (const [i, [uri, , expect]] of cases.entries()) {
			const actual = results[i];
			assert.equal(actual.type, expect.type, uri + ' fixture ' + i);
			if (expect.id) assert.equal(actual.folder.id, expect.id);
			if (expect.items)
				assert.deepEqual(
					actual.items.map((a) => a.id),
					expect.items,
				);
			if (expect.kinds)
				assert.deepEqual(
					actual.items.map((a) => a.kind),
					expect.kinds,
				);
			if (expect.folders)
				assert.deepEqual(
					actual.folders.map((a) => a.id),
					expect.folders,
				);
			if (expect.complete !== undefined) assert.equal(actual.complete, expect.complete, uri);
			assert.doesNotMatch(JSON.stringify(actual), /sig=sensitive|tracking=private/);
		}
	},
);
