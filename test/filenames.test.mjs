import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {publishVideoFile, videoFilename} from '../src/filenames.mjs';

async function fixture(t, name = 'media.part', contents = 'validated-media') {
	const directory = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'fetchy-title-test-')));
	t.after(() => fs.rm(directory, {recursive: true, force: true}));
	const source = path.join(directory, name);
	await fs.writeFile(source, contents);
	return {directory, source, contents};
}

test('title filenames preserve readable Unicode and normalize unsafe path characters', () => {
	assert.equal(videoFilename('  方格：一起看世界 / 第 1 集?  '), '方格：一起看世界 第 1 集.mp4');
	assert.equal(videoFilename('Cafe\u0301 👨‍👩‍👧‍👦'), 'Café 👨‍👩‍👧‍👦.mp4');
	assert.equal(videoFilename('../foo\\bar:<hello>|"world"*\n\t..'), 'foo bar hello world.mp4');
	assert.equal(videoFilename('.hidden\u202e\u2066 title... '), 'hidden title.mp4');
	assert.equal(videoFilename('演示.MP4'), '演示.mp4');
	assert.equal(videoFilename('TOKEN explained'), 'TOKEN explained.mp4');
});

test('filenames omit embedded links and recognizable credential assignments', () => {
	const title =
		'分享 https://example.test/video?xsec_token=SECRET_URL TOKEN explained token=SECRET_TOKEN authorization: Bearer SECRET_AUTH signature="SECRET SIGN"';
	const name = videoFilename(title);
	assert.equal(name, '分享 TOKEN explained.mp4');
	assert.doesNotMatch(name, /SECRET|https|authorization|signature/);
	assert.equal(
		videoFilename('片段\nCookie: session=SECRET_COOKIE; another=SECRET_MORE'),
		'片段.mp4',
	);
	assert.equal(
		videoFilename('https://example.test/?token=SECRET', {platform: 'youtube', id: 'abcdefghijk'}),
		'youtube-abcdefghijk.mp4',
	);
});

test('empty, punctuation-only, device and long titles have portable bounded basenames', () => {
	for (const title of [null, undefined, {}, '', '... --- ___ !!!', '\0\u202e'])
		assert.equal(videoFilename(title), '未命名视频.mp4');
	assert.equal(
		videoFilename('', {platform: 'bilibili', id: 'BV1GJ411x7h7'}),
		'bilibili-BV1GJ411x7h7.mp4',
	);
	assert.equal(videoFilename('', {platform: '../../escape', id: '../SECRET'}), '未命名视频.mp4');
	for (const title of ['CON', 'nul.txt', 'CoM1', 'LPT²'])
		assert.equal(videoFilename(title), `_${title}.mp4`);
	const name = videoFilename('中文🙂'.repeat(100));
	assert.ok(Buffer.byteLength(name) <= 184);
	assert.equal(name.slice(0, -4).isWellFormed(), true);
	assert.doesNotMatch(name, /\ufffd/);
	assert.equal(videoFilename('-'.repeat(300) + 'title'), '未命名视频.mp4');
	assert.ok(Buffer.byteLength(videoFilename('CON.' + '长'.repeat(100))) <= 184);
});

test('validated staging file becomes title.mp4 in its same directory', async (t) => {
	const {directory, source, contents} = await fixture(t);
	const result = await publishVideoFile(source, {title: '我的视频 / 第一期'});
	assert.equal(result, path.join(directory, '我的视频 第一期.mp4'));
	assert.equal(await fs.readFile(result, 'utf8'), contents);
	assert.deepEqual(await fs.readdir(directory), ['我的视频 第一期.mp4']);
});

test('staged media is published directly into the chosen canonical output directory', async (t) => {
	const {directory, source, contents} = await fixture(t, '视频.mp4');
	const staging = await fs.mkdtemp(path.join(directory, '.fetchy-'));
	const staged = path.join(staging, '视频.mp4');
	await fs.rename(source, staged);
	const alias = path.join(directory, 'output-alias');
	await fs.symlink(directory, alias);
	const result = await publishVideoFile(staged, {title: '视频', outputDir: alias});
	assert.equal(result, path.join(directory, '视频.mp4'));
	assert.equal(await fs.readFile(result, 'utf8'), contents);
	assert.deepEqual(await fs.readdir(staging), []);
});

test('existing files and symlinks are never overwritten, with numbered collision suffixes', async (t) => {
	const {directory, source, contents} = await fixture(t);
	const prior = path.join(directory, '同一个标题.mp4');
	await fs.writeFile(prior, 'keep-user-file');
	await fs.symlink(prior, path.join(directory, '同一个标题 (2).mp4'));
	const result = await publishVideoFile(source, {title: '同一个标题'});
	assert.equal(path.basename(result), '同一个标题 (3).mp4');
	assert.equal(await fs.readFile(result, 'utf8'), contents);
	assert.equal(await fs.readFile(prior, 'utf8'), 'keep-user-file');
	assert.equal((await fs.lstat(path.join(directory, '同一个标题 (2).mp4'))).isSymbolicLink(), true);
});

test('concurrent publications with matching titles preserve both videos', async (t) => {
	const {directory, source} = await fixture(t, 'first.part', 'first');
	const staging = await fs.mkdtemp(path.join(directory, '.fetchy-'));
	const other = path.join(staging, 'second.part');
	await fs.writeFile(other, 'second');
	const results = await Promise.all([
		publishVideoFile(source, {title: '同名', outputDir: directory}),
		publishVideoFile(other, {title: '同名', outputDir: directory}),
	]);
	assert.equal(new Set(results).size, 2);
	assert.ok(results.every((filename) => path.dirname(filename) === directory));
	assert.deepEqual(
		new Set(await Promise.all(results.map((name) => fs.readFile(name, 'utf8')))),
		new Set(['first', 'second']),
	);
	assert.deepEqual(await fs.readdir(staging), []);
	assert.deepEqual((await fs.readdir(directory)).sort(), [
		path.basename(staging),
		'同名 (2).mp4',
		'同名.mp4',
	]);
});

test('matching source name is a no-op and source symlinks are rejected', async (t) => {
	const {directory, source, contents} = await fixture(t, 'media.mp4');
	assert.equal(await publishVideoFile(source, {title: 'media'}), source);
	assert.equal(await fs.readFile(source, 'utf8'), contents);
	const symlink = path.join(directory, 'alias.part');
	await fs.symlink(source, symlink);
	await assert.rejects(publishVideoFile(symlink, {title: 'renamed'}), {code: 'output_invalid'});
	assert.equal(await fs.readFile(source, 'utf8'), contents);
});

test('a volume without hard links uses an exclusive copy without overwriting a collision', async (t) => {
	const {directory, source, contents} = await fixture(t);
	const outputDir = path.join(directory, 'output');
	await fs.mkdir(outputDir);
	await fs.writeFile(path.join(outputDir, '视频.mp4'), 'preserved');
	t.mock.method(fs, 'link', async () => {
		throw Object.assign(new Error('not supported'), {code: 'ENOTSUP'});
	});
	const originalCopy = fs.copyFile;
	const flags = [];
	t.mock.method(fs, 'copyFile', async (...args) => {
		flags.push(args[2]);
		return originalCopy(...args);
	});
	const result = await publishVideoFile(source, {title: '视频', outputDir});
	assert.equal(result, path.join(outputDir, '视频 (2).mp4'));
	assert.ok(flags.every((value) => value === constants.COPYFILE_EXCL));
	assert.equal(await fs.readFile(result, 'utf8'), contents);
	assert.equal(await fs.readFile(path.join(outputDir, '视频.mp4'), 'utf8'), 'preserved');
});

test('cancellation after moving out of staging removes only the newly published video', async (t) => {
	const {directory, source} = await fixture(t);
	const outputDir = path.join(directory, 'output');
	await fs.mkdir(outputDir);
	await fs.writeFile(path.join(outputDir, '视频.mp4'), 'preserved');
	const controller = new AbortController(),
		originalUnlink = fs.unlink;
	t.mock.method(fs, 'unlink', async (filename) => {
		await originalUnlink(filename);
		if (filename === source) controller.abort();
	});
	await assert.rejects(
		publishVideoFile(source, {title: '视频', outputDir, signal: controller.signal}),
		{code: 'cancelled'},
	);
	assert.deepEqual(await fs.readdir(outputDir), ['视频.mp4']);
	assert.equal(await fs.readFile(path.join(outputDir, '视频.mp4'), 'utf8'), 'preserved');
	assert.deepEqual(await fs.readdir(directory), ['output']);
});

test('invalid or missing output directories never consume the validated source', async (t) => {
	const {directory, source, contents} = await fixture(t);
	for (const outputDir of [null, '', {}, 'bad\0path']) {
		await assert.rejects(publishVideoFile(source, {title: '视频', outputDir}), {
			code: 'invalid_options',
		});
	}
	for (const outputDir of [source, path.join(directory, 'missing')]) {
		await assert.rejects(publishVideoFile(source, {title: '视频', outputDir}), {
			code: 'output_invalid',
		});
	}
	assert.equal(await fs.readFile(source, 'utf8'), contents);
	assert.deepEqual(await fs.readdir(directory), ['media.part']);
});

test('cancellation before publication preserves source; after publication removes only the new file', async (t) => {
	const {directory, source, contents} = await fixture(t);
	await assert.rejects(publishVideoFile(source, {title: '视频', signal: AbortSignal.abort()}), {
		code: 'cancelled',
	});
	const controller = new AbortController(),
		originalLink = fs.link;
	t.mock.method(fs, 'link', async (...args) => {
		await originalLink(...args);
		controller.abort();
	});
	await assert.rejects(publishVideoFile(source, {title: '视频', signal: controller.signal}), {
		code: 'cancelled',
	});
	assert.deepEqual(await fs.readdir(directory), ['media.part']);
	assert.equal(await fs.readFile(source, 'utf8'), contents);
});

test('failed publication reports safe storage errors and leaves the source untouched', async (t) => {
	const {directory, source, contents} = await fixture(t);
	t.mock.method(fs, 'link', async () => {
		throw Object.assign(new Error('private/path/SECRET'), {code: 'ENOSPC'});
	});
	await assert.rejects(
		publishVideoFile(source, {title: '视频'}),
		(error) => error.code === 'disk_full' && !error.message.includes('SECRET'),
	);
	assert.deepEqual(await fs.readdir(directory), ['media.part']);
	assert.equal(await fs.readFile(source, 'utf8'), contents);
});

test('cancellation after exclusive-copy fallback removes the copy and preserves the source', async (t) => {
	const {directory, source, contents} = await fixture(t);
	const controller = new AbortController(),
		originalCopy = fs.copyFile;
	t.mock.method(fs, 'link', async () => {
		throw Object.assign(new Error(), {code: 'ENOTSUP'});
	});
	t.mock.method(fs, 'copyFile', async (...args) => {
		await originalCopy(...args);
		controller.abort();
	});
	await assert.rejects(publishVideoFile(source, {title: '视频', signal: controller.signal}), {
		code: 'cancelled',
	});
	assert.deepEqual(await fs.readdir(directory), ['media.part']);
	assert.equal(await fs.readFile(source, 'utf8'), contents);
});

test('a replaced source is not deleted and the owned unpublished result is cleaned', async (t) => {
	const {directory, source} = await fixture(t);
	const originalLink = fs.link;
	t.mock.method(fs, 'link', async (...args) => {
		await originalLink(...args);
		await fs.unlink(source);
		await fs.writeFile(source, 'replacement-to-preserve');
	});
	await assert.rejects(publishVideoFile(source, {title: '视频'}), {code: 'output_invalid'});
	assert.deepEqual(await fs.readdir(directory), ['media.part']);
	assert.equal(await fs.readFile(source, 'utf8'), 'replacement-to-preserve');
});
