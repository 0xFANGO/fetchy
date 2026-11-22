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

## Changelog & Git workflow

- Commit messages and PR titles follow Conventional Commits (`feat(extension): …`,
  `fix(core): …`, `chore: …`), English imperative subject under 72 characters.
- Record user-visible changes in `CHANGELOG.md` (English, under `Unreleased`);
  omit formatting, refactoring, test counts and development chronology.
- Use a fresh branch from `main` per focused PR and merge with **squash merge
  only**, using a concise PR description rather than intermediate commit lists.
- Ship releases via a release PR (version + changelog), tag the merged `main`
  commit only after squash merge, then publish the GitHub Release. Never rewrite
  published tags or `main` history unless explicitly asked.
- See [CONTRIBUTING.md](CONTRIBUTING.md) for commit examples, changelog rules,
  PR checklist and release commands.

## Architecture

Dependency direction is one-way; never import upwards.

```
bin/        CLI                       → src/index.mjs
extension/  MV3 popup + background    → src/urls.mjs, src/page-extract.mjs (copied at build)
native/     messaging host + daemon   → src/index.mjs, src/process.mjs, src/dependencies.mjs
src/index.mjs  public API, engine routing, bounded fallbacks → dependencies.mjs
  ├─ yt-dlp.mjs   → mp4.mjs, filenames.mjs, thumbnails.mjs, process.mjs
  ├─ browser.mjs  → filenames.mjs, thumbnails.mjs, process.mjs (downloads caller-supplied page media)
  └─ urls.mjs     link normalisation and content identity (no imports)
```

- `src/page-extract.mjs` is serialised and injected into the video page by
  the extension (see `scripts/page-extract-inject.mjs`). It must stay
  self-contained: no imports, no closures over module scope.
- The browser engine never opens pages. It takes `options.pageMedia` from the
  extension and re-validates identity and CDN hosts before downloading.
- `native/` keeps raw inputs and signed `pageMedia` URLs in memory only;
  persisted state stores only sanitised task results.
- `src/process.mjs` owns bounded external-tool subprocess execution (the only
  other `child_process` callers are `native/host.mjs` launching the detached
  daemon and `scripts/pack-extension.mjs` packing releases). Always pass
  argument arrays, never shell strings; always bound time and output.
- Public errors are `EngineError` with a stable `code`. Never surface raw
  tool output, which may contain signed URLs.

## Build & test

- `npm run deps:install` installs the pinned yt-dlp from `requirements.txt` into
  `.venv` (shared by local setup and CI).
- `npm test` runs offline contract tests; FFmpeg is required for the MP4
  suite and `.venv` yt-dlp for two integration tests (skipped otherwise).
- `npm run check` = `oxfmt --check` + `oxlint` (tabs, single quotes, no bracket
  spacing). Run `npm run fmt` before committing.
- `npm run extension:build` writes the loadable extension to `dist/extension`;
  `npm run native:install` registers the native host (macOS only for now).
- See [CONTRIBUTING.md](CONTRIBUTING.md) for CI matrix and full setup details.
