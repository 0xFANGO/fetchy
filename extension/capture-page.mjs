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
	const xhsHosts = ['xiaohongshu.com', 'www.xiaohongshu.com', 'rednote.com', 'www.rednote.com'];
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
		if (!u) return null;
		if (domains.some((d) => isHost(u.hostname, d))) return u.href;
		if (
			xhsHosts.includes(url.hostname) &&
			['sns-web-i10.rednotecdn.com', 'sns-v8.rednotecdn.com', 'sns-v8-ae.rednotecdn.com'].includes(
				u.hostname,
			)
		)
			return u.href;
		return null;
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
		return u && xhsHosts.includes(u.hostname)
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
	function viewportBox(el) {
		const vh = (typeof window !== 'undefined' && window.innerHeight) || 900;
		const rect =
			typeof el?.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
		if (!rect) return {top: 0, left: 0, overlap: 200};
		const top = Math.max(0, rect.top);
		const bottom = Math.min(vh, rect.bottom);
		return {top: rect.top, left: rect.left || 0, overlap: bottom - top};
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
	if (xhsHosts.includes(url.hostname)) {
		const id = xhsId(url.href);
		if (id) {
			const canonical = url.origin + '/explore/' + id;
			const doc = globalThis.document;
			const app =
				doc?.querySelector?.('[data-v-app]')?.__vue_app__ ??
				doc?.querySelector?.('#app')?.__vue_app__;
			const unwrap = (value) => (value?.__v_isRef === true ? value.value : value);
			const read = (store) => {
				const map = unwrap(unwrap(store)?.noteDetailMap);
				return unwrap(unwrap(map?.[id])?.note);
			};
			const live = app?.config?.globalProperties?.$pinia?.state?.value?.note;
			const note = read(live) ?? read(globalThis.window?.__INITIAL_STATE__?.note);
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
		function normalizeXhsVisit(rawHref, id) {
			try {
				const u = new URL(rawHref, url);
				const next = new URL('/explore/' + id, u.origin);
				for (const key of ['xsec_token', 'xsec_source']) {
					if (u.searchParams.has(key)) next.searchParams.set(key, u.searchParams.get(key));
				}
				return next.href;
			} catch {
				return url.origin + '/explore/' + id;
			}
		}
		function noteCards(panel) {
			const entries = [];
			for (const item of all(panel, '.note-item')) {
				const links = all(item, 'a[href]');
				const canonical = links.find(
					(a) => clean(a.href)?.pathname.startsWith('/explore/') && xhsId(a.href),
				);
				const coverLink = query(item, 'a.cover[href]') || links.find((a) => xhsId(a.href));
				const id = xhsId(canonical?.href || coverLink?.href);
				if (!id) continue;
				const rawVisit =
					coverLink && xhsId(coverLink.href) === id ? coverLink.href : canonical.href;
				const visitUrl = normalizeXhsVisit(rawVisit, id);
				const imgEl = query(item, 'a.cover img, img.cover, img');
				const rawCover = imgEl?.currentSrc || imgEl?.getAttribute('src') || '';
				const cover = /^https?:\/\//i.test(rawCover)
					? rawCover.replace(/^http:\/\//i, 'https://')
					: '';
				const title =
					txt(query(item, '.title, .footer .title, a.title')) ||
					(imgEl?.getAttribute('alt') || '').trim();
				const author = txt(query(item, '.author .name, .author-wrapper .name, .name'));
				const isVideo = Boolean(query(item, '.play-icon, [class*="play-icon"], svg.play-icon'));
				entries.push({
					...rawPost(
						'xiaohongshu',
						id,
						new URL(visitUrl, url).origin + '/explore/' + id,
						title,
						author,
					),
					visitUrl,
					...(cover ? {cover} : {}),
					mediaHint: isVideo ? 'video' : 'image',
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
			const uid = url.pathname.split('/')[3];
			const active = all(document, '.reds-tab-item.active').map(txt).filter(Boolean);
			const pickActivePanel = () => {
				const width = window.innerWidth;
				const panels = all(document, '.tab-content-item').map((panel) => {
					const box = panel.getBoundingClientRect();
					return {
						panel,
						overlap: Math.max(0, Math.min(width, box.right) - Math.max(0, box.left)),
						height: Number.isFinite(box.height) ? box.height : 100,
					};
				});
				const visible = panels.filter((p) => p.overlap > width / 2 && p.height > 20);
				const ranked = (visible.length ? visible : panels).sort(
					(a, b) => b.overlap - a.overlap || b.height - a.height,
				);
				if (!ranked[0] || ranked[0].overlap <= width / 2) return null;
				if (
					ranked[1] &&
					ranked[0].overlap === ranked[1].overlap &&
					ranked[0].height === ranked[1].height
				)
					return null;
				return ranked[0].panel;
			};
			if (active.some((label) => /^收藏(?:$|[·・•\s])/.test(label))) {
				if (active.some((label) => /^专辑(?:$|[·・•\s])/.test(label))) {
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
					return unsupported('source_not_ready');
				}
				const notesTab = active.find((label) => /^笔记(?:$|[·・•\s])/.test(label));
				if (notesTab) {
					const panel = pickActivePanel();
					if (!panel) return unsupported('source_not_ready');
					const scope = query(panel, '.feeds-container');
					if (!scope) return unsupported('source_not_ready');
					const count = /^笔记\s*[·・•]?\s*([\d,]+)$/.exec(notesTab)?.[1];
					return folderResult(
						{platform: 'xiaohongshu', id: 'saved-' + uid, name: '收藏笔记'},
						noteCards(scope),
						count ? Number(count.replaceAll(',', '')) : null,
						scope,
					);
				}
				return unsupported('unsupported_page');
			}
			const panel = pickActivePanel();
			const scope =
				(panel ? query(panel, '.feeds-container') : null) || query(document, '.feeds-container');
			const seen = scope ? noteCards(scope) : [];
			if (seen.length) {
				const activeLabel = active.join(' · ');
				return folderResult(
					{
						platform: 'xiaohongshu',
						id: 'profile-' + uid + '-' + (activeLabel || 'notes'),
						name: activeLabel || '用户笔记',
					},
					seen,
					null,
					scope,
				);
			}
		}
		if (/^\/(?:explore|search_result)\/?$/i.test(url.pathname)) {
			const scope = query(document, '#exploreFeeds, .feeds-container') || document;
			const visibleItems = all(scope, '.note-item')
				.map((el) => ({el, ...viewportBox(el)}))
				.filter((r) => r.overlap > 40)
				.sort((a, b) => Math.floor(a.top / 60) - Math.floor(b.top / 60) || a.left - b.left)
				.flatMap((r) => noteCards({querySelectorAll: () => [r.el]}));
			const channel = txt(query(document, '.channel.active, .channel-item.active'));
			const isSearch = url.pathname.startsWith('/search_result');
			const label = isSearch ? '小红书搜索' : channel ? '小红书 · ' + channel : '小红书发现';
			if (visibleItems.length || query(document, '#exploreFeeds, .feeds-container')) {
				return {
					type: 'feed',
					platform: 'xiaohongshu',
					folder: {
						platform: 'xiaohongshu',
						id: isSearch ? 'search' : 'explore-' + (url.searchParams.get('channel_id') || 'home'),
						name: label,
					},
					items: dedup(visibleItems),
				};
			}
		}
		return unsupported('unsupported_page');
	}
	if (x) {
		const cleanAuthor = (raw) =>
			String(raw || '')
				.replace(/\s*\n+\s*/g, ' ')
				.replace(/\s*·.*$/, '')
				.replace(/\s+/g, ' ')
				.trim();
		const hasOwnVideo = (tweet) =>
			all(tweet, 'video').some(
				(v) =>
					!v.closest(
						'aside,nav,footer,[aria-hidden="true"],[data-testid="quoteTweet"],div[role="link"]',
					),
			);
		const buildXTweet = (tweet, forcedId, forcedUrl) => {
			const a = query(tweet, 'time')?.closest('a[href]');
			const id = forcedId || (a && xId(a.href));
			if (!id) return null;
			const canonicalUrl =
				forcedUrl ||
				(a
					? new URL(a.href, url.origin).origin + new URL(a.href, url.origin).pathname
					: url.origin + url.pathname);
			const article = query(
				tweet,
				'[data-testid="twitterArticleRichTextView"],[data-testid="longformRichTextComponent"]',
			);
			const body = query(tweet, '[data-testid="tweetText"]');
			const author = cleanAuthor(txt(query(tweet, '[data-testid="User-Name"]')));
			const titleText =
				txt(query(article, 'h1')) ||
				txt(body).replace(/\s+/g, ' ').slice(0, 120) ||
				(author ? `${author} 的帖子` : id);
			const entry = {
				...rawPost('x', id, canonicalUrl, titleText, author),
				visitUrl: a?.href || canonicalUrl,
			};
			entry.body = article ? markdown(article) : txt(body);
			entry.bodyFormat = article ? 'markdown' : 'text';
			entry.bodyComplete = Boolean(article || body) && !isTruncated(tweet);
			entry.attachments = collectDomMedia(
				article || tweet,
				'[data-testid="tweetPhoto"] img,video,figure img',
				['pbs.twimg.com', 'video.twimg.com'],
			);
			const video = hasOwnVideo(tweet);
			const hasImage = entry.attachments.some((m) => m.kind === 'image');
			if (video) {
				entry.kind = 'video';
				entry.mediaHint = 'video';
			} else if (article) {
				entry.kind = 'article';
				entry.mediaHint = 'article';
			} else if (hasImage) {
				entry.mediaHint = 'images';
			} else {
				entry.mediaHint = 'text';
			}
			const xCover =
				entry.attachments.find((m) => m.kind === 'image' && m.url)?.url ||
				query(tweet, 'video')?.getAttribute('poster') ||
				'';
			if (xCover && /^https?:\/\//i.test(xCover)) entry.cover = xCover;
			return entry;
		};
		const bookmark = /^\/i\/bookmarks(?:\/(\d+))?\/?$/.exec(url.pathname);
		const primary = query(document, '[data-testid="primaryColumn"]') || query(document, 'main');
		if (bookmark && primary) {
			const entries = [];
			for (const tweet of all(primary, 'article[data-testid="tweet"]')) {
				const entry = buildXTweet(tweet);
				if (entry) entries.push(entry);
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
		if (id && primary) {
			const tweet = all(primary, 'article[data-testid="tweet"]').find(
				(el) => xId(query(el, 'time')?.closest('a[href]')?.href) === id,
			);
			if (!tweet) return unsupported('source_not_ready');
			const entry = buildXTweet(tweet, id, url.origin + url.pathname);
			return {type: 'post', entry};
		}
		if (primary) {
			const tweets = all(primary, 'article[data-testid="tweet"]');
			if (tweets.length) {
				const vh = (typeof window !== 'undefined' && window.innerHeight) || 900;
				const seenIds = new Set();
				const visibleEntries = tweets
					.map((el) => {
						const rect =
							typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
						if (!rect) return {el, top: 0, overlap: 200};
						const top = Math.max(0, rect.top);
						const bottom = Math.min(vh, rect.bottom);
						return {el, top: rect.top, overlap: bottom - top};
					})
					.filter((r) => r.overlap > 60)
					.sort((a, b) => a.top - b.top)
					.map((r) => buildXTweet(r.el))
					.filter((entry) => {
						if (!entry || seenIds.has(entry.id)) return false;
						seenIds.add(entry.id);
						return true;
					});
				return {
					type: 'feed',
					platform: 'x',
					folder: {platform: 'x', id: 'feed', name: '当前屏幕帖子'},
					items: visibleEntries,
				};
			}
		}
		return unsupported('unsupported_page');
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
	if (['www.bilibili.com', 'bilibili.com', 'm.bilibili.com'].includes(url.hostname)) {
		const vid = /^\/video\/(BV[\w]{10}|av\d+)\/?$/.exec(url.pathname)?.[1];
		if (vid) {
			const rawPage = url.searchParams.get('p');
			const parsedPage = rawPage === null ? 1 : Number(rawPage);
			const page = Number.isSafeInteger(parsedPage) && parsedPage >= 1 ? parsedPage : 1;
			const id = page > 1 ? vid + '_p' + page : vid;
			const sourceUrl =
				'https://www.bilibili.com/video/' + vid + '/' + (page > 1 ? '?p=' + page : '');
			const title =
				txt(query(document, 'h1.video-title, h1[title], .video-title, h1')) ||
				String(document.title || '')
					.replace(/_哔哩哔哩_bilibili$/i, '')
					.trim() ||
				vid;
			const author =
				txt(
					query(document, '.up-name, a.up-name, .up-detail-top .up-name, .up-info--right .name'),
				) ||
				query(document, 'meta[name="author"]')?.content ||
				'';
			const entry = rawPost('bilibili', id, sourceUrl, title, author);
			entry.kind = 'video';
			entry.mediaHint = 'video';
			entry.bodyComplete = true;
			return {type: 'post', entry};
		}
	}
	if (
		['www.youtube.com', 'youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(url.hostname)
	) {
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
				const ytImg = query(tile, 'img')?.src || 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg';
				items.push({
					...rawPost('youtube', id, 'https://www.youtube.com/watch?v=' + id, txt(a)),
					kind: 'video',
					cover: ytImg,
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
		const ytId =
			url.pathname === '/watch'
				? url.searchParams.get('v')
				: /^\/(?:shorts|live|embed)\/([\w-]{11})(?:\/|$)/.exec(url.pathname)?.[1];
		if (/^[\w-]{11}$/.test(ytId || '')) {
			const isShorts = url.pathname.startsWith('/shorts/');
			const rawTitle =
				(isShorts
					? txt(
							query(
								document,
								'ytd-reel-video-renderer[is-active] h2, ytd-reel-player-header-renderer h2, #overlay h2',
							),
						)
					: txt(
							query(
								document,
								'ytd-watch-metadata h1 yt-formatted-string, ytd-watch-metadata h1, #title h1',
							),
						)) ||
				String(document.title || '')
					.replace(/^\(\d+\+?\)\s*/, '')
					.replace(/\s*-\s*YouTube$/i, '')
					.trim() ||
				ytId;
			const author =
				(isShorts
					? txt(
							query(
								document,
								'ytd-reel-video-renderer[is-active] #channel-name a, ytd-reel-video-renderer[is-active] ytd-channel-name a',
							),
						)
					: txt(
							query(
								document,
								'ytd-watch-metadata #channel-name a, ytd-watch-metadata ytd-channel-name a, #owner #channel-name a',
							),
						)) || '';
			const entry = rawPost(
				'youtube',
				ytId,
				'https://www.youtube.com/watch?v=' + ytId,
				rawTitle,
				author,
			);
			entry.kind = 'video';
			entry.mediaHint = 'video';
			entry.bodyComplete = true;
			return {type: 'post', entry};
		}
	}
	if (
		['www.douyin.com', 'douyin.com', 'www.iesdouyin.com', 'iesdouyin.com'].includes(url.hostname)
	) {
		const modalId = url.searchParams.get('modal_id') || '';
		const singleId =
			/^\/(?:share\/)?video\/(\d{10,25})\/?$/.exec(url.pathname)?.[1] ||
			(/^\d{10,25}$/.test(modalId) ? modalId : '');
		if (singleId) {
			const title =
				txt(query(document, '[data-e2e="video-desc"], [data-e2e="detail-video-info"] h1, h1')) ||
				String(document.title || '')
					.replace(/\s*[-–—]\s*抖音.*$/i, '')
					.trim() ||
				singleId;
			const author = txt(
				query(
					document,
					'[data-e2e="video-author-name"], [data-e2e="user-info-nickname"], [data-e2e="feed-video-nickname"], .account-name',
				),
			).replace(/^@/, '');
			const entry = rawPost(
				'douyin',
				singleId,
				'https://www.douyin.com/video/' + singleId,
				title.slice(0, 140),
				author,
			);
			entry.kind = 'video';
			entry.mediaHint = 'video';
			entry.bodyComplete = true;
			return {type: 'post', entry};
		}
		if (/^\/(?:$|jingxuan|follow|friend|discover|hot|search|channel)/i.test(url.pathname)) {
			const feedItems = [];
			const candidates = all(
				document,
				'[data-e2e="feed-active-video"], .swiper-slide-active, [data-e2e-vid], li a[href*="/video/"]',
			);
			const ranked = candidates
				.map((el) => ({el, ...viewportBox(el)}))
				.filter((r) => r.overlap > 60)
				.sort((a, b) => b.overlap - a.overlap || a.top - b.top);
			for (const {el} of ranked) {
				const card = el.tagName === 'A' ? el.closest('li, article, div') || el : el;
				const attrId =
					card.getAttribute?.('data-e2e-vid') || el.getAttribute?.('data-e2e-vid') || '';
				const linkEl = el.tagName === 'A' ? el : query(card, 'a[href*="/video/"]');
				const linkId = linkEl
					? /\/video\/(\d{10,25})(?:\/?|\?|$)/.exec(
							linkEl.getAttribute?.('href') || linkEl.href || '',
						)?.[1]
					: '';
				const vid = /^\d{10,25}$/.test(attrId) ? attrId : linkId;
				if (!vid) continue;
				const title =
					txt(query(card, '[data-e2e="video-desc"], .title, p')) ||
					(query(card, 'img')?.getAttribute?.('alt') || '').trim() ||
					vid;
				const author = txt(
					query(
						card,
						'[data-e2e="feed-video-nickname"], [data-e2e="video-author-name"], .account-name',
					),
				).replace(/^@/, '');
				const entry = rawPost(
					'douyin',
					vid,
					'https://www.douyin.com/video/' + vid,
					title.slice(0, 140),
					author,
				);
				entry.kind = 'video';
				entry.mediaHint = 'video';
				entry.bodyComplete = true;
				feedItems.push(entry);
			}
			return {
				type: 'feed',
				platform: 'douyin',
				folder: {platform: 'douyin', id: 'feed', name: '当前播放视频'},
				items: dedup(feedItems),
			};
		}
	}
	if (['www.tiktok.com', 'tiktok.com'].includes(url.hostname)) {
		const tkMatch = /^\/@([\w.-]+)\/video\/(\d+)\/?$/.exec(url.pathname);
		if (tkMatch) {
			const [, user, vid] = tkMatch;
			const title =
				txt(query(document, '[data-e2e="browse-video-desc"], [data-e2e="video-desc"], h1')) ||
				String(document.title || '')
					.replace(/\s*\|\s*TikTok$/i, '')
					.trim() ||
				vid;
			const author =
				txt(query(document, '[data-e2e="browse-username"], [data-e2e="video-author-uniqueid"]')) ||
				'@' + user;
			const entry = rawPost(
				'tiktok',
				vid,
				'https://www.tiktok.com/@' + user + '/video/' + vid,
				title.slice(0, 140),
				author,
			);
			entry.kind = 'video';
			entry.mediaHint = 'video';
			entry.bodyComplete = true;
			return {type: 'post', entry};
		}
		if (/^\/(?:foryou|following|explore)?\/?$/i.test(url.pathname)) {
			const cards = all(
				document,
				'[data-e2e="recommend-list-item-container"], article, [data-e2e="explore-item"]',
			);
			const feedItems = [];
			for (const {el} of cards
				.map((el) => ({el, ...viewportBox(el)}))
				.filter((r) => r.overlap > 60)
				.sort((a, b) => a.top - b.top)) {
				const link = query(el, 'a[href*="/video/"]');
				const u = link && clean(link.href);
				const m = u && /^\/@([\w.-]+)\/video\/(\d+)\/?$/.exec(u.pathname);
				if (!m) continue;
				const [, user, vid] = m;
				const title =
					txt(query(el, '[data-e2e="video-desc"], h1, h2')) ||
					(query(el, 'img')?.getAttribute?.('alt') || '').trim() ||
					vid;
				const author =
					txt(
						query(el, '[data-e2e="video-author-uniqueid"], [data-e2e="video-author-nickname"]'),
					) || '@' + user;
				const entry = rawPost(
					'tiktok',
					vid,
					'https://www.tiktok.com/@' + user + '/video/' + vid,
					title.slice(0, 140),
					author,
				);
				entry.kind = 'video';
				entry.mediaHint = 'video';
				entry.bodyComplete = true;
				feedItems.push(entry);
			}
			if (feedItems.length || cards.length) {
				return {
					type: 'feed',
					platform: 'tiktok',
					folder: {platform: 'tiktok', id: 'feed', name: '当前屏幕视频'},
					items: dedup(feedItems),
				};
			}
		}
	}
	if (
		zhihu &&
		(/^\/collections\/mine\/?$/.test(url.pathname) ||
			/^\/people\/[^/]+\/collections\/?$/.test(url.pathname))
	) {
		const folders = [];
		for (const a of all(document, 'a[href*="/collection/"]')) {
			const u = safeUrl(a.href);
			const id = u && /^\/collection\/(\d+)\/?$/.exec(u.pathname)?.[1];
			if (!id) continue;
			folders.push({
				platform: 'zhihu',
				id,
				name: txt(a) || '收藏夹 ' + id,
				url: 'https://www.zhihu.com/collection/' + id,
			});
		}
		const uniqueFolders = dedup(folders);
		if (uniqueFolders.length) return {type: 'folders', folders: uniqueFolders};
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
	if (zhihu && /^\/question\/(\d+)\/?$/.test(url.pathname)) {
		const qid = url.pathname.split('/')[2];
		const qTitle =
			txt(query(document, 'h1.QuestionHeader-title, h1')) ||
			String(document.title || '')
				.replace(/\s*[-–—]\s*知乎$/i, '')
				.trim();
		const rawAnswers = [
			...new Set(all(document, '.AnswerItem, [itemprop="zhihu:answer"], .List-item .ContentItem')),
		];
		const visibleAnswers = rawAnswers
			.map((el) => ({el, ...viewportBox(el)}))
			.filter((r) => r.overlap > 60)
			.sort((a, b) => a.top - b.top)
			.map(({el}) => {
				let aid = '';
				const metaUrl = query(el, 'meta[itemprop="url"]')?.getAttribute?.('content') || '';
				aid = /\/answer\/(\d+)/.exec(metaUrl)?.[1] || '';
				if (!aid) {
					const link = query(el, 'a[href*="/answer/"]');
					aid = /\/answer\/(\d+)/.exec(link?.getAttribute?.('href') || link?.href || '')?.[1] || '';
				}
				if (!aid) {
					try {
						const zop = JSON.parse(el.getAttribute?.('data-zop') || '{}');
						if (/^\d+$/.test(String(zop.itemId || ''))) aid = String(zop.itemId);
					} catch {}
				}
				if (!aid) return null;
				const author =
					txt(query(el, '.AuthorInfo-name, [itemprop="author"] [itemprop="name"]')) ||
					query(el, '[itemprop="author"] meta[itemprop="name"]')?.getAttribute?.('content') ||
					'';
				const rich = query(el, '.RichContent-inner .RichText, .RichContent-inner');
				const body = rich ? markdown(rich) : '';
				const attachments = rich
					? collectDomMedia(rich, 'img,video', ['zhimg.com', 'zhihu.com'])
					: [];
				const hasVideo = attachments.some((a) => a.kind === 'video');
				const hasImg = attachments.some((a) => a.kind === 'image');
				const sourceUrl = 'https://www.zhihu.com/question/' + qid + '/answer/' + aid;
				const title = author ? qTitle + ' - ' + author : qTitle || '知乎回答 ' + aid;
				const entry = rawPost('zhihu', aid, sourceUrl, title.slice(0, 140), author);
				entry.visitUrl = sourceUrl;
				entry.body = body;
				entry.bodyFormat = 'markdown';
				entry.bodyComplete = Boolean(body) && !isTruncated(el);
				entry.attachments = attachments;
				entry.mediaHint = hasVideo ? 'video' : hasImg ? 'images' : 'text';
				return entry;
			})
			.filter(Boolean);
		if (visibleAnswers.length || rawAnswers.length) {
			return {
				type: 'feed',
				platform: 'zhihu',
				folder: {platform: 'zhihu', id: 'question-' + qid, name: qTitle || '当前屏幕回答'},
				items: dedup(visibleAnswers),
			};
		}
	}
	const bareHost = url.hostname.replace(/^www\./, '');
	if (['threads.com', 'threads.net'].includes(bareHost)) {
		if (/^\/@[\w.]+\/post\/[\w-]+\/?$/.test(url.pathname)) return unsupported('unsupported_page');
		const cards = all(document, 'article,[role="article"],[data-pressable-container="true"]');
		const topCards = cards.filter(
			(c) => !cards.some((parent) => parent !== c && parent.contains?.(c)),
		);
		const feedItems = topCards
			.map((el) => ({el, ...viewportBox(el)}))
			.filter((r) => r.overlap > 60)
			.sort((a, b) => a.top - b.top)
			.map(({el}) => {
				const links = all(el, 'a[href]');
				const ownLinks = links.filter((a) => {
					const hostCard = a.closest?.(
						'article,[role="article"],[data-pressable-container="true"]',
					);
					return !hostCard || hostCard === el;
				});
				const matchPost = (a) => {
					const u = clean(a.href);
					return u && /^\/@([\w.]+)\/post\/([\w-]+)\/?$/.exec(u.pathname);
				};
				const timeLink = ownLinks.find((a) => query(a, 'time') && matchPost(a));
				const link = timeLink || ownLinks.find(matchPost);
				const m = link && matchPost(link);
				if (!m) return null;
				const [, user, pid] = m;
				const sourceUrl = url.origin + '/@' + user + '/post/' + pid;
				const textNode = query(el, '[data-testid="post-text"]');
				let body = textNode ? txt(textNode) : '';
				if (!body) {
					body = all(el, 'span[dir="auto"]')
						.filter(
							(s) => !s.closest?.('header,footer,button,time,a[href^="/@"]') && txt(s).length >= 3,
						)
						.map(txt)
						.join('\n')
						.trim();
				}
				const rawAttachments = collectDomMedia(el, 'img,video', [
					'cdninstagram.com',
					'fbcdn.net',
					'instagram.com',
					'threads.com',
				]).filter(
					(a) =>
						!(a.kind === 'image' && /(?:profile (?:picture|photo)|avatar|头像)/i.test(a.alt || '')),
				);
				const hasVideo =
					rawAttachments.some((a) => a.kind === 'video') || Boolean(query(el, 'video'));
				const hasImg = rawAttachments.some((a) => a.kind === 'image');
				const firstLine = body.split('\n').find((l) => l.trim()) || '';
				const title = (firstLine || '@' + user + ' 的串文').slice(0, 120);
				const entry = rawPost('threads', pid, sourceUrl, title, '@' + user);
				entry.visitUrl = sourceUrl;
				entry.body = body;
				entry.bodyComplete = Boolean(body) && !isTruncated(el);
				entry.attachments = rawAttachments;
				entry.mediaHint = hasVideo ? 'video' : hasImg ? 'images' : 'text';
				if (hasVideo && !body) entry.kind = 'video';
				return entry;
			})
			.filter(Boolean);
		if (feedItems.length || topCards.length) {
			return {
				type: 'feed',
				platform: 'threads',
				folder: {platform: 'threads', id: 'feed', name: '当前屏幕串文'},
				items: dedup(feedItems),
			};
		}
		return unsupported('unsupported_page');
	}
	if (['instagram.com', 'kuaishou.com'].includes(bareHost)) return unsupported('unsupported_page');
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
	const panels = Array.from(document.querySelectorAll('.tab-content-item')).map((panel) => {
		const r = panel.getBoundingClientRect();
		return {
			panel,
			overlap: Math.max(0, Math.min(width, r.right) - Math.max(0, r.left)),
			height: Number.isFinite(r.height) ? r.height : 100,
		};
	});
	const visiblePanels = panels.filter((p) => p.overlap > width / 2 && p.height > 20);
	const ranked = (visiblePanels.length ? visiblePanels : panels).sort(
		(a, b) => b.overlap - a.overlap || b.height - a.height,
	);
	const root = ranked[0]?.overlap > width / 2 ? ranked[0].panel : document;
	const docEl = document.scrollingElement || document.documentElement;
	let scrolling = docEl;
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
	if (
		!fromTop &&
		scrolling !== docEl &&
		scrolling.scrollTop + scrolling.clientHeight >= scrolling.scrollHeight - 2 &&
		docEl.scrollHeight > docEl.clientHeight + 2 &&
		docEl.scrollTop + docEl.clientHeight < docEl.scrollHeight - 2
	) {
		scrolling = docEl;
	}
	const before = scrolling.scrollTop,
		viewport = Math.min(window.innerHeight, scrolling.clientHeight || window.innerHeight);
	const nextTop = fromTop ? 0 : before + Math.max(1, Math.floor(viewport * 0.8));
	scrolling.scrollTo({
		top: nextTop,
		behavior: 'instant',
	});
	try {
		scrolling.dispatchEvent(new Event('scroll', {bubbles: true}));
		if (scrolling === docEl) window.dispatchEvent(new Event('scroll'));
	} catch {}
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
				...(typeof m.cover === 'string' && /^https?:\/\//i.test(m.cover)
					? {cover: m.cover.replace(/^http:\/\//i, 'https://')}
					: {}),
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
