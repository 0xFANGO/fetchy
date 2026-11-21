import {createRequire} from 'node:module';
import {mkdir, chmod} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

export const libraryRoot = (options = {}) =>
	path.resolve(
		options.root ||
			process.env.FETCHY_LIBRARY_DIR ||
			path.join(
				process.env.FETCHY_DATA_DIR ||
					path.join(homedir(), 'Library', 'Application Support', 'Fetchy'),
				'library',
			),
	);

export function problem(code, message) {
	return Object.assign(new Error(message), {code});
}

function connect(filename) {
	let DatabaseSync;
	try {
		({DatabaseSync} = createRequire(import.meta.url)('node:sqlite'));
	} catch {
		throw problem(
			'dependency_missing',
			'The library requires Node 22.13 or later with node:sqlite.',
		);
	}
	return new DatabaseSync(filename);
}

export async function openLibrary(options) {
	const root = libraryRoot(options);
	await mkdir(root, {recursive: true, mode: 0o700});
	const filename = path.join(root, 'library.sqlite');
	const db = connect(filename);
	try {
		await chmod(filename, 0o600);
		db.exec(`PRAGMA busy_timeout=5000;
			CREATE TABLE IF NOT EXISTS works (key TEXT PRIMARY KEY, record TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, created TEXT, status TEXT, config TEXT);
			CREATE TABLE IF NOT EXISTS items (task TEXT, key TEXT, input TEXT, status TEXT DEFAULT 'pending',
				reason TEXT, PRIMARY KEY(task,key));
			CREATE TABLE IF NOT EXISTS folder_members (task TEXT, folder TEXT, key TEXT, PRIMARY KEY(task,folder,key));
			CREATE INDEX IF NOT EXISTS items_progress ON items(task,status);`);
		return {root, db};
	} catch (err) {
		db.close();
		throw err;
	}
}

export function transaction(db, fn) {
	db.exec('BEGIN IMMEDIATE');
	try {
		const result = fn();
		db.exec('COMMIT');
		return result;
	} catch (err) {
		db.exec('ROLLBACK');
		throw err;
	}
}

// Holding a SQLite write transaction on a separate file leaves status queries readable.
// SQLite releases the lock even if the worker is killed between the download and its receipt.
export async function withWorker(root, signal, action) {
	const lock = connect(path.join(root, 'worker.sqlite'));
	try {
		for (;;) {
			signal?.throwIfAborted();
			try {
				lock.exec('BEGIN IMMEDIATE');
				break;
			} catch (err) {
				if (err.errcode !== 5 && err.errcode !== 6) throw err;
				await delay(150, undefined, {signal});
			}
		}
		return await action();
	} finally {
		lock.close();
	}
}
