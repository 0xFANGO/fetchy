import {invalidUrl} from './shared.mjs';

function singleVideo({
	id,
	label,
	hosts,
	extractor,
	path,
	canonical,
	matchesSource,
	extractorName,
	receiptFields,
}) {
	return {
		id,
		label,
		hosts,
		extractor,
		matchesSource,
		extractorName,
		receiptFields,
		parse(url) {
			const match = path.exec(url.pathname);
			if (!match) invalidUrl(`请使用具体的 ${label} 视频链接。`);
			return {id: match[1], url: canonical(match[1])};
		},
	};
}

export const videoHosts = [
	singleVideo({
		id: 'streamable',
		label: 'Streamable',
		hosts: ['streamable.com', 'www.streamable.com'],
		extractor: 'Streamable',
		path: /^\/(?:e\/)?([a-z0-9]+)\/?$/,
		canonical: (id) => `https://streamable.com/${id}`,
	}),
	singleVideo({
		id: 'vimeo',
		label: 'Vimeo',
		hosts: ['vimeo.com', 'www.vimeo.com', 'player.vimeo.com'],
		extractor: 'Vimeo',
		path: /^\/(?:video\/)?(\d+)\/?$/,
		canonical: (id) => `https://vimeo.com/${id}`,
	}),
	singleVideo({
		id: 'dailymotion',
		label: 'Dailymotion',
		hosts: ['dailymotion.com', 'www.dailymotion.com'],
		extractor: 'Dailymotion',
		path: /^\/(?:embed\/)?video\/([a-z0-9]+)(?:_[\w-]+)?\/?$/,
		canonical: (id) => `https://www.dailymotion.com/video/${id}`,
	}),
	singleVideo({
		id: 'loom',
		label: 'Loom',
		hosts: ['loom.com', 'www.loom.com'],
		extractor: 'Loom',
		path: /^\/(?:share|embed)\/([\da-f]{32})\/?$/,
		canonical: (id) => `https://www.loom.com/share/${id}`,
	}),
	singleVideo({
		id: 'rumble',
		label: 'Rumble',
		hosts: ['rumble.com', 'www.rumble.com'],
		extractor: 'RumbleEmbed',
		path: /^\/embed\/(v[0-9a-z]+)\/?$/,
		canonical: (id) => `https://rumble.com/embed/${id}/`,
	}),
	singleVideo({
		id: 'archive',
		label: 'Internet Archive',
		hosts: ['archive.org', 'www.archive.org'],
		extractor: 'ArchiveOrg',
		extractorName: 'archive\\.org',
		path: /^\/(?:details|embed)\/([a-z\d_-][a-z\d._-]*(?:\/[a-z\d_-][a-z\d._-]*\.(?:mp4|ogv|mov|mkv|avi|webm))?)\/?$/i,
		canonical: (id) => `https://archive.org/details/${id}`,
	}),
	singleVideo({
		id: 'ted',
		label: 'TED',
		hosts: ['ted.com', 'www.ted.com'],
		extractor: 'TedTalk',
		receiptFields: ['webpage_url'],
		path: /^\/talks\/([a-z0-9_]+)\/?$/,
		canonical: (id) => `https://www.ted.com/talks/${id}`,
		matchesSource: (target, info) => /^\d+$/.test(info.id) && info.webpage_url === target.url,
	}),
	singleVideo({
		id: 'vk',
		label: 'VK',
		hosts: ['vk.com', 'www.vk.com', 'vkvideo.ru'],
		extractor: 'VK',
		path: /^\/video(-?\d+_\d+)\/?$/,
		canonical: (id) => `https://vk.com/video${id}`,
	}),
];

export const peerTube = {
	id: 'peertube',
	label: 'PeerTube',
	hosts: ['framatube.org', 'video.blender.org'],
	extractor: 'PeerTube',
	receiptFields: ['webpage_url'],
	parse(url) {
		const match =
			/^\/videos\/(?:watch|embed)\/([\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12})\/?$/i.exec(
				url.pathname,
			);
		if (!match) invalidUrl('请使用已支持实例的 PeerTube 视频 UUID 链接。');
		const uuid = match[1].toLowerCase();
		return {id: `${url.hostname}/${uuid}`, url: `https://${url.hostname}/videos/watch/${uuid}`};
	},
	matchesSource(target, info) {
		return info.webpage_url === target.url && target.id.endsWith('/' + info.id);
	},
};
