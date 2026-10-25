import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {extractPageMedia} from '../src/page-extract.mjs';

const noteId = '6adb92b90000000031037a66';
const awemeId = '7695202760953793827';
const cdn = 'https://sns-video-v4.xhscdn.com/video.mp4?sign=example';
const dyCdn = 'https://v3.douyinvod.com/video.mp4';
const xhs = (note) => ({platform: 'xiaohongshu', expectedId: noteId, snapshot: {note}});
const dy = (detail) => ({platform: 'douyin', expectedId: awemeId, snapshot: {detail}});

test('reads all XHS codec families, keeps mirrors together, omits unrelated private state', () => {
	const common = {
		width: 720,
		height: 1404,
		duration: 146700,
		fps: 30,
		audioCodec: 'aac',
		masterUrl: cdn,
	};
	const result = extractPageMedia(
		xhs({
			noteId,
			title: '目标视频',
			user: {secret: 'do-not-return'},
			video: {
				media: {
					stream: {
						EF4: [
							{
								...common,
								videoCodec: 'h264',
								size: 19875696,
								avgBitrate: 1083882,
								backupUrls: [cdn, 'https://sns-bak-v1.xhscdn.com/backup.mp4'],
							},
						],
						EF5: [
							{...common, videoCodec: 'h265', size: 10946185},
							{...common, width: 984, height: 1920, videoCodec: 'h265', size: 10167052},
						],
					},
				},
			},
		}),
	);
	assert.equal(result.formats.length, 3);
	assert.equal(result.formats[0].urls.length, 2);
	assert.equal(result.formats[2].height, 1920);
	assert.equal(result.formats[2].size, 10167052);
	assert.equal(result.formats[0].bitrate, 1083882);
	assert.equal(result.durationSeconds, 146.7);
	assert.equal(result.title, '目标视频');
	assert.equal(JSON.stringify(result).includes('do-not-return'), false);
});

test('requires exact string identity before exposing any media', () => {
	assert.throws(() => extractPageMedia(xhs({noteId: 'aaaaaaaaaaaaaaaaaaaaaaaa'})), {
		code: 'identity_mismatch',
	});
	assert.throws(() => extractPageMedia(dy({awemeId: Number(awemeId)})), {
		code: 'identity_mismatch',
	});
	assert.throws(() => extractPageMedia(xhs({})), {code: 'identity_mismatch'});
	assert.throws(() => extractPageMedia({platform: 'douyin', expectedId: Number(awemeId)}), {
		code: 'invalid_options',
	});
});

test('rejects unexpected protocols, deceptive CDN hosts, credentials and custom ports', () => {
	const hostile = [
		'ftp://sns-video.xhscdn.com/a.mp4',
		'https://xhscdn.com.attacker.test/a.mp4',
		'https://fake-xhscdn.com/a.mp4',
		'https://user:pass@sns-video.xhscdn.com/a.mp4',
		'https://sns-video.xhscdn.com:444/a.mp4',
		'file:///tmp/a.mp4',
		'blob:https://www.xiaohongshu.com/id',
	];
	assert.throws(
		() =>
			extractPageMedia(
				xhs({
					noteId,
					video: {
						media: {
							stream: {
								EF4: [{masterUrl: hostile[0], backupUrls: hostile.slice(1)}],
							},
						},
					},
				}),
			),
		{code: 'no_formats'},
	);
});

test('upgrades only XHS HTTP CDN URLs without rewriting signed parameters', () => {
	const signed = 'http://sns-video-v4.xhscdn.com/v.mp4?sign=a%2fb%2B&oi=%30%31&t=001&b=a+b';
	const result = extractPageMedia(
		xhs({
			noteId,
			video: {
				media: {
					stream: {
						EF4: [
							{
								masterUrl: signed,
								backupUrls: [signed.replace('http:', 'https:'), 'http://evil.test/x.mp4'],
							},
						],
					},
				},
			},
		}),
	);
	assert.deepEqual(result.formats[0].urls, [signed.replace('http:', 'https:')]);
	assert.throws(
		() =>
			extractPageMedia(
				dy({
					awemeId,
					video: {
						playAddr: [{src: 'http://v3.douyinvod.com/v.mp4'}],
					},
				}),
			),
		{code: 'no_formats'},
	);
});

test('normalizes observed XHS codec tags and leaves unrecognized tags unknown', () => {
	const result = extractPageMedia(
		xhs({
			noteId,
			video: {
				media: {
					stream: {
						EF4: [
							{masterUrl: cdn, videoCodec: 'EF4'},
							{masterUrl: cdn, videoCodec: 'EF5'},
							{masterUrl: cdn, videoCodec: 'EF99'},
							{masterUrl: cdn},
						],
					},
				},
			},
		}),
	);
	assert.deepEqual(
		result.formats.map((format) => format.vcodec),
		['h264', null, null, null],
	);
});

test('Douyin excludes separate-audio rates and retains valid muxed mirrors', () => {
	const result = extractPageMedia(
		dy({
			awemeId,
			desc: '目标抖音',
			video: {
				duration: 2082067,
				playAddr: [{src: dyCdn}],
				bitRateList: [
					{audioFileId: 'separate-track', indexRange: '0-100', playAddr: [{src: dyCdn}]},
					{
						width: 1080,
						height: 1920,
						bitRate: 1200000,
						dataSize: 10100000,
						isH265: true,
						fps: 30,
						gearName: '1080p',
						playAddr: [{src: dyCdn}, {src: dyCdn}, {src: 'https://v9.douyinvod.com/video.mp4'}],
					},
				],
			},
		}),
	);
	assert.equal(result.formats.length, 1);
	assert.equal(result.formats[0].vcodec, 'h265');
	assert.equal(result.formats[0].urls.length, 2);
	assert.equal(result.durationSeconds, 2082.067);
	assert.equal(result.formats[0].bitrate, 1200000);
	assert.equal(result.formats[0].size, 10100000);
});

test('Douyin uses playAddr only with no bitRateList; never falls back from split-only rates', () => {
	const video = {width: 1080, height: 1920, playAddr: [{src: dyCdn}]};
	assert.equal(extractPageMedia(dy({awemeId, video})).formats.length, 1);
	assert.throws(
		() =>
			extractPageMedia(
				dy({
					awemeId,
					video: {
						...video,
						bitRateList: [{audioFileId: 'split', playAddr: [{src: dyCdn}]}],
					},
				}),
			),
		{code: 'no_formats'},
	);
});

test('Douyin videoFormat is a container; codec comes only from an explicit isH265 flag', () => {
	const result = extractPageMedia(
		dy({
			awemeId,
			video: {
				bitRateList: [
					{isH265: 0, videoFormat: 'mp4', playAddr: [{src: dyCdn}]},
					{isH265: false, videoFormat: 'mp4', playAddr: [{src: dyCdn}]},
					{isH265: 1, videoFormat: 'mp4', playAddr: [{src: dyCdn}]},
					{videoFormat: 'mp4', playAddr: [{src: dyCdn}]},
				],
			},
		}),
	);
	assert.deepEqual(
		result.formats.map((format) => format.vcodec),
		['h264', 'h264', 'h265', null],
	);
});

test('serialized function runs independently in browser state for both platforms', () => {
	const run = (args, globals) =>
		vm.runInNewContext(`(${extractPageMedia.toString()})(${JSON.stringify(args)})`, {
			URL,
			...globals,
		});
	const note = {noteId, video: {media: {stream: {EF5: [{masterUrl: cdn}]}}}};
	const result = run(
		{platform: 'xiaohongshu', expectedId: noteId},
		{
			window: {__INITIAL_STATE__: {note: {noteDetailMap: {[noteId]: {note}}}}},
		},
	);
	assert.equal(result.id, noteId);
	const detail = {awemeId, video: {duration: 1000, playAddr: [{src: dyCdn}]}};
	const dyResult = run(
		{platform: 'douyin', expectedId: awemeId},
		{
			document: {
				getElementById: (id) =>
					id === 'RENDER_DATA'
						? {textContent: encodeURIComponent(JSON.stringify({app: {videoDetail: detail}}))}
						: null,
			},
		},
	);
	assert.equal(dyResult.id, awemeId);
	assert.equal(dyResult.durationSeconds, 1);
	assert.throws(
		() =>
			run(
				{platform: 'douyin', expectedId: awemeId},
				{
					document: {getElementById: () => ({textContent: '%invalid'})},
				},
			),
		{code: 'browser_state_missing'},
	);
});

test('reports missing state and absent media without fabricating a ready result', () => {
	assert.throws(
		() => extractPageMedia({platform: 'xiaohongshu', expectedId: noteId, snapshot: {}}),
		{code: 'browser_state_missing'},
	);
	assert.throws(() => extractPageMedia(xhs({noteId, type: 'normal', imageList: []})), {
		code: 'no_formats',
	});
	assert.throws(
		() => extractPageMedia(dy({awemeId, video: {playAddr: [{src: 'https://evil.test/v.mp4'}]}})),
		{code: 'no_formats'},
	);
	assert.throws(() => extractPageMedia({platform: 'youtube', expectedId: 'EWvNQjAaOHw'}), {
		code: 'unsupported_platform',
	});
});

test('covers come only from the identity-checked target, with null when absent', () => {
	const cover = 'https://sns-webpic-qc.xhscdn.com/target.webp';
	const video = {media: {stream: {EF4: [{masterUrl: cdn}]}}};
	const note = {noteId, imageList: [{urlDefault: cover}], video};
	const result = extractPageMedia({
		...xhs(note),
		snapshot: {note, recommendation: {thumbnail: 'https://evil.test/recommendation.jpg'}},
	});
	assert.equal(result.thumbnailUrl, cover);
	assert.equal(extractPageMedia(xhs({noteId, video})).thumbnailUrl, null);
	assert.throws(() => extractPageMedia(xhs({...note, noteId: 'aaaaaaaaaaaaaaaaaaaaaaaa'})), {
		code: 'identity_mismatch',
	});
	const dyCover = 'https://p3-pc-sign.douyinpic.com/target.webp';
	assert.equal(
		extractPageMedia(dy({awemeId, video: {playAddr: [{src: dyCdn}], cover: [{src: dyCover}]}}))
			.thumbnailUrl,
		dyCover,
	);
	assert.equal(
		extractPageMedia(
			dy({awemeId, video: {playAddr: [{src: dyCdn}], originCover: {urlList: [dyCover]}}}),
		).thumbnailUrl,
		dyCover,
	);
});
