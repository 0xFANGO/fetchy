# What Fetchy can save

Choose the row for the platform and the column for the kind of content you want to keep. A video file, images in their original order, and a readable offline copy of the post are separate outputs. “Folder URL” means importing the items in one specified collection. “All folders” means discovering the signed-in user's collections. “History” means reading a collection through its last page.

| Platform         | Examples to test                    | Video      | Audio    | Images    | Post text | Folder URL | All folders | History   |
| ---------------- | ----------------------------------- | ---------- | -------- | --------- | --------- | ---------- | ----------- | --------- |
| Bilibili         | Video; named favorites folder       | Saved¹     | —        | —         | —         | Saved⁷     | Untested⁷   | Public⁷   |
| Douyin           | Video post; album                   | Saved²     | —        | —         | —         | —          | —           | —         |
| Facebook         | Video post                          | Saved      | —        | —         | —         | —          | —           | —         |
| Instagram        | Reel; carousel                      | Saved⁴     | —        | Untested  | Partial⁶  | —          | —           | —         |
| Kuaishou         | Video post                          | Partial⁶   | —        | Untested⁶ | Partial⁶  | —          | —           | —         |
| Pinterest        | Pin; board                          | Resolved   | —        | —         | —         | —          | —           | —         |
| Reddit           | Video post; gallery                 | Restricted | —        | —         | —         | —          | —           | —         |
| Threads          | Post; carousel                      | Saved⁶     | —        | Partial⁶  | Saved⁶    | —          | —           | —         |
| TikTok           | Video; photo post                   | Saved      | —        | —         | —         | —          | —           | —         |
| Weibo            | Video post                          | Saved      | —        | —         | —         | —          | —           | —         |
| X (Twitter)      | Video post; text-only post          | Saved³     | —        | Fixture⁸  | Fixture⁸  | Fixture⁸   | Untested⁸   | Fixture⁸  |
| Xiaohongshu      | Video note; photo note with caption | Saved²     | —        | Saved⁵    | Saved⁵    | Browser⁵   | Counted⁵    | Partial⁵  |
| YouTube          | Video; playlist                     | Saved      | —        | —         | —         | Untested⁸  | Untested⁸   | Untested⁸ |
| Zhihu            | Article; answer                     | —          | —        | Untested⁸ | Untested⁸ | Untested⁸  | —           | Untested⁸ |
| Bandcamp         | Track; album                        | —          | Saved    | —         | —         | —          | —           | —         |
| Bluesky          | Media post                          | Saved      | —        | —         | —         | —          | —           | —         |
| Dailymotion      | Video                               | Saved      | —        | —         | —         | —          | —           | —         |
| Imgur            | Image; album                        | Untested   | —        | —         | —         | —          | —           | —         |
| Internet Archive | Item containing a video file        | Saved      | —        | —         | —         | —          | —           | —         |
| Kick             | Clip; recorded broadcast            | —          | —        | —         | —         | —          | —           | —         |
| Loom             | Recording                           | Saved      | —        | —         | —         | —          | —           | —         |
| Mixcloud         | Track; set                          | —          | Resolved | —         | —         | —          | —           | —         |
| Odysee           | Video or audio claim                | Untested   | Saved    | —         | —         | —          | —           | —         |
| PeerTube         | Video on a public instance          | Saved      | —        | —         | —         | —          | —           | —         |
| Rumble           | Video                               | Restricted | —        | —         | —         | —          | —           | —         |
| SoundCloud       | Track; set                          | —          | Saved    | —         | —         | —          | —           | —         |
| Streamable       | Video                               | Resolved   | —        | —         | —         | —          | —           | —         |
| TED              | Talk                                | Saved      | —        | —         | —         | —          | —           | —         |
| Tumblr           | Media post                          | Restricted | —        | —         | —         | —          | —           | —         |
| Twitch           | Clip; recorded broadcast            | Saved      | —        | —         | —         | —          | —           | —         |
| Vimeo            | Video; showcase                     | Restricted | —        | —         | —         | —          | —           | —         |
| VK               | Video                               | Saved      | —        | —         | —         | —          | —           | —         |

**Saved** means a sample produced a local file and passed its media checks. **Resolved** means a real page returned media metadata and formats. **Untested** means an adapter exists but the example did not establish that the output works. **Restricted** means access to the sample prevented validation. A dash (—) marks an operation without a dedicated implementation. See the individual sources, checks and limits before relying on a particular platform. [Single-link validation](platform-validation.md)

1. Bilibili produced verified files in previous CLI and extension runs. On November 18, 2026, two anonymous CLI attempts reached the download stage and returned `network_error`. Repeat the download and verify the resulting MP4 before reporting the anonymous CLI path as working again. [CLI validation](validation.md) · [Extension validation](extension-validation.md)
2. Xiaohongshu and Douyin have verified extension downloads from a readable video page. In the November 18 anonymous CLI run, the Xiaohongshu note without share parameters returned `no_formats` and the Douyin URL returned `session_required`. To retest current-page saving, open a playable post in the browser and use the extension. [CLI validation](validation.md) · [Extension validation](extension-validation.md)
3. Fetchy accepts an X post when the Twitter extractor returns one video. On a quote post, this may be the quoted post’s video. The CLI and the Chrome toolbar each saved both USGS posts, which contain their own footage. Both toolbar outputs played offline. [CLI validation](validation.md) · [Extension validation](extension-validation.md)
4. Instagram supports individual video Reels. The CLI and the Chrome toolbar each saved both NASA Reels. Both toolbar outputs played offline. [CLI validation](validation.md) · [Extension validation](extension-validation.md)

Earlier Bilibili, Douyin and Xiaohongshu video saves came from the October 24, 2026 tests or the browser-extension runs. The November 18, 2026 single-link rerun produced two complete YouTube files. Anonymous terminal downloads for two Bilibili videos failed during transfer, Douyin requested a browser session and two Xiaohongshu public URLs returned no formats. The same Douyin post produced a playable MP4 when the page supplied the source media. [Earlier platform rerun](validation.md)

5. A signed-in reader opened their own Xiaohongshu collections. The number of named folders matched the platform’s displayed total. Some folders exposed fewer visible items than their displayed counts. One note’s complete text and three original image files were checked byte-for-byte in display order. **Browser** means the folder was opened in the browser. **Partial** records the visible history when the source withholds entries.
6. The browser captured two public Threads posts using their own permalinks. Both texts and their visible video attachments were checked offline. The full original carousel inventory remains unconfirmed. An Instagram Reel yielded partial text through the current-page capture path. Earlier Instagram Reel video checks used the separate media downloader. The Kuaishou sample rendered, but the page reader could not verify its text or obtain a video URL. [Current-page checks](platform-validation.md#current-page-capture)

7. The Bilibili folder reader enumerated two pages of a public folder with 22 distinct IDs and a matching total. Account discovery is implemented for a signed-in user. Private and account-wide history have separate access requirements. [Bilibili validation](library.md)
8. The Chrome toolbar archived text, long-form Markdown and mixed attachments, and selected an item from a second bookmarks page on controlled fixtures. YouTube and Zhihu readers identify supported open lists and posts from their visible pages. These checks do not establish full authenticated histories on those platforms. [Browser archive and checks](extension-library.md)

The comparison covers the 31 services in Downbit’s list plus Zhihu. The named adapters accept individual items. Bandcamp, Mixcloud and SoundCloud route individual tracks or shows to M4A. Odysee can route a claim to either video or audio after inspecting the formats. Albums, sets, boards, channels and live streams have separate semantics. PeerTube accepts UUID and /w/ share links on FramaTube and Blender Video. Rumble accepts single-video and embed pages. Internet Archive accepts a single-video item or a named video file within an item. [Downbit’s site list](https://downbit.app/docs/sites) · [Fetchy site registry](../src/sites/index.mjs) · [Single-link validation](platform-validation.md)

When adding a platform, test each claimed output with public material you can save. Open images and text offline and check their order and completeness. For collection history, check at least two pages against the visible count or an early saved item, then confirm the final page. Report an interrupted or access-limited read as partial and record where it stopped. [Validation records](validation.md)
