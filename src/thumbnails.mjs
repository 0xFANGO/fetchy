/** Only platform image CDNs may be loaded by the popup; unknown covers are optional. */
export function publicThumbnailUrl(value, { platform, id } = {}) {
  if (typeof value !== 'string' || value.length > 8192 || value !== value.trim()) return null;
  const hosts = {
    youtube: ['ytimg.com', 'youtube.com'],
    bilibili: ['hdslb.com'],
    xiaohongshu: ['xhscdn.com'],
    douyin: ['douyinpic.com', 'byteimg.com', 'byteimg.com.cn', 'ibytedtos.com'],
  }[platform];
  if (!hosts) return null;
  try {
    // These image CDNs serve HTTPS even when upstream metadata supplies HTTP.
    const candidate = value.replace(/^http:/i, 'https:');
    const url = new URL(candidate);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
      || !hosts.some(host => url.hostname === host || url.hostname.endsWith('.' + host))) return null;
    if (/\.(?:mp4|m3u8|m4s|mpd|webm)$/i.test(url.pathname) || /^sns-video/i.test(url.hostname)) return null;
    // YouTube also publishes storyboard and channel images on ytimg. Only a
    // target-specific video cover is suitable for the confirmation card.
    const parts = url.pathname.split('/');
    if (platform === 'youtube' && (!id || !['vi', 'vi_webp'].includes(parts[1]) || parts[2] !== String(id))) return null;
    return candidate;
  } catch { return null; }
}

export function pickPublicThumbnail(values, target) {
  for (const value of values) {
    const url = publicThumbnailUrl(value, target);
    if (url) return url;
  }
  return null;
}
