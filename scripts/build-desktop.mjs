import {cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {findExecutable, ytDlpCommand} from '../src/dependencies.mjs';
import {captureArchivePage, hydrateArchiveEntry} from '../extension/capture-page.mjs';
import {captureSocialPost} from '../extension/social-post.mjs';
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
		...['main.swift', 'Workspace.swift', 'Session.swift'].map((name) =>
			path.join(root, 'desktop', name),
		),
	]);
	for (const directory of ['bin', 'src', 'native'])
		await cp(path.join(root, directory), path.join(app, directory), {recursive: true});
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
		if(capture.type==='post') capture.entry=await (${hydrateArchiveEntry.toString()})(capture.entry);
		return JSON.stringify(capture).length<=40*1024*1024?capture:{type:'unsupported',reason:'too_large'};`,
	);
	await cp(path.join(root, 'package.json'), path.join(app, 'package.json'));
	const binaries = [
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
		JSON.stringify({node: process.execPath, path: searchPath}),
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
