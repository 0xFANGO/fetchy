// Renders the popup in three states for the README. Needs `playwright` on
// the import path (npm i -g playwright works); not part of the test suite.
// Usage: node scripts/screenshot-popup.mjs <repo root> <output dir>
import {chromium} from 'playwright';
import {mkdtemp, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

const root = process.argv[2];
const outDir = process.argv[3];
const frames = await mkdtemp(path.join(tmpdir(), 'popup-frames-'));
const thumb = `<svg xmlns="http://www.w3.org/2000/svg" width="376" height="312"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2f6b8f"/><stop offset="1" stop-color="#1b2a3a"/></linearGradient></defs><rect width="376" height="312" fill="url(#g)"/><circle cx="110" cy="120" r="46" fill="#f2b84b" opacity=".9"/><path d="M0 240 Q120 170 220 230 T376 210 V312 H0Z" fill="#1f3f52"/></svg>`;
const base = {
	connection: {status: 'connected'},
	settings: {outputDir: '/Users/me/Downloads/Fetchy'},
};
const metadata = {
	title: '在东京住了十年，我终于学会了怎么拍城市夜景',
	platform: 'bilibili',
	durationSeconds: 754,
	thumbnailUrl: 'https://thumb.example/cover.svg',
};
const states = {
	ready: {
		...base,
		context: {
			mode: 'page',
			input: 'https://www.bilibili.com/video/BV1xx',
			status: 'ready',
			metadata,
		},
	},
	downloading: {
		...base,
		context: {
			mode: 'page',
			input: 'https://www.bilibili.com/video/BV1xx',
			status: 'ready',
			metadata,
		},
		task: {
			id: 't',
			status: 'running',
			stage: 'downloading',
			metadata,
			outputDir: base.settings.outputDir,
			progress: {downloadedBytes: 61_000_000, totalBytes: 98_000_000},
		},
	},
	saved: {
		...base,
		context: {
			mode: 'page',
			input: 'https://www.bilibili.com/video/BV1xx',
			status: 'ready',
			metadata,
		},
		task: {
			id: 't',
			status: 'completed',
			unread: true,
			metadata,
			outputDir: base.settings.outputDir,
			result: {
				platform: 'bilibili',
				filepath:
					'/Users/me/Downloads/Fetchy/video-k3f9a2/在东京住了十年，我终于学会了怎么拍城市夜景.mp4',
				bytes: 98_000_000,
				validation: {video: true, audio: true, durationSeconds: 754},
			},
		},
	},
};

const browser = await chromium.launch();
for (const [name, state] of Object.entries(states)) {
	const page = await browser.newPage({viewport: {width: 360, height: 520}, deviceScaleFactor: 2});
	await page.addInitScript((state) => {
		globalThis.chrome = {
			runtime: {
				lastError: null,
				connect() {
					const listeners = [];
					return {
						onMessage: {addListener: (fn) => listeners.push(fn)},
						onDisconnect: {addListener() {}},
						postMessage(message) {
							if (message.action === 'initialize')
								setTimeout(() => listeners.forEach((fn) => fn({type: 'state', state})), 0);
						},
					};
				},
			},
		};
	}, state);
	await page.route('**/*', async (route) => {
		const url = new URL(route.request().url());
		if (url.hostname === 'thumb.example')
			return route.fulfill({contentType: 'image/svg+xml', body: thumb});
		const file = path.join(root, 'extension', url.pathname.replace(/^\//, ''));
		try {
			const body = await readFile(file);
			const type = file.endsWith('.mjs')
				? 'text/javascript'
				: file.endsWith('.css')
					? 'text/css'
					: 'text/html';
			return route.fulfill({contentType: type, body});
		} catch {
			return route.fulfill({status: 404, body: ''});
		}
	});
	await page.goto('https://popup.local/popup.html');
	await page.waitForTimeout(400);
	await page.setViewportSize({width: 360, height: 430});
	await page.screenshot({path: `${frames}/popup-${name}.png`});
	await page.close();
}
const compose = await browser.newPage({viewport: {width: 1176, height: 478}, deviceScaleFactor: 2});
const imgs = (
	await Promise.all(
		Object.keys(states).map(
			async (name) =>
				`<img src="data:image/png;base64,${(await readFile(`${frames}/popup-${name}.png`)).toString('base64')}" width="360" height="430">`,
		),
	)
).join('');
await compose.setContent(
	`<body style="margin:0;background:#ebe7df;display:flex;gap:24px;padding:24px;align-items:flex-start">${imgs.replaceAll('<img', '<img style="border-radius:12px;box-shadow:0 4px 18px rgba(0,0,0,.12);display:block"')}</body>`,
);
await compose.waitForTimeout(300);
await compose.screenshot({path: `${outDir}/popup-states.png`});
await browser.close();
