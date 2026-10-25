import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod, mkdtemp, readFile, readdir, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {ensureCompatibleMp4} from '../src/mp4.mjs';
import {runProcess} from '../src/process.mjs';

const ffmpegCheck = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], {
	encoding: 'utf8',
	timeout: 10_000,
});
const ffprobeCheck = spawnSync('ffprobe', ['-version'], {encoding: 'utf8', timeout: 10_000});
const available = ffmpegCheck.status === 0 && ffprobeCheck.status === 0;
const encoders = ffmpegCheck.stdout || '';
const canEncode = (...names) => available && names.every((name) => encoders.includes(name));
const skipReason = (condition) =>
	condition ? false : 'Requires local FFmpeg/ffprobe with the specified encoders';

async function sandbox(t) {
	const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'fango-mp4-test-')));
	t.after(() => rm(directory, {recursive: true, force: true}));
	return directory;
}

async function synthetic(
	directory,
	filename,
	{vcodec = 'libx264', acodec = 'aac', duration = 0.6, pixFmt = 'yuv420p'} = {},
) {
	const filepath = path.join(directory, filename);
	const args = [
		'-hide_banner',
		'-loglevel',
		'error',
		'-nostdin',
		'-y',
		'-f',
		'lavfi',
		'-i',
		`testsrc2=size=192x128:rate=10:duration=${duration}`,
	];
	if (acodec)
		args.push('-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${duration}`);
	args.push('-map', '0:v:0');
	if (acodec) args.push('-map', '1:a:0');
	args.push('-c:v', vcodec, '-pix_fmt', pixFmt);
	if (vcodec === 'libx264') args.push('-preset', 'ultrafast');
	if (vcodec === 'libvpx-vp9') args.push('-deadline', 'realtime', '-cpu-used', '8');
	if (vcodec === 'libsvtav1') args.push('-preset', '12', '-svtav1-params', 'lp=2');
	if (acodec) args.push('-c:a', acodec);
	args.push(filepath);
	const result = await runProcess('ffmpeg', args, {timeoutMs: 30_000});
	assert.equal(result.code, 0, `Synthetic fixture could not be created with ${vcodec}/${acodec}`);
	return filepath;
}

async function inspect(filepath) {
	const result = await runProcess('ffprobe', [
		'-v',
		'error',
		'-show_streams',
		'-show_format',
		'-of',
		'json',
		filepath,
	]);
	assert.equal(result.code, 0);
	return JSON.parse(result.stdout);
}

async function assertCompatible(filepath, {audio = true} = {}) {
	const data = await inspect(filepath);
	assert.match(data.format.format_name, /(?:^|,)mp4(?:,|$)/);
	const video = data.streams.find((stream) => stream.codec_type === 'video');
	const audioStream = data.streams.find((stream) => stream.codec_type === 'audio');
	assert.equal(video.codec_name, 'h264');
	assert.equal(video.pix_fmt, 'yuv420p');
	assert.equal(video.width, 192);
	assert.equal(video.height, 128);
	assert.equal(
		Number(video.avg_frame_rate.split('/')[0]) / Number(video.avg_frame_rate.split('/')[1]),
		10,
	);
	assert.ok(Number(data.format.duration) > 0);
	if (audio) assert.equal(audioStream.codec_name, 'aac');
	else assert.equal(audioStream, undefined);
}

test(
	'compatible MP4 is returned unchanged; explicit copy creates only the chosen target',
	{
		skip: skipReason(canEncode('libx264', 'aac')),
	},
	async (t) => {
		const directory = await sandbox(t);
		const source = await synthetic(directory, 'ready.mp4');
		const original = await readFile(source);
		const result = await ensureCompatibleMp4(source);
		assert.deepEqual(result, {
			filepath: source,
			mode: 'copy',
			videoCodec: 'h264',
			audioCodec: 'aac',
		});
		assert.deepEqual(await readdir(directory), ['ready.mp4']);
		const copied = await ensureCompatibleMp4(source, {
			outputPath: path.join(directory, 'copy.mp4'),
		});
		assert.equal(copied.mode, 'copy');
		assert.deepEqual(await readFile(source), original);
		assert.deepEqual(await readFile(copied.filepath), original);
		await assertCompatible(copied.filepath);
	},
);

test(
	'H.264/AAC in Matroska is remuxed into actual MP4 and keeps the source',
	{
		skip: skipReason(canEncode('libx264', 'aac')),
	},
	async (t) => {
		const directory = await sandbox(t);
		const source = await synthetic(directory, 'source.mkv');
		const original = await readFile(source);
		const result = await ensureCompatibleMp4(source);
		assert.equal(result.filepath, path.join(directory, 'source.mp4'));
		assert.equal(result.mode, 'remux');
		await assertCompatible(result.filepath);
		assert.deepEqual(await readFile(source), original);
	},
);

for (const codec of ['libvpx-vp9', 'libsvtav1']) {
	test(
		`${codec} + Opus becomes H.264/AAC MP4 without changing dimensions or fps`,
		{
			skip: skipReason(canEncode(codec, 'libopus', 'libx264', 'aac')),
		},
		async (t) => {
			const directory = await sandbox(t);
			const source = await synthetic(directory, 'source.webm', {vcodec: codec, acodec: 'libopus'});
			const original = await readFile(source);
			const result = await ensureCompatibleMp4(source, {timeoutMs: 30_000});
			assert.equal(result.mode, 'transcode');
			assert.equal(result.audioCodec, 'aac');
			await assertCompatible(result.filepath);
			assert.deepEqual(await readFile(source), original);
			assert.equal(
				(await readdir(directory)).some((file) => file.startsWith('.fango-mp4-')),
				false,
			);
		},
	);
}

test(
	'MP4 with Opus gets a new compatible filename; a silent source stays silent',
	{
		skip: skipReason(canEncode('libx264', 'libopus', 'aac')),
	},
	async (t) => {
		const directory = await sandbox(t);
		const source = await synthetic(directory, 'opus.mp4', {acodec: 'libopus'});
		const result = await ensureCompatibleMp4(source);
		assert.equal(result.filepath, path.join(directory, 'opus-compatible.mp4'));
		assert.equal(result.mode, 'transcode');
		await assertCompatible(result.filepath);
		const silent = await synthetic(directory, 'silent.mkv', {acodec: null});
		const silentResult = await ensureCompatibleMp4(silent);
		assert.equal(silentResult.audioCodec, null);
		await assertCompatible(silentResult.filepath, {audio: false});
	},
);

test(
	'H.264 with yuv444p is converted to yuv420p without resizing',
	{
		skip: skipReason(canEncode('libx264', 'aac')),
	},
	async (t) => {
		const directory = await sandbox(t);
		const source = await synthetic(directory, 'chroma.mp4', {pixFmt: 'yuv444p'});
		assert.equal(
			(await inspect(source)).streams.find((stream) => stream.codec_type === 'video').pix_fmt,
			'yuv444p',
		);
		const result = await ensureCompatibleMp4(source);
		assert.equal(result.mode, 'transcode');
		await assertCompatible(result.filepath);
	},
);

test(
	'ffmpegLocation accepts either its directory or its executable path',
	{
		skip: skipReason(canEncode('libx264', 'aac') && process.platform !== 'win32'),
	},
	async (t) => {
		const which = spawnSync('which', ['ffmpeg'], {encoding: 'utf8', timeout: 10_000});
		assert.equal(which.status, 0);
		const ffmpeg = which.stdout.trim();
		const directory = await sandbox(t);
		const source = await synthetic(directory, 'source.mkv');
		for (const [label, location] of [
			['directory', path.dirname(ffmpeg)],
			['executable', ffmpeg],
		]) {
			const result = await ensureCompatibleMp4(source, {
				ffmpegLocation: location,
				outputPath: path.join(directory, `${label}.mp4`),
			});
			assert.equal(result.mode, 'remux');
			await assertCompatible(result.filepath);
		}
	},
);

test(
	'invalid options, overwrite, and outside-directory targets never modify the source',
	{
		skip: skipReason(canEncode('libx264', 'aac')),
	},
	async (t) => {
		const directory = await sandbox(t);
		const otherDirectory = await sandbox(t);
		const source = await synthetic(directory, 'source.mkv');
		const original = await readFile(source);
		await assert.rejects(ensureCompatibleMp4(source, {timeoutMs: 0}), {code: 'invalid_options'});
		await assert.rejects(ensureCompatibleMp4(source, {outputPath: source}), {
			code: 'invalid_options',
		});
		await assert.rejects(
			ensureCompatibleMp4(source, {outputPath: path.join(otherDirectory, 'new.mp4')}),
			{code: 'invalid_options'},
		);
		await assert.rejects(
			ensureCompatibleMp4(source, {outputPath: path.join(directory, 'new.webm')}),
			{code: 'invalid_options'},
		);
		const target = path.join(directory, 'source.mp4');
		await writeFile(target, 'existing user file');
		await assert.rejects(ensureCompatibleMp4(source), {code: 'output_exists'});
		assert.equal(await readFile(target, 'utf8'), 'existing user file');
		assert.deepEqual(await readFile(source), original);
	},
);

test(
	'pre-cancelled and timed-out work leaves source and no temporary output',
	{
		skip: skipReason(canEncode('libx264', 'aac')),
	},
	async (t) => {
		const directory = await sandbox(t);
		const source = await synthetic(directory, 'source.mkv');
		const original = await readFile(source);
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(ensureCompatibleMp4(source, {signal: controller.signal}), {
			code: 'cancelled',
		});
		await assert.rejects(ensureCompatibleMp4(source, {timeoutMs: 1}), {code: 'timeout'});
		assert.deepEqual(await readFile(source), original);
		assert.deepEqual(await readdir(directory), ['source.mkv']);
	},
);

test(
	'cancellation after a temporary file is created cleans only that owned file',
	{
		skip: skipReason(canEncode('libvpx-vp9', 'libopus', 'libx264', 'aac')),
	},
	async (t) => {
		const directory = await sandbox(t);
		const source = await synthetic(directory, 'source.webm', {
			vcodec: 'libvpx-vp9',
			acodec: 'libopus',
			duration: 2,
		});
		const original = await readFile(source);
		const controller = new AbortController();
		let observedTemporary = false;
		let stopWatching = false;
		const watcher = (async () => {
			while (!stopWatching) {
				if ((await readdir(directory)).some((file) => file.startsWith('.fango-mp4-'))) {
					observedTemporary = true;
					controller.abort();
					break;
				}
				await delay(1);
			}
		})();
		try {
			await assert.rejects(ensureCompatibleMp4(source, {signal: controller.signal}), {
				code: 'cancelled',
			});
		} finally {
			stopWatching = true;
			await watcher;
		}
		assert.equal(observedTemporary, true);
		assert.deepEqual(await readFile(source), original);
		assert.deepEqual(await readdir(directory), ['source.webm']);
	},
);

test(
	'a destination created during conversion is never overwritten',
	{
		skip: skipReason(canEncode('libvpx-vp9', 'libopus', 'libx264', 'aac')),
	},
	async (t) => {
		const directory = await sandbox(t);
		const source = await synthetic(directory, 'source.webm', {
			vcodec: 'libvpx-vp9',
			acodec: 'libopus',
			duration: 2,
		});
		const original = await readFile(source);
		const destination = path.join(directory, 'source.mp4');
		let created = false;
		let stopWatching = false;
		const watcher = (async () => {
			while (!stopWatching) {
				if ((await readdir(directory)).some((file) => file.startsWith('.fango-mp4-'))) {
					await writeFile(destination, 'concurrent user file', {flag: 'wx'});
					created = true;
					break;
				}
				await delay(1);
			}
		})();
		try {
			await assert.rejects(ensureCompatibleMp4(source), {code: 'output_exists'});
		} finally {
			stopWatching = true;
			await watcher;
		}
		assert.equal(created, true);
		assert.equal(await readFile(destination, 'utf8'), 'concurrent user file');
		assert.deepEqual(await readFile(source), original);
		assert.equal(
			(await readdir(directory)).some((file) => file.startsWith('.fango-mp4-')),
			false,
		);
	},
);

test(
	'missing encoder executable cleans temporary output while respecting an explicit ffprobe path',
	{
		skip: skipReason(canEncode('libx264', 'aac')),
	},
	async (t) => {
		const directory = await sandbox(t);
		const source = await synthetic(directory, 'source.mkv');
		const original = await readFile(source);
		await assert.rejects(
			ensureCompatibleMp4(source, {
				ffmpegLocation: path.join(directory, 'missing-ffmpeg'),
				ffprobePath: 'ffprobe',
			}),
			{code: 'dependency_missing'},
		);
		assert.deepEqual(await readFile(source), original);
		assert.deepEqual(await readdir(directory), ['source.mkv']);
	},
);

test(
	'FFmpeg disk exhaustion stays actionable and leaves the original media intact',
	{
		skip: skipReason(canEncode('libx264', 'aac')),
	},
	async (t) => {
		const directory = await sandbox(t),
			source = await synthetic(directory, 'source.mkv');
		const original = await readFile(source),
			encoder = path.join(directory, 'fake-ffmpeg.mjs');
		await writeFile(
			encoder,
			'#!/usr/bin/env node\nconsole.error("Error writing output file: No space left on device /private/SECRET.mp4"); process.exit(1);',
		);
		await chmod(encoder, 0o755);
		await assert.rejects(
			ensureCompatibleMp4(source, {ffmpegLocation: encoder, ffprobePath: 'ffprobe'}),
			(error) => {
				assert.equal(error.code, 'disk_full');
				assert.doesNotMatch(error.message, /SECRET|private/);
				return true;
			},
		);
		assert.deepEqual(await readFile(source), original);
		assert.deepEqual((await readdir(directory)).sort(), ['fake-ffmpeg.mjs', 'source.mkv']);
	},
);
