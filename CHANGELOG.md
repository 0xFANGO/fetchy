# Changelog

Notable changes for users, following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Save public videos and audio from additional social and media sites. The platform table records file-level checks and access requirements.
- Inspect links with `info`, save with `get`, and process a file or stdin with `batch`. The generic downloader accepts direct videos, declared media, finite HLS and static DASH.
- Build a macOS desktop app, sign in with a dedicated site browser, and use the same session for subsequent saves.
- Archive text and ordered attachments from supported posts and collections. Search the offline library, keep original folder memberships, and resume, retry or export shared tasks.
- Open the extension in Chrome's side panel beside the current page to save a post, read a collection one screen at a time or to the end, and save the selected entries.
- Saving selected collection entries starts at once from the list and keeps going after the panel or browser closes. The local component downloads every file, with no combined size limit, and each entry records its result and reason and can be retried on its own.
- The macOS app is one window with a cover-grid library, a built-in browser with the same side column, and an accounts list showing whether each site is signed in, expired or signed out.
- Sign in once in the desktop app; the CLI, the extension's saves and the app pass that site's cookies to the downloader only for that site's downloads. New commands `login`, `logout`, `accounts`, `folders`, `sync`, `list`, `search` and `retry`; `get` accepts `-o` and `--audio`, and a bare link saves like `get`.

### Changed

- The extension no longer opens tabs to read pages. Xiaohongshu and Douyin videos are read from the open video page; open a short link in the browser first.
- `fetchy --help` lists the new commands; `resolve`, `download`, `browse`, `batch` and `library …` keep working and are listed under `fetchy help all`.
- Downloads reuse yt-dlp's first extraction instead of reading the page twice, and the extension connects without waiting for the tool check.

### Fixed

- Media downloads work behind fake-IP proxies that resolve names into 198.18.0.0/15.

## [0.3.1] - 2026-11-02

### Fixed

- Automatically refresh the page media and retry once when a Xiaohongshu or Douyin download fails file validation.
- Read Douyin media from an already open video page without opening an extra tab.

## [0.3.0] - 2026-10-26

### Added

- Change the download folder from the popup footer; the new folder is saved
  right away for the next download.
- `npm run deps:install` to install the pinned downloader into a project-local environment.

### Changed

- New extension icon and a cleaner, more compact popup layout.

### Fixed

- Reselecting a previously unsaved download folder now saves it correctly.
- Dependency checks now report tools that cannot run and consistently ignore unusable local executables.

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

[Unreleased]: https://github.com/0xFANGO/fetchy/compare/v0.3.1...main
[0.3.1]: https://github.com/0xFANGO/fetchy/releases/tag/v0.3.1
[0.3.0]: https://github.com/0xFANGO/fetchy/releases/tag/v0.3.0
[0.2.0]: https://github.com/0xFANGO/fetchy/releases/tag/v0.2.0
