#!/usr/bin/env node
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NativeController } from './controller.mjs';
import { dataDirectory, privateDirectory, readJson } from './settings.mjs';
import { startServer } from './server.mjs';
import { shouldStopIdle } from './lifecycle.mjs';

process.umask(0o077);
const directory = dataDirectory();
const lockDirectory = path.join(directory, 'daemon.lock');
const socketPath = path.join(directory, 'bridge.sock');
let ownsLock = false;
async function acquireLock() {
  try { await mkdir(lockDirectory, { mode: 0o700 }); ownsLock = true; await writeFile(path.join(lockDirectory, 'pid'), String(process.pid), { mode: 0o600 }); return true; }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let pid;
    try { pid = Number(await readFile(path.join(lockDirectory, 'pid'), 'utf8')); } catch {}
    if (Number.isSafeInteger(pid) && pid > 1) { try { process.kill(pid, 0); return false; } catch (e) { if (e.code !== 'ESRCH') return false; } }
    else { const info = await stat(lockDirectory).catch(() => null); if (info && Date.now() - info.mtimeMs < 10000) return false; }
    await rm(lockDirectory, { recursive: true, force: true });
    return acquireLock();
  }
}
let bridge, controller, shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return; shuttingDown = true;
  await controller?.close().catch(() => {});
  await bridge?.close().catch(() => {});
  if (ownsLock) await rm(lockDirectory, { recursive: true, force: true }).catch(() => {});
  process.exit(0);
}
try {
  await privateDirectory(directory);
  if (!await acquireLock()) process.exit(0);
  const runtime = await readJson(path.join(directory, 'runtime.json'), {});
  if (typeof runtime.path === 'string') process.env.PATH = runtime.path;
  controller = await new NativeController({ directory, engineOptions: runtime.engineOptions ?? {} }).initialize();
  await rm(socketPath, { force: true });
  bridge = await startServer(controller, socketPath);
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
  const idleTimer = setInterval(() => {
    if (shouldStopIdle(controller, bridge)) void shutdown();
  }, 30_000);
  idleTimer.unref();
} catch {
  if (ownsLock) await rm(lockDirectory, { recursive: true, force: true }).catch(() => {});
  process.exit(1);
}
