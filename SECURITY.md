# Security Policy

## Supported versions

Only the latest release on `main` receives fixes.

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's
private vulnerability reporting on this repository
("Security" tab → "Report a vulnerability"). You will get an acknowledgement
within a few days and a fix or mitigation plan as soon as the report is
confirmed.

Things that are in scope and that we especially want to hear about:

- The native messaging host accepting messages from an origin other than the
  registered extension ID.
- Any way for a page, share text or video title to reach a shell or a file
  path outside the chosen download directory.
- Cookies, access tokens or signed media URLs ending up in logs, persisted
  state or output filenames.

## What this project deliberately does not do

- It never exports browser cookies or session storage.
- The extension uses `activeTab` to identify the current video page, `storage`
  for local task state, and `nativeMessaging` to communicate with the local host.
- `scripting` and host access to `xiaohongshu.com`, `douyin.com` and
  `iesdouyin.com` let it read video playback data on those supported sites;
  it never injects scripts into arbitrary pages.
- Child processes are spawned with argument arrays, never shell strings.
