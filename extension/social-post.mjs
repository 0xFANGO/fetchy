// Runs in the saved post's page. Use the original post permalink to choose one
// article on feeds that render replies or recommendations in the same document.
export function captureSocialPost() {
	const url = new URL(location.href);
	const unavailable = (reason) => ({type: 'unsupported', reason});
	if (url.protocol !== 'https:' || url.port || url.username || url.password)
		return unavailable('unsupported_page');
	const site = (u) => {
		const host = u.hostname.replace(/^www\./, '');
		return host === 'threads.net' ? 'threads.com' : host;
	};
	const host = site(url);
	const text = (node) => (node?.innerText || node?.textContent || '').trim();
	const meta = (name) => document.querySelector('meta[property="' + name + '"]')?.content || '';
	const parse = (u) => {
		if (!u || u.protocol !== 'https:' || u.port || u.username || u.password || site(u) !== host)
			return null;
		if (host === 'threads.com') {
			const m = /^\/@([\w.]+)\/post\/([\w-]+)\/?$/.exec(u.pathname);
			if (m) return {platform: 'threads', author: m[1], id: m[2]};
		}
		if (host === 'instagram.com') {
			const m = /^\/(?:[\w.]+\/)?(?:p|reels?)\/([\w-]+)\/?$/.exec(u.pathname);
			if (m) return {platform: 'instagram', id: m[1]};
		}
		if (host === 'kuaishou.com') {
			const m = /^\/(?:short-video|f)\/([a-zA-Z0-9_-]+)\/?$/.exec(u.pathname);
			if (m) return {platform: 'kuaishou', id: m[1]};
		}
		return null;
	};
	const identity = parse(url);
	if (!identity) return unavailable('unsupported_page');
	const canonical = document.querySelector('link[rel=canonical]')?.href || meta('og:url');
	if (canonical) {
		let linked;
		try {
			linked = new URL(canonical, url);
		} catch {
			return unavailable('identity_mismatch');
		}
		if (parse(linked)?.id !== identity.id) return unavailable('identity_mismatch');
	}
	const matchLink = (el) =>
		[...el.querySelectorAll('a[href]')].some(
			(a) => parse(new URL(a.href, url))?.id === identity.id,
		);
	const candidates = [
		...document.querySelectorAll('article,[role=article],[data-pressable-container=true]'),
	];
	const post =
		candidates.find(
			(el) =>
				matchLink(el) &&
				![...el.querySelectorAll('article,[role=article],[data-pressable-container=true]')].some(
					matchLink,
				),
		) ||
		(candidates.length === 1 && canonical && candidates[0]);
	const description = meta('og:description');
	let root = post,
		bodyNode;
	if (identity.platform === 'kuaishou') {
		root = document.querySelector('main .video-detail,.short-video-detail,.video-detail') || post;
		bodyNode = root?.querySelector('[class*="caption"],[class*="description"],h1');
	} else if (root) bodyNode = root.querySelector('[data-testid=post-text],h1[dir=auto],h1');
	if (!bodyNode && root && description && identity.platform === 'threads') {
		// Match the rendered caption against the publisher's description; usernames and counters also use dir=auto.
		const spans = [...root.querySelectorAll('span[dir=auto]')].filter(
			(el) =>
				!el.closest('header,footer,button,time') &&
				text(el).length >= 3 &&
				(description.includes(text(el)) ||
					(text(el).length >= 40 && description.includes(text(el).slice(0, 40)))),
		);
		bodyNode = spans.sort((a, b) => text(b).length - text(a).length)[0];
	}
	if (!root && !description && !meta('og:video')) return unavailable('source_not_ready');
	const body = text(bodyNode) || description;
	const allowed =
		identity.platform === 'kuaishou'
			? ['kuaishou.com', 'kwai.net', 'kwaicdn.com', 'yximgs.com', 'gifshow.com']
			: ['cdninstagram.com', 'fbcdn.net', 'instagram.com', 'threads.com'];
	function mediaUrl(raw) {
		try {
			const source = new URL(raw, url);
			if (!raw || source.protocol !== 'https:' || source.port || source.username || source.password)
				return null;
			return allowed.some(
				(domain) => source.hostname === domain || source.hostname.endsWith('.' + domain),
			)
				? source.href
				: null;
		} catch {
			return null;
		}
	}
	const seen = new Set(),
		attachments = [];
	function add(kind, src, alt = '') {
		const safe = mediaUrl(src);
		if (safe && seen.has(safe)) return;
		if (safe) seen.add(safe);
		attachments.push(safe ? {kind, url: safe, alt} : {kind, missing: true, alt});
	}
	if (root)
		for (const el of root.querySelectorAll('img,video')) {
			// A poster can be an accessibility-hidden sibling of a nested video player.
			if (identity.platform === 'threads' && el.tagName === 'IMG') {
				const videos = el.parentElement?.querySelectorAll('video');
				if (videos?.length === 1 && el.parentElement.querySelectorAll('img').length === 1) {
					const preview = el.getBoundingClientRect(),
						movie = videos[0].getBoundingClientRect();
					if (
						el.getAttribute('aria-hidden') === 'true' ||
						(preview.width > 0 &&
							Math.abs(preview.x - movie.x) < 2 &&
							Math.abs(preview.y - movie.y) < 2 &&
							Math.abs(preview.width - movie.width) < 2)
					)
						continue;
				}
			}
			if (
				el.closest('header,nav,aside,footer,a[role=link][href^="/@"]') ||
				(el.closest('[aria-hidden=true]') &&
					el.getBoundingClientRect().width === 0 &&
					el.getBoundingClientRect().height === 0) ||
				(el.closest('article,[role=article]') &&
					post?.matches('article,[role=article]') &&
					el.closest('article,[role=article]') !== post)
			)
				continue;
			if (
				el.tagName === 'IMG' &&
				(/(?:profile (?:picture|photo)|avatar|头像)/i.test(el.alt) ||
					(el.naturalWidth && el.naturalWidth < 120))
			)
				continue;
			add(
				el.tagName === 'IMG' ? 'image' : 'video',
				el.currentSrc || el.getAttribute('src') || el.querySelector('source')?.src,
				el.alt || '',
			);
		}
	if (!attachments.length && meta('og:video')) add('video', meta('og:video'));
	const missing = [];
	if (!bodyNode || !body || /(?:show more|read more|展开全文|展开更多)/i.test(text(root)))
		missing.push('full text');
	if (
		!root ||
		root.querySelector(
			'[aria-label="Next"],[aria-label="下一张"],[aria-roledescription="carousel"]',
		) ||
		attachments.some((a) => a.kind === 'image')
	)
		missing.push('original attachment count and quality unconfirmed');
	if (!body && !attachments.length) return unavailable('source_not_ready');
	return {
		type: 'post',
		entry: {
			...identity,
			sourceUrl: url.origin + url.pathname,
			title: text(bodyNode)?.split('\n')[0]?.slice(0, 160) || meta('og:title'),
			body,
			bodyFormat: 'text',
			bodyComplete: !!bodyNode && !!body && !missing.includes('full text'),
			attachments,
			missing,
		},
	};
}
