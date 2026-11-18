// This function is injected into the current document. Keep every dependency inside its body.
export function captureArchivePage(allowLoopback = false) {
	const url = new URL(location.href);
	const unsupported = (reason) => ({type: 'unsupported', reason});
	const testOrigin =
		allowLoopback === true &&
		url.protocol === 'http:' &&
		['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
			? url.origin
			: null;
	if ((!testOrigin && (url.protocol !== 'https:' || url.port)) || url.username || url.password)
		return unsupported('unsupported_page');
	const isHost = (host, domain) => host === domain || host.endsWith('.' + domain);
	const xhs = ['www.xiaohongshu.com', 'xiaohongshu.com'].includes(url.hostname);
	const x = ['www.x.com', 'x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname);
	const zhihu = ['zhuanlan.zhihu.com', 'www.zhihu.com', 'zhihu.com'].includes(url.hostname);
	const query = (el, selector) => el?.querySelector(selector);
	const all = (el, selector) => Array.from(el?.querySelectorAll(selector) || []);
	const txt = (el) => (el?.innerText || el?.textContent || '').trim();
	function clean(href) {
		try {
			const u = new URL(href, url);
			if (
				(u.origin !== testOrigin && (u.protocol !== 'https:' || u.port)) ||
				u.username ||
				u.password
			)
				return null;
			u.hash = '';
			return u;
		} catch {
			return null;
		}
	}
	function imgUrl(raw, domains) {
		if (typeof raw !== 'string' || !raw) return null;
		const u = clean(raw.replace(/^http:\/\//i, 'https://'));
		return u && domains.some((d) => isHost(u.hostname, d)) ? u.href : null;
	}
	function media(kind, raw, domains, alt = '') {
		const inline =
			typeof raw === 'string' &&
			raw.length <= 3 * 1024 * 1024 &&
			/^data:((?:image\/(?:jpeg|png|gif|webp|avif)|video\/(?:mp4|webm)));base64,([A-Za-z0-9+/]+=*)$/.exec(
				raw,
			);
		if (inline && inline[1].startsWith(kind + '/'))
			return {kind, mimeType: inline[1], data: inline[2], alt};
		const src = imgUrl(raw, domains);
		return src ? {kind, url: src, alt} : {kind, missing: true, alt};
	}
	function collectDomMedia(root, selector, domains) {
		const result = [],
			seen = new Set();
		for (const n of all(root, selector)) {
			if (
				n.closest(
					'aside,nav,footer,[aria-hidden="true"],[data-testid="quoteTweet"],[data-testid="UserAvatar-Container"]',
				)
			)
				continue;
			if (n.tagName === 'IMG' && n.closest('video')) continue;
			const kind = n.tagName === 'VIDEO' ? 'video' : 'image';
			const src =
				n.currentSrc ||
				n.getAttribute('src') ||
				query(n, 'source[src]')?.src ||
				n.getAttribute('data-original') ||
				n.getAttribute('data-src');
			const a = media(kind, src, domains, n.getAttribute('alt') || '');
			if (a.url && seen.has(a.url)) continue;
			if (a.url) seen.add(a.url);
			result.push(a);
		}
		return result;
	}
	function xId(href) {
		const u = clean(href);
		return u && ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(u.hostname)
			? /^\/(?:[\w]{1,15}|i\/web)\/status\/(\d+)\/?$/.exec(u.pathname)?.[1]
			: null;
	}
	function xhsId(href) {
		const u = clean(href);
		return u && ['xiaohongshu.com', 'www.xiaohongshu.com'].includes(u.hostname)
			? /^\/(?:explore|discovery\/item|board\/[\w-]+|user\/profile\/[a-f0-9]+)\/([a-f0-9]{24})\/?$/i.exec(
					u.pathname,
				)?.[1]
			: null;
	}
	function rawPost(platform, id, src, title = '', author = '') {
		return {
			platform,
			id,
			sourceUrl: src,
			title,
			author,
			body: '',
			bodyFormat: 'text',
			bodyComplete: false,
			attachments: [],
		};
	}
	function dedup(entries) {
		return [...new Map(entries.map((v) => [v.platform + ':' + v.id, v])).values()];
	}
	function markdown(root) {
		function line(n) {
			if (n.nodeType === 3) return n.textContent || '';
			if (
				n.nodeType !== 1 ||
				n.matches(
					'script,style,aside,nav,footer,figure,button,form,[hidden],[aria-hidden="true"],.comments,.CommentTopbar,[data-testid="tweet"]',
				)
			)
				return '';
			const tag = n.tagName;
			if (tag === 'BR') return '\n';
			const content = Array.from(n.childNodes).map(line).join('');
			if (tag === 'A') {
				const href = clean(n.href);
				return href ? '[' + content.trim() + '](' + href.href + ')' : content;
			}
			if (/^H[1-6]$/.test(tag))
				return '\n\n' + '#'.repeat(Number(tag[1])) + ' ' + content.trim() + '\n\n';
			if (['P', 'DIV', 'LI', 'BLOCKQUOTE', 'SECTION', 'PRE'].includes(tag))
				return '\n' + content.trim() + '\n';
			return content;
		}
		return Array.from(root.childNodes)
			.map(line)
			.join('')
			.replace(/\n{3,}/g, '\n\n')
			.trim();
	}
	function isTruncated(root) {
		if (
			query(
				root,
				'[data-testid="tweet-text-show-more-link"],[data-testid="paywall"],.RichContent--unescapable,.ContentItem-expandButton,.paywall',
			)
		)
			return true;
		return all(root, 'button,a[role=button]').some((el) =>
			/^(?:show more|read more|展开全文|展开阅读全文|阅读剩余全文|显示更多)$/i.test(txt(el)),
		);
	}
	function folderResult(folder, entries, total, root) {
		let nextUrl = null;
		const next = query(root, 'a[rel="next"]');
		const dest = next && clean(next.href);
		if (dest?.origin === url.origin && dest.href !== url.href) nextUrl = dest.href;
		const items = dedup(entries);
		const end = all(
			root,
			'.end-container,.end-text,[data-testid="endOfList"],[role="status"]',
		).some((el) =>
			/^(?:-?\s*THE END\s*-?|没有更多了|已显示全部|没有更多内容|No more (?:results|posts|items))$/i.test(
				txt(el),
			),
		);
		return {
			type: 'collection',
			folder,
			items,
			total,
			nextUrl,
			complete: !nextUrl && (end || (total !== null && items.length === total)),
		};
	}
	if (xhs) {
		const id = xhsId(url.href);
		if (id) {
			const canonical = 'https://www.xiaohongshu.com/explore/' + id;
			const note = window.__INITIAL_STATE__?.note?.noteDetailMap?.[id]?.note;
			if (!note || note.noteId !== id) return unsupported('source_not_ready');
			const entry = rawPost(
				'xiaohongshu',
				id,
				canonical,
				String(note.title || ''),
				String(note.user?.nickname || ''),
			);
			entry.body = typeof note.desc === 'string' ? note.desc : '';
			entry.bodyComplete = typeof note.desc === 'string';
			const domains = ['xhscdn.com', 'xhsimg.com', 'xiaohongshu.com'];
			if (note.type === 'video') {
				const streams = Object.values(note.video?.media?.stream || {})
					.flat()
					.filter((v) => v?.masterUrl);
				streams.sort(
					(a, b) => Number(b.width) * Number(b.height) - Number(a.width) * Number(a.height),
				);
				entry.attachments = [media('video', streams[0]?.masterUrl, domains)];
			} else {
				if (!Array.isArray(note.imageList)) entry.missing = ['image list'];
				for (const img of note.imageList || []) {
					const original =
						img.urlDefault || img.url || img.infoList?.find((x) => x.imageScene === 'WB_DFT')?.url;
					entry.attachments.push(media('image', original, domains));
					if (img.livePhoto || img.livePhotoUrl)
						entry.attachments.push(media('video', img.livePhotoUrl || img.videoUrl, domains));
				}
			}
			return {type: 'post', entry};
		}
		function noteCards(panel) {
			const entries = [];
			for (const item of all(panel, '.note-item')) {
				const links = all(item, 'a[href]');
				const canonical = links.find(
					(a) => clean(a.href)?.pathname.startsWith('/explore/') && xhsId(a.href),
				);
				const cover = query(item, 'a.cover[href]') || links.find((a) => xhsId(a.href));
				const id = xhsId(canonical?.href || cover?.href);
				if (!id) continue;
				const visitUrl = cover && xhsId(cover.href) === id ? cover.href : canonical.href;
				entries.push({
					...rawPost(
						'xiaohongshu',
						id,
						'https://www.xiaohongshu.com/explore/' + id,
						txt(query(item, '.title')),
					),
					visitUrl,
				});
			}
			return entries;
		}
		const board = /^\/board\/([\w-]+)\/?$/.exec(url.pathname)?.[1];
		if (board) {
			const seen = noteCards(document);
			const count = txt(query(document, '.board-info .note-count,.note-count')).match(
				/[\d,]+/,
			)?.[0];
			const name =
				txt(query(document, '.board-info .name,.board-info .board-name,.board-info .title,h1')) ||
				document.title;
			return folderResult(
				{platform: 'xiaohongshu', id: board, name},
				seen,
				count ? Number(count.replaceAll(',', '')) : null,
				document,
			);
		}
		if (/^\/user\/profile\/[a-f\d]+\/?$/i.test(url.pathname)) {
			const active = all(document, '.reds-tab-item.active').map(txt);
			if (!active.some((label) => /^收藏(?:$|[·・•\s])/.test(label)))
				return unsupported('unsupported_page');
			const notesTab = active.find((label) => /^笔记(?:$|[·・•\s])/.test(label));
			if (notesTab) {
				const width = window.innerWidth;
				const panels = all(document, '.tab-content-item')
					.map((panel) => {
						const box = panel.getBoundingClientRect();
						return {
							panel,
							overlap: Math.max(0, Math.min(width, box.right) - Math.max(0, box.left)),
						};
					})
					.sort((a, b) => b.overlap - a.overlap);
				if (
					!panels[0] ||
					panels[0].overlap <= width / 2 ||
					panels[0].overlap === panels[1]?.overlap
				)
					return unsupported('source_not_ready');
				const scope = query(panels[0].panel, '.feeds-container');
				if (!scope) return unsupported('source_not_ready');
				const count = /^笔记\s*[·・•]?\s*([\d,]+)$/.exec(notesTab)?.[1];
				return folderResult(
					{platform: 'xiaohongshu', id: 'saved-' + url.pathname.split('/')[3], name: '收藏笔记'},
					noteCards(scope),
					count ? Number(count.replaceAll(',', '')) : null,
					scope,
				);
			}
			if (!active.some((label) => /^专辑(?:$|[·・•\s])/.test(label)))
				return unsupported('unsupported_page');
			const boards = [];
			for (const a of all(document, 'a.board-card[href]')) {
				const u = clean(a.href);
				const id = u?.origin === url.origin && /^\/board\/([\w-]+)\/?$/.exec(u.pathname)?.[1];
				if (!id) continue;
				boards.push({
					platform: 'xiaohongshu',
					id,
					name: txt(query(a, '.title')) || txt(a),
					url: u.origin + u.pathname,
				});
			}
			const expected = /专辑\s*[·・•]?\s*([\d,]+)/.exec(active.join(' '))?.[1];
			const total = expected ? Number(expected.replaceAll(',', '')) : null;
			const folders = dedup(boards);
			if (folders.length || total === 0)
				return {type: 'folders', folders, total, complete: total === folders.length};
		}
		return unsupported('unsupported_page');
	}
	if (x) {
		const bookmark = /^\/i\/bookmarks(?:\/(\d+))?\/?$/.exec(url.pathname);
		const primary = query(document, '[data-testid="primaryColumn"]') || query(document, 'main');
		if (bookmark && primary) {
			const entries = [];
			for (const tweet of all(primary, 'article[data-testid="tweet"]')) {
				const a = query(tweet, 'time')?.closest('a[href]');
				const id = a && xId(a.href);
				if (id)
					entries.push({
						...rawPost(
							'x',
							id,
							new URL(a.href).origin + new URL(a.href).pathname,
							txt(query(tweet, '[data-testid="tweetText"]')).slice(0, 160),
						),
						visitUrl: a.href,
					});
			}
			const folders = all(primary, 'a[href]')
				.map((a) => {
					const u = clean(a.href),
						id = u?.origin === url.origin && /^\/i\/bookmarks\/(\d+)\/?$/.exec(u.pathname)?.[1];
					return id ? {id, name: txt(a), platform: 'x', url: u.origin + u.pathname} : null;
				})
				.filter(Boolean);
			return {
				...folderResult(
					{
						platform: 'x',
						id: bookmark[1] || 'bookmarks',
						name: txt(query(primary, 'h1,h2')) || 'Bookmarks',
					},
					entries,
					null,
					primary,
				),
				folders: dedup(folders),
			};
		}
		const id = xId(url.href);
		if (!id || !primary) return unsupported('unsupported_page');
		const tweet = all(primary, 'article[data-testid="tweet"]').find(
			(el) => xId(query(el, 'time')?.closest('a[href]')?.href) === id,
		);
		if (!tweet) return unsupported('source_not_ready');
		const article = query(
			tweet,
			'[data-testid="twitterArticleRichTextView"],[data-testid="longformRichTextComponent"]',
		);
		const body = query(tweet, '[data-testid="tweetText"]');
		const entry = rawPost(
			'x',
			id,
			url.origin + url.pathname,
			txt(query(article, 'h1')) || txt(body).slice(0, 100),
			txt(query(tweet, '[data-testid="User-Name"]')),
		);
		entry.body = article ? markdown(article) : txt(body);
		entry.bodyFormat = article ? 'markdown' : 'text';
		entry.bodyComplete = Boolean(article || body) && !isTruncated(tweet);
		entry.attachments = collectDomMedia(
			article || tweet,
			'[data-testid="tweetPhoto"] img,video,figure img',
			['pbs.twimg.com', 'video.twimg.com'],
		);
		return {type: 'post', entry};
	}
	if (url.hostname === 'space.bilibili.com' && /^\/\d+\/favlist\/?$/.test(url.pathname)) {
		const ownerId = url.pathname.split('/')[1],
			id = url.searchParams.get('fid');
		if (id && /^\d+$/.test(id))
			return {
				type: 'collection',
				provider: 'bilibili',
				folder: {platform: 'bilibili', id, name: document.title},
				items: [],
				total: null,
				complete: false,
			};
		return {type: 'folders', provider: 'bilibili', ownerId, folders: [], complete: false};
	}
	if (['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(url.hostname)) {
		if (url.pathname === '/playlist' && /^[\w-]{2,128}$/.test(url.searchParams.get('list') || '')) {
			const list = url.searchParams.get('list');
			const items = [];
			for (const tile of all(
				document,
				'ytd-playlist-video-renderer,ytd-playlist-panel-video-renderer',
			)) {
				const a = query(tile, 'a#video-title[href],a[href*="watch?"]'),
					u = a && clean(a.href);
				const id = u?.origin === url.origin && u.searchParams.get('v');
				if (!/^[\w-]{11}$/.test(id || '')) continue;
				items.push({
					...rawPost('youtube', id, 'https://www.youtube.com/watch?v=' + id, txt(a)),
					kind: 'video',
				});
			}
			const root = query(document, 'ytd-playlist-header-renderer,yt-page-header-renderer');
			const total = txt(root).match(/([\d,]+)\s*(?:videos?\b|个视频)/i)?.[1];
			return folderResult(
				{platform: 'youtube', id: list, name: txt(query(root, 'h1,#title')) || document.title},
				items,
				total ? Number(total.replaceAll(',', '')) : null,
				document,
			);
		}
		if (url.pathname === '/feed/playlists') {
			const dirs = all(document, 'main a[href*="playlist?"],ytd-browse a[href*="playlist?"]')
				.map((a) => {
					const u = clean(a.href),
						id = u?.origin === url.origin && u.searchParams.get('list');
					return id
						? {
								platform: 'youtube',
								id,
								name: a.title || txt(a) || id,
								url: url.origin + '/playlist?list=' + encodeURIComponent(id),
							}
						: null;
				})
				.filter(Boolean);
			return {type: 'folders', folders: dedup(dirs), complete: false};
		}
	}
	if (zhihu && /^\/collection\/\d+\/?$/.test(url.pathname)) {
		const id = url.pathname.split('/')[2],
			entries = [];
		for (const a of all(
			document,
			'main .ContentItem-title a[href],.CollectionDetailPageItem-inner a[href]',
		)) {
			const u = clean(a.href);
			if (!u || !['www.zhihu.com', 'zhuanlan.zhihu.com'].includes(u.hostname)) continue;
			const id = /(?:\/answer\/|\/p\/)(\d+)\/?$/.exec(u.pathname)?.[1];
			if (id)
				entries.push({...rawPost('zhihu', id, u.origin + u.pathname, txt(a)), visitUrl: u.href});
		}
		return folderResult(
			{platform: 'zhihu', id, name: txt(query(document, 'h1')) || document.title},
			entries,
			null,
			document,
		);
	}
	if (
		['instagram.com', 'threads.com', 'threads.net', 'kuaishou.com'].includes(
			url.hostname.replace(/^www\./, ''),
		)
	)
		return unsupported('unsupported_page');
	const article = zhihu
		? query(
				document,
				'.Post-RichTextContainer .RichText,.Post-RichText,.RichContent-inner .RichText,.RichContent-inner',
			) || query(document, 'article')
		: query(document, 'article[itemprop="articleBody"],article,main [itemprop="articleBody"]');
	if (
		!article ||
		['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName) ||
		query(article, 'input[type="password"]')
	)
		return unsupported('unsupported_page');
	const title = txt(query(article, 'h1') || query(document, 'h1'));
	if (!title) return unsupported('source_not_ready');
	const canonical = clean(query(document, 'link[rel="canonical"]')?.href || url.href);
	if (!canonical || canonical.origin !== url.origin) return unsupported('identity_mismatch');
	const ids = new URLSearchParams();
	for (const name of ['id', 'p', 'v', 'bvid', 'fid', 'modal_id']) {
		const val = canonical.searchParams.get(name);
		if (val && /^[\w-]{1,128}$/.test(val)) ids.set(name, val);
	}
	if (
		canonical.search &&
		!ids.size &&
		!query(document, 'link[rel="canonical"]') &&
		!canonical.pathname.split('/').at(-1)
	)
		return unsupported('identity_mismatch');
	canonical.search = ids.toString();
	const source = canonical.href;
	const id = zhihu ? /(?:\/answer\/|\/p\/)(\d+)\/?$/.exec(canonical.pathname)?.[1] : source;
	if (!id || id.length > 256) return unsupported('unsupported_page');
	const entry = rawPost(
		zhihu ? 'zhihu' : 'web',
		id,
		source,
		title,
		txt(query(article, '[rel="author"],[itemprop="author"]')) ||
			query(document, 'meta[name="author"]')?.content ||
			'',
	);
	entry.body = markdown(article);
	entry.bodyFormat = 'markdown';
	entry.bodyComplete = Boolean(entry.body) && !isTruncated(article.parentElement || article);
	entry.attachments = collectDomMedia(
		article,
		'img,video',
		zhihu ? ['zhimg.com', 'zhihu.com'] : [url.hostname],
	);
	return {type: 'post', entry};
}

export function advanceArchivePage(fromTop = false) {
	const width = window.innerWidth;
	const panels = Array.from(document.querySelectorAll('.tab-content-item'))
		.map((panel) => {
			const r = panel.getBoundingClientRect();
			return {panel, overlap: Math.min(width, r.right) - Math.max(0, r.left)};
		})
		.sort((a, b) => b.overlap - a.overlap);
	const root = panels[0]?.overlap > width / 2 ? panels[0].panel : document;
	let scrolling = document.scrollingElement || document.documentElement;
	for (
		let parent =
			root.querySelector(
				'.feeds-container,.note-item,[data-testid="primaryColumn"],ytd-playlist-video-list-renderer',
			) || root;
		parent && parent.nodeType === 1;
		parent = parent.parentElement
	) {
		if (
			parent.scrollHeight > parent.clientHeight + 2 &&
			parent.clientHeight > 0 &&
			/^(?:scroll|auto|overlay)$/.test(getComputedStyle(parent).overflowY)
		) {
			scrolling = parent;
			break;
		}
	}
	const before = scrolling.scrollTop,
		viewport = Math.min(window.innerHeight, scrolling.clientHeight || window.innerHeight);
	scrolling.scrollTo({
		top: fromTop ? 0 : before + Math.max(1, Math.floor(viewport * 0.8)),
		behavior: 'instant',
	});
	return {before, position: scrolling.scrollTop, height: scrolling.scrollHeight, viewport};
}

// Bilibili's authorized browser session stays inside its own HTTPS page.
export async function readBilibiliCollectionPage(folderId, page = 1, ownerId = null) {
	if (
		location.protocol !== 'https:' ||
		location.hostname !== 'space.bilibili.com' ||
		!/^\/\d+\/favlist\/?$/.test(location.pathname)
	)
		return {error: 'identity_mismatch'};
	const params = new URLSearchParams();
	let path;
	if (ownerId !== null) {
		if (String(ownerId) !== location.pathname.split('/')[1]) return {error: 'identity_mismatch'};
		path = '/x/v3/fav/folder/created/list-all';
		params.set('up_mid', ownerId);
	} else {
		if (!/^\d{1,18}$/.test(folderId) || !Number.isSafeInteger(page) || page < 1)
			return {error: 'invalid_request'};
		path = '/x/v3/fav/resource/list';
		params.set('media_id', folderId);
		params.set('ps', '20');
		params.set('pn', String(page));
		params.set('platform', 'web');
	}
	try {
		const res = await fetch('https://api.bilibili.com' + path + '?' + params, {
			credentials: 'include',
			redirect: 'error',
			signal: AbortSignal.timeout(15000),
		});
		if (!res.ok) return {error: 'access_restricted'};
		const data = await res.json();
		if (data.code !== 0 || !data.data) return {error: 'access_restricted'};
		const d = data.data;
		if (ownerId !== null) {
			const folders = (d.list || []).map((f) => ({
				platform: 'bilibili',
				id: String(f.id),
				name: f.title,
				url: location.origin + location.pathname + '?fid=' + f.id,
			}));
			return {type: 'folders', folders, complete: folders.length === d.count};
		}
		if (String(d.info?.id) !== String(folderId) || typeof d.has_more !== 'boolean')
			return {error: 'invalid_page'};
		const items = (d.medias || []).map((m) => {
			const id = typeof m.bvid === 'string' && /^BV[\w]{10}$/.test(m.bvid) ? m.bvid : 'av' + m.id;
			return {
				platform: 'bilibili',
				id,
				title: m.title,
				author: m.upper?.name || '',
				kind: 'video',
				sourceUrl: 'https://www.bilibili.com/video/' + id + '/',
				savedAt: m.fav_time ? new Date(m.fav_time * 1000).toISOString() : null,
				...(m.type === 2 ? {} : {coverage: 'unavailable_resource'}),
			};
		});
		return {
			type: 'collection',
			folder: {platform: 'bilibili', id: String(folderId), name: d.info.title},
			items,
			total: Number.isSafeInteger(d.info.media_count) ? d.info.media_count : null,
			nextPage: d.has_more ? page + 1 : null,
			complete: !d.has_more,
		};
	} catch {
		return {error: 'network_error'};
	}
}

// Run in the original document. Only fetch files that belong to this precise post.
export async function hydrateArchiveEntry(entry, byteBudget = 24 * 1024 * 1024) {
	if (!entry || !Array.isArray(entry.attachments) || !entry.attachments.some((a) => a.url))
		return entry;
	const current = new URL(location.href);
	let source;
	try {
		source = new URL(entry.sourceUrl);
	} catch {
		return entry;
	}
	if (current.protocol !== 'https:' || source.protocol !== 'https:') return entry;
	const domains = {
		xiaohongshu: ['xhscdn.com', 'xhsimg.com', 'xiaohongshu.com'],
		x: ['pbs.twimg.com', 'video.twimg.com'],
		zhihu: ['zhimg.com', 'zhihu.com'],
	};
	const listed = new Set();
	const add = (raw) => {
		try {
			const u = new URL(raw, current);
			if (u.protocol === 'http:') u.protocol = 'https:';
			listed.add(u.href);
		} catch {}
	};
	let root;
	if (entry.platform === 'xiaohongshu') {
		if (
			!['xiaohongshu.com', 'www.xiaohongshu.com'].includes(current.hostname) ||
			current.pathname.split('/').filter(Boolean).at(-1) !== entry.id ||
			source.href !== 'https://www.xiaohongshu.com/explore/' + entry.id
		)
			return entry;
		const note = window.__INITIAL_STATE__?.note?.noteDetailMap?.[entry.id]?.note;
		if (note?.noteId !== entry.id) return entry;
		for (const im of note.imageList || [])
			for (const raw of [
				im.urlDefault,
				im.url,
				im.livePhotoUrl,
				im.videoUrl,
				...(im.infoList || []).filter((v) => v.imageScene === 'WB_DFT').map((v) => v.url),
			])
				if (raw) add(raw);
		for (const v of Object.values(note.video?.media?.stream || {}).flat())
			if (v.masterUrl) add(v.masterUrl);
	} else {
		if (current.origin !== source.origin || current.pathname !== source.pathname) return entry;
		if (entry.platform === 'x') {
			if (
				!['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(current.hostname) ||
				!current.pathname.endsWith('/status/' + entry.id)
			)
				return entry;
			root = [...document.querySelectorAll('article[data-testid="tweet"]')].find((el) => {
				try {
					return new URL(el.querySelector('time')?.closest('a')?.href).pathname === source.pathname;
				} catch {
					return false;
				}
			});
		} else root = document.querySelector('.Post-RichText,article,[itemprop="articleBody"]');
		if (!root) return entry;
		for (const el of root.querySelectorAll('img,video,video source'))
			for (const raw of [el.currentSrc, el.src, el.dataset.original, el.dataset.src])
				if (raw) add(raw);
	}
	let budget = Math.min(
		24 * 1024 * 1024,
		Math.max(0, Number.isSafeInteger(byteBudget) ? byteBudget : 0),
	);
	const result = [];
	for (const a of entry.attachments) {
		const inlineBytes = typeof a.data === 'string' ? Math.ceil((a.data.length * 3) / 4) : 0;
		budget = Math.max(0, budget - inlineBytes);
		if (!a.url || !listed.has(a.url) || budget === 0) {
			result.push(a);
			continue;
		}
		let hydrated = a;
		try {
			const u = new URL(a.url);
			const hosts = domains[entry.platform] || [current.hostname];
			if (
				u.protocol !== 'https:' ||
				u.username ||
				u.password ||
				u.port ||
				!hosts.some((h) => u.hostname === h || u.hostname.endsWith('.' + h))
			) {
				result.push(a);
				continue;
			}
			const limit = Math.min(budget, 16 * 1024 * 1024);
			const response = await fetch(u.href, {
				mode: 'cors',
				credentials: u.origin === current.origin ? 'same-origin' : 'omit',
				redirect: 'error',
				signal: AbortSignal.timeout(18000),
			});
			const mimeType = (response.headers.get('content-type') || '')
				.split(';')[0]
				.trim()
				.toLowerCase();
			if (
				!response.ok ||
				!/^(?:image\/(?:png|jpeg|gif|webp|avif)|video\/(?:mp4|webm))$/.test(mimeType) ||
				!mimeType.startsWith(a.kind + '/') ||
				Number(response.headers.get('content-length')) > limit ||
				!response.body
			) {
				await response.body?.cancel();
				result.push(a);
				continue;
			}
			const reader = response.body.getReader(),
				parts = [];
			let length = 0;
			while (true) {
				const {done, value} = await reader.read();
				if (done) break;
				length += value.byteLength;
				if (length > limit) {
					await reader.cancel();
					break;
				}
				parts.push(value);
			}
			if (length && length <= limit) {
				const blob = new Blob(parts, {type: mimeType});
				const encoded = await new Promise((resolve, reject) => {
					const reader = new FileReader();
					reader.onload = () => resolve(String(reader.result).split(',')[1]);
					reader.onerror = reject;
					reader.readAsDataURL(blob);
				});
				hydrated = {kind: a.kind, alt: a.alt || '', mimeType, data: encoded};
				budget -= length;
			}
		} catch {
			/* The native importer can still try a public source URL. */
		}
		result.push(hydrated);
	}
	return {...entry, attachments: result};
}

// The user requests this list from one open document. Read only visible media
// sources and the browser's existing resource timing entries for that document.
export function discoverArchiveMedia() {
	const page = new URL(location.href);
	if (page.protocol !== 'https:' || page.username || page.password || page.port) return {items: []};
	const items = new Map();
	function add(raw, video = false) {
		if (!raw || items.size >= 60) return;
		let u;
		try {
			u = new URL(raw, page);
		} catch {
			return;
		}
		if (
			u.protocol !== 'https:' ||
			u.username ||
			u.password ||
			u.port ||
			u.href.length > 16384 ||
			items.has(u.href)
		)
			return;
		const ext = u.pathname.match(/\.(mp4|m4v|mov|webm|mkv|m3u8|mpd)$/i)?.[1]?.toLowerCase();
		if (!ext && !video) return;
		const type = ext === 'm3u8' ? 'HLS' : ext === 'mpd' ? 'DASH' : '视频';
		items.set(u.href, {url: u.href, type, host: u.hostname});
	}
	for (const n of document.querySelectorAll('video')) {
		const r = n.getBoundingClientRect();
		if (r.width && r.height)
			add(n.currentSrc || n.getAttribute('src') || n.querySelector('source[src]')?.src, true);
	}
	for (const r of performance.getEntriesByType('resource')) {
		if (['video', 'audio', 'fetch', 'xmlhttprequest'].includes(r.initiatorType)) add(r.name);
	}
	return {page: page.origin + page.pathname, items: [...items.values()]};
}
