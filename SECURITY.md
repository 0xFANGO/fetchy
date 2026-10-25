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
- It never injects scripts into arbitrary pages; the extension requests only
  `activeTab`, `storage` and `nativeMessaging`.
- Child processes are spawned with argument arrays, never shell strings.
