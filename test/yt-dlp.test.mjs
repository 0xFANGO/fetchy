import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {chmod, mkdtemp, readFile, readdir, realpath, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {classifyEngineError, downloadWithYtDlp, resolveWithYtDlp} from '../src/yt-dlp.mjs';
import {runProcess} from '../src/process.mjs';

const target = {
	platform: 'youtube',
	id: 'test-id',
	url: 'https://www.youtube.com/watch?v=test-id&private_token=do-not-expose',
};
const metadata = {
	id: 'test-id',
	title: 'Test video',
	duration: 12,
	vcodec: 'h264',
	acodec: 'aac',
	formats: [
		{
			format_id: 'video',
			ext: 'mp4',
			vcodec: 'h264',
			acodec: 'none',
			height: 1080,
			width: 1920,
			url: 'https://cdn.test/video?sig=SECRET',
		},
		{
			format_id: 'audio',
			ext: 'm4a',
			vcodec: 'none',
			acodec: 'aac',
			url: 'https://cdn.test/audio?sig=SECRET',
		},
	],
	requested_formats: [
		{vcodec: 'h264', acodec: 'none'},
		{vcodec: 'none', acodec: 'aac'},
	],
};
const validProbe = {
	streams: [
		{
			codec_type: 'video',
			codec_name: 'h264',
			pix_fmt: 'yuv420p',
			width: 1920,
			height: 1080,
			disposition: {attached_pic: 0},
		},
		{codec_type: 'audio', codec_name: 'aac', channels: 2},
	],
	format: {duration: '12.000', format_name: 'mov,mp4,m4a,3gp,3g2,mj2'},
};

async function fixture(
	t,
	{
		info = metadata,
		probe = validProbe,
		failure = '',
		noReceipt = false,
		outside = false,
		before = '',
		hang = false,
		templatePython = null,
		mediaSource = null,
		mediaExt = 'mp4',
		realProbe = false,
	} = {},
) {
	const root = await mkdtemp(path.join(tmpdir(), 'fetchy-engine-test-'));
	t.after(() => rm(root, {recursive: true, force: true}));
	const ytDlpPath = path.join(root, 'yt-dlp.mjs');
	const ffprobePath = path.join(root, 'ffprobe.mjs');
	const trace = path.join(root, 'trace.jsonl');
	await writeFile(
		ytDlpPath,
		[
			'#!/usr/bin/env node',
			"import { writeFile, appendFile, copyFile } from 'node:fs/promises';",
			"import { spawnSync } from 'node:child_process';",
			'const args = process.argv.slice(2);',
			'await appendFile(' + JSON.stringify(trace) + ', JSON.stringify(args) + "\\n");',
			before,
			'if (' + hang + ') await new Promise(() => setInterval(() => {}, 1000));',
			'if (' +
				JSON.stringify(failure) +
				') { process.stderr.write(' +
				JSON.stringify(failure) +
				'); process.exit(1); }',
			'if (args.includes("--dump-single-json")) { console.log(' +
				JSON.stringify(JSON.stringify(info)) +
				'); process.exit(0); }',
			'const filepath = ' +
				(outside
					? JSON.stringify(path.join(root, 'outside.mp4'))
					: 'args[args.indexOf("--output") + 1].replaceAll("%%", "%").replace("%(ext)s", ' +
						JSON.stringify(mediaExt) +
						')') +
				';',
			'if (' +
				JSON.stringify(mediaSource) +
				') await copyFile(' +
				JSON.stringify(mediaSource) +
				', filepath); else await writeFile(filepath, Buffer.from("test-media-data"));',
			'const record = {filepath, id: ' +
				JSON.stringify(info.id) +
				', _old_archive_ids: ' +
				JSON.stringify(info._old_archive_ids ?? null) +
				'};',
			'if(record._old_archive_ids===null)delete record._old_archive_ids;',
			'let receiptText = JSON.stringify(record);',
			'if (' + JSON.stringify(templatePython) + ') {',
			'  const rendered = spawnSync(' +
				JSON.stringify(templatePython) +
				', ["-c", "import json,sys,yt_dlp; print(yt_dlp.YoutubeDL({\\\"quiet\\\": True}).evaluate_outtmpl(sys.argv[1], json.loads(sys.argv[2])))", args[args.indexOf("--print-to-file")+1].replace(/^after_move:/,""), JSON.stringify(record)], {encoding:"utf8"});',
			'  if(rendered.status!==0)throw new Error("Real yt-dlp template rendering failed");',
			'  receiptText=rendered.stdout;',
			'}',
			'if (!' +
				noReceipt +
				') await writeFile(args[args.indexOf("--print-to-file") + 2].replaceAll("%%", "%"), receiptText + "\\n");',
		].join('\n'),
	);
	await writeFile(
		ffprobePath,
		'#!/usr/bin/env node\nconsole.log(' + JSON.stringify(JSON.stringify(probe)) + ');\n',
	);
	await chmod(ytDlpPath, 0o755);
	await chmod(ffprobePath, 0o755);
	const outputDir = path.join(root, 'output');
	return {
		root,
		trace,
		options: {ytDlpPath, ffprobePath: realProbe ? 'ffprobe' : ffprobePath, outputDir},
	};
}

test('resolve returns format metadata without signed URLs or unrelated private metadata', async (t) => {
	const {options} = await fixture(t);
	const result = await resolveWithYtDlp(target, options);
	assert.equal(result.availability, 'ready');
	assert.equal(result.formats[0].hasVideo, true);
	assert.equal(result.formats[0].hasAudio, false);
	assert.equal(result.formats[1].hasAudio, true);
	assert.equal(result.thumbnailUrl, null);
	assert.doesNotMatch(JSON.stringify(result), /SECRET|private_token|cdn\.test|requested_formats/);
});

test('yt-dlp uses only the verified video cover and tolerates missing or unsafe covers', async (t) => {
	const cover = 'https://i.ytimg.com/vi/test-id/hqdefault.jpg';
	const {options} = await fixture(t, {
		info: {
			...metadata,
			thumbnail: 'https://i.ytimg.com/vi/wrong-id/hqdefault.jpg',
			thumbnails: [
				{url: cover},
				{url: 'https://i.ytimg.com/sb/test-id/storyboard.jpg'},
				{url: 'https://evil.test/cover.jpg'},
			],
		},
	});
	assert.equal((await resolveWithYtDlp(target, options)).thumbnailUrl, cover);
	const unsafe = await fixture(t, {info: {...metadata, thumbnail: 'file:///tmp/private.jpg'}});
	assert.equal((await resolveWithYtDlp(target, unsafe.options)).thumbnailUrl, null);
	const wrong = await fixture(t, {info: {...metadata, id: 'wrong-id', thumbnail: cover}});
	await assert.rejects(resolveWithYtDlp(target, wrong.options), {code: 'wrong_video'});
});

test('download verifies actual tracks and records stages only after success', async (t) => {
	const {options, trace} = await fixture(t);
	const stages = [];
	const result = await downloadWithYtDlp(target, {
		...options,
		maxHeight: 720,
		transport: 'hls',
		onProgress: ({stage}) => stages.push(stage),
	});
	assert.equal(result.validation.video, true);
	assert.equal(result.validation.audio, true);
	assert.equal(result.validation.durationSeconds, 12);
	assert.equal(result.validation.fullDecode, false);
	assert.equal(result.validation.videoCodec, 'h264');
	assert.equal(result.validation.audioCodec, 'aac');
	assert.equal(result.validation.pixelFormat, 'yuv420p');
	assert.equal(result.validation.compatibleMp4, true);
	assert.equal(result.selectionPolicy, 'prefer-native-h264-aac');
	assert.equal(result.conversion, 'copy');
	assert.equal(result.transport, 'hls');
	assert.equal(result.bytes, 15);
	assert.equal(path.dirname(path.dirname(result.filepath)), await realpath(options.outputDir));
	assert.equal(path.basename(result.filepath), 'Test video.mp4');
	assert.deepEqual(await readdir(path.dirname(result.filepath)), ['Test video.mp4']);
	assert.deepEqual(stages, [
		'resolving',
		'downloading',
		'postprocessing',
		'validating',
		'complete',
	]);
	const calls = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
	for (const args of calls) {
		assert(args.includes('--ignore-config'));
		assert(args.includes('--no-cookies-from-browser'));
		assert(args.includes('--abort-on-unavailable-fragments'));
		assert.equal(args.at(-1), target.url);
		const selection = args[args.indexOf('--format') + 1];
		if (args.includes('--dump-single-json')) {
			assert.equal(
				selection,
				'bv*[height<=720][protocol^=m3u8]+ba[protocol^=m3u8]/b[height<=720][protocol^=m3u8]',
			);
		} else {
			assert.match(selection, /vcodec/);
			assert.match(selection, /acodec/);
			assert(
				selection.endsWith(
					'/bv*[height<=720][protocol^=m3u8]+ba[protocol^=m3u8]/b[height<=720][protocol^=m3u8]',
				),
			);
		}
	}
});

test('a zero exit without final receipt cannot be reported successful', async (t) => {
	const {options} = await fixture(t, {noReceipt: true});
	await assert.rejects(downloadWithYtDlp(target, options), {code: 'output_invalid'});
	assert.deepEqual(await readdir(options.outputDir), []);
});

test('missing expected audio fails and removes the failed job', async (t) => {
	const {options} = await fixture(t, {probe: {...validProbe, streams: [validProbe.streams[0]]}});
	await assert.rejects(downloadWithYtDlp(target, options), {code: 'output_invalid'});
	assert.deepEqual(await readdir(options.outputDir), []);
});

test('explicitly silent source can succeed with a verified video-only file', async (t) => {
	const info = {...metadata, acodec: 'none', requested_formats: [{vcodec: 'h264', acodec: 'none'}]};
	const {options} = await fixture(t, {
		info,
		probe: {...validProbe, streams: [validProbe.streams[0]]},
	});
	const result = await downloadWithYtDlp(target, options);
	assert.equal(result.validation.audio, false);
});

test('a much shorter file and album artwork cannot masquerade as a video', async (t) => {
	const shorter = await fixture(t, {
		probe: {...validProbe, format: {...validProbe.format, duration: '2'}},
	});
	await assert.rejects(downloadWithYtDlp(target, shorter.options), {code: 'output_invalid'});
	const artwork = await fixture(t, {
		probe: {
			...validProbe,
			streams: [{...validProbe.streams[0], disposition: {attached_pic: 1}}, validProbe.streams[1]],
		},
	});
	await assert.rejects(downloadWithYtDlp(target, artwork.options), {code: 'output_invalid'});
});

test('a receipt cannot point outside the task directory', async (t) => {
	const {options} = await fixture(t, {outside: true});
	await assert.rejects(downloadWithYtDlp(target, options), {code: 'output_invalid'});
	assert.deepEqual(await readdir(options.outputDir), []);
});

test('authentication failures are actionable and do not expose raw credentials', async (t) => {
	const {options} = await fixture(t, {
		failure: 'ERROR login required; https://cdn.test/?token=SECRET Cookie: session=TOPSECRET',
	});
	await assert.rejects(resolveWithYtDlp(target, options), (error) => {
		assert.equal(error.code, 'auth_required');
		assert.doesNotMatch(error.message, /SECRET|Cookie|https/);
		return true;
	});
});

test('cookies are only consumed through an explicit private copy', async (t) => {
	const {options, root, trace} = await fixture(t, {
		before:
			'if (args.includes("--cookies")) await writeFile(args[args.indexOf("--cookies") + 1], "# modified cookie jar");',
	});
	const original = path.join(root, 'cookies.txt');
	await writeFile(original, '# original cookie jar');
	await resolveWithYtDlp(target, {...options, cookiesFile: original});
	assert.equal(await readFile(original, 'utf8'), '# original cookie jar');
	const args = JSON.parse((await readFile(trace, 'utf8')).trim());
	const copy = args[args.indexOf('--cookies') + 1];
	assert.notEqual(copy, original);
	await assert.rejects(readFile(copy), {code: 'ENOENT'});
});

test('timeout and abort stop the executable and never produce a result', async (t) => {
	const {options} = await fixture(t, {hang: true});
	await assert.rejects(resolveWithYtDlp(target, {...options, timeoutMs: 80}), {code: 'timeout'});
	const controller = new AbortController();
	const promise = resolveWithYtDlp(target, {...options, signal: controller.signal});
	setTimeout(() => controller.abort(), 80);
	await assert.rejects(promise, {code: 'cancelled'});
});

test('missing executables and invalid options fail explicitly', async () => {
	await assert.rejects(resolveWithYtDlp(target, {ytDlpPath: '/not-installed/yt-dlp'}), {
		code: 'dependency_missing',
	});
	await assert.rejects(resolveWithYtDlp(target, {maxHeight: -1}), {code: 'invalid_options'});
	await assert.rejects(resolveWithYtDlp(target, {format: 'arbitrary'}), {code: 'invalid_options'});
});

test('live or playlist results are outside the single completed video contract', async (t) => {
	const live = await fixture(t, {info: {...metadata, is_live: true}});
	await assert.rejects(resolveWithYtDlp(target, live.options), {code: 'unavailable'});
	const playlist = await fixture(t, {info: {_type: 'playlist', entries: [metadata]}});
	await assert.rejects(resolveWithYtDlp(target, playlist.options), {code: 'unavailable'});
});

test('progress observer failures do not invalidate a completed file', async (t) => {
	const {options} = await fixture(t);
	const result = await downloadWithYtDlp(target, {
		...options,
		onProgress() {
			throw new Error('observer');
		},
	});
	assert.equal(result.validation.video, true);
});

test('unbounded process output is stopped instead of accumulating in memory', async () => {
	await assert.rejects(
		runProcess(
			process.execPath,
			['-e', "process.stdout.write('x'.repeat(100000)); setInterval(() => {}, 1000)"],
			{maxOutputBytes: 128, timeoutMs: 3000},
		),
		{code: 'engine_error'},
	);
});

test('format and stale-session errors keep their specific meaning', () => {
	assert.equal(classifyEngineError('Requested format is not available').code, 'no_formats');
	assert.equal(classifyEngineError('Fresh cookies are needed').code, 'session_required');
});

test('local disk errors retain actionable categories without leaking tool output or confusing HTTP 403', async (t) => {
	const scenarios = [
		[
			'ERROR: unable to write data: [Errno 28] No space left on device /private/path?token=SECRET',
			'disk_full',
		],
		[
			'ERROR: unable to open for writing: [Errno 13] Permission denied /private/path?token=SECRET',
			'directory_unwritable',
		],
	];
	for (const [message, code] of scenarios) {
		const {options} = await fixture(t, {
			before: `if (!args.includes('--dump-single-json')) { console.error(${JSON.stringify(message)}); process.exit(1); }`,
		});
		await assert.rejects(downloadWithYtDlp(target, options), (error) => {
			assert.equal(error.code, code);
			assert.doesNotMatch(error.message, /SECRET|private|Errno/);
			return true;
		});
		assert.deepEqual(await readdir(options.outputDir), []);
	}
	assert.equal(classifyEngineError('HTTP Error 403: Permission denied').code, 'network_error');
	assert.equal(classifyEngineError('Read-only file system').code, 'directory_unwritable');
});

test('wrong video identities and the wrong Bilibili part are rejected', async (t) => {
	const wrong = await fixture(t, {info: {...metadata, id: 'another-video'}});
	await assert.rejects(resolveWithYtDlp(target, wrong.options), {code: 'wrong_video'});
	const part = await fixture(t, {info: {...metadata, id: 'BV19Pnb6REhD_p2'}});
	const bili = {
		platform: 'bilibili',
		id: 'BV19Pnb6REhD',
		page: 1,
		url: 'https://www.bilibili.com/video/BV19Pnb6REhD/',
	};
	await assert.rejects(resolveWithYtDlp(bili, part.options), {code: 'wrong_video'});
	assert.equal(
		(await resolveWithYtDlp({...bili, page: 2}, part.options)).sourceId,
		'BV19Pnb6REhD_p2',
	);
});

test('AV aliases must identify the requested part', async (t) => {
	const fixtureData = await fixture(t, {
		info: {...metadata, id: 'BV19Pnb6REhD_p2', _old_archive_ids: ['bilibili 123456_part2']},
	});
	const av = {
		platform: 'bilibili',
		id: 'av123456',
		page: 2,
		url: 'https://www.bilibili.com/video/av123456/?p=2',
	};
	assert.equal((await resolveWithYtDlp(av, fixtureData.options)).sourceId, 'BV19Pnb6REhD_p2');
	await assert.rejects(resolveWithYtDlp({...av, page: 1}, fixtureData.options), {
		code: 'wrong_video',
	});
});

test('bitrate is reported in bit/s rather than yt-dlp kbit/s', async (t) => {
	const {options} = await fixture(t, {
		info: {...metadata, formats: [{...metadata.formats[0], tbr: 1000}]},
	});
	assert.equal((await resolveWithYtDlp(target, options)).formats[0].bitrate, 1_000_000);
});

const templatePython = fileURLToPath(
	new URL(
		process.platform === 'win32' ? '../.venv/Scripts/python.exe' : '../.venv/bin/python',
		import.meta.url,
	),
);
const hasTemplateRenderer =
	existsSync(templatePython) &&
	spawnSync(templatePython, ['-c', 'import yt_dlp'], {stdio: 'ignore', timeout: 5000}).status === 0;
test(
	'actual yt-dlp renderer produces valid receipts with absent and present optional archive IDs',
	{
		skip: hasTemplateRenderer
			? false
			: 'Install requirements.txt into .venv to run the real yt-dlp template integration test.',
	},
	async (t) => {
		// This exercises the exact --print-to-file template passed by production code.
		// Building the receipt with JSON.stringify alone concealed yt-dlp's bare-NA behavior.
		const youtube = await fixture(t, {templatePython});
		const output = await downloadWithYtDlp(target, youtube.options);
		assert.equal(output.sourceId, target.id);
		assert.equal(output.validation.audio, true);
		const avInfo = {
			...metadata,
			id: 'BV19Pnb6REhD_p2',
			_old_archive_ids: ['bilibili 123456_part2'],
		};
		const av = await fixture(t, {templatePython, info: avInfo});
		const avTarget = {
			platform: 'bilibili',
			id: 'av123456',
			page: 2,
			url: 'https://www.bilibili.com/video/av123456/?p=2',
		};
		const avOutput = await downloadWithYtDlp(avTarget, av.options);
		assert.equal(avOutput.sourceId, avInfo.id);
		assert.equal(avOutput.validation.audio, true);
	},
);

test(
	'real yt-dlp selection prefers compatible codecs within height/HLS limits and retains a source fallback',
	{
		skip: hasTemplateRenderer
			? false
			: 'Install requirements.txt into .venv to run the real yt-dlp format selection test.',
	},
	async (t) => {
		const {options, trace} = await fixture(t);
		await downloadWithYtDlp(target, {...options, maxHeight: 720, transport: 'hls'});
		const calls = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
		const downloadArgs = calls.find((args) => args.includes('--no-simulate'));
		const selector = downloadArgs[downloadArgs.indexOf('--format') + 1];
		const format = (id, video, audio, height, protocol = 'm3u8_native') => ({
			format_id: id,
			vcodec: video,
			acodec: audio,
			height,
			protocol,
			ext: video === 'none' ? (audio === 'opus' ? 'webm' : 'm4a') : 'mp4',
			url: 'https://example.test/' + id,
		});
		const audio = [format('aac', 'none', 'mp4a.40.2', null), format('opus', 'none', 'opus', null)];
		const avc = format('avc720', 'avc1.4d401f', 'none', 720);
		const av1 = format('av1-720', 'av01.0.05M.08', 'none', 720);
		const select = async (formats) => {
			const result = await runProcess(templatePython, [
				'-c',
				'import json,sys,yt_dlp; ydl=yt_dlp.YoutubeDL({"quiet":True}); results=list(ydl.build_format_selector(sys.argv[1])({"formats":json.loads(sys.argv[2]),"has_merged_format":False,"incomplete_formats":False})); print(json.dumps([{"id":r.get("format_id"),"video":r.get("vcodec"),"audio":r.get("acodec")} for r in results]))',
				selector,
				JSON.stringify(formats),
			]);
			assert.equal(result.code, 0, 'yt-dlp must accept the production selector');
			return JSON.parse(result.stdout);
		};
		const native = await select([
			...audio,
			avc,
			av1,
			format('avc1080', 'avc1.640028', 'none', 1080),
			format('https720', 'avc1.4d401f', 'none', 720, 'https'),
		]);
		assert.equal(native[0].id, 'avc720+aac');
		const fallback = await select([...audio, av1]);
		assert.equal(fallback[0].id, 'av1-720+opus');
		const muxed = await select([...audio, avc, format('muxed720', 'h264', 'aac', 720)]);
		assert.equal(muxed[0].id, 'muxed720');
		const unknownAudio = await select([format('unknown-audio', 'none', undefined, null), avc, av1]);
		assert.equal(unknownAudio[0].id, 'avc720+unknown-audio');
		assert.equal(unknownAudio[0].audio, null, 'unreported source audio is not claimed to be AAC');
	},
);

const hasRealMediaTools = ['ffmpeg', 'ffprobe'].every(
	(command) => spawnSync(command, ['-version'], {stdio: 'ignore', timeout: 5000}).status === 0,
);
test(
	'default download remuxes or transcodes real source media and verifies H.264/yuv420p/AAC MP4',
	{
		skip: hasRealMediaTools
			? false
			: 'Install FFmpeg and ffprobe to run the real-media compatibility integration test.',
	},
	async (t) => {
		const root = await mkdtemp(path.join(tmpdir(), 'fetchy-compatibility-test-'));
		t.after(() => rm(root, {recursive: true, force: true}));
		for (const config of [
			{
				name: 'native',
				video: 'libx264',
				audio: 'aac',
				ext: 'mkv',
				expected: 'remux',
				vcodec: 'h264',
				acodec: 'aac',
			},
			{
				name: 'fallback',
				video: 'libvpx-vp9',
				audio: 'libopus',
				ext: 'webm',
				expected: 'transcode',
				vcodec: 'vp9',
				acodec: 'opus',
			},
		]) {
			const source = path.join(root, config.name + '.' + config.ext);
			const made = await runProcess(
				'ffmpeg',
				[
					'-hide_banner',
					'-loglevel',
					'error',
					'-nostdin',
					'-f',
					'lavfi',
					'-i',
					'color=c=blue:s=160x90:r=5',
					'-f',
					'lavfi',
					'-i',
					'anullsrc=r=48000:cl=mono',
					'-t',
					'1',
					'-c:v',
					config.video,
					'-pix_fmt',
					'yuv420p',
					'-c:a',
					config.audio,
					source,
				],
				{timeoutMs: 30_000},
			);
			assert.equal(made.code, 0, 'short source media generation must succeed');
			const info = {
				...metadata,
				duration: 1,
				vcodec: config.vcodec,
				acodec: config.acodec,
				requested_formats: [
					{vcodec: config.vcodec, acodec: 'none'},
					{vcodec: 'none', acodec: config.acodec},
				],
			};
			const {options} = await fixture(t, {
				info,
				mediaSource: source,
				mediaExt: config.ext,
				realProbe: true,
			});
			const result = await downloadWithYtDlp(target, options);
			assert.equal(result.conversion, config.expected);
			assert.equal(result.validation.compatibleMp4, true);
			assert.equal(result.validation.width, 160);
			assert.equal(result.validation.height, 90);
			assert.equal(path.extname(result.filepath), '.mp4');
			assert.deepEqual(
				await readdir(path.dirname(result.filepath)),
				['Test video.mp4'],
				'only the validated title-named final file remains',
			);
			const checked = await runProcess('ffprobe', [
				'-v',
				'error',
				'-show_streams',
				'-show_format',
				'-of',
				'json',
				result.filepath,
			]);
			assert.equal(checked.code, 0);
			const actual = JSON.parse(checked.stdout);
			const video = actual.streams.find((stream) => stream.codec_type === 'video');
			const audio = actual.streams.find((stream) => stream.codec_type === 'audio');
			assert.equal(video.codec_name, 'h264');
			assert.equal(video.pix_fmt, 'yuv420p');
			assert.equal(audio.codec_name, 'aac');
			assert(actual.format.format_name.split(',').includes('mp4'));
		}
	},
);
