// Run explicitly against a freshly installed, isolated Chrome for Testing profile.
// Supply the executable and a Playwright Core ES module through the environment.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createHash, X509Certificate} from 'node:crypto';
import {createServer} from 'node:https';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {getLibraryTask} from '../src/library/index.mjs';

const {
	FETCHY_TEST_ROOT: root,
	FETCHY_TEST_CHROME: executablePath,
	FETCHY_TEST_PLAYWRIGHT: playwright,
} = process.env;
if (
	!root ||
	!executablePath ||
	!playwright ||
	!existsSync(path.join(root, 'chrome-profile', 'NativeMessagingHosts'))
)
	throw Error(
		'Supply an isolated FETCHY_TEST_ROOT with a native host, FETCHY_TEST_CHROME and FETCHY_TEST_PLAYWRIGHT.',
	);
const {chromium} = await import(pathToFileURL(path.resolve(playwright)).href);
const extension = path.join(root, 'dist', 'extension'),
	id = 'hmgmpigkcmalkhcmjfikpkeabbfbhdoh';
const record = [];
const mkMedia = (color, format, args = []) =>
	execFileSync(
		'ffmpeg',
		[
			'-loglevel',
			'error',
			'-f',
			'lavfi',
			'-i',
			'color=c=' + color + ':s=32x32:d=1',
			...args,
			'-f',
			format,
			'pipe:1',
		],
		{timeout: 10000},
	);
const images = ['red', 'green', 'blue'].map((color) =>
	mkMedia(color, 'image2pipe', ['-frames:v', '1', '-c:v', 'png']),
);
const video = mkMedia('yellow', 'mp4', [
	'-c:v',
	'libx264',
	'-pix_fmt',
	'yuv420p',
	'-movflags',
	'frag_keyframe+empty_moov',
]);
const noteId = '0123456789abcdef01234567',
	secondId = '0123456789abcdef01234568';
const xhs = 'https://www.xiaohongshu.com',
	x = 'https://x.com/archivetest/status/',
	article = 'https://example.org/reading/fixture';
const imageUrls = images.map((_, i) => 'https://archive-fixture.xhscdn.com/' + i + '.png');
const note = (id) =>
	'<script>window.__INITIAL_STATE__=' +
	JSON.stringify({
		note: {
			noteDetailMap: {
				[id]: {
					note: {
						noteId: id,
						title: 'Three colors',
						desc: 'A three-image note from the test owner.',
						type: 'normal',
						user: {nickname: 'Fixture author'},
						imageList: imageUrls.map((urlDefault) => ({urlDefault})),
					},
				},
			},
		},
	}) +
	'</script>';
const text = 'A locally authored, text-only post — original punctuation.';
const data = (type, bytes) => 'data:' + type + ';base64,' + bytes.toString('base64');
const img = (n) =>
	'<div data-testid="tweetPhoto"><img src="' + data('image/png', images[n]) + '"></div>';
const tweet = (id, body, media) =>
	'<main data-testid="primaryColumn"><article data-testid="tweet"><div data-testid="User-Name">Fixture author</div><a href="' +
	x +
	id +
	'"><time>Today</time></a><div data-testid="tweetText">' +
	body +
	'</div>' +
	media +
	'</article></main>';
const articleBody =
	'<article><h1>Offline field notes</h1><p>First paragraph marker.</p><h2>Methods</h2>' +
	Array.from(
		{length: 90},
		(_, i) => '<p>Observation ' + i + ' — material from the fixture author.</p>',
	).join('') +
	'<p><a href="https://example.org/reference">Reference point</a></p><p>Final paragraph marker.</p></article>';
const folder = 'https://www.xiaohongshu.com/board/archive-fixture',
	tile = (id) =>
		'<div class="note-item"><a class="cover" href="/board/archive-fixture/' +
		id +
		'"><span class="title">Fixture ' +
		id.slice(-2) +
		'</span></a></div>';
const fixtures = new Map([
	[xhs + '/explore/' + noteId, note(noteId)],
	[x + '100000001', tweet('100000001', text, '')],
	[article, articleBody],
	[
		x + '100000003',
		tweet(
			'100000003',
			'Article summary',
			'<div data-testid="twitterArticleRichTextView">' + articleBody + '</div>',
		),
	],
	[
		x + '100000002',
		tweet(
			'100000002',
			'Images around a playable clip.',
			img(0) + '<video src="' + data('video/mp4', video) + '"></video>' + img(2),
		),
	],
	[
		folder,
		'<div class="board-info"><h1>Two pages</h1><span class="note-count">2 notes</span></div>' +
			tile(noteId) +
			'<a rel="next" href="?page=2">Next</a>',
	],
	[
		folder + '?page=2',
		'<div class="board-info"><h1>Two pages</h1><span class="note-count">2 notes</span></div>' +
			tile(noteId) +
			tile(secondId),
	],
	...[noteId, secondId].map((id) => [folder + '/' + id, note(id)]),
]);
// Chromium creates background tabs before a page interceptor can subscribe. Route
// every fixture hostname to the same ephemeral local HTTPS server, including popups.
const certDir = await mkdtemp(path.join(tmpdir(), 'fetchy-browser-fixture-'));
const certFile = path.join(certDir, 'cert.pem'),
	keyFile = path.join(certDir, 'key.pem');
execFileSync(
	'openssl',
	[
		'req',
		'-x509',
		'-newkey',
		'rsa:2048',
		'-nodes',
		'-days',
		'1',
		'-subj',
		'/CN=Fetchy fixture',
		'-keyout',
		keyFile,
		'-out',
		certFile,
	],
	{stdio: 'ignore', timeout: 10000},
);
const cert = await readFile(certFile),
	privateKey = await readFile(keyFile);
const pin = createHash('sha256')
	.update(new X509Certificate(cert).publicKey.export({format: 'der', type: 'spki'}))
	.digest('base64');
const server = createServer({cert, key: privateKey}, (req, res) => {
	const url = 'https://' + req.headers.host + req.url,
		i = imageUrls.indexOf(url);
	if (i !== -1) {
		res.writeHead(200, {'content-type': 'image/png', 'access-control-allow-origin': '*'});
		res.end(images[i]);
		return;
	}
	if (fixtures.has(url)) {
		res.writeHead(200, {'content-type': 'text/html;charset=utf-8'});
		res.end('<!doctype html><meta charset="UTF-8">' + fixtures.get(url));
		return;
	}
	res.writeHead(404);
	res.end();
});
await new Promise((resolve, reject) => {
	server.once('error', reject);
	server.listen(0, '127.0.0.1', resolve);
});
const resolver = ['www.xiaohongshu.com', 'x.com', 'example.org', 'archive-fixture.xhscdn.com']
	.map((host) => 'MAP ' + host + ' 127.0.0.1:' + server.address().port)
	.concat('MAP * ~NOTFOUND')
	.join(',');
const chromiumContext = await chromium.launchPersistentContext(path.join(root, 'chrome-profile'), {
	executablePath,
	headless: true,
	viewport: {width: 1000, height: 750},
	ignoreDefaultArgs: ['--disable-extensions'],
	args: [
		'--disable-extensions-except=' + extension,
		'--load-extension=' + extension,
		'--disable-background-networking',
		'--disable-sync',
		'--disable-quic',
		'--no-proxy-server',
		'--host-resolver-rules=' + resolver,
		'--ignore-certificate-errors-spki-list=' + pin,
		'--no-first-run',
		'--use-mock-keychain',
		'--enable-unsafe-extension-debugging',
	],
});
const sessionTab = await chromiumContext.newPage();
await sessionTab.goto('about:blank');
async function toolPage(src) {
	const before = await chromiumContext.newPage();
	await before.goto(src);
	await before.bringToFront();
	const session = await chromiumContext.newCDPSession(before),
		browserSession = await chromiumContext.browser().newBrowserCDPSession();
	try {
		const tabs = (await browserSession.send('Target.getTargets', {filter: [{type: 'tab'}]}))
			.targetInfos;
		const target = tabs.find((t) => t.url === src);
		assert.ok(target, 'source tab');
		await browserSession.send('Extensions.triggerAction', {id, targetId: target.targetId});
		let popup;
		for (let i = 0; i < 70 && !popup; i++) {
			popup = (await session.send('Target.getTargets')).targetInfos.find(
				(t) => t.url === 'chrome-extension://' + id + '/popup.html',
			);
			if (!popup) await delay(100);
		}
		assert.ok(popup, 'toolbar popup');
		const {sessionId} = await session.send('Target.attachToTarget', {
			targetId: popup.targetId,
			flatten: false,
		});
		const next = chromiumContext.waitForEvent('page', {timeout: 12000});
		await session.send('Target.sendMessageToTarget', {
			sessionId,
			message: JSON.stringify({
				id: 1,
				method: 'Runtime.evaluate',
				params: {
					expression:
						"(async()=>{for(let i=0;i<100;i++){if(document.querySelector('#supported-platforms span')){document.querySelector('#archive-button').click();return;}await new Promise(r=>setTimeout(r,50));}})()",
					awaitPromise: true,
				},
			}),
		});
		const page = await next;
		await page.waitForURL('chrome-extension://' + id + '/archive.html?tab=*');
		return {page, before};
	} finally {
		await session.detach();
		await browserSession.detach();
	}
}
async function archive(src, batch = false) {
	const {page, before} = await toolPage(src);
	try {
		if (batch) {
			await page.getByRole('button', {name: '读取全部页面', exact: true}).click();
			await page.getByText('已读 2 / 2 项 · 已到末页').waitFor({timeout: 15000});
			await page.locator('#capture-items .check input').first().uncheck();
		}
		await page.locator('#save:enabled').click({timeout: 10000});
		await page.waitForFunction(
			() =>
				['completed', 'partial', 'failed'].includes(
					document.querySelector('#task-detail .panel')?.dataset.status,
				),
			null,
			{timeout: 60000},
		);
		const taskId = await page.locator('#task-detail .panel').getAttribute('data-task-id'),
			task = await getLibraryTask(taskId, {root: path.join(root, 'native-state', 'library')});
		console.log(
			'Archived fixture',
			taskId,
			task.status,
			task.items.map((i) => i.key),
		);
		assert.equal(task.status, 'completed');
		if (!record.length) await page.screenshot({path: path.join(root, 'archive-task.png')});
		await page.locator('[data-view=library]').click();
		await page.locator('#results .row').first().waitFor();
		record.push({src, id: task.id, item: task.items[0]});
		await writeFile(
			path.join(root, 'archive-fixture-results.json'),
			JSON.stringify(record, null, 2),
		);
	} catch (e) {
		console.error(await page.locator('main').innerText());
		throw e;
	} finally {
		await page.close();
		await before.close();
	}
}
try {
	for (const src of [
		xhs + '/explore/' + noteId,
		x + '100000001',
		article,
		x + '100000002',
		x + '100000003',
	])
		await archive(src);
	await archive(folder, true);
	await chromiumContext.setOffline(true);
	for (const [i, r] of record.entries()) {
		const page = await chromiumContext.newPage();
		await page.goto(pathToFileURL(r.item.filepath).href);
		const body = await page.locator('article').innerText(),
			imagesOnPage = page.locator('article img');
		if (i === 0 || i === 5) {
			assert.equal(await imagesOnPage.count(), 3);
			assert.equal(
				new Set(await imagesOnPage.evaluateAll((nodes) => nodes.map((n) => n.src))).size,
				3,
			);
			assert.deepEqual(
				await imagesOnPage.evaluateAll((nodes) => nodes.map((n) => n.complete && n.naturalWidth)),
				[32, 32, 32],
			);
		}
		if (i === 1) {
			assert.ok(body.includes(text));
			assert.equal(await imagesOnPage.count(), 0);
		}
		if (i === 2 || i === 4) {
			for (const s of ['First paragraph marker.', 'Observation 45', 'Final paragraph marker.'])
				assert.ok(body.includes(s));
			assert.equal(await page.getByRole('heading', {name: 'Methods'}).count(), 1);
			assert.equal(
				await page.getByRole('link', {name: 'Reference point'}).getAttribute('href'),
				'https://example.org/reference',
			);
		}
		if (i === 3) {
			assert.deepEqual(
				await page
					.locator('article img,article video')
					.evaluateAll((ns) => ns.map((n) => n.tagName)),
				['IMG', 'VIDEO', 'IMG'],
			);
			await page.locator('video').evaluate(async (v) => {
				v.muted = true;
				await v.play();
			});
			await page.waitForFunction(() => document.querySelector('video').currentTime > 0.2);
		}
		await page.close();
	}
	console.log('Offline content, media order, playback and cross-page selection verified.');
} catch (error) {
	console.error(error);
	process.exitCode = 1;
} finally {
	const closed = await Promise.race([
		chromiumContext.close().then(() => true),
		delay(4000).then(() => false),
	]);
	if (!closed)
		console.error('Chrome closed its windows while native messaging was still attached.');
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
	await rm(certDir, {recursive: true, force: true});
	if (!closed) process.exit(process.exitCode || 0);
}
