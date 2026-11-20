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

	function shouldIgnore(url) {
		if (!url) return true;
		if (AD_RE.test(url)) return true;
		if (SEGMENT_RE.test(url)) return true;
		if (CHUNK_RE.test(url)) return true;
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
		const item = {
			url,
			type,
			title: meta.title || pageTitle() || filenameFromUrl(url),
			poster,
			mime: String(meta.mime || '')
				.split(';')[0]
				.trim()
				.toLowerCase(),
			size: Number.isFinite(meta.size) && meta.size > 0 ? Math.round(meta.size) : 0,
			duration: Number.isFinite(meta.duration) && meta.duration > 0 ? Math.round(meta.duration) : 0,
			width: Number.isFinite(meta.width) && meta.width > 0 ? Math.round(meta.width) : 0,
			height: Number.isFinite(meta.height) && meta.height > 0 ? Math.round(meta.height) : 0,
			host,
			pageUrl: location.href,
			ts: Date.now(),
		};
		if (!isTop) {
			try {
				window.top.postMessage({__fetchyMedia: true, item}, '*');
			} catch {}
			return;
		}
		mergeItem(item);
	}

	function mergeItem(item) {
		if (!item?.url || shouldIgnore(item.url)) return;
		const prev = store.get(item.url);
		if (prev) {
			store.set(item.url, {
				...prev,
				type: prev.type === 'hls' || prev.type === 'dash' ? prev.type : item.type || prev.type,
				title: prev.title || item.title,
				poster: prev.poster || item.poster || '',
				mime: prev.mime || item.mime,
				size: Math.max(prev.size || 0, item.size || 0),
				duration: Math.max(prev.duration || 0, item.duration || 0),
				width: Math.max(prev.width || 0, item.width || 0),
				height: Math.max(prev.height || 0, item.height || 0),
				ts: item.ts || prev.ts,
			});
			return;
		}
		if (store.size >= MAX_ITEMS) {
			const oldest = store.keys().next().value;
			if (oldest) store.delete(oldest);
		}
		store.set(item.url, item);
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

	function isWhitelistedJsonVideoApi(rawUrl) {
		const pageHost = String(location?.hostname || '').replace(/^www\./, '');
		if (!JSON_VIDEO_HOST_RE.test(pageHost)) return false;
		try {
			const u = new URL(rawUrl, location.href);
			if (!JSON_VIDEO_HOST_RE.test(u.hostname)) return false;
			if (AUTH_PATH_RE.test(u.pathname)) return false;
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
			for (const entry of entries) {
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
					if (direct) {
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
								if (detected) record(url, {type: detected, mime, size});
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
						if (!this.responseType || this.responseType === 'text') {
							if (typeof this.responseText === 'string') {
								head = this.responseText.slice(0, 512);
								if (mime.includes('json') && isWhitelistedJsonVideoApi(url))
									extractJsonVideos(this.responseText);
							}
						}
						const type = classify(url, mime, head);
						if (type) record(url, {type, mime, size});
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
		scanDom();
	}, 2000);

	window.__fetchySniffer = {
		scan() {
			scanPerformance();
			scanDom();
		},
		list() {
			scanPerformance();
			scanDom();
			const rank = {hls: 4, dash: 3, video: 2, audio: 1};
			return [...store.values()].sort(
				(a, b) => (rank[b.type] || 0) - (rank[a.type] || 0) || b.size - a.size || b.ts - a.ts,
			);
		},
		clear() {
			store.clear();
		},
		add(url, meta) {
			record(url, meta);
		},
	};
}
