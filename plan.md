# Facebook Event Poster Catalog — Project Plan

## Problem

User browses Facebook pages looking for local events (posted either as regular
posts or as Facebook Events), usually featuring a poster image. When an
interesting event is found, the poster image is currently manually copied and
saved into a catalogue organized by date. Occasionally the same event gets
saved twice across different browsing sessions because there's no easy way to
check for duplicates while browsing.

Facebook prevents automated scraping, so this tool must be "assisted manual
capture" — the user points at something they want, and the tool captures it —
rather than an unattended crawler.

## Goals

1. One-click/right-click capture of a poster image while browsing Facebook.
2. Automatically pull along useful metadata where possible (post URL,
   caption text, and — if it's a proper Facebook Event page — the structured
   event date/time/venue).
3. Store captures in a local catalog, organized by date.
4. Detect and flag likely duplicates (same poster saved before) so the user
   doesn't have to remember what they've already captured.
5. Show the catalog as a browsable panel of thumbnails alongside the browser,
   so the user can check "have I already got this?" quickly.

## Architecture

### 1. Chrome Extension (Manifest V3)
- **Capture mechanism**: right-click context menu item ("Add to event
  catalog") on images, plus optionally a keyboard shortcut.
- **Content script**: on capture, grabs:
  - Full-resolution image (not the downscaled thumbnail rendering)
  - Nearby post caption text
  - If on a Facebook Event page: structured date/time/venue fields from the
    DOM
  - The post/event URL
- **Side panel** (native Chrome side panel API): shows the catalog UI —
  thumbnails grouped by date, with duplicate-warning badges, click-to-enlarge,
  and delete/edit actions.
- Sends captured data to the local server via `fetch` to `localhost`.

### 2. Local Server (Node.js)
- Receives captures from the extension.
- Runs:
  - **Perceptual hashing** (e.g. `blockhash-js` or similar) on the image to
    catch near-duplicates (re-shared, recompressed, cropped, or re-uploaded
    posters).
  - **OCR** (Tesseract.js) on the poster image, used as:
    - A fallback for event date if no structured date was captured (e.g. a
      plain post rather than a Facebook Event).
    - A secondary duplicate signal — near-identical extracted text is a
      strong hint even when perceptual hash distance is borderline.
- Compares new capture's hash/OCR text against existing catalog entries;
  flags "possible duplicate" above a similarity threshold rather than
  silently rejecting (avoid false negatives; let the user eyeball it).
- Stores:
  - Images on disk, organized into date-named folders.
  - An index (SQLite or lowdb/JSON) recording: file path, date added, event
    date, source URL, caption/OCR text, perceptual hash.

### 3. Catalog UI (in the side panel, or a pinned localhost tab)
- Thumbnail grid grouped by event date.
- Duplicate badge / warning on entries flagged as similar to an existing one.
- Click to enlarge; simple delete/edit metadata.

## Suggested Build Order

1. Scaffold the Chrome extension: manifest, context menu capture action,
   basic side panel shell.
2. Local Node server: endpoint to receive an image + metadata, save to disk,
   write to index.
3. Add perceptual hashing + duplicate check on ingest.
4. Add OCR (Tesseract.js) for date extraction and secondary duplicate
   signal.
5. Build out the side panel UI: thumbnail grid grouped by date, duplicate
   badges, enlarge/delete.
6. Polish: keyboard shortcut, error handling for Facebook DOM changes,
   settings (thresholds, storage location).

## Notes / Open Decisions

- Extension side panel vs. separate localhost tab for the catalog UI — side
  panel is more integrated but a pinned tab is simpler to build first.
- Duplicate threshold tuning will need some real-world testing once there's
  a decent number of captures to test against.
- Facebook's DOM structure changes occasionally; the image-capture path is
  robust, but caption/date scraping may need occasional maintenance.