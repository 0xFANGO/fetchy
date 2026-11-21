import youtube from './youtube.mjs';
import bilibili from './bilibili.mjs';
import xiaohongshu from './xiaohongshu.mjs';
import douyin from './douyin.mjs';
import x from './x.mjs';
import instagram from './instagram.mjs';
import {socialVideo} from './social-video.mjs';
import {videoHosts, peerTube} from './video-hosts.mjs';
import {kick, twitch} from './recordings.mjs';
import {audioSites, odysee} from './audio-sites.mjs';

export const sites = [
	youtube,
	bilibili,
	xiaohongshu,
	douyin,
	x,
	instagram,
	...socialVideo,
	...videoHosts,
	peerTube,
	twitch,
	kick,
	...audioSites,
	odysee,
];
const byId = new Map(sites.map((site) => [site.id, site]));
const byHost = new Map();
for (const site of sites) {
	for (const host of [...site.hosts, ...(site.shortHosts ?? [])]) byHost.set(host, site);
}
const bySubdomain = new Map(
	sites.filter((site) => site.subdomain).map((site) => [site.subdomain, site]),
);
export function siteForHost(host) {
	const exact = byHost.get(host);
	if (exact) return exact;
	const dot = host.indexOf('.');
	if (dot < 1 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(host.slice(0, dot))) return undefined;
	return bySubdomain.get(host.slice(dot + 1));
}
export const siteForPlatform = (platform) => byId.get(platform);
export const usesPageMedia = (platform) => siteForPlatform(platform)?.pageMedia === true;
export const unsupportedPlatformMessage = '暂不支持此网站，请查看 Fetchy 的平台列表。';
