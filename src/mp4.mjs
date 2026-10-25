import {constants} from 'node:fs';
import fs, {copyFile, lstat, open, realpath, rm, stat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {EngineError, fileWriteError, runProcess} from './process.mjs';

const NO_HARDLINK = new Set(['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV']);
const sameFile = (a, b) => a?.isFile() && b?.isFile() && a.dev === b.dev && a.ino === b.ino;

function fail(code, message) {
	throw new EngineError(code, message);
}

function checkOptions(filepath, options) {
	if (typeof filepath !== 'string' || !filepath || filepath.includes('\0'))
		fail('invalid_options', '需要有效的本地媒体路径。');
	if (!options || typeof options !== 'object' || Array.isArray(options))
		fail('invalid_options', '媒体转换选项必须是对象。');
	for (const key of ['outputPath', 'ffmpegLocation', 'ffprobePath']) {
		if (
			options[key] !== undefined &&
			(typeof options[key] !== 'string' || !options[key] || options[key].includes('\0'))
		) {
			fail('invalid_options', `${key} 必须是有效路径。`);
		}
	}
	if (
		options.timeoutMs !== undefined &&
		(!Number.isSafeInteger(options.timeoutMs) ||
			options.timeoutMs < 1 ||
			options.timeoutMs > 2_147_483_647)
	) {
		fail('invalid_options', 'timeoutMs 必须是有效的正整数。');
	}
	if (
		options.signal !== undefined &&
		(typeof options.signal?.aborted !== 'boolean' ||
			typeof options.signal?.addEventListener !== 'function')
	) {
		fail('invalid_options', 'signal 必须是 AbortSignal。');
	}
}

async function binaries(options) {
	let ffmpeg = 'ffmpeg';
	let ffprobe = options.ffprobePath ?? 'ffprobe';
	if (options.ffmpegLocation) {
		const location = path.resolve(options.ffmpegLocation);
		let directory = false;
		try {
			directory = (await stat(location)).isDirectory();
		} catch {
			/* Spawn reports a missing executable safely. */
		}
		const suffix = process.platform === 'win32' ? '.exe' : '';
		ffmpeg = directory ? path.join(location, `ffmpeg${suffix}`) : location;
		if (!options.ffprobePath)
			ffprobe = path.join(directory ? location : path.dirname(location), `ffprobe${suffix}`);
	}
	return {ffmpeg, ffprobe};
}

async function probe(filepath, binary, settings) {
	const result = await runProcess(
		binary,
		['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filepath],
		{
			...settings,
			maxOutputBytes: 2 * 1024 * 1024,
		},
	);
	if (result.code !== 0) fail('output_invalid', '媒体文件无法通过 ffprobe 校验。');
	let data;
	try {
		data = JSON.parse(result.stdout);
	} catch {
		fail('output_invalid', '媒体校验工具未返回有效结果。');
	}
	const streams = Array.isArray(data?.streams) ? data.streams : [];
	const videos = streams.filter((stream) => stream.codec_type === 'video');
	const audio = streams.filter((stream) => stream.codec_type === 'audio');
	const video = videos[0];
	const duration = Number(data?.format?.duration);
	if (
		!video ||
		video.disposition?.attached_pic ||
		!Number.isInteger(video.width) ||
		video.width < 1 ||
		!Number.isInteger(video.height) ||
		video.height < 1 ||
		!Number.isFinite(duration) ||
		duration <= 0
	) {
		fail('output_invalid', '媒体缺少可用的主视频轨或有效时长。');
	}
	return {
		video,
		videos,
		audio,
		duration,
		mp4: String(data.format?.format_name ?? '')
			.split(',')
			.some((name) => name === 'mp4' || name === 'mov'),
		compatibleVideo: videos.every(
			(stream) => stream.codec_name === 'h264' && stream.pix_fmt === 'yuv420p',
		),
		compatibleAudio: audio.every(
			(stream) => stream.codec_name === 'aac' && Number(stream.channels) > 0,
		),
	};
}

function validateConverted(source, output) {
	const tolerance = Math.max(0.5, Math.min(3, source.duration * 0.001));
	if (
		!output.mp4 ||
		!output.compatibleVideo ||
		!output.compatibleAudio ||
		(source.audio.length > 0 && output.audio.length === 0) ||
		output.video.width !== source.video.width ||
		output.video.height !== source.video.height ||
		Math.abs(output.duration - source.duration) > tolerance
	) {
		fail('output_invalid', 'MP4 校验失败：编码、音轨、分辨率或时长与要求不符。');
	}
}

/** Create a broadly playable H.264/yuv420p + AAC MP4 without deleting the source. */
export async function ensureCompatibleMp4(filepath, options = {}) {
	const startedAt = Date.now();
	checkOptions(filepath, options);
	const timeoutMs = options.timeoutMs ?? 30 * 60_000;
	const remaining = () => {
		if (options.signal?.aborted) fail('cancelled', '任务已取消。');
		const milliseconds = timeoutMs - (Date.now() - startedAt);
		if (milliseconds < 1) fail('timeout', '媒体转换超过时间限制。');
		return milliseconds;
	};
	remaining();
	let sourcePath;
	try {
		sourcePath = await realpath(path.resolve(filepath));
		const sourceStat = await stat(sourcePath);
		if (!sourceStat.isFile() || sourceStat.size < 1) throw new Error('invalid source');
	} catch {
		fail('output_invalid', '源媒体文件不存在或不是有效文件。');
	}
	const directory = path.dirname(sourcePath);
	const paths = await binaries(options);
	const source = await probe(sourcePath, paths.ffprobe, {
		signal: options.signal,
		timeoutMs: remaining(),
	});
	const sourceIsMp4 = path.extname(sourcePath).toLowerCase() === '.mp4' && source.mp4;
	const compatible = source.compatibleVideo && source.compatibleAudio;
	if (compatible && sourceIsMp4 && options.outputPath === undefined) {
		remaining();
		return {
			filepath: sourcePath,
			mode: 'copy',
			videoCodec: 'h264',
			audioCodec: source.audio.length ? 'aac' : null,
		};
	}
	const basename = path.basename(sourcePath, path.extname(sourcePath));
	const destination =
		options.outputPath === undefined
			? path.join(
					directory,
					`${basename}${path.extname(sourcePath).toLowerCase() === '.mp4' ? '-compatible' : ''}.mp4`,
				)
			: path.resolve(options.outputPath);
	let destinationDirectory;
	try {
		destinationDirectory = await realpath(path.dirname(destination));
	} catch {
		fail('invalid_options', '输出目录必须已存在并与源文件相同。');
	}
	if (
		destinationDirectory !== directory ||
		path.extname(destination).toLowerCase() !== '.mp4' ||
		(destinationDirectory === directory && path.basename(destination) === path.basename(sourcePath))
	) {
		fail('invalid_options', '输出必须是源文件同目录的新 MP4 文件，不能覆盖源文件。');
	}
	// Use the canonical directory after validating aliases/symlinks.
	const finalPath = path.join(directory, path.basename(destination));
	try {
		await lstat(finalPath);
		fail('output_exists', '目标文件已存在，请选择新的输出文件名。');
	} catch (error) {
		if (error instanceof EngineError) throw error;
		if (error.code !== 'ENOENT') fail('output_invalid', '无法检查输出文件路径。');
	}
	const selectedStreamsCompatible =
		source.video.codec_name === 'h264' &&
		source.video.pix_fmt === 'yuv420p' &&
		(source.audio.length === 0 ||
			(source.audio[0].codec_name === 'aac' && Number(source.audio[0].channels) > 0));
	const mode =
		compatible && sourceIsMp4 ? 'copy' : selectedStreamsCompatible ? 'remux' : 'transcode';
	const temporary = path.join(directory, `.fetchy-mp4-${randomUUID()}.mp4`);
	let ownedTemporary = false,
		ownedOutput;
	try {
		remaining();
		const handle = await open(temporary, 'wx', 0o600);
		ownedTemporary = true;
		await handle.close();
		if (mode === 'copy') {
			await copyFile(sourcePath, temporary, constants.COPYFILE_FICLONE);
		} else {
			const args = [
				'-hide_banner',
				'-loglevel',
				'error',
				'-nostdin',
				'-y',
				'-noautorotate',
				'-i',
				sourcePath,
				'-map',
				'0:v:0',
				'-map',
				'0:a:0?',
				'-map_metadata',
				'-1',
				'-map_chapters',
				'-1',
			];
			if (source.video.codec_name === 'h264' && source.video.pix_fmt === 'yuv420p')
				args.push('-c:v', 'copy');
			else
				args.push(
					'-c:v',
					'libx264',
					'-crf',
					'20',
					'-preset',
					'veryfast',
					'-pix_fmt',
					'yuv420p',
					'-fps_mode',
					'passthrough',
				);
			if (source.audio.length) {
				if (source.audio[0].codec_name === 'aac') args.push('-c:a', 'copy');
				else args.push('-c:a', 'aac', '-b:a', '192k');
			}
			args.push('-movflags', '+faststart', '-f', 'mp4', temporary);
			const result = await runProcess(paths.ffmpeg, args, {
				signal: options.signal,
				timeoutMs: remaining(),
			});
			if (result.code !== 0)
				throw (
					fileWriteError(result.stderr) ??
					new EngineError(
						'conversion_failed',
						'无法转换为兼容 MP4，请检查媒体文件与 FFmpeg 编码器。',
					)
				);
		}
		remaining();
		const output = await probe(temporary, paths.ffprobe, {
			signal: options.signal,
			timeoutMs: remaining(),
		});
		validateConverted(source, output);
		remaining();
		// Both paths exclusively create the output, including on volumes without hard links.
		try {
			const temporaryInfo = await lstat(temporary);
			try {
				await fs.link(temporary, finalPath);
				ownedOutput = temporaryInfo;
			} catch (error) {
				if (!NO_HARDLINK.has(error.code)) throw error;
				await fs.copyFile(temporary, finalPath, constants.COPYFILE_EXCL);
				ownedOutput = await lstat(finalPath);
			}
			remaining();
			const outputInfo = await lstat(finalPath);
			if (!sameFile(outputInfo, ownedOutput) || outputInfo.size !== temporaryInfo.size)
				fail('output_invalid', '保存时 MP4 文件发生变化，已停止交付。');
			remaining();
		} catch (error) {
			if (error instanceof EngineError) throw error;
			if (error.code === 'EEXIST') fail('output_exists', '目标文件已存在，请选择新的输出文件名。');
			const storageError = fileWriteError(error);
			if (storageError) throw storageError;
			fail('output_invalid', '无法保存已验证的 MP4 文件。');
		}
		ownedOutput = null;
		return {
			filepath: finalPath,
			mode,
			videoCodec: 'h264',
			audioCodec: output.audio.length ? 'aac' : null,
		};
	} catch (error) {
		if (ownedOutput)
			await lstat(finalPath)
				.then((info) => (sameFile(info, ownedOutput) ? rm(finalPath, {force: true}) : undefined))
				.catch(() => {});
		const storageError = fileWriteError(error);
		if (storageError) throw storageError;
		if (error instanceof EngineError) throw error;
		fail('output_invalid', '无法创建或处理临时 MP4 文件。');
	} finally {
		if (ownedTemporary) await rm(temporary, {force: true}).catch(() => {});
	}
}
