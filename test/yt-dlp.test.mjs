import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { classifyEngineError, downloadWithYtDlp, resolveWithYtDlp } from '../src/yt-dlp.mjs';
import { runProcess } from '../src/process.mjs';

const target = { platform: 'youtube', id: 'test-id', url: 'https://www.youtube.com/watch?v=test-id&private_token=do-not-expose' };
const metadata = {
  id: 'test-id', title: 'Test video', duration: 12,
  vcodec: 'h264', acodec: 'aac',
  formats: [{ format_id: 'video', ext: 'mp4', vcodec: 'h264', acodec: 'none', height: 1080, width: 1920, url: 'https://cdn.test/video?sig=SECRET' },
    { format_id: 'audio', ext: 'm4a', vcodec: 'none', acodec: 'aac', url: 'https://cdn.test/audio?sig=SECRET' }],
  requested_formats: [{ vcodec: 'h264', acodec: 'none' }, { vcodec: 'none', acodec: 'aac' }],
};
const validProbe = { streams: [
  { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, disposition: { attached_pic: 0 } },
  { codec_type: 'audio', codec_name: 'aac', channels: 2 },
], format: { duration: '12.000' } };

async function fixture(t, { info = metadata, probe = validProbe, failure = '', noReceipt = false, outside = false, before = '', hang = false, templatePython = null } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'fango-engine-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ytDlpPath = path.join(root, 'yt-dlp.mjs');
  const ffprobePath = path.join(root, 'ffprobe.mjs');
  const trace = path.join(root, 'trace.jsonl');
  await writeFile(ytDlpPath, [
    '#!/usr/bin/env node',
    "import { writeFile, appendFile } from 'node:fs/promises';",
    "import { spawnSync } from 'node:child_process';",
    'const args = process.argv.slice(2);',
    'await appendFile(' + JSON.stringify(trace) + ', JSON.stringify(args) + "\\n");',
    before,
    'if (' + hang + ') await new Promise(() => setInterval(() => {}, 1000));',
    'if (' + JSON.stringify(failure) + ') { process.stderr.write(' + JSON.stringify(failure) + '); process.exit(1); }',
    'if (args.includes("--dump-single-json")) { console.log(' + JSON.stringify(JSON.stringify(info)) + '); process.exit(0); }',
    'const filepath = ' + (outside ? JSON.stringify(path.join(root, 'outside.mp4')) : 'args[args.indexOf("--output") + 1].replaceAll("%%", "%").replace("%(ext)s", "mp4")') + ';',
    'await writeFile(filepath, Buffer.from("test-media-data"));',
    'const record = {filepath, id: ' + JSON.stringify(info.id) + ', _old_archive_ids: ' + JSON.stringify(info._old_archive_ids ?? null) + '};',
    'if(record._old_archive_ids===null)delete record._old_archive_ids;',
    'let receiptText = JSON.stringify(record);',
    'if (' + JSON.stringify(templatePython) + ') {',
    '  const rendered = spawnSync(' + JSON.stringify(templatePython) + ', ["-c", "import json,sys,yt_dlp; print(yt_dlp.YoutubeDL({\\\"quiet\\\": True}).evaluate_outtmpl(sys.argv[1], json.loads(sys.argv[2])))", args[args.indexOf("--print-to-file")+1].replace(/^after_move:/,""), JSON.stringify(record)], {encoding:"utf8"});',
    '  if(rendered.status!==0)throw new Error("Real yt-dlp template rendering failed");',
    '  receiptText=rendered.stdout;',
    '}',
    'if (!' + noReceipt + ') await writeFile(args[args.indexOf("--print-to-file") + 2].replaceAll("%%", "%"), receiptText + "\\n");',
  ].join('\n'));
  await writeFile(ffprobePath, '#!/usr/bin/env node\nconsole.log(' + JSON.stringify(JSON.stringify(probe)) + ');\n');
  await chmod(ytDlpPath, 0o755);
  await chmod(ffprobePath, 0o755);
  const outputDir = path.join(root, 'output');
  return { root, trace, options: { ytDlpPath, ffprobePath, outputDir } };
}

test('resolve returns format metadata without signed URLs or unrelated private metadata', async (t) => {
  const { options } = await fixture(t);
  const result = await resolveWithYtDlp(target, options);
  assert.equal(result.availability, 'ready');
  assert.equal(result.formats[0].hasVideo, true);
  assert.equal(result.formats[0].hasAudio, false);
  assert.equal(result.formats[1].hasAudio, true);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|private_token|cdn\.test|requested_formats/);
});

test('download verifies actual tracks and records stages only after success', async (t) => {
  const { options, trace } = await fixture(t);
  const stages = [];
  const result = await downloadWithYtDlp(target, { ...options, maxHeight: 720, transport: 'hls', onProgress: ({ stage }) => stages.push(stage) });
  assert.equal(result.validation.video, true);
  assert.equal(result.validation.audio, true);
  assert.equal(result.validation.durationSeconds, 12);
  assert.equal(result.validation.fullDecode, false);
  assert.equal(result.transport, 'hls');
  assert.equal(result.bytes, 15);
  assert.equal(path.dirname(path.dirname(result.filepath)), options.outputDir);
  assert.deepEqual(await readdir(path.dirname(result.filepath)), ['media.mp4']);
  assert.deepEqual(stages, ['resolving', 'downloading', 'validating', 'complete']);
  const calls = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
  for (const args of calls) {
    assert(args.includes('--ignore-config'));
    assert(args.includes('--no-cookies-from-browser'));
    assert(args.includes('--abort-on-unavailable-fragments'));
    assert.equal(args.at(-1), target.url);
    assert.equal(args[args.indexOf('--format') + 1], 'bv*[height<=720][protocol^=m3u8]+ba[protocol^=m3u8]/b[height<=720][protocol^=m3u8]');
  }
});

test('a zero exit without final receipt cannot be reported successful', async (t) => {
  const { options } = await fixture(t, { noReceipt: true });
  await assert.rejects(downloadWithYtDlp(target, options), { code: 'output_invalid' });
  assert.deepEqual(await readdir(options.outputDir), []);
});

test('missing expected audio fails and removes the failed job', async (t) => {
  const { options } = await fixture(t, { probe: { ...validProbe, streams: [validProbe.streams[0]] } });
  await assert.rejects(downloadWithYtDlp(target, options), { code: 'output_invalid' });
  assert.deepEqual(await readdir(options.outputDir), []);
});

test('explicitly silent source can succeed with a verified video-only file', async (t) => {
  const info = { ...metadata, acodec: 'none', requested_formats: [{ vcodec: 'h264', acodec: 'none' }] };
  const { options } = await fixture(t, { info, probe: { ...validProbe, streams: [validProbe.streams[0]] } });
  const result = await downloadWithYtDlp(target, options);
  assert.equal(result.validation.audio, false);
});

test('a much shorter file and album artwork cannot masquerade as a video', async (t) => {
  const shorter = await fixture(t, { probe: { ...validProbe, format: { duration: '2' } } });
  await assert.rejects(downloadWithYtDlp(target, shorter.options), { code: 'output_invalid' });
  const artwork = await fixture(t, { probe: { ...validProbe, streams: [{ ...validProbe.streams[0], disposition: { attached_pic: 1 } }, validProbe.streams[1]] } });
  await assert.rejects(downloadWithYtDlp(target, artwork.options), { code: 'output_invalid' });
});

test('a receipt cannot point outside the task directory', async (t) => {
  const { options } = await fixture(t, { outside: true });
  await assert.rejects(downloadWithYtDlp(target, options), { code: 'output_invalid' });
  assert.deepEqual(await readdir(options.outputDir), []);
});

test('authentication failures are actionable and do not expose raw credentials', async (t) => {
  const { options } = await fixture(t, { failure: 'ERROR login required; https://cdn.test/?token=SECRET Cookie: session=TOPSECRET' });
  await assert.rejects(resolveWithYtDlp(target, options), (error) => {
    assert.equal(error.code, 'auth_required');
    assert.doesNotMatch(error.message, /SECRET|Cookie|https/);
    return true;
  });
});

test('cookies are only consumed through an explicit private copy', async (t) => {
  const { options, root, trace } = await fixture(t, { before: 'if (args.includes("--cookies")) await writeFile(args[args.indexOf("--cookies") + 1], "# modified cookie jar");' });
  const original = path.join(root, 'cookies.txt');
  await writeFile(original, '# original cookie jar');
  await resolveWithYtDlp(target, { ...options, cookiesFile: original });
  assert.equal(await readFile(original, 'utf8'), '# original cookie jar');
  const args = JSON.parse((await readFile(trace, 'utf8')).trim());
  const copy = args[args.indexOf('--cookies') + 1];
  assert.notEqual(copy, original);
  await assert.rejects(readFile(copy), { code: 'ENOENT' });
});

test('timeout and abort stop the executable and never produce a result', async (t) => {
  const { options } = await fixture(t, { hang: true });
  await assert.rejects(resolveWithYtDlp(target, { ...options, timeoutMs: 80 }), { code: 'timeout' });
  const controller = new AbortController();
  const promise = resolveWithYtDlp(target, { ...options, signal: controller.signal });
  setTimeout(() => controller.abort(), 80);
  await assert.rejects(promise, { code: 'cancelled' });
});

test('missing executables and invalid options fail explicitly', async () => {
  await assert.rejects(resolveWithYtDlp(target, { ytDlpPath: '/not-installed/yt-dlp' }), { code: 'dependency_missing' });
  await assert.rejects(resolveWithYtDlp(target, { maxHeight: -1 }), { code: 'invalid_options' });
  await assert.rejects(resolveWithYtDlp(target, { format: 'arbitrary' }), { code: 'invalid_options' });
});

test('live or playlist results are outside the single completed video contract', async (t) => {
  const live = await fixture(t, { info: { ...metadata, is_live: true } });
  await assert.rejects(resolveWithYtDlp(target, live.options), { code: 'unavailable' });
  const playlist = await fixture(t, { info: { _type: 'playlist', entries: [metadata] } });
  await assert.rejects(resolveWithYtDlp(target, playlist.options), { code: 'unavailable' });
});

test('progress observer failures do not invalidate a completed file', async (t) => {
  const { options } = await fixture(t);
  const result = await downloadWithYtDlp(target, { ...options, onProgress() { throw new Error('observer'); } });
  assert.equal(result.validation.video, true);
});

test('unbounded process output is stopped instead of accumulating in memory', async () => {
  await assert.rejects(runProcess(process.execPath, ['-e', "process.stdout.write('x'.repeat(100000)); setInterval(() => {}, 1000)"], { maxOutputBytes: 128, timeoutMs: 3000 }), { code: 'engine_error' });
});

test('format and stale-session errors keep their specific meaning', () => {
  assert.equal(classifyEngineError('Requested format is not available').code, 'no_formats');
  assert.equal(classifyEngineError('Fresh cookies are needed').code, 'session_required');
});

test('wrong video identities and the wrong Bilibili part are rejected', async (t) => {
  const wrong = await fixture(t, { info: { ...metadata, id: 'another-video' } });
  await assert.rejects(resolveWithYtDlp(target, wrong.options), { code: 'wrong_video' });
  const part = await fixture(t, { info: { ...metadata, id: 'BV19Pnb6REhD_p2' } });
  const bili = { platform: 'bilibili', id: 'BV19Pnb6REhD', page: 1, url: 'https://www.bilibili.com/video/BV19Pnb6REhD/' };
  await assert.rejects(resolveWithYtDlp(bili, part.options), { code: 'wrong_video' });
  assert.equal((await resolveWithYtDlp({ ...bili, page: 2 }, part.options)).sourceId, 'BV19Pnb6REhD_p2');
});

test('AV aliases must identify the requested part', async (t) => {
  const fixtureData = await fixture(t, { info: { ...metadata, id: 'BV19Pnb6REhD_p2', _old_archive_ids: ['bilibili 123456_part2'] } });
  const av = { platform: 'bilibili', id: 'av123456', page: 2, url: 'https://www.bilibili.com/video/av123456/?p=2' };
  assert.equal((await resolveWithYtDlp(av, fixtureData.options)).sourceId, 'BV19Pnb6REhD_p2');
  await assert.rejects(resolveWithYtDlp({ ...av, page: 1 }, fixtureData.options), { code: 'wrong_video' });
});

test('bitrate is reported in bit/s rather than yt-dlp kbit/s', async (t) => {
  const { options } = await fixture(t, { info: { ...metadata, formats: [{ ...metadata.formats[0], tbr: 1000 }] } });
  assert.equal((await resolveWithYtDlp(target, options)).formats[0].bitrate, 1_000_000);
});

const templatePython = fileURLToPath(new URL(process.platform === 'win32' ? '../.venv/Scripts/python.exe' : '../.venv/bin/python', import.meta.url));
const hasTemplateRenderer = existsSync(templatePython)
  && spawnSync(templatePython, ['-c', 'import yt_dlp'], { stdio: 'ignore', timeout: 5000 }).status === 0;
test('actual yt-dlp renderer produces valid receipts with absent and present optional archive IDs', {
  skip: hasTemplateRenderer ? false : 'Install requirements.txt into .venv to run the real yt-dlp template integration test.',
}, async (t) => {
  // This exercises the exact --print-to-file template passed by production code.
  // Building the receipt with JSON.stringify alone concealed yt-dlp's bare-NA behavior.
  const youtube = await fixture(t, { templatePython });
  const output = await downloadWithYtDlp(target, youtube.options);
  assert.equal(output.sourceId, target.id);
  assert.equal(output.validation.audio, true);
  const avInfo = { ...metadata, id: 'BV19Pnb6REhD_p2', _old_archive_ids: ['bilibili 123456_part2'] };
  const av = await fixture(t, { templatePython, info: avInfo });
  const avTarget = { platform: 'bilibili', id: 'av123456', page: 2, url: 'https://www.bilibili.com/video/av123456/?p=2' };
  const avOutput = await downloadWithYtDlp(avTarget, av.options);
  assert.equal(avOutput.sourceId, avInfo.id);
  assert.equal(avOutput.validation.audio, true);
});
