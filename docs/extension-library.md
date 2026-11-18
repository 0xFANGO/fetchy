# Archive from the browser

Open an original post, article or collection you may save. Click the Fetchy toolbar button, then **收藏库**. The extension reads the tab you opened it from. The archive opens in its own tab so you can inspect a selection before sending it to the local component.

- **当前页面** previews the original title, author, text and attachment count. For a single work, click **保存到收藏库**. Expand shortened text on the original page and use **重新读取** if the preview reports an incomplete body.
- For a collection, click **读取全部页面**. The progress line shows unique items read against the site's count when available. Use **全选已读取的作品**, or check individual items across the selection pages. In a folder directory, select the folders you want before reading their contents. The same work can belong to several folders.
- **任务** shows the persistent task ID, folder coverage, item counts and individual outcomes. After the local component accepts a task, it continues when you close the archive tab. **继续任务** processes remaining work after an interruption. **仅重试失败项** retries failed items. To fill a partial post, open the complete original and save it again.
- **离线收藏** searches titles, authors and bodies. You can filter by platform, folder or topic. **打开离线页** opens local HTML with its saved attachments. The desktop and CLI use the same library and task IDs. See the [library commands and import format](library.md).

## What the extension can read

| Page                    | Scope and coverage                                                                                                                                                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Xiaohongshu             | A note's matching ID selects its original text and ordered image list or video source. Open a named album to read its notes. On a profile, switch to **收藏 → 专辑** for named albums, or **收藏 → 笔记** for the saved-note list. The latter reads the active panel and checks its own reported count. |
| X                       | A status permalink selects the matching post among replies. Text, an expanded article and identifiable media keep their order within the body and attachment list. Open **Bookmarks** or a visible named bookmark folder to read its visible entries. An unconfirmed end remains partial.               |
| Bilibili                | An open space favorites page uses the site's favorites listing in that tab's current session. Individual folders expose page numbers and reported totals. Items selected for video download use Fetchy's video engine.                                                                                  |
| YouTube                 | A playlist exposes the entries present as you scroll, including a reported total when displayed. The playlist directory exposes visible playlists. Video availability is checked when saving.                                                                                                           |
| Zhihu and article pages | A Zhihu collection provides links to original questions' answers or columns. An individual article can preserve headings, text and ordinary links. Access restrictions, folded text and missing media may leave a partial entry.                                                                        |

Post capture uses the site tab you selected. The extension requests optional site access when it must open original posts or more collection pages in temporary tabs. Browser session credentials stay with the site. The importer may receive short-lived attachment locations to retrieve public bytes. The library stores canonical sources and local media. Opening a login page, a preview or a collection with an unknown end cannot establish complete coverage.

A browser-readable attachment may be unavailable to a separate downloader. For recognized source pages the extension can read eligible media with the browser's ordinary permissions before sending bytes to the local component. A single browser read is capped at 16 MiB per attachment and 24 MiB per post. Larger submissions use local native-messaging chunks, up to 48 MiB per submission. The native importer can fetch publicly reachable attachments that the browser could not read. A failed read keeps the corresponding position missing.

## Browser regression

On November 18, 2026, Chrome for Testing 157 on macOS ran the unpacked extension with an isolated profile and native host. The test served locally authored pages and media over HTTPS. Each flow started at the browser's toolbar, submitted through the archive UI, then found the resulting persistent task and local HTML.

| Input                        | Offline check                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Three-image Xiaohongshu note | Three distinct images decoded in their original slots. The browser read the image responses with CORS.              |
| Text-only X post             | Full text and punctuation survived without a media attachment.                                                      |
| Long article and X article   | First, middle and final paragraphs, a section heading and a link survived.                                          |
| X post with mixed media      | The local page rendered image, video, image in order. Its video played with the browser offline.                    |
| Named album with two pages   | The UI deduplicated the repeated first note and displayed two of two. Selecting only the second archived that note. |

A separate desktop and CLI check reopened the same Chrome-created three-image and text-only tasks. Both reported the same task IDs and one addition each. These fixture results exercise Fetchy's end-to-end behavior. Live site availability and account-specific coverage are recorded separately in the [platform matrix](platforms.md).

The default `npm test` includes offline capture, identity, album count and native upload checks. To repeat the real-browser scenario on macOS, install the current native host in a fresh browser profile. Set `FETCHY_TEST_ROOT` to an isolated directory containing `dist/extension`, `chrome-profile/NativeMessagingHosts` and the local component's `native-state` directory. Set `FETCHY_TEST_CHROME` to a Chrome for Testing executable and `FETCHY_TEST_PLAYWRIGHT` to a Playwright Core ES module. Run `node test/extension-library.chrome.mjs` with FFmpeg and OpenSSL on PATH. The runner generates disposable media and a local TLS certificate.
