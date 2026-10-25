import {access, chmod, mkdir, open, readFile, rename, rm, stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {bridgeError} from './errors.mjs';
export const dataDirectory = () =>
	process.env.FETCHY_DATA_DIR || path.join(homedir(), 'Library', 'Application Support', 'Fetchy');
export const defaultOutputDirectory = () => path.join(homedir(), 'Downloads', 'Fetchy');
export async function privateDirectory(directory) {
	await mkdir(directory, {recursive: true, mode: 0o700});
	await chmod(directory, 0o700);
}
export async function readJson(filename, fallback = null) {
	try {
		return JSON.parse(await readFile(filename, 'utf8'));
	} catch (error) {
		if (error.code === 'ENOENT' || error instanceof SyntaxError) return fallback;
		throw error;
	}
}
export async function writeJson(filename, value) {
	const temporary = `${filename}.${randomUUID()}.tmp`;
	try {
		await import('node:fs/promises').then(({writeFile}) =>
			writeFile(temporary, JSON.stringify(value), {mode: 0o600}),
		);
		await rename(temporary, filename);
	} finally {
		await rm(temporary, {force: true}).catch(() => {});
	}
}
export async function validateDirectory(
	directory,
	{createDefault = false, defaultDirectory = defaultOutputDirectory()} = {},
) {
	if (
		typeof directory !== 'string' ||
		!path.isAbsolute(directory) ||
		directory.includes('\0') ||
		directory.length > 4096
	)
		throw bridgeError('directory_invalid');
	const resolved = path.resolve(directory);
	if (createDefault && resolved === path.resolve(defaultDirectory))
		await mkdir(resolved, {recursive: true});
	let info;
	try {
		info = await stat(resolved);
	} catch (error) {
		if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw bridgeError('directory_invalid');
		throw error;
	}
	if (!info.isDirectory()) throw bridgeError('directory_invalid');
	await access(resolved, constants.W_OK);
	const probe = path.join(resolved, `.fetchy-write-check-${randomUUID()}`);
	let handle;
	try {
		handle = await open(probe, 'wx', 0o600);
		await handle.close();
		handle = null;
	} finally {
		await handle?.close().catch(() => {});
		await rm(probe, {force: true}).catch(() => {});
	}
	return resolved;
}
