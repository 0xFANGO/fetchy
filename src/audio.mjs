import {resolveTarget} from './urls.mjs';
import {downloadWithYtDlp, resolveWithYtDlp} from './yt-dlp.mjs';
import {ytDlpCommand} from './dependencies.mjs';
import {EngineError} from './process.mjs';

async function audio(input, options, action, defaultTimeout) {
	const timeoutMs = options.timeoutMs ?? defaultTimeout;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647)
		throw new EngineError('invalid_options', 'timeoutMs 必须是有效正整数。');
	if (options.engine && !['auto', 'yt-dlp'].includes(options.engine))
		throw new EngineError('invalid_options', '音频下载使用 yt-dlp。');
	const deadline = AbortSignal.timeout(timeoutMs);
	const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
	try {
		if (signal.aborted) throw new EngineError('cancelled', '任务已取消。');
		const target = await resolveTarget(input, {...options, signal});
		const result = await action(
			target,
			{...options, timeoutMs, signal, ytDlpPath: ytDlpCommand(options)},
			'audio',
		);
		return {...result, kind: 'audio'};
	} catch (error) {
		if (options.signal?.aborted) throw new EngineError('cancelled', '任务已取消。');
		if (deadline.aborted) throw new EngineError('timeout', '任务超过时间限制。');
		throw error;
	}
}
export const resolveAudio = (input, options = {}) =>
	audio(input, options, resolveWithYtDlp, 60_000);
export const downloadAudio = (input, options = {}) =>
	audio(input, options, downloadWithYtDlp, 30 * 60_000);
