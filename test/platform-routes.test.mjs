import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeUrl, resolveVideo} from '../src/index.mjs';
import {siteForPlatform} from '../src/sites/index.mjs';
import {resolveAudio} from '../src/audio.mjs';

const cases = [
	['facebook', 'https://www.facebook.com/example/videos/12345/?ref=tracking', '12345'],
	['tiktok', 'https://www.tiktok.com/@example/video/12345', '12345'],
	['weibo', 'https://weibo.com/12345/NaB12', 'NaB12'],
	[
		'bluesky',
		'https://bsky.app/profile/blender.org/post/3mxrcw6rxhf2j',
		'blender.org/3mxrcw6rxhf2j',
	],
	['reddit', 'https://reddit.com/r/example/comments/a23cd/post_slug/', 'a23cd'],
	['pinterest', 'https://pinterest.com/pin/title--1234/', '1234'],
	['imgur', 'https://i.imgur.com/AbCdE12.mp4', 'AbCdE12'],
	['tumblr', 'https://www.tumblr.com/example/123/article', '123'],
	['streamable', 'https://streamable.com/e/dnd1', 'dnd1'],
	['vimeo', 'https://player.vimeo.com/video/1234', '1234'],
	['dailymotion', 'https://www.dailymotion.com/video/x1234_name', 'x1234'],
	[
		'loom',
		'https://www.loom.com/embed/43d05f362f734614a2e81b4694a3a523',
		'43d05f362f734614a2e81b4694a3a523',
	],
	['rumble', 'https://rumble.com/embed/v5pv5f', 'v5pv5f'],
	['archive', 'https://archive.org/embed/BigBuckBunny_328', 'BigBuckBunny_328'],
	['ted', 'https://www.ted.com/talks/one_example', 'one_example'],
	['vk', 'https://vk.com/video-77521_162222515', '-77521_162222515'],
	[
		'peertube',
		'https://framatube.org/videos/watch/9c9de5e8-0a1e-484a-b099-e80766180a6d',
		'framatube.org/9c9de5e8-0a1e-484a-b099-e80766180a6d',
	],
	['twitch', 'https://www.twitch.tv/example/clip/SomeClip', 'SomeClip'],
	['twitch', 'https://www.twitch.tv/videos/123', 'v123'],
	['kick', 'https://kick.com/example/clips/clip_A123', 'clip_A123'],
	[
		'kick',
		'https://kick.com/example/videos/9c9de5e8-0a1e-484a-b099-e80766180a6d',
		'9c9de5e8-0a1e-484a-b099-e80766180a6d',
	],
	['bandcamp', 'https://artist.bandcamp.com/track/one-tune', 'artist/one-tune'],
	['soundcloud', 'https://soundcloud.com/nasa/clip', 'nasa/clip'],
	['mixcloud', 'https://www.mixcloud.com/artist/episode/', 'artist/episode'],
	['odysee', 'https://odysee.com/@creator:1/recording:ab', '@creator:1/recording:ab'],
];

test('platform URLs have stable identity across canonical and shared forms', () => {
	for (const [platform, url, id] of cases) {
		const target = normalizeUrl(url);
		assert.equal(target.platform, platform, url);
		assert.equal(target.id, id, url);
		assert.equal(new URL(target.url).search, platform === 'facebook' ? '?v=12345' : '', url);
		assert.deepEqual(normalizeUrl(target.url), target, url);
	}
});

test('user libraries, live channels, boards, albums and unrelated subdomains stay distinct', () => {
	for (const url of [
		'https://www.tiktok.com/@example/photo/12345',
		'https://www.pinterest.com/artist/my-board/',
		'https://www.loom.com/workspace/videos',
		'https://artist.bandcamp.com/album/test',
		'https://soundcloud.com/nasa/sets/space',
		'https://www.mixcloud.com/artist/playlists/',
		'https://imgur.com/a/AbCdE12',
		'https://www.twitch.tv/example',
		'https://kick.com/example',
		'https://odysee.com/@channel:f',
		'https://www.facebook.com/artist',
		'https://reddit.com/r/space/comments/abc/title/def/',
	])
		assert.throws(() => normalizeUrl(url), {code: 'invalid_url'}, url);
	for (const host of [
		'artist.bandcamp.com.example.org',
		'artist.foo.bandcamp.com',
		'artist-tumblr.com',
		'video.example.org',
	]) {
		assert.throws(() => normalizeUrl(`https://${host}/track/sound`), {
			code: 'unsupported_platform',
		});
	}
});

test('source identity includes the origin for federated records and namespaced audio tracks', () => {
	const peertube = normalizeUrl(cases.find(([platform]) => platform === 'peertube')[1]);
	const uuid = peertube.id.split('/')[1],
		peerSite = siteForPlatform('peertube');
	assert.ok(peerSite.matchesSource(peertube, {id: uuid, webpage_url: peertube.url}));
	assert.equal(
		peerSite.matchesSource(peertube, {
			id: uuid,
			webpage_url: peertube.url.replace('framatube.org', 'video.blender.org'),
		}),
		false,
	);
	const bluesky = normalizeUrl(cases.find(([platform]) => platform === 'bluesky')[1]);
	const tid = bluesky.id.split('/')[1];
	assert.equal(
		siteForPlatform('bluesky').matchesSource(bluesky, {id: tid, uploader_id: 'other.example'}),
		false,
	);
	assert.ok(
		siteForPlatform('bluesky').matchesSource(bluesky, {id: tid, uploader_id: 'blender.org'}),
	);
	const bandcamp = normalizeUrl('https://artist.bandcamp.com/track/example');
	assert.ok(
		siteForPlatform('bandcamp').matchesSource(bandcamp, {id: '123', webpage_url: bandcamp.url}),
	);
	assert.equal(
		siteForPlatform('bandcamp').matchesSource(bandcamp, {
			id: '123',
			webpage_url: bandcamp.url.replace('artist.', 'another.'),
		}),
		false,
	);
});

test('audio and video API entry points reject mismatched content before contacting a platform', async () => {
	await assert.rejects(
		resolveVideo('https://artist.bandcamp.com/track/example', {ytDlpPath: '/not-installed'}),
		{code: 'unsupported_content'},
	);
	await assert.rejects(resolveAudio('https://streamable.com/dnd1', {ytDlpPath: '/not-installed'}), {
		code: 'unsupported_content',
	});
});
