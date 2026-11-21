import {invalidUrl} from './shared.mjs';

export default {
	id: 'instagram',
	label: 'Instagram',
	hosts: ['instagram.com', 'www.instagram.com'],
	extractor: 'Instagram',
	parse(url) {
		const match =
			/^\/(?:(?!share\/)[A-Za-z0-9._]{1,30}\/)?(reels?)\/([A-Za-z0-9_-]{1,28})\/?$/.exec(
				url.pathname,
			);
		const id = match?.[2];
		if (!id || (match[1] === 'reels' && id === 'audio'))
			invalidUrl('请使用具体的 Instagram Reel 链接。');
		return {id, url: `https://www.instagram.com/reel/${id}/`};
	},
};
