import {invalidUrl} from './shared.mjs';

const facebook = {
	id: 'facebook',
	label: 'Facebook',
	hosts: ['facebook.com', 'www.facebook.com', 'm.facebook.com'],
	extractor: 'Facebook',
	parse(u) {
		const id =
			/^\/(?:[\w.-]+\/videos|reel)\/(\d+)\/?$/.exec(u.pathname)?.[1] ??
			(/^\/(?:watch\/?|video\.php)$/.test(u.pathname) ? u.searchParams.get('v') : null);
		if (!id || !/^\d+$/.test(id)) invalidUrl('请使用具体的 Facebook 视频链接。');
		return {id, url: `https://www.facebook.com/watch/?v=${id}`};
	},
};
const tiktok = {
	id: 'tiktok',
	label: 'TikTok',
	hosts: ['tiktok.com', 'www.tiktok.com'],
	extractor: 'TikTok',
	parse(u) {
		const match = /^\/@([\w.-]+)\/video\/(\d+)\/?$/.exec(u.pathname);
		if (!match) invalidUrl('请使用具体的 TikTok 视频详情页。');
		return {id: match[2], url: `https://www.tiktok.com/@${match[1]}/video/${match[2]}`};
	},
};
const weibo = {
	id: 'weibo',
	label: '微博',
	hosts: ['weibo.com', 'www.weibo.com'],
	extractor: 'Weibo',
	parse(u) {
		const match = /^\/(\d+)\/([a-zA-Z0-9]+)\/?$/.exec(u.pathname);
		if (!match) invalidUrl('请使用包含作者 ID 和微博短码的帖子链接。');
		return {id: match[2], url: `https://weibo.com/${match[1]}/${match[2]}`};
	},
	matchesSource: (target, info) => info.display_id === target.id && /^\d+$/.test(info.id),
};
const bluesky = {
	id: 'bluesky',
	label: 'Bluesky',
	hosts: ['bsky.app'],
	extractor: 'Bluesky',
	receiptFields: ['uploader_id', 'channel_id'],
	parse(u) {
		const match =
			/^\/profile\/([a-z0-9.-]+\.[a-z][a-z0-9-]*|did:plc:[a-z2-7]{24})\/post\/([2-7a-z]{13})\/?$/i.exec(
				u.pathname,
			);
		if (!match) invalidUrl('请使用 Bluesky 单帖链接。');
		const actor = match[1].toLowerCase(),
			post = match[2];
		return {id: `${actor}/${post}`, url: `https://bsky.app/profile/${actor}/post/${post}`};
	},
	matchesSource(target, info) {
		return [info.uploader_id, info.channel_id].some(
			(actor) => actor && `${actor}/${info.id}` === target.id,
		);
	},
};
const reddit = {
	id: 'reddit',
	label: 'Reddit',
	hosts: ['reddit.com', 'www.reddit.com', 'old.reddit.com'],
	extractor: 'Reddit',
	parse(u) {
		const match = /^\/(?:r\/[a-z0-9_]+\/)?comments\/([a-z0-9]+)(?:\/[\w-]+)?\/?$/i.exec(u.pathname);
		if (!match) invalidUrl('请使用 Reddit 单帖链接。');
		const id = match[1].toLowerCase();
		return {id, url: `https://www.reddit.com/comments/${id}/`};
	},
	matchesSource: (target, info) => info.display_id === target.id && /^[a-z0-9]+$/i.test(info.id),
};
const pinterest = {
	id: 'pinterest',
	label: 'Pinterest',
	hosts: ['pinterest.com', 'www.pinterest.com'],
	extractor: 'Pinterest',
	parse(u) {
		const id = /^\/pin\/(?:[\w-]+--)?(\d+)\/?$/.exec(u.pathname)?.[1];
		if (!id) invalidUrl('请使用 Pinterest 单个 Pin 链接。');
		return {id, url: `https://www.pinterest.com/pin/${id}/`};
	},
};
const imgur = {
	id: 'imgur',
	label: 'Imgur',
	hosts: ['imgur.com', 'www.imgur.com', 'i.imgur.com'],
	extractor: 'Imgur',
	parse(u) {
		const id = /^\/([a-zA-Z0-9]{5,7})(?:\.mp4|\.gifv)?\/?$/.exec(u.pathname)?.[1];
		if (!id || ['about', 'upload', 'search', 'signin', 'gallery', 'memes', 'rules'].includes(id))
			invalidUrl('请使用 Imgur 单个视频链接。');
		return {id, url: `https://imgur.com/${id}`};
	},
};
const tumblr = {
	id: 'tumblr',
	label: 'Tumblr',
	hosts: ['www.tumblr.com', 'tumblr.com'],
	subdomain: 'tumblr.com',
	extractor: 'Tumblr',
	parse(u) {
		const main = u.hostname === 'www.tumblr.com' || u.hostname === 'tumblr.com';
		const match = main
			? /^\/([a-z0-9-]+)\/(\d+)(?:\/[\w-]+)?\/?$/i.exec(u.pathname)
			: /^\/post\/(\d+)(?:\/[\w-]+)?\/?$/.exec(u.pathname);
		if (!match) invalidUrl('请使用 Tumblr 作者的单篇视频帖子。');
		const blog = main ? match[1].toLowerCase() : u.hostname.split('.')[0];
		const id = main ? match[2] : match[1];
		return {id, url: `https://${blog}.tumblr.com/post/${id}`};
	},
};
export const socialVideo = [facebook, tiktok, weibo, bluesky, reddit, pinterest, imgur, tumblr];
