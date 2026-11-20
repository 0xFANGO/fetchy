import {createHash} from 'node:crypto';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {dataDirectory, privateDirectory, readJson, writeJson} from '../native/settings.mjs';
import {findExecutable, ytDlpCommand} from '../src/dependencies.mjs';
import {EngineError, runProcess} from '../src/process.mjs';
import {appBundle, sessionTarget} from './desktop.mjs';
import xiaohongshu, {isRednoteHost} from '../src/sites/xiaohongshu.mjs';

// Sign-in lives in the desktop app's WebKit store for each site. A site counts
// as signed in only while one of its session cookies is present; the cookie
// values leave the app only for a request or a download on that same site.
export const KNOWN_SITES = [
	{
		site: 'xiaohongshu',
		label: '小红书',
		url: 'https://www.xiaohongshu.com/',
		session: ['web_session'],
	},
	{
		site: 'douyin',
		label: '抖音',
		url: 'https://www.douyin.com/',
		session: ['sessionid', 'sessionid_ss'],
	},
	{site: 'bilibili', label: 'B站', url: 'https://www.bilibili.com/', session: ['SESSDATA']},
	{
		site: 'youtube',
		label: 'YouTube',
		url: 'https://www.youtube.com/',
		session: ['SAPISID', '__Secure-3PAPISID'],
	},
	{site: 'x', label: 'X', url: 'https://x.com/', session: ['auth_token']},
	{
		site: 'instagram',
		label: 'Instagram',
		url: 'https://www.instagram.com/',
		session: ['sessionid'],
	},
	{site: 'threads', label: 'Threads', url: 'https://www.threads.com/', session: ['sessionid']},
	{site: 'zhihu', label: '知乎', url: 'https://www.zhihu.com/', session: ['z_c0']},
	{site: 'tiktok', label: 'TikTok', url: 'https://www.tiktok.com/', session: ['sessionid']},
];
const accountsFile = () => path.join(dataDirectory(), 'accounts.json');
const digest = (value) => createHash('sha256').update(value).digest('hex');

async function readState() {
	const state = await readJson(accountsFile(), {});
	return {custom: Array.isArray(state.custom) ? state.custom : [], seen: state.seen ?? {}};
}
async function saveState(state) {
	await privateDirectory(dataDirectory());
	await writeJson(accountsFile(), state);
}

function describe(row) {
	const {url, hosts, profile} = sessionTarget(row.url);
	return {...row, url: url.href, hosts, profile};
}
/** Find the account row for a site id, label or any URL on that site. */
export async function findAccount(input) {
	const state = await readState();
	const rows = [...KNOWN_SITES, ...state.custom];
	const byName = rows.find(
		(row) =>
			row.site === input ||
			row.label === input ||
			row.label.toLowerCase() === String(input).toLowerCase(),
	);
	let target;
	try {
		target = sessionTarget(byName?.url ?? input);
	} catch {
		throw new EngineError('invalid_url', '请提供站点名称，例如 bilibili，或该站的 HTTPS 链接。');
	}
	const row = rows.find((r) => sessionTarget(r.url).profile === target.profile);
	if (row) {
		const account = describe(row);
		// An explicit regional login opens the domain the user selected.
		if (account.site === 'xiaohongshu' && isRednoteHost(target.url.hostname))
			account.url = target.url.origin + '/';
		return account;
	}
	const url = new URL(input);
	return describe({site: url.hostname, label: url.hostname, url: url.origin + '/', session: []});
}

export async function addAccount(input) {
	const account = await findAccount(input);
	const state = await readState();
	if (
		!KNOWN_SITES.some((s) => s.site === account.site) &&
		!state.custom.some((s) => s.site === account.site)
	) {
		state.custom.push({site: account.site, label: account.label, url: account.url, session: []});
		await saveState(state);
	}
	return account;
}

const matchesCookieHost = (host, domain) =>
	host === domain.replace(/^\./, '') || (domain.startsWith('.') && host.endsWith(domain));

// The two regional logins live in one WebKit store, but either can expire independently.
// Pre-verification state only proved a cookie existed, which is also true for guests.
function loginScopes(account) {
	if (account.site !== 'xiaohongshu') return [account];
	return [
		{
			...account,
			hosts: xiaohongshu.hosts.filter((h) => !isRednoteHost(h)),
			stateKey: account.profile + ':verified:xiaohongshu.com',
		},
		{
			...account,
			hosts: account.hosts.filter(isRednoteHost),
			stateKey: account.profile + ':verified:rednote.com',
		},
	];
}
const cookiesForHosts = (cookies, hosts) =>
	cookies.filter((c) => hosts.some((host) => matchesCookieHost(host, c.domain)));

/** Cookies for exactly this site's hosts, read from the desktop app. */
export async function readSiteCookies(account) {
	let binary;
	try {
		binary = path.join(await appBundle(), 'Contents/MacOS/Fetchy');
	} catch {
		return [];
	}
	let result;
	try {
		// Longer than the app's own 15 s limit, so its answer arrives first.
		result = await runProcess(binary, ['cookies', account.profile, account.hosts.join(',')], {
			timeoutMs: 20000,
			maxOutputBytes: 4 * 1024 * 1024,
		});
	} catch {
		// Without the app's answer the request goes ahead signed out.
		return [];
	}
	let payload;
	try {
		payload = JSON.parse(result.stdout);
	} catch {}
	if (result.code !== 0 || !payload?.ok || !Array.isArray(payload.cookies)) return [];
	if (account.site === 'xiaohongshu' && payload.xiaohongshuSessionVerification !== 1) return [];
	return payload.cookies.filter(
		(c) =>
			typeof c?.name === 'string' &&
			typeof c.value === 'string' &&
			typeof c.domain === 'string' &&
			account.hosts.some((h) => matchesCookieHost(h, c.domain)),
	);
}

function sessionDigest(account, cookies) {
	const now = Date.now() / 1000;
	const live = cookies.filter((c) => !c.expires || c.expires > now);
	const names = account.session?.length ? account.session : null;
	const session = names ? live.filter((c) => names.includes(c.name)) : live;
	return session.length
		? digest(
				session
					.map((c) => c.name + '=' + c.value)
					.sort()
					.join('\n'),
			)
		: null;
}

/**
 * logged_in: a session cookie is present and has not failed a download.
 * expired: the site signed in before, but the session is gone or was rejected.
 */
function computeStatus(current, seen = {}) {
	if (current && current !== seen.rejected) return 'logged_in';
	if (current || seen.loggedIn) return 'expired';
	return 'logged_out';
}
const statusRow = (account, status) => ({
	site: account.site,
	label: account.label,
	url: account.url,
	status,
	verified: Boolean(account.session?.length),
});

export async function accountStatus(account, {readCookies = readSiteCookies} = {}) {
	return (await statuses([account], readCookies))[0];
}
export async function listAccounts({readCookies = readSiteCookies} = {}) {
	const state = await readState();
	// A domain saved as a custom site by an older build may now be a built-in alias.
	const accounts = new Map();
	for (const row of [...KNOWN_SITES, ...state.custom]) {
		const account = describe(row);
		if (!accounts.has(account.profile)) accounts.set(account.profile, account);
	}
	return statuses([...accounts.values()], readCookies);
}
// Cookies are read in parallel; the state file is then read and written once, with no wait between.
async function statuses(accounts, readCookies) {
	const scoped = await Promise.all(
		accounts.map(async (account) => {
			const cookies = await readCookies(account);
			return loginScopes(account).map((scope) => ({
				key: scope.stateKey ?? scope.profile,
				current: sessionDigest(scope, cookiesForHosts(cookies, scope.hosts)),
			}));
		}),
	);
	const state = await readState();
	let changed = false;
	const rows = accounts.map((account, i) => {
		const results = scoped[i].map(({key, current}) => {
			const seen = state.seen[key];
			const status = computeStatus(current, seen);
			if (status === 'logged_in' && seen?.loggedIn !== current) {
				state.seen[key] = {loggedIn: current};
				changed = true;
			}
			return status;
		});
		return statusRow(
			account,
			results.includes('logged_in')
				? 'logged_in'
				: results.includes('expired')
					? 'expired'
					: 'logged_out',
		);
	});
	if (changed) await saveState(state);
	return rows;
}

/** After logout the site shows as signed out, not expired. */
export async function forgetAccount(account) {
	const state = await readState();
	for (const scope of loginScopes(account)) delete state.seen[scope.stateKey ?? scope.profile];
	await saveState(state);
}

/** A download was refused while signed in: show the site as expired until it signs in again. */
export async function markExpired(account, {readCookies = readSiteCookies} = {}) {
	const current = sessionDigest(account, await readCookies(account));
	const state = await readState();
	const key = account.stateKey ?? account.profile;
	state.seen[key] = {...state.seen[key], rejected: current ?? 'none'};
	await saveState(state);
}

export function cookieHeader(cookies, url) {
	const u = new URL(url);
	return cookies
		.filter((c) => {
			return (
				matchesCookieHost(u.hostname, c.domain) &&
				u.pathname.startsWith(c.path || '/') &&
				(!c.secure || u.protocol === 'https:')
			);
		})
		.map((c) => c.name + '=' + c.value)
		.join('; ');
}

export function netscapeCookies(cookies) {
	const lines = ['# Netscape HTTP Cookie File'];
	for (const c of cookies) {
		if (/[\t\n\r]/.test(c.name + c.value + c.domain + (c.path || ''))) continue;
		lines.push(
			[
				(c.httpOnly ? '#HttpOnly_' : '') + c.domain,
				c.domain.startsWith('.') ? 'TRUE' : 'FALSE',
				c.path || '/',
				c.secure ? 'TRUE' : 'FALSE',
				String(Math.max(0, Math.floor(c.expires || 0))),
				c.name,
				c.value,
			].join('\t'),
		);
	}
	return lines.join('\n') + '\n';
}

async function requestCookies(input, readCookies) {
	const account = await findAccount(input);
	if (account.site !== 'xiaohongshu') return {account, cookies: await readCookies(account)};
	const {url} = sessionTarget(URL.canParse(input) ? input : account.url);
	const scope = loginScopes(account).find((s) => s.hosts.includes(url.hostname));
	if (!scope) return {account, cookies: []};
	const hosts = [url.hostname];
	const cookies = cookiesForHosts(await readCookies({...scope, hosts}), hosts);
	return {account: scope, cookies};
}

/**
 * Give `action` a temporary cookies file for this site only while it runs.
 * Without a sign-in, `action` runs without one. A rejected sign-in marks the
 * account expired and is reported as `login_expired`.
 */
export async function withSiteCookies(input, action, {readCookies = readSiteCookies} = {}) {
	let account, cookies;
	try {
		({account, cookies} = await requestCookies(input, readCookies));
	} catch {
		return action(undefined);
	}
	if (!sessionDigest(account, cookies)) return action(undefined);
	const dir = await mkdtemp(path.join(tmpdir(), 'fetchy-session-'));
	const file = path.join(dir, 'cookies.txt');
	try {
		await writeFile(file, netscapeCookies(cookies), {mode: 0o600});
		return await action(file);
	} catch (error) {
		// Only a refused sign-in marks the site expired. Paid or members-only content
		// (premium_required) and a missing browser session (session_required) do not.
		if (['auth_required', 'login_required'].includes(error.code)) {
			await markExpired(account, {readCookies: async () => cookies});
			throw new EngineError(
				'login_expired',
				account.label + ' 的登录已过期，请在 Fetchy「账号」重新登录后重试。',
			);
		}
		throw error;
	} finally {
		await rm(dir, {recursive: true, force: true});
	}
}

/** The Cookie header for one request to `url`, from that site's sign-in only. */
export async function siteCookieHeader(url, {readCookies = readSiteCookies} = {}) {
	try {
		const {account, cookies} = await requestCookies(url, readCookies);
		return sessionDigest(account, cookies) ? cookieHeader(cookies, url) : '';
	} catch {
		return '';
	}
}

export const IMPORT_BROWSERS = [
	'chrome',
	'safari',
	'edge',
	'firefox',
	'brave',
	'chromium',
	'vivaldi',
	'opera',
];
const BROWSER_LABELS = {
	chrome: 'Chrome',
	safari: 'Safari',
	edge: 'Edge',
	firefox: 'Firefox',
	brave: 'Brave',
	chromium: 'Chromium',
	vivaldi: 'Vivaldi',
	opera: 'Opera',
};

function findPythonForCookies() {
	const ytdlp = ytDlpCommand();
	if (path.isAbsolute(ytdlp)) {
		const dir = path.dirname(ytdlp);
		const venvPy =
			findExecutable(path.join(dir, 'python3')) ?? findExecutable(path.join(dir, 'python'));
		if (venvPy) return venvPy;
	}
	return findExecutable('python3') ?? 'python3';
}

export async function extractExternalBrowserCookies(browser, hosts) {
	const script = fileURLToPath(new URL('../src/browser-cookies.py', import.meta.url));
	const python = findPythonForCookies();
	const result = await runProcess(python, [script, browser, hosts.join(',')], {
		timeoutMs: 30000,
		maxOutputBytes: 4 * 1024 * 1024,
	});
	let payload;
	try {
		payload = JSON.parse(result.stdout);
	} catch {}
	if (result.code !== 0 || !payload?.ok || !Array.isArray(payload.cookies)) {
		const code = typeof payload?.error === 'string' ? payload.error : 'unavailable';
		const message =
			typeof payload?.message === 'string' && payload.message
				? payload.message
				: `无法从 ${BROWSER_LABELS[browser] ?? browser} 读取登录信息。`;
		throw new EngineError(code, message);
	}
	return payload.cookies.filter(
		(c) =>
			typeof c?.name === 'string' &&
			typeof c.value === 'string' &&
			typeof c.domain === 'string' &&
			hosts.some((h) => matchesCookieHost(h, c.domain)),
	);
}

/**
 * Import cookies for a single site from a local browser (Chrome, Safari, etc.)
 * into Fetchy's shared WebKit data store so desktop, extension and CLI share the session.
 */
export async function importBrowserCookies(
	input,
	browser = 'chrome',
	{
		extractCookies = extractExternalBrowserCookies,
		readCookies = readSiteCookies,
		writeCookies,
	} = {},
) {
	const normalized = String(browser || '')
		.trim()
		.toLowerCase();
	if (!IMPORT_BROWSERS.includes(normalized)) {
		throw new EngineError('invalid_options', '请选择 Chrome、Safari、Edge、Firefox 或 Brave。');
	}
	const account = await findAccount(input);
	const cookies = (await extractCookies(normalized, account.hosts)).filter(
		(c) =>
			typeof c?.name === 'string' &&
			typeof c.value === 'string' &&
			typeof c.domain === 'string' &&
			account.hosts.some((h) => matchesCookieHost(h, c.domain)),
	);
	const browserLabel = BROWSER_LABELS[normalized] ?? normalized;
	if (!cookies.length) {
		throw new EngineError(
			'auth_required',
			`${browserLabel} 中未找到 ${account.label} 的登录信息，请先在 ${browserLabel} 登录该站。`,
		);
	}
	if (account.session?.length && !sessionDigest(account, cookies)) {
		throw new EngineError(
			'auth_required',
			`${browserLabel} 中只有 ${account.label} 的访客 Cookie，请先在 ${browserLabel} 完成登录。`,
		);
	}
	if (writeCookies) {
		await writeCookies(account, cookies);
	} else {
		const binary = path.join(await appBundle(), 'Contents/MacOS/Fetchy');
		const result = await runProcess(
			binary,
			['import-cookies', account.profile, account.hosts.join(',')],
			{
				input: JSON.stringify(cookies),
				timeoutMs: 30000,
				maxOutputBytes: 64 * 1024,
			},
		);
		let payload;
		try {
			payload = JSON.parse(result.stdout);
		} catch {}
		if (result.code !== 0 || !payload?.ok) {
			throw new EngineError('browser_unavailable', '无法将登录信息写入 Fetchy 内置浏览器。');
		}
	}
	await forgetAccount(account);
	const status = await accountStatus(account, {readCookies});
	return {
		imported: true,
		site: account.site,
		label: account.label,
		browser: normalized,
		count: cookies.length,
		status: status.status,
	};
}
