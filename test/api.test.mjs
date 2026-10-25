import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {resolveVideo, downloadVideo} from '../src/index.mjs';
import {runProcess} from '../src/process.mjs';

const youtube = 'https://www.youtube.com/watch?v=EWvNQjAaOHw&t=4538s';
async function fakeTools(t, {id = 'EWvNQjAaOHw', failDirect = false} = {}) {
	const root = await mkdtemp(path.join(tmpdir(), 'fango-api-test-'));
	t.after(() => rm(root, {recursive: true, force: true}));
	const ytDlpPath = path.join(root, 'yt-dlp.mjs'),
		ffprobePath = path.join(root, 'ffprobe.mjs');
	const trace = path.join(root, 'trace.jsonl');
	const info = {
		id,
		title: 'fixture',
		duration: 12,
		vcodec: 'h264',
		acodec: 'aac',
		formats: [
			{
				format_id: 'muxed',
				vcodec: 'h264',
				acodec: 'aac',
				width: 1280,
				height: 720,
				url: 'https://cdn.example/media',
			},
		],
	};
	await writeFile(
		ytDlpPath,
		[
			'#!/usr/bin/env node',
			"import { appendFile, writeFile } from 'node:fs/promises';",
			'const args=process.argv.slice(2);',
			'await appendFile(' + JSON.stringify(trace) + ',JSON.stringify(args)+"\\n");',
			'if(args.includes("--dump-single-json")){console.log(' +
				JSON.stringify(JSON.stringify(info)) +
				');process.exit(0);}',
			'if(' +
				failDirect +
				'&&!args[args.indexOf("--format")+1].includes("m3u8")){console.error("HTTP Error 403: Forbidden");process.exit(1);}',
			'const filepath=args[args.indexOf("--output")+1].replaceAll("%%","%").replace("%(ext)s","mp4");',
			'await writeFile(filepath,"test-media-data");',
			'await writeFile(args[args.indexOf("--print-to-file")+2],JSON.stringify({filepath,id:' +
				JSON.stringify(id) +
				'}));',
		].join('\n'),
	);
	await writeFile(
		ffprobePath,
		'#!/usr/bin/env node\nconsole.log(' +
			JSON.stringify(
				JSON.stringify({
					streams: [
						{codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 1280, height: 720},
						{codec_type: 'audio', codec_name: 'aac', channels: 2},
					],
					format: {duration: '12', format_name: 'mov,mp4,m4a,3gp,3g2,mj2'},
				}),
			) +
			');',
	);
	await chmod(ytDlpPath, 0o755);
	await chmod(ffprobePath, 0o755);
	return {trace, options: {ytDlpPath, ffprobePath, outputDir: path.join(root, 'output')}};
}

test('public API preserves timestamp metadata but resolves the whole-video URL', async (t) => {
	const {options, trace} = await fakeTools(t);
	const result = await resolveVideo(youtube, options);
	assert.equal(result.startTimeSeconds, 4538);
	assert.equal(result.engine, 'yt-dlp');
	const args = JSON.parse((await readFile(trace, 'utf8')).trim());
	assert.equal(args.at(-1), 'https://www.youtube.com/watch?v=EWvNQjAaOHw');
	assert.equal(args.includes('--download-sections'), false);
});

test('public API rejects unsupported engines and can be cancelled before any work', async () => {
	await assert.rejects(resolveVideo(youtube, {engine: 'unknown'}), {code: 'invalid_options'});
	await assert.rejects(resolveVideo(youtube, {engine: 'browser'}), {code: 'unsupported_platform'});
	await assert.rejects(downloadVideo(youtube, {signal: AbortSignal.abort()}), {code: 'cancelled'});
	await assert.rejects(resolveVideo('https://example.com/video'), {code: 'unsupported_platform'});
});

test('YouTube direct failure retries HLS once and reports the fallback', async (t) => {
	const {options, trace} = await fakeTools(t, {failDirect: true});
	const result = await downloadVideo(youtube, options);
	assert.equal(result.fallback, 'https_failed_retry_hls');
	assert.equal(result.transport, 'hls');
	assert.equal(result.validation.audio, true);
	const calls = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
	assert.equal(calls.filter((args) => args.includes('--no-simulate')).length, 2);
	assert.equal(calls.filter((args) => args.includes('--dump-single-json')).length, 2);
});

test('XHS and Douyin use yt-dlp unless the extension supplies page media', async (t) => {
	const id = '6adb92b90000000031037a66';
	const {options} = await fakeTools(t, {id});
	const url = 'https://www.xiaohongshu.com/explore/' + id;
	const result = await resolveVideo(url, options);
	assert.equal(result.engine, 'yt-dlp');
	const media = {
		platform: 'xiaohongshu',
		id,
		title: 'from page',
		formats: [
			{
				hasVideo: true,
				hasAudio: true,
				width: 720,
				height: 1280,
				urls: ['https://sns-video.xhscdn.com/a.mp4'],
			},
		],
	};
	const fromPage = await resolveVideo(url, {...options, pageMedia: {media}});
	assert.equal(fromPage.engine, 'browser');
	assert.equal(fromPage.title, 'from page');
	assert.doesNotMatch(JSON.stringify(fromPage), /xhscdn/);
	await assert.rejects(resolveVideo(url, {...options, engine: 'browser'}), {
		code: 'invalid_options',
	});
});

test('CLI help is available without external dependencies', async () => {
	const result = await runProcess(process.execPath, ['bin/fango-download.mjs', '--help']);
	assert.equal(result.code, 0);
	assert.match(result.stdout, /resolve/);
	assert.match(result.stdout, /download/);
	assert.match(result.stdout, /--max-height/);
});
