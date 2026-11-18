import {invalidUrl, startTime} from './shared.mjs';

export default {
	id: 'bilibili',
	label: 'B站',
	hosts: ['bilibili.com', 'www.bilibili.com', 'm.bilibili.com'],
	shortHosts: ['b23.tv'],
	thumbnailHosts: ['hdslb.com'],
	matchesSource(target, info) {
		const page = target.page ?? 1;
		if (target.id.startsWith('BV')) {
			return (info.id === target.id && page === 1) || info.id === target.id + '_p' + page;
		}
		// yt-dlp keeps the requested AV number and part in an archive alias.
		return (
			Array.isArray(info._old_archive_ids) &&
			info._old_archive_ids.includes('bilibili ' + target.id.slice(2) + '_part' + page)
		);
	},
	parse(u) {
		const id = /^\/video\/(BV[\w]{10}|av\d+)\/?$/.exec(u.pathname)?.[1];
		if (!id) invalidUrl('需要具体 B 站 BV/av 视频链接。');
		const rawPage = u.searchParams.get('p'),
			page = rawPage === null ? 1 : Number(rawPage);
		if (!Number.isSafeInteger(page) || page < 1) invalidUrl('B 站分 P 参数必须为正整数。');
		return {
			id,
			page,
			url: `https://www.bilibili.com/video/${id}/${page === 1 ? '' : `?p=${page}`}`,
			startTimeSeconds: startTime(u.searchParams.get('t')),
		};
	},
};
