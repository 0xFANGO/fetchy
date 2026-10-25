# Fango Video Downloader

[![CI](https://github.com/0xFANGO/fango-video-downloader/actions/workflows/ci.yml/badge.svg)](https://github.com/0xFANGO/fango-video-downloader/actions/workflows/ci.yml)
[![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue)](LICENSE)
[![Node >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](package.json)
[![Platform: macOS](https://img.shields.io/badge/platform-macOS-lightgrey)](docs/extension-install.md)

Save a single video from **YouTube, Bilibili, Xiaohongshu or Douyin** to a folder on your Mac.
One toolbar button, one command, or one function call. Everything runs locally.

[中文文档](README.zh-CN.md)

<p align="center">
  <img src="docs/assets/popup-ready.png" width="30%" alt="Popup showing a detected Bilibili video with a Download button">
  <img src="docs/assets/popup-downloading.png" width="30%" alt="Popup showing download progress at 62%">
  <img src="docs/assets/popup-saved.png" width="30%" alt="Popup showing the saved file path and a Reveal in Finder button">
</p>

## Features

- **Four platforms, one workflow.** Paste a link or open a video page, click once. Share text with a short link works too.
- **Local first.** Downloads run on your machine through a native host. No cloud service, no account, no cookie export.
- **Real, playable files.** Output is an MP4 validated with ffprobe for H.264 / yuv420p / AAC. Files are named after the actual video title and never overwrite existing files.
- **Keeps going.** Close the popup and the download continues; reopen it to see progress, cancel or reveal the file in Finder.
- **Same core everywhere.** The extension, the CLI and the Node API share one `resolveVideo` / `downloadVideo` contract with stable error codes.

## Supported platforms

| Platform    | Accepted input                                                       | Engine      | Notes                                                         |
| ----------- | -------------------------------------------------------------------- | ----------- | ------------------------------------------------------------- |
| YouTube     | `youtube.com/watch`, `youtu.be`, Shorts                              | yt-dlp      | Prefers native H.264/AAC, falls back to HLS on network errors |
| Bilibili    | `bilibili.com/video/BV…`, `av…`, multi-part `?p=`                    | yt-dlp      | DASH video and audio merged into MP4                          |
| Xiaohongshu | Full share link with `xsec_token`, or share text containing one link | Ego Browser | Reads the note page in your logged-in browser session         |
| Douyin      | `v.douyin.com` short links, `modal_id` links, detail pages           | Ego Browser | Short links are resolved to the canonical video ID            |

Single, finished videos only. Playlists, live streams, image notes, DRM content and watermark removal are out of scope.
See [docs/limitations.md](docs/limitations.md) for the full list.

## Requirements

| Tool                        | Needed for                    | macOS install                                                                  |
| --------------------------- | ----------------------------- | ------------------------------------------------------------------------------ |
| Node.js 22+                 | everything                    | `brew install node`                                                            |
| FFmpeg + ffprobe            | merging, remuxing, validation | `brew install ffmpeg`                                                          |
| yt-dlp (pinned version)     | YouTube, Bilibili             | `python3 -m venv .venv && .venv/bin/python -m pip install -r requirements.txt` |
| Ego Browser (`ego-browser`) | Xiaohongshu, Douyin only      | optional, see [docs/extension-install.md](docs/extension-install.md)           |

Run `npm run doctor` at any time to see what is found and what is missing.

The native host installer currently supports **macOS** only. The download core and CLI also run on Linux and Windows.

## Quick start

```sh
git clone https://github.com/0xFANGO/fango-video-downloader.git
cd fango-video-downloader
npm install
python3 -m venv .venv && .venv/bin/python -m pip install -r requirements.txt
npm run doctor

# download a video into ./downloads
node bin/fango-download.mjs download 'https://www.bilibili.com/video/BV19Pnb6REhD/'
```

The CLI prints a JSON result with the absolute file path, size and validation details. Progress goes to stderr. `Ctrl+C` cancels cleanly and leaves no half-written file behind.

## Browser extension

```sh
npm run extension:build                 # writes dist/extension
npm run native:install -- --browser ego # registers the native host (use --browser chrome for Chrome)
```

1. Open `chrome://extensions/`, enable Developer mode, click **Load unpacked** and pick `dist/extension`.
2. Pin the extension to the toolbar.
3. Open a video page and click the icon, or paste a link into the popup.

Downloads go to `~/Downloads/Fango` by default; change it from the popup's settings view.
The extension only requests `activeTab`, `storage` and `nativeMessaging`.

Verified so far on macOS with Ego Lite. Chrome registration is available but not yet verified end to end.
Full installation notes, session requirements and troubleshooting: [docs/extension-install.md](docs/extension-install.md).

## CLI

```sh
node bin/fango-download.mjs resolve  <url>   # inspect formats without downloading
node bin/fango-download.mjs download <url>   # download
```

| Option                           | Default       | Description                                                                  |
| -------------------------------- | ------------- | ---------------------------------------------------------------------------- |
| `--output <dir>`                 | `./downloads` | Target directory; each download gets its own `video-*` subfolder             |
| `--engine auto\|yt-dlp\|browser` | `auto`        | `auto` routes Xiaohongshu/Douyin to the browser engine, the rest to yt-dlp   |
| `--max-height <px>`              | unlimited     | Upper bound on the actual frame height (a 1080×1920 portrait video is 1920)  |
| `--transport auto\|hls`          | `auto`        | Force HLS on YouTube                                                         |
| `--timeout-ms <ms>`              | 30 min        | Whole-task timeout                                                           |
| `--cookies-file <file>`          | none          | Netscape cookie file for the yt-dlp engine; a private temporary copy is used |

`npm run download -- <url>` and `npm run resolve -- <url>` are shortcuts for the same commands.

## Node API

```js
import {resolveVideo, downloadVideo} from './src/index.mjs';

const url = 'https://www.bilibili.com/video/BV19Pnb6REhD/';

const info = await resolveVideo(url);
console.log(info.title, info.durationSeconds, info.formats.length);

const result = await downloadVideo(url, {
	outputDir: './downloads',
	maxHeight: 1080,
	onProgress: ({stage}) => console.log(stage),
});
console.log(result.filepath, result.validation);
```

Options: `outputDir`, `engine`, `maxHeight`, `transport`, `timeoutMs`, `signal` (an `AbortSignal`), `onProgress`, `cookiesFile`, plus tool paths `ytDlpPath`, `ffmpegLocation`, `ffprobePath`, `egoBrowserPath`.

`resolveVideo` returns displayable metadata (`platform`, `id`, `title`, `thumbnailUrl`, `durationSeconds`, `formats`) and never exposes signed media URLs.
`downloadVideo` re-resolves the link, downloads, validates and returns `{filepath, bytes, validation, conversion, …}`.
Failures throw an `EngineError` with a stable `code` such as `invalid_url`, `unsupported_platform`, `network_error`, `auth_required`, `verification_required`, `drm`, `no_formats`, `dependency_missing`, `timeout` or `cancelled`.

## How it works

```
extension/   Manifest V3 popup + service worker   ─┐
bin/         CLI                                   ├─▶ src/index.mjs ─▶ yt-dlp engine (yt-dlp + FFmpeg)
native/      Native Messaging host + daemon       ─┘                  └─▶ browser engine (Ego Browser page extraction)
```

The popup is only a view. A native host hands each task to a standalone daemon that owns the download, so closing the popup, rebuilding the service worker or dropping the port never cancels a transfer. Persisted task records contain no raw inputs, tokens or signed URLs.

## Development

```sh
npm test              # offline contract tests (FFmpeg required for the MP4 suite)
npm run check         # oxfmt --check + oxlint
npm run fmt           # format
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Design notes, platform research and manual validation logs live in [docs/](docs/).

## License

Source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE). Free for personal, educational, research and other non-commercial use, including modifying and sharing copies with the license and the `Required Notice` from [NOTICE](NOTICE). Commercial use is not granted. This is not an [OSI-approved](https://opensource.org/osd) open source license.

This tool is for saving content you are allowed to keep, for personal use. Respect each platform's terms of service and the rights of content creators. The license covers the code only, not any downloaded content.
