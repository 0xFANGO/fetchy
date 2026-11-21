#!/usr/bin/env node
import {connectNative} from './client.mjs';
import path from 'node:path';
import {MessageDecoder, encodeMessage} from './protocol.mjs';
import {dataDirectory, privateDirectory, readJson} from './settings.mjs';

process.umask(0o077);
const directory = dataDirectory();
try {
	await privateDirectory(directory);
	const runtime = await readJson(path.join(directory, 'runtime.json'));
	if (!runtime?.extensionId || process.argv[2] !== `chrome-extension://${runtime.extensionId}/`)
		process.exit(1);
	if (typeof runtime.path === 'string') process.env.PATH = runtime.path;
	const socket = await connectNative(directory);
	socket.on('error', () => process.exit(1));
	socket.on('close', () => process.exit(0));
	const incoming = new MessageDecoder();
	incoming.on('error', () => {
		socket.destroy();
		process.exit(1);
	});
	incoming.on('data', (message) => socket.write(encodeMessage(message)));
	process.stdin.pipe(incoming);
	socket.pipe(process.stdout);
	process.stdin.on('end', () => socket.end());
	process.stdin.on('error', () => socket.destroy());
	process.stdout.on('error', () => socket.destroy());
} catch {
	process.exit(1);
}
