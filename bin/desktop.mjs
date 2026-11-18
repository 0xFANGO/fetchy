import {createHash} from 'node:crypto';
import {access, mkdir, mkdtemp, open, rm, stat, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {dataDirectory} from '../native/settings.mjs';
import {ensureCompatibleMp4} from '../src/mp4.mjs';
import {publishVideoFile, videoFilename} from '../src/filenames.mjs';
import {EngineError, runProcess} from '../src/process.mjs';
import {siteForHost} from '../src/sites/index.mjs';
import {normalizeUrl} from '../src/urls.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const digest = (value) => createHash('sha256').update(value).digest('hex');

function sessionTarget(input) {
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
	const site = url.protocol === 'https:' && !url.port ? siteForHost(url.hostname) : null;
	const hosts = site
		? [...new Set([url.hostname, ...site.hosts, ...(site.shortHosts ?? [])])]
		: [url.hostname];
	const scope = site ? 'https:site:' + site.id : url.origin;
	const key = digest(dataDirectory() + '\0' + scope).slice(0, 32);
	const profile = [
		key.slice(0, 8),
		key.slice(8, 12),
		key.slice(12, 16),
		key.slice(16, 20),
		key.slice(20),
	].join('-');
	return {url, hosts, profile, marker: path.join(dataDirectory(), 'browser-sites', profile)};
}

async function appBundle() {
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

export async function hasSession(input) {
	try {
		await access(sessionTarget(input).marker);
		return true;
	} catch {
		return false;
	}
}

export async function browse(input) {
	const {url, profile, marker} = sessionTarget(input);
	const bundle = await appBundle();
	const started = await runProcess(
		'/usr/bin/open',
		['-n', '-a', bundle, '--args', 'browse', profile, url.href],
		{timeoutMs: 15000},
	);
	if (started.code !== 0)
		throw new EngineError('browser_unavailable', '无法启动 Fetchy 专属浏览器。');
	await mkdir(path.dirname(marker), {recursive: true, mode: 0o700});
	await writeFile(marker, '', {mode: 0o600});
	return {opened: true, origin: url.origin};
}

export async function logout(input) {
	const {url, profile, marker} = sessionTarget(input);
	const binary = path.join(await appBundle(), 'Contents/MacOS/Fetchy');
	const result = await runProcess(binary, ['logout', profile], {timeoutMs: 30000});
	if (result.code !== 0)
		throw new EngineError('browser_unavailable', '无法清除本站的 Fetchy 会话。');
	await rm(marker, {force: true});
	return {loggedOut: true, origin: url.origin};
}

const messages = {
	auth_required: '本站要求登录，请用 fetchy browse 打开原链接并登录后重试。',
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
