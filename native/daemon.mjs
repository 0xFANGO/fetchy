#!/usr/bin/env node
import {rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {NativeController} from './controller.mjs';
import {dataDirectory, privateDirectory, readJson} from './settings.mjs';
import {startServer} from './server.mjs';
import {shouldStopIdle} from './lifecycle.mjs';
import {acquireDaemonLock} from './daemon-lock.mjs';

process.umask(0o077);
const directory = dataDirectory();
const lockDirectory = path.join(directory, 'daemon.lock');
const socketPath = path.join(directory, 'bridge.sock');
let lock,
	bridge,
	controller,
	shuttingDown = false;
async function shutdown() {
	if (shuttingDown) return;
	shuttingDown = true;
	await controller?.close().catch(() => {});
	await bridge?.close().catch(() => {});
	await lock?.release().catch(() => {});
	process.exit(0);
}
try {
	await privateDirectory(directory);
	lock = await acquireDaemonLock(lockDirectory, fileURLToPath(import.meta.url));
	if (!lock) process.exit(0);
	const runtime = await readJson(path.join(directory, 'runtime.json'), {});
	if (typeof runtime.path === 'string') process.env.PATH = runtime.path;
	controller = await new NativeController({
		directory,
		engineOptions: runtime.engineOptions ?? {},
	}).initialize();
	await rm(socketPath, {force: true});
	bridge = await startServer(controller, socketPath);
	process.on('SIGTERM', shutdown);
	process.on('SIGINT', shutdown);
	const idleTimer = setInterval(() => {
		if (shouldStopIdle(controller, bridge)) void shutdown();
	}, 30_000);
	idleTimer.unref();
} catch {
	await lock?.release().catch(() => {});
	process.exit(1);
}
