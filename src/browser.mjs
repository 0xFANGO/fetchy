import { mkdir, mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { publishVideoFile } from './filenames.mjs';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { EngineError, fileWriteError, runProcess } from './process.mjs';
import { extractPageMedia } from './page-extract.mjs';
import { publicThumbnailUrl } from './thumbnails.mjs';

function emit(options, stage, extra = {}) {
  try { options.onProgress?.({ stage, engine: 'browser', ...extra }); } catch { /* observer */ }
}
function check(options) {
  if (options.maxHeight !== undefined && (!Number.isSafeInteger(options.maxHeight) || options.maxHeight < 1 || options.maxHeight > 16384)) throw new EngineError('invalid_options', 'maxHeight 必须是 1–16384 的整数。');
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 2147483647)) throw new EngineError('invalid_options', 'timeoutMs 必须是有效的正整数。');
  if (options.browserSpaceId !== undefined && (!Number.isSafeInteger(options.browserSpaceId) || options.browserSpaceId < 1)) throw new EngineError('invalid_options', 'browserSpaceId 必须是有效任务空间编号。');
  if (options.maxBytes !== undefined && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1)) throw new EngineError('invalid_options', 'maxBytes 必须是正整数。');
  if (options.format !== undefined || (options.transport !== undefined && options.transport !== 'auto')) throw new EngineError('invalid_options', '浏览器引擎当前仅接受合流直链，请用 maxHeight 选择画质。');
  if (options.cookiesFile !== undefined) throw new EngineError('invalid_options', 'cookiesFile 仅可用于 yt-dlp 引擎。');
  for(const key of ['outputDir','egoBrowserPath','ffprobePath']) if(options[key]!==undefined && (typeof options[key]!=='string'||!options[key]||options[key].includes('\0'))) throw new EngineError('invalid_options',`${key} 必须是有效路径。`);
}

export function publicBrowserMetadata(media) {
  return {
    platform: media.platform, id: media.id, title: media.title,
    thumbnailUrl: publicThumbnailUrl(media.thumbnailUrl, media),
    durationSeconds: media.durationSeconds ?? null,
    formats: media.formats.map(({ id, ext, protocol, width, height, fps, vcodec, acodec, bitrate, size, hasVideo, hasAudio }) =>
      ({ id, ext, protocol, width, height, fps, vcodec, acodec, bitrate, size, hasVideo, hasAudio })),
    engine: 'browser', availability: 'ready',
    qualityScope: '当前页面明确提供的合流格式；不代表平台全部画质',
  };
}

export function selectBrowserFormat(formats, { maxHeight } = {}) {
  const selected = formats.filter(f => f.hasVideo && f.hasAudio && f.width > 0 && f.height > 0 && (!maxHeight || f.height <= maxHeight));
  const compatibility = c => /264|avc/i.test(c ?? '') ? 2 : /265|hevc/i.test(c ?? '') ? 1 : 0;
  selected.sort((a,b) => b.width*b.height-a.width*a.height || (b.fps||0)-(a.fps||0) || compatibility(b.vcodec)-compatibility(a.vcodec) || (a.vcodec === b.vcodec ? (b.bitrate||0)-(a.bitrate||0) : 0));
  if (!selected.length) throw new EngineError('no_formats', '当前页面没有符合清晰度限制的合流视频。');
  return selected[0];
}

async function extract(target, options) {
  check(options);
  if (!['xiaohongshu', 'douyin'].includes(target.platform)) throw new EngineError('unsupported_platform', '浏览器引擎当前仅支持小红书和抖音。');
  emit(options, 'resolving');
  const dir = await mkdtemp(path.join(tmpdir(), 'fango-browser-'));
  const resultFile = path.join(dir, 'result.json');
  const scriptFile = path.join(dir, 'extract.mjs');
  // Only scoped media data crosses the browser boundary; never cookies or whole page state.
  const source = `const fs=await import('node:fs/promises');
const resultFile=${JSON.stringify(resultFile)};
let task;
try {
 task=await taskSpace(${JSON.stringify(options.browserSpaceId ?? `fango-download-${randomUUID()}`)});
 const page=task.page('p1');
 await page.goto(${JSON.stringify(target.platform === 'douyin' ? `https://www.douyin.com/jingxuan?modal_id=${target.id}` : target.url)});
 await page.waitForFunction(({platform,id}) => {
   if(![...document.querySelectorAll('video')].some(v=>v.readyState>=1))return false;
   if(platform==='xiaohongshu')return window.__INITIAL_STATE__?.note?.noteDetailMap?.[id]?.note?.noteId===id;
   try{return JSON.parse(decodeURIComponent(document.getElementById('RENDER_DATA')?.textContent))?.app?.videoDetail?.awemeId===id;}catch{return false;}
 }, ${JSON.stringify({platform:target.platform,id:target.id})}, {timeout:20000});
 const extracted=await page.evaluate((args)=>{try{return{ok:true,media:(${extractPageMedia.toString()})(args)};}catch(e){return{ok:false,code:e.code};}},${JSON.stringify({platform:target.platform,expectedId:target.id})});
 if(!extracted.ok)throw Object.assign(new Error('media extraction failed'),{code:extracted.code});
 const media=extracted.media;
 const userAgent=await page.evaluate(()=>navigator.userAgent);
 await fs.writeFile(resultFile,JSON.stringify({ok:true,media,userAgent}),{mode:0o600});
 ${options.browserSpaceId ? '' : 'await task.finish({keep:[]});'}
} catch(error) {
 await fs.writeFile(resultFile,JSON.stringify({ok:false,code:typeof error.code==='string'?error.code:'browser_state_missing',spaceId:task?.spaceId}),{mode:0o600});
 ${options.browserSpaceId ? '' : 'if(task) await task.handOff();'}
}`;
  try {
    await writeFile(scriptFile, source, { mode: 0o600 });
    let result;
    try {
      result = await runProcess(options.egoBrowserPath ?? 'ego-browser', ['nodejs', '-e', `await import(${JSON.stringify(pathToFileURL(scriptFile).href)})`], { signal: options.signal, timeoutMs: Math.min(options.timeoutMs ?? 60000, 60000), maxOutputBytes: 1024*1024 });
    } catch(error) {
      if(error.code==='dependency_missing')error.dependency='ego-browser';
      throw error;
    }
    if (result.code !== 0) throw new EngineError('browser_unavailable', '无法连接浏览器，请检查 Ego Browser 是否已启动。');
    let value;
    try { value = JSON.parse(await readFile(resultFile, 'utf8')); } catch { throw new EngineError('browser_unavailable', '浏览器没有返回媒体信息。'); }
    if (!value.ok) {
      const error = new EngineError(['identity_mismatch','no_formats','not_video','drm'].includes(value.code) ? value.code : 'browser_state_missing', '页面没有提供目标视频的可用媒体信息，请在浏览器确认登录、验证和视频状态。');
      error.browserSpaceId = value.spaceId;
      throw error;
    }
    if (value.media?.id !== target.id || value.media?.platform !== target.platform) throw new EngineError('identity_mismatch', '页面视频与输入链接不一致。');
    return value;
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export async function resolveWithBrowser(target, options = {}) {
  return publicBrowserMetadata((await extract(target, options)).media);
}

export function validateMediaUrl(raw, platform) {
  let url;
  try { url = new URL(raw); } catch { throw new EngineError('invalid_media_url', '媒体地址无效。'); }
  const suffix = platform === 'xiaohongshu' ? '.xhscdn.com' : platform === 'douyin' ? '.douyinvod.com' : null;
  if (!suffix || url.protocol !== 'https:' || url.username || url.password || url.port || !url.hostname.endsWith(suffix)) throw new EngineError('invalid_media_url', '媒体地址不在该平台已验证的 CDN 范围内。');
  return url.href;
}

async function fetchMedia(url, target, headers, signal) {
  let current = validateMediaUrl(url, target.platform);
  for (let i=0;i<5;i++) {
    const response=await fetch(current,{headers,signal,redirect:'manual'});
    if ([301,302,303,307,308].includes(response.status)) {
      await response.body?.cancel();
      const next=response.headers.get('location');
      if (!next) throw new EngineError('network_error','媒体跳转地址缺失。');
      current=validateMediaUrl(new URL(next,current).href,target.platform);
      continue;
    }
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw new EngineError(response.status===403||response.status===410?'media_expired':'network_error','媒体请求失败或签名已过期，请重新解析。');
    }
    const type=response.headers.get('content-type')||'';
    if (/text|json|html/.test(type)) { await response.body.cancel();throw new EngineError('output_invalid','媒体地址返回了网页而非视频。'); }
    return response;
  }
  throw new EngineError('network_error','媒体跳转次数过多。');
}

export async function downloadWithBrowser(target, options = {}) {
  check(options);
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 30*60_000);
  const signal = AbortSignal.any([timeout, ...(options.signal ? [options.signal] : [])]);
  let directory, successful=false;
  try {
    const {media,userAgent}=await extract(target,{...options,signal});
    const format=selectBrowserFormat(media.formats, options);
    const outputRoot=path.resolve(options.outputDir ?? 'downloads');
    await mkdir(outputRoot,{recursive:true});
    directory=await mkdtemp(path.join(outputRoot,'video-'));
    const temporary=path.join(directory,'media.part');
    const headers={'user-agent':userAgent,referer:`https://www.${target.platform==='douyin'?'douyin':'xiaohongshu'}.com/`};
    let bytes=0,lastError;
    emit(options,'downloading');
    for(const raw of format.urls) {
      bytes=0;
      try {
        const response=await fetchMedia(raw,target,headers,signal);
        const limit=options.maxBytes ?? 4*1024*1024*1024;
        const count=new Transform({ transform(chunk,encoding,callback) {
          bytes+=chunk.length;
          if(bytes>limit) callback(new EngineError('size_limit','视频超过当前下载体积上限。'));
          else callback(null,chunk);
        }});
        await pipeline(Readable.fromWeb(response.body),count,createWriteStream(temporary),{signal});
        const declared=Number(response.headers.get('content-length'));
        if(!bytes || (declared>0 && bytes!==declared) || (format.size>0 && bytes!==format.size)) throw new EngineError('output_invalid','媒体字节数与声明长度不一致。');
        lastError=null;break;
      } catch(error) {
        lastError=error;await rm(temporary,{force:true});
        if(signal.aborted || ['invalid_media_url','size_limit'].includes(error.code)) throw error;
      }
    }
    if(lastError || !bytes) throw lastError ?? new EngineError('no_formats','没有可下载的媒体地址。');
    emit(options,'validating');
    const probe=await runProcess(options.ffprobePath ?? 'ffprobe',['-v','error','-show_streams','-show_format','-of','json',temporary],{signal,timeoutMs:30000,maxOutputBytes:2*1024*1024});
    let info;
    try{info=JSON.parse(probe.stdout);}catch{throw new EngineError('output_invalid','下载文件无法识别。');}
    const video=info.streams?.find(s=>s.codec_type==='video'&&!s.disposition?.attached_pic&&s.width>0&&s.height>0);
    const audio=info.streams?.find(s=>s.codec_type==='audio'&&s.channels>0);
    const duration=Number(info.format?.duration);
    if(probe.code!==0||!video||!audio||!Number.isFinite(duration)||duration<=0||duration<(media.durationSeconds||0)-Math.max(3,(media.durationSeconds||0)*0.01)) {
      const error=new EngineError('output_invalid','下载文件缺少音视频轨道或时长不完整。');
      error.details={video:!!video,audio:!!audio,durationSeconds:duration,expectedDurationSeconds:media.durationSeconds,probeExitCode:probe.code};
      throw error;
    }
    const filepath=await publishVideoFile(temporary,{title:media.title,platform:target.platform,id:target.id,signal});
    const result={platform:target.platform,id:target.id,engine:'browser',filepath,bytes:(await stat(filepath)).size,format:{...publicBrowserMetadata({...media,formats:[format]}).formats[0],vcodec:video.codec_name??null,acodec:audio.codec_name??null},validation:{video:true,audio:true,durationSeconds:duration,width:video.width,height:video.height,method:'ffprobe',fullDecode:false}};
    successful=true;
    emit(options,'complete',{filepath,bytes});
    return result;
  }catch(error){
    if(options.signal?.aborted) throw new EngineError('cancelled','任务已取消。');
    if(timeout.aborted) throw new EngineError('timeout','任务超过时间限制。');
    const storageError=fileWriteError(error);if(storageError)throw storageError;
    if(error instanceof EngineError) throw error;
    throw new EngineError('network_error','浏览器媒体下载失败，请检查网络后重新解析。');
  }finally{if(directory&&!successful)await rm(directory,{recursive:true,force:true});}
}
