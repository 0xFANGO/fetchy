# Contributing

Thanks for taking the time to contribute. Bug reports, platform fixes and
documentation improvements are all welcome.

## Prerequisites

- Node.js >= 22
- FFmpeg (with `ffprobe`)
- Python 3.10+ for the pinned yt-dlp in `requirements.txt`

See the [README](README.md#requirements) for the one-line install per platform.

## Getting started

```sh
git clone https://github.com/0xFANGO/fetchy.git
cd fetchy
npm install
python3 -m venv .venv && .venv/bin/python -m pip install -r requirements.txt
npm run doctor
```

## Testing

```sh
npm test               # offline contract tests; needs FFmpeg for the MP4 suite
npm run extension:build
```

Tests never hit a real platform or launch a real browser. Tests that need the
project yt-dlp are skipped when `.venv` is missing. Manual end-to-end checks
against real sites are recorded in `docs/extension-validation.md`.

## Code style

```sh
npm run check          # oxfmt --check + oxlint
npm run fmt            # format in place
npm run lint:fix
```

Formatting is enforced by [oxfmt](https://oxc.rs) (tabs, single quotes) and
linting by [oxlint](https://oxc.rs). CI runs `npm run check`, `npm test` and
the extension build on every pull request; all three must pass.

## Commit messages

Commits follow [Conventional Commits](https://www.conventionalcommits.org/).
GitHub release notes are generated from them, so the subject line is what
users read.

```
<type>(<scope>): <subject>

<body: why, not what>
```

- **type**: `feat` (user-visible feature), `fix` (bug fix), `docs`, `refactor`
  (no behaviour change), `test`, `chore` (tooling, deps, release plumbing),
  `ci`.
- **scope** (optional): `extension`, `native`, `core`, `cli`, `docs`.
- **subject**: imperative, lower case, no trailing period, under 72 characters,
  in English. Say what changes for the user, not which file you touched.
- **body** (optional): the reason, the trade-off, or the gotcha that the diff
  cannot explain. Wrap at 72 characters.
- A breaking change to the API, CLI flags, native protocol or file layout
  gets a `!` after the type and a `BREAKING CHANGE:` paragraph in the body.
- One logical change per commit. Formatting-only changes go in their own
  `chore` commit so reviews stay readable.

Examples:

```
feat(extension): read Douyin media from the current tab
fix(core): keep the signed query when upgrading XHS CDN links to https
chore: adopt oxfmt and oxlint, format the whole codebase
feat(cli)!: drop --engine browser; the CLI always uses yt-dlp
```

Pull request titles follow the same format, since squash merges use them as
the commit subject.

## Releasing

```sh
npm version patch   # or minor / major
```

That one command bumps `package.json`, copies the version into
`extension/manifest.json`, commits, tags `v<version>` and pushes. The Release
workflow then builds the extension, checks the tag against the version,
creates the GitHub release with generated notes and attaches
`fetchy-extension-<version>.zip`. Add a line to `CHANGELOG.md` beforehand if
the generated notes are not enough. `npm run extension:pack` produces the same
zip locally.

## Pull requests

1. Branch from `main`.
2. Keep each PR focused on one fix or feature.
3. Add or update tests for behaviour you change. Never commit downloaded media,
   cookies, tokens or signed media URLs; validation logs belong in `.local/`.
4. Run `npm run check` and `npm test` before pushing.
5. Describe which platforms you verified manually, if any.

By contributing you agree that your contributions are licensed under the
project's [AGPL-3.0](LICENSE) license.
