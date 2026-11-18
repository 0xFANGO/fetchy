# Single-link media validation

These anonymous checks used the public Node API, yt-dlp 2026.10.21, FFmpeg 8.0.1 and Node 25.8.0 on November 18, 2026. For each file, the download receipt matched the source ID from a separate resolve. ffprobe reported the tracks, duration and byte count below. FFmpeg then decoded the full audio and video streams with error handling enabled. MP4 samples have H.264 video and AAC audio unless marked silent. Standalone audio samples have one AAC track in an M4A container. [Capability matrix](platforms.md) · [Earlier CLI checks](validation.md) · [Browser checks](extension-validation.md)

## Saved and decoded

| Platform         | Public item                                                                                                    | Source ID                                  | Frame size |  Seconds |         Bytes |
| ---------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------: | -------: | ------------: |
| Bandcamp         | [Monkeys Spinning Monkeys](https://kevinmacleod.bandcamp.com/track/monkeys-spinning-monkeys-104bpm)            | `516876888`                                | Audio only |  173.077 |     5,900,109 |
| Bandcamp         | [Sneaky Snitch](https://kevinmacleod.bandcamp.com/track/sneaky-snitch)                                         | `455981924`                                | Audio only |  136.620 |     4,770,301 |
| Bluesky          | [Charge production clip](https://bsky.app/profile/studio.blender.org/post/3lkndbrnm4t2q)                       | `3lkndbrnm4t2q`                            |    602×360 |   36.966 |     2,849,030 |
| Bluesky          | [OVERGROWN production clip](https://bsky.app/profile/studio.blender.org/post/3mssodxecsg2z)                    | `3mssodxecsg2z`                            |    640×360 |   42.233 |     3,002,009 |
| Dailymotion      | [Big Buck Bunny](https://www.dailymotion.com/video/x5myp5)                                                     | `x5myp5`                                   |    320×240 |  596.417 |    34,886,046 |
| Dailymotion      | [Sintel](https://www.dailymotion.com/video/x22goil)                                                            | `x22goil`                                  |    512×216 |  888.070 |    51,005,449 |
| Facebook         | [Kīlauea UAS mission](https://www.facebook.com/USGSVolcanoes/videos/2047215991973618/)                         | `2047215991973618`                         |    640×360 |  108.159 |     5,006,114 |
| Facebook         | [Fissure 17 explosions at Kīlauea](https://www.facebook.com/USGSVolcanoes/videos/2034315496597001/)            | `2034315496597001`                         |    400×250 |   38.080 |       307,838 |
| Internet Archive | [Big Buck Bunny](https://archive.org/details/BigBuckBunny_328)                                                 | `BigBuckBunny_328`                         |    532×300 |  596.458 |    58,387,027 |
| Internet Archive | [Sintel (selected file)](https://archive.org/details/Sintel/sintel-2048-stereo.mp4)                            | `Sintel/sintel-2048-stereo.mp4`            |    704×300 |  888.060 |   115,438,788 |
| Loom             | [Introdução à teoria do cinema](https://www.loom.com/share/86cf7c94aacb4e19bcbc7e97d2dc7c2e)                   | `86cf7c94aacb4e19bcbc7e97d2dc7c2e`         |   1280×720 | 6721.770 | 1,121,527,096 |
| Odysee           | [Everything Is Wrong](https://odysee.com/@KrisAttfieldMUSIC:a/everythingiswrongoriginalmusic:2)                | `2328c28cc7095b015b5dfc13f532263b88854431` | Audio only |   34.174 |     1,213,504 |
| Odysee           | [Escaping Dubious Deception](https://odysee.com/@KrisAttfieldMUSIC:a/01-Escaping-Dubious-Deception:3)          | `3cfc3a7052ef5d0bb9544df636df58b4173a8e82` | Audio only |   53.499 |     1,690,812 |
| PeerTube         | [What is PeerTube?](https://framatube.org/videos/watch/9c9de5e8-0a1e-484a-b099-e80766180a6d)                   | `9c9de5e8-0a1e-484a-b099-e80766180a6d`     |    852×480 |  114.063 |     6,557,911 |
| PeerTube         | [Rushhour auf dem Waldboden](https://framatube.org/videos/watch/7c371dce-2943-4b4a-8d06-64996db15f52)          | `7c371dce-2943-4b4a-8d06-64996db15f52`     |    480×854 |   18.937 |     3,719,131 |
| SoundCloud       | [Apollo 11, One Small Step](https://soundcloud.com/nasa/apollo-11-thats-one-small-step-for-a-man)              | `172034745`                                | Audio only |   13.029 |       159,667 |
| SoundCloud       | [Apollo 13, Houston](https://soundcloud.com/nasa/apollo-13-houston-weve-had-a)                                 | `172374191`                                | Audio only |   17.157 |       347,099 |
| TED              | [How to tie your shoes](https://www.ted.com/talks/terry_moore_how_to_tie_your_shoes)                           | `1150`                                     |    854×480 |  162.145 |    21,828,092 |
| TED              | [Try something new for 30 days](https://www.ted.com/talks/matt_cutts_try_something_new_for_30_days)            | `1183`                                     |    854×480 |  190.357 |    18,573,896 |
| TikTok           | [Volcán Villarrica Street field recording](https://www.tiktok.com/@juampayoescorpio/video/7118890092793548038) | `7118890092793548038`                      |   576×1024 |   21.107 |     2,249,812 |
| TikTok           | [Alemania Avenue field recording](https://www.tiktok.com/@juampayoescorpio/video/7118905816412949766)          | `7118905816412949766`                      |   576×1024 |   42.283 |    13,542,293 |
| Twitch           | [Totality at NASA Glenn](https://www.twitch.tv/nasa/clip/CheerfulBlazingMeatloafOneHand-NJofsCsfbdpdF97d)      | `110585429`                                |   1280×720 |   11.994 |     4,954,179 |
| Twitch           | [Astronauts enter the ISS](https://www.twitch.tv/nasa/clip/BelovedCallousKimchiHoneyBadger)                    | `3398677613`                               |   1280×720 |   26.028 |    16,621,438 |
| VK               | [Будем зорки (1927)](https://vk.com/video61207156_456245547)                                                   | `61207156_456245547`                       |    640×480 |  167.787 |    25,204,012 |
| VK               | [Novogorny cultural centre recording](https://vk.com/video-221218173_456239044)                                | `-221218173_456239044`                     |    636×480 |  336.498 |    40,801,824 |
| Weibo            | [Embassy spokesperson introduces herself](https://weibo.com/1743951792/NsFs84tbb)                              | `4968325321065481`                         |  1920×1080 |  150.094 |    44,314,656 |

For the Loom lecture, the source advertised 6,768 seconds and the playable file measured 6,721.770 seconds. The file decoded to its end. The 46.23-second difference remains unaccounted for.

### Sources and permissions

- Kevin MacLeod publishes the Bandcamp recordings under CC BY. These files came from the public track player. [Artist’s licensed collection](https://kevinmacleod.bandcamp.com/album/complete-collection-creative-commons)
- Blender Studio published the Bluesky production clips. The Dailymotion and Internet Archive samples reproduce Blender Foundation’s open movies. [Blender Studio terms](https://studio.blender.org/terms-and-conditions/) · [Big Buck Bunny credits and license](https://peach.blender.org/about/) · [Sintel sharing terms](https://durian.blender.org/sharing/)
- The Facebook footage is from the USGS Hawaiian Volcano Observatory. [Fissure 17 footage and credit](https://commons.wikimedia.org/?curid=69370128) · [USGS credits and copyright](https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits)
- The two FramaTube items name the uploader and their licenses. The first uses CC BY-SA and the second uses CC BY. [What is PeerTube? credits](https://framatube.org/api/v1/videos/9c9de5e8-0a1e-484a-b099-e80766180a6d) · [Rushhour credits](https://framatube.org/api/v1/videos/7c371dce-2943-4b4a-8d06-64996db15f52)
- NASA’s Twitch channel carried footage from Glenn Research Center and the International Space Station. NASA links to both SoundCloud recordings from its audio collection. [NASA audio and ringtones](https://www.nasa.gov/audio-and-ringtones/) · [NASA media guidance](https://www.nasa.gov/nasa-brand-center/images-and-media/)
- The TED samples are complete, unedited talks used for a noncommercial check under TED’s usage policy. [TED Talks usage policy](https://www.ted.com/about/our-organization/our-policies-terms/ted-talks-usage-policy)
- Kris Attfield publishes the two original Odysee recordings under CC BY 4.0. [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- The Loom source records identify the individual works and licenses. [Introdução à teoria do cinema (CC BY 3.0)](https://commons.wikimedia.org/?curid=172151235)
- The TikTok source records identify the individual works and licenses. [Volcán Villarrica Street field recording (original TikTok video, CC BY 4.0)](https://commons.wikimedia.org/?curid=121329693) · [Alemania Avenue field recording (original TikTok video, CC BY 4.0)](https://commons.wikimedia.org/?curid=121388364)
- The VK source records identify the individual works and licenses. [Будем зорки (1927) (Public domain)](https://commons.wikimedia.org/?curid=153273443) · [Novogorny cultural centre recording (Public domain)](https://commons.wikimedia.org/?curid=173518109)
- The Weibo source records identify the individual works and licenses. [Embassy spokesperson introduces herself (Public domain)](https://commons.wikimedia.org/?curid=141593072)

## Other public checks

Each row describes a specific request. The extractor can return formats without the downstream transfer succeeding. A media file was only counted in the table above after decoding completed.

| Service    | Public example                                                                                              | Anonymous result                                                                                                                               |
| ---------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Kick       | [Public page](https://kick.com/spreen/clips/clip_01J8RGZRKHXHXXKJEHGRM932A5)                                | Clip metadata and one format. A recording URL uses a separate adapter.                                                                         |
| Loom       | [Public page](https://www.loom.com/share/43d05f362f734614a2e81b4694a3a523)                                  | Recording metadata and two formats.                                                                                                            |
| Mixcloud   | [Public page](https://www.mixcloud.com/dholbach/cryptkeeper/)                                               | Show metadata and three audio formats.                                                                                                         |
| Odysee     | [Public page](https://odysee.com/@LBRYFoundation:0/Episode-1:e)                                             | The video API identifies this as audio-only. The audio API resolves one audio format. Playback type comes from the media formats in the claim. |
| Pinterest  | [Public page](https://www.pinterest.com/pin/664281013778109217/)                                            | One video Pin and six formats.                                                                                                                 |
| Streamable | [Public page](https://streamable.com/dnd1)                                                                  | One video and two formats.                                                                                                                     |
| TikTok     | [Public page](https://www.tiktok.com/@scout2015/video/6718335390845095173)                                  | One video and eleven formats.                                                                                                                  |
| Twitch     | [Public page](https://clips.twitch.tv/FaintLightGullWholeWheat)                                             | One clip and one format. A recorded broadcast uses a separate adapter.                                                                         |
| VK         | [Public page](https://vk.com/video-77521_162222515)                                                         | One video and twelve formats.                                                                                                                  |
| Weibo      | [Public page](https://weibo.com/7827771738/N4xlMvjhI)                                                       | One video and four formats. The post shortcode maps to media ID 4910815147462302.                                                              |
| Vimeo      | [Public page](https://vimeo.com/1041646710)                                                                 | Anonymous extraction returned auth_required.                                                                                                   |
| Reddit     | [Public page](https://www.reddit.com/r/aww/comments/90bu6w/heat_index_was_110_degrees_so_we_offered_him_a/) | Anonymous extraction returned auth_required.                                                                                                   |
| Rumble     | [Public page](https://rumble.com/embed/v5pv5f/)                                                             | The embed and a separate public video page both received HTTP 403.                                                                             |
| Tumblr     | [Public page](https://maskofthedragon.tumblr.com/post/626907179849564160/)                                  | The post request received HTTP 403.                                                                                                            |
| Imgur      | [Public page](https://imgur.com/a/iX265HX)                                                                  | The sample is an album. The single-video route rejected it. A separate Imgur item reported that it only contained a still image.               |
| Bluesky    | [Public page](https://bsky.app/profile/bsky.app/post/3n22yg6lg2k2f)                                         | This image post returned no playable formats.                                                                                                  |
| Kuaishou   | [Public page](https://www.kuaishou.com/short-video/3x5pf8ia4zc76tc)                                         | No dedicated extractor in this yt-dlp release. The anonymous page did not expose a video element or Open Graph video.                          |
| Threads    | [Public page](https://www.threads.com/@mosseri/post/Dd_mV-4iVTT)                                            | No dedicated extractor in this yt-dlp release.                                                                                                 |

## Current-page capture

In an ordinary signed-out browser, the extension’s page reader located each Threads post by its own permalink. The source URL is public and the author’s recordings are listed under CC BY-SA 4.0. Static requests to the same pages did not declare the player URLs. The browser rendered the original caption and HTTPS media attachments. The table records the visible attachments. The platform did not provide a reliable total for the original carousel. [First Threads post](https://www.threads.com/@striking_biking/post/DRgr4zOgdp7) · [First source credit](https://commons.wikimedia.org/?curid=179022187) · [Second Threads post](https://www.threads.com/@striking_biking/post/DRhFVG8ktEL) · [Second source credit](https://commons.wikimedia.org/?curid=179058066)

| Threads post | Caption               | Decoded video durations in page order | Other visible media |
| ------------ | --------------------- | ------------------------------------- | ------------------- |
| DRgr4zOgdp7  | Matched rendered text | 30.604 s, 16.556 s, 28.236 s          | One separate photo  |
| DRhFVG8ktEL  | Matched rendered text | 6.800 s, 92.441 s                     | None                |

All five videos decoded to the end at 720×1280 with H.264 video and AAC audio. Player preview images are excluded from the attachment list. Both captions matched the rendered text verbatim. Reopening the local library confirmed six attachments in order, with bytes matching the browser responses. One post retained a partial status because the source did not confirm its carousel inventory.

The same current-page reader returned a partial caption and no video attachment for the NASA Instagram Reel below. The single-video Instagram adapter saved the Reel in separate checks. The Kuaishou sample rendered a caption and video player. The reader returned no caption, could not obtain a URL for the player, and found an unverified image. No Kuaishou media was counted as saved. [Instagram Reel](https://www.instagram.com/reel/Dd1gQBsCWE8/) · [Kuaishou sample](https://www.kuaishou.com/short-video/3x5pf8ia4zc76tc)

## Earlier platform rerun

Two YouTube files passed independent decoding. Two Bilibili links resolved and then failed during transfer. The Douyin post required a session in the anonymous CLI and produced a 576×1024 H.264/AAC MP4 via the browser engine. The Xiaohongshu note previously missing an audio track did not expose playback data on its bare public URL. The original missing-audio condition requires a currently playable copy to retest. [CLI checks](validation.md) · [Browser checks](extension-validation.md)

## Repeating a file check

Run the CLI against a public item you have permission to save. Inspect the stored file and decode it to the end. A successful decode has exit status zero. The API and CLI report a lightweight ffprobe check for each download. The full decode in this record was an additional verification step.

```sh
node bin/fetchy.mjs get "$url" --output ./downloads
ffprobe -v error -show_streams -show_format -of json "$file"
ffmpeg -nostdin -v error -xerror -i "$file" -f null -
```
