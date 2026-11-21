import {invalidUrl} from './shared.mjs';

export const twitch = {
	id: 'twitch',
	label: 'Twitch',
	hosts: ['twitch.tv', 'www.twitch.tv', 'clips.twitch.tv'],
	parse(u) {
		const vod = u.hostname !== 'clips.twitch.tv' && /^\/videos\/(\d+)\/?$/.exec(u.pathname)?.[1];
		if (vod)
			return {
				id: 'v' + vod,
				url: `https://www.twitch.tv/videos/${vod}`,
				extractor: 'TwitchVod',
				extractorName: 'twitch:vod',
			};
		const clip =
			u.hostname === 'clips.twitch.tv'
				? /^\/([\w-]+)\/?$/.exec(u.pathname)?.[1]
				: /^\/[\w-]+\/clip\/([\w-]+)\/?$/.exec(u.pathname)?.[1];
		if (!clip || clip === 'embed') invalidUrl('请提供 Twitch 剪辑或已结束的录像链接。');
		return {
			id: clip,
			url: `https://clips.twitch.tv/${clip}`,
			extractor: 'TwitchClips',
			extractorName: 'twitch:clips',
		};
	},
	matchesSource: (target, info) =>
		target.extractor === 'TwitchVod'
			? target.id === info.id
			: info.display_id === target.id && /^\d+$/.test(info.id),
};

export const kick = {
	id: 'kick',
	label: 'Kick',
	hosts: ['kick.com', 'www.kick.com'],
	parse(u) {
		const clip = /^\/([\w-]+)\/clips\/(clip_[\w-]+)\/?$/.exec(u.pathname);
		if (clip)
			return {
				id: clip[2],
				url: `https://kick.com/${clip[1]}/clips/${clip[2]}`,
				extractor: 'KickClip',
				extractorName: 'kick:clip',
			};
		const vod = /^\/([\w-]+)\/videos\/([\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12})\/?$/i.exec(
			u.pathname,
		);
		if (!vod) invalidUrl('请提供 Kick 剪辑或已结束的录像链接。');
		return {
			id: vod[2],
			url: `https://kick.com/${vod[1]}/videos/${vod[2]}`,
			extractor: 'KickVOD',
			extractorName: 'kick:vod',
		};
	},
};
