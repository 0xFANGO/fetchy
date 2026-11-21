import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter, once} from 'node:events';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {LibraryBridge} from '../native/library-bridge.mjs';
import {requestNative} from '../native/client.mjs';
import {startServer} from '../native/server.mjs';
import {searchLibrary} from '../src/library/index.mjs';

const gif = 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
const bytes = Buffer.from(gif, 'base64');
const inline = {kind: 'image', mimeType: 'image/gif', data: gif};
const post = (id, attachments) => ({
	platform: 'x',
	id,
	sourceUrl: 'https://x.com/sample/status/' + id,
	title: 'Sample ' + id,
	body: 'Saved text ' + id,
	bodyComplete: true,
	attachments,
});
async function fixture(t, handle) {
	const dir = await mkdtemp(path.join(tmpdir(), 'fy-q-'));
	const http = createServer(handle);
	await new Promise((res) => http.listen(0, '127.0.0.1', res));
	t.after(async () => {
		http.closeAllConnections();
		await new Promise((r) => http.close(r));
		await rm(dir, {recursive: true, force: true});
	});
	return {dir, origin: 'http://127.0.0.1:' + http.address().port};
}
const imageResponse = (res) => res.writeHead(200, {'content-type': 'image/gif'}).end(bytes);

test(
	'the native socket returns a queued ID before remote media and keeps working after the client disconnects',
	{timeout: 12000},
	async (t) => {
		const reached = Promise.withResolvers();
		const paths = [];
		let held;
		const {dir, origin} = await fixture(t, (req, res) => {
			paths.push(new URL(req.url, 'http://fixture').pathname);
			if (req.url.startsWith('/slow?')) {
				held = res;
				reached.resolve();
			} else if (req.url === '/large')
				res.writeHead(200, {'content-type': 'image/gif'}).end(Buffer.concat([bytes, bytes]));
			else imageResponse(res);
		});
		const bridge = new LibraryBridge(dir);
		// Grant this test fixture explicitly on the server. IPC does not accept network overrides.
		// maxBytes caps each file; a batch has no combined limit.
		Object.assign(bridge.options, {localOrigin: origin, maxBytes: bytes.length + 10});
		const controller = Object.assign(new EventEmitter(), {
			snapshot: () => ({}),
			request: bridge.request.bind(bridge),
		});
		const server = await startServer(controller, path.join(dir, 'bridge.sock'));
		t.after(() => server.close());
		const secret = 'temporary-queue-test-value';
		const url = origin + '/slow?token=' + secret;
		const task = await requestNative(
			'libraryStart',
			{
				manifest: {
					version: 1,
					items: [
						post('70001', [inline, {kind: 'image', url}, {kind: 'image', url}]),
						post('70002', [
							{kind: 'image', url: origin + '/large'},
							{kind: 'image', url: origin + '/after'},
						]),
					],
				},
			},
			{directory: dir, timeoutMs: 2000},
		);
		assert.equal(task.status, 'queued');
		await reached.promise;
		assert.equal(server.clientCount, 0);
		const db = await readFile(path.join(dir, 'library', 'library.sqlite'));
		assert.ok(db.includes('Saved text 70001'));
		assert.ok(!db.includes(secret));
		imageResponse(held);
		await bridge.tail;
		const finished = await requestNative('libraryTask', {id: task.id}, {directory: dir});
		assert.deepEqual(finished.counts, {added: 1, skipped: 0, partial: 1, failed: 0, pending: 0});
		assert.deepEqual(paths, ['/slow', '/large', '/after']);
		const partial = finished.items.find((i) => i.key === 'x:70002');
		assert.equal(partial.reason, 'size_limit');
		const [rest] = await searchLibrary({key: 'x:70002'}, bridge.options);
		assert.equal(rest.attachments[0].error, 'size_limit');
		assert.ok(rest.attachments[1].path);
		const [complete] = await searchLibrary({key: 'x:70001'}, bridge.options);
		assert.equal(complete.attachments.length, 3);
		assert.ok(complete.attachments.every((a) => a.path === complete.attachments[0].path));
		assert.ok(!(await readFile(path.join(dir, 'library', 'library.sqlite'))).includes(secret));
	},
);

test(
	'after daemon termination completed work survives and unresolved browser media becomes partial on the next connection',
	{timeout: 15000},
	async (t) => {
		const reached = Promise.withResolvers();
		const {dir, origin} = await fixture(t, (_req, _res) => reached.resolve());
		const moduleURL = new URL('../native/library-bridge.mjs', import.meta.url).href;
		const child = spawn(
			process.execPath,
			[
				'--input-type=module',
				'-e',
				`import {LibraryBridge} from ${JSON.stringify(moduleURL)};process.on('message',async m=>{const b=new LibraryBridge(m.dir);b.options.localOrigin=m.origin;const task=await b.request('libraryStart',{manifest:m.manifest});process.send(task);});`,
			],
			{stdio: ['ignore', 'ignore', 'inherit', 'ipc']},
		);
		t.after(() => {
			if (child.exitCode === null && child.signalCode === null) child.kill();
		});
		const taskMessage = once(child, 'message');
		const secret = 'expired-source-reference';
		child.send({
			dir,
			origin,
			manifest: {
				version: 1,
				items: [
					post('71001', [inline]),
					post('71002', [inline, {kind: 'image', url: origin + '/blocked?sig=' + secret}]),
				],
			},
		});
		const [queued] = await taskMessage;
		await reached.promise;
		const stopped = once(child, 'close');
		child.kill('SIGKILL');
		await stopped;
		const downloads = async () =>
			(await readdir(path.join(dir, 'library'))).filter((name) => name.startsWith('.download-'));
		assert.equal((await downloads()).length, 1);
		const fresh = new LibraryBridge(dir);
		await fresh.request('libraryTasks', {});
		await fresh.tail;
		assert.deepEqual(await downloads(), []);
		const result = await fresh.request('libraryTask', {id: queued.id});
		assert.equal(result.status, 'partial');
		assert.deepEqual(
			result.items.map((x) => x.status),
			['added', 'partial'],
		);
		const [entry] = await searchLibrary({key: 'x:71002'}, fresh.options);
		assert.equal(entry.body, 'Saved text 71002');
		assert.ok(entry.attachments[0].path);
		assert.equal(entry.attachments[1].needsSource, true);
		assert.ok(!JSON.stringify(entry).includes(secret));
		assert.ok(!(await readFile(path.join(dir, 'library', 'library.sqlite'))).includes(secret));
		const recaptured = await fresh.request('libraryStart', {
			manifest: {version: 1, items: [post('71002', [inline, inline])]},
		});
		await fresh.tail;
		assert.equal((await fresh.request('libraryTask', {id: recaptured.id})).status, 'completed');
	},
);

test('native retry forwards selected keys without retrying other failed items', async (t) => {
	const {dir} = await fixture(t, (_req, res) => res.writeHead(404).end());
	const bridge = new LibraryBridge(dir);
	const attempts = [];
	bridge.options.downloadVideo = async (url) => {
		attempts.push(url);
		throw Object.assign(Error(), {code: 'unavailable'});
	};
	const items = ['78001', '78002'].map((id) => ({...post(id, []), kind: 'video', body: ''}));
	const task = await bridge.request('libraryStart', {manifest: {version: 1, items}});
	await bridge.tail;
	assert.equal((await bridge.request('libraryTask', {id: task.id})).counts.failed, 2);
	attempts.length = 0;
	await bridge.request('libraryRetry', {id: task.id, selected: ['x:78002']});
	await bridge.tail;
	assert.deepEqual(attempts, [items[1].sourceUrl]);
});

test('the desktop library counts works by kind, filters search by kind and removes works', async (t) => {
	const {dir} = await fixture(t, imageResponse);
	const bridge = new LibraryBridge(dir);
	const items = [
		{...post('79001', [inline]), title: 'Pictures'},
		{...post('79002', []), title: 'Long read', bodyFormat: 'markdown'},
	];
	await bridge.request('libraryStart', {manifest: {version: 1, items}});
	await bridge.tail;
	assert.deepEqual(await bridge.request('libraryStats', {}), {
		root: path.join(dir, 'library'),
		total: 2,
		kinds: {post: 1, article: 1},
		platforms: {x: 2},
		folders: {},
	});
	const [article] = await bridge.request('librarySearch', {filters: {kind: 'article'}});
	assert.equal(article.title, 'Long read');
	const [picture] = await bridge.request('librarySearch', {filters: {kind: 'post'}});
	assert.equal(picture.files.length, 1);
	await bridge.request('libraryRename', {key: 'x:79001', title: 'Renamed'});
	assert.equal(
		(await bridge.request('librarySearch', {filters: {key: 'x:79001'}}))[0].title,
		'Renamed',
	);
	const removed = await bridge.request('libraryRemove', {keys: ['x:79001']});
	assert.deepEqual(removed.removed, ['x:79001']);
	assert.ok(removed.files.includes(picture.files[0]));
	assert.equal((await bridge.request('libraryStats', {})).total, 1);
});
