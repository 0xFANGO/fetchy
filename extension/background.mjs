import {Controller, activeTask} from './controller.mjs';

const HOST = 'com.fango.video_downloader';
const popups = new Set(),
	requests = new Map();
let nativePort,
	connectionPromise,
	reconnectTimer,
	reconnectAttempt = 0;
const controller = new Controller({
	rpc,
	readActiveTab: async () => (await chrome.tabs.query({active: true, lastFocusedWindow: true}))[0],
	saveSession: (session) => chrome.storage.session.set({session}),
	emit: (state) => {
		for (const port of popups) {
			try {
				port.postMessage({type: 'state', state});
			} catch {
				popups.delete(port);
			}
		}
		chrome.action
			.setBadgeText({
				text: activeTask(state.task)
					? '↓'
					: state.task?.unread
						? state.task.status === 'completed'
							? '✓'
							: '!'
						: '',
			})
			.catch(() => {});
		chrome.action.setBadgeBackgroundColor({color: '#c9573b'}).catch(() => {});
	},
	openHelp: () => chrome.tabs.create({url: chrome.runtime.getURL('help.html')}),
});

const loaded = chrome.storage.session
	.get('session')
	.then(({session}) => controller.restore(session));

function send(method, params = {}, timeoutMs = 20000) {
	return new Promise((resolve, reject) => {
		const id = crypto.randomUUID();
		const timer = setTimeout(() => {
			requests.delete(id);
			reject({code: 'timeout'});
		}, timeoutMs);
		requests.set(id, {resolve, reject, timer});
		try {
			nativePort.postMessage({id, method, params});
		} catch {
			clearTimeout(timer);
			requests.delete(id);
			reject({code: 'disconnected'});
		}
	});
}
async function connect() {
	await loaded;
	if (connectionPromise) return connectionPromise;
	if (nativePort && controller.state.connection.status === 'connected') return;
	connectionPromise = (async () => {
		clearTimeout(reconnectTimer);
		controller.setConnection({status: 'connecting'});
		const port = chrome.runtime.connectNative(HOST);
		nativePort = port;
		port.onMessage.addListener((message) => {
			if (nativePort !== port) return;
			if (message.event === 'state') {
				controller.receiveNative(message.state);
				return;
			}
			const pending = requests.get(message.id);
			if (!pending) return;
			clearTimeout(pending.timer);
			requests.delete(message.id);
			if (message.ok) pending.resolve(message.result);
			else pending.reject({...message.error, safe: true});
		});
		port.onDisconnect.addListener(() => {
			const unavailable = /not found|forbidden|not registered/i.test(
				chrome.runtime.lastError?.message || '',
			);
			if (nativePort !== port) return;
			nativePort = null;
			for (const pending of requests.values()) {
				clearTimeout(pending.timer);
				pending.reject({code: unavailable ? 'native_unavailable' : 'disconnected'});
			}
			requests.clear();
			controller.setConnection({
				status: 'disconnected',
				error: {
					code: unavailable ? 'native_unavailable' : 'disconnected',
					message: unavailable
						? '尚未安装本地组件，或浏览器注册未完成。'
						: '本地组件连接中断，正在尝试恢复原任务。',
				},
			});
			if (!unavailable && reconnectAttempt < 5) {
				const delay = Math.min(1000 * 2 ** reconnectAttempt++, 15000);
				reconnectTimer = setTimeout(() => connect().catch(() => {}), delay);
			}
		});
		let hello;
		try {
			hello = await send('hello', {}, 12000);
		} catch (error) {
			if (nativePort === port) {
				nativePort = null;
				try {
					port.disconnect();
				} catch {}
				controller.setConnection({
					status: 'disconnected',
					error: {
						code: error.code || 'disconnected',
						message: '本地组件未响应，请重试连接或按安装指引修复。',
					},
				});
			}
			throw error;
		}
		controller.receiveNative(hello.state, {authoritative: true});
		controller.setConnection({status: 'connected', dependencies: hello.dependencies});
		reconnectAttempt = 0;
	})();
	try {
		await connectionPromise;
	} finally {
		connectionPromise = null;
	}
}
async function rpc(method, params, timeoutMs) {
	await connect();
	return send(method, params, timeoutMs);
}

chrome.runtime.onConnect.addListener((port) => {
	if (port.name !== 'popup') return;
	popups.add(port);
	port.onDisconnect.addListener(() => popups.delete(port));
	port.onMessage.addListener(async (message) => {
		await loaded;
		if (message.type !== 'action') return;
		if (message.action === 'initialize') {
			try {
				await connect();
			} catch {
				/* connection state provides installation guidance */
			}
		}
		await controller.action(message.action, message);
	});
	loaded.then(() => port.postMessage({type: 'state', state: controller.state})).catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
	if (change.url || change.status === 'loading')
		loaded.then(() =>
			controller.navigation(tabId, change.url, {loading: change.status === 'loading'}),
		);
	else if (change.status === 'complete' && popups.size && tabId === controller.tabId)
		loaded.then(() => controller.detectCurrentPage());
});
chrome.tabs.onActivated.addListener(() => {
	loaded.then(() => {
		if (popups.size) controller.detectCurrentPage();
	});
});
chrome.runtime.onStartup.addListener(() => {
	loaded.then(() => connect()).catch(() => {});
});
