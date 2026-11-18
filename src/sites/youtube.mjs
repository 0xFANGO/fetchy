import {invalidUrl, startTime} from './shared.mjs';

export default {
	id: 'youtube',
	label: 'YouTube',
	hosts: ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'],
	thumbnailHosts: ['ytimg.com', 'youtube.com'],
	retryHls: true,
	publicThumbnail(url, id) {
		// ytimg also hosts channel images and storyboards.
		const [, type, videoId] = url.pathname.split('/');
		return id && ['vi', 'vi_webp'].includes(type) && videoId === String(id) ? url.href : null;
	},
	parse(u) {
		const id =
			u.hostname === 'youtu.be'
				? u.pathname.split('/')[1]
				: u.pathname === '/watch'
					? u.searchParams.get('v')
					: /^\/(?:shorts|embed|live)\/([^/]+)/.exec(u.pathname)?.[1];
		if (!/^[\w-]{11}$/.test(id || ''))
			invalidUrl('需要具体 YouTube 视频链接，暂不支持频道或播放列表。');
		return {
			id,
			url: `https://www.youtube.com/watch?v=${id}`,
			startTimeSeconds: startTime(
				u.searchParams.get('t') ||
					u.searchParams.get('start') ||
					new URLSearchParams(u.hash.slice(1)).get('t'),
			),
		};
	},
};
