// This function is serialized into the active tab. Only read its rendered collection controls.
export function captureSocialCollection() {
	const page = new URL(location.href);
	const unsupported = (reason = 'unsupported_page') => ({type: 'unsupported', reason});
	if (page.protocol !== 'https:' || page.port || page.username || page.password)
		return unsupported();
	const host = page.hostname.replace(/^www\./, '');
	const platform = {
		'instagram.com': 'instagram',
		'threads.com': 'threads',
		'threads.net': 'threads',
		'douyin.com': 'douyin',
		'tiktok.com': 'tiktok',
	}[host];
	if (!platform) return unsupported();
	const path = page.pathname.replace(/\/$/, '');
	const text = (e) => (e?.innerText || e?.textContent || '').trim();
	const visible = (e) =>
		!!e &&
		!e.closest('[hidden],[inert],[aria-hidden="true"]') &&
		(typeof e.checkVisibility !== 'function' || e.checkVisibility());
	const list = (root, selector) =>
		Array.from(root?.querySelectorAll(selector) ?? []).filter(visible);
	const unique = (values) => [...new Map(values.filter(Boolean).map((x) => [x.id, x])).values()];
	function sameSite(href) {
		try {
			const u = new URL(href, page);
			return u.origin === page.origin && !u.username && !u.password ? u : null;
		} catch {
			return null;
		}
	}
	function safeLink(el) {
		const u = sameSite(el.href);
		return u &&
			!el.closest(
				'nav,aside,footer,[role="navigation"],[aria-label*="recommend" i],[aria-label*="suggested" i],[aria-label*="推荐"],[aria-label*="推薦"],[data-e2e*="recommend"],[data-testid*="recommend"]',
			)
			? u
			: null;
	}
	const roots =
		'section,main,[role=main],[role=region],[role=grid],[role=list],[role=feed],[role=tabpanel]';
	function label(el) {
		return (
			el.getAttribute('aria-label') ||
			text(document.getElementById(el.getAttribute('aria-labelledby'))) ||
			''
		).trim();
	}
	function region(expected) {
		const eq = (t) => expected.some((n) => n && n.toLowerCase() === t.toLowerCase());
		const matches = list(document, roots).filter((e) => eq(label(e)));
		// A heading and its containing section can identify a grid that lacks an aria-label.
		for (const heading of list(document, 'h1,h2,[role=heading]')) {
			if (!eq(text(heading))) continue;
			const area = heading.closest(roots);
			if (area && !matches.includes(area)) matches.push(area);
		}
		const inner = matches.filter((e) => !matches.some((other) => other !== e && e.contains(other)));
		if (inner.length !== 1) return null;
		const area = inner[0];
		// A second section or feed heading can designate recommendations within the same view.
		if (list(area, 'h1,h2,h3,[role=heading]').some((h) => !eq(text(h)))) return null;
		return area;
	}
	function coverage(area, emptyLabels, count, folders) {
		const status = list(area, '[role=status]').filter(
			(el) => !el.closest('a,article,li,[role=article]'),
		);
		const pattern = folders
			? /^(\d+) saved collections?$/i
			: /^(\d+) saved (?:posts?|videos?|items?)$/i;
		const reported = new Set(
			status
				.map((el) => pattern.exec(text(el))?.[1])
				.filter(Boolean)
				.map(Number)
				.filter(Number.isSafeInteger),
		);
		if (reported.size === 1) {
			const [total] = reported;
			return {total, complete: total === count};
		}
		const empty =
			!count &&
			!list(area, 'a[href]').length &&
			(emptyLabels.includes(text(area)) || status.some((el) => emptyLabels.includes(text(el))));
		return {total: empty ? 0 : null, complete: empty};
	}
	function folder(id, name, u) {
		return {platform, id, name, url: u.origin + u.pathname};
	}
	function members(f, root, emptyLabels) {
		if (
			!root ||
			list(document, 'form input[type=password],[role=dialog] input[type=password]').length
		)
			return unsupported('source_not_ready');
		const items = [];
		let anchors = list(root, 'a[href]');
		if (platform === 'threads') {
			// Only the card's own timestamp identifies a saved post. A quote has its own nested card.
			const cards = list(root, 'article,[role=article],[data-pressable-container=true]');
			anchors = cards
				.filter((c) => !cards.some((parent) => parent !== c && parent.contains(c)))
				.flatMap((c) => {
					const links = list(c, 'a[href]').filter(
						(a) =>
							a.closest('article,[role=article],[data-pressable-container=true]') === c &&
							a.querySelector('time'),
					);
					return links.slice(0, 1);
				});
		}
		for (const a of anchors) {
			const u = safeLink(a);
			if (!u) continue;
			let id,
				canonical,
				kind = 'post';
			if (platform === 'instagram') {
				const m = /^\/(?:[\w.]+\/)?(p|reels?)\/([\w-]+)\/?$/.exec(u.pathname);
				if (m) {
					id = m[2];
					const type = m[1] === 'p' ? 'p' : 'reel';
					canonical = '/' + type + '/' + id + '/';
					if (type === 'reel') kind = 'video';
				}
			} else if (platform === 'threads') {
				const m = /^\/@([\w.]+)\/post\/([\w-]+)\/?$/.exec(u.pathname);
				if (m) {
					id = m[2];
					canonical = '/@' + m[1] + '/post/' + id;
				}
			} else if (platform === 'tiktok') {
				const m = /^\/@([\w.]+)\/(video|photo)\/(\d+)\/?$/.exec(u.pathname);
				if (m) {
					id = m[3];
					canonical = '/@' + m[1] + '/' + m[2] + '/' + id;
					if (m[2] === 'video') kind = 'video';
				}
			} else {
				const m = /^\/(video|note)\/(\d+)\/?$/.exec(u.pathname);
				if (m) {
					id = m[2];
					canonical = '/' + m[1] + '/' + id;
					if (m[1] === 'video') kind = 'video';
				}
			}
			if (!id) continue;
			const sourceUrl = u.origin + canonical;
			const img =
				a.querySelector('img') || a.closest('article,li,[role=article]')?.querySelector('img');
			const rawCover = img?.currentSrc || img?.getAttribute('src') || '';
			const cover = /^https?:\/\//i.test(rawCover)
				? rawCover.replace(/^http:\/\//i, 'https://')
				: '';
			items.push({
				platform,
				id,
				sourceUrl,
				visitUrl: sourceUrl,
				kind,
				...(cover ? {cover} : {}),
				title: (a.getAttribute('aria-label') || text(a) || img?.alt || '').slice(0, 256),
				bodyComplete: false,
			});
		}
		const entries = unique(items);
		return {
			type: 'collection',
			folder: f,
			items: entries,
			...coverage(root, emptyLabels, entries.length, false),
			nextUrl: null,
		};
	}
	function directories(root, parse, emptyLabels) {
		if (
			!root ||
			list(document, 'form input[type=password],[role=dialog] input[type=password]').length
		)
			return unsupported('source_not_ready');
		const folders = unique(
			list(root, 'a[href]').map((a) => {
				const u = safeLink(a);
				return u && parse(u, a);
			}),
		);
		return {type: 'folders', folders, ...coverage(root, emptyLabels, folders.length, true)};
	}
	const selected = (names) =>
		list(document, '[role=tab][aria-selected=true]').find((el) => names.includes(text(el)));
	function panel(tab) {
		const el = tab && document.getElementById(tab.getAttribute('aria-controls'));
		return visible(el) && el.getAttribute('role') === 'tabpanel' ? el : null;
	}
	const favorites = ['Favorites', 'Favourites', '收藏', '已收藏', '收藏夹', '收藏夾'];
	const saved = ['Saved', '已保存', '珍藏', '收藏', '已收藏'];
	if (platform === 'instagram') {
		const m = /^\/([\w.]+)\/saved(?:\/([^/]+)(?:\/(\d+))?)?$/.exec(path);
		if (!m) return unsupported();
		const owner = m[1].toLowerCase();
		function instagramFolder(u, a) {
			const match = /^\/([\w.]+)\/saved\/([^/]+)(?:\/(\d+))?\/?$/.exec(u.pathname);
			if (!match || match[1].toLowerCase() !== owner || (!match[3] && match[2] !== 'all-posts'))
				return null;
			return folder(match[3] || owner + '/all-posts', text(a) || match[2], u);
		}
		if (!m[2]) {
			const main = list(document, 'main,[role=main]')[0];
			const result = directories(main, instagramFolder, ['No saved collections', '暂无收藏集']);
			return result.folders?.length || result.complete ? result : unsupported('source_not_ready');
		}
		if (!m[3] && m[2] !== 'all-posts') return unsupported();
		let name;
		try {
			name = decodeURIComponent(m[2]).replace(/[-_]+/g, ' ');
		} catch {
			return unsupported();
		}
		const all = m[2] === 'all-posts';
		const root = region(all ? [...saved, 'All Posts', '所有帖子', '全部帖子', '所有貼文'] : [name]);
		return members(folder(m[3] || owner + '/all-posts', name, page), root, [
			'No saved posts',
			'暂无收藏的帖子',
			'尚无收藏',
		]);
	}
	if (platform === 'threads') {
		if (path !== '/saved') return unsupported();
		// The Saved URL is shared by every account. Bind it to the self-profile navigation link.
		const own = list(document, 'nav a[href],[role=navigation] a[href]').filter((a) =>
			['Profile', '个人主页', '個人檔案', '个人资料'].includes(
				label(a) || label(a.querySelector('[aria-label]') || a),
			),
		);
		const actors = new Set(
			own
				.map((a) => /^\/@([\w.]+)\/?$/.exec(sameSite(a.href)?.pathname || '')?.[1])
				.filter(Boolean),
		);
		if (actors.size !== 1) return unsupported('source_not_ready');
		return members(folder([...actors][0].toLowerCase() + '/saved', 'Saved', page), region(saved), [
			'No saved posts',
			'暂无已保存的帖子',
			'尚無已儲存的串文',
		]);
	}
	if (platform === 'tiktok') {
		const named = /^\/@([\w.]+)\/collection\/([^/]+)-(\d+)$/.exec(path);
		if (named) {
			let name;
			try {
				name = decodeURIComponent(named[2]).replace(/[-_]+/g, ' ');
			} catch {
				return unsupported();
			}
			return members(folder(named[3], name, page), region([name]), ['No videos yet', '暂无视频']);
		}
		const profile = /^\/@([\w.]+)$/.exec(path),
			tab = selected(favorites);
		if (!profile || !tab) return unsupported();
		const root = panel(tab) || list(document, '[data-e2e="user-favorite-item-list"]')[0];
		return members(folder(profile[1].toLowerCase() + '/favorites', 'Favorites', page), root, [
			'No favorites yet',
			'暂无收藏',
		]);
	}
	const mix = /^\/(?:collection|mix)\/(\d+)$/.exec(path);
	if (mix)
		return members(
			folder('mix/' + mix[1], document.title, page),
			region(['合集', '合集作品', '播放列表']),
			['暂无作品', '暂无视频'],
		);
	if (
		path !== '/user/self' ||
		page.searchParams.has('modal_id') ||
		(page.searchParams.has('showTab') && page.searchParams.get('showTab') !== 'favorite_collection')
	)
		return unsupported();
	const top = selected(['收藏']);
	const categories = list(document, '[role=tablist]').filter((group) => {
		const names = list(group, '[role=tab]')
			.filter((tab) => tab.closest('[role=tablist]') === group)
			.map(text);
		return (
			names.includes('合集') &&
			names.includes('收藏夹') &&
			(names.includes('视频') || names.includes('作品'))
		);
	});
	const section =
		categories.length === 1 &&
		list(categories[0], '[role=tab][aria-selected=true]').find(
			(tab) => tab.closest('[role=tablist]') === categories[0],
		);
	if (!top || !section || panel(top)?.getAttribute('data-e2e') !== 'user-favorite-tab')
		return unsupported('source_not_ready');
	const own = sameSite(document.querySelector('link[rel=canonical]')?.href);
	const id = /^\/user\/(MS4wLjAB[\w-]+)\/?$/.exec(own?.pathname || '')?.[1];
	const mode = text(section);
	if (!['视频', '作品', '合集', '收藏夹'].includes(mode)) return unsupported();
	// Douyin renders the content next to its nested tab switcher, outside the empty ARIA tabpanel.
	const wrapper = section.closest('[role=tablist]')?.parentElement?.parentElement;
	const outlet =
		wrapper?.children.length === 2 &&
		!wrapper.children[1].contains(section) &&
		!wrapper.children[1].querySelector('[role=tablist]')
			? wrapper.children[1]
			: null;
	const root = visible(outlet) ? outlet : panel(section);
	if (mode === '收藏夹' || mode === '合集') {
		return directories(
			root,
			(u, a) => {
				if (mode !== '合集') return null; // Personal folder tiles need their own stable, navigable URL.
				const m = /^\/(?:collection|mix)\/(\d+)\/?$/.exec(u.pathname);
				return m && folder('mix/' + m[1], text(a) || m[1], u);
			},
			mode === '收藏夹' ? ['暂无收藏夹', '还没有收藏夹'] : ['暂无收藏合集', '暂无收藏的合集'],
		);
	}
	if (!id) return unsupported('source_not_ready');
	const confirmed = list(document, '[data-e2e="user-favorite-list"]');
	const active = confirmed.length === 1 ? confirmed[0] : panel(section);
	return members(
		{
			...folder(id + '/favorites', '收藏的视频', page),
			url: page.origin + '/user/self?showTab=favorite_collection',
		},
		active,
		['暂无收藏', '暂无收藏的视频', '还没有收藏作品'],
	);
}
