import test from 'node:test';
import assert from 'node:assert/strict';
import { publicBrowserMetadata, resolveWithBrowser, selectBrowserFormat, validateMediaUrl } from '../src/browser.mjs';

const base = { hasVideo: true, hasAudio: true, width: 720, height: 1280, fps: 30, vcodec: 'h264', bitrate: 1_000_000 };

test('browser selection compares pixel area, then fps and codec compatibility', () => {
  const small = { ...base, id: 'small', bitrate: 9_000_000 };
  const large = { ...base, id: 'large', width: 1080, height: 1920, vcodec: 'h265', bitrate: 500_000 };
  assert.equal(selectBrowserFormat([small, large]).id, 'large');
  assert.equal(selectBrowserFormat([large, { ...large, id: 'compatible', vcodec: 'h264' }]).id, 'compatible');
  assert.equal(selectBrowserFormat([large, { ...large, id: 'fps', fps: 60 }]).id, 'fps');
});

test('height limits are actual frame heights and unknown or split streams are excluded', () => {
  const streams = [
    { ...base, id: 'portrait' },
    { ...base, id: 'landscape', width: 1280, height: 720 },
    { ...base, id: 'unknown', width: null, height: null, bitrate: 99_000_000 },
    { ...base, id: 'split', width: 1920, height: 1080, hasAudio: false },
  ];
  assert.equal(selectBrowserFormat(streams, { maxHeight: 1080 }).id, 'landscape');
  assert.throws(() => selectBrowserFormat(streams, { maxHeight: 360 }), { code: 'no_formats' });
  assert.deepEqual(streams.map((s) => s.id), ['portrait', 'landscape', 'unknown', 'split']);
});

test('public browser metadata removes every media URL without mutating the private result', () => {
  const media = { platform: 'xiaohongshu', id: 'note', formats: [{ ...base, urls: ['https://sns-video.xhscdn.com/video?sign=SECRET'] }] };
  const result = publicBrowserMetadata(media);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|xhscdn|urls/);
  assert.match(result.qualityScope, /当前页面/);
  assert.equal(media.formats[0].urls.length, 1);
});

test('media URL validation preserves signatures but rejects cross-platform and deceptive hosts', () => {
  const url = 'https://sns-video-v4.xhscdn.com/a.mp4?sign=abc%2B123&expires=123';
  assert.equal(validateMediaUrl(url, 'xiaohongshu'), url);
  const rejected = [
    'https://xhscdn.com.evil.test/a', 'https://fake-xhscdn.com/a',
    'http://sns-video.xhscdn.com/a', 'https://user:secret@sns-video.xhscdn.com/a',
    'https://sns-video.xhscdn.com:444/a', 'file:///tmp/video.mp4', 'https://v3.douyinvod.com/a',
  ];
  for (const raw of rejected) assert.throws(() => validateMediaUrl(raw, 'xiaohongshu'), { code: 'invalid_media_url' });
  assert.equal(validateMediaUrl('https://v3.douyinvod.com/a', 'douyin'), 'https://v3.douyinvod.com/a');
  assert.throws(() => validateMediaUrl(url, 'youtube'), { code: 'invalid_media_url' });
});

test('invalid browser options and unsupported platforms fail before launching a browser', async () => {
  const target = { platform: 'xiaohongshu', id: '6adb92b90000000031037a66', url: 'https://www.xiaohongshu.com/explore/6adb92b90000000031037a66' };
  await assert.rejects(resolveWithBrowser(target, { maxHeight: NaN }), { code: 'invalid_options' });
  await assert.rejects(resolveWithBrowser(target, { timeoutMs: Infinity }), { code: 'invalid_options' });
  await assert.rejects(resolveWithBrowser(target, { browserSpaceId: 0 }), { code: 'invalid_options' });
  for(const bad of [{maxBytes:NaN},{maxBytes:Infinity},{maxBytes:-1},{outputDir:12},{egoBrowserPath:''},{transport:'hls'},{cookiesFile:'cookies.txt'}]) {
    await assert.rejects(resolveWithBrowser(target,bad),{code:'invalid_options'});
  }
  await assert.rejects(resolveWithBrowser({ ...target, platform: 'youtube' }), { code: 'unsupported_platform' });
});
