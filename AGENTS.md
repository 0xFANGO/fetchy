# Fetchy

Browser extension plus local download core for single videos from YouTube,
Bilibili, Xiaohongshu and Douyin. Pure ESM JavaScript (`.mjs`), Node 22+,
no runtime npm dependencies. Tests use `node:test`.

## Coding guardrails

- Think before coding: restate the goal, surface assumptions and trade-offs,
  and ask when requirements are ambiguous.
- Keep it simple: choose the smallest working change; avoid speculative
  abstractions, configurability, or broad rewrites.
- Make surgical edits: touch only the files and lines required, follow local
  style, and leave unrelated cleanup alone.
- Verify against the goal: define the relevant checks up front, run the
  focused validation, and keep iterating until the stated goal is satisfied.
- Comment discipline: comment only what the code cannot say — invariants,
  trade-offs, external constraints, hard-won gotchas. Delete comments that
  restate the code.
- Never commit downloaded media, cookies, tokens or signed media URLs. Logs
  and validation output go to the git-ignored `.local/`.
- Commit messages follow Conventional Commits (`feat(extension): …`,
  `fix(core): …`, `chore: …`); see CONTRIBUTING.md. Subject in English,
  imperative, under 72 characters; body explains why.

## Changelog & Git workflow

- Write `CHANGELOG.md` and GitHub release notes in English.
- Keep `CHANGELOG.md` focused on user-visible changes, grouped by release.
  Use short entries under relevant Added / Changed / Removed / Fixed sections;
  include deprecations, security fixes and migration steps when applicable.
  Omit formatting, refactoring, test counts and development chronology.
- Put upcoming changes in `Unreleased`; move them into the version section
  when releasing. Keep GitHub release notes consistent and link to installation
  docs instead of copying them. Preserve breaking changes and license changes.
- Use a fresh branch from `main` for each focused PR. Iterative commits on the
  branch are fine; merge into `main` with **squash merge only**. The PR title
  follows Conventional Commits and becomes the final commit subject; use a
  concise PR description rather than a list of intermediate commits.
- Prepare version and changelog updates in a release PR. Tag the merged `main`
  commit only after squash merge, then publish the GitHub Release. See
  CONTRIBUTING.md for commands. Do not rewrite published tags or `main` history
  unless the user explicitly requests that separate operation.

## Architecture

Dependency direction is one-way; never import upwards.

```
bin/        CLI                       → src/index.mjs
extension/  MV3 popup + background    → src/urls.mjs, src/page-extract.mjs (copied at build)
native/     messaging host + daemon   → src/index.mjs, src/process.mjs
src/index.mjs  public API, engine routing, bounded fallbacks
  ├─ yt-dlp.mjs   → mp4.mjs, filenames.mjs, thumbnails.mjs, process.mjs
  ├─ browser.mjs  → filenames.mjs, thumbnails.mjs, process.mjs (downloads caller-supplied page media)
  └─ urls.mjs     link normalisation and content identity (no imports)
```

- `src/page-extract.mjs` is serialised and injected into the video page by
  the extension (see `scripts/page-extract-inject.mjs`). It must stay
  self-contained: no imports, no closures over module scope.
- The browser engine never opens pages. It takes `options.pageMedia` from the
  extension and re-validates identity and CDN hosts before downloading.
- Signed media URLs in `pageMedia` live only in memory in `native/`.
- `src/process.mjs` is the only place that spawns child processes. Always
  pass argument arrays, never shell strings; always bound time and output.
- `native/` persists only sanitised task results; raw inputs stay in memory.
- Public errors are `EngineError` with a stable `code`. Never surface raw
  tool output, which may contain signed URLs.

## Build & test

- `npm test` runs offline contract tests; FFmpeg is required for the MP4
  suite and `.venv` yt-dlp for two integration tests (skipped otherwise).
- `npm run check` = `oxfmt --check` + `oxlint`. Style: tabs, single quotes,
  no bracket spacing. Run `npm run fmt` before committing.
- `npm run extension:build` writes the loadable extension to `dist/extension`.
- `npm run native:install` registers the native host (macOS only for now).
