const PLATFORMS = Object.freeze({
	youtube: 'YouTube',
	bilibili: 'B站',
	xiaohongshu: '小红书',
	douyin: '抖音',
});
const STAGES = Object.freeze({
	resolving: '正在解析视频…',
	downloading: '正在下载…',
	postprocessing: '正在处理音视频…',
	validating: '正在校验文件…',
	retrying: '正在重试…',
});

export function formatDuration(value) {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '';
	const seconds = Math.max(1, Math.floor(value));
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor(seconds / 60) % 60;
	const rest = String(seconds % 60).padStart(2, '0');
	return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

export function safeThumbnail(value) {
	try {
		const url = new URL(value);
		return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
	} catch {
		return null;
	}
}

export function errorMessage(error, fallback = '暂时无法完成，请稍后重试。') {
	const messages = {
		invalid_url: '请输入一个有效的视频链接；分享文案中请只保留一个链接。',
		unsupported_platform: '暂不支持此网站，请使用 YouTube、B站、小红书或抖音链接。',
		identity_mismatch: '无法确认目标视频，请重新打开视频后重试。',
		output_invalid: '下载文件校验失败，请重新下载。',
		no_formats: '没有找到可下载的视频，请确认这是单个视频内容。',
		unsupported_content: '当前内容暂不支持，请使用单个已发布的视频链接。',
		browser_state_missing: '页面还没有加载出这个视频，请等它可以播放后重试。',
		browser_unavailable: '无法读取视频页面，请重新打开视频页后重试。',
		authentication_required: '请在浏览器中登录后重新打开视频页，然后重试。',
		login_required: '请在浏览器中登录后重新打开视频页，然后重试。',
		network_error: '网络连接失败，请检查网络后重试。',
		timeout: '识别或下载超时，请稍后重试。',
		interrupted: '上次下载已中断，可以重新下载。',
		cancelled: '已取消下载。',
	};
	if (messages[error?.code]) return messages[error.code];
	const message = typeof error === 'string' ? error : error?.message;
	if (!message) return fallback;
	// Native errors are already mapped. Keep this last UI boundary safe if another
	// transport accidentally supplies a raw diagnostic instead.
	return String(message)
		.replace(/https?:\/\/[^\s<>]+/gi, '（链接已隐藏）')
		.replace(
			/\b(cookie|authorization|xsec_token|access_token|token|signature)\s*[:=]\s*[^\s,;]+/gi,
			'$1=（已隐藏）',
		)
		.slice(0, 280);
}

export function isValidatedResult(result) {
	return Boolean(
		result &&
		typeof result.filepath === 'string' &&
		result.filepath &&
		Number.isFinite(result.bytes) &&
		result.bytes > 0 &&
		result.validation?.video === true &&
		Number.isFinite(result.validation.durationSeconds) &&
		result.validation.durationSeconds > 0,
	);
}

export function taskIsVisible(task) {
	return Boolean(
		task && (['running', 'cancelling'].includes(task.status) || task.unread !== false),
	);
}

/** Keep a late state from another process from replacing the user's newer edit. */
export function withPendingDraft(state, draft) {
	if (
		typeof draft !== 'string' ||
		taskIsVisible(state.task) ||
		(state.context?.mode === 'manual' && state.context?.input === draft)
	)
		return state;
	return {
		...state,
		context: {
			...state.context,
			mode: 'manual',
			input: draft,
			status: 'empty',
			metadata: null,
			error: null,
			editing: true,
		},
	};
}

export function deriveView(state = {}) {
	const connection = state.connection ?? {status: 'connecting'};
	const connected = connection.status === 'connected';
	const context = state.context ?? {mode: 'auto', input: '', status: 'empty'};
	const task = taskIsVisible(state.task) ? state.task : null;
	const active = Boolean(task && ['running', 'cancelling'].includes(task.status));
	// A restored task may have no cover/title yet. Never borrow the metadata of
	// a different page simply to fill that empty card.
	const metadata = task
		? (task.metadata ?? null)
		: context.status === 'ready'
			? context.metadata
			: null;
	const title =
		typeof metadata?.title === 'string' && metadata.title.trim() ? metadata.title : '未命名视频';
	const platform = PLATFORMS[metadata?.platform] ?? PLATFORMS[task?.result?.platform] ?? '视频';
	const duration = formatDuration(metadata?.durationSeconds);
	const view = {
		isSettings: state.view === 'settings',
		connected,
		active,
		task,
		input: typeof context.input === 'string' ? context.input : '',
		showInput: !task && (context.editing || context.status !== 'ready'),
		showCard: Boolean(metadata || task),
		title,
		thumbnail: safeThumbnail(metadata?.thumbnailUrl),
		subtitle: [platform, duration].filter(Boolean).join(' · '),
		status: '',
		tone: 'neutral',
		busy: false,
		primary: null,
		secondary: [],
		outputDir: task?.outputDir || state.settings?.outputDir || '',
		actualPath: '',
		progress: null,
		connectionNotice: '',
		showConnectionHelp: false,
		directory: state.pendingDirectory || state.settings?.outputDir || '',
		directoryPending: Boolean(
			state.pendingDirectory && state.pendingDirectory !== state.settings?.outputDir,
		),
		choosingDirectory: Boolean(state.choosingDirectory),
		settingsNotice: state.settingsNotice ? errorMessage(state.settingsNotice, '') : '',
		notice: state.notice ? errorMessage(state.notice, '') : '',
		emptyTitle: context.mode === 'manual' ? '粘贴链接，识别你的视频' : '当前页面未识别到支持的视频',
		showEmpty: !task && context.status === 'empty',
	};
	if (!connected) {
		view.connectionNotice =
			connection.status === 'connecting'
				? active
					? '正在恢复连接，确认下载状态…'
					: '正在连接本地组件…'
				: errorMessage(connection.error, '无法连接本地组件，请完成安装后重试。');
		view.showConnectionHelp = connection.status !== 'connecting';
	} else {
		const labels = {
			node: 'Node.js',
			ytDlp: 'yt-dlp',
			ffmpeg: 'FFmpeg',
			ffprobe: 'ffprobe',
		};
		const missing = Object.entries(connection.dependencies ?? {})
			.filter(([name, value]) => labels[name] && value?.available === false)
			.map(([name]) => labels[name]);
		if (missing.length) {
			view.connectionNotice = `缺少 ${missing.join('、')}，请按安装指引修复。`;
			view.showConnectionHelp = true;
		}
	}
	if (task) {
		if (task.status === 'running' || task.status === 'cancelling') {
			view.status = task.status === 'cancelling' ? '正在取消…' : STAGES[task.stage] || '正在下载…';
			view.busy = true;
			if (task.status === 'running')
				view.secondary.push({action: 'cancel', label: '取消下载', disabled: !connected});
			const {downloadedBytes, totalBytes} = task.progress ?? {};
			if (
				connected &&
				task.status === 'running' &&
				task.stage === 'downloading' &&
				Number.isFinite(downloadedBytes) &&
				downloadedBytes >= 0 &&
				Number.isFinite(totalBytes) &&
				totalBytes > 0 &&
				downloadedBytes <= totalBytes
			) {
				view.progress = Math.floor((downloadedBytes / totalBytes) * 100);
			}
		} else if (task.status === 'completed' && isValidatedResult(task.result)) {
			view.status = '已保存';
			view.tone = 'success';
			view.actualPath = task.result.filepath;
			view.primary = {
				action: 'reveal',
				label: '在文件夹中显示',
				icon: 'folder',
				disabled: !connected,
			};
		} else if (task.status === 'cancelled') {
			view.status = '已取消下载';
			view.primary = {action: 'retry', label: '重新下载', icon: 'download', disabled: !connected};
		} else {
			view.status =
				task.status === 'completed'
					? '文件校验结果不完整，请重试下载。'
					: errorMessage(
							task.error,
							task.status === 'interrupted'
								? '上次下载已中断，可以重新下载。'
								: '下载失败，请重试。',
						);
			view.tone = 'error';
			view.primary = {action: 'retry', label: '重试下载', icon: 'retry', disabled: !connected};
		}
		if (!active)
			view.secondary.push(
				{action: 'changeLink', label: '更换链接'},
				{action: 'useCurrentPage', label: '返回当前页面'},
			);
	} else if (context.status === 'resolving') {
		view.status = '正在识别视频…';
		view.busy = true;
		view.showEmpty = false;
	} else if (context.status === 'ready') {
		view.primary = {action: 'start', label: '下载视频', icon: 'download', disabled: !connected};
		view.secondary.push({action: 'changeLink', label: '更换链接'});
	} else if (context.status === 'error') {
		view.status = errorMessage(context.error, '无法识别视频，请修改链接或重试。');
		view.tone = 'error';
		view.primary = {
			action: 'resolveInput',
			label: '重新识别',
			icon: 'retry',
			disabled: !connected || !view.input.trim(),
		};
		view.showEmpty = false;
	}
	if (!task && context.mode === 'manual')
		view.secondary.push({action: 'useCurrentPage', label: '识别当前页面'});
	if (active && !connected) {
		view.status =
			task.status === 'cancelling' ? '连接恢复后确认取消结果' : '连接恢复后确认下载状态';
		view.busy = false;
		view.progress = null;
	}
	if (connection.status === 'disconnected') {
		view.primary = {action: 'reconnect', label: '重新连接', icon: 'retry'};
	}
	if (state.starting) {
		if (view.primary && ['start', 'retry'].includes(view.primary.action))
			view.primary = {...view.primary, label: '正在连接下载任务…', disabled: true};
		view.secondary = view.secondary.map((action) => ({...action, disabled: true}));
	}
	return view;
}
