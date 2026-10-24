import { spawn } from 'node:child_process';

export class EngineError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}

/** Recognize local storage failures without exposing filenames or tool output. */
export function fileWriteError(value) {
  const code = typeof value === 'object' && value ? value.code : null;
  const message = typeof value === 'string' ? value : '';
  if (['ENOSPC', 'EDQUOT'].includes(code) || /\bENOSPC\b|\bEDQUOT\b|no space left on device|disk quota exceeded|disk (?:is )?full/i.test(message)) {
    return new EngineError('disk_full', '磁盘空间不足，请释放空间或选择其他下载目录。');
  }
  if (['EACCES', 'EPERM', 'EROFS'].includes(code)
    || /\bEACCES\b|\bEPERM\b|\bEROFS\b|\[Errno (?:13|30)\]|read-only file system/i.test(message)
    || /permission denied/i.test(message) && /unable to (?:open|write|create)|error opening output|writing (?:to )?(?:file|output)|output file/i.test(message)) {
    return new EngineError('directory_unwritable', '无法写入下载目录，请检查目录权限或选择其他文件夹。');
  }
  return null;
}

/** Spawn without a shell. Never place untrusted process output in thrown errors. */
export function runProcess(command, args, { signal, timeoutMs = 60_000, maxOutputBytes = 16 * 1024 * 1024 } = {}) {
  if (signal?.aborted) return Promise.reject(new EngineError('cancelled', '任务已取消。'));
  return new Promise((resolve, reject) => {
    let child;
    let timer;
    let forceTimer;
    let stopped;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout = [];
    const stderr = [];
    const detached = process.platform !== 'win32';
    const kill = (kind) => {
      try {
        if (detached && child.pid) process.kill(-child.pid, kind);
        else child.kill(kind);
      } catch { /* The process may already have exited. */ }
    };
    const stop = (error) => {
      if (stopped) return;
      stopped = error;
      kill('SIGTERM');
      forceTimer = setTimeout(() => kill('SIGKILL'), 1_000);
      forceTimer.unref();
    };
    const abort = () => stop(new EngineError('cancelled', '任务已取消。'));
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      signal?.removeEventListener('abort', abort);
    };
    try {
      child = spawn(command, args, { shell: false, detached, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch {
      reject(new EngineError('dependency_missing', '无法启动下载或媒体校验工具，请检查依赖路径。'));
      return;
    }
    child.on('error', () => {
      cleanup();
      reject(new EngineError('dependency_missing', '无法启动下载或媒体校验工具，请检查依赖路径。'));
    });
    child.stdout.on('data', (data) => {
      stdoutBytes += data.length;
      if (stdoutBytes + stderrBytes > maxOutputBytes) stop(new EngineError('engine_error', '工具输出超出大小限制。'));
      else stdout.push(data);
    });
    child.stderr.on('data', (data) => {
      stderrBytes += data.length;
      if (stdoutBytes + stderrBytes > maxOutputBytes) stop(new EngineError('engine_error', '工具输出超出大小限制。'));
      else stderr.push(data);
    });
    child.on('close', (code) => {
      cleanup();
      if (stopped) reject(stopped);
      else resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    timer = setTimeout(() => stop(new EngineError('timeout', '任务超过时间限制。')), timeoutMs);
    timer.unref();
  });
}
