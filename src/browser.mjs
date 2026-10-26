import {mkdir, mkdtemp, rm, stat} from 'node:fs/promises';
import {publishVideoFile} from './filenames.mjs';
import {createWriteStream} from 'node:fs';
import path from 'node:path';
import {Readable, Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {EngineError, fileWriteError, runProcess} from './process.mjs';
import {publicThumbnailUrl} from './thumbnails.mjs';

function emit(options, stage, extra = {}) {
	try {
		options.onProgress?.({stage, engine: 'browser', ...extra});
	} catch {
		/* observer */
	}
}
function check(options) {
	if (
		options.maxHeight !== undefined &&
		(!Number.isSafeInteger(options.maxHeight) || options.maxHeight < 1 || options.maxHeight > 16384)
	)
		throw new EngineError('invalid_options', 'maxHeight 必须是 1–16384 的整数。');
	if (
		options.timeoutMs !== undefined &&
		(!Number.isSafeInteger(options.timeoutMs) ||
			options.timeoutMs < 1 ||
			options.timeoutMs > 2147483647)
	)
		throw new EngineError('invalid_options', 'timeoutMs 必须是有效的正整数。');
	if (
		options.maxBytes !== undefined &&
		(!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1)
	)
		throw new EngineError('invalid_options', 'maxBytes 必须是正整数。');
	if (
		options.format !== undefined ||
		(options.transport !== undefined && options.transport !== 'auto')
	)
		throw new EngineError(
			'invalid_options',
			'浏览器引擎当前仅接受合流直链，请用 maxHeight 选择画质。',
		);
	if (options.cookiesFile !== undefined)
		throw new EngineError('invalid_options', 'cookiesFile 仅可用于 yt-dlp 引擎。');
	for (const key of ['outputDir', 'ffprobePath'])
		if (
			options[key] !== undefined &&
			(typeof options[key] !== 'string' || !options[key] || options[key].includes('\0'))
		)
			throw new EngineError('invalid_options', `${key} 必须是有效路径。`);
}

export function publicBrowserMetadata(media) {
	return {
		platform: media.platform,
		id: media.id,
		title: media.title,
		thumbnailUrl: publicThumbnailUrl(media.thumbnailUrl, media),
		durationSeconds: media.durationSeconds ?? null,
		formats: media.formats.map(
			({
				id,
				ext,
				protocol,
				width,
				height,
				fps,
				vcodec,
				acodec,
				bitrate,
				size,
				hasVideo,
				hasAudio,
			}) => ({
				id,
				ext,
				protocol,
				width,
				height,
				fps,
				vcodec,
				acodec,
				bitrate,
				size,
				hasVideo,
				hasAudio,
			}),
		),
		engine: 'browser',
		availability: 'ready',
		qualityScope: '当前页面明确提供的合流格式；不代表平台全部画质',
	};
}

export function selectBrowserFormat(formats, {maxHeight} = {}) {
	const selected = formats.filter(
		(f) =>
			f.hasVideo &&
			f.hasAudio &&
			f.width > 0 &&
			f.height > 0 &&
			(!maxHeight || f.height <= maxHeight),
	);
	const compatibility = (c) => (/264|avc/i.test(c ?? '') ? 2 : /265|hevc/i.test(c ?? '') ? 1 : 0);
	selected.sort(
		(a, b) =>
			b.width * b.height - a.width * a.height ||
			(b.fps || 0) - (a.fps || 0) ||
			compatibility(b.vcodec) - compatibility(a.vcodec) ||
			(a.vcodec === b.vcodec ? (b.bitrate || 0) - (a.bitrate || 0) : 0),
	);
	if (!selected.length)
		throw new EngineError('no_formats', '当前页面没有符合清晰度限制的合流视频。');
	return selected[0];
}

const PAGE_PLATFORMS = ['xiaohongshu', 'douyin'];
const positive = (value) =>
	typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
const bounded = (value, max) => (typeof value === 'string' && value ? value.slice(0, max) : null);

/**
 * The browser engine never opens pages itself. The extension runs
 * extractPageMedia inside the user's own tab and hands the result over as
 * options.pageMedia = {media, userAgent}. Only the fields below are trusted;
 * everything is re-checked against the resolved target before any download.
 */
export function checkPageMedia(pageMedia, target) {
	if (!pageMedia || typeof pageMedia !== 'object' || Array.isArray(pageMedia))
		throw new EngineError('invalid_options', 'browser 引擎需要扩展提供的页面媒体信息。');
	const {media, userAgent} = pageMedia;
	if (!media || typeof media !== 'object' || Array.isArray(media))
		throw new EngineError('invalid_options', '页面媒体信息格式无效。');
	if (media.platform !== target.platform || media.id !== target.id)
		throw new EngineError('identity_mismatch', '页面视频与输入链接不一致。');
	const formats = (Array.isArray(media.formats) ? media.formats.slice(0, 128) : [])
		.filter((item) => item && typeof item === 'object' && Array.isArray(item.urls))
		.map((item, index) => {
			const urls = [];
			for (const raw of item.urls.slice(0, 8)) {
				try {
					urls.push(validateMediaUrl(raw, target.platform));
				} catch {
					/* unverified CDN hosts are dropped, never fetched */
				}
			}
			return {
				id: bounded(item.id, 64) ?? `format-${index}`,
				ext: bounded(item.ext, 16) ?? 'mp4',
				protocol: 'https',
				width: positive(item.width),
				height: positive(item.height),
				fps: positive(item.fps),
				vcodec: bounded(item.vcodec, 32),
				acodec: bounded(item.acodec, 32),
				bitrate: positive(item.bitrate),
				size: positive(item.size),
				hasVideo: item.hasVideo === true,
				hasAudio: item.hasAudio === true,
				urls,
			};
		})
		.filter((item) => item.urls.length);
	if (!formats.length) throw new EngineError('no_formats', '页面没有提供可下载的视频地址。');
	return {
		media: {
			platform: target.platform,
			id: target.id,
			title: bounded(media.title, 1000) ?? target.id,
			thumbnailUrl: bounded(media.thumbnailUrl, 8192),
			durationSeconds: positive(media.durationSeconds),
			formats,
		},
		userAgent: bounded(userAgent, 512),
	};
}

function pageMediaFor(target, options) {
	check(options);
	if (!PAGE_PLATFORMS.includes(target.platform))
		throw new EngineError('unsupported_platform', '浏览器引擎当前仅支持小红书和抖音。');
	emit(options, 'resolving');
	return checkPageMedia(options.pageMedia, target);
}

export async function resolveWithBrowser(target, options = {}) {
	return publicBrowserMetadata(pageMediaFor(target, options).media);
}

export function validateMediaUrl(raw, platform) {
	let url;
	try {
		url = new URL(raw);
	} catch {
		throw new EngineError('invalid_media_url', '媒体地址无效。');
	}
	const suffix =
		platform === 'xiaohongshu' ? '.xhscdn.com' : platform === 'douyin' ? '.douyinvod.com' : null;
	if (
		!suffix ||
		url.protocol !== 'https:' ||
		url.username ||
		url.password ||
		url.port ||
		!url.hostname.endsWith(suffix)
	)
		throw new EngineError('invalid_media_url', '媒体地址不在该平台已验证的 CDN 范围内。');
	return url.href;
}

async function fetchMedia(url, target, headers, signal) {
	let current = validateMediaUrl(url, target.platform);
	for (let i = 0; i < 5; i++) {
		const response = await fetch(current, {headers, signal, redirect: 'manual'});
		if ([301, 302, 303, 307, 308].includes(response.status)) {
			await response.body?.cancel();
			const next = response.headers.get('location');
			if (!next) throw new EngineError('network_error', '媒体跳转地址缺失。');
			current = validateMediaUrl(new URL(next, current).href, target.platform);
			continue;
		}
		if (response.status !== 200 || !response.body) {
			await response.body?.cancel();
			throw new EngineError(
				response.status === 403 || response.status === 410 ? 'media_expired' : 'network_error',
				'媒体请求失败或签名已过期，请重新解析。',
			);
		}
		const type = response.headers.get('content-type') || '';
		if (/text|json|html/.test(type)) {
			await response.body.cancel();
			throw new EngineError('output_invalid', '媒体地址返回了网页而非视频。');
		}
		return response;
	}
	throw new EngineError('network_error', '媒体跳转次数过多。');
}

export async function downloadWithBrowser(target, options = {}) {
	check(options);
	const timeout = AbortSignal.timeout(options.timeoutMs ?? 30 * 60_000);
	const signal = AbortSignal.any([timeout, ...(options.signal ? [options.signal] : [])]);
	let directory,
		successful = false;
	try {
		const {media, userAgent} = pageMediaFor(target, options);
		const format = selectBrowserFormat(media.formats, options);
		const outputRoot = path.resolve(options.outputDir ?? 'downloads');
		await mkdir(outputRoot, {recursive: true});
		directory = await mkdtemp(path.join(outputRoot, '.fetchy-'));
		const temporary = path.join(directory, 'media.part');
		const headers = {
			...(userAgent ? {'user-agent': userAgent} : {}),
			referer: `https://www.${target.platform === 'douyin' ? 'douyin' : 'xiaohongshu'}.com/`,
		};
		let bytes = 0,
			lastError;
		emit(options, 'downloading');
		for (const raw of format.urls) {
			bytes = 0;
			try {
				const response = await fetchMedia(raw, target, headers, signal);
				const limit = options.maxBytes ?? 4 * 1024 * 1024 * 1024;
				const count = new Transform({
					transform(chunk, encoding, callback) {
						bytes += chunk.length;
						if (bytes > limit)
							callback(new EngineError('size_limit', '视频超过当前下载体积上限。'));
						else callback(null, chunk);
					},
				});
				await pipeline(Readable.fromWeb(response.body), count, createWriteStream(temporary), {
					signal,
				});
				const declared = Number(response.headers.get('content-length'));
				if (
					!bytes ||
					(declared > 0 && bytes !== declared) ||
					(format.size > 0 && bytes !== format.size)
				)
					throw new EngineError('output_invalid', '媒体字节数与声明长度不一致。');
				lastError = null;
				break;
			} catch (error) {
				lastError = error;
				await rm(temporary, {force: true});
				if (signal.aborted || ['invalid_media_url', 'size_limit'].includes(error.code)) throw error;
			}
		}
		if (lastError || !bytes)
			throw lastError ?? new EngineError('no_formats', '没有可下载的媒体地址。');
		emit(options, 'validating');
		const probe = await runProcess(
			options.ffprobePath ?? 'ffprobe',
			['-v', 'error', '-show_streams', '-show_format', '-of', 'json', temporary],
			{signal, timeoutMs: 30000, maxOutputBytes: 2 * 1024 * 1024},
		);
		let info;
		try {
			info = JSON.parse(probe.stdout);
		} catch {
			throw new EngineError('output_invalid', '下载文件无法识别。');
		}
		const mp4 = String(info.format?.format_name ?? '')
			.split(',')
			.some((name) => name === 'mp4' || name === 'mov');
		if (!mp4) throw new EngineError('output_invalid', '下载文件不是支持的 MP4 容器。');
		const video = info.streams?.find(
			(s) =>
				s.codec_type === 'video' && !s.disposition?.attached_pic && s.width > 0 && s.height > 0,
		);
		const audio = info.streams?.find((s) => s.codec_type === 'audio' && s.channels > 0);
		const duration = Number(info.format?.duration);
		if (
			probe.code !== 0 ||
			!video ||
			!audio ||
			!Number.isFinite(duration) ||
			duration <= 0 ||
			duration < (media.durationSeconds || 0) - Math.max(3, (media.durationSeconds || 0) * 0.01)
		) {
			const error = new EngineError('output_invalid', '下载文件缺少音视频轨道或时长不完整。');
			error.details = {
				video: !!video,
				audio: !!audio,
				durationSeconds: duration,
				expectedDurationSeconds: media.durationSeconds,
				probeExitCode: probe.code,
			};
			throw error;
		}
		const result = {
			platform: target.platform,
			id: target.id,
			engine: 'browser',
			bytes: (await stat(temporary)).size,
			format: {
				...publicBrowserMetadata({...media, formats: [format]}).formats[0],
				vcodec: video.codec_name ?? null,
				acodec: audio.codec_name ?? null,
			},
			validation: {
				video: true,
				audio: true,
				durationSeconds: duration,
				width: video.width,
				height: video.height,
				method: 'ffprobe',
				fullDecode: false,
			},
		};
		const filepath = await publishVideoFile(temporary, {
			title: media.title,
			platform: target.platform,
			id: target.id,
			outputDir: outputRoot,
			signal,
		});
		result.filepath = filepath;
		successful = true;
		emit(options, 'complete', {filepath, bytes});
		return result;
	} catch (error) {
		if (options.signal?.aborted) throw new EngineError('cancelled', '任务已取消。');
		if (timeout.aborted) throw new EngineError('timeout', '任务超过时间限制。');
		const storageError = fileWriteError(error);
		if (storageError) throw storageError;
		if (error instanceof EngineError) throw error;
		throw new EngineError('network_error', '浏览器媒体下载失败，请检查网络后重新解析。');
	} finally {
		if (directory)
			await rm(directory, {recursive: true, force: true}).catch((error) => {
				// A cleanup failure must not invalidate an already delivered video.
				if (!successful) throw error;
			});
	}
}
