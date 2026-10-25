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

## Pull requests

1. Branch from `main`.
2. Keep each PR focused on one fix or feature.
3. Add or update tests for behaviour you change. Never commit downloaded media,
   cookies, tokens or signed media URLs; validation logs belong in `.local/`.
4. Run `npm run check` and `npm test` before pushing.
5. Describe which platforms you verified manually, if any.

By contributing you agree that your contributions are licensed under the
project's [AGPL-3.0](LICENSE) license.
