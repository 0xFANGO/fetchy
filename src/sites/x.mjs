import {invalidUrl} from './shared.mjs';

export default {
	id: 'x',
	label: 'X',
	hosts: ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'],
	extractor: 'Twitter',
	thumbnailHosts: ['pbs.twimg.com'],
	publicThumbnail(url) {
		// The public poster is available without the query parameters.
		return url.origin + url.pathname;
	},
	matchesSource(target, info) {
		// Twitter's display_id identifies the post, and id identifies its media.
		return (
			info.display_id === target.id &&
			typeof info.id === 'string' &&
			/^[1-9]\d{0,19}$/.test(info.id)
		);
	},
	parse(u) {
		const id = /^\/(?:[A-Za-z0-9_]{1,15}|i\/web)\/status\/([1-9]\d{0,19})\/?$/.exec(
			u.pathname,
		)?.[1];
		if (!id) invalidUrl('请使用包含单个视频的 X 帖子链接。');
		return {id, url: `https://x.com/i/web/status/${id}`};
	},
};
