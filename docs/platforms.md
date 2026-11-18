# What Fetchy can save

Choose the row for the platform and the column for the kind of content you want to keep. A video file, images in their original order, and a readable offline copy of the post are separate outputs. “Folder URL” means importing the items in one specified collection. “All folders” means discovering the signed-in user's collections. “History” means reading a collection through its last page.

| Platform         | Examples to test                    | Video  | Images | Post text | Folder URL | All folders | History |
| ---------------- | ----------------------------------- | ------ | ------ | --------- | ---------- | ----------- | ------- |
| Bilibili         | Video; named favorites folder       | Saved¹ | —      | —         | —          | —           | —       |
| Douyin           | Video post; album                   | Saved² | —      | —         | —          | —           | —       |
| Facebook         | Video post                          | —      | —      | —         | —          | —           | —       |
| Instagram        | Reel; carousel                      | Saved⁴ | —      | —         | —          | —           | —       |
| Kuaishou         | Video post                          | —      | —      | —         | —          | —           | —       |
| Pinterest        | Pin; board                          | —      | —      | —         | —          | —           | —       |
| Reddit           | Video post; gallery                 | —      | —      | —         | —          | —           | —       |
| Threads          | Post; carousel                      | —      | —      | —         | —          | —           | —       |
| TikTok           | Video; photo post                   | —      | —      | —         | —          | —           | —       |
| Weibo            | Video post                          | —      | —      | —         | —          | —           | —       |
| X (Twitter)      | Video post; text-only post          | Saved³ | —      | —         | —          | —           | —       |
| Xiaohongshu      | Video note; photo note with caption | Saved² | —      | —         | —          | —           | —       |
| YouTube          | Video; playlist                     | Saved  | —      | —         | —          | —           | —       |
| Zhihu            | Article; answer                     | —      | —      | —         | —          | —           | —       |
| Bandcamp         | Track; album                        | —      | —      | —         | —          | —           | —       |
| Bluesky          | Media post                          | —      | —      | —         | —          | —           | —       |
| Dailymotion      | Video                               | —      | —      | —         | —          | —           | —       |
| Imgur            | Image; album                        | —      | —      | —         | —          | —           | —       |
| Internet Archive | Item containing a video file        | —      | —      | —         | —          | —           | —       |
| Kick             | Clip; recorded broadcast            | —      | —      | —         | —          | —           | —       |
| Loom             | Recording                           | —      | —      | —         | —          | —           | —       |
| Mixcloud         | Track; set                          | —      | —      | —         | —          | —           | —       |
| Odysee           | Video                               | —      | —      | —         | —          | —           | —       |
| PeerTube         | Video on a public instance          | —      | —      | —         | —          | —           | —       |
| Rumble           | Video                               | —      | —      | —         | —          | —           | —       |
| SoundCloud       | Track; set                          | —      | —      | —         | —          | —           | —       |
| Streamable       | Video                               | —      | —      | —         | —          | —           | —       |
| TED              | Talk                                | —      | —      | —         | —          | —           | —       |
| Tumblr           | Media post                          | —      | —      | —         | —          | —           | —       |
| Twitch           | Clip; recorded broadcast            | —      | —      | —         | —          | —           | —       |
| Vimeo            | Video; showcase                     | —      | —      | —         | —          | —           | —       |
| VK               | Video                               | —      | —      | —         | —          | —           | —       |

**Saved** means Fetchy produced a video file that passed checks for its video track, expected audio and duration. Each result covers the recorded sample and entry point. **Untested** means Fetchy has a path for the operation and still needs a real-file check. A dash (—) means Fetchy has no implementation for that operation. Use **Restricted** only when the platform or session prevents an implemented operation, and **N/A** only when the service itself is known to lack the feature.

1. Bilibili produced verified files in previous CLI and extension runs. On November 18, 2026, two anonymous CLI attempts reached the download stage and returned `network_error`. Repeat the download and verify the resulting MP4 before reporting the anonymous CLI path as working again. [CLI validation](validation.md) · [Extension validation](extension-validation.md)
2. Xiaohongshu and Douyin have verified extension downloads from a readable video page. In the November 18 anonymous CLI run, the Xiaohongshu note without share parameters returned `no_formats` and the Douyin URL returned `session_required`. To retest current-page saving, open a playable post in the browser and use the extension. [CLI validation](validation.md) · [Extension validation](extension-validation.md)
3. Fetchy accepts an X post when the Twitter extractor returns one video. On a quote post, this may be the quoted post’s video. The CLI and the Chrome toolbar each saved both USGS posts, which contain their own footage. Both toolbar outputs played offline. [CLI validation](validation.md) · [Extension validation](extension-validation.md)
4. Instagram supports individual video Reels. The CLI and the Chrome toolbar each saved both NASA Reels. Both toolbar outputs played offline. [CLI validation](validation.md) · [Extension validation](extension-validation.md)

The comparison includes the sites named by Downbit 0.2.8 and adds Zhihu for saved articles and answers. Downbit documents support for tracks and sets on Bandcamp, Mixcloud and SoundCloud, and for declared media on other pages. Fetchy's single-video command currently produces MP4. Standalone audio, arbitrary media and playlist imports each need their own implementation and file checks. [Downbit's site list](https://downbit.app/docs/sites) · [Fetchy site registry](../src/sites/index.mjs)

When adding a platform, test each claimed output with public material you can save. Open images and text offline and check their order and completeness. For collection history, check at least two pages against the visible count or an early saved item, then confirm the final page. Report an interrupted or access-limited read as partial and record where it stopped. [Validation records](validation.md)
