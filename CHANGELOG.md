# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- `npm run doctor` to check local dependencies.
- Code style tooling (oxfmt, oxlint), CI workflow and contributor docs.

### Changed

- Rewrote the README for first-time users; moved design notes into `docs/`.

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
