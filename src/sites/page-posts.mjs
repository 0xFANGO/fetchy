// Browser-only services can redirect between these first-party hosts before rendering a post.
const threads = {
	platform: 'threads',
	hosts: ['www.threads.com', 'threads.com', 'www.threads.net', 'threads.net'],
	path: /^\/@[\w.]+\/post\/([\w-]+)\/?$/,
};
const kuaishou = {
	platform: 'kuaishou',
	hosts: ['www.kuaishou.com', 'kuaishou.com'],
	path: /^\/(?:short-video|f)\/([\w-]+)\/?$/,
};
const browserOnly = [threads, kuaishou];
const posts = [
	...browserOnly,
	{
		platform: 'instagram',
		hosts: ['instagram.com', 'www.instagram.com'],
		path: /^\/(?:[\w.]+\/)?p\/([\w-]+)\/?$/,
	},
	{
		platform: 'zhihu',
		hosts: ['www.zhihu.com', 'zhihu.com'],
		path: /^\/question\/\d+\/answer\/(\d+)\/?$/,
	},
	{platform: 'zhihu', hosts: ['zhuanlan.zhihu.com'], path: /^\/p\/(\d+)\/?$/},
];

export function browserOnlySite(host) {
	return browserOnly.find((site) => site.hosts.includes(host));
}

export function browserPostTarget(url) {
	if (url.protocol !== 'https:' || url.username || url.password || url.port) return;
	const site = posts.find((s) => s.hosts.includes(url.hostname));
	const match = site?.path.exec(url.pathname);
	if (match) return {platform: site.platform, id: match[1], url: url.href, pageOnly: true};
}
