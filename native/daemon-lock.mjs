import {mkdir, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {runProcess} from '../src/process.mjs';

export async function processIdentity(pid) {
	try {
		const result = await runProcess(
			'/usr/bin/env',
			[
				'LC_ALL=C',
				'TZ=UTC',
				'/bin/ps',
				'-ww',
				'-p',
				String(pid),
				'-o',
				'lstart=',
				'-o',
				'command=',
			],
			{timeoutMs: 2000, maxOutputBytes: 16384},
		);
		const match = result.stdout
			.trim()
			.match(/^(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
		return result.code === 0 && match
			? {started: match[1].replace(/\s+/g, ' '), command: match[2]}
			: null;
	} catch {
		return null;
	}
}

const sameDirectory = (a, b) => a?.dev === b?.dev && a?.ino === b?.ino;
const RETIRED_MARKER = 'fetchy-daemon-lock\n';
async function snapshot(directory) {
	try {
		return {
			info: await stat(directory),
			pid: await readFile(path.join(directory, 'pid'), 'utf8').catch(() => ''),
			owner: await readFile(path.join(directory, 'owner.json'), 'utf8').catch(() => ''),
		};
	} catch (error) {
		if (error.code === 'ENOENT') return null;
		throw error;
	}
}

async function stale(lock, daemonPath) {
	const pid = Number(lock.pid);
	if (!Number.isSafeInteger(pid) || pid < 2) return Date.now() - lock.info.mtimeMs >= 10000;
	try {
		process.kill(pid, 0);
	} catch (error) {
		return error.code === 'ESRCH';
	}
	const current = await processIdentity(pid);
	if (!current) return false;
	let owner;
	try {
		owner = JSON.parse(lock.owner);
	} catch {}
	if (owner?.pid === pid && owner.identity?.started && owner.identity?.command)
		return current.started !== owner.identity.started || current.command !== owner.identity.command;
	// Legacy locks contain only a PID; a different executable cannot own this daemon.
	return !` ${current.command} `.includes(` ${daemonPath} `);
}

export async function acquireDaemonLock(directory, daemonPath) {
	const identity = await processIdentity(process.pid);
	const owner = JSON.stringify({pid: process.pid, identity});
	for (let attempt = 0; attempt < 10; attempt++) {
		let info;
		try {
			await mkdir(directory, {mode: 0o700});
			info = await stat(directory);
			await writeFile(path.join(directory, 'pid'), String(process.pid), {mode: 0o600});
			await writeFile(path.join(directory, 'owner.json'), owner, {mode: 0o600});
			return {
				async release() {
					const current = await snapshot(directory);
					if (sameDirectory(info, current?.info) && current.owner === owner) {
						await rm(directory, {recursive: true, force: true});
					}
				},
			};
		} catch (error) {
			if (info && sameDirectory(info, (await snapshot(directory))?.info))
				await rm(directory, {recursive: true, force: true});
			if (error.code !== 'EEXIST') throw error;
		}
		const observed = await snapshot(directory);
		if (!observed) continue;
		if (!(await stale(observed, daemonPath))) return null;
		const current = await snapshot(directory);
		if (
			!sameDirectory(observed.info, current?.info) ||
			current.pid !== observed.pid ||
			current.owner !== observed.owner
		)
			continue;
		const old = `${directory}.stale-${observed.info.dev}-${observed.info.ino}-${observed.info.birthtimeMs}`;
		try {
			// Keep this nonempty tombstone across daemon lifetimes: a paused old
			// reclaimer may still try to rename the current lock into this same path.
			await writeFile(path.join(directory, 'retired'), RETIRED_MARKER, {mode: 0o600});
			const marked = await snapshot(directory);
			if (
				!sameDirectory(observed.info, marked?.info) ||
				marked.pid !== observed.pid ||
				marked.owner !== observed.owner
			)
				continue;
			await rename(directory, old);
			if (!sameDirectory(observed.info, await stat(old))) return null;
		} catch (error) {
			if (!['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
		}
	}
	return null;
}
