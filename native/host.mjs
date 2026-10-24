#!/usr/bin/env node
import net from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { MessageDecoder, encodeMessage } from './protocol.mjs';
import { dataDirectory, privateDirectory, readJson } from './settings.mjs';

process.umask(0o077);
const directory = dataDirectory();
const socketPath = path.join(directory, 'bridge.sock');
function connect() {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once('connect', () => { socket.removeListener('error', reject); resolve(socket); });
    socket.once('error', reject);
  });
}
try {
  await privateDirectory(directory);
  const runtime = await readJson(path.join(directory, 'runtime.json'));
  if (!runtime?.extensionId || process.argv[2] !== `chrome-extension://${runtime.extensionId}/`) process.exit(1);
  if (typeof runtime.path === 'string') process.env.PATH = runtime.path;
  let socket;
  try { socket = await connect(); } catch {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./daemon.mjs', import.meta.url))], {
      detached: true, stdio: 'ignore', env: { ...process.env, FANGO_DATA_DIR: directory },
    });
    child.on('error', () => {}); child.unref();
    for (let attempt = 0; attempt < 60 && !socket; attempt++) {
      await delay(100);
      try { socket = await connect(); } catch {}
    }
  }
  if (!socket) process.exit(1);
  socket.on('error', () => process.exit(1));
  socket.on('close', () => process.exit(0));
  const incoming = new MessageDecoder();
  incoming.on('error', () => { socket.destroy(); process.exit(1); });
  incoming.on('data', (message) => socket.write(encodeMessage(message)));
  process.stdin.pipe(incoming);
  socket.pipe(process.stdout);
  process.stdin.on('end', () => socket.end());
  process.stdin.on('error', () => socket.destroy());
  process.stdout.on('error', () => socket.destroy());
} catch { process.exit(1); }
