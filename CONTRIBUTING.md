# Contributing

Thanks for taking the time to contribute. Bug reports, platform fixes and
documentation improvements are all welcome.

## Prerequisites

- Node.js >= 22
- FFmpeg (with `ffprobe`)
- Python 3.10+ for the pinned yt-dlp in `requirements.txt`

See the [README](README.md#requirements) for installation instructions.

## Getting started

```sh
git clone https://github.com/0xFANGO/fetchy.git
cd fetchy
npm install
npm run deps:install
npm run doctor
```

## Testing

```sh
npm test               # offline contract tests; needs FFmpeg for the MP4 suite
npm run extension:build
```

The default test suite runs locally. Desktop and extension end-to-end checks use separate opt-in commands. Tests that need the
project yt-dlp are skipped when `.venv` is missing. Manual end-to-end checks
against real sites are recorded in the [CLI validation log](docs/validation.md)
and the [extension validation log](docs/extension-validation.md).

PRs and pushes to `main` run CI on Node 22 and 24 with the pinned yt-dlp,
Python 3.12 and FFmpeg. CI verifies media-test dependencies before running
formatting, lint, tests and extension packaging. Keep `requirements.txt` as
the shared yt-dlp version source; after updating it, rerun `npm run deps:install`
and the tests.

## Adding a video platform

The [Instagram Reel adapter](src/sites/instagram.mjs) shows how to add a site
that works with the existing yt-dlp engine.

1. Check two public posts you have permission to save with the project’s
   pinned yt-dlp. Inspect the extractor key and media ID. Verify that a
   format choice is a rendition of the same video and that the input
   resolves to one video.
2. Add a module in `src/sites/` and register it in
   [the site list](src/sites/index.mjs). Supply an `id`, `label`, exact
   `hosts`, the yt-dlp `extractor` key and a `parse(url)` function. Instagram
   recognizes Reel permalinks and preserves the case of the shortcode
   and returns its canonical URL. Use `invalidUrl()` for unsupported paths.
   Fetchy checks the requested ID and extractor at resolve time and again on
   the downloaded file’s receipt. If yt-dlp uses separate IDs for a post
   and its media, implement `matchesSource(target, info)` as in the
   [X adapter](src/sites/x.mjs).
3. Exercise accepted URLs, tracking parameters, unsupported paths and
   lookalike hosts through `normalizeUrl`. See the
   [Instagram tests](test/instagram.test.mjs). Add a regression test for any
   special identity rule. Run `npm run check`, `npm test` and
   `npm run extension:build`.
4. Run `node bin/fetchy.mjs resolve <url>` and
   `node bin/fetchy.mjs download <url> --output .local/validation`.
   Load the built extension, start a download from the side panel and open the
   saved file. Match the saved result to the post and check the duration,
   dimensions and tracks with ffprobe. Decode the entire file with
   `ffmpeg -nostdin -v error -xerror -i <file> -f null -`.
   Record the public source, engine and observed results in the appropriate
   validation log. Reflect the verified content types and surfaces in the
   [capability table](docs/platforms.md), the READMEs and `CHANGELOG.md`.

For an audio or mixed-media adapter, also verify the AAC audio-only receipt and output with `get`. A page adapter should match the requested post identity and verify attachment order, local readability and partial results on a truncated page. An accessible folder should report its declared total, independent member count and last-page evidence. Use synthetic fixtures in version control. Account-level checks belong in a private local profile. [Library format](docs/library.md) · [Desktop session tests](docs/desktop.md)

## Code style

```sh
npm run check          # oxfmt --check + oxlint
npm run fmt            # format in place
npm run lint:fix
```

Formatting is enforced by [oxfmt](https://oxc.rs) (tabs, single quotes) and
linting by [oxlint](https://oxc.rs). Run the relevant checks locally before
requesting review. The Release workflow also checks formatting and lint before
building the release archives.

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

- Write changelog entries and GitHub release notes in English.
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
```

Replace `MERGED_RELEASE_SHA` with the release PR's squash commit on `main`,
even if newer commits have since landed. Confirm it contains the expected
version before tagging. Pushing the tag starts the Release workflow. It checks
the package and extension versions, builds both archives on Apple Silicon, and
publishes the GitHub Release with the dated notes from `CHANGELOG.md`. If the
job fails, rerun it from Actions. It can finish an interrupted draft. Ship
corrections to published builds in a new version.

To try a pull request, open its Release workflow run in Actions. The artifact
named for the PR number and commit contains the extension and macOS ZIPs.

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
