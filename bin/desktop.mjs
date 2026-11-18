import {createHash} from 'node:crypto';
import {access, mkdir, mkdtemp, open, rm, stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {dataDirectory} from '../native/settings.mjs';
import {ensureCompatibleMp4} from '../src/mp4.mjs';
import {publishVideoFile, videoFilename} from '../src/filenames.mjs';
import {EngineError, runProcess} from '../src/process.mjs';
import {siteForHost} from '../src/sites/index.mjs';
import {browserOnlySite, browserPostTarget} from '../src/sites/page-posts.mjs';
import {normalizeUrl} from '../src/urls.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const digest = (value) => createHash('sha256').update(value).digest('hex');

// An extractor may support several independent instances or tenant-owned hosts.
// Only its explicitly registered aliases can share a website data store.
// Hosts of one service without a video adapter that share one sign-in. The first host
// names the store, so an existing sign-in on it keeps its profile.
const sessionAliases = [['www.zhihu.com', 'zhihu.com', 'zhuanlan.zhihu.com']];
export function browserSessionScope(url) {
	const secure = url.protocol === 'https:' && !url.port && !url.username && !url.password;
	const browserOnly = secure && browserOnlySite(url.hostname);
	if (browserOnly) return {scope: 'https://' + browserOnly.hosts[0], hosts: browserOnly.hosts};
	const alias = secure && sessionAliases.find((hosts) => hosts.includes(url.hostname));
	if (alias) return {scope: 'https://' + alias[0], hosts: alias};
	const site = secure ? siteForHost(url.hostname) : null;
	const aliases = site ? [...site.hosts, ...(site.shortHosts ?? [])] : [];
	if (site?.browserProfile !== 'origin' && aliases.includes(url.hostname)) {
		return {scope: 'https:site:' + site.id, hosts: [...new Set(aliases)]};
	}
	return {scope: url.origin, hosts: [url.hostname]};
}

export function sessionTarget(input) {
	let url;
	try {
		url = new URL(input);
	} catch {
		/* Reject prose and incomplete URLs. */
	}
	const local = ['localhost', '127.0.0.1', '[::1]'].includes(url?.hostname);
	if (
		!url ||
		(url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
		url.username ||
		url.password
	)
		throw new EngineError('invalid_url', '请提供 HTTPS 网页地址，本机测试也可使用回环 HTTP 地址。');
	const {hosts, scope} = browserSessionScope(url);
	const key = digest(dataDirectory() + '\0' + scope).slice(0, 32);
	const profile = [
		key.slice(0, 8),
		key.slice(8, 12),
		key.slice(12, 16),
		key.slice(16, 20),
		key.slice(20),
	].join('-');
	return {url, hosts, profile};
}

export async function appBundle() {
	if (process.platform !== 'darwin')
		throw new EngineError('browser_unavailable', 'Fetchy 专属浏览器需要 macOS 14 或更高版本。');
	const packaged = path.resolve(root, '../../..');
	const candidates = [
		process.env.FETCHY_DESKTOP_APP,
		packaged.endsWith('.app') && packaged,
		path.join(root, 'dist/Fetchy.app'),
		path.join(homedir(), 'Applications/Fetchy.app'),
		'/Applications/Fetchy.app',
	].filter(Boolean);
	for (const candidate of candidates) {
		try {
			await access(path.join(candidate, 'Contents/MacOS/Fetchy'));
			return candidate;
		} catch {}
	}
	throw new EngineError(
		'browser_unavailable',
		'尚未安装 Fetchy 桌面端。请运行 npm run desktop:build 后重试。',
	);
}

/** True while the desktop app holds a sign-in for this site, judged from its cookies. */
export async function hasSession(input) {
	try {
		const {accountStatus, findAccount} = await import('./accounts.mjs');
		return (await accountStatus(await findAccount(input))).status === 'logged_in';
	} catch {
		return false;
	}
}

// The desktop app is one window. A running window receives the request as a
// notification; a new launch reads it from its arguments.
async function openInApp(command, url) {
	const bundle = await appBundle();
	// A running window acknowledges the request. Hidden helper processes of the same app
	// (cookies, capture) do not, so only then is a new window instance launched.
	const notified = await runProcess(
		path.join(bundle, 'Contents/MacOS/Fetchy'),
		['notify', command, url],
		{timeoutMs: 10000},
	).catch(() => null);
	let delivered = false;
	try {
		delivered = JSON.parse(notified?.stdout ?? '').delivered === true;
	} catch {}
	if (delivered) return;
	// Launch Services does not pass this environment on; the app hands it to its own Node calls.
	const data = process.env.FETCHY_DATA_DIR ? ['--data-dir', dataDirectory()] : [];
	const started = await runProcess(
		'/usr/bin/open',
		['-n', '-a', bundle, '--args', command, url, ...data],
		{timeoutMs: 15000},
	);
	if (started.code !== 0) throw new EngineError('browser_unavailable', '无法启动 Fetchy 桌面端。');
}

/** Open the site's row in the app's accounts and sign in inside its built-in browser. */
export async function login(input) {
	const {addAccount, findAccount} = await import('./accounts.mjs');
	const account = await findAccount(input);
	await openInApp('login', account.url);
	// Saved only once the app opened, so a failed command leaves no row behind.
	await addAccount(input);
	return {opened: true, site: account.site, url: account.url};
}

/** Open a link in the app's built-in browser with that site's storage. */
export async function browse(input) {
	const {url} = sessionTarget(input);
	await openInApp('browse', url.href);
	return {opened: true, origin: url.origin};
}

export async function logout(input) {
	const {findAccount, forgetAccount} = await import('./accounts.mjs');
	const account = await findAccount(input);
	const binary = path.join(await appBundle(), 'Contents/MacOS/Fetchy');
	const result = await runProcess(binary, ['logout', account.profile], {timeoutMs: 30000});
	if (result.code !== 0)
		throw new EngineError('browser_unavailable', '无法清除本站的 Fetchy 会话。');
	await forgetAccount(account);
	return {loggedOut: true, site: account.site, origin: new URL(account.url).origin};
}

const messages = {
	auth_required: '本站要求登录，请运行 fetchy login <站点> 登录后重试。',
	no_formats: '当前页没有唯一可保存的同源 MP4 或 WebM。请打开具体的视频页。',
	network_error: '专属浏览器无法加载该内容。',
	unavailable: '本站没有提供请求的内容。',
	size_limit: '媒体超过专属浏览器单文件上限。',
	output_invalid: '返回的文件未通过媒体验证。',
};

async function checkHeader(filename) {
	const handle = await open(filename, 'r');
	try {
		const bytes = Buffer.alloc(12);
		await handle.read(bytes, 0, bytes.length, 0);
		if (bytes.toString('ascii', 4, 8) !== 'ftyp' && bytes.readUInt32BE(0) !== 0x1a45dfa3)
			throw new EngineError('output_invalid', messages.output_invalid);
	} finally {
		await handle.close();
	}
}

/** WebKit sends credentials itself, within the exact origin's Fetchy data store. */
export async function downloadWithSession(input, options = {}) {
	const {url, hosts, profile} = sessionTarget(input);
	const binary = path.join(await appBundle(), 'Contents/MacOS/Fetchy');
	const outputDir = path.resolve(options.outputDir ?? 'downloads');
	const timeoutMs = options.timeoutMs ?? 30 * 60_000;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647)
		throw new EngineError('invalid_options', 'timeoutMs 必须是有效正整数。');
	const signal = AbortSignal.any([
		AbortSignal.timeout(timeoutMs),
		...(options.signal ? [options.signal] : []),
	]);
	const settings = {...options, signal, timeoutMs};
	await mkdir(outputDir, {recursive: true});
	const folder = await mkdtemp(path.join(outputDir, '.fetchy-session-'));
	try {
		const staged = path.join(folder, 'source.mp4');
		options.onProgress?.({stage: 'resolving', engine: 'webkit'});
		const capture = await runProcess(
			binary,
			['capture', profile, url.href, staged, hosts.join(',')],
			{...settings, maxOutputBytes: 16 * 1024},
		);

		let info;
		try {
			info = JSON.parse(capture.stdout);
		} catch {}
		if (capture.code !== 0 || !info?.ok) {
			const code = Object.hasOwn(messages, info?.error) ? info.error : 'network_error';
			throw new EngineError(code, messages[code]);
		}
		await checkHeader(staged);
		options.onProgress?.({stage: 'validating', engine: 'webkit'});
		const converted = await ensureCompatibleMp4(staged, settings);
		const probe = await runProcess(
			options.ffprobePath ?? 'ffprobe',
			[
				'-v',
				'error',
				'-show_entries',
				'format=duration:stream=codec_type,width,height',
				'-of',
				'json',
				converted.filepath,
			],
			settings,
		);
		if (probe.code !== 0) throw new EngineError('output_invalid', messages.output_invalid);
		const metadata = JSON.parse(probe.stdout),
			video = metadata.streams?.find((stream) => stream.codec_type === 'video');
		const durationSeconds = Number(metadata.format?.duration);
		if (!video || !(durationSeconds > 0))
			throw new EngineError('output_invalid', messages.output_invalid);
		if (options.maxHeight !== undefined && video.height > options.maxHeight)
			throw new EngineError('no_formats', '源视频高于指定的画质上限。');
		let target;
		try {
			target = normalizeUrl(input);
		} catch {}
		const id = target?.id || digest(url.origin + url.pathname + url.search).slice(0, 24),
			platform = target?.platform ?? url.hostname;
		const title = path.basename(
			videoFilename(typeof info.title === 'string' ? info.title : id, {platform, id}),
			'.mp4',
		);
		const bytes = (await stat(converted.filepath)).size;
		const filepath = await publishVideoFile(converted.filepath, {
			title,
			id,
			platform,
			outputDir,
			signal,
		});
		return {
			platform,
			id,
			title,
			engine: 'webkit',
			filepath,
			bytes,
			durationSeconds,
			validation: {
				video: true,
				audio: metadata.streams.some((stream) => stream.codec_type === 'audio'),
				width: video.width,
				height: video.height,
				durationSeconds,
				method: 'ffprobe',
				fullDecode: false,
			},
			conversion: converted.mode,
		};
	} catch (error) {
		if (signal.aborted && !options.signal?.aborted)
			throw new EngineError('timeout', '专属浏览器保存超时。');
		throw error;
	} finally {
		await rm(folder, {recursive: true, force: true});
	}
}

export function samePost(input, candidate, entry) {
	let a, b;
	try {
		a = new URL(input);
		b = new URL(candidate);
	} catch {
		return false;
	}
	if (b.username || b.password) return false;
	const pagePost = browserPostTarget(a);
	if (pagePost) {
		const captured = browserPostTarget(b);
		return (
			captured?.platform === pagePost.platform &&
			captured.id === pagePost.id &&
			entry.platform === pagePost.platform &&
			entry.id === pagePost.id
		);
	}
	try {
		const expected = normalizeUrl(a.href),
			captured = normalizeUrl(b.href);
		if (expected.id && captured.id)
			return (
				expected.platform === captured.platform &&
				expected.id === captured.id &&
				entry.platform === expected.platform &&
				entry.id === expected.id
			);
	} catch {}
	return a.origin === b.origin && a.pathname.replace(/\/$/, '') === b.pathname.replace(/\/$/, '');
}

/** Temporary attachment URLs are consumed by the library worker and must never be logged. */
export async function captureWithSession(input, options = {}) {
	const {url, hosts, profile} = sessionTarget(input);
	const binary = path.join(await appBundle(), 'Contents/MacOS/Fetchy');
	const result = await runProcess(binary, ['post', profile, url.href, hosts.join(',')], {
		signal: options.signal,
		timeoutMs: options.timeoutMs ?? 45000,
		maxOutputBytes: 48 * 1024 * 1024,
	});
	let payload;
	try {
		payload = JSON.parse(result.stdout);
	} catch {}
	if (result.code !== 0 || !payload?.ok) {
		const code = Object.hasOwn(messages, payload?.error) ? payload.error : 'unavailable';
		throw new EngineError(
			code,
			code === 'no_formats' ? '专属浏览器未找到可归档的正文。' : messages[code],
		);
	}
	const e = payload.entry;
	if (
		!e ||
		typeof e.id !== 'string' ||
		typeof e.platform !== 'string' ||
		!samePost(input, payload.observed, e) ||
		!samePost(input, e.sourceUrl, e)
	)
		throw new EngineError('identity_mismatch', '浏览器当前作品与输入链接不一致。');
	const source = new URL(e.sourceUrl);
	source.username = '';
	source.password = '';
	source.search = '';
	source.hash = '';
	let remaining = 32 * 1024 * 1024;
	const attachments = (Array.isArray(e.attachments) ? e.attachments : []).map((a) => {
		const media = {kind: a.kind, alt: typeof a.alt === 'string' ? a.alt.slice(0, 1500) : ''};
		if (
			typeof a.data === 'string' &&
			a.data.length > 0 &&
			a.data.length <= remaining &&
			typeof a.mimeType === 'string' &&
			/^(?:image\/(?:jpeg|png|gif|webp|avif)|video\/(?:webm|mp4))$/.test(a.mimeType) &&
			a.mimeType.startsWith(a.kind + '/') &&
			/^[A-Za-z0-9+/]+=*$/.test(a.data)
		) {
			remaining -= a.data.length;
			return {...media, mimeType: a.mimeType, data: a.data};
		}
		try {
			const url = new URL(a.url);
			if (
				!a.missing &&
				['image', 'audio', 'video'].includes(a.kind) &&
				url.protocol === 'https:' &&
				!url.username &&
				!url.password &&
				!url.port
			)
				return {...media, url: url.href};
		} catch {}
		return {...media, missing: true};
	});
	return {
		type: 'post',
		entry: {
			platform: e.platform,
			id: e.id,
			sourceUrl: source.href,
			title: String(e.title ?? ''),
			author: String(e.author ?? ''),
			body: String(e.body ?? ''),
			bodyFormat: e.bodyFormat === 'markdown' ? 'markdown' : 'text',
			bodyComplete: e.bodyComplete === true,
			attachments,
			...(Array.isArray(e.missing)
				? {missing: e.missing.filter((v) => typeof v === 'string')}
				: {}),
		},
	};
}
