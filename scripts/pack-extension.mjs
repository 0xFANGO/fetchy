#!/usr/bin/env node
// Builds the extension and zips dist/extension into dist/fetchy-extension-<version>.zip,
// the file attached to GitHub releases. Refuses to pack when package.json and
// the extension manifest disagree about the version.
import {execFile} from 'node:child_process';
import {readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(join(root, 'extension', 'manifest.json'), 'utf8'));
if (pkg.version !== manifest.version)
	throw new Error(
		`package.json is ${pkg.version} but extension/manifest.json is ${manifest.version}; keep them in sync.`,
	);
const expected = process.env.RELEASE_TAG?.replace(/^v/, '');
if (expected && expected !== pkg.version)
	throw new Error(`Release tag ${process.env.RELEASE_TAG} does not match version ${pkg.version}.`);

await run(process.execPath, [join(root, 'scripts', 'build-extension.mjs')]);
const archive = `fetchy-extension-${pkg.version}.zip`;
await rm(join(root, 'dist', archive), {force: true});
await run('zip', ['-r', '-X', '-q', archive, 'extension'], {cwd: join(root, 'dist')});
console.log(join(root, 'dist', archive));
