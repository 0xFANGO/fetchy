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
linting by [oxlint](https://oxc.rs). Run the relevant checks locally before
requesting review. The Release workflow checks formatting and lint, then packs
the extension; there is currently no PR test workflow.

## Commit messages

PR titles and commits follow [Conventional Commits](https://www.conventionalcommits.org/).
Each PR is squash-merged, using its title as the final commit subject and a
concise description as the body.

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
- One logical change per PR. Iterative commits are fine on the branch;
  unrelated formatting or refactoring belongs in a separate PR.

Examples:

```
feat(extension): read Douyin media from the current tab
fix(core): keep the signed query when upgrading XHS CDN links to https
chore: adopt oxfmt and oxlint, format the whole codebase
feat(cli)!: drop --engine browser; the CLI always uses yt-dlp
```

## Changelog

`CHANGELOG.md` is the source for release notes, curated for users rather than
generated from the commit log. Follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/):

- Keep `Unreleased` at the top, then versions in reverse chronological order
  with `YYYY-MM-DD` dates and release or comparison links when available.
- Write one short sentence per change, grouped under relevant Added, Changed,
  Deprecated, Removed, Fixed or Security headings. Omit empty categories.
- Describe the user-visible result. Combine related fixes and leave formatting,
  internal refactoring, test counts and development steps out of the notes.
- Always preserve breaking changes, removals, migration guidance and license
  changes. Link to installation docs instead of repeating their instructions.
- On release, move the shipped entries out of `Unreleased`. GitHub release
  notes summarize the same changes; documentation-only edits need no entry.

## Releasing

Prepare a release PR from current `main`:

```sh
git switch main
git pull --ff-only
git switch -c codex/release-X.Y.Z
npm version X.Y.Z --no-git-tag-version
npm run fmt
npm run check
npm test
RELEASE_TAG=vX.Y.Z npm run extension:pack
```

Replace `X.Y.Z` with the intended version. This updates `package.json`, the
lockfile and extension manifest without creating a commit or tag; the version
hook stages the manifest. Move the shipped changelog entries into the dated
version section, update its links, and include these files in the release PR.
Squash-merge it before tagging. Version commands never push automatically.

After the PR is merged:

```sh
git switch main
git pull --ff-only
git tag -a vX.Y.Z MERGED_RELEASE_SHA -m 'Release vX.Y.Z'
git push origin refs/tags/vX.Y.Z
gh release create vX.Y.Z --verify-tag --title 'Fetchy vX.Y.Z' --notes-file .local/release-notes.md
```

Replace `MERGED_RELEASE_SHA` with the release PR's squash commit on `main`,
even if newer commits have since landed. Confirm it contains the expected
version before tagging. Write the short release notes to
`.local/release-notes.md` first. Publishing the GitHub Release triggers the
workflow to check and pack the matching version,
then attach `fetchy-extension-X.Y.Z.zip`; pushing a tag alone does not trigger
it. Verify the workflow succeeds and the asset appears. Preserve published
tags; ship corrections in a new version.

## Pull requests

1. Start a fresh branch from current `main`, including after a previous squash merge.
2. Keep each PR focused on one fix or feature.
3. Add or update tests for behaviour you change. Never commit downloaded media,
   cookies, tokens or signed media URLs; validation logs belong in `.local/`.
4. Run `npm run check`, relevant tests and the extension build for code changes.
   Documentation-only changes need formatting and diff checks, not the full suite.
5. Update `Unreleased` for user-visible changes and describe verification performed.
6. Use **Squash and merge** only. Check the final title and body; do not include
   the branch's intermediate commit list. Start the next PR from updated `main`.

By contributing you agree that your contributions are licensed under the
project's [AGPL-3.0](LICENSE) license.
