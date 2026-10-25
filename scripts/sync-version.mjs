#!/usr/bin/env node
// Runs from the npm "version" hook: copies the version npm just wrote to
// package.json into extension/manifest.json so the two never drift.
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const {version} = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const file = join(root, 'extension', 'manifest.json');
const manifest = JSON.parse(await readFile(file, 'utf8'));
manifest.version = version;
await writeFile(file, JSON.stringify(manifest, null, '\t') + '\n');
console.log(`extension/manifest.json → ${version}`);
