import {usesPageMedia} from '../src/sites/index.mjs';
import {Controller, activeTask} from './controller.mjs';
import {normalizeUrl} from '../src/urls.mjs';

const HOST = 'com.fetchy.video_downloader';
const panels = new Set(),
	requests = new Map();
let nativePort,
	archiveAvailable = false,
	connectionPromise,
	reconnectTimer,
	reconnectAttempt = 0;
const controller = new Controller({
	rpc,
	collectPageMedia,
	readActiveTab: async () => (await chrome.tabs.query({active: true, lastFocusedWindow: true}))[0],
	saveSession: (session) => chrome.storage.session.set({session}),
	emit: (state) => {
		for (const port of panels) {
			try {
				port.postMessage({type: 'state', state});
			} catch {
				panels.delete(port);
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
	// The help page is the only tab Fetchy opens, and only when the user asks.
	openHelp: () => chrome.tabs.create({url: chrome.runtime.getURL('help.html')}),
});

// The toolbar button opens Fetchy beside the current page instead of a popup.
chrome.sidePanel?.setPanelBehavior({openPanelOnActionClick: true}).catch(() => {});

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
		archiveAvailable = hello.capabilities?.archive === true;
		controller.receiveNative(hello.state, {authoritative: true});
		controller.setConnection({status: 'connected', dependencies: hello.dependencies});
		reconnectAttempt = 0;
		if (hello.capabilities?.dependencies)
			send('dependencies', {}, 20000)
				.then((dependencies) => {
					if (nativePort === port) controller.setConnection({status: 'connected', dependencies});
				})
				.catch(() => {});
	})();
	try {
		await connectionPromise;
	} finally {
		connectionPromise = null;
	}
}
async function rpc(method, params, timeoutMs) {
	await connect();
	if (!archiveAvailable && (method.startsWith('library') || method === 'webSave'))
		throw {code: 'archive_update_required'};
	return send(method, params, timeoutMs);
}

// Xiaohongshu and Douyin media is read from the page the user has open, in
// their own browser session. Fetchy never opens a tab for this: without an
// open page for the exact video it asks the user to open one. Only the
// extractor's narrow result crosses into the native host.
const PAGE_HOSTS = ['https://*.xiaohongshu.com/*', 'https://*.douyin.com/*'];
const RETRYABLE = ['browser_state_missing', 'browser_unavailable'];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function checkCancelled(signal) {
	if (signal?.aborted) throw {code: 'cancelled'};
}
function targetOf(url) {
	try {
		const target = normalizeUrl(url);
		return target.needsRedirect ? null : target;
	} catch {
		return null;
	}
}
const sameTarget = (a, b) => Boolean(a && b && a.platform === b.platform && a.id === b.id);

async function extractOnce(tabId, target) {
	const args = {platform: target.platform, expectedId: target.id};
	await chrome.scripting.executeScript({
		target: {tabId},
		world: 'MAIN',
		func: (value) => {
			globalThis.__fetchyPageExtractArgs = value;
		},
		args: [args],
	});
	const [injection] = await chrome.scripting.executeScript({
		target: {tabId},
		world: 'MAIN',
		files: ['shared/page-extract.inject.js'],
	});
	return injection?.result ?? {ok: false, code: 'browser_state_missing'};
}
async function extractFromTab(tabId, target, attempts, signal) {
	let last = {ok: false, code: 'browser_state_missing'};
	for (let attempt = 0; attempt < attempts; attempt++) {
		checkCancelled(signal);
		try {
			last = await extractOnce(tabId, target);
		} catch {
			last = {ok: false, code: 'browser_unavailable'};
		}
		checkCancelled(signal);
		if (last.ok) return {media: last.media, userAgent: last.userAgent, resolvedUrl: target.url};
		if (!RETRYABLE.includes(last.code)) break;
		await delay(500);
	}
	throw {code: typeof last.code === 'string' ? last.code : 'browser_state_missing'};
}
async function collectPageMedia(input, {fresh = false, signal} = {}) {
	checkCancelled(signal);
	let expected;
	try {
		expected = normalizeUrl(input);
	} catch {
		return undefined;
	}
	if (!usesPageMedia(expected.platform)) return undefined;
	if (expected.needsRedirect) throw {code: 'open_page_required'};
	const tabs = await chrome.tabs.query({url: PAGE_HOSTS}).catch(() => []);
	let last = {code: 'open_page_required'};
	for (const tab of tabs) {
		if (!sameTarget(targetOf(tab.url), expected)) continue;
		try {
			// A refresh waits longer: the page may still be loading a new address.
			return await extractFromTab(tab.id, expected, fresh ? 20 : 6, signal);
		} catch (error) {
			if (!RETRYABLE.includes(error.code)) throw error;
			last = error;
		}
	}
	throw last;
}

// After "保存所选" the native worker owns the task. This worker only reads each
// selected post page from the user's tab with a same-site request and hands it
// over; it keeps going when the side panel closes. If the tab goes away, the
// rest is left to the native worker, which reads with the desktop sign-in.
const feeding = new Map();
async function feedTask({taskId, tabId, origin, items}) {
	if (typeof taskId !== 'string' || !Number.isInteger(tabId) || !Array.isArray(items)) return;
	if (feeding.has(taskId)) return;
	feeding.set(taskId, true);
	const {readPostPageInTab, mayVisit} = await import('./archive-source.mjs');
	const skip = (key) => rpc('libraryPage', {id: taskId, key, skip: true}).catch(() => {});
	try {
		for (const {key, url, platform} of items) {
			let tab;
			try {
				tab = await chrome.tabs.get(tabId);
			} catch {
				tab = null;
			}
			const sameSite = tab?.url && new URL(tab.url).origin === origin;
			if (!sameSite || !mayVisit(url, platform, origin)) {
				await skip(key);
				continue;
			}
			let page;
			try {
				page = await readPostPageInTab(tabId, url);
			} catch {
				page = {error: 'page_access'};
			}
			if (page.error) {
				await skip(key);
				continue;
			}
			for (let attempt = 0; attempt < 30; attempt++) {
				try {
					await rpc('libraryPage', {id: taskId, key, ...page});
					break;
				} catch (error) {
					if (error.code !== 'busy') break;
					await delay(2000);
				}
			}
		}
	} finally {
		feeding.delete(taskId);
		await rpc('libraryFeed', {id: taskId, active: false}).catch(() => {});
	}
}

chrome.runtime.onConnect.addListener((port) => {
	if (port.name === 'library') {
		if (port.sender?.url?.split('?')[0] !== chrome.runtime.getURL('panel.html')) return;
		const methods = new Set([
			'libraryTasks',
			'libraryTask',
			'librarySearch',
			'libraryStart',
			'libraryRetry',
			'libraryResume',
			'libraryOpen',
			'webSave',
			'libraryUploadStart',
			'libraryUploadPart',
			'libraryUploadFinish',
		]);
		port.onMessage.addListener(async (message) => {
			if (message?.method === 'feed') {
				feedTask(message.params).catch(() => {});
				return;
			}
			if (typeof message?.id !== 'string' || !methods.has(message.method)) return;
			let response;
			try {
				const long = ['libraryStart', 'libraryUploadFinish', 'webSave'].includes(message.method);
				response = {
					id: message.id,
					ok: true,
					result: await rpc(message.method, message.params || {}, long ? 660000 : 30000),
				};
			} catch (e) {
				response = {
					id: message.id,
					ok: false,
					code: typeof e.code === 'string' ? e.code : 'unavailable',
				};
			}
			try {
				port.postMessage(response);
			} catch {
				/* The native worker owns accepted tasks. */
			}
		});
		return;
	}
	if (port.name !== 'panel') return;
	panels.add(port);
	port.onDisconnect.addListener(() => panels.delete(port));
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
	else if (change.status === 'complete' && panels.size && tabId === controller.tabId)
		loaded.then(() => controller.detectCurrentPage());
});
chrome.tabs.onActivated.addListener(() => {
	loaded.then(() => {
		if (panels.size) controller.detectCurrentPage();
	});
});
chrome.runtime.onStartup.addListener(() => {
	loaded.then(() => connect()).catch(() => {});
});
