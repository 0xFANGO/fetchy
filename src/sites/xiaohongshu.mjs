import {invalidUrl} from './shared.mjs';

export default {
	id: 'xiaohongshu',
	label: '小红书',
	hosts: ['xiaohongshu.com', 'www.xiaohongshu.com'],
	shortHosts: ['xhslink.com', 'www.xhslink.com'],
	pageMedia: true,
	thumbnailHosts: ['xhscdn.com'],
	parse(u) {
		const id = /^\/(?:explore|discovery\/item)\/([a-f\d]{24})\/?$/i.exec(u.pathname)?.[1];
		if (!id) invalidUrl('需要具体小红书笔记链接。');
		const canonical = new URL(`https://www.xiaohongshu.com/explore/${id}`);
		for (const key of ['xsec_token', 'xsec_source'])
			if (u.searchParams.has(key)) canonical.searchParams.set(key, u.searchParams.get(key));
		return {id, url: canonical.href};
	},
};
