import {normalizeUrl} from '../src/urls.mjs';

export const activeTask = (task) => ['running', 'cancelling'].includes(task?.status);
const PAGE_PLATFORMS = ['xiaohongshu', 'douyin'];
// Only Xiaohongshu and Douyin need media read from a page; other platforms must
// not pay an extra async hop, which would reorder in-flight resolve requests.
export function pageMediaNeeded(input) {
	try {
		return PAGE_PLATFORMS.includes(normalizeUrl(input).platform);
	} catch {
		return false;
	}
}
export const visibleTask = (task) => activeTask(task) || task?.unread;
export const initialState = () => ({
	connection: {status: 'connecting'},
	context: {mode: 'auto', input: '', status: 'empty', metadata: null, error: null, editing: false},
	task: null,
	settings: {outputDir: ''},
	pendingDirectory: null,
	choosingDirectory: false,
	view: 'main',
	settingsNotice: null,
	notice: null,
	starting: false,
});

const messages = {
	invalid_url: '请输入一个有效的视频链接，或只含一个链接的分享文案。',
	unsupported_platform: '暂不支持此网站。支持 YouTube、B站、小红书和抖音。',
	disconnected: '本地组件连接中断。重连后会查询原任务，请勿重复启动。',
	native_unavailable: '无法连接本地组件，请按安装指引完成安装后重试。',
	timeout: '识别或下载超时，请重试。',
	cancelled: '操作已取消。',
	browser_state_missing: '页面还没有加载出这个视频，请等它可以播放后重试。',
	browser_unavailable: '无法读取视频页面，请重新打开视频页后重试。',
	identity_mismatch: '页面内容与链接不一致，请重新打开目标视频。',
	no_formats: '页面没有提供可下载的视频，请确认这是单个视频内容。',
};
export function displayError(error) {
	const code = typeof error?.code === 'string' ? error.code : 'unknown_error';
	// Only native bridge errors have already been sanitized. Never display runtime/log text.
	return {
		code,
		message:
			messages[code] ||
			(error?.safe && error.message) ||
			'操作未完成，请重试；如仍失败，请检查本地组件。',
	};
}

/** The popup is a replaceable view. All edits, request generations and task IDs live here. */
export class Controller {
	constructor({
		rpc,
		readActiveTab,
		collectPageMedia = async () => undefined,
		saveSession = async () => {},
		emit = () => {},
		openHelp = async () => {},
		uuid = () => crypto.randomUUID(),
		debounceMs = 450,
	}) {
		Object.assign(this, {
			rpc,
			readActiveTab,
			collectPageMedia,
			saveSession,
			emit,
			openHelp,
			uuid,
			debounceMs,
		});
		this.state = initialState();
		this.generation = 0;
		this.resolveId = null;
		this.timer = null;
		this.starting = false;
		this.pendingStart = null;
		this.tabId = null;
		this.autoUrl = null;
		this.detection = 0;
		this.persist = Promise.resolve();
	}
	restore(saved) {
		if (!saved) return;
		if (saved.context) this.state.context = {...this.state.context, ...saved.context};
		this.state.view = saved.view === 'settings' ? 'settings' : 'main';
		this.state.task = saved.task || null;
		this.pendingStart = saved.pendingStart || null;
		if (this.pendingStart) this.pendingStart.ambiguous = true;
		this.autoUrl = saved.autoUrl || null;
		this.tabId = saved.tabId ?? null;
		if (this.state.context.status === 'resolving') this.state.context.status = 'empty';
	}
	publish() {
		this.state.starting = this.starting || Boolean(this.pendingStart);
		const snapshot = structuredClone(this.state);
		this.emit(snapshot);
		const session = {
			context: snapshot.context,
			view: snapshot.view,
			task: snapshot.task,
			pendingStart: this.pendingStart,
			autoUrl: this.autoUrl,
			tabId: this.tabId,
		};
		this.persist = this.persist.catch(() => {}).then(() => this.saveSession(session));
	}
	setConnection(connection) {
		this.state.connection = connection;
		this.publish();
	}
	receiveNative(remote, {authoritative = false} = {}) {
		if (!remote || typeof remote !== 'object') return;
		if ('task' in remote) {
			const previous = this.state.task;
			this.state.task = remote.task;
			// Same-browser session data can restore a target after a daemon restart;
			// it is never recovered from disk or borrowed from another task/page.
			if (remote.task?.id === previous?.id && previous?.input && !remote.task.input) {
				this.state.task = {
					...remote.task,
					input: previous.input,
					metadata: previous.metadata || remote.task.metadata,
				};
			}
		}
		if (remote.settings) this.state.settings = remote.settings;
		if ('pendingDirectory' in remote) this.state.pendingDirectory = remote.pendingDirectory;
		if ('choosingDirectory' in remote) this.state.choosingDirectory = remote.choosingDirectory;
		if (this.pendingStart && remote.task?.id === this.pendingStart.taskId) this.pendingStart = null;
		// If the host restarted without the in-flight reservation, do not silently resubmit it.
		if (
			authoritative &&
			this.pendingStart?.ambiguous &&
			remote.task?.id !== this.pendingStart.taskId
		) {
			const pending = this.pendingStart;
			this.state.task = {
				id: pending.taskId,
				input: pending.input,
				metadata: pending.metadata,
				status: 'interrupted',
				unread: true,
				error: {code: 'interrupted', message: '任务连接已中断，请重新下载。'},
			};
			this.pendingStart = null;
		}
		this.publish();
	}
	invalidate() {
		clearTimeout(this.timer);
		this.timer = null;
		this.generation++;
		if (this.resolveId) this.rpc('cancelResolve', {requestId: this.resolveId}).catch(() => {});
		this.resolveId = null;
	}
	async initialize() {
		if (visibleTask(this.state.task) || this.pendingStart) return this.publish();
		const ctx = this.state.context;
		if (ctx.mode === 'manual') {
			if (ctx.input && ctx.status === 'empty') await this.resolveInput();
			return this.publish();
		}
		await this.detectCurrentPage();
	}
	async detectCurrentPage() {
		if (this.state.context.mode === 'manual' || visibleTask(this.state.task) || this.pendingStart)
			return;
		const generation = this.generation,
			detection = ++this.detection;
		const tab = await this.readActiveTab();
		if (
			detection !== this.detection ||
			generation !== this.generation ||
			this.state.context.mode === 'manual' ||
			visibleTask(this.state.task)
		)
			return;
		const input = tab?.url || '';
		this.tabId = tab?.id ?? null;
		if (
			input === this.autoUrl &&
			['ready', 'resolving', 'error'].includes(this.state.context.status)
		)
			return;
		this.invalidate();
		this.autoUrl = input;
		this.state.context = {
			mode: 'auto',
			input: '',
			status: 'empty',
			metadata: null,
			error: null,
			editing: true,
		};
		try {
			normalizeUrl(input);
		} catch {
			return this.publish();
		}
		this.state.context.input = input;
		this.state.context.editing = false;
		await this.resolveInput();
	}
	async navigation(tabId, url, {loading = false} = {}) {
		if (
			tabId !== this.tabId ||
			(!url && !loading) ||
			(!loading && url === this.autoUrl) ||
			this.state.context.mode === 'manual'
		)
			return;
		// Even while a task runs, invalidate the old auto card; the task keeps its own target.
		this.invalidate();
		this.autoUrl = null;
		this.state.context = {
			mode: 'auto',
			input: '',
			status: 'empty',
			metadata: null,
			error: null,
			editing: true,
		};
		this.publish();
		if (url && !visibleTask(this.state.task)) await this.detectCurrentPage();
	}
	editInput(input) {
		if (activeTask(this.state.task) || this.starting || this.pendingStart) return;
		this.invalidate();
		this.state.context = {
			mode: 'manual',
			input: String(input).slice(0, 16384),
			status: 'empty',
			metadata: null,
			error: null,
			editing: true,
		};
		this.state.notice = null;
		this.publish();
		if (input.trim()) this.timer = setTimeout(() => this.resolveInput(), this.debounceMs);
	}
	async resolveInput() {
		clearTimeout(this.timer);
		if (activeTask(this.state.task) || this.pendingStart) return;
		this.invalidate();
		const generation = this.generation,
			input = this.state.context.input;
		if (!input.trim()) return this.publish();
		try {
			normalizeUrl(input);
		} catch (error) {
			this.state.context.status = 'error';
			this.state.context.error = displayError(error);
			return this.publish();
		}
		const requestId = this.uuid();
		this.resolveId = requestId;
		this.state.context.status = 'resolving';
		this.state.context.metadata = null;
		this.state.context.error = null;
		this.publish();
		try {
			let pageMedia;
			if (pageMediaNeeded(input)) {
				pageMedia = await this.collectPageMedia(input);
				if (generation !== this.generation || input !== this.state.context.input) return;
			}
			const metadata = await this.rpc('resolve', {input, requestId, pageMedia}, 90000);
			if (generation !== this.generation || input !== this.state.context.input) return;
			this.state.context.status = 'ready';
			this.state.context.metadata = metadata;
			this.state.context.editing = false;
		} catch (error) {
			if (generation !== this.generation) return;
			this.state.context.status = 'error';
			this.state.context.error = displayError(error);
		} finally {
			if (generation === this.generation) {
				this.resolveId = null;
				this.publish();
			}
		}
	}
	async dismissTask() {
		if (activeTask(this.state.task) || this.pendingStart) return false;
		if (this.state.task) {
			const id = this.state.task.id;
			try {
				this.receiveNative(await this.rpc('acknowledge', {taskId: id}));
			} catch (error) {
				if (error.code !== 'task_not_found') throw error;
			}
			if (this.state.task?.id === id) this.state.task.unread = false;
		}
		return true;
	}
	async start(input = this.state.context.input, metadata = this.state.context.metadata) {
		if (this.starting || this.pendingStart || activeTask(this.state.task) || !input) return;
		if (
			!metadata ||
			(input === this.state.context.input &&
				this.state.context.status !== 'ready' &&
				!this.state.task)
		)
			return;
		this.starting = true;
		this.invalidate();
		this.state.notice = '正在读取页面视频信息…';
		this.publish();
		let pageMedia;
		try {
			if (pageMediaNeeded(input)) pageMedia = await this.collectPageMedia(input);
		} catch (error) {
			this.starting = false;
			this.state.notice = displayError(error).message;
			return this.publish();
		}
		const taskId = this.uuid();
		this.pendingStart = {taskId, input, metadata};
		this.state.notice = '正在连接下载任务…';
		this.publish();
		let sent = false;
		try {
			await this.persist;
			sent = true;
			this.receiveNative(await this.rpc('start', {taskId, input, metadata, pageMedia}));
			this.pendingStart = null;
		} catch (error) {
			this.state.notice = null;
			// A native event is authoritative even if its RPC receipt was lost later.
			if (this.state.task?.id === taskId && !this.pendingStart) return;
			// Disconnection may happen after delivery. Preserve the ID until a state query reconciles it.
			if (!sent || !['disconnected', 'timeout', 'native_unavailable'].includes(error.code))
				this.pendingStart = null;
			else if (this.pendingStart) this.pendingStart.ambiguous = true;
			this.state.task = {
				id: taskId,
				input,
				metadata,
				status: 'interrupted',
				unread: true,
				error: displayError(error),
			};
		} finally {
			this.starting = false;
			this.state.notice = null;
			this.publish();
			this.persist.catch(() => {});
		}
	}
	async action(action, data = {}) {
		this.state.notice = null;
		try {
			switch (action) {
				case 'initialize':
					return await this.initialize();
				case 'editInput':
					return this.editInput(data.input || '');
				case 'resolveInput':
					return await this.resolveInput();
				case 'start':
					return await this.start();
				case 'retry': {
					const task = this.state.task;
					if (visibleTask(task) && !activeTask(task) && task.input)
						return await this.start(task.input, task.metadata);
					if (visibleTask(task) && !activeTask(task)) {
						if (!(await this.dismissTask())) break;
						this.invalidate();
						this.state.context = {...initialState().context, mode: 'manual', editing: true};
						this.state.notice = '为保护访问凭据，重启后请重新粘贴原视频链接。';
						break;
					}
					return await this.resolveInput();
				}
				case 'cancel':
					if (activeTask(this.state.task))
						this.receiveNative(await this.rpc('cancel', {taskId: this.state.task.id}));
					break;
				case 'changeLink':
					if (!(await this.dismissTask())) break;
					this.invalidate();
					this.state.context = {
						...this.state.context,
						mode: 'manual',
						status: 'empty',
						metadata: null,
						error: null,
						editing: true,
					};
					break;
				case 'useCurrentPage':
					if (!(await this.dismissTask())) break;
					this.invalidate();
					this.autoUrl = null;
					this.state.context = initialState().context;
					await this.detectCurrentPage();
					break;
				case 'openSettings':
					this.state.view = 'settings';
					this.state.settingsNotice = null;
					break;
				case 'back':
					this.state.view = 'main';
					break;
				case 'chooseDirectory':
					this.state.choosingDirectory = true;
					this.state.settingsNotice = null;
					this.publish();
					try {
						this.receiveNative(await this.rpc('chooseDirectory', {}, 10 * 60_000));
					} finally {
						this.state.choosingDirectory = false;
					}
					break;
				case 'saveSettings':
					this.receiveNative(
						await this.rpc('saveSettings', {
							outputDir:
								data.outputDir || this.state.pendingDirectory || this.state.settings.outputDir,
						}),
					);
					this.state.settingsNotice = '已保存';
					break;
				case 'reveal':
					await this.rpc('reveal', {taskId: this.state.task?.id});
					break;
				case 'reconnect': {
					const hello = await this.rpc('hello');
					this.receiveNative(hello.state, {authoritative: true});
					await this.initialize();
					break;
				}
				case 'openHelp':
					await this.openHelp();
					break;
			}
		} catch (error) {
			if (this.state.view === 'settings') this.state.settingsNotice = displayError(error).message;
			else this.state.notice = displayError(error).message;
		}
		this.publish();
	}
}
