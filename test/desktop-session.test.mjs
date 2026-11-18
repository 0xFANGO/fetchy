import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, readFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {
	browse,
	browserSessionScope,
	captureWithSession,
	downloadWithSession,
	hasSession,
	logout,
} from '../bin/desktop.mjs';
import {runProcess} from '../src/process.mjs';

test('the browser rejects credentials, local files and cleartext remote origins', async () => {
	for (const input of [
		'file:///tmp/example',
		'https://name:secret@example.com',
		'http://example.com',
		'not a URL',
	]) {
		await assert.rejects(() => browse(input), {code: 'invalid_url'});
		assert.equal(await hasSession(input), false);
	}
});

test('dedicated profiles and capture hosts respect independently operated sites', () => {
	const plan = (host) => browserSessionScope(new URL('https://' + host + '/'));
	for (const [a, b] of [
		['framatube.org', 'video.blender.org'],
		['artist-a.bandcamp.com', 'artist-b.bandcamp.com'],
		['alice.tumblr.com', 'bob.tumblr.com'],
		['alice.tumblr.com', 'www.tumblr.com'],
	]) {
		assert.notEqual(plan(a).scope, plan(b).scope);
		assert.deepEqual(plan(a).hosts, [a]);
	}
	for (const [a, b] of [
		['www.x.com', 'twitter.com'],
		['b23.tv', 'www.bilibili.com'],
		['xhslink.com', 'www.xiaohongshu.com'],
		['tumblr.com', 'www.tumblr.com'],
	]) {
		assert.equal(plan(a).scope, plan(b).scope);
		assert.ok(plan(a).hosts.includes(b));
	}
});

// Explicit opt-in: this opens and closes a real macOS window in an isolated Fetchy site store.
test(
	'WebKit retains only its dedicated origin session after the browser quits',
	{
		skip: process.platform !== 'darwin' || process.env.FETCHY_TEST_WEBKIT !== '1',
		timeout: 150000,
	},
	async (t) => {
		const dir = await mkdtemp(path.join(tmpdir(), 'fetchy-webkit-'));
		const previous = process.env.FETCHY_DATA_DIR;
		process.env.FETCHY_DATA_DIR = path.join(dir, 'state');
		const media = path.join(dir, 'clip.mp4');
		const generate = await runProcess('ffmpeg', [
			'-y',
			'-hide_banner',
			'-loglevel',
			'error',
			'-f',
			'lavfi',
			'-i',
			'testsrc2=s=160x90:r=12',
			'-f',
			'lavfi',
			'-i',
			'sine=frequency=440',
			'-t',
			'1',
			'-c:v',
			'libx264',
			'-pix_fmt',
			'yuv420p',
			'-c:a',
			'aac',
			media,
		]);
		assert.equal(generate.code, 0);
		const bytes = await readFile(media);
		let session,
			confirmed = 0,
			authorizedDownloads = 0;
		const server = createServer((req, res) => {
			if (req.url === '/entry') {
				session = randomBytes(16).toString('hex');
				res
					.writeHead(302, {
						'Set-Cookie':
							'fetchy_test=' + session + '; Max-Age=300; HttpOnly; SameSite=Lax; Path=/',
						Location: '/ready',
					})
					.end();
				return;
			}
			if (!session || req.headers.cookie !== 'fetchy_test=' + session) {
				res.writeHead(401).end();
				return;
			}
			if (req.url === '/ready') {
				confirmed++;
				res.writeHead(200, {'Content-Type': 'text/html'}).end('<title>Signed in</title>');
				return;
			}
			if (req.url === '/article' || req.url === '/summary') {
				const more = req.url === '/summary' ? '<button>Read more</button>' : '';
				res
					.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'})
					.end(
						'<article><h1>Owned fixture report</h1><p>First line.</p><h2>Middle</h2><p>Last line.</p><img alt="Original" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">' +
							more +
							'</article>',
					);
				return;
			}
			if (req.url === '/watch') {
				res
					.writeHead(200, {'Content-Type': 'text/html'})
					.end('<title>Session clip</title><video src="/movie.mp4"></video>');
				return;
			}
			if (req.url === '/dynamic') {
				res
					.writeHead(200, {'Content-Type': 'text/html'})
					.end(
						'<title>Dynamic clip</title><video></video><script>fetch("/movie.mp4").then(r=>r.blob()).then(b=>document.querySelector("video").src=URL.createObjectURL(b))</script>',
					);
				return;
			}
			if (req.url === '/movie.mp4') {
				authorizedDownloads++;
				res
					.writeHead(200, {'Content-Type': 'video/mp4', 'Content-Length': bytes.length})
					.end(bytes);
				return;
			}
			res.writeHead(404).end();
		});
		await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
		const site = 'http://127.0.0.1:' + server.address().port;
		const windows = new Set();
		const cli = fileURLToPath(new URL('../bin/fetchy.mjs', import.meta.url));
		const command = (...args) => runProcess(process.execPath, [cli, ...args], {timeoutMs: 60000});
		async function enter() {
			const before = confirmed;
			const launched = await command('browse', site + '/entry');
			assert.equal(launched.code, 0, launched.stderr);
			const deadline = Date.now() + 15000;
			while (confirmed === before && Date.now() < deadline) await delay(100);
			assert.ok(confirmed > before, 'interactive WKWebView visited the signed-in page');
			await delay(600);
			// Match only the fresh fixture's browse instance and never the ordinary desktop app.
			const pattern =
				'/Contents/MacOS/Fetchy browse [[:xdigit:]-]+ http://127[.]0[.]0[.]1:' +
				server.address().port +
				'/entry$';
			const match = await runProcess('/usr/bin/pgrep', ['-f', pattern]);
			assert.match(match.stdout.trim(), /^\d+$/, 'Launch Services started one dedicated browser');
			const pid = Number(match.stdout.trim());
			windows.add(pid);
			process.kill(pid, 'SIGTERM');
			for (let i = 0; i < 50; i++) {
				if (!(await runProcess('/bin/ps', ['-p', String(pid), '-o', 'pid='])).stdout.trim()) break;
				await delay(100);
			}
			windows.delete(pid);
		}
		t.after(async () => {
			for (const pid of windows) {
				try {
					process.kill(pid, 'SIGTERM');
				} catch {}
			}
			await logout(site).catch(() => {});
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
			if (previous === undefined) delete process.env.FETCHY_DATA_DIR;
			else process.env.FETCHY_DATA_DIR = previous;
			await rm(dir, {recursive: true, force: true});
		});
		const opts = {outputDir: path.join(dir, 'saved'), timeoutMs: 20000};
		await assert.rejects(() => downloadWithSession(site + '/watch', opts), {code: 'auth_required'});
		await enter();
		assert.equal(await hasSession(site + '/watch'), true);
		assert.equal(await hasSession(site.replace('127.0.0.1', 'localhost') + '/watch'), false);
		const otherSite = site.replace('127.0.0.1', 'localhost');
		const otherLogout = await command('logout', otherSite);
		assert.equal(otherLogout.code, 0, otherLogout.stderr);
		assert.equal(await hasSession(site + '/watch'), true);
		for (const page of ['/watch', '/dynamic', '/movie.mp4']) {
			const saved = await downloadWithSession(site + page, opts);
			assert.equal(saved.validation.width, 160);
			assert.equal(saved.validation.audio, true);
			assert.equal(saved.bytes, (await stat(saved.filepath)).size);
		}
		const cliSaved = await command('get', site + '/watch');
		assert.equal(cliSaved.code, 0, cliSaved.stderr);
		const result = JSON.parse(cliSaved.stdout);
		assert.equal(result.engine, 'webkit');
		assert.equal(result.validation.width, 160);
		assert.equal(result.bytes, (await stat(result.filepath)).size);
		assert.ok(result.taskId);
		const cliPost = await command('get', site + '/article', '--allow-local');
		assert.equal(cliPost.code, 0, cliPost.stderr);
		const post = JSON.parse(cliPost.stdout);
		assert.equal(post.kind, 'post');
		assert.match(await readFile(post.filepath, 'utf8'), /Last line/);
		const article = await captureWithSession(site + '/article', opts);
		assert.equal(article.type, 'post');
		assert.equal(article.entry.bodyComplete, true);
		assert.match(article.entry.body, /First line[\s\S]*## Middle[\s\S]*Last line/);
		assert.equal(article.entry.attachments[0].mimeType, 'image/gif');
		assert.equal((await captureWithSession(site + '/summary', opts)).entry.bodyComplete, false);
		assert.ok(authorizedDownloads >= 3);
		session = null;
		const expired = await command('get', site + '/watch');
		assert.equal(expired.code, 1);
		assert.match(JSON.parse(expired.stderr).error.message, /fetchy browse/);
		await assert.rejects(() => captureWithSession(site + '/article', opts), {
			code: 'auth_required',
		});
		await assert.rejects(() => downloadWithSession(site + '/watch', opts), {code: 'auth_required'});
		await enter();
		const renewed = await command('get', site + '/dynamic');
		assert.equal(renewed.code, 0, renewed.stderr);
		assert.ok(JSON.parse(renewed.stdout).validation.video);
		const loggedOut = await command('logout', site);
		assert.equal(loggedOut.code, 0, loggedOut.stderr);
		assert.equal(await hasSession(site + '/watch'), false);
		await assert.rejects(() => downloadWithSession(site + '/watch', opts), {code: 'auth_required'});
	},
);
