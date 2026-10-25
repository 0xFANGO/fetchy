import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {
	downloadWithBrowser,
	publicBrowserMetadata,
	resolveWithBrowser,
	selectBrowserFormat,
	validateMediaUrl,
} from '../src/browser.mjs';
import {publicThumbnailUrl} from '../src/thumbnails.mjs';

const base = {
	hasVideo: true,
	hasAudio: true,
	width: 720,
	height: 1280,
	fps: 30,
	vcodec: 'h264',
	bitrate: 1_000_000,
};

test('browser selection compares pixel area, then fps and codec compatibility', () => {
	const small = {...base, id: 'small', bitrate: 9_000_000};
	const large = {...base, id: 'large', width: 1080, height: 1920, vcodec: 'h265', bitrate: 500_000};
	assert.equal(selectBrowserFormat([small, large]).id, 'large');
	assert.equal(
		selectBrowserFormat([large, {...large, id: 'compatible', vcodec: 'h264'}]).id,
		'compatible',
	);
	assert.equal(selectBrowserFormat([large, {...large, id: 'fps', fps: 60}]).id, 'fps');
});

test('height limits are actual frame heights and unknown or split streams are excluded', () => {
	const streams = [
		{...base, id: 'portrait'},
		{...base, id: 'landscape', width: 1280, height: 720},
		{...base, id: 'unknown', width: null, height: null, bitrate: 99_000_000},
		{...base, id: 'split', width: 1920, height: 1080, hasAudio: false},
	];
	assert.equal(selectBrowserFormat(streams, {maxHeight: 1080}).id, 'landscape');
	assert.throws(() => selectBrowserFormat(streams, {maxHeight: 360}), {code: 'no_formats'});
	assert.deepEqual(
		streams.map((s) => s.id),
		['portrait', 'landscape', 'unknown', 'split'],
	);
});

test('public browser metadata removes every media URL without mutating the private result', () => {
	const media = {
		platform: 'xiaohongshu',
		id: 'note',
		cookie: 'SECRET',
		formats: [{...base, token: 'SECRET', urls: ['https://sns-video.xhscdn.com/video?sign=SECRET']}],
	};
	const result = publicBrowserMetadata(media);
	assert.doesNotMatch(JSON.stringify(result), /SECRET|xhscdn|urls/);
	assert.match(result.qualityScope, /当前页面/);
	assert.equal(media.formats[0].urls.length, 1);
	assert.equal(result.thumbnailUrl, null);
});

test('optional public covers reject credentials, media, deceptive hosts and unsafe schemes', () => {
	const cover = 'https://sns-webpic-qc.xhscdn.com/target.webp';
	const media = {platform: 'xiaohongshu', id: 'note', thumbnailUrl: cover, formats: [base]};
	assert.equal(publicBrowserMetadata(media).thumbnailUrl, cover);
	assert.equal(publicThumbnailUrl(cover.replace('https:', 'http:'), media), cover);
	for (const thumbnailUrl of [
		'javascript:alert(1)',
		'data:image/svg+xml,<svg/>',
		'file:///tmp/private.jpg',
		'https://evil.test/cover.jpg',
		'https://xhscdn.com.evil.test/cover.jpg',
		'https://secret@sns-webpic-qc.xhscdn.com/cover.jpg',
		'https://sns-webpic-qc.xhscdn.com:444/cover.jpg',
		'http://sns-webpic-qc.xhscdn.com:80/cover.jpg',
		'https://sns-video.xhscdn.com/media?sign=SECRET',
		'https://sns-webpic-qc.xhscdn.com/media.mp4?sign=SECRET',
	]) {
		assert.equal(publicBrowserMetadata({...media, thumbnailUrl}).thumbnailUrl, null, thumbnailUrl);
	}
	const target = {platform: 'youtube', id: 'EWvNQjAaOHw'};
	assert.equal(
		publicThumbnailUrl('https://i.ytimg.com/vi/EWvNQjAaOHw/hqdefault.jpg', target),
		'https://i.ytimg.com/vi/EWvNQjAaOHw/hqdefault.jpg',
	);
	assert.equal(
		publicThumbnailUrl('https://i.ytimg.com/vi/OTHER_VIDEO/hqdefault.jpg', target),
		null,
	);
	assert.equal(
		publicThumbnailUrl('https://i.ytimg.com/sb/EWvNQjAaOHw/storyboard.jpg', target),
		null,
	);
	assert.equal(
		publicThumbnailUrl('https://p3-pc-sign.douyinpic.com/cover.webp', {platform: 'douyin'}),
		'https://p3-pc-sign.douyinpic.com/cover.webp',
	);
	assert.equal(
		publicThumbnailUrl('https://i0.hdslb.com/bfs/archive/cover.jpg', {platform: 'bilibili'}),
		'https://i0.hdslb.com/bfs/archive/cover.jpg',
	);
});

test('media URL validation preserves signatures but rejects cross-platform and deceptive hosts', () => {
	const url = 'https://sns-video-v4.xhscdn.com/a.mp4?sign=abc%2B123&expires=123';
	assert.equal(validateMediaUrl(url, 'xiaohongshu'), url);
	const rejected = [
		'https://xhscdn.com.evil.test/a',
		'https://fake-xhscdn.com/a',
		'http://sns-video.xhscdn.com/a',
		'https://user:secret@sns-video.xhscdn.com/a',
		'https://sns-video.xhscdn.com:444/a',
		'file:///tmp/video.mp4',
		'https://v3.douyinvod.com/a',
	];
	for (const raw of rejected)
		assert.throws(() => validateMediaUrl(raw, 'xiaohongshu'), {code: 'invalid_media_url'});
	assert.equal(
		validateMediaUrl('https://v3.douyinvod.com/a', 'douyin'),
		'https://v3.douyinvod.com/a',
	);
	assert.throws(() => validateMediaUrl(url, 'youtube'), {code: 'invalid_media_url'});
});

test('invalid browser options and unsupported platforms fail before launching a browser', async () => {
	const target = {
		platform: 'xiaohongshu',
		id: '6adb92b90000000031037a66',
		url: 'https://www.xiaohongshu.com/explore/6adb92b90000000031037a66',
	};
	await assert.rejects(resolveWithBrowser(target, {maxHeight: NaN}), {code: 'invalid_options'});
	await assert.rejects(resolveWithBrowser(target, {timeoutMs: Infinity}), {
		code: 'invalid_options',
	});
	await assert.rejects(resolveWithBrowser(target, {browserSpaceId: 0}), {code: 'invalid_options'});
	for (const bad of [
		{maxBytes: NaN},
		{maxBytes: Infinity},
		{maxBytes: -1},
		{outputDir: 12},
		{egoBrowserPath: ''},
		{transport: 'hls'},
		{cookiesFile: 'cookies.txt'},
	]) {
		await assert.rejects(resolveWithBrowser(target, bad), {code: 'invalid_options'});
	}
	await assert.rejects(resolveWithBrowser({...target, platform: 'youtube'}), {
		code: 'unsupported_platform',
	});
});

test('browser engines publish the resolved video title only after media validation', async (t) => {
	const root = await mkdtemp(path.join(tmpdir(), 'fango-browser-title-'));
	t.after(() => rm(root, {recursive: true, force: true}));
	const stages = [];
	for (const platform of ['xiaohongshu', 'douyin']) {
		const id = platform === 'xiaohongshu' ? '6adb92b90000000031037a66' : '7677789451007649658';
		const target = {
			platform,
			id,
			url: `https://www.${platform}.com/${platform === 'xiaohongshu' ? 'explore' : 'video'}/${id}`,
		};
		const title = '中文视频 第 1 集';
		const url =
			platform === 'xiaohongshu'
				? 'https://sns-video.xhscdn.com/media.mp4'
				: 'https://v3.douyinvod.com/media.mp4';
		const media = {
			platform,
			id,
			title,
			durationSeconds: 12,
			formats: [{...base, urls: [url], size: 15}],
		};
		const egoBrowserPath = path.join(root, `fake-${platform}.mjs`),
			ffprobePath = path.join(root, 'fake-probe.mjs');
		await writeFile(
			egoBrowserPath,
			[
				'#!/usr/bin/env node',
				"import { readFile, writeFile } from 'node:fs/promises';",
				'const scriptUrl = JSON.parse(process.argv.at(-1).match(/await import\\((.+)\\)/)[1]);',
				'const source = await readFile(new URL(scriptUrl), "utf8");',
				'const resultFile = JSON.parse(source.match(/const resultFile=(.+);/)[1]);',
				'await writeFile(resultFile, JSON.stringify(' +
					JSON.stringify({ok: true, media, userAgent: 'test'}) +
					'));',
			].join('\n'),
		);
		await writeFile(
			ffprobePath,
			'#!/usr/bin/env node\nconsole.log(' +
				JSON.stringify(
					JSON.stringify({
						streams: [
							{codec_type: 'video', codec_name: 'h264', width: 720, height: 1280},
							{codec_type: 'audio', codec_name: 'aac', channels: 2},
						],
						format: {duration: '12'},
					}),
				) +
				');\n',
		);
		await chmod(egoBrowserPath, 0o755);
		await chmod(ffprobePath, 0o755);
		const fetchMock = t.mock.method(
			globalThis,
			'fetch',
			async () =>
				new Response('test-media-data', {
					headers: {'content-type': 'video/mp4', 'content-length': '15'},
				}),
		);
		const result = await downloadWithBrowser(target, {
			egoBrowserPath,
			ffprobePath,
			outputDir: path.join(root, platform),
			onProgress: (event) => stages.push(event),
		});
		fetchMock.mock.restore();
		assert.equal(path.basename(result.filepath), `${title}.mp4`);
		assert.deepEqual(await readdir(path.dirname(result.filepath)), [`${title}.mp4`]);
		assert.equal(await readFile(result.filepath, 'utf8'), 'test-media-data');
		assert.equal(result.validation.video, true);
		assert.equal(result.validation.audio, true);
		assert.equal(stages.at(-2).stage, 'validating');
		assert.equal(stages.at(-1).filepath, result.filepath);
	}
});

test(
	'a permission loss at the browser media write is a directory error and cleans the task',
	{
		skip:
			process.platform === 'win32' || process.getuid?.() === 0
				? 'Requires POSIX non-root directory permissions'
				: false,
	},
	async (t) => {
		const root = await mkdtemp(path.join(tmpdir(), 'fango-browser-storage-'));
		t.after(() => rm(root, {recursive: true, force: true}));
		const egoBrowserPath = path.join(root, 'fake-ego.mjs'),
			outputDir = path.join(root, 'output');
		const target = {
			platform: 'xiaohongshu',
			id: '6adb92b90000000031037a66',
			url: 'https://www.xiaohongshu.com/explore/6adb92b90000000031037a66',
		};
		const media = {
			...target,
			title: 'fixture',
			durationSeconds: 1,
			formats: [{...base, urls: ['https://sns-video.xhscdn.com/media.mp4']}],
		};
		// Implements only the extraction receipt contract; no real browser is launched.
		await writeFile(
			egoBrowserPath,
			[
				'#!/usr/bin/env node',
				"import { readFile, writeFile } from 'node:fs/promises';",
				'const scriptUrl = JSON.parse(process.argv.at(-1).match(/await import\\((.+)\\)/)[1]);',
				'const source = await readFile(new URL(scriptUrl), "utf8");',
				'const resultFile = JSON.parse(source.match(/const resultFile=(.+);/)[1]);',
				'await writeFile(resultFile, JSON.stringify(' +
					JSON.stringify({ok: true, media, userAgent: 'test'}) +
					'));',
			].join('\n'),
		);
		await chmod(egoBrowserPath, 0o755);
		t.mock.method(globalThis, 'fetch', async () => {
			const task = (await readdir(outputDir)).find((name) => name.startsWith('video-'));
			await chmod(path.join(outputDir, task), 0o555);
			return new Response('test-media-data', {headers: {'content-type': 'video/mp4'}});
		});
		await assert.rejects(downloadWithBrowser(target, {egoBrowserPath, outputDir}), (error) => {
			assert.equal(error.code, 'directory_unwritable');
			assert.doesNotMatch(error.message, /sns-video|\/output|EACCES/);
			return true;
		});
		assert.deepEqual(await readdir(outputDir), []);
	},
);
