import test from 'node:test';
import assert from 'node:assert/strict';
import {access, chmod, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
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

test('regional Xiaohongshu logins share a store and keep their own credentials and expiry', async () => {
	const home = await accounts.findAccount('小红书');
	const regionalUrl = 'https://www.rednote.com/explore/example';
	const regional = await accounts.findAccount(regionalUrl);
	assert.equal(regional.profile, home.profile);
	assert.equal(regional.site, home.site);
	assert.equal(regional.url, 'https://www.rednote.com/');
	const domestic = {name: 'web_session', value: 'domestic', domain: '.xiaohongshu.com', path: '/'};
	const international = {...domestic, domain: '.rednote.com', value: 'international'};
	const device = {...international, name: 'device'};
	let jar = [domestic, device];
	const readCookies = async () => jar;
	const header = () => accounts.siteCookieHeader(regionalUrl, {readCookies});
	assert.equal(await header(), '');
	assert.equal(
		await accounts.withSiteCookies(regionalUrl, (file) => file, {readCookies}),
		undefined,
	);

	jar = [domestic, international, {...device, domain: 'rednote.com'}];
	assert.equal(await header(), 'web_session=international');
	assert.equal(await accounts.siteCookieHeader(home.url, {readCookies}), 'web_session=domestic');
	await assert.rejects(
		accounts.withSiteCookies(
			regionalUrl,
			async (file) => {
				const lines = (await readFile(file, 'utf8')).trim().split('\n');
				assert.equal(lines.length, 2);
				assert.match(lines[1], /^\.rednote\.com\tTRUE\t.*\tweb_session\tinternational$/);
				throw Object.assign(new Error(), {code: 'auth_required'});
			},
			{readCookies},
		),
		{code: 'login_expired'},
	);
	assert.equal((await accounts.accountStatus(home, {readCookies})).status, 'logged_in');
	jar = [international];
	assert.equal((await accounts.accountStatus(home, {readCookies})).status, 'expired');
	jar = [{...international, value: 'fresh'}];
	assert.equal((await accounts.accountStatus(home, {readCookies})).status, 'logged_in');
	await accounts.forgetAccount(home);
	jar = [device];
	assert.equal((await accounts.accountStatus(home, {readCookies})).status, 'logged_out');
});

test(
	'the downloader does not borrow a guest cookie from an older macOS helper',
	{skip: process.platform !== 'darwin'},
	async (t) => {
		const previous = process.env.FETCHY_DESKTOP_APP;
		const bundle = path.join(dir, 'old-helper.app');
		const executable = path.join(bundle, 'Contents/MacOS/Fetchy');
		await mkdir(path.dirname(executable), {recursive: true});
		const payload = {
			ok: true,
			cookies: [{name: 'web_session', value: 'guest-fixture', domain: '.rednote.com', path: '/'}],
		};
		await writeFile(
			executable,
			['#!/bin/sh', "cat <<'JSON'", JSON.stringify(payload), 'JSON', ''].join('\n'),
		);
		await chmod(executable, 0o700);
		process.env.FETCHY_DESKTOP_APP = bundle;
		t.after(() => {
			if (previous === undefined) delete process.env.FETCHY_DESKTOP_APP;
			else process.env.FETCHY_DESKTOP_APP = previous;
		});
		const url = 'https://www.rednote.com/explore/example';
		assert.equal(await accounts.siteCookieHeader(url), '');
		await accounts.withSiteCookies(url, (file) => assert.equal(file, undefined));
	},
);

test('a custom Rednote row from an earlier install resolves to the built-in account', async () => {
	const file = path.join(dir, 'accounts.json');

	const old = {
		site: 'www.rednote.com',
		label: 'www.rednote.com',
		url: 'https://www.rednote.com/',
		session: [],
	};
	const home = await accounts.findAccount('xiaohongshu');
	await writeFile(
		file,
		JSON.stringify({custom: [old], seen: {[home.profile]: {loggedIn: 'legacy-guest'}}}),
	);
	const byName = await accounts.findAccount(old.label);
	assert.equal(byName.site, 'xiaohongshu');
	assert.deepEqual(byName.session, ['web_session']);
	const rows = await accounts.listAccounts({readCookies: async () => []});
	assert.equal(rows.filter((row) => row.site === 'xiaohongshu').length, 1);
	assert.equal(rows.find((row) => row.site === 'xiaohongshu').status, 'logged_out');
	assert.equal(
		rows.some((row) => row.site === old.site),
		false,
	);
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

test('every Zhihu host shares the one Zhihu sign-in', async () => {
	const zhihu = await accounts.findAccount('zhihu');
	for (const link of ['https://zhuanlan.zhihu.com/p/1', 'https://zhihu.com/question/1/answer/2'])
		assert.equal((await accounts.findAccount(link)).profile, zhihu.profile);
	assert.deepEqual(zhihu.hosts.sort(), ['www.zhihu.com', 'zhihu.com', 'zhuanlan.zhihu.com'].sort());
});

test('paid content and a missing browser session do not mark a sign-in expired', async () => {
	const bilibili = await accounts.findAccount('bilibili');
	await accounts.forgetAccount(bilibili);
	const readCookies = async () => session('four');
	for (const code of ['premium_required', 'session_required'])
		await assert.rejects(
			accounts.withSiteCookies(
				'https://www.bilibili.com/video/BV1',
				async () => {
					throw Object.assign(new Error(), {code});
				},
				{readCookies},
			),
			{code},
		);
	assert.equal((await accounts.accountStatus(bilibili, {readCookies})).status, 'logged_in');
});

test('listing every site records each sign-in once, without losing concurrent updates', async () => {
	const list = await accounts.listAccounts({
		readCookies: async (account) => [
			{name: account.session[0] ?? 'any', value: account.site, domain: account.hosts[0], path: '/'},
		],
	});
	assert.ok(list.filter((row) => row.verified).every((row) => row.status === 'logged_in'));
	const after = await accounts.listAccounts({readCookies: async () => []});
	assert.ok(after.filter((row) => row.verified).every((row) => row.status === 'expired'));
});

test('importBrowserCookies validates browser, filters to site hosts, clears expired state, and syncs status', async () => {
	await assert.rejects(() => accounts.importBrowserCookies('x', 'netscape'), {
		code: 'invalid_options',
	});

	await assert.rejects(
		() =>
			accounts.importBrowserCookies('x', 'chrome', {
				extractCookies: async () => [],
				writeCookies: async () => {},
			}),
		{code: 'auth_required'},
	);

	// Guest-only cookies without session cookie are rejected for verified sites
	await assert.rejects(
		() =>
			accounts.importBrowserCookies('x', 'chrome', {
				extractCookies: async () => [
					{name: 'guest_id', value: 'v1', domain: '.x.com', path: '/', secure: true},
				],
				writeCookies: async () => {},
			}),
		{code: 'auth_required'},
	);

	// Mark X expired first, then import valid Chrome cookies (with an unrelated domain mixed in)
	const xAccount = await accounts.findAccount('x');
	await accounts.markExpired(xAccount, {
		readCookies: async () => [{name: 'auth_token', value: 'old', domain: '.x.com', path: '/'}],
	});
	const written = [];
	const imported = await accounts.importBrowserCookies('x', 'chrome', {
		extractCookies: async (_browser, hosts) => {
			assert.ok(hosts.includes('x.com'));
			return [
				{name: 'auth_token', value: 'fresh-token', domain: '.x.com', path: '/', secure: true},
				{name: 'SID', value: 'should-not-leak', domain: '.google.com', path: '/', secure: true},
			];
		},
		writeCookies: async (_account, cookies) => {
			written.push(...cookies);
		},
		readCookies: async () => written,
	});
	assert.equal(imported.imported, true);
	assert.equal(imported.site, 'x');
	assert.equal(imported.count, 1);
	assert.equal(imported.status, 'logged_in');
	assert.deepEqual(
		written.map((c) => c.name),
		['auth_token'],
	);
});
