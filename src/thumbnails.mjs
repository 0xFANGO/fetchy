import {siteForPlatform} from './sites/index.mjs';

/** Only platform image CDNs may be loaded by the popup; unknown covers are optional. */
export function publicThumbnailUrl(value, {platform, id} = {}) {
	if (typeof value !== 'string' || value.length > 8192 || value !== value.trim()) return null;
	const site = siteForPlatform(platform);
	const hosts = site?.thumbnailHosts;
	if (!hosts) return null;
	try {
		// These image CDNs serve HTTPS even when upstream metadata supplies HTTP.
		const candidate = value.replace(/^http:/i, 'https:');
		const url = new URL(candidate);
		if (
			url.protocol !== 'https:' ||
			url.username ||
			url.password ||
			url.port ||
			url.hash ||
			!hosts.some((host) => url.hostname === host || url.hostname.endsWith('.' + host))
		)
			return null;
		if (/\.(?:mp4|m3u8|m4s|mpd|webm)$/i.test(url.pathname) || /^sns-video/i.test(url.hostname))
			return null;
		return site.publicThumbnail ? site.publicThumbnail(url, id) : candidate;
	} catch {
		return null;
	}
}

export function pickPublicThumbnail(values, target) {
	for (const value of values) {
		const url = publicThumbnailUrl(value, target);
		if (url) return url;
	}
	return null;
}
