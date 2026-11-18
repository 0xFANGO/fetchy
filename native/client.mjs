import net from 'node:net';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {MessageDecoder, encodeMessage} from './protocol.mjs';
import {dataDirectory, privateDirectory} from './settings.mjs';

function connect(socketPath) {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(socketPath);
		socket.once('connect', () => {
			socket.removeListener('error', reject);
			resolve(socket);
		});
		socket.once('error', reject);
	});
}
export async function connectNative(directory = dataDirectory()) {
	await privateDirectory(directory);
	const socketPath = path.join(directory, 'bridge.sock');
	let socket;
	try {
		socket = await connect(socketPath);
	} catch {
		const child = spawn(
			process.execPath,
			[fileURLToPath(new URL('./daemon.mjs', import.meta.url))],
			{
				detached: true,
				stdio: 'ignore',
				env: {...process.env, FETCHY_DATA_DIR: directory},
			},
		);
		child.on('error', () => {});
		child.unref();
		for (let attempt = 0; attempt < 60 && !socket; attempt++) {
			await delay(100);
			try {
				socket = await connect(socketPath);
			} catch {}
		}
	}
	if (!socket)
		throw Object.assign(new Error('无法连接本机下载服务。'), {code: 'native_unavailable'});
	return socket;
}

export async function requestNative(method, params = {}, {timeoutMs = 60000, directory} = {}) {
	const socket = await connectNative(directory);
	try {
		return await new Promise((resolve, reject) => {
			const id = randomUUID();
			const decoder = new MessageDecoder();
			const timer = setTimeout(
				() => socket.destroy(Object.assign(new Error('本机组件未及时响应。'), {code: 'timeout'})),
				timeoutMs,
			);
			socket.once('error', reject);
			socket.once('close', () => {
				clearTimeout(timer);
				reject(Object.assign(new Error('本机下载服务已断开。'), {code: 'disconnected'}));
			});
			decoder.on('error', reject);
			decoder.on('data', (message) => {
				if (message.id !== id) return;
				if (message.ok) resolve(message.result);
				else
					reject(
						Object.assign(new Error(message.error?.message || '本机操作失败。'), {
							code: message.error?.code || 'engine_error',
						}),
					);
			});
			socket.pipe(decoder);
			socket.write(encodeMessage({id, method, params}));
		});
	} finally {
		socket.destroy();
	}
}
