import {cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {findExecutable, ytDlpCommand} from '../src/dependencies.mjs';
import {
	advanceArchivePage,
	captureArchivePage,
	discoverArchiveMedia,
	readBilibiliCollectionPage,
} from '../extension/capture-page.mjs';
import {captureSocialCollection} from '../extension/collection-page.mjs';
import {captureSocialPost} from '../extension/social-post.mjs';
import {isCollectionRoute, readPostPage} from '../extension/archive-source.mjs';
import {installBrowserCompat} from '../src/browser-compat.mjs';
import {installMediaSniffer} from '../src/browser-sniffer.mjs';
import {runProcess} from '../src/process.mjs';

if (process.platform !== 'darwin')
	throw new Error('Build the macOS application on macOS with the Xcode command-line tools.');
const root = fileURLToPath(new URL('../', import.meta.url));
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
const dist = path.join(root, 'dist');
await mkdir(dist, {recursive: true});
const staging = await mkdtemp(path.join(dist, '.desktop-build-'));
const bundle = path.join(staging, 'Fetchy.app'),
	contents = path.join(bundle, 'Contents'),
	binary = path.join(contents, 'MacOS/Fetchy');
const resources = path.join(contents, 'Resources'),
	app = path.join(resources, 'app');
async function tool(name, args) {
	const result = await runProcess(name, args, {timeoutMs: 240000});
	if (result.code !== 0) throw new Error(result.stderr || name + ' failed');
}
try {
	await mkdir(path.dirname(binary), {recursive: true});
	await mkdir(app, {recursive: true});
	await tool('/usr/bin/xcrun', [
		'swiftc',
		'-O',
		'-swift-version',
		'5',
		'-target',
		(process.arch === 'arm64' ? 'arm64' : 'x86_64') + '-apple-macosx14.0',
		'-framework',
		'AppKit',
		'-framework',
		'WebKit',
		'-framework',
		'SwiftUI',
		'-o',
		binary,
		...[
			'main.swift',
			'Workspace.swift',
			'Library.swift',
			'Tasks.swift',
			'Session.swift',
			'XiaohongshuLogin.swift',
			'Browser.swift',
			'Accounts.swift',
		].map((name) => path.join(root, 'desktop', name)),
	]);
	for (const directory of ['bin', 'src', 'native'])
		await cp(path.join(root, directory), path.join(app, directory), {recursive: true});
	await mkdir(path.join(app, 'extension'));
	for (const file of ['archive-rpc.mjs', 'manifest.json'])
		await cp(path.join(root, 'extension', file), path.join(app, 'extension', file));
	await mkdir(path.join(app, 'desktop'));
	await cp(path.join(root, 'desktop/bridge.mjs'), path.join(app, 'desktop/bridge.mjs'));
	await writeFile(
		path.join(resources, 'capture-post.js'),
		`if(document.readyState==='loading') return {type:'unsupported',reason:'source_not_ready'};
		if (document.querySelector('input[type=password]')?.getClientRects().length || /\\/(login|signin|sign_in)(\\/|$)/i.test(location.pathname)) return {type:'unsupported',reason:'auth_required'};
		let capture = (${captureArchivePage.toString()})(true);
		const hostname=location.hostname.replace(/^www[.]/,'');
		if (['threads.net','threads.com','instagram.com','kuaishou.com'].includes(hostname)
		  && (capture.type==='unsupported' || capture.entry?.platform==='web')) {
		  capture=(${captureSocialPost.toString()})();
		}
		return JSON.stringify(capture).length<=40*1024*1024?capture:{type:'unsupported',reason:'too_large'};`,
	);
	// The built-in browser's side column runs the extension's page readers in the open page.
	// The body receives `action` and `input` and returns JSON text.
	function findFavoritesUrl() {
		const host = location.hostname.replace(/^www\./, '');
		if (host === 'xiaohongshu.com' || host === 'rednote.com') {
			const unwrap = (v) => (v && v.__v_isRef === true ? v.value : v);
			const app =
				document.querySelector('[data-v-app]')?.__vue_app__ ??
				document.querySelector('#app')?.__vue_app__;
			const liveUser = unwrap(app?.config?.globalProperties?.$pinia?.state?.value?.user);
			const initUser = unwrap(window.__INITIAL_STATE__?.user);
			const liveInfo = unwrap(liveUser?.userInfo);
			const initInfo = unwrap(initUser?.userInfo);
			const guest =
				liveInfo?.guest === true || (liveInfo?.guest === undefined && initInfo?.guest === true);
			let uid = guest
				? ''
				: liveInfo?.userId ||
					initInfo?.userId ||
					unwrap(initUser?.userPageData)?.basicInfo?.userId ||
					'';
			if (!uid) {
				for (const a of document.querySelectorAll('a[href*="/user/profile/"]')) {
					const m = /\/user\/profile\/([a-f0-9]{16,32})/i.exec(a.getAttribute('href') || '');
					if (m) {
						uid = m[1];
						break;
					}
				}
			}
			if (uid) return {url: location.origin + '/user/profile/' + uid + '?tab=fav&subTab=note'};
			return {url: null};
		}
		if (location.hostname === 'space.bilibili.com') {
			const m = /^\/(\d+)(?:\/.*)?$/.exec(location.pathname);
			if (m && !/^\/\d+\/favlist\/?$/.test(location.pathname)) {
				return {url: 'https://space.bilibili.com/' + m[1] + '/favlist'};
			}
			return {url: null};
		}
		if (host === 'instagram.com') {
			const saved = document.querySelector('a[href$="/saved/"]');
			if (saved?.href) return {url: saved.href};
			for (const a of document.querySelectorAll('nav a[href^="/"], a[role="link"][href^="/"]')) {
				const href = a.getAttribute('href') || '';
				if (
					/^\/[a-zA-Z0-9._]{2,40}\/$/.test(href) &&
					!/^\/(explore|reels|direct|accounts|stories)\/$/.test(href) &&
					a.querySelector('img')
				) {
					return {url: location.origin + href + 'saved/'};
				}
			}
			return {url: null};
		}
		if (host === 'tiktok.com') {
			const prof = document.querySelector('a[data-e2e="nav-profile"][href*="/@"], a[href^="/@"]');
			if (prof?.href) return {url: prof.href};
			return {url: null};
		}
		return {url: null};
	}
	const tools = {
		captureArchivePage,
		captureSocialCollection,
		captureSocialPost,
		advanceArchivePage,
		readBilibiliCollectionPage,
		discoverArchiveMedia,
		readPostPage,
		isCollectionRoute,
		findFavoritesUrl,
	};
	await writeFile(
		path.join(resources, 'page-tools.js'),
		`const tools = {${Object.entries(tools)
			.map(([name, fn]) => JSON.stringify(name) + ': ' + fn.toString())
			.join(',\n')}};
		const run = async () => {
			if (action === 'capture') {
				const u = new URL(location.href);
				let snap = tools.isCollectionRoute(u) ? tools.captureSocialCollection() : tools.captureArchivePage(false);
				const social = ['www.kuaishou.com','kuaishou.com','www.threads.com','threads.com','www.threads.net','threads.net','www.instagram.com','instagram.com'];
				if (snap.type === 'unsupported' && snap.reason === 'unsupported_page' && social.includes(u.hostname))
					snap = tools.captureSocialPost();
				if (snap.type === 'folders' && snap.provider === 'bilibili')
					return tools.readBilibiliCollectionPage(null, 1, snap.ownerId);
				if (snap.type === 'collection' && snap.provider === 'bilibili')
					return {...(await tools.readBilibiliCollectionPage(snap.folder.id, 1)), provider: 'bilibili'};
				return snap;
			}
			if (action === 'advance') return tools.advanceArchivePage(input.fromTop === true);
			if (action === 'bilibili') return tools.readBilibiliCollectionPage(input.folderId, input.page);
			if (action === 'media') {
				if (window.__fetchySniffer && typeof window.__fetchySniffer.list === 'function') {
					return {items: window.__fetchySniffer.list()};
				}
				return tools.discoverArchiveMedia();
			}
			if (action === 'findFavorites') return tools.findFavoritesUrl();
			if (action === 'readPost') return tools.readPostPage(input.url, input.maxBytes);
			return {error: 'unknown_action'};
		};
		return JSON.stringify(await run());`,
	);
	await writeFile(
		path.join(resources, 'media-sniffer.js'),
		`(${installMediaSniffer.toString()})();\n`,
	);
	await writeFile(
		path.join(resources, 'browser-compat.js'),
		`(${installBrowserCompat.toString()})();\n`,
	);
	await cp(path.join(root, 'package.json'), path.join(app, 'package.json'));
	const portable = process.argv.includes('--portable');
	const binaries = portable
		? []
		: [
				process.execPath,
				findExecutable(ytDlpCommand()),
				findExecutable('ffmpeg'),
				findExecutable('ffprobe'),
			].filter(Boolean);
	const searchPath = [
		...new Set([
			...binaries.map((file) => path.dirname(file)),
			'/opt/homebrew/bin',
			'/usr/local/bin',
			'/usr/bin',
			'/bin',
		]),
	].join(path.delimiter);
	await writeFile(
		path.join(resources, 'tools.json'),
		JSON.stringify({node: portable ? undefined : process.execPath, path: searchPath}),
	);
	await tool('/usr/bin/sips', [
		'-s',
		'format',
		'icns',
		path.join(root, 'extension/icons/icon128.png'),
		'-o',
		path.join(resources, 'Fetchy.icns'),
	]);
	await writeFile(
		path.join(contents, 'Info.plist'),
		`<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>app.fetchy.desktop</string>
<key>CFBundleName</key><string>Fetchy</string>
<key>CFBundleExecutable</key><string>Fetchy</string>
<key>CFBundleIconFile</key><string>Fetchy.icns</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>`,
	);
	await tool('/usr/bin/codesign', ['--force', '--sign', '-', bundle]);
	const destination = path.join(dist, 'Fetchy.app');
	const previous = path.join(staging, 'previous.app');
	const exists = await stat(destination).then(
		() => true,
		(error) => {
			if (error.code === 'ENOENT') return false;
			throw error;
		},
	);
	if (exists) await rename(destination, previous);
	try {
		await rename(bundle, destination);
	} catch (error) {
		if (exists) await rename(previous, destination);
		throw error;
	}
	console.log(destination);
} finally {
	await rm(staging, {recursive: true, force: true});
}
