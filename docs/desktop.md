# Fetchy for macOS

## Install or update

For an Apple Silicon Mac running macOS 14 or later, download `fetchy-macos-arm64-<version>.zip` from [GitHub Releases](https://github.com/0xFANGO/fetchy/releases/latest). Install Node.js 22.13 or later, Python 3.10 or later, yt-dlp and FFmpeg (including ffprobe). With Homebrew, run:

```sh
brew install node python yt-dlp ffmpeg
```

Quit Fetchy, unzip the archive and drag `Fetchy.app` into Applications. Its library and site sessions live outside the app bundle. The download uses an ad-hoc signature and has no Apple notarization. If macOS asks you to verify the developer, see [Apple's guide to opening downloaded apps](https://support.apple.com/en-us/102445).

If you use the browser extension, update it from the same release and register the native host in the installed app. [Extension installation and updates](extension-install.md)

## Build from source

Build the app on macOS 14 or later with the Xcode command-line tools installed. Set up Node, the pinned yt-dlp, FFmpeg and ffprobe using the [project instructions](../README.md).

```sh
npm run deps:install
npm run desktop:build
open dist/Fetchy.app
```

You can now double-click **Fetchy.app** in Finder, or copy it to Applications. The app contains the JavaScript implementation and records the local Node and media-tool installation paths at build time. Rebuild after moving those tools or updating the source. The browser extension and its native-host registration are optional for the desktop app.

The app is one window with three areas in its sidebar: **资料库**, **浏览器** and **账号**.

## Library

Saved works appear as a cover grid. Paste a link into the field at the top and click **保存**; type anything else to search titles, authors and text. Filter by **全部**, **视频**, **图文** or **文章**, and by platform or original folder. Click a card to open its offline page; the context menu reveals it in Finder or opens the original post in the built-in browser.

**进行中与失败** lists unfinished saves. Each failed or partial entry shows its reason and the next step: **去登录后重试** takes you to that site's row under accounts, **重试** saves that entry again, and **重试失败项** retries a whole task. **更多 → 导入收藏清单…** previews a Fetchy JSON collection manifest so you can tick items before saving. A manifest containing local attachments must keep them under its own directory.

## Built-in browser

The browser sits in the main window with an address bar, back, forward and reload. The bar shows whether the current site is signed in. Each site keeps its own WebKit store; registered aliases of the same service share one, while PeerTube instances, tenant-owned Bandcamp or Tumblr hosts and other origins get their own. A link inside a page stays in the current store, so a sign-in that passes through another domain completes. A page that opens a new window continues in the same view.

Beside the page is the same column as the browser extension: save the open post, read and select a collection, or save media the page has played. Saving hands the list to the local component and then reads each post page from the open page.

## Accounts

Each site has a row showing **已登录**, **已过期** or **未登录**. **登录** opens the site in the built-in browser; **退出登录** clears that site's store. Add any other site by its address; for a site without a known session cookie, any cookie counts as signed in and the row says so. Being signed in is judged from the site's session cookies, and a site whose download was rejected shows as expired until you sign in again.

```sh
fetchy login bilibili     # opens the row's site in the app's browser
fetchy accounts           # the same states as the app
fetchy logout bilibili
```

When a download needs a site's sign-in, the CLI or the local component asks the app for that site's cookies and gives them to the downloader as a temporary file for that one request, then deletes it. Cookies for other sites are never included. Generic pages that yt-dlp cannot read are still saved inside WebKit with the site's own store, as before.

The article capture path uses the same page adapter as the extension to read a matching post and its ordered attachments. Missing media and truncated text remain marked as partial when archived.

## Reproduce the session check

```sh
npm run desktop:build
FETCHY_TEST_WEBKIT=1 node --test test/desktop-session.test.mjs
```

Quit Fetchy before running it. This opt-in macOS test starts a temporary HTTP site with an expiring HttpOnly session. Each CLI invocation runs in a fresh process. The test runs `browse`, quits the Fetchy window, then runs `get <watch URL>` and verifies the archived 160 × 90 video and audio stream. It also saves a protected article with an inline image, detects a truncated version, checks the login prompt after expiry, signs in again and saves a blob-backed player with `get`. A final `logout` clears the site session. The test uses its own library and download directories.

## Desktop acceptance on macOS

These checks were run with the earlier two-window app; the single window still needs the same checks.

- The desktop saved [USGS Volcanoes’ Mauna Loa clip](https://x.com/USGSVolcanoes/status/1600252502217211904) into the directory chosen in the native folder picker. The file contained 2,950,225 bytes of H.264 video and AAC audio at 1280 × 720, with a duration of 9.97 seconds. Clicking **打开文件** showed the saved clip playing in Fetchy's own window.
- A real Chrome toolbar session archived a three-image fixture and a separate text-only post through the native host. The desktop **任务** view and fresh CLI `library task` calls showed the same two task IDs and counts as the extension. Each reported one addition, with zero skipped, partial or failed entries. The desktop library showed both titles and their offline open actions.
- In a fresh signed-out WebKit profile, `get` followed a [public Threads permalink on the older domain](https://www.threads.net/@striking_biking/post/DRgr4zOgdp7) and wrote an offline page for the matching post. WebKit exposed a caption excerpt and no attachments, so the task reported a partial save. The [Chrome checks](platform-validation.md#current-page-capture) record what the same post exposed there.
- The signed-in flow above was verified against the controlled site. Platform-specific authenticated checks require an authorized account and an accessible example.
