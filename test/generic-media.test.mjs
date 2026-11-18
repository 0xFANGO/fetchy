import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import {createReadStream} from 'node:fs';
import {mkdtemp, readFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {downloadGeneric, resolveGeneric} from '../src/generic-media.mjs';
import {openWeb} from '../src/public-http.mjs';
import {LibraryUploads} from '../native/library-upload.mjs';
const exec = promisify(execFile);

test('direct, declared, HLS and DASH sources produce decodable video and audio; batch preserves successes', async (t) => {
	const dir = await mkdtemp(path.join(tmpdir(), 'fetchy-web-test-'));
	t.after(() => rm(dir, {recursive: true, force: true}));
	const ff = (args) =>
		exec('ffmpeg', ['-nostdin', '-hide_banner', '-v', 'error', ...args], {cwd: dir});
	await ff([
		'-f',
		'lavfi',
		'-i',
		'color=c=blue:size=160x90:rate=12',
		'-f',
		'lavfi',
		'-i',
		'sine=frequency=440',
		'-t',
		'2',
		'-c:v',
		'libx264',
		'-pix_fmt',
		'yuv420p',
		'-g',
		'12',
		'-c:a',
		'aac',
		'sample.mp4',
	]);
	await ff(['-i', 'sample.mp4', '-c', 'copy', '-f', 'dash', '-seg_duration', '1', 'sample.mpd']);
	await ff(['-i', 'sample.mp4', '-c', 'copy', '-f', 'hls', '-hls_time', '1', 'sample.m3u8']);
	const types = {
		'.mp4': 'video/mp4',
		'.m3u8': 'application/vnd.apple.mpegurl',
		'.mpd': 'application/dash+xml',
	};
	const server = http.createServer(async (req, res) => {
		const route = new URL(req.url, 'http://localhost').pathname.slice(1);
		if (route === 'reader') {
			res
				.writeHead(200, {'content-type': 'text/html'})
				.end(
					'<article><h1>Field notes</h1><p>First line.</p><h2>Middle</h2><p><a href="/field">Field report</a></p><p>Last line.</p></article>',
				);
			return;
		}
		if (route.startsWith('article-')) {
			const media = route.slice(8);
			res
				.writeHead(200, {'content-type': 'text/html'})
				.end(
					'<title>Owned fixture</title><video><source src="/missing"><source src="/' +
						media +
						'"></video>',
				);
			return;
		}
		if (route === 'bad.mp4') {
			res.writeHead(200, {'content-type': 'video/mp4'}).end('This is not a video');
			return;
		}
		const file = path.join(dir, path.basename(route));
		if (!route || !(await stat(file).catch(() => null))?.isFile()) {
			res.writeHead(404).end();
			return;
		}
		res.writeHead(200, {'content-type': types[path.extname(file)] || 'application/octet-stream'});
		createReadStream(file)
			.on('error', () => res.destroy())
			.pipe(res);
	});
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	t.after(() => new Promise((r) => server.close(r)));
	const origin = 'http://127.0.0.1:' + server.address().port;
	await assert.rejects(openWeb(origin), {code: 'invalid_url'});
	await assert.rejects(
		downloadGeneric(origin + '/bad.mp4', {localOrigin: origin, outputDir: dir}),
		{code: 'output_invalid'},
	);
	for (const route of [
		'sample.mp4',
		'article-sample.mp4',
		'article-sample.m3u8',
		'article-sample.mpd',
	]) {
		const url = origin + '/' + route;
		const info = await resolveGeneric(url, {localOrigin: origin});
		const out = await downloadGeneric(url, {
			localOrigin: origin,
			outputDir: path.join(dir, 'results'),
		});
		assert.equal(out.id, info.id);
		assert.equal(out.validation.videoCodec, 'h264');
		assert.equal(out.validation.audioCodec, 'aac');
		assert.ok(Math.abs(out.validation.durationSeconds - 2) < 0.3);
		await ff(['-xerror', '-i', out.filepath, '-f', 'null', '-']);
	}
	const env = {
		...process.env,
		FETCHY_DATA_DIR: path.join(dir, 'data'),
		FETCHY_LIBRARY_DIR: path.join(dir, 'library'),
	};
	const args = [
		'bin/fetchy.mjs',
		'batch',
		'--allow-local',
		origin + '/missing',
		origin + '/sample.mp4',
	];
	let result;
	try {
		await exec(process.execPath, args, {env});
	} catch (e) {
		result = e;
	}
	assert.equal(result?.code, 1);
	const [bad, ok] = result.stdout
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line));
	assert.ok(bad.error.code);
	assert.ok(ok.taskId, JSON.stringify(ok));
	const again = JSON.parse(
		(
			await exec(
				process.execPath,
				['bin/fetchy.mjs', 'get', '--allow-local', origin + '/sample.mp4'],
				{env},
			)
		).stdout,
	);
	assert.equal(again.status, 'skipped');
	assert.equal(ok.filepath, again.filepath);
	assert.ok((await readFile(ok.offlinePage, 'utf8')).includes('<video'));
	const article = JSON.parse(
		(
			await exec(
				process.execPath,
				[
					'bin/fetchy.mjs',
					'get',
					'--allow-local',
					'--output',
					path.join(dir, 'selected'),
					origin + '/reader',
				],
				{
					env,
				},
			)
		).stdout,
	);
	assert.equal(article.kind, 'post');
	assert.equal(article.status, 'added');
	const offline = await readFile(article.filepath, 'utf8');
	for (const part of ['<h2>Middle</h2>', 'First line.', 'Last line.', 'Field report'])
		assert.ok(offline.includes(part), part);
});

test('large native uploads preserve UTF-8 across chunks and reject stale or reordered chunks', () => {
	const u = new LibraryUploads();
	const {uploadId} = u.start();
	const bytes = Buffer.from(JSON.stringify({text: '图文'.repeat(100000)}));
	assert.throws(() => u.part({uploadId, index: 1, data: 'YQ=='}));
	let count = 0;
	for (let off = 0; off < bytes.length; off += 100001)
		u.part({uploadId, index: count++, data: bytes.subarray(off, off + 100001).toString('base64')});
	assert.deepEqual(u.finish({uploadId, count}), JSON.parse(bytes));
	assert.throws(() => u.finish({uploadId, count}));
});
