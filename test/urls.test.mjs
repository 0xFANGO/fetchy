import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, resolveTarget } from '../src/urls.mjs';

test('sample identities and timestamps survive normalization without tracking', () => {
  assert.deepEqual(normalizeUrl('https://www.youtube.com/watch?v=EWvNQjAaOHw&t=4538s'), { platform:'youtube', id:'EWvNQjAaOHw', url:'https://www.youtube.com/watch?v=EWvNQjAaOHw', startTimeSeconds:4538 });
  assert.equal(normalizeUrl('https://www.douyin.com/jingxuan?modal_id=7695202760953793827').url, 'https://www.douyin.com/video/7695202760953793827');
  assert.equal(normalizeUrl('https://www.bilibili.com/video/BV19Pnb6REhD/?p=2&spm_id=tracker').url, 'https://www.bilibili.com/video/BV19Pnb6REhD/?p=2');
  const note = normalizeUrl('https://www.xiaohongshu.com/explore/6adb92b90000000031037a66?xsec_token=a%2Bb%3D&xsec_source=pc_feed&tracking=1');
  assert.equal(new URL(note.url).searchParams.get('xsec_token'), 'a+b=');
  assert.equal(new URL(note.url).searchParams.has('tracking'), false);
});
test('share prose, short YouTube URL, and long timestamp', () => {
  assert.equal(normalizeUrl('来看看 https://youtu.be/EWvNQjAaOHw?t=1h15m38s 复制打开').startTimeSeconds, 4538);
});
test('reject unrelated hosts, ambiguous content, credentials and invalid page', () => {
  for(const url of ['https://youtube.com.evil.test/watch?v=EWvNQjAaOHw','http://youtu.be/EWvNQjAaOHw','https://u:p@youtu.be/EWvNQjAaOHw','https://www.youtube.com/playlist?list=abc','https://www.bilibili.com/video/BV19Pnb6REhD/?p=-1','https://youtu.be/EWvNQjAaOHw https://youtu.be/aaaaaaaaaaa']) assert.throws(()=>normalizeUrl(url));
});
test('short redirect validates every destination before requesting it', async () => {
  let calls=0;
  const badFetch=async()=> { calls++;return new Response(null,{status:302,headers:{location:'https://127.0.0.1/internal'}}); };
  await assert.rejects(resolveTarget('https://b23.tv/example',{fetchImpl:badFetch}), {code:'unsupported_platform'});
  assert.equal(calls,1);
  const goodFetch=async()=>new Response(null,{status:302,headers:{location:'https://www.bilibili.com/video/BV19Pnb6REhD/?p=3'}});
  assert.equal((await resolveTarget('https://b23.tv/example',{fetchImpl:goodFetch})).page,3);
});
