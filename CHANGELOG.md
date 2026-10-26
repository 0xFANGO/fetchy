# Changelog

Notable changes for users, following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.2.0] - 2026-10-25

### Added

- Browser extension with download controls and background downloads.
- Prebuilt extension ZIPs and `npm run doctor` for dependency checks.

### Changed

- Renamed the project to Fetchy and changed the license to AGPL-3.0-only.
- Save videos directly in the selected folder, with title-based names and
  automatic numbering for duplicates.
- Read Xiaohongshu and Douyin media from the user's browser; the CLI uses yt-dlp.

### Removed

- CLI `--engine browser` and Node API `egoBrowserPath` / `browserSpaceId` options.
  Use the extension for browser-based downloads; Ego Browser is no longer required.

### Fixed

- Xiaohongshu and Douyin short-link downloads.
- Saving to disks without hard-link support; reject non-MP4 files before saving.
- Background startup after stale locks or simultaneous connection attempts.

## 0.1.0 - 2026-10-24

### Added

- CLI and Node API for single-video downloads from YouTube, Bilibili,
  Xiaohongshu and Douyin, with MP4 validation.

[Unreleased]: https://github.com/0xFANGO/fetchy/compare/v0.2.0...main
[0.2.0]: https://github.com/0xFANGO/fetchy/releases/tag/v0.2.0
