/**
 * Self-contained browser media sniffer injected at document_start across all frames.
 * Captures MP4/WebM/audio, HLS (#EXTM3U), DASH (<MPD), DOM media playback, and
 * cross-iframe media into window.__fetchySniffer on the top frame.
 */
export function installMediaSniffer() {
	if (typeof window === 'undefined' || window.__fetchySniffer) return;

	const MAX_ITEMS = 120;
	const AD_RE =
		/(?:doubleclick\.net|googlesyndication|googleadservices|adservice\.|adsystem|\/ads\/|\/ad_|analytics|telemetry|\/pixel|\/beacon|\/track)/i;
	const SEGMENT_RE =
		/\.(?:ts|m4s|cmfv|cmfa|vtt|srt|ass|png|jpe?g|gif|webp|avif|svg|ico|css|js|woff2?|ttf|map)(?:$|\?)/i;
	const CHUNK_RE = /(?:^|\/)(?:seg|chunk|frag|init)[-_]?\d*\.(?:mp4|m4v|m4a|webm)(?:$|\?)/i;
	const RANGE_RE = /[?&](?:range|bytestart|byteend)=/i;
	// X/Twitter CMAF single-codec/single-resolution/audio-only HLS sub-playlists.
	const TWIMG_VARIANT_RE =
		/\/\/video\.twimg\.com\/.*\/pl\/(?:avc1|av01|hvc1|hev1|vp09|mp4a|audio|video|\d+x\d+)\//i;
	const HLS_SUB_RE = /\/(?:subtitles?|captions?|webvtt|audio[_-]?only)\/[^/]*\.m3u8(?:$|\?)/i;
	const TWIMG_VIDEO_ID_RE = /\/(ext_tw_video|amplify_video|tweet_video)\/(\d+)\//i;
	const TWIMG_THUMB_ID_RE =
		/\/(?:ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)\/(\d+)\//i;
	const URL_RES_RE = /\/(\d{2,4})x(\d{2,4})(?:\/|_|\.)/;
	const X_HOST_RE = /(?:^|\.)(?:x\.com|twitter\.com)$/i;
	const GENERIC_X_TITLE_RE =
		/^(?:Home|History|Explore|Notifications|Messages|Bookmarks|X)\s*(?:\/\s*X)?$/i;

	const EXT_HLS = /\.m3u8(?:$|\?)/i;
	const EXT_DASH = /\.mpd(?:$|\?)/i;
	const EXT_VIDEO = /\.(?:mp4|webm|mkv|mov|flv|m4v)(?:$|\?)/i;
	const EXT_AUDIO = /\.(?:mp3|m4a|aac|ogg|flac|wav|opus)(?:$|\?)/i;

	const isTop = (() => {
		try {
			return window === window.top;
		} catch {
			return false;
		}
	})();

	const store = new Map();
	const subPlaylistUrls = new Set();
	const xMetaByVideoId = new Map();
	let perfWatermark = 0;

	function routeKey(href) {
		try {
			const u = new URL(href || location.href);
			return u.origin + u.pathname + (u.pathname === '/home' ? '' : u.search);
		} catch {
			return String(href || '');
		}
	}

	let currentRoute = routeKey(location?.href || '');

	function normalizeMediaUrl(raw) {
		if (typeof raw !== 'string') return '';
		const trimmed = raw.trim();
		if (!trimmed || /^(?:blob|data|javascript|about):/i.test(trimmed)) return '';
		try {
			const u = new URL(trimmed, location.href);
			if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
			u.hash = '';
			return u.href;
		} catch {
			return '';
		}
	}

	function twimgVideoId(url) {
		try {
			const u = new URL(url);
			if (!/(?:^|\.)twimg\.com$/i.test(u.hostname)) return '';
			const m = TWIMG_VIDEO_ID_RE.exec(u.pathname);
			return m ? m[2] : '';
		} catch {
			return '';
		}
	}

	function canonicalKey(url) {
		try {
			const u = new URL(url);
			if (/(?:^|\.)twimg\.com$/i.test(u.hostname)) {
				const m = TWIMG_VIDEO_ID_RE.exec(u.pathname);
				if (m) return `twimg:${m[1].toLowerCase()}:${m[2]}`;
			}
		} catch {}
		return url;
	}

	function parseDimsFromUrl(url) {
		const m = URL_RES_RE.exec(String(url || ''));
		if (!m) return {width: 0, height: 0};
		const width = Number(m[1]) || 0;
		const height = Number(m[2]) || 0;
		if (width >= 100 && height >= 100 && width <= 8192 && height <= 8192) {
			return {width, height};
		}
		return {width: 0, height: 0};
	}

	function shouldIgnore(url) {
		if (!url) return true;
		if (AD_RE.test(url)) return true;
		if (SEGMENT_RE.test(url)) return true;
		if (CHUNK_RE.test(url)) return true;
		if (TWIMG_VARIANT_RE.test(url)) return true;
		if (HLS_SUB_RE.test(url)) return true;
		if (subPlaylistUrls.has(url)) return true;
		if (RANGE_RE.test(url) && !EXT_HLS.test(url) && !EXT_DASH.test(url)) return true;
		return false;
	}

	function classify(url, mime = '', head = '') {
		const m = String(mime || '').toLowerCase();
		const h = String(head || '');
		if (EXT_HLS.test(url) || /mpegurl/i.test(m) || /^\s*#EXTM3U\b/m.test(h)) return 'hls';
		if (EXT_DASH.test(url) || /dash\+xml/i.test(m) || /<MPD[\s>]/i.test(h)) return 'dash';
		if (EXT_AUDIO.test(url) || /^audio\//i.test(m)) return 'audio';
		if (EXT_VIDEO.test(url) || (/^video\//i.test(m) && !/mp2t/i.test(m))) return 'video';
		return '';
	}

	function pageTitle() {
		try {
			return String(document.title || '')
				.replace(/^\(\d+\+?\)\s*/, '')
				.replace(/\s+/g, ' ')
				.trim()
				.slice(0, 140);
		} catch {
			return '';
		}
	}

	function filenameFromUrl(url) {
		try {
			const u = new URL(url);
			const base = decodeURIComponent(u.pathname.split('/').pop() || '');
			return base && base.length <= 100 ? base : u.hostname;
		} catch {
			return '';
		}
	}

	function isGenericTitle(title) {
		if (!title) return true;
		return GENERIC_X_TITLE_RE.test(title.trim());
	}

	function inspectHlsBody(masterUrl, body) {
		if (!body || typeof body !== 'string')
			return {isMaster: false, isMedia: false, width: 0, height: 0};
		const hasMasterTag = /#EXT-X-STREAM-INF\b|#EXT-X-MEDIA\b/i.test(body);
		const hasSegmentTag = /#EXTINF:/i.test(body);
		if (!hasMasterTag) {
			return {isMaster: false, isMedia: hasSegmentTag, width: 0, height: 0};
		}
		let maxWidth = 0;
		let maxHeight = 0;
		const lines = body.split(/\r?\n/);
		for (const rawLine of lines) {
			const line = rawLine.trim();
			if (!line) continue;
			if (line.startsWith('#')) {
				const resMatch = /RESOLUTION=(\d+)x(\d+)/i.exec(line);
				if (resMatch) {
					const w = Number(resMatch[1]) || 0;
					const h = Number(resMatch[2]) || 0;
					if (w * h > maxWidth * maxHeight) {
						maxWidth = w;
						maxHeight = h;
					}
				}
				const uriMatch = /URI="([^"]+)"/i.exec(line);
				if (uriMatch) {
					const sub = normalizeMediaUrl(new URL(uriMatch[1], masterUrl).href);
					if (sub && sub !== masterUrl) {
						subPlaylistUrls.add(sub);
						removeUrlFromStore(sub);
					}
				}
				continue;
			}
			try {
				const sub = normalizeMediaUrl(new URL(line, masterUrl).href);
				if (sub && sub !== masterUrl) {
					subPlaylistUrls.add(sub);
					removeUrlFromStore(sub);
				}
			} catch {}
		}
		return {isMaster: true, isMedia: false, width: maxWidth, height: maxHeight};
	}

	function removeUrlFromStore(url) {
		for (const [key, item] of store.entries()) {
			if (item.url === url) store.delete(key);
		}
	}

	function urlQualityScore(item) {
		if (!item) return 0;
		let score = 0;
		if (item.type === 'hls') score += item.isMaster ? 500 : item.isSubPlaylist ? 100 : 350;
		else if (item.type === 'dash') score += 450;
		else if (item.type === 'video') score += 300;
		else if (item.type === 'audio') score += 150;
		const pixels = (item.width || 0) * (item.height || 0);
		if (pixels > 0) score += Math.min(200, Math.round(pixels / 10000));
		return score;
	}

	function enrichFromXMeta(item) {
		const vid = twimgVideoId(item.url);
		if (!vid) return item;
		const meta = xMetaByVideoId.get(vid);
		if (!meta) return item;
		return {
			...item,
			title: !isGenericTitle(item.title) ? item.title : meta.title || item.title,
			poster: item.poster || meta.poster || '',
			pageUrl: meta.pageUrl || item.pageUrl,
			duration: Math.max(item.duration || 0, meta.duration || 0),
			width: Math.max(item.width || 0, meta.width || 0),
			height: Math.max(item.height || 0, meta.height || 0),
		};
	}

	function record(rawUrl, meta = {}) {
		const url = normalizeMediaUrl(rawUrl);
		if (shouldIgnore(url)) return;
		const type = meta.type || classify(url, meta.mime, meta.head);
		if (!type) return;
		let host = '';
		try {
			host = new URL(url).hostname;
		} catch {}
		const rawPoster =
			meta.poster ||
			(() => {
				try {
					const og = document.querySelector?.(
						'meta[property="og:image"], meta[name="twitter:image"]',
					);
					return og?.getAttribute?.('content') || '';
				} catch {
					return '';
				}
			})();
		const poster = /^https?:\/\//i.test(String(rawPoster || ''))
			? String(rawPoster).replace(/^http:\/\//i, 'https://')
			: '';
		const dims = parseDimsFromUrl(url);
		const isManifest = type === 'hls' || type === 'dash';
		const item = enrichFromXMeta({
			url,
			type,
			title: meta.title || pageTitle() || filenameFromUrl(url),
			poster,
			mime: String(meta.mime || '')
				.split(';')[0]
				.trim()
				.toLowerCase(),
			// Never report .m3u8/.mpd manifest text bytes as media file size.
			size: !isManifest && Number.isFinite(meta.size) && meta.size > 0 ? Math.round(meta.size) : 0,
			duration: Number.isFinite(meta.duration) && meta.duration > 0 ? Math.round(meta.duration) : 0,
			width: Number.isFinite(meta.width) && meta.width > 0 ? Math.round(meta.width) : dims.width,
			height:
				Number.isFinite(meta.height) && meta.height > 0 ? Math.round(meta.height) : dims.height,
			isMaster: meta.isMaster === true,
			isSubPlaylist: meta.isSubPlaylist === true,
			host,
			pageUrl: meta.pageUrl || location.href,
			ts: Date.now(),
		});
		if (!isTop) {
			try {
				window.top.postMessage({__fetchyMedia: true, item}, '*');
			} catch {}
			return;
		}
		mergeItem(item);
	}

	function mergeItem(rawItem) {
		if (!rawItem?.url || shouldIgnore(rawItem.url)) return;
		const item = enrichFromXMeta(rawItem);
		const key = canonicalKey(item.url);
		const prev = store.get(key);
		if (prev) {
			const preferNew = urlQualityScore(item) > urlQualityScore(prev);
			const chosen = preferNew ? item : prev;
			const other = preferNew ? prev : item;
			const isManifest = chosen.type === 'hls' || chosen.type === 'dash';
			const bestTitle = !isGenericTitle(chosen.title)
				? chosen.title
				: !isGenericTitle(other.title)
					? other.title
					: chosen.title || other.title;
			store.set(key, {
				...chosen,
				title: bestTitle,
				poster: chosen.poster || other.poster || '',
				mime: chosen.mime || other.mime,
				size: isManifest ? 0 : Math.max(chosen.size || 0, other.size || 0),
				duration: Math.max(chosen.duration || 0, other.duration || 0),
				width: Math.max(chosen.width || 0, other.width || 0),
				height: Math.max(chosen.height || 0, other.height || 0),
				isMaster: Boolean(chosen.isMaster || other.isMaster),
				isSubPlaylist: Boolean(chosen.isSubPlaylist && !chosen.isMaster && !other.isMaster),
				pageUrl: chosen.pageUrl || other.pageUrl,
				ts: Math.max(chosen.ts || 0, other.ts || 0),
			});
			return;
		}
		if (store.size >= MAX_ITEMS) {
			const oldest = store.keys().next().value;
			if (oldest) store.delete(oldest);
		}
		store.set(key, item);
	}

	const JSON_VIDEO_HOST_RE =
		/(?:^|\.)(?:douyin\.com|iesdouyin\.com|xiaohongshu\.com|rednote\.com)$/i;
	const JSON_VIDEO_PATH_RE =
		/(?:\/aweme\/|\/web\/v\d\/|\/api\/sns\/web\/|\/(?:feed|detail|note|collect|favor|item|post))/i;
	const AUTH_PATH_RE = /(?:login|signin|sign_in|passport|oauth|captcha|verify|account|auth|token)/i;
	const SNIFFABLE_BODY_MIMES = new Set([
		'',
		'text/plain',
		'application/octet-stream',
		'application/xml',
		'text/xml',
	]);

	const FEED_NOISE_API_RE =
		/\/(?:related|recommend|homefeed|tab\/feed|web\/tab\/feed|aweme\/post)(?:\/|$)/i;

	function isWhitelistedJsonVideoApi(rawUrl) {
		const pageHost = String(location?.hostname || '').replace(/^www\./, '');
		if (!JSON_VIDEO_HOST_RE.test(pageHost)) return false;
		try {
			const pageUrl = new URL(location.href);
			const pagePath = pageUrl.pathname || '/';
			if (/(?:^|\.)(?:douyin\.com|iesdouyin\.com)$/i.test(pageHost)) {
				const onSingleVideo =
					/^\/(?:share\/)?video\/\d+/i.test(pagePath) ||
					/^\d{10,25}$/.test(pageUrl.searchParams.get('modal_id') || '');
				if (!onSingleVideo) return false;
			}
			if (/(?:^|\.)(?:xiaohongshu\.com|rednote\.com)$/i.test(pageHost)) {
				const onSingleNote =
					/^\/(?:explore|discovery\/item|user\/profile\/[a-f\d]+|board\/[\w-]+)\/[a-f\d]{24}/i.test(
						pagePath,
					);
				if (!onSingleNote) return false;
			}
			const u = new URL(rawUrl, location.href);
			if (!JSON_VIDEO_HOST_RE.test(u.hostname)) return false;
			if (AUTH_PATH_RE.test(u.pathname)) return false;
			if (FEED_NOISE_API_RE.test(u.pathname)) return false;
			return JSON_VIDEO_PATH_RE.test(u.pathname);
		} catch {
			return false;
		}
	}

	function extractJsonVideos(text) {
		if (!text || text.length > 2 * 1024 * 1024) return;
		const host = location.hostname.replace(/^www\./, '');
		if (!JSON_VIDEO_HOST_RE.test(host)) return;
		if (!text.includes('url_list') && !text.includes('masterUrl')) return;
		try {
			const data = JSON.parse(text);
			const stack = [{node: data, title: '', poster: ''}];
			let steps = 0;
			while (stack.length && steps++ < 4000) {
				const frame = stack.pop();
				const node = frame.node;
				if (!node || typeof node !== 'object') continue;
				if (Array.isArray(node)) {
					for (let i = 0; i < node.length && i < 200; i++) {
						stack.push({node: node[i], title: frame.title, poster: frame.poster});
					}
					continue;
				}
				const title =
					(typeof node.title === 'string' && node.title.trim()) ||
					(typeof node.displayTitle === 'string' && node.displayTitle.trim()) ||
					(typeof node.desc === 'string' && node.desc.trim().slice(0, 80)) ||
					frame.title;
				const poster =
					node.cover?.urlDefault ||
					node.cover?.url_default ||
					node.cover?.urlPre ||
					node.cover?.url_list?.[0] ||
					node.origin_cover?.url_list?.[0] ||
					node.image_list?.[0]?.url_default ||
					node.imageList?.[0]?.urlDefault ||
					frame.poster;
				if (typeof node.masterUrl === 'string') {
					record(node.masterUrl, {
						type: 'video',
						title,
						poster,
						width: Number(node.width) || 0,
						height: Number(node.height) || 0,
					});
				}
				if (node.play_addr && Array.isArray(node.play_addr.url_list)) {
					const u = node.play_addr.url_list.find(
						(v) => typeof v === 'string' && v.startsWith('http'),
					);
					if (u) {
						record(u, {
							type: 'video',
							title,
							poster,
							width: Number(node.play_addr.width) || 0,
							height: Number(node.play_addr.height) || 0,
						});
					}
				}
				for (const v of Object.values(node)) {
					if (v && typeof v === 'object') stack.push({node: v, title, poster});
				}
			}
		} catch {}
	}

	function scanXDom() {
		if (!X_HOST_RE.test(String(location?.hostname || ''))) return;
		try {
			const articles = document.querySelectorAll?.('article[data-testid="tweet"]') || [];
			for (const article of articles) {
				const posterCandidates = [];
				const videoEl = article.querySelector?.('video');
				if (videoEl) {
					const p = videoEl.poster || videoEl.getAttribute?.('poster') || '';
					if (p) posterCandidates.push(p);
				}
				const imgs =
					article.querySelectorAll?.(
						'img[src*="_video_thumb/"], [data-testid="videoPlayer"] img[src*="pbs.twimg.com"], [data-testid="videoComponent"] img[src*="pbs.twimg.com"]',
					) || [];
				for (const img of imgs) {
					const src = img.src || img.getAttribute?.('src') || '';
					if (src) posterCandidates.push(src);
				}
				let videoId = '';
				let poster = '';
				for (const cand of posterCandidates) {
					const m = TWIMG_THUMB_ID_RE.exec(cand);
					if (m) {
						videoId = m[1];
						poster = cand.replace(/^http:\/\//i, 'https://');
						break;
					}
				}
				if (!videoId) continue;

				const userEl = article.querySelector?.('[data-testid="User-Name"]');
				const rawUser = String(userEl?.textContent || '')
					.split(/\n|·/)[0]
					.replace(/\s+/g, ' ')
					.trim();
				const author = rawUser.slice(0, 40);
				const textEl = article.querySelector?.('[data-testid="tweetText"]');
				const tweetText = String(textEl?.textContent || '')
					.replace(/\s+/g, ' ')
					.trim();
				let statusUrl = '';
				const timeLink = article.querySelector?.('a[href*="/status/"] time')?.closest?.('a');
				const statusLink = timeLink || article.querySelector?.('a[href*="/status/"]');
				if (statusLink) {
					try {
						const u = new URL(statusLink.getAttribute('href'), location.origin);
						statusUrl = u.origin + u.pathname;
					} catch {}
				}
				let title = '';
				if (author && tweetText) title = `${author}：${tweetText.slice(0, 72)}`;
				else if (tweetText) title = tweetText.slice(0, 88);
				else if (author) title = `${author} 的视频`;

				const duration = Number(videoEl?.duration) || 0;
				const width = Number(videoEl?.videoWidth) || 0;
				const height = Number(videoEl?.videoHeight) || 0;
				xMetaByVideoId.set(videoId, {
					title,
					poster,
					pageUrl: statusUrl || location.href,
					duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : 0,
					width: Number.isFinite(width) && width > 0 ? Math.round(width) : 0,
					height: Number.isFinite(height) && height > 0 ? Math.round(height) : 0,
				});
			}
			// Backfill already-recorded twimg items with freshly matched tweet metadata.
			for (const [key, item] of store.entries()) {
				const enriched = enrichFromXMeta(item);
				if (enriched !== item) store.set(key, enriched);
			}
		} catch {}
	}

	function checkRouteChange() {
		if (!isTop) return;
		const next = routeKey(location?.href || '');
		if (next && next !== currentRoute) {
			currentRoute = next;
			clearAll();
		}
	}

	function clearAll() {
		store.clear();
		subPlaylistUrls.clear();
		try {
			perfWatermark = (performance.getEntriesByType('resource') || []).length;
		} catch {
			perfWatermark = 0;
		}
	}

	// Track SPA navigations so stale media from previous routes does not linger.
	if (isTop && typeof history === 'object' && history) {
		for (const fn of ['pushState', 'replaceState']) {
			if (typeof history[fn] === 'function') {
				const orig = history[fn].bind(history);
				history[fn] = function (...args) {
					const ret = orig(...args);
					checkRouteChange();
					return ret;
				};
			}
		}
		window.addEventListener('popstate', checkRouteChange);
	}

	// 1. Cross-iframe receiver on top frame
	if (isTop) {
		window.addEventListener('message', (event) => {
			const data = event?.data;
			if (data && data.__fetchyMedia === true && data.item && typeof data.item.url === 'string') {
				mergeItem(data.item);
			}
		});
	}

	// 2. PerformanceObserver for network resources
	function scanPerformance() {
		try {
			const entries = performance.getEntriesByType('resource') || [];
			for (let i = perfWatermark; i < entries.length; i++) {
				const entry = entries[i];
				if (typeof entry?.name === 'string') {
					const type = classify(entry.name);
					if (type)
						record(entry.name, {type, size: entry.transferSize || entry.decodedBodySize || 0});
				}
			}
		} catch {}
	}
	try {
		const po = new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) {
				if (typeof entry?.name === 'string') {
					const type = classify(entry.name);
					if (type)
						record(entry.name, {type, size: entry.transferSize || entry.decodedBodySize || 0});
				}
			}
		});
		po.observe({type: 'resource', buffered: true});
	} catch {}

	// 3. Hook fetch()
	if (typeof window.fetch === 'function') {
		const origFetch = window.fetch;
		window.fetch = function (...args) {
			const reqUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
			return origFetch.apply(this, args).then((res) => {
				try {
					const url = res.url || reqUrl;
					const mime = res.headers?.get('content-type') || '';
					const size = Number(res.headers?.get('content-length') || 0) || 0;
					const baseMime = mime.split(';')[0].trim().toLowerCase();
					const direct = classify(url, mime);
					if (direct === 'hls') {
						const norm = normalizeMediaUrl(url);
						if (!shouldIgnore(norm)) {
							if (res.ok && (size === 0 || size <= 512 * 1024)) {
								res
									.clone()
									.text()
									.then((body) => {
										const info = inspectHlsBody(norm, body);
										if (info.isMedia && subPlaylistUrls.has(norm)) return;
										record(norm, {
											type: 'hls',
											mime,
											isMaster: info.isMaster,
											isSubPlaylist: info.isMedia && !info.isMaster,
											width: info.width,
											height: info.height,
										});
									})
									.catch(() => {
										record(norm, {type: 'hls', mime});
									});
							} else {
								record(norm, {type: 'hls', mime});
							}
						}
					} else if (direct) {
						record(url, {type: direct, mime, size});
					} else if (res.ok && baseMime.includes('json')) {
						if (isWhitelistedJsonVideoApi(url) && (size === 0 || size <= 2 * 1024 * 1024)) {
							res
								.clone()
								.text()
								.then(extractJsonVideos)
								.catch(() => {});
						}
					} else if (
						res.ok &&
						size > 0 &&
						size <= 1024 * 1024 &&
						SNIFFABLE_BODY_MIMES.has(baseMime)
					) {
						res
							.clone()
							.text()
							.then((body) => {
								const head = body.slice(0, 512);
								const detected = classify(url, mime, head);
								if (detected === 'hls') {
									const norm = normalizeMediaUrl(url);
									const info = inspectHlsBody(norm, body);
									if (info.isMedia && subPlaylistUrls.has(norm)) return;
									record(norm, {
										type: 'hls',
										mime,
										isMaster: info.isMaster,
										isSubPlaylist: info.isMedia && !info.isMaster,
										width: info.width,
										height: info.height,
									});
								} else if (detected) {
									record(url, {type: detected, mime, size});
								}
							})
							.catch(() => {});
					}
				} catch {}
				return res;
			});
		};
	}

	// 4. Hook XMLHttpRequest
	if (typeof XMLHttpRequest !== 'undefined') {
		const origOpen = XMLHttpRequest.prototype.open;
		const origSend = XMLHttpRequest.prototype.send;
		XMLHttpRequest.prototype.open = function (method, url, ...rest) {
			this.__fetchyUrl = typeof url === 'string' ? url : String(url || '');
			return origOpen.call(this, method, url, ...rest);
		};
		XMLHttpRequest.prototype.send = function (...args) {
			this.addEventListener(
				'load',
				function () {
					try {
						const url = this.responseURL || this.__fetchyUrl || '';
						const mime = this.getResponseHeader('content-type') || '';
						const size = Number(this.getResponseHeader('content-length') || 0) || 0;
						let head = '';
						let textBody = '';
						if (!this.responseType || this.responseType === 'text') {
							if (typeof this.responseText === 'string') {
								textBody = this.responseText;
								head = textBody.slice(0, 512);
								if (mime.includes('json') && isWhitelistedJsonVideoApi(url))
									extractJsonVideos(textBody);
							}
						}
						const type = classify(url, mime, head);
						if (type === 'hls') {
							const norm = normalizeMediaUrl(url);
							if (!shouldIgnore(norm)) {
								const info = textBody
									? inspectHlsBody(norm, textBody)
									: {isMaster: false, isMedia: false, width: 0, height: 0};
								if (info.isMedia && subPlaylistUrls.has(norm)) return;
								record(norm, {
									type: 'hls',
									mime,
									isMaster: info.isMaster,
									isSubPlaylist: info.isMedia && !info.isMaster,
									width: info.width,
									height: info.height,
								});
							}
						} else if (type) {
							record(url, {type, mime, size});
						}
					} catch {}
				},
				{once: true},
			);
			return origSend.apply(this, args);
		};
	}

	// 5. DOM <video> / <audio> / <source> monitoring & periodic scan
	function inspectMediaElement(el) {
		if (!el || typeof el !== 'object') return;
		const tag = String(el.tagName || '').toLowerCase();
		const kind = tag === 'audio' ? 'audio' : 'video';
		const srcs = [el.currentSrc, el.src, el.getAttribute?.('src')].filter(Boolean);
		for (const src of srcs) {
			const url = normalizeMediaUrl(src);
			if (!url) continue;
			const type = classify(url) || kind;
			record(url, {
				type,
				poster: el.poster || el.getAttribute?.('poster') || '',
				duration: Number(el.duration) || 0,
				width: Number(el.videoWidth) || 0,
				height: Number(el.videoHeight) || 0,
			});
		}
		if (typeof el.querySelectorAll === 'function') {
			for (const s of el.querySelectorAll('source[src]')) {
				const src = s.getAttribute('src');
				if (src) record(src, {type: classify(src, s.getAttribute('type') || '') || kind});
			}
		}
	}

	function scanDom() {
		try {
			scanXDom();
			for (const el of document.querySelectorAll('video, audio')) inspectMediaElement(el);
			for (const s of document.querySelectorAll('source[src]')) {
				const src = s.getAttribute('src');
				const mime = s.getAttribute('type') || '';
				if (src) record(src, {type: classify(src, mime) || 'video', mime});
			}
		} catch {}
	}

	for (const evt of ['play', 'playing', 'loadedmetadata']) {
		document.addEventListener(
			evt,
			(e) => {
				if (e.target && /^(?:VIDEO|AUDIO)$/i.test(e.target.tagName || '')) {
					inspectMediaElement(e.target);
				}
			},
			true,
		);
	}

	setInterval(() => {
		checkRouteChange();
		scanDom();
	}, 2000);

	window.__fetchySniffer = {
		scan() {
			checkRouteChange();
			scanPerformance();
			scanDom();
		},
		list() {
			checkRouteChange();
			scanDom();
			scanPerformance();
			const rank = {hls: 4, dash: 3, video: 2, audio: 1};
			return [...store.values()]
				.filter((item) => !subPlaylistUrls.has(item.url))
				.sort(
					(a, b) =>
						(rank[b.type] || 0) - (rank[a.type] || 0) ||
						(b.isMaster ? 1 : 0) - (a.isMaster ? 1 : 0) ||
						b.size - a.size ||
						b.ts - a.ts,
				);
		},
		clear() {
			clearAll();
		},
		add(url, meta) {
			record(url, meta);
		},
	};
}
