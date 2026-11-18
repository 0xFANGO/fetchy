import {invalidUrl} from './shared.mjs';

function numericIdAtCanonicalUrl(target, info) {
	return /^\d+$/.test(info.id) && info.webpage_url === target.url;
}

const bandcamp = {
	id: 'bandcamp',
	label: 'Bandcamp',
	kind: 'audio',
	hosts: [],
	subdomain: 'bandcamp.com',
	extractor: 'Bandcamp',
	receiptFields: ['webpage_url'],
	parse(u) {
		const match = /^\/track\/([a-z0-9-]+)\/?$/.exec(u.pathname);
		if (!match || u.hostname === 'www.bandcamp.com')
			invalidUrl('请提供 Bandcamp 艺人页面的单曲链接。');
		const artist = u.hostname.split('.')[0];
		return {id: `${artist}/${match[1]}`, url: `https://${u.hostname}/track/${match[1]}`};
	},
	matchesSource: numericIdAtCanonicalUrl,
};
const soundcloud = {
	id: 'soundcloud',
	label: 'SoundCloud',
	kind: 'audio',
	hosts: ['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com'],
	extractor: 'Soundcloud',
	receiptFields: ['webpage_url'],
	parse(u) {
		const match = /^\/([a-z0-9_-]+)\/([a-z0-9_-]+)\/?$/i.exec(u.pathname);
		if (
			!match ||
			['discover', 'you', 'search', 'stations', 'stream', 'tags'].includes(match[1]) ||
			['sets', 'tracks', 'albums', 'reposts', 'likes', 'spotlight', 'comments'].includes(match[2])
		)
			invalidUrl('请提供 SoundCloud 艺人的单曲链接。');
		const id = `${match[1]}/${match[2]}`;
		return {id, url: `https://soundcloud.com/${id}`};
	},
	matchesSource: numericIdAtCanonicalUrl,
};
const mixcloud = {
	id: 'mixcloud',
	label: 'Mixcloud',
	kind: 'audio',
	hosts: ['mixcloud.com', 'www.mixcloud.com'],
	extractor: 'Mixcloud',
	receiptFields: ['webpage_url'],
	parse(u) {
		const match = /^\/([\w-]+)\/([\w-]+)\/?$/.exec(u.pathname);
		if (!match || ['stream', 'uploads', 'favorites', 'listens', 'playlists'].includes(match[2]))
			invalidUrl('请提供 Mixcloud 的单个节目链接。');
		return {
			id: `${match[1]}/${match[2]}`,
			url: `https://www.mixcloud.com/${match[1]}/${match[2]}/`,
		};
	},
	matchesSource: (target, info) =>
		info.id === target.id.replace('/', '_') && info.webpage_url === target.url,
};
export const audioSites = [bandcamp, mixcloud, soundcloud];

export const odysee = {
	id: 'odysee',
	label: 'Odysee',
	kind: 'mixed',
	hosts: ['odysee.com', 'www.odysee.com'],
	extractor: 'LBRY',
	receiptFields: ['webpage_url'],
	parse(u) {
		const match = /^\/(?:@([\w.-]+):([0-9a-f]{1,40})\/)?([\w.-]+):([0-9a-f]{1,40})\/?$/i.exec(
			u.pathname,
		);
		if (!match) invalidUrl('请提供带作品名和 claim ID 的 Odysee 单条作品链接。');
		const id = u.pathname.slice(1).replace(/\/$/, '');
		return {id, url: `https://odysee.com/${id}`};
	},
	matchesSource(target, info) {
		const shortClaim = target.id.slice(target.id.lastIndexOf(':') + 1);
		return (
			typeof info.id === 'string' &&
			/^[a-f0-9]{40}$/.test(info.id) &&
			info.id.startsWith(shortClaim) &&
			info.webpage_url === target.url
		);
	},
};
