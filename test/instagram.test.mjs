import assert from 'node:assert/strict';
import test from 'node:test';
import {normalizeUrl} from '../src/index.mjs';

test('Instagram Reel links retain case-sensitive shortcodes and discard share tracking', () => {
	const id = 'Abcd_12-eFg';
	const url = `https://www.instagram.com/reel/${id}/`;
	for (const input of [
		url,
		`https://instagram.com/reel/${id}?igsh=private#fragment`,
		`https://www.instagram.com/nasa/reel/${id}/`,
		`https://www.instagram.com/reels/${id}/`,
	]) {
		assert.deepEqual(normalizeUrl(input), {platform: 'instagram', id, url, startTimeSeconds: null});
	}
});

test('Instagram accepts individual Reels and rejects other content and lookalike hosts', () => {
	for (const pathname of [
		'/nasa/',
		'/reel/',
		'/p/Abcd_12-eFg/',
		'/stories/nasa/1234/',
		'/reels/audio/1234/',
		'/reels/audio/',
		'/share/reel/Abcd_12-eFg/',
		'/reel/Abcd_12-eFg/embed/',
		'/reel/Abcd%2F12-eFg/',
		'/reel/' + 'a'.repeat(39) + '/',
	]) {
		assert.throws(() => normalizeUrl(`https://instagram.com${pathname}`), {code: 'invalid_url'});
	}
	assert.throws(() => normalizeUrl('https://instagram.com.example.org/reel/Abcd_12-eFg/'), {
		code: 'unsupported_platform',
	});
});
