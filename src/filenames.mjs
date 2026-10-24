import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { EngineError, fileWriteError } from './process.mjs';

const MAX_STEM_BYTES = 180;
const NO_HARDLINK = new Set(['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV']);
const RESERVED = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu;
const meaningful = value => /[\p{L}\p{N}\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(value);
const sameFile = (a, b) => a?.isFile() && b?.isFile() && a.dev === b.dev && a.ino === b.ino;

function truncateUtf8(value, maxBytes) {
  let result = '', bytes = 0;
  for (const character of value) {
    const next = Buffer.byteLength(character, 'utf8');
    if (bytes + next > maxBytes) break;
    result += character; bytes += next;
  }
  return result;
}

function cleanTitle(value) {
  if (typeof value !== 'string') return '';
  return value.toWellFormed().normalize('NFC')
    // Titles are page text, not a safe place to retain embedded access data.
    .replace(/https?:\/\/[^\s<>]+/giu, ' ')
    .replace(/\bcookie\s*[:=][^\r\n]*/giu, ' ')
    .replace(/\b(?:authorization|xsec_token|access_token|refresh_token|id_token|token|signature)\s*[:=]\s*(?:(?:Bearer|Basic)\s+)?(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu, ' ')
    .replace(/[<>:"/\\|?*]/gu, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, character => ['\u200c', '\u200d'].includes(character) ? character : ' ')
    .replace(/\s+/gu, ' ').trim()
    .replace(/^[. ]+/u, '').replace(/[. ]+$/u, '')
    .replace(/\.mp4$/iu, '').replace(/[. ]+$/u, '');
}

/** A title-derived basename only; no directory or source URL can enter the path. */
export function videoFilename(title, { platform, id } = {}) {
  const safeId = typeof id === 'string' && /^[a-z\d_-]{1,128}$/iu.test(id) ? id : '';
  const safePlatform = typeof platform === 'string' && /^[a-z][a-z\d_-]{0,31}$/iu.test(platform) ? platform : '';
  const fallback = safeId ? [safePlatform, safeId].filter(Boolean).join('-') : '未命名视频';
  let stem = cleanTitle(title);
  if (!meaningful(stem)) stem = fallback;
  stem = truncateUtf8(stem, MAX_STEM_BYTES).replace(/[. ]+$/u, '');
  if (!meaningful(stem)) stem = fallback;
  if (RESERVED.test(stem)) stem = truncateUtf8(`_${stem}`, MAX_STEM_BYTES);
  return `${stem}.mp4`;
}

function checkAbort(signal) {
  if (signal?.aborted) throw new EngineError('cancelled', '任务已取消。');
}

async function removeOwned(filename, identity) {
  try { if (sameFile(await fs.lstat(filename), identity)) await fs.unlink(filename); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

/**
 * Publish a media file after its caller has validated it. Staging files may use
 * any extension; final output is always MP4 in the same canonical directory.
 * Exclusive publication prevents an existing or concurrently-created file from
 * being replaced, including on volumes without hard-link support.
 */
export async function publishVideoFile(sourcePath, options = {}) {
  if (typeof sourcePath !== 'string' || !sourcePath || sourcePath.includes('\0')
    || !options || typeof options !== 'object' || Array.isArray(options)) {
    throw new EngineError('invalid_options', '需要有效的媒体文件路径和命名选项。');
  }
  const { title, platform, id, signal } = options;
  if (signal !== undefined && (typeof signal?.aborted !== 'boolean' || typeof signal?.addEventListener !== 'function')) {
    throw new EngineError('invalid_options', 'signal 必须是 AbortSignal。');
  }
  checkAbort(signal);
  let source, sourceInfo;
  try {
    const requested = path.resolve(sourcePath);
    const directory = await fs.realpath(path.dirname(requested));
    source = path.join(directory, path.basename(requested));
    sourceInfo = await fs.lstat(source);
    // Refuse a source symlink rather than following it outside the task folder.
    if (!sourceInfo.isFile() || sourceInfo.size < 1) throw new Error('invalid source');
  } catch (error) {
    throw fileWriteError(error) ?? new EngineError('output_invalid', '无法读取已校验的媒体文件。');
  }
  const basename = videoFilename(title, { platform, id });
  const stem = basename.slice(0, -4), directory = path.dirname(source);
  let owned;
  try {
    for (let index = 1; index <= 1000; index++) {
      checkAbort(signal);
      const destination = path.join(directory, index === 1 ? basename : `${stem} (${index}).mp4`);
      if (destination === source) return source;
      try {
        try {
          await fs.link(source, destination);
          owned = { filename: destination, identity: sourceInfo };
        } catch (error) {
          if (!NO_HARDLINK.has(error.code)) throw error;
          await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
          owned = { filename: destination, identity: await fs.lstat(destination) };
        }
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // On case-insensitive filesystems a title differing only in case can
        // refer to the source itself. Return its existing spelling unchanged.
        if (path.basename(source).normalize('NFC').toLowerCase() === path.basename(destination).normalize('NFC').toLowerCase()
          && sameFile(await fs.lstat(destination), sourceInfo)) { checkAbort(signal); return source; }
        continue;
      }
      checkAbort(signal);
      const currentSource = await fs.lstat(source);
      const currentOutput = await fs.lstat(destination);
      if (!sameFile(currentSource, sourceInfo) || currentSource.size !== sourceInfo.size
        || currentSource.mtimeMs !== sourceInfo.mtimeMs || !sameFile(currentOutput, owned.identity)
        || currentOutput.size !== sourceInfo.size) {
        throw new EngineError('output_invalid', '保存时媒体文件发生变化，已停止交付。');
      }
      checkAbort(signal);
      await fs.unlink(source);
      checkAbort(signal);
      owned = null;
      return destination;
    }
    throw new EngineError('output_exists', '同名文件过多，请整理下载目录后重试。');
  } catch (error) {
    if (owned) await removeOwned(owned.filename, owned.identity).catch(() => {});
    if (signal?.aborted) throw new EngineError('cancelled', '任务已取消。');
    throw fileWriteError(error) ?? (error instanceof EngineError ? error : new EngineError('output_invalid', '无法按视频标题保存文件。'));
  }
}
