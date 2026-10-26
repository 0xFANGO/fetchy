const messages = {
	invalid_request: '本地组件收到无效请求，请重新打开插件。',
	invalid_url: '请输入一个有效的视频链接。',
	multiple_urls: '请只保留一个视频链接。',
	unsupported_platform: '暂不支持此网站，请使用 YouTube、B站、小红书或抖音链接。',
	unsupported_url: '请使用具体的视频或分享链接。',
	redirect_required: '此分享短链需要在浏览器中打开，请复制打开后的具体视频链接。',
	invalid_options: '本地下载配置无效，请重新选择保存目录或修复本地组件。',
	no_formats: '当前内容没有可用的视频格式，请确认链接或稍后重试。',
	not_video: '当前内容不是受支持的单个视频。',
	unavailable: '该内容不可用或不在当前支持范围内。',
	drm: '该视频受 DRM 保护，当前不支持下载。',
	auth_required:
		'该内容需要访问权限。小红书和抖音请在浏览器中登录后打开视频页重试；YouTube 和 B站当前使用匿名解析。',
	session_required: '平台需要有效会话。请在浏览器中登录后重新打开视频页，然后重试。',
	verification_required:
		'平台要求人工验证。小红书和抖音请在浏览器打开的视频页完成验证后重试；YouTube 和 B站匿名解析暂时不可用。',
	browser_state_missing: '页面尚未加载出目标视频，请等视频可以播放后重试。',
	browser_unavailable: '无法读取浏览器页面，请重新打开视频页后重试。',
	dependency_missing: '缺少本地下载依赖，请按安装指引修复 Node.js、yt-dlp 或 FFmpeg。',
	network_error: '连接失败，请检查网络后重试。',
	timeout: '识别或下载超时，请稍后重试。',
	media_expired: '媒体访问地址已失效，请重新解析并下载。',
	identity_mismatch: '无法确认目标视频，请检查链接后重试。',
	wrong_video: '无法确认目标视频，请检查链接后重试。',
	output_invalid: '下载文件校验失败，未将本次任务标记为已保存。',
	invalid_media_url: '视频媒体地址未通过安全校验，请重新解析。',
	directory_invalid: '保存目录不存在或不可用，请重新选择文件夹。',
	directory_unwritable: '无法写入保存目录，请检查权限或重新选择文件夹。',
	disk_full: '磁盘空间不足，请释放空间或更换保存目录。',
	picker_failed: '无法打开系统文件夹选择器，请重试。',
	file_missing: '本次下载文件已被移动或删除，无法在文件夹中显示。',
	reveal_failed: '无法在 Finder 中显示文件，请检查文件是否仍然存在。',
	task_busy: '已有一个下载任务正在执行，请等待完成或取消。',
	task_not_found: '无法找到这个任务，请重新打开插件。',
	task_already_finished: '这个启动请求已经处理过，请使用重试按钮开始新任务。',
	interrupted: '下载已中断，请重新下载。',
	cancelled: '已取消下载。',
	size_limit: '视频超过当前下载大小上限。',
	engine_error: '本次识别或下载未能完成，请稍后重试或检查本地组件。',
};
export function bridgeError(code) {
	return Object.assign(new Error(messages[code] ?? messages.engine_error), {
		code: messages[code] ? code : 'engine_error',
	});
}
export function publicError(error) {
	const code = ['EACCES', 'EPERM', 'EROFS'].includes(error?.code)
		? 'directory_unwritable'
		: error?.code === 'ENOSPC'
			? 'disk_full'
			: error?.code;
	const safe = bridgeError(code);
	return {code: safe.code, message: safe.message};
}
