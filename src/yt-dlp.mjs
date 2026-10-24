import { copyFile, chmod, mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EngineError, fileWriteError, runProcess } from './process.mjs';
import { ensureCompatibleMp4 } from './mp4.mjs';
import { pickPublicThumbnail } from './thumbnails.mjs';
import { publishVideoFile } from './filenames.mjs';

export { EngineError } from './process.mjs';

const COMMON_ARGS = [
  '--ignore-config', '--no-plugin-dirs', '--no-playlist', '--no-progress', '--no-warnings',
  '--retries', '2', '--fragment-retries', '2', '--concurrent-fragments', '8', '--socket-timeout', '20',
  '--abort-on-unavailable-fragments', '--no-mark-watched', '--no-cookies-from-browser',
  '--no-cache-dir', '--no-remote-components', '--no-color',
];

const number = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const codecPresent = (value) => typeof value === 'string' && value !== '' && value !== 'none' ? true : value === 'none' ? false : null;

export function classifyEngineError(text = '') {
  // Source URLs, signed parameters and credentials never leave this classifier.
  const storageError = fileWriteError(text);
  if (storageError) return storageError;
  if (/DRM|digital rights management/i.test(text)) return new EngineError('drm', '该内容包含 DRM 保护，无法通过此方法下载。');
  if (/fresh cookies/i.test(text)) return new EngineError('session_required', '平台需要有效浏览器会话，请使用 browser 引擎。');
  if (/captcha|verify you|verification|not a bot|sign in to confirm|验证码|验证/i.test(text)) return new EngineError('verification_required', '平台要求验证，请在浏览器完成验证后重试。');
  if (/login|log in|sign in|authentication|cookies|members.only|premium|purchase|会员|登录/i.test(text)) return new EngineError('auth_required', '该内容需要有效的登录或访问权限。');
  if (/ffmpeg.*not (?:installed|found)|ffprobe.*not (?:installed|found)|no supported javascript runtime|EJS.*not|No such file or directory/i.test(text)) return new EngineError('dependency_missing', '缺少下载所需的本地依赖。');
  if (/requested format is not available|no video formats|no formats|only images/i.test(text)) return new EngineError('no_formats', '没有符合要求的视频格式。');
  if (/not available|unavailable|deleted|removed|private video|not found|404|geo.?restrict|not support|直播/i.test(text)) return new EngineError('unavailable', '该内容不可用或不在当前支持范围内。');
  if (/timed? ?out|timeout|connection|network|unable to download|HTTP Error|SSL|TLS|certificate|remote end closed/i.test(text)) return new EngineError('network_error', '请求失败，请检查网络或稍后重试。');
  return new EngineError('engine_error', '下载工具未能完成解析或下载，请检查工具版本及平台可用性。');
}

function optionsChecked(options) {
  if (options.maxHeight !== undefined && (!Number.isSafeInteger(options.maxHeight) || options.maxHeight < 1 || options.maxHeight > 16384)) {
    throw new EngineError('invalid_options', 'maxHeight 必须是 1–16384 的整数。');
  }
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 2_147_483_647)) {
    throw new EngineError('invalid_options', 'timeoutMs 必须是有效的正整数。');
  }
  if (options.format !== undefined) throw new EngineError('invalid_options', '当前版本请用 maxHeight 选择画质，暂不接受自定义 format。');
  if (options.transport !== undefined && !['auto', 'hls'].includes(options.transport)) throw new EngineError('invalid_options', 'transport 只能是 auto 或 hls。');
  for (const field of ['ytDlpPath', 'ffprobePath', 'ffmpegLocation', 'cookiesFile', 'outputDir']) {
    if (options[field] !== undefined && (typeof options[field] !== 'string' || !options[field] || options[field].includes('\0'))) {
      throw new EngineError('invalid_options', `${field} 必须是有效路径。`);
    }
  }
}

function formatSelector(options, compatible = false) {
  const height = options.maxHeight ? `[height<=${options.maxHeight}]` : '';
  const protocol = options.transport === 'hls' ? '[protocol^=m3u8]' : '';
  const source = `bv*${height}${protocol}+ba${protocol}/b${height}${protocol}`;
  if (!compatible) return source;
  const avc = '[vcodec~="^(?:avc[13]|h264)(?:[.]|$)"]';
  const aac = '[acodec~="^(?:mp4a[.]40[.]|aac(?:[.]|$))"]';
  const compatibleAudio = '[acodec~="^(?:none$|mp4a[.]40[.]|aac(?:[.]|$))"]';
  // HLS can omit the audio codec. Preserve native H.264 before considering
  // non-H.264 video; the MP4 helper probes and converts unknown/non-AAC audio.
  return `bv*${height}${protocol}${avc}${compatibleAudio}+ba${protocol}${aac}/b${height}${protocol}${avc}${aac}/bv${height}${protocol}${avc}+ba${protocol}/b${height}${protocol}${avc}/${source}`;
}

function argsFor(options, compatible = false) {
  const args = [...COMMON_ARGS, '--format', formatSelector(options, compatible)];
  // This project already requires Node >= 22; make it available for YouTube's JS challenges.
  args.push('--js-runtimes', `node:${process.execPath}`);
  if (options.ffmpegLocation) args.push('--ffmpeg-location', options.ffmpegLocation);
  if (options._cookiesFile) args.push('--cookies', options._cookiesFile);
  else args.push('--no-cookies');
  return args;
}

function emit(options, stage, extra = {}) {
  // Observers must not turn a completed download into a reported failure.
  if (typeof options.onProgress === 'function') {
    try { options.onProgress({ stage, engine: 'yt-dlp', ...extra }); } catch { /* observer only */ }
  }
}

async function withCookies(options, action) {
  if (!options.cookiesFile) return action(options);
  let directory;
  try {
    const source = path.resolve(options.cookiesFile);
    const sourceStat = await stat(source);
    if (!sourceStat.isFile() || sourceStat.size > 16 * 1024 * 1024) throw new Error('invalid cookies file');
    // yt-dlp writes its cookie jar back on exit. Give it a private copy, not the user's original file.
    directory = await mkdtemp(path.join(tmpdir(), 'fango-cookies-'));
    await chmod(directory, 0o700);
    const destination = path.join(directory, 'cookies.txt');
    await copyFile(source, destination);
    await chmod(destination, 0o600);
    return await action({ ...options, _cookiesFile: destination });
  } catch (error) {
    if (error instanceof EngineError) throw error;
    if (directory) throw new EngineError('engine_error', '使用 Cookie 文件时任务未能完成。');
    throw new EngineError('invalid_options', '无法读取 cookiesFile，必须是有效的 Netscape cookies 文件。');
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

function parseObject(output, errorCode = 'engine_error') {
  try {
    const value = JSON.parse(output);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch {
    throw new EngineError(errorCode, '工具没有返回有效的媒体信息。');
  }
}

function selectedFormats(info) {
  if (Array.isArray(info.requested_formats) && info.requested_formats.length) return info.requested_formats;
  if (Array.isArray(info.requested_downloads) && info.requested_downloads.length) {
    return info.requested_downloads.flatMap((item) => item.requested_formats ?? [item]);
  }
  return [info];
}

function assertIdentity(target, info) {
  const id = String(info.id ?? '');
  let matches = id === target.id;
  if (target.platform === 'bilibili') {
    const page = target.page ?? 1;
    if (/^BV[\w]{10}$/.test(target.id)) {
      matches = id === target.id && page === 1 || id === target.id + '_p' + page;
    } else if (/^av\d+$/.test(target.id)) {
      // Upstream maps AV IDs to BV IDs and retains the original aid/part archive alias.
      const aliases = Array.isArray(info._old_archive_ids) ? info._old_archive_ids : [];
      matches = aliases.includes('bilibili ' + target.id.slice(2) + '_part' + page);
    }
  }
  if (!matches) throw new EngineError('wrong_video', '解析结果与目标视频或分 P 不一致，已停止下载。');
}

async function metadata(target, options) {
  const result = await runProcess(options.ytDlpPath ?? 'yt-dlp', [...argsFor(options), '--dump-single-json', '--skip-download', '--', target.url], {
    signal: options.signal, timeoutMs: Math.min(options.timeoutMs ?? 60_000, 60_000),
  });
  if (result.code !== 0) throw classifyEngineError(result.stderr);
  const info = parseObject(result.stdout);
  if (info._type === 'playlist' || Array.isArray(info.entries)) throw new EngineError('unavailable', '当前方法只接受单个视频，不下载整个合集。');
  if (info.is_live || ['is_live', 'is_upcoming', 'post_live'].includes(info.live_status)) throw new EngineError('unavailable', '当前版本不下载直播或尚未完成处理的视频。');
  assertIdentity(target, info);
  const formats = Array.isArray(info.formats) ? info.formats : [info];
  if (info.has_drm === true || (formats.length > 0 && formats.every((item) => item.has_drm === true))) throw new EngineError('drm', '该内容包含 DRM 保护。');
  if (!formats.some((item) => codecPresent(item.vcodec) !== false && item.has_drm !== true && (item.url || item.format_id))) {
    throw new EngineError('no_formats', '没有可下载的视频格式。');
  }
  return info;
}

function publicMetadata(target, info) {
  return {
    platform: target.platform,
    id: target.id,
    sourceId: String(info.id),
    title: typeof info.title === 'string' ? info.title : target.id,
    thumbnailUrl: pickPublicThumbnail([info.thumbnail,
      ...(Array.isArray(info.thumbnails) ? [...info.thumbnails].reverse().map(item => item?.url) : []),
    ], target),
    durationSeconds: number(info.duration),
    formats: (Array.isArray(info.formats) ? info.formats : [info]).filter((item) => item.has_drm !== true).map((item) => ({
      id: String(item.format_id ?? 'unknown'),
      ext: item.ext ?? null,
      protocol: item.protocol ?? null,
      width: number(item.width), height: number(item.height), fps: number(item.fps),
      vcodec: item.vcodec ?? null, acodec: item.acodec ?? null,
      // yt-dlp tbr is kbit/s; the shared contract uses bit/s.
      bitrate: number(item.tbr) === null ? null : item.tbr * 1000, size: number(item.filesize) ?? number(item.filesize_approx),
      hasVideo: codecPresent(item.vcodec), hasAudio: codecPresent(item.acodec),
    })),
    engine: 'yt-dlp',
    availability: 'ready',
  };
}

export async function resolveWithYtDlp(target, options = {}) {
  optionsChecked(options);
  emit(options, 'resolving');
  return withCookies(options, async (settings) => publicMetadata(target, await metadata(target, settings)));
}

async function validateTaskFile(filepath, directory) {
  let outputStat;
  try {
    const actual = await realpath(filepath);
    const root = await realpath(directory);
    if (path.dirname(actual) !== root) throw new Error('outside task directory');
    outputStat = await stat(actual);
    if (!outputStat.isFile() || outputStat.size < 1) throw new Error('empty output');
  } catch {
    throw new EngineError('output_invalid', '下载没有产生有效的任务内媒体文件。');
  }
  return outputStat;
}

async function validateOutput(filepath, directory, info, options) {
  const outputStat = await validateTaskFile(filepath, directory);
  const result = await runProcess(options.ffprobePath ?? 'ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filepath], {
    signal: options.signal, timeoutMs: Math.min(options.timeoutMs ?? 30_000, 30_000), maxOutputBytes: 2 * 1024 * 1024,
  });
  if (result.code !== 0) throw new EngineError('output_invalid', '下载文件无法通过媒体校验。');
  const probe = parseObject(result.stdout, 'output_invalid');
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const videoStreams = streams.filter((item) => item.codec_type === 'video' && !item.disposition?.attached_pic && item.width > 0 && item.height > 0);
  const audioStreams = streams.filter((item) => item.codec_type === 'audio' && Number(item.channels) > 0);
  const expected = selectedFormats(info).map((item) => codecPresent(item.acodec));
  // Unknown audio metadata is not enough to declare a silent output successful.
  const expectAudio = expected.some((value) => value === true) || expected.some((value) => value === null);
  const durationSeconds = Number(probe.format?.duration);
  if (!videoStreams.length || (expectAudio && !audioStreams.length) || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new EngineError('output_invalid', '下载文件缺少视频、预期音频或有效时长。');
  }
  if (number(info.duration) > 0 && durationSeconds < info.duration - Math.max(3, info.duration * 0.01)) {
    throw new EngineError('output_invalid', '下载文件的时长明显短于源视频，可能不完整。');
  }
  const mp4Container = path.extname(filepath).toLowerCase() === '.mp4'
    && String(probe.format?.format_name ?? '').split(',').includes('mp4');
  if (!mp4Container || videoStreams.some((item) => item.codec_name !== 'h264' || item.pix_fmt !== 'yuv420p')
    || audioStreams.some((item) => item.codec_name !== 'aac')) {
    throw new EngineError('output_invalid', '最终文件不是兼容的 MP4（H.264/yuv420p 与 AAC），不能报告下载成功。');
  }
  return {
    bytes: outputStat.size,
    validation: {
      video: true, audio: audioStreams.length > 0, durationSeconds,
      container: 'mp4', videoCodec: videoStreams[0].codec_name,
      audioCodec: audioStreams[0]?.codec_name ?? null, pixelFormat: videoStreams[0].pix_fmt,
      width: videoStreams[0].width, height: videoStreams[0].height,
      compatibleMp4: true, method: 'ffprobe', fullDecode: false,
    },
  };
}

export async function downloadWithYtDlp(target, options = {}) {
  optionsChecked(options);
  const timeoutMs = options.timeoutMs ?? 30 * 60_000;
  const startedAt = Date.now();
  const remaining = () => {
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs < 1) throw new EngineError('timeout', '任务超过时间限制。');
    return remainingMs;
  };
  return withCookies(options, async (settings) => {
    emit(options, 'resolving');
    const info = await metadata(target, { ...settings, timeoutMs: remaining() });
    const outputDir = path.resolve(settings.outputDir ?? 'downloads');
    let directory;
    try {
      await mkdir(outputDir, { recursive: true });
      directory = await mkdtemp(path.join(outputDir, 'video-'));
    } catch (error) {
      throw fileWriteError(error) ?? new EngineError('output_invalid', '无法创建下载目录。');
    }
    let successful = false;
    try {
      const receipt = path.join(directory, 'result.json');
      emit(options, 'downloading');
      const result = await runProcess(settings.ytDlpPath ?? 'yt-dlp', [
        ...argsFor(settings, true), '--no-simulate', '--no-overwrites', '--merge-output-format', 'mkv',
        '--match-filters', '!is_live', '--output', path.join(directory.replaceAll('%', '%%'), 'media.%(ext)s'),
        // Serialize the projected object once: optional missing fields otherwise render bare NA.
        '--print-to-file', 'after_move:%(.{filepath,id,_old_archive_ids})j', receipt.replaceAll('%', '%%'), '--', target.url,
      ], { signal: settings.signal, timeoutMs: remaining() });
      if (result.code !== 0) throw classifyEngineError(result.stderr);
      let filepath;
      let record;
      try {
        const receiptStat = await stat(receipt);
        if (receiptStat.size > 32_768) throw new Error('receipt size');
        record = parseObject((await readFile(receipt, 'utf8')).trim(), 'output_invalid');
        if (typeof record.filepath !== 'string') throw new Error('receipt path');
        filepath = path.resolve(record.filepath);
      } catch {
        throw new EngineError('output_invalid', '下载工具没有确认最终媒体文件。');
      }
      assertIdentity(target, record);
      await validateTaskFile(filepath, directory);
      const sourceFilepath = await realpath(filepath);
      emit(options, 'postprocessing');
      const conversion = await ensureCompatibleMp4(sourceFilepath, { ...settings, timeoutMs: remaining() });
      filepath = conversion.filepath;
      emit(options, 'validating');
      const validation = await validateOutput(filepath, directory, info, { ...settings, timeoutMs: remaining() });
      if (sourceFilepath !== filepath) await rm(sourceFilepath, { force: true });
      await rm(receipt, { force: true });
      filepath = await publishVideoFile(filepath, { title: info.title, platform: target.platform, id: target.id, signal: settings.signal });
      successful = true;
      const output = { platform: target.platform, id: target.id, sourceId: String(record.id), engine: 'yt-dlp', filepath, transport: options.transport ?? 'auto', selectionPolicy: 'prefer-native-h264-aac', conversion: conversion.mode, ...validation };
      emit(options, 'complete', { filepath, bytes: output.bytes });
      return output;
    } catch (error) {
      throw fileWriteError(error) ?? error;
    } finally {
      // A failed/cancelled job is never left looking like a completed media file.
      if (!successful) await rm(directory, { recursive: true, force: true });
    }
  });
}
