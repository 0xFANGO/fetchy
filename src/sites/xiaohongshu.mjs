import {invalidUrl} from './shared.mjs';

const rednoteHosts = ['rednote.com', 'www.rednote.com'];
export const isRednoteHost = (host) => rednoteHosts.includes(host);

export default {
	id: 'xiaohongshu',
	label: '小红书',
	hosts: ['xiaohongshu.com', 'www.xiaohongshu.com', ...rednoteHosts],
	shortHosts: ['xhslink.com', 'www.xhslink.com'],
	pageMedia: true,
	thumbnailHosts: ['xhscdn.com', 'rednotecdn.com'],
	parse(u) {
		const id =
			/^\/(?:explore|discovery\/item|board\/[\w-]+|user\/profile\/[a-f\d]+)\/([a-f\d]{24})\/?$/i.exec(
				u.pathname,
			)?.[1];
		if (!id) invalidUrl('需要具体小红书笔记链接。');
		// The domestic extractor expects www; keep rednote links on the host serving the note.
		const origin = u.hostname === 'xiaohongshu.com' ? 'https://www.xiaohongshu.com' : u.origin;
		const canonical = new URL('/explore/' + id, origin);
		for (const key of ['xsec_token', 'xsec_source'])
			if (u.searchParams.has(key)) canonical.searchParams.set(key, u.searchParams.get(key));
		return {id, url: canonical.href};
	},
};
