# CLAUDE.md

Guidance for working in this repo. See `plan.md` for the original design and
build order; this file captures how things actually fit together now.

## What this is

A personal "assisted capture" tool for saving Facebook event posters into a
local, date-organized catalog with duplicate detection. Two halves:

- **`extension/`** — a Chrome MV3 extension. Right-click (or Ctrl+Shift+E) a
  poster on Facebook to capture it; a side panel shows the catalog.
- **`server/`** — a local Node HTTP server that stores images on disk, keeps a
  JSON index, perceptually-hashes for duplicates, and OCRs posters for dates.

They talk over `http://127.0.0.1:3777`. The extension falls back to
`chrome.storage.local` when the server is offline.

## Running

```sh
cd server && npm start          # node server.js, listens on 127.0.0.1:3777
```

Load the extension unpacked at `chrome://extensions` (Developer mode → Load
unpacked → `extension/`). After editing extension files, reload it there (↻).

**The server does not hot-reload.** After changing anything in `server/`, kill
the running process and restart it, or changes won't take effect. Typical loop:
find the PID on 3777 (`netstat -ano | grep :3777`), `taskkill //PID <pid> //F`,
then `node server.js`. This is a common footgun — a "fix didn't work" is often
just a stale server.

Two conveniences avoid the manual start: `start-server.cmd` (repo root) is an
idempotent, double-clickable launcher (no-op if `/health` already answers; good
for `shell:startup`). And `native-host/` registers a Chrome **native-messaging**
host so the side panel auto-starts the server on load when it's down — the panel
calls `ensureServerRunning()` (see `sidepanel.js`), which messages
`com.cameronwills.event_catalog`; the host (`host.mjs`, launched via
`event_catalog_host.bat`) spawns `node server.js` detached and exits. Requires a
one-time `native-host/install.cmd <extension-id>` and the `nativeMessaging`
manifest permission. Neither of these hot-reloads either — restarting after
`server/` edits still means killing the process by hand.

Windows box; the Bash tool is Git Bash. `/tmp` resolves to `C:\tmp` for Node
(which usually doesn't exist) — use the scratchpad dir for temp files instead.

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
`ocrTime`, surfaced by `eventTimeKey()` in the panel and editable via the
editor's Time field.

An index entry: `id, capturedAt, assignedDate, eventDate, imageFile, imageUrl,
caption, event{name,startDate,endDate,venue}, pageUrl, pageTitle, title, venue,
url, assignedTime, hash, ocrText, ocrDate, ocrTime, duplicateOf,
duplicateDistance, uploadState`. `title/venue/url/assignedTime` are user
overrides that fall back to scraped/OCR'd values in the UI.

**Upload state** (`uploadState`) drives the *selective upload* feature: `null`
(the default) = "initial" / a candidate to upload; `"omit"` = skip; `"uploaded"`
= already sent. Toggled per-poster and by the header Upload button (see Extension
notes). Only `"omit"`/`"uploaded"` are stored — anything else (incl. "initial")
normalizes back to `null`.

### HTTP API

`GET /health`, `GET|POST /captures` (POST accepts an optional `assignedDate` to
pin the date — still OCRs for a start time), `PATCH /captures/:id` (assignedDate
moves the file; title/venue/url/assignedTime/uploadState are metadata), `DELETE
/captures/:id`, `GET|POST /dates`, `DELETE /dates/:date`, `GET /venues`
(distinct venue names for autocomplete), `POST /backfill-images`, `GET
/images/<folder>/<file>`.

## Extension notes

- `background.js` (service worker) — context menu, capture flow, side-panel
  open, and **fetching the image bytes**. This is important: content scripts
  run in the page origin and are CORS-blocked from `fbcdn.net`, so the service
  worker fetches the bytes (it can, via `host_permissions`) and encodes them.
  Service workers have no `FileReader`, hence the manual ArrayBuffer→base64.
- `content.js` — runs on Facebook; finds the image, picks best-resolution from
  `srcset`, scrapes caption + structured event data. `scrapeEventDetails()`
  merges most→least reliable: JSON-LD → `og:`/`event:` head meta → the visible
  event-page **header DOM** → document title. On logged-in SPA sessions JSON-LD
  and event:* meta are usually *absent*, so the header DOM is the practical
  source for date and venue: `scrapeEventHeaderFromDom()` anchors on the title
  leaf and reads the date line just above it and the venue line just below (FB
  order is date → title → venue). `parseHeaderDate()` resolves relative forms
  ("Today"/"Tomorrow"/weekday names, and ranges like "Saturday from 10:00-12:30")
  against the capture time into a local-naive ISO `startDate` with the start time
  embedded. All of this (and the meta/title name fallbacks) is gated to
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
  bottom-docked edit form (title/venue/date/time/url + duplicate warning) that
  also opens on capture, and delete. The Venue field autocompletes from a native
  `<datalist>` populated (each render) from `GET /venues` unioned with venues on
  the loaded captures. Server is the source of truth; pending local captures
  merge on top.
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
      needed) so new posters appear. The poster URL is sent as the API's
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
- Match the surrounding style: small focused functions, comments explaining
  *why* (especially the CORS/date-precedence/serialized-write decisions).
