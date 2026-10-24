import path from 'node:path';

export function manifestDirectories(browser, home, override = null) {
  if (!['ego', 'chrome', 'all'].includes(browser)) throw new Error('--browser 仅接受 ego、chrome 或 all。');
  if (override !== null) {
    if (typeof override !== 'string' || !path.isAbsolute(override)) throw new Error('--manifest-dir 必须是绝对路径。');
    return [override];
  }
  const chrome = path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts');
  // Ego Lite 0.6.0.20 uses Chrome's shared native-host lookup on macOS.
  // Its product directory alone returned "Specified native messaging host not
  // found" in the real extension; adding the Chrome registration connected.
  // Register both for compatibility with product-specific lookup in other builds.
  return browser === 'chrome' ? [chrome] : [
    path.join(home, 'Library', 'Application Support', 'Citro Labs', 'ego lite', 'NativeMessagingHosts'),
    chrome,
  ];
}
