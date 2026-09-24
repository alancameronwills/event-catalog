# CLAUDE.md

Guidance for working in this repo. See `plan.md` for the original design and
build order; this file captures how things actually fit together now.

## What this is

A personal "assisted capture" tool for saving event posters into a WordPress
site's event listing, with duplicate detection.

- **`extension/`** — a Chrome MV3 extension. Right-click (or Ctrl+Shift+E) a
  poster on *any* web page to capture it, or click the side panel header's
  **Paste** button to capture whatever image is currently on the system
  clipboard; a side panel is an editor for everything currently on the site.
  The content script runs on `<all_urls>` and `host_permissions` is
  `http(s)://*/*` (the service worker needs it to fetch image bytes from any
  CDN, and the panel needs it to fetch poster images for hashing/upload); the
  panel also has the `clipboardRead` permission for the Paste button. Capture
  and generic scraping (image, caption, JSON-LD Event) work everywhere; the
  Facebook-specific enrichment stays gated to FB event pages (`onEventPage()`).

**There is no custom backend.** The extension talks straight to Pawb
(`gigiau.uk/pawb`), a WordPress site running the `gigiau-events-posters`
plugin (a separate repo — see "The Pawb REST API" below). Pawb *is* the
catalog: a captured poster with a title and venue is posted there
immediately; anything missing is held in `chrome.storage.local` until
completed, then synced. There is no "select which posters to upload" step —
every valid poster is already live.

*(An earlier design ran a shared AWS Lambda/DynamoDB/S3 backend, and before
that a local Node server, each with a batch "upload selected posters to
Pawb" step. Both were removed once the extension started talking to Pawb
directly — there's nothing left to migrate from.)*

## The Pawb REST API

The extension is a client of `gigiau.uk/pawb`'s WordPress plugin (source at
a separate repo/path — ask if you need to change it). It uses the plugin's
`gigiau/v1` REST namespace:

- `GET /events` — public callers get a minimal `{id, title, start}` list of
  current/future events. A caller authenticated as an admin (WordPress
  Application Password, HTTP Basic Auth) instead gets every field needed to
  edit each event: `id, title, dtstart, dtend, venue, dtinfo, bookinglink,
  recurring, pending, rejected, picture, link`. The extension always
  authenticates, so it always gets the rich shape — see "Auth" below for how
  to detect the fallback-to-minimal case (bad/missing credentials don't
  error, they silently degrade).
- `POST /events` — admin-authenticated. Creates one event: `title`,
  `dtstart`, `dtend`, `venue`, `dtinfo`, `bookinglink`, multipart `picture`.
- `POST /events/<id>` — admin-authenticated. Updates an existing event's
  same fields (form-encoded body, no file needed unless replacing the
  poster). Never touches recurrence meta or approval state.
- `DELETE /events/<id>` — admin-authenticated. Deletes the event and its
  poster attachment.
- `GET /events/version` — same public/admin split as `GET /events`, but
  returns only `{version}`, a cheap opaque fingerprint over the same
  visible-event set (id + `post_modified_gmt` per post, hashed together).
  The panel polls this (not the full listing) to notice changes from other
  people using the panel concurrently, and only does a full refresh when it
  changes.

**Auth**: WordPress Application Password, sent as `Authorization: Basic
<base64(user:password)>`. Prompted once via `window.prompt` (username +
password), saved in `chrome.storage.local` (this browser profile only, never
in source), forgotten on a 401/403 so the next call re-prompts. Because the
capability check happens *inside* an otherwise-public route rather than via
the route's own `permission_callback`, a missing/wrong credential doesn't
error on `GET /events` — it just returns the minimal public shape. The panel
detects this by checking whether the first returned item has a `venue` key;
if not, it treats it as an auth failure.

**Recurring events**: `GET /events`'s `recurring` flag means the event's
`dtstart`/`dtend` are WordPress's *computed next occurrence*, not a literal
stored date — the recurrence pattern (day-of-week/nth-week/fortnight) lives
in meta the panel never reads or writes. The panel disables date editing for
these (title/venue/dtinfo/url stay editable); don't build a path that PATCHes
a recurring event's dates, or you'll silently corrupt the recurrence's
origin date.

## Extension notes

- `background.js` (service worker) — context menu, capture flow, side-panel
  open, and **fetching the image bytes**. This is important: content scripts
  run in the page origin and are CORS-blocked from CDNs (e.g. `fbcdn.net`),
  so the service worker fetches the bytes (it can, via `host_permissions`)
  and encodes them as a data URL. Service workers have no `FileReader`,
  hence the manual ArrayBuffer→base64. Background.js does **not** persist
  anything or talk to Pawb — it just scrapes + fetches bytes and hands the
  result to the panel via a `CAPTURE_ADDED` message; the panel owns every
  persistence decision.
- `content.js` — runs on every page; finds the image, picks best-resolution
  from `srcset`, scrapes caption + structured event data. **Image selection**
  identifies the target by tracking the actual element the cursor was over
  (`mouseover`/`contextmenu` listeners on `document`, capture phase) rather
  than re-searching the page for an `<img>` whose `src` matches the
  right-click's reported `srcUrl` — a page can have more than one `<img>`
  with the same URL (e.g. a "featured" item reusing a thumbnail from a list
  below it), and a URL search would silently grab the wrong copy. Those
  listeners read `event.composedPath()[0]`, not `event.target`: events
  crossing a shadow-DOM boundary get `target` *retargeted* to the shadow
  host, so a plain `e.target.closest("img")` finds nothing for elements
  inside a shadow root (e.g. the Pawb plugin's own event list on
  `moylgrove.wales`, which client-side-renders into `capsule.attachShadow({
  mode: "open" })`) — `composedPath()` isn't affected by that retargeting.
  The URL-search path (used as a fallback only when nothing has been
  tracked, e.g. right after an on-demand injection) has its own shadow-aware
  walk (`allImages()`) since `document.images` also misses shadow content.
  `scrapeEventDetails()` merges most→least reliable: JSON-LD → `og:`/`event:`
  head meta → the visible event-page **header DOM** → document title. On
  logged-in SPA sessions JSON-LD and event:* meta are usually *absent*, so
  the header DOM is the practical source for date and venue:
  `scrapeEventHeaderFromDom()` anchors on the title leaf and reads the date
  line just above it and the venue line just below (FB order is date → title
  → venue). `parseHeaderDate()` resolves relative forms ("Today"/"Tomorrow"/
  weekday names, and ranges like "Saturday from 10:00-12:30") against the
  capture time into a local-naive ISO `startDate` with the start time
  embedded. FB renders a *day-only* line for near dates, with the actual
  day-of-month in a calendar box just above it; that number (`parseBoxDay()`)
  is passed in to pin the exact month/year (`dateFromWeekdayAndDay()`) rather
  than guessing "the next Saturday", which would be wrong for events >7 days
  out that are still shown day-only. All of this (and the meta/title name
  fallbacks) is gated to `/events/<id>` pages — elsewhere og:title/
  document.title are just "Facebook". On an event page it also prefers the
  `og:image` cover as the poster (unless the user right-clicked a specific
  other image). Header scraping is best-effort and expected to need
  maintenance as FB's DOM shifts. Wrapped in a guarded IIFE so it's safe to
  inject more than once (the SW injects on demand into tabs that predate the
  extension). It does **not** fetch bytes.
- `dhash.js` — client-side perceptual image hashing (64-bit dHash via
  `OffscreenCanvas`, Hamming distance, threshold `DUP_THRESHOLD = 10/64`) for
  duplicate detection. Used only by `sidepanel.js`. This used to run
  server-side (via `sharp`); reimplemented here since there's no server left.
- `sidepanel/` — the catalog UI, and the only place that talks to Pawb: a
  date-grouped grid bucketed into collapsible **month** sections (earliest
  first; the current month starts open, others collapsed, and toggles
  persist across re-renders via `monthState`). Also: drag/copy-paste to move
  posters between dates, click-to-enlarge lightbox, a bottom-docked edit form
  (title/venue/start date+time/end date/dtinfo/url + duplicate warning) that
  also opens on capture, and delete.
    - **Entry identity** — a Pawb-backed entry has `entry.wpId` (the
      WordPress post id) and `entry.id = String(wpId)`; a captured-but-not-
      yet-valid entry lives only in `chrome.storage.local`, keyed by a
      `crypto.randomUUID()` `id`, and has no `wpId`. `entry.wpId` truthy is
      the one flag used everywhere to decide whether a write goes to Pawb or
      to local storage.
    - **Saving** (`syncEntry`, editor submit / drag-move / retry) — a
      Pawb-backed entry PATCHes straight through (`POST /events/<id>`, form-
      encoded). A local entry that becomes valid (title + venue, checked by
      `isUploadable()`) is created on Pawb immediately (multipart `POST
      /events`, reusing the fetched image bytes) and dropped from
      `chrome.storage.local`; if the create fails (offline, etc.) it stays
      local for the next retry. Still-invalid entries just get their fields
      updated in local storage.
    - **Not-yet-on-Pawb indicator** — each local entry's thumbnail shows a
      small square, bottom-left: red = incomplete (missing title/venue,
      click opens the editor), grey = valid but not yet synced (click
      retries the create). Nothing is shown once an entry is on Pawb. The
      header **Filter** button narrows the view to only these not-yet-synced
      items (there's no more "select which valid posters to upload" step —
      every valid poster is already live).
    - **Duplicate detection** — every loaded entry's image is hashed
      (`dhash.js`); Pawb-hosted images are cached by picture URL in
      `chrome.storage.local` (`imageHashCache`) across renders so an
      unchanged catalog isn't re-fetched/re-hashed each time, while local
      (not-yet-synced) entries are cheap to re-hash from their in-memory data
      URL. Any two currently-loaded entries within `DUP_THRESHOLD` are
      mutually flagged (`duplicateOf`/`duplicateDistance`), driving the
      `.dup-badge`, the editor's duplicate warning, and skip-confirm-on-
      delete for flagged items.
    - **Concurrent-user polling** — other people may have the panel open
      against the same Pawb catalog. While open, the panel polls `GET
      /events/version` every 60s and only does a full refresh
      (`loadCaptures()` + re-render) when the fingerprint changes, to avoid
      hitting the full listing on every tick. A write updates the stored
      fingerprint as part of its own refresh, so the next poll tick doesn't
      redundantly re-fetch a change already just rendered. If a write gets a
      404 back (someone else already deleted that event), it's treated as
      "removed elsewhere," not a failure.
    - **Prune on open** — `pruneOutdated()` runs once on load and
      permanently deletes stale **local** (not-yet-synced) entries whose
      effective date has passed; it never touches Pawb — a Pawb-backed event
      naturally stops appearing in `GET /events` once its own end date
      passes (the plugin's own date filtering), so there's nothing to delete
      there. "Unknown"-dated local items are spared.
    - **Custom "empty date" folders** — pure local convenience
      (`chrome.storage.local`, no server sync): lets the panel show an empty
      date column before anything is filed under it. Pawb has no matching
      concept.
    - **Drag-to-add** — dropping an image file, or an image dragged from a
      page, onto a date group captures it there as a local entry pinned to
      that date (it never has a title, so it's always held locally until
      edited). Page drags are fetched in the panel itself: it's an extension
      page with blanket `host_permissions`, so it isn't CORS-blocked the way
      a content script would be. A document-level drop guard stops a stray
      drop from navigating the panel to the image URL.
    - **Paste-to-add** — the header's Paste button (`pasteFromClipboard()`)
      reads `navigator.clipboard.read()` for an `image/*` item and, if found,
      captures it the same way a right-click capture is handled
      (`addNewLocalCapture()`, shared with the `CAPTURE_ADDED` listener):
      held locally, editor opened immediately in "new capture" mode so
      Cancel/Escape discards it if unused. No image on the clipboard is a
      silent no-op — there's no capture-date context to pin it to (unlike a
      date-group drop), so it's grouped like any other undated capture (by
      `capturedAt`, i.e. today) until assigned a date in the editor.

Facebook's DOM changes often — the image path is robust, but caption/date
scraping is expected to need occasional maintenance.

## Conventions

- ES modules, no build step. `sidepanel.js` is loaded as `type="module"`
  (it imports `../dhash.js`); `background.js`/`content.js` are classic
  scripts (MV3 service worker / content script — no `import`).
- No test framework. Verify JS with `node --check <file>` for syntax
  (`node --input-type=module --check < file.js` for `sidepanel.js`, since
  it's an ES module). **Chrome is available on this dev machine** with the
  extension already loaded as an unpacked side panel — after any change,
  reload it via `chrome://extensions` and actually exercise the flow
  (capture, edit, delete, drag, duplicate warning) rather than relying on
  static checks alone.
- Changing the Pawb plugin (`gigiau-events-posters`, a separate repo/path —
  the local dev copy lives under UniServer) is a separate change with its
  own branch. Syntax-check with the UniServer-bundled PHP CLI (e.g.
  `core\php83\php.exe -l gigio.php`), then curl smoke-test against the local
  UniServer WordPress site (start UniServer's control panel yourself — it's
  not always running) before exercising it from the extension. Shipping a
  plugin change to the live `gigiau.uk` site is a separate, later step via
  that repo's own `release.ps1` process.
- Match the surrounding style: small focused functions, comments explaining
  *why* (especially auth/date-precedence/entry-identity decisions).
