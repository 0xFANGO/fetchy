#!/usr/bin/env node
import {parseArgs} from 'node:util';
import {resolveVideo, downloadVideo} from '../src/index.mjs';

const HELP = `Fetchy — 把作品保存到本机资料库

保存
  fetchy <链接>                          保存到资料库，同 fetchy get
  fetchy get <链接> [-o 目录] [--audio]   另存一份到目录；--audio 只要音频
  fetchy get -i <文件>                   每行一个链接，逐条输出 JSON
  fetchy info <链接>                     查看来源和可用格式

登录（在桌面端内置浏览器完成，三端共用）
  fetchy login <站点>                    例如 fetchy login bilibili
  fetchy logout <站点>
  fetchy accounts                        各站登录状态

收藏夹
  fetchy folders <站点>                  列出收藏夹（目前支持 bilibili）
  fetchy sync <收藏夹链接>                保存整个收藏夹

资料库
  fetchy list                            已保存的作品
  fetchy search <关键词>
  fetchy retry [任务ID]                   重试失败和缺项的条目，默认最近一个任务

结果 JSON 写入 stdout，进度写入 stderr；Ctrl+C 取消。
fetchy help all 查看旧命令和全部选项。`;

const HELP_ALL = `旧命令（保持兼容）
fetchy batch -i <文件或 ->               同 fetchy get -i
fetchy browse <URL>                      在桌面端内置浏览器打开
fetchy library tasks|task|search|export|folders|page|import|sync|resume|retry
node bin/fetchy.mjs resolve '<视频链接>' [选项]
node bin/fetchy.mjs download '<视频链接>' [选项]

resolve / download 选项
--engine auto|yt-dlp           默认 auto；命令行全部平台使用 yt-dlp
--output <目录>                 默认 ./downloads
--max-height <像素>             实际帧高度上限（竖屏1080×1920的高度为1920）
--transport auto|hls           YouTube可显式选HLS
--timeout-ms <毫秒>             下载默认30分钟
--cookies-file <文件>           可选的用户显式提供Cookie文件，仅yt-dlp

get 另有 --max-height、--timeout-ms、--transport、--cookies-file。
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
		console.log(HELP + '\n\n' + HELP_ALL);
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
const looksLikeLink = (value) => /https?:\/\/|^[\w-]+(?:\.[\w-]+)+\//i.test(value ?? '');
try {
	const [action, ...args] = process.argv.slice(2);
	const print = (value) => console.log(JSON.stringify(value, null, 2));
	if (!action || ['-h', '--help'].includes(action) || (action === 'help' && !args.length))
		console.log(HELP);
	else if (action === 'help') console.log(HELP_ALL);
	else if (['get', 'info', 'batch'].includes(action))
		await (await import('./get.mjs')).runGetCommand(action, args);
	else if (action === 'library') await (await import('./library.mjs')).runLibraryCommand(args);
	else if (['list', 'search', 'retry', 'folders', 'sync'].includes(action))
		await (await import('./library.mjs')).runShortCommand(action, args);
	else if (['login', 'logout', 'browse'].includes(action)) {
		if (args.length !== 1)
			throw Object.assign(new Error('请提供一个站点名称或链接。'), {code: 'invalid_arguments'});
		const desktop = await import('./desktop.mjs');
		print(await desktop[action](args[0]));
	} else if (action === 'accounts') print(await (await import('./accounts.mjs')).listAccounts());
	else if (['resolve', 'download'].includes(action) || action.startsWith('-')) await legacy();
	else if (looksLikeLink(action))
		await (await import('./get.mjs')).runGetCommand('get', [action, ...args]);
	else throw Object.assign(new Error(HELP), {code: 'invalid_arguments'});
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
