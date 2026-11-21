import {invalidUrl} from './shared.mjs';

export default {
	id: 'douyin',
	label: '抖音',
	hosts: ['douyin.com', 'www.douyin.com', 'iesdouyin.com', 'www.iesdouyin.com'],
	shortHosts: ['v.douyin.com'],
	pageMedia: true,
	thumbnailHosts: ['douyinpic.com', 'byteimg.com', 'byteimg.com.cn', 'ibytedtos.com'],
	parse(u) {
		const id = ['www.iesdouyin.com', 'iesdouyin.com'].includes(u.hostname)
			? /^\/share\/video\/(\d+)\/?$/.exec(u.pathname)?.[1]
			: /^\/video\/(\d+)\/?$/.exec(u.pathname)?.[1] || u.searchParams.get('modal_id');
		if (!/^\d{10,25}$/.test(id || '')) invalidUrl('需要具体抖音视频链接或含 modal_id 的页面。');
		return {
			id,
			url: `https://www.douyin.com/video/${id}`,
		};
	},
};
