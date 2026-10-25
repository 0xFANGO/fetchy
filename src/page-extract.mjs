/**
 * Read only the selected video's public playback state.
 * Keep this function self-contained: callers may evaluate its toString() in a page.
 * URLs are ephemeral download inputs; do not persist the result in public logs.
 */
export function extractPageMedia({platform, expectedId, snapshot} = {}) {
	function fail(code, message) {
		throw Object.assign(new Error(message), {code});
	}
	function positive(value) {
		if ((typeof value !== 'number' && typeof value !== 'string') || value === '') return null;
		const number = Number(value);
		return Number.isFinite(number) && number > 0 ? number : null;
	}
	function text(value) {
		return typeof value === 'string' && value ? value : null;
	}
	// Read only cover fields inside the already identity-checked target. No DOM
	// image fallback: a recommendation or advertisement is not a video cover.
	function coverUrl(value) {
		if (typeof value === 'string') return value;
		if (Array.isArray(value)) {
			for (const item of value) {
				const url = coverUrl(item);
				if (url) return url;
			}
			return null;
		}
		if (!value || typeof value !== 'object') return null;
		return (
			text(value.urlDefault) ||
			text(value.urlPre) ||
			text(value.src) ||
			text(value.url) ||
			coverUrl(value.urlList) ||
			coverUrl(value.url_list) ||
			coverUrl(value.infoList)
		);
	}
	function permittedUrls(values) {
		const suffix = platform === 'xiaohongshu' ? '.xhscdn.com' : '.douyinvod.com';
		const found = [];
		for (const value of values) {
			if (typeof value !== 'string') continue;
			try {
				const url = new URL(value);
				if (
					value !== value.trim() ||
					url.username ||
					url.password ||
					url.port ||
					!url.hostname.endsWith(suffix) ||
					url.hostname.length <= suffix.length
				)
					continue;
				// XHS SSR can publish HTTP addresses for CDN resources observed over HTTPS.
				// Upgrade only this verified CDN family; retain the signed query byte-for-byte.
				const candidate =
					platform === 'xiaohongshu' && url.protocol === 'http:'
						? value.replace(/^http:/i, 'https:')
						: value;
				if (url.protocol !== 'https:' && !(platform === 'xiaohongshu' && url.protocol === 'http:'))
					continue;
				if (!found.includes(candidate)) found.push(candidate);
			} catch {
				/* Ignore malformed media candidates, never execute their content. */
			}
		}
		return found;
	}
	function xhsCodec(value) {
		if (typeof value !== 'string') return null;
		// EF4 was verified against this investigation's decoded sample. Other opaque
		// platform labels remain unknown until independently verified.
		const codecs = {EF4: 'h264', h264: 'h264', h265: 'h265', hevc: 'h265', av1: 'av1'};
		return Object.prototype.hasOwnProperty.call(codecs, value) ? codecs[value] : null;
	}
	function record(id, item, urls, codecs = {}) {
		return {
			id,
			ext: 'mp4',
			protocol: 'https',
			width: positive(item.width),
			height: positive(item.height),
			fps: positive(item.fps),
			vcodec: text(codecs.vcodec),
			acodec: text(codecs.acodec),
			bitrate: positive(item.avgBitrate ?? item.bitRate),
			size: positive(item.size ?? item.dataSize),
			// These are muxed playback candidates; the downloader must verify both tracks.
			hasVideo: true,
			hasAudio: true,
			urls,
		};
	}
	if (!['xiaohongshu', 'douyin'].includes(platform))
		fail('unsupported_platform', '当前页面解析器仅支持小红书和抖音。');
	if (
		typeof expectedId !== 'string' ||
		!(platform === 'xiaohongshu' ? /^[a-f\d]{24}$/i : /^\d{10,25}$/).test(expectedId)
	) {
		fail('invalid_options', '需要平台视频的完整字符串 ID。');
	}
	if (
		snapshot !== undefined &&
		(!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot))
	) {
		fail('invalid_options', '页面快照必须是对象。');
	}

	let selected;
	if (platform === 'xiaohongshu') {
		selected =
			snapshot !== undefined
				? snapshot.note
				: typeof window !== 'undefined'
					? window.__INITIAL_STATE__?.note?.noteDetailMap?.[expectedId]?.note
					: null;
	} else if (snapshot !== undefined) {
		selected = snapshot.detail;
	} else {
		try {
			const raw =
				typeof document !== 'undefined'
					? document.getElementById('RENDER_DATA')?.textContent
					: null;
			selected = raw ? JSON.parse(decodeURIComponent(raw))?.app?.videoDetail : null;
		} catch {
			fail('browser_state_missing', '抖音页面状态不可解析，请打开目标视频后重试。');
		}
	}
	if (!selected || typeof selected !== 'object' || Array.isArray(selected)) {
		fail('browser_state_missing', '当前页面尚未提供目标视频详情。');
	}
	const actualId = platform === 'xiaohongshu' ? selected.noteId : selected.awemeId;
	if (typeof actualId !== 'string' || actualId !== expectedId) {
		fail('identity_mismatch', '页面内容与请求的视频 ID 不一致，请重新打开目标视频。');
	}

	const formats = [];
	let durationSeconds = null;
	if (platform === 'xiaohongshu') {
		const streams = selected.video?.media?.stream;
		if (streams && typeof streams === 'object' && !Array.isArray(streams)) {
			for (const [family, items] of Object.entries(streams)) {
				if (!Array.isArray(items)) continue;
				items.forEach((item, index) => {
					if (!item || typeof item !== 'object') return;
					const urls = permittedUrls([
						item.masterUrl,
						...(Array.isArray(item.backupUrls) ? item.backupUrls : []),
					]);
					if (!urls.length) return;
					formats.push(
						record(`${family}-${index}`, item, urls, {
							vcodec: xhsCodec(item.videoCodec),
							acodec: item.audioCodec,
						}),
					);
					durationSeconds ??=
						positive(item.duration) === null ? null : positive(item.duration) / 1000;
				});
			}
		}
	} else {
		const video = selected.video;
		durationSeconds = positive(video?.duration) === null ? null : positive(video.duration) / 1000;
		const rates = Array.isArray(video?.bitRateList) ? video.bitRateList : [];
		const candidates = rates.length ? rates : video ? [video] : [];
		candidates.forEach((item, index) => {
			if (
				!item ||
				typeof item !== 'object' ||
				Object.prototype.hasOwnProperty.call(item, 'audioFileId')
			)
				return;
			const urls = permittedUrls(
				(Array.isArray(item.playAddr) ? item.playAddr : []).map((address) => address?.src),
			);
			if (!urls.length) return;
			// videoFormat is the container (e.g. mp4), not a codec identifier.
			const codec =
				item.isH265 === true || item.isH265 === 1
					? 'h265'
					: item.isH265 === false || item.isH265 === 0
						? 'h264'
						: null;
			formats.push(
				record(`${text(item.gearName) || 'play'}-${index}`, item, urls, {
					vcodec: codec,
					acodec: null,
				}),
			);
		});
	}
	if (!formats.length) fail('no_formats', '没有找到当前支持的合流视频候选。');
	return {
		platform,
		id: actualId,
		title: text(platform === 'xiaohongshu' ? selected.title : selected.desc) || actualId,
		thumbnailUrl:
			platform === 'xiaohongshu'
				? coverUrl(selected.imageList?.[0]) || coverUrl(selected.video?.cover)
				: coverUrl(selected.video?.originCover) || coverUrl(selected.video?.cover),
		durationSeconds,
		formats,
		engine: 'browser',
		availability: 'ready',
	};
}
