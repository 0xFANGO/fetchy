import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {acquireDaemonLock, processIdentity} from '../native/daemon-lock.mjs';
import {encodeMessage, MessageDecoder} from '../native/protocol.mjs';

const daemonPath = fileURLToPath(new URL('../native/daemon.mjs', import.meta.url));
async function fixture(t) {
	const directory = await mkdtemp('/tmp/fetchy-lock-');
	const children = [];
	t.after(async () => {
		for (const child of children) {
			if (child.exitCode !== null || child.signalCode) continue;
			const exited = once(child, 'exit');
			child.kill('SIGTERM');
			const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
			await exited;
			clearTimeout(timer);
		}
		await rm(directory, {recursive: true, force: true});
	});
	return {
		directory,
		lockDirectory: path.join(directory, 'daemon.lock'),
		start() {
			const child = spawn(process.execPath, [daemonPath], {
				env: {...process.env, FETCHY_DATA_DIR: directory},
				stdio: 'ignore',
			});
			children.push(child);
			return child;
		},
	};
}

function state(directory) {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(path.join(directory, 'bridge.sock'));
		const decoder = new MessageDecoder();
		const timer = setTimeout(() => finish(new Error('socket timeout')), 500);
		function finish(error, result) {
			clearTimeout(timer);
			socket.destroy();
			if (error) reject(error);
			else resolve(result);
		}
		socket.on('error', finish);
		decoder.on('error', finish);
		socket.pipe(decoder);
		socket.once('connect', () => socket.write(encodeMessage({id: 'check', method: 'getState'})));
		decoder.on('data', (message) => {
			if (message.id === 'check') finish(null, message);
		});
	});
}

async function ready(directory) {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const result = await state(directory).catch(() => null);
		if (result?.ok) return result;
		await delay(20);
	}
	throw new Error('daemon did not become ready');
}

test('a live unrelated PID in a legacy lock does not block daemon startup', async (t) => {
	const {directory, lockDirectory, start} = await fixture(t);
	await mkdir(lockDirectory);
	await writeFile(path.join(lockDirectory, 'pid'), String(process.pid));
	const child = start();
	await ready(directory);
	assert.equal(Number(await readFile(path.join(lockDirectory, 'pid'), 'utf8')), child.pid);
	assert.equal(process.kill(process.pid, 0), true);
});

test('a reused PID with the same command but a different start identity is reclaimed', async (t) => {
	const {lockDirectory} = await fixture(t);
	const identity = await processIdentity(process.pid);
	assert.ok(identity);
	await mkdir(lockDirectory);
	await writeFile(path.join(lockDirectory, 'pid'), String(process.pid));
	await writeFile(
		path.join(lockDirectory, 'owner.json'),
		JSON.stringify({
			pid: process.pid,
			identity: {...identity, started: 'previous boot'},
		}),
	);
	const lock = await acquireDaemonLock(lockDirectory, daemonPath);
	assert.ok(lock);
	await lock.release();
	await assert.rejects(readFile(path.join(lockDirectory, 'pid')), {code: 'ENOENT'});
});

for (const empty of [false, true])
	test(`concurrent starters recover one ${empty ? 'empty' : 'PID'} stale lock without replacing the winning daemon`, async (t) => {
		const {directory, lockDirectory, start} = await fixture(t);
		await mkdir(lockDirectory);
		if (empty) {
			const old = new Date(Date.now() - 20000);
			await utimes(lockDirectory, old, old);
		} else await writeFile(path.join(lockDirectory, 'pid'), String(process.pid));
		const children = Array.from({length: 6}, () => start());
		await ready(directory);
		await delay(250);
		const owner = JSON.parse(await readFile(path.join(lockDirectory, 'owner.json'), 'utf8'));
		assert.equal(
			children.filter((child) => child.exitCode === null && !child.signalCode).length,
			1,
		);
		assert.ok(children.some((child) => child.pid === owner.pid));
		assert.equal((await state(directory)).ok, true);
		const extra = start();
		assert.equal((await once(extra, 'exit'))[0], 0);
		assert.equal(Number(await readFile(path.join(lockDirectory, 'pid'), 'utf8')), owner.pid);
		const winner = children.find((child) => child.pid === owner.pid);
		const stopped = once(winner, 'exit');
		winner.kill('SIGTERM');
		await stopped;
		const remaining = await readdir(directory);
		assert.equal(remaining.includes('daemon.lock'), false);
		const tombstones = remaining.filter((name) => name.startsWith('daemon.lock.stale-'));
		assert.ok(tombstones.length > 0);
		for (const name of tombstones)
			assert.equal(
				await readFile(path.join(directory, name, 'retired'), 'utf8'),
				'fetchy-daemon-lock\n',
			);
	});

test('a delayed reclaimer cannot move a lock acquired after an intervening daemon exits', async (t) => {
	const {lockDirectory} = await fixture(t);
	await mkdir(lockDirectory);
	await writeFile(path.join(lockDirectory, 'pid'), String(process.pid));
	let pause, resume;
	const paused = new Promise((resolve) => {
		pause = resolve;
	});
	const resumed = new Promise((resolve) => {
		resume = resolve;
	});
	const originalRename = fs.rename;
	let calls = 0,
		firstWinner,
		activeWinner,
		lateStarter;
	const renameMock = t.mock.method(fs, 'rename', async (...args) => {
		if (++calls === 1) {
			pause();
			await resumed;
		}
		return originalRename(...args);
	});
	syncBuiltinESMExports();
	const waitingStarter = acquireDaemonLock(lockDirectory, daemonPath);
	try {
		await paused;
		firstWinner = await acquireDaemonLock(lockDirectory, daemonPath);
		assert.ok(firstWinner);
		await firstWinner.release();
		activeWinner = await acquireDaemonLock(lockDirectory, daemonPath);
		assert.ok(activeWinner);
		const currentIdentity = await fs.stat(lockDirectory);
		const currentOwner = await readFile(path.join(lockDirectory, 'owner.json'), 'utf8');
		resume();
		lateStarter = await waitingStarter;
		assert.equal(lateStarter, null);
		const after = await fs.stat(lockDirectory);
		assert.equal(after.dev, currentIdentity.dev);
		assert.equal(after.ino, currentIdentity.ino);
		assert.equal(await readFile(path.join(lockDirectory, 'owner.json'), 'utf8'), currentOwner);
	} finally {
		resume();
		await waitingStarter.catch(() => {});
		renameMock.mock.restore();
		syncBuiltinESMExports();
		await lateStarter?.release();
		await activeWinner?.release();
		await firstWinner?.release();
	}
});

test('a running legacy daemon keeps its lock and socket when another daemon starts', async (t) => {
	const {directory, lockDirectory, start} = await fixture(t);
	const first = start();
	await ready(directory);
	await rm(path.join(lockDirectory, 'owner.json'));
	const second = start();
	assert.equal((await once(second, 'exit'))[0], 0);
	assert.equal(Number(await readFile(path.join(lockDirectory, 'pid'), 'utf8')), first.pid);
	assert.equal((await state(directory)).ok, true);
});

test('fresh empty locks retain startup grace, while stale empty locks can be recovered', async (t) => {
	const {lockDirectory} = await fixture(t);
	await mkdir(lockDirectory);
	assert.equal(await acquireDaemonLock(lockDirectory, daemonPath), null);
	const old = new Date(Date.now() - 20000);
	await utimes(lockDirectory, old, old);
	const lock = await acquireDaemonLock(lockDirectory, daemonPath);
	assert.ok(lock);
	await lock.release();
});

test('release never removes a replacement lock owned by another process identity', async (t) => {
	const {lockDirectory} = await fixture(t);
	const lock = await acquireDaemonLock(lockDirectory, daemonPath);
	assert.ok(lock);
	await writeFile(path.join(lockDirectory, 'owner.json'), '{"pid":1,"identity":null}');
	await lock.release();
	assert.equal(
		await readFile(path.join(lockDirectory, 'owner.json'), 'utf8'),
		'{"pid":1,"identity":null}',
	);
});
