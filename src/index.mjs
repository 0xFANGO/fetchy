import {normalizeUrl, resolveTarget} from './urls.mjs';
import {resolveWithYtDlp, downloadWithYtDlp} from './yt-dlp.mjs';
import {resolveWithBrowser, downloadWithBrowser} from './browser.mjs';
import {EngineError} from './process.mjs';
import {ytDlpCommand} from './dependencies.mjs';

export {normalizeUrl, resolveTarget} from './urls.mjs';
export {EngineError} from './process.mjs';

function settings(options) {
	const result = {...options};
	result.ytDlpPath = ytDlpCommand({ytDlpPath: result.ytDlpPath});
	if (!['auto', 'yt-dlp', 'browser'].includes(result.engine ?? 'auto'))
		throw new EngineError('invalid_options', 'engine 必须为 auto、yt-dlp 或 browser。');
	return result;
}

async function inputTarget(input, options) {
	const target = normalizeUrl(input);
	if (
		target.needsRedirect &&
		['xiaohongshu', 'douyin'].includes(target.platform) &&
		options.engine !== 'yt-dlp' &&
		options.pageMedia?.resolvedUrl !== undefined
	) {
		const resolved = normalizeUrl(options.pageMedia.resolvedUrl);
		if (
			resolved.needsRedirect ||
			resolved.platform !== target.platform ||
			options.pageMedia.media?.platform !== resolved.platform ||
			options.pageMedia.media?.id !== resolved.id
		)
			throw new EngineError('identity_mismatch', '浏览器展开的页面与目标视频不一致。');
		return resolved;
	}
	return target.needsRedirect ? resolveTarget(input, options) : target;
}

async function execute(action, input, options = {}) {
	options = settings(options);
	if (options.signal?.aborted) throw new EngineError('cancelled', '任务已取消。');
	if (
		options.timeoutMs !== undefined &&
		(!Number.isSafeInteger(options.timeoutMs) ||
			options.timeoutMs < 1 ||
			options.timeoutMs > 2147483647)
	)
		throw new EngineError('invalid_options', 'timeoutMs 必须是有效正整数。');
	const timeoutMs = options.timeoutMs ?? (action === 'resolve' ? 60000 : 30 * 60_000);
	const started = Date.now(),
		callerSignal = options.signal,
		deadline = AbortSignal.timeout(timeoutMs);
	options = {
		...options,
		timeoutMs,
		signal: AbortSignal.any([deadline, ...(callerSignal ? [callerSignal] : [])]),
	};
	try {
		const target = await inputTarget(input, options);
		options.timeoutMs = Math.max(1, timeoutMs - (Date.now() - started));
		// Xiaohongshu and Douyin use the browser engine only when the extension
		// supplies media it extracted from the user's own tab; the CLI and plain
		// API calls fall back to yt-dlp's anonymous extractors.
		const engine =
			options.engine && options.engine !== 'auto'
				? options.engine
				: options.pageMedia && ['xiaohongshu', 'douyin'].includes(target.platform)
					? 'browser'
					: 'yt-dlp';
		const fn =
			engine === 'browser'
				? action === 'resolve'
					? resolveWithBrowser
					: downloadWithBrowser
				: action === 'resolve'
					? resolveWithYtDlp
					: downloadWithYtDlp;
		try {
			return {...(await fn(target, options)), startTimeSeconds: target.startTimeSeconds};
		} catch (error) {
			if (
				action === 'download' &&
				target.platform === 'youtube' &&
				engine === 'yt-dlp' &&
				(options.transport ?? 'auto') === 'auto' &&
				error.code === 'network_error'
			) {
				try {
					options.onProgress?.({
						stage: 'retrying',
						engine: 'yt-dlp',
						reason: '尝试提取器提供的 HLS 格式',
					});
				} catch {}
				return {
					...(await downloadWithYtDlp(target, {
						...options,
						timeoutMs: Math.max(1, timeoutMs - (Date.now() - started)),
						transport: 'hls',
					})),
					fallback: 'https_failed_retry_hls',
					startTimeSeconds: target.startTimeSeconds,
				};
			}
			throw error;
		}
	} catch (error) {
		if (callerSignal?.aborted) throw new EngineError('cancelled', '任务已取消。');
		if (deadline.aborted) throw new EngineError('timeout', '任务超过时间限制。');
		throw error;
	}
}

export const resolveVideo = (input, options) => execute('resolve', input, options);
export const downloadVideo = (input, options) => execute('download', input, options);
export {resolveVideo as resolve, downloadVideo as download};
