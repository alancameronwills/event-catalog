# CLAUDE.md

Guidance for working in this repo. See `plan.md` for the original design and
build order; this file captures how things actually fit together now.

## What this is

A personal "assisted capture" tool for saving event posters into a local,
date-organized catalog with duplicate detection.

- **`extension/`** — a Chrome MV3 extension. Right-click (or Ctrl+Shift+E) a
  poster on *any* web page to capture it; a side panel shows the catalog. The
  content script runs on `<all_urls>` and `host_permissions` is `http(s)://*/*`
  (the service worker needs it to fetch image bytes from any CDN). Capture and
  generic scraping (image, caption, JSON-LD Event) work everywhere; the
  Facebook-specific enrichment stays gated to FB event pages (`onEventPage()`).

**Backend — on the `aws-shared-catalog` branch, the extension talks to a
shared AWS backend, not a local server.** This replaced the one-catalog-per-
machine design so several people (Windows and Mac) can use the same catalog.
See "Shared AWS backend" below.

- **`aws/`** *(current default backend)* — a Lambda function (Function URL,
  no API Gateway) backed by DynamoDB (index) + S3 (images). Pay-per-use, one
  shared catalog, auth via a shared token. See `aws/README.md`.
- **`server/`** + **`native-host/`** *(superseded, still functional
  standalone)* — the original local Node HTTP server + Windows/macOS
  auto-start tooling: one catalog per machine, no sharing. Useful for local
  dev/offline testing but the extension no longer points at it by default —
  see "Local server (superseded)" below.

The extension falls back to `chrome.storage.local` when whichever backend
it's pointed at is unreachable.

## Shared AWS backend

`aws/` — see `aws/README.md` for full detail (architecture, deploy, auth,
migration, operating it). Short version:

- Deploy with SAM: `cd aws && sam build && sam deploy ...` — creates a Lambda
  (`src/index.mjs`, ported from `server/{store,hash,ocr}.js`), a Function URL,
  `CapturesTable`/`DatesTable`/`VenuesTable` (DynamoDB, on-demand billing),
  and a public-read `ImagesBucket` (S3). No fixed cost while idle.
- `src/.npmrc` (`os=linux cpu=x64 libc=glibc`) makes `sam build` fetch the
  Linux `sharp` binary even when built from Windows/macOS — Lambda always
  runs on Amazon Linux. No Docker needed.
- Auth is one shared secret (`X-Api-Token` header, checked in `index.mjs`),
  not per-user identity — give the same token to everyone sharing the
  catalog. `extension/background.js` and `extension/sidepanel/sidepanel.js`
  each have an `API_URL` constant pointing at the Function URL; the panel
  prompts once for the token (`chrome.storage.local`, this browser only) and
  forgets it on a 401 so the next call re-prompts.
- `migrate.mjs` pushes an existing `server/data/` catalog into this backend
  via the AWS SDK directly (not the API) — run once after first deploy.
- Images are public-read S3 objects; `GET /captures` returns each entry's URL
  as `imageSrc`, which the panel's `imageSrc()` helper uses directly (no more
  `/images/<path>` proxy route).

## Local server (superseded — files still work standalone, extension no longer wired to them)

```sh
cd server && npm start          # node server.js, listens on 127.0.0.1:3777
```

This still runs and can be exercised with curl/Postman, but **the extension's
own auto-start code for it is gone**: repointing `background.js`/
`sidepanel.js` at `aws/` deleted `ensureServerRunning()`,
`launchServerViaNativeHost()`, and the `SERVER_URL`/`NATIVE_HOST` constants
entirely (see "Shared AWS backend" above). To use the local server with the
extension again you'd need to re-add that wiring, or just set `API_URL` back
to `http://127.0.0.1:3777` and enter any placeholder value when the panel
prompts for an API token — `server.js` has no auth check, so it ignores
whatever `X-Api-Token` header the panel now always sends.

**The server does not hot-reload.** After changing anything in `server/`, kill
the running process and restart it, or changes won't take effect. On Windows:
find the PID on 3777 (`netstat -ano | grep :3777`), `taskkill //PID <pid> //F`,
then `node server.js`. On macOS: `lsof -ti:3777 | xargs kill`, then `node
server.js`. This is a common footgun — a "fix didn't work" is often just a
stale server.

Two conveniences avoid the manual start: `event catalog server.cmd` (Windows)
/ `event catalog server.command` (macOS) — both at the repo root — are an
idempotent, double-clickable launcher (no-op if `/health` already answers;
good for `shell:startup` / Login Items). `native-host/` registers a Chrome
**native-messaging** host that a browser panel *could* message to auto-start
`node server.js` on demand — `host.mjs` spawns it detached via
`event_catalog_host.bat` (Windows) or `event_catalog_host.sh` (macOS), after a
one-time `native-host/install.cmd <extension-id>` / `install.sh
<extension-id>`. This was originally wired up from `sidepanel.js`
(`ensureServerRunning()`), but that call site no longer exists now the panel
talks to `aws/` by default — `native-host/` is kept for reference/manual use
only. Neither launcher hot-reloads — restarting after `server/` edits still
means killing the process by hand.

**Cross-platform:** the extension and server code are plain, portable
JS/Node — no platform-specific logic. Chrome loads the unpacked `extension/`
folder identically on macOS. The only Windows-specific pieces are the
launcher/installer scripts above, which have macOS counterparts.
`server/node_modules` is gitignored (native deps like `sharp` are
platform-specific), so `npm install` must be run on each machine — the setup
script below does this automatically on macOS.

**macOS launchd option (for running `server.js` standalone):** `Setup Event
Catalog.command` (repo root) is a one-shot, double-click setup — checks for
Node (opening the install page if it's missing), runs `npm install`, and
registers a **launchd** LaunchAgent (`~/Library/LaunchAgents/
com.cameronwills.event-catalog-server.plist`, `RunAtLoad`+`KeepAlive`) so
`server.js` is always running in the background, restarting itself at
login/crash. Logs go to `server/data/server.log`. This predates the `aws/`
backend and was originally written so a non-technical macOS user's panel
would always find the local server up without touching `native-host/` at
all; it still works to keep `server.js` running for standalone/dev use, but
isn't part of the default `aws/`-backed setup any more.

This dev machine is Windows; the Bash tool here is Git Bash. `/tmp` resolves
to `C:\tmp` for Node (which usually doesn't exist) — use the scratchpad dir
for temp files instead.

## Server layout & data model

- `server.js` — HTTP routing, CORS, image serving (with path-traversal guard),
  request-body limits. Startup runs `backfillHashes()` and `backfillVenues()`
  in the background.
- `store.js` — persistence: image files, the index, dates, the venue registry,
  plus `addCapture`, `updateCapture`, `deleteCapture`, and the backfills.
  **Index writes are serialized** through `enqueueWrite` and written atomically
  (temp file + rename); keep new writes on that path. `recordVenues` runs on the
  same chain, so call it *outside* an in-flight `enqueueWrite` task, never
  within (that would deadlock).
- `hash.js` — 64-bit dHash via `sharp` + Hamming distance.
- `ocr.js` — Tesseract text extraction (one reused worker, serialized) and
  best-effort English parsers for a date (`parseEventDate`) and a *start* time
  (`parseEventTime`, 24h "HH:MM"; ranges like "7–11pm" keep the start).
- `config.js` — env-configurable settings and derived `paths`.

Data lives under `server/data/` (gitignored): `index.json` (array, newest
first), `dates.json` (user-created dates), `venues.json` (every venue name ever
seen, for autocomplete — not pruned when events pass), `ocr-cache/` (Tesseract
language data), and `images/<YYYY-MM-DD>/<id>.<ext>`.

**Effective date** (folder + grouping key) precedence, defined in
`effectiveDate()` (server) and mirrored by `dateKey()` (panel):
`assignedDate` → structured `event.startDate` → `ocrDate` → capture date.
Keep these two in sync when you touch date logic. A capture POSTed with an
`assignedDate` (drag-to-add in the panel) pins that date, so `addCapture` skips
the *date* parse — but it still OCRs to pull a **start time** off the poster.

**Start time** is a separate, display-only value (it doesn't affect the folder):
precedence `assignedTime` → the time in structured `event.startDate` →
`ocrTime`, surfaced by `eventTimeKey()` in the panel. Date and time are edited
together in one `datetime-local` **Start** field; on save `splitStart()` splits
it back into `assignedDate` (grouping) and `assignedTime` (display). Midnight is
treated as "no time" — the field always carries one, so an unknown time would
otherwise be saved as a spurious 00:00. A blank/unknown date defaults the field
to today.

An index entry: `id, capturedAt, assignedDate, eventDate, imageFile, imageUrl,
caption, event{name,startDate,endDate,venue}, pageUrl, pageTitle, title, venue,
url, dtinfo, assignedTime, hash, ocrText, ocrDate, ocrTime, duplicateOf,
duplicateDistance, uploadState`. `title/venue/url/assignedTime` are user
overrides that fall back to scraped/OCR'd values in the UI; `dtinfo` is a
user-only free-text date/time note (no scraped fallback), sent to the upload
API's `dtinfo` field.

**Upload state** (`uploadState`) drives the *selective upload* feature: `null`
(the default) = "initial" / a candidate to upload; `"omit"` = skip; `"uploaded"`
= already sent. Toggled per-poster and by the header Upload button (see Extension
notes). Only `"omit"`/`"uploaded"` are stored — anything else (incl. "initial")
normalizes back to `null`.

### HTTP API

`GET /health`, `GET|POST /captures` (POST accepts an optional `assignedDate` to
pin the date — still OCRs for a start time), `PATCH /captures/:id` (assignedDate
moves the file; title/venue/url/dtinfo/assignedTime/uploadState are metadata), `DELETE
/captures/:id`, `GET|POST /dates`, `DELETE /dates/:date`, `GET /venues`
(distinct venue names for autocomplete), `POST /backfill-images`, `GET
/images/<folder>/<file>`.

`aws/src/index.mjs` mirrors this route set except `POST /backfill-images` and
`GET /images/*` (images are public S3 objects instead — each capture's
`imageSrc` field is the direct URL) — and every route but `/health` requires
the `X-Api-Token` header.

## Extension notes

- `background.js` (service worker) — context menu, capture flow, side-panel
  open, and **fetching the image bytes**. This is important: content scripts
  run in the page origin and are CORS-blocked from `fbcdn.net`, so the service
  worker fetches the bytes (it can, via `host_permissions`) and encodes them.
  Service workers have no `FileReader`, hence the manual ArrayBuffer→base64.
- `content.js` — runs on every page; finds the image, picks best-resolution from
  `srcset`, scrapes caption + structured event data. `scrapeEventDetails()`
  merges most→least reliable: JSON-LD → `og:`/`event:` head meta → the visible
  event-page **header DOM** → document title. On logged-in SPA sessions JSON-LD
  and event:* meta are usually *absent*, so the header DOM is the practical
  source for date and venue: `scrapeEventHeaderFromDom()` anchors on the title
  leaf and reads the date line just above it and the venue line just below (FB
  order is date → title → venue). `parseHeaderDate()` resolves relative forms
  ("Today"/"Tomorrow"/weekday names, and ranges like "Saturday from 10:00-12:30")
  against the capture time into a local-naive ISO `startDate` with the start time
  embedded. FB renders a *day-only* line for near dates, with the actual
  day-of-month in a calendar box just above it; that number (`parseBoxDay()`) is
  passed in to pin the exact month/year (`dateFromWeekdayAndDay()`) rather than
  guessing "the next Saturday", which would be wrong for events >7 days out that
  are still shown day-only. All of this (and the meta/title name fallbacks) is gated to
  `/events/<id>` pages — elsewhere og:title/document.title are just "Facebook".
  On an event page it also prefers the `og:image` cover as the poster (unless the
  user right-clicked a specific other image). Header scraping is best-effort and
  expected to need maintenance as FB's DOM shifts. Wrapped in a guarded IIFE so
  it's safe to inject more than once (the SW injects on demand into tabs that
  predate the extension). It does **not** fetch bytes.
- `sidepanel/` — the catalog UI: a date-grouped grid bucketed into collapsible
  **month** sections (earliest first; the current month starts open, others
  collapsed, and toggles persist across re-renders via `monthState`). Also:
  drag/copy-paste to move posters between dates, click-to-enlarge lightbox, a
  bottom-docked edit form (title/venue/start date+time/end date/dtinfo/url +
  duplicate warning) that
  also opens on capture, and delete. The Venue field autocompletes from a native
  `<datalist>` populated (each render) from `GET /venues` unioned with venues on
  the loaded captures. The backend (`API_URL` — `aws/` by default, see above)
  is the source of truth; pending local captures merge on top.
    - **Selective upload** — each thumb has a bottom-left square that cycles its
      `uploadState` white→black→green (initial→omit→uploaded), persisted via
      PATCH. An initial poster missing a title *or* venue shows **red** instead
      of white (tooltip "Set title and venue") and is skipped by Upload — see
      `isUploadable()`. Three icon buttons in the header: *Expand* (open all
      month sections), *Filter* (toggle — show only initial-state events), and
      *Upload* (POST every uploadable initial-state event to the gigiau site's
      REST API as multipart, marking each `"uploaded"` on success; failures and
      incomplete posters stay initial for a retry). A successful run reloads any
      open tab showing the listing (`refreshUploadTargetTabs()` — any
      `gigiau.uk/pawb` path; uses the site host permission, no `tabs` perm
      needed) so new posters appear. `uploadOne()` sends the multipart fields
      `title`, `dtstart`, `dtend`, `venue`, `dtinfo` (the free-text date/time
      note), `bookinglink` (the poster URL), and `picture`. The poster URL as
      `bookinglink`; `displayUrl()`/`specificPageUrl()` drop a bare
      `facebook.com` root so it isn't used as a link. Only the upload URL is a
      constant in `sidepanel.js`; the WordPress **username and (secret) app
      password are *not* in source** — `getUploadAuth()` prompts for both on
      first upload (the username prompt pre-fills a default, since it may change)
      and keeps them in `chrome.storage.local` (this browser profile only); a
      401/403 forgets them so the next run re-prompts. Password spaces are
      stripped before encoding (WP strips non-alphanumerics on auth).
      `https://gigiau.uk/*` is in the manifest `host_permissions` so the panel
      isn't CORS-blocked posting there.
  Two more behaviors worth knowing:
    - **Prune on open** — `pruneOutdated()` runs once on load and *permanently
      deletes* every capture whose effective date is before today (plus stale
      empty dates). Destructive by design; "unknown"-dated items are spared.
    - **Drag-to-add** — dropping an image file, or an image dragged from a page,
      onto a date group captures it there (POST with `assignedDate` set). Page
      drags are fetched in the panel itself: it's an extension page with the
      fbcdn/facebook `host_permissions`, so it isn't CORS-blocked the way a
      content script would be. A document-level drop guard stops a stray drop
      from navigating the panel to the image URL.

Facebook's DOM changes often — the image path is robust, but caption/date
scraping is expected to need occasional maintenance.

## Conventions

- ES modules, Node ≥ 18 (dev on 22). Server is dependency-light: only `sharp`
  and `tesseract.js`. Prefer built-ins over adding deps.
- No test framework. Verify with `node --check <file>` for syntax and ad-hoc
  smoke tests against a throwaway instance: run the server with
  `CATALOG_DATA_DIR=<scratch> CATALOG_PORT=<other>` so you never touch real
  data, exercise it with `curl`, and inspect. Large data-URL bodies exceed
  shell arg limits — write the JSON body to a file and `curl --data-binary @`.
- The UI can't be driven from here (no Chrome); verify panel changes via
  `node --check` plus the server endpoints they call.
- `aws/`: `sam validate --lint` + `sam build` catch template/packaging issues
  before a deploy. There's no local Lambda emulation used here — verify a
  deployed change with `curl` against the Function URL (health check, then an
  authenticated round trip) and `aws logs filter-log-events` (or `aws lambda
  list-functions` first, since SAM appends a suffix to the function name) for
  errors/timing. `.deployed-config.json` (gitignored) holds this stack's
  table/bucket names for ad-hoc AWS CLI/SDK use — never put the `ApiToken` in
  a tracked file.
- Match the surrounding style: small focused functions, comments explaining
  *why* (especially the CORS/date-precedence/serialized-write decisions).
