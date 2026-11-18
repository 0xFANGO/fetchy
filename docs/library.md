# Local library

Import an exported post or a saved folder to keep the original text, ordered media and source on your computer. Each work has an offline HTML page. The library uses Node's built-in SQLite module (Node 22.13 or later), plus FFmpeg and ffprobe for media. It lives in `library/` under Fetchy's data directory. Pass `--root <directory>` to the library commands, or set `FETCHY_LIBRARY_DIR` to choose a different library.

## Save and find posts

Save this JSON as `reading.json` to try the text archive. It contains one synthetic post.

```json
{
	"version": 1,
	"items": [
		{
			"platform": "example",
			"id": "field-notes-1",
			"sourceUrl": "https://example.org/field-notes-1",
			"author": "Field team",
			"title": "Field notes",
			"body": "# Observations\nThe survey began before sunrise.\n\n## Results\nRead the [field report](https://example.org/report).",
			"bodyFormat": "markdown",
			"bodyComplete": true,
			"topics": ["fieldwork"],
			"notes": "Follow up on the next survey."
		}
	]
}
```

```sh
node bin/fetchy.mjs library import reading.json
node bin/fetchy.mjs library search 'survey' --topic fieldwork
node bin/fetchy.mjs library tasks
node bin/fetchy.mjs library task <task-id>
node bin/fetchy.mjs library export --platform example
```

Open the `filepath` returned by search or the task's item result. The page works offline. Paragraphs, Markdown headings and HTTP(S) links are retained. Author text, optional `summary`, `translation` and personal `notes` appear separately. Search supports `--platform`, `--topic` and `--folder` (folder ID or name). Export writes a versioned JSON manifest to stdout. Media paths are relative to the library root. For an independent export, place that JSON alongside a copy of the library’s `media/` directory.

For a supported single video, supply `kind: "video"`, the platform's stable ID and its public `sourceUrl`. The library calls Fetchy's regular video downloader. A text or photo post can instead include an ordered array such as `"attachments": [{"kind":"image","path":"photos/01.jpg"},{"kind":"video","path":"clips/02.mp4"}]`. Relative paths must resolve inside the selected manifest directory. Browser integrations can pass bytes with `data` (base64) and `mimeType`, or mark a known missing attachment with `missing: true`. An image or video counts as saved after its bytes are present and ffprobe recognizes the expected stream. A URL, preview, unreadable file or incomplete body gives a partial result. Mark `bodyComplete: true` only after reading the complete source.

## Collections and progress

A JSON export can have `folders` instead of `items`. Each folder has a platform, stable ID, name and either its complete `items` or its ordered `pages`. Set the first page's `cursor` to `null`, each following cursor to the previous `nextCursor`, and the last `nextCursor` to `null`. A missing or repeated cursor, overlapping pages or disagreement with a supplied `total` marks coverage partial. To import a known subset supplied as a single array, set the folder's `complete` to `false`.

```json
{
	"version": 1,
	"folders": [
		{
			"platform": "example",
			"id": "reading",
			"name": "Reading",
			"total": 2,
			"pages": [
				{
					"cursor": null,
					"nextCursor": "older",
					"items": [
						{
							"id": "one",
							"sourceUrl": "https://example.org/one",
							"body": "First post.",
							"bodyComplete": true
						}
					]
				},
				{
					"cursor": "older",
					"nextCursor": null,
					"items": [
						{
							"id": "two",
							"sourceUrl": "https://example.org/two",
							"body": "Older post.",
							"bodyComplete": true
						}
					]
				}
			]
		}
	]
}
```

Import the entire manifest, or repeat `--select platform:id` to save chosen items across pages. The library stores each platform/ID once, keeps all original folder memberships and their supplied `savedAt` values, and shares matching media files. Running the import again skips previously archived works. Adding a new post to the source and rerunning produces a new task containing both added and skipped counts.

```sh
node bin/fetchy.mjs library import folders.json --select example:two
node bin/fetchy.mjs library import folders.json --queue
node bin/fetchy.mjs library resume <task-id>
node bin/fetchy.mjs library retry <task-id>
```

Queueing persists a task ID and copies supplied media into the library. A worker checkpoints each item, so another process can resume pending items after interruption. `retry` attempts only failed entries. To complete a partial post, reimport it with the missing text or attachments. The CLI returns nonzero for a partial or failed import while retaining the successful results. Per-folder progress includes pages read, entries seen, the platform's reported total when available, and any reason for stopping.

## Bilibili favorites

```sh
node bin/fetchy.mjs library page 'https://space.bilibili.com/84912/favlist?fid=1103317812' --page 1
node bin/fetchy.mjs library import 'https://space.bilibili.com/84912/favlist?fid=1103317812' --select bilibili:<BV-id>
node bin/fetchy.mjs library folders bilibili --cookies-file <local-netscape-file>
node bin/fetchy.mjs library sync bilibili --cookies-file <local-netscape-file>
```

A specified favorites URL or folder ID can be enumerated when Bilibili grants access. A video member goes through Fetchy's Bilibili download path. Use `page` to preview a page before selecting members. For authenticated discovery, `folders bilibili` lists folders created by the signed-in account. `sync bilibili` imports those folders. Discovery of subscriptions to other people's lists is outside this adapter's coverage. Session data stays local. Supply the authorized session again when resuming a restricted folder. A refused request or an inconsistent page sequence is recorded with its partial coverage.

On November 18, 2026, an anonymous read of [a public folder](https://space.bilibili.com/84912/favlist?fid=1103317812) reached the end after two pages with 22 distinct entries, matching the reported total. The read selected no files. A second [public folder](https://space.bilibili.com/84912/favlist?fid=1103407912) returned an empty final page and total zero. Private folders and account-wide history still need an authorized account comparison. In a separate real media import, the library saved this [USGS public-domain clip](https://www.usgs.gov/media/videos/december-5-2022-mauna-loa-fissure-3-lava-channel) from its [X post](https://x.com/USGSVolcanoes/status/1600252502217211904). The first task recorded one addition, and the next task skipped the same work.

## Node API

Import from `src/library/index.mjs`. `prepareLibraryTask(manifest, options)` returns the durable task, and `runLibraryTask(task.id, options)` executes it. `importLibrary` combines those calls. Supply `sourceDir` only for a trusted export or staging directory. The worker supports an abort `signal`, `onProgress`, and `retryFailed`. `getLibraryTask` returns item-level results. `listLibraryTasks` lists task progress. `searchLibrary(filters, options)` and `exportLibrary(filters, options)` read the same store. Library operations accept an optional `root`; the same root shares task IDs across clients.

Run `node --test test/library.test.mjs` to exercise two-page selection, cross-folder deduplication, retry and interruption, media in source order, an offline article, and partial-coverage reporting.
