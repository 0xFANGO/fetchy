#!/usr/bin/env node
import {parseArgs} from 'node:util';
import {resolveVideo, downloadVideo} from '../src/index.mjs';

const HELP = `Fango Video Downloader — 先解析，再下载
node bin/fango-download.mjs resolve '<视频链接>' [选项]
node bin/fango-download.mjs download '<视频链接>' [选项]

--engine auto|yt-dlp|browser    默认 auto；小红书/抖音使用浏览器
--output <目录>                 默认 ./downloads
--max-height <像素>             实际帧高度上限（竖屏1080×1920的高度为1920）
--transport auto|hls           YouTube可显式选HLS
--timeout-ms <毫秒>             下载默认30分钟
--cookies-file <文件>           可选的用户显式提供Cookie文件，仅yt-dlp
--help                         显示帮助

结果JSON写入stdout，阶段信息写入stderr；Ctrl+C取消。
分享链接的 t= 只记录定位时间，默认下载整片。`;
try {
	const {values, positionals} = parseArgs({
		allowPositionals: true,
		strict: true,
		options: {
			engine: {type: 'string'},
			output: {type: 'string'},
			'max-height': {type: 'string'},
			transport: {type: 'string'},
			'timeout-ms': {type: 'string'},
			'cookies-file': {type: 'string'},
			help: {type: 'boolean'},
		},
	});
	if (values.help) {
		console.log(HELP);
		process.exit(0);
	}
	const [action, input] = positionals;
	if (!['resolve', 'download'].includes(action) || !input || positionals.length !== 2)
		throw Object.assign(new Error(HELP), {code: 'invalid_arguments'});
	const controller = new AbortController();
	process.once('SIGINT', () => controller.abort());
	const options = {
		engine: values.engine,
		outputDir: values.output,
		maxHeight: values['max-height'] === undefined ? undefined : Number(values['max-height']),
		transport: values.transport,
		timeoutMs: values['timeout-ms'] === undefined ? undefined : Number(values['timeout-ms']),
		cookiesFile: values['cookies-file'],
		signal: controller.signal,
		onProgress: (p) => process.stderr.write(JSON.stringify(p) + '\n'),
	};
	const result = await (action === 'resolve' ? resolveVideo : downloadVideo)(input, options);
	console.log(JSON.stringify(result, null, 2));
} catch (error) {
	// Unknown exception text can contain signed URLs; only our bounded errors are public.
	const known = typeof error.code === 'string' && !error.code.startsWith('ERR_');
	console.error(
		JSON.stringify(
			{
				error: {
					code: known ? error.code : 'invalid_arguments',
					message: known ? error.message : '参数或任务无效，请运行 --help。',
					...(error.browserSpaceId ? {browserSpaceId: error.browserSpaceId} : {}),
				},
			},
			null,
			2,
		),
	);
	process.exitCode = 1;
}
