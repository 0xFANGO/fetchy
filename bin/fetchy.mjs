#!/usr/bin/env node
import {parseArgs} from 'node:util';
import {resolveVideo, downloadVideo} from '../src/index.mjs';

const HELP = `Fetchy Video Downloader — 先解析，再下载
fetchy get <URL> [--output <目录>]       保存到资料库，可另选输出目录
fetchy info <URL>                       查看来源和格式
fetchy batch -i <文件或 ->               每行一个 URL；逐条输出 JSON
fetchy browse <URL> / logout <URL>       打开或退出该站的专属会话
fetchy library tasks|task|search|export|folders|page|import|sync|resume|retry
node bin/fetchy.mjs resolve '<视频链接>' [选项]
node bin/fetchy.mjs download '<视频链接>' [选项]

--engine auto|yt-dlp           默认 auto；命令行全部平台使用 yt-dlp
--output <目录>                 默认 ./downloads
--max-height <像素>             实际帧高度上限（竖屏1080×1920的高度为1920）
--transport auto|hls           YouTube可显式选HLS
--timeout-ms <毫秒>             下载默认30分钟
--cookies-file <文件>           可选的用户显式提供Cookie文件，仅yt-dlp
--help                         显示帮助

结果JSON写入stdout，阶段信息写入stderr；Ctrl+C取消。
分享链接的 t= 只记录定位时间，默认下载整片。`;
async function legacy() {
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
}
try {
	const [action, ...args] = process.argv.slice(2);
	if (['get', 'info', 'batch'].includes(action))
		await (await import('./get.mjs')).runGetCommand(action, args);
	else if (action === 'library') await (await import('./library.mjs')).runLibraryCommand(args);
	else if (['browse', 'logout'].includes(action)) {
		if (args.length !== 1)
			throw Object.assign(new Error('请提供一个站点链接。'), {code: 'invalid_arguments'});
		const desktop = await import('./desktop.mjs');
		console.log(JSON.stringify(await desktop[action](args[0])));
	} else await legacy();
} catch (error) {
	// Unknown exception text can contain signed URLs; only our bounded errors are public.
	const known = typeof error.code === 'string' && !error.code.startsWith('ERR_');
	console.error(
		JSON.stringify(
			{
				error: {
					code: known ? error.code : 'invalid_arguments',
					message: known ? error.message : '参数或任务无效，请运行 --help。',
				},
			},
			null,
			2,
		),
	);
	process.exitCode = 1;
}
