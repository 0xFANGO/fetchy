import test from 'node:test';
import assert from 'node:assert/strict';
import {access, mkdtemp, readFile, rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';

const dir = await mkdtemp(path.join(tmpdir(), 'fy-accounts-'));
process.env.FETCHY_DATA_DIR = dir;
const accounts = await import('../bin/accounts.mjs');
test.after(() => rm(dir, {recursive: true, force: true}));

const later = Date.now() / 1000 + 3600;
const session = (value) => [
	{name: 'SESSDATA', value, domain: '.bilibili.com', path: '/', secure: true, expires: later},
	{name: 'buvid3', value: 'device', domain: '.bilibili.com', path: '/', secure: false},
];

test('a site is signed in only while its session cookie is present and accepted', async () => {
	const bilibili = await accounts.findAccount('bilibili');
	let jar = [];
	const readCookies = async () => jar;
	assert.equal((await accounts.accountStatus(bilibili, {readCookies})).status, 'logged_out');
	jar = [session('one')[1]];
	assert.equal((await accounts.accountStatus(bilibili, {readCookies})).status, 'logged_out');
	jar = session('one');
	assert.equal((await accounts.accountStatus(bilibili, {readCookies})).status, 'logged_in');
	await accounts.markExpired(bilibili, {readCookies});
	assert.equal((await accounts.accountStatus(bilibili, {readCookies})).status, 'expired');
	jar = session('two');
	assert.equal((await accounts.accountStatus(bilibili, {readCookies})).status, 'logged_in');
	jar = [];
	assert.equal((await accounts.accountStatus(bilibili, {readCookies})).status, 'expired');
	await accounts.forgetAccount(bilibili);
	assert.equal((await accounts.accountStatus(bilibili, {readCookies})).status, 'logged_out');
});

test('a site is found by name, label or any of its links', async () => {
	const byName = await accounts.findAccount('bilibili');
	assert.equal((await accounts.findAccount('B站')).profile, byName.profile);
	assert.equal(
		(await accounts.findAccount('https://m.bilibili.com/video/BV1xx411c7mD')).profile,
		byName.profile,
	);
	assert.notEqual((await accounts.findAccount('youtube')).profile, byName.profile);
	await assert.rejects(accounts.findAccount('not a site'), {code: 'invalid_url'});
});

test('custom sites are listed after the built-in ones', async () => {
	await accounts.addAccount('https://forum.example.org/thread/1');
	const list = await accounts.listAccounts({readCookies: async () => []});
	assert.equal(list.at(-1).site, 'forum.example.org');
	assert.equal(list.at(-1).verified, false);
	assert.ok(list.some((row) => row.site === 'xiaohongshu' && row.verified));
});

test('a request carries only cookies for its own host and path', () => {
	const header = accounts.cookieHeader(
		[
			{name: 'a', value: '1', domain: '.bilibili.com', path: '/'},
			{name: 'b', value: '2', domain: 'api.bilibili.com', path: '/'},
			{name: 'c', value: '3', domain: '.bilibili.com', path: '/private'},
			{name: 'd', value: '4', domain: '.evil-bilibili.com', path: '/'},
		],
		'https://www.bilibili.com/video/x',
	);
	assert.equal(header, 'a=1');
});

test('the downloader gets a cookies file only while it runs and only when signed in', async () => {
	let seen;
	await accounts.withSiteCookies(
		'https://www.bilibili.com/video/BV1',
		async (file) => {
			seen = file;
		},
		{readCookies: async () => []},
	);
	assert.equal(seen, undefined);
	await accounts.withSiteCookies(
		'https://www.bilibili.com/video/BV1',
		async (file) => {
			seen = file;
			const text = await readFile(file, 'utf8');
			assert.match(
				text,
				/^# Netscape HTTP Cookie File\n\.bilibili\.com\tTRUE\t\/\tTRUE\t\d+\tSESSDATA\tthree\n/,
			);
		},
		{readCookies: async () => session('three')},
	);
	await assert.rejects(access(seen));
	await assert.rejects(
		accounts.withSiteCookies(
			'https://www.bilibili.com/video/BV1',
			async () => {
				throw Object.assign(new Error(), {code: 'auth_required'});
			},
			{readCookies: async () => session('three')},
		),
		{code: 'login_expired'},
	);
	const bilibili = await accounts.findAccount('bilibili');
	const status = await accounts.accountStatus(bilibili, {
		readCookies: async () => session('three'),
	});
	assert.equal(status.status, 'expired');
});
