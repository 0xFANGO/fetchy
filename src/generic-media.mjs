import {createHash} from 'node:crypto';
import {createReadStream, createWriteStream, existsSync} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {mkdir, mkdtemp, open, rm, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openWeb, readBounded, saveWebFile, webUrl} from './public-http.mjs';
import {EngineError, runProcess} from './process.mjs';
import {publishVideoFile} from './filenames.mjs';
import {ensureCompatibleMp4} from './mp4.mjs';

const parseScript = fileURLToPath(new URL('./parse-web.py', import.meta.url));
const localPython = fileURLToPath(
	new URL(
		process.platform === 'win32' ? '../.venv/Scripts/python.exe' : '../.venv/bin/python',
		import.meta.url,
	),
);
async function parse(kind, url, text, options) {
	const {code, stdout} = await runProcess(
		existsSync(localPython) ? localPython : 'python3',
		[parseScript],
		{
			input: JSON.stringify({kind, url, text}),
			signal: options.signal,
			timeoutMs: 12000,
			maxOutputBytes: 8 * 1024 * 1024,
		},
	);
	if (code !== 0)
		throw new EngineError(
			'unsupported_content',
			'不能读取此页面或清单，请检查内容类型、依赖和访问权限。',
		);
	return JSON.parse(stdout);
}
function kindOf(url, mime) {
	if (/html/i.test(mime)) return 'page';
	if (/mpegurl/i.test(mime) || /\.m3u8$/i.test(url.pathname)) return 'hls';
	if (/dash\+xml/i.test(mime) || /\.mpd$/i.test(url.pathname)) return 'dash';
	if (/^video\//i.test(mime) || /\.(?:mp4|mov|webm|mkv|m4v)$/i.test(url.pathname)) return 'file';
	return null;
}
async function inspect(input, options) {
	const {url, response} = await openWeb(input, options);
	const kind = kindOf(url, response.headers['content-type'] ?? '');
	if (kind === 'file') {
		response.destroy();
		return {kind, url: url.href, title: path.basename(url.pathname)};
	}
	if (!kind) {
		response.destroy();
		throw new EngineError('no_formats', '没有识别到可保存的视频或清单。');
	}
	const text = (await readBounded(response, 2 * 1024 * 1024)).toString('utf8');
	if (kind !== 'page') return {kind, url: url.href, text, title: path.basename(url.pathname)};
	const page = await parse('page', url.href, text, options);
	for (const candidate of page.urls) {
		try {
			const source = webUrl(candidate);
			if (source.href === url.href) continue;
			const opened = await openWeb(source, options);
			const mediaKind = kindOf(opened.url, opened.response.headers['content-type'] ?? '');
			if (['file', 'dash', 'hls'].includes(mediaKind)) {
				const mediaText =
					mediaKind === 'file'
						? undefined
						: (await readBounded(opened.response, 2 * 1024 * 1024)).toString('utf8');
				opened.response.destroy();
				return {
					kind: mediaKind,
					url: opened.url.href,
					text: mediaText,
					title: page.title || path.basename(source.pathname),
				};
			}
			opened.response.destroy();
		} catch (err) {
			if (options.signal?.aborted) throw err;
		}
	}
	throw new EngineError('no_formats', '网页没有声明媒体。请播放视频后在扩展中选择媒体流。');
}
export async function readWebArticle(input, options = {}) {
	const {url, response} = await openWeb(input, options);
	if (!/html/i.test(response.headers['content-type'] || '')) {
		response.destroy();
		return null;
	}
	const text = (await readBounded(response, 2 * 1024 ** 2)).toString('utf8');
	const article = await parse('article', url.href, text, options);
	if (!article) return null;
	return {
		platform: 'web',
		id: (url.origin + url.pathname).length <= 256 ? url.origin + url.pathname : webIdentity(input),
		sourceUrl: url.href,
		...article,
	};
}
function attributes(line) {
	return Object.fromEntries(
		[...line.matchAll(/(?:^|[:,])([A-Z\d-]+)=("[^"]*"|[^,\s]+)/g)].map(([, key, val]) => [
			key,
			val.replace(/^"|"$/g, ''),
		]),
	);
}
async function readManifest(input, options) {
	const {url, response} = await openWeb(input, options);
	return {url: url.href, text: (await readBounded(response, 2 * 1024 * 1024)).toString('utf8')};
}
async function hlsTracks(source, options) {
	let {url, text} = source;
	let audio;
	for (let level = 0; level < 4; level++) {
		const lines = text
			.trim()
			.split(/\r?\n/)
			.map((l) => l.trim());
		if (lines[0] !== '#EXTM3U') throw new EngineError('output_invalid', 'HLS 清单格式无效。');
		const variants = [];
		for (let i = 0; i < lines.length; i++) {
			if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
			const attrs = attributes(lines[i]);
			const next = lines[i + 1];
			if (next && !next.startsWith('#'))
				variants.push({uri: next, attrs, height: Number(attrs.RESOLUTION?.split('x')[1]) || 0});
		}
		if (!variants.length)
			return [{url, text}, ...(audio ? [await readManifest(audio, options)] : [])];
		const variant = variants
			.filter((v) => !options.maxHeight || v.height <= options.maxHeight)
			.sort(
				(a, b) => b.height - a.height || Number(b.attrs.BANDWIDTH) - Number(a.attrs.BANDWIDTH),
			)[0];
		if (!variant) throw new EngineError('no_formats', '清单中没有符合画质限制的视频。');
		const renditions = lines
			.filter((l) => l.startsWith('#EXT-X-MEDIA:'))
			.map(attributes)
			.filter((a) => a.TYPE === 'AUDIO' && a['GROUP-ID'] === variant.attrs.AUDIO && a.URI);
		const selected = renditions.find((a) => a.DEFAULT === 'YES') ?? renditions[0];
		if (selected) audio = new URL(selected.URI, url).href;
		({url, text} = await readManifest(new URL(variant.uri, url), options));
	}
	throw new EngineError('unsupported_content', '播放列表嵌套过深。');
}
async function materializeHls(track, dir, options) {
	const lines = track.text
		.trim()
		.split(/\r?\n/)
		.map((l) => l.trim());
	if (!lines.includes('#EXT-X-ENDLIST'))
		throw new EngineError('unsupported_content', '仅支持已经结束的点播清单。');
	if (lines.length > 40000) throw new EngineError('size_limit', '分片数量过多。');
	let n = 0;
	const local = [];
	for (const line of lines) {
		if (line.startsWith('#EXT-X-KEY') && attributes(line).METHOD !== 'NONE')
			throw new EngineError('drm', '不支持加密的播放清单。');
		if (line.startsWith('#EXT-X-BYTERANGE') || line.includes('BYTERANGE='))
			throw new EngineError('unsupported_content', '此清单使用字节范围分片。');
		if (line.startsWith('#EXT-X-MAP:')) {
			const uri = attributes(line).URI;
			if (!uri) throw new EngineError('output_invalid', '清单缺少初始化分片。');
			const file = `init-${n++}.mp4`;
			await options.save(new URL(uri, track.url), path.join(dir, file));
			local.push(`#EXT-X-MAP:URI="${file}"`);
		} else if (line && !line.startsWith('#')) {
			const ext = /\.(?:m4s|mp4|aac)$/i.exec(new URL(line, track.url).pathname)?.[0] ?? '.ts';
			const file = `segment-${n++}${ext}`;
			await options.save(new URL(line, track.url), path.join(dir, file));
			local.push(file);
		} else if (
			/^#(?:EXTM3U$|EXTINF:|EXT-X-(?:ENDLIST$|TARGETDURATION:|MEDIA-SEQUENCE:|VERSION:|DISCONTINUITY$|INDEPENDENT-SEGMENTS$))/.test(
				line,
			)
		)
			local.push(line);
	}
	if (!n) throw new EngineError('no_formats', '播放清单为空。');
	const filename = path.join(dir, 'track.m3u8');
	await writeFile(filename, local.join('\n') + '\n');
	return filename;
}
async function materializeDash(track, dir, options) {
	const file = path.join(dir, 'track.mp4');
	for (const [i, uri] of track.urls.entries()) {
		const part = path.join(dir, `part-${i}`);
		await options.save(uri, part);
		await pipeline(createReadStream(part), createWriteStream(file, {flags: 'a', mode: 0o600}), {
			signal: options.signal,
		});
		await rm(part);
	}
	return file;
}
export function webIdentity(input) {
	const url = webUrl(input);
	url.hash = '';
	for (const name of new Set(url.searchParams.keys()))
		if (/^(?:utm_|x-amz-|x-goog-|xsec_|token$|access_token$|sig$|signature$|expires$)/i.test(name))
			url.searchParams.delete(name);
	url.searchParams.sort();
	return createHash('sha256').update(url.href).digest('hex').slice(0, 32);
}
export async function resolveGeneric(input, options = {}) {
	const deadline = AbortSignal.timeout(options.timeoutMs ?? 30000);
	const settings = {
		...options,
		signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline,
	};
	const source = await inspect(input, settings);
	let formats = [{id: source.kind, hasVideo: true}];
	if (source.kind === 'dash') {
		const tracks = await parse('dash', source.url, source.text, settings);
		formats = tracks.map((track, i) => ({
			id: 'dash-' + i,
			hasVideo: !track.audioOnly,
			hasAudio: track.audioOnly ? true : undefined,
			height: track.height || null,
			bitrate: track.bitrate || null,
		}));
		if (!formats.some((f) => f.hasVideo))
			throw new EngineError('no_formats', '未找到 DASH 视频轨道。');
	} else if (source.kind === 'hls') {
		if (!source.text.trimStart().startsWith('#EXTM3U'))
			throw new EngineError('output_invalid', 'HLS 清单格式无效。');
		const variants = source.text
			.split(/\r?\n/)
			.filter((line) => line.startsWith('#EXT-X-STREAM-INF:'))
			.map(attributes);
		if (variants.length)
			formats = variants.map((v, i) => {
				const [width, height] = (v.RESOLUTION || '').split('x').map(Number);
				return {
					id: 'hls-' + i,
					hasVideo: true,
					width: width || null,
					height: height || null,
					bitrate: Number(v.BANDWIDTH) || null,
				};
			});
	}
	return {
		platform: 'web',
		id: webIdentity(input),
		title: source.title,
		engine: 'web',
		kind: source.kind,
		availability: 'declared',
		formats,
	};
}
export async function downloadGeneric(input, options = {}) {
	const deadline = AbortSignal.timeout(options.timeoutMs ?? 1800000);
	const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
	const settings = {...options, signal};
	const source = await inspect(input, settings);
	const outputDir = path.resolve(options.outputDir ?? 'downloads');
	await mkdir(outputDir, {recursive: true});
	const dir = await mkdtemp(path.join(outputDir, '.fetchy-web-'));
	let remaining = options.maxBytes ?? 4 * 1024 ** 3;
	settings.save = async (url, output) => {
		const file = await saveWebFile(url, output, {...settings, maxBytes: remaining});
		remaining -= file.bytes;
	};
	try {
		let file = path.join(dir, 'media.mp4');
		if (source.kind === 'file') {
			await settings.save(source.url, file);
			// A server's MIME type and filename do not identify its actual container.
			const handle = await open(file);
			try {
				const head = Buffer.alloc(12);
				const {bytesRead} = await handle.read(head, 0, 12, 0);
				if (
					bytesRead !== 12 ||
					(!['ftyp', 'moov', 'mdat', 'free', 'wide'].includes(head.toString('ascii', 4, 8)) &&
						head.readUInt32BE(0) !== 0x1a45dfa3)
				)
					throw new EngineError('output_invalid', '文件内容不是 MP4、MOV 或 WebM 视频。');
			} finally {
				await handle.close();
			}
		} else {
			let tracks;
			if (source.kind === 'hls') tracks = await hlsTracks(source, settings);
			else {
				const all = await parse('dash', source.url, source.text, settings);
				const video = all
					.filter((t) => !t.audioOnly && (!options.maxHeight || t.height <= options.maxHeight))
					.sort((a, b) => b.height - a.height || b.bitrate - a.bitrate)[0];
				const audio = all.filter((t) => t.audioOnly).sort((a, b) => b.bitrate - a.bitrate)[0];
				if (!video) throw new EngineError('no_formats', '未找到 DASH 视频轨道。');
				tracks = audio ? [video, audio] : [video];
			}
			const args = ['-nostdin', '-v', 'error', '-xerror'];
			for (const [i, track] of tracks.entries()) {
				const sub = path.join(dir, String(i));
				await mkdir(sub);
				const inputPath =
					source.kind === 'hls'
						? await materializeHls(track, sub, settings)
						: await materializeDash(track, sub, settings);
				args.push(
					'-protocol_whitelist',
					'file',
					'-format_whitelist',
					source.kind === 'hls' ? 'hls,mpegts,mov,aac' : 'mov,matroska',
					'-i',
					inputPath,
				);
			}
			file = path.join(dir, 'assembled.mkv');
			args.push(
				'-map',
				'0:v:0',
				'-map',
				tracks.length > 1 ? '1:a:0' : '0:a:0?',
				'-c',
				'copy',
				file,
			);
			const mux = await runProcess(options.ffmpegLocation ?? 'ffmpeg', args, {
				signal,
				timeoutMs: options.timeoutMs ?? 1800000,
			});
			if (mux.code) throw new EngineError('output_invalid', '媒体分片未能完整合并。');
		}
		const conversion = await ensureCompatibleMp4(file, settings);
		const probe = await runProcess(
			options.ffprobePath ?? 'ffprobe',
			['-v', 'error', '-show_format', '-show_streams', '-of', 'json', conversion.filepath],
			{signal},
		);
		if (probe.code) throw new EngineError('output_invalid', '媒体文件校验失败。');
		const info = JSON.parse(probe.stdout);
		const video = info.streams.find((s) => s.codec_type === 'video');
		const audio = info.streams.find((s) => s.codec_type === 'audio');
		const durationSeconds = Number(info.format.duration);
		if (!video || !(durationSeconds > 0) || (options.maxHeight && video.height > options.maxHeight))
			throw new EngineError('output_invalid', '文件中缺少符合要求的视频。');
		const id = webIdentity(input),
			title = source.title || id;
		const filepath = await publishVideoFile(conversion.filepath, {
			platform: 'web',
			id,
			title,
			outputDir,
			signal,
		});
		return {
			platform: 'web',
			id,
			title,
			engine: 'web',
			filepath,
			bytes: (await stat(filepath)).size,
			validation: {
				video: true,
				audio: Boolean(audio),
				durationSeconds,
				width: video.width,
				height: video.height,
				videoCodec: video.codec_name,
				audioCodec: audio?.codec_name ?? null,
			},
		};
	} finally {
		await rm(dir, {recursive: true, force: true});
	}
}
