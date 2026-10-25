# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- `npm run doctor` to check local dependencies.
- `npm run extension:pack` and a Release workflow that attaches the packed
  extension zip to every GitHub release.
- Code style tooling (oxfmt, oxlint), CI workflow and contributor docs.

### Changed

- Renamed the project, extension, native host and default download folder to Fetchy.
- Xiaohongshu and Douyin media is now read directly from the video page in the
  user's own browser by the extension (`scripting` + host permissions). The
  extension no longer depends on Ego Browser.
- The CLI uses yt-dlp for every platform; `--engine browser` is gone.
- Rewrote the README for first-time users; moved design notes into `docs/`.

### Removed

- The PolyForm Noncommercial license and NOTICE file; the project is now AGPL-3.0.
- The `ego-browser` dependency, `egoBrowserPath` and `browserSpaceId` options.

## [0.2.0] - 2026-10-25

### Added

- Manifest V3 browser extension with a toolbar popup, current-page
  detection, manual link input, download / cancel / retry and a download
  directory setting.
- Native Messaging host and a standalone download daemon so downloads keep
  running after the popup closes.
- Output filenames based on the real video title, with sanitising and
  no-overwrite numbering.

## [0.1.0] - 2026-10-24

### Added

- Unified `resolveVideo` / `downloadVideo` API and CLI for YouTube, Bilibili,
  Xiaohongshu and Douyin.
- yt-dlp engine delivering H.264/AAC MP4 with remux or transcode as needed.
- Browser engine for Xiaohongshu and Douyin.
