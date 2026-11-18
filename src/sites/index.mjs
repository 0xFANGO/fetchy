import youtube from './youtube.mjs';
import bilibili from './bilibili.mjs';
import xiaohongshu from './xiaohongshu.mjs';
import douyin from './douyin.mjs';
import x from './x.mjs';
import instagram from './instagram.mjs';

export const sites = [youtube, bilibili, xiaohongshu, douyin, x, instagram];
const byId = new Map(sites.map((site) => [site.id, site]));
const byHost = new Map();
for (const site of sites) {
	for (const host of [...site.hosts, ...(site.shortHosts ?? [])]) byHost.set(host, site);
}
export const siteForHost = (host) => byHost.get(host);
export const siteForPlatform = (platform) => byId.get(platform);
export const usesPageMedia = (platform) => siteForPlatform(platform)?.pageMedia === true;
export const unsupportedPlatformMessage =
	'暂不支持此网站，请使用 ' + sites.map((site) => site.label).join('、') + ' 的视频链接。';
