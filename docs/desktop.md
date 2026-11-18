# Fetchy for macOS

Build the app on macOS 14 or later with the Xcode command-line tools installed. Set up Node, the pinned yt-dlp, FFmpeg and ffprobe using the [project instructions](../README.md).

```sh
npm run deps:install
npm run desktop:build
open dist/Fetchy.app
```

You can now double-click **Fetchy.app** in Finder, or copy it to Applications. The app contains the JavaScript implementation and records the local Node and media-tool installation paths at build time. Rebuild after moving those tools or updating the source. The browser extension and its native-host registration are optional for the desktop app.

## Download a link

Paste a public video URL under **保存**, choose a folder and click **下载**. When the file passes validation, **打开文件** plays that exact MP4 in the app. Existing files keep their names. The native folder picker remembers your choice.

## Sign in with Fetchy Browser

```sh
node bin/fetchy.mjs browse '<page URL>'
# Sign in on the site, then close the Fetchy Browser window.
node bin/fetchy.mjs get '<page URL>' --output ./downloads
node bin/fetchy.mjs logout '<page URL>'
```

**在专属浏览器打开** opens the same WebKit browser from the desktop. Registered platform hosts share their Fetchy profile. Other origins, including different loopback ports, receive separate profiles. The site controls login, expiration and access. Open the original page with `browse` to renew a session, then repeat `get`. Explicit logout clears the site's Fetchy website data and closes its open Fetchy login window.

The article capture path uses the same page adapter as the extension to read a matching post and its ordered attachments. Missing media and truncated text remain marked as partial when archived.

The session path loads the page and downloads inside WebKit. It can save a direct MP4 or WebM response, a single video referenced by the page, or one matching progressive media request from a player that exposes a blob URL. Only the requested site's allowed origins participate in this authenticated download. Its files pass the local media checks before publication. Adaptive manifests, encrypted content, cross-site media requests and ambiguous players require a different supported path. A platform's public video support does not establish its authenticated support.

Fetchy uses its own WebKit data store. Cookies, tokens and site storage stay inside WebKit. The registry of opened profiles contains opaque identifiers. The capture command returns the saved file's metadata.

## Browse the archive

Open **任务** to inspect shared task IDs, progress and counts. Choose **导入收藏清单…** to preview all items from a Fetchy JSON collection manifest, then tick individual items or choose **全选**. The same work appears in the CLI and extension. Resume an interrupted background job or retry its failed entries without repeating completed ones. A manifest containing local attachments must keep them under its own directory. Use separate imports for remote attachments and local relative paths.

**收藏库** searches source text, title or author and filters by platform, original folder and topic. **离线打开** opens the archived item in the default browser. Search results and completed tasks use the local library shared by Fetchy's tools.

## Reproduce the session check

```sh
npm run desktop:build
FETCHY_TEST_WEBKIT=1 node --test test/desktop-session.test.mjs
```

This opt-in macOS test opens a browser against a temporary loopback HTTP fixture with an expiring, HttpOnly session. It exits the login process, starts fresh WebKit capture processes, saves three local video paths and checks their files. It also tests expiry, renewed login and logout. The generated media, test profile registration and download directory are isolated from normal Fetchy data. Each real platform still needs an authorized account and an accessible example for authenticated acceptance.
