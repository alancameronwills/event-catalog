# Event Poster Catalog — Local Server

Receives captures from the browser extension, stores poster images on disk in
date-named folders, and maintains a JSON index. Zero dependencies — just Node.

## Status

**Step 2 — ingest server (done).** Save-to-disk + JSON index + REST API, wired
to the extension. Perceptual hashing (step 3) and OCR (step 4) will populate
the `hash` / `ocrText` / `duplicateOf` fields that are already reserved on each
index entry.

## Run it

```sh
cd server
npm start        # or: node server.js
```

Listens on `http://127.0.0.1:3777` by default. Leave it running while you
browse; the extension posts captures to it and the side panel reads from it.

### Configuration (environment variables)

| Var | Default | Meaning |
| --- | --- | --- |
| `CATALOG_PORT` | `3777` | Listen port (must match `SERVER_URL` in the extension) |
| `CATALOG_HOST` | `127.0.0.1` | Listen address |
| `CATALOG_DATA_DIR` | `server/data` | Where images + `index.json` live |
| `CATALOG_MAX_BODY` | `31457280` | Max request body in bytes (~30 MB) |
| `CATALOG_DUP_THRESHOLD` | `10` | Max Hamming distance (of 64) to flag a duplicate; lower = stricter |
| `CATALOG_OCR` | `1` | Run OCR on ingest; set `0` to disable |

## API

| Method & path | Purpose |
| --- | --- |
| `GET /health` | Liveness check → `{ ok: true }` |
| `POST /captures` | Store a capture (JSON body); returns the saved entry |
| `GET /captures` | The index array, newest first |
| `PATCH /captures/:id` | Update a capture — currently `{ "assignedDate": "YYYY-MM-DD" \| null }` to move it to another date (also relocates the image file) |
| `DELETE /captures/:id` | Remove a capture and its image file |
| `GET /dates` | User-created dates (may be empty) |
| `POST /dates` | Create a date — `{ "date": "YYYY-MM-DD" }` |
| `DELETE /dates/:date` | Remove a user-created date |
| `POST /backfill-images` | Re-fetch, store, hash + OCR any entries that have an `imageUrl` but no stored image; returns `{ attempted, saved, flagged, failed }` |
| `GET /images/<folder>/<file>` | Serve a stored image |

### Capture body

```json
{
  "id": "optional; generated if absent",
  "capturedAt": "ISO timestamp; defaults to now",
  "imageDataUrl": "data:image/jpeg;base64,...",
  "imageUrl": "https://... (original source, optional)",
  "caption": "nearby post text",
  "event": { "name": "...", "startDate": "...", "endDate": "...", "venue": "..." },
  "pageUrl": "https://www.facebook.com/...",
  "pageTitle": "..."
}
```

## Storage layout

```
data/
  index.json                     # array of entries, newest first
  dates.json                     # user-created dates (array of YYYY-MM-DD)
  ocr-cache/                     # Tesseract language data (downloaded once)
  images/
    2026-08-15/                  # effective date (see precedence below)
      <id>.png
```

The image folder is the entry's effective date: an explicit `assignedDate`
(set when the user moves an item) wins, otherwise `event.startDate`, otherwise
the capture date — so posters cluster by when the event happens, and moving an
item in the panel relocates its file to match.

## Duplicate detection

On ingest, each poster gets a 64-bit **perceptual hash** (dHash via `sharp`):
the image is shrunk to 9×8 grayscale and each pixel is compared to its right
neighbour. This survives rescaling and re-compression, so a re-shared poster
that Facebook has re-encoded still matches the original.

New captures are compared (Hamming distance) against every stored hash; the
closest within `CATALOG_DUP_THRESHOLD` is recorded on the entry as
`duplicateOf` (+ `duplicateDistance`). Nothing is rejected — the panel shows a
**dup?** badge so you can eyeball it and decide.

At startup, any captures saved before this feature are hashed in the background
(`backfillHashes`) so the whole catalog is comparable without a migration.

## OCR date extraction

On ingest, the poster image is run through **Tesseract** (`tesseract.js`). The
recognized text is stored on the entry as `ocrText`, and — when the capture has
**no** structured event date (an ordinary post rather than a Facebook Event) —
a date is parsed from that text into `ocrDate`.

The effective date used for grouping and the on-disk folder is, in order:
`assignedDate` → structured `event.startDate` → `ocrDate` → capture date. So a
plain post whose poster reads "Saturday 19 September" lands under that date
automatically.

The date parser understands common English formats — `15 August 2026`,
`Aug 15th`, `15/08/2026` (day-first), ISO `2026-08-15` — and infers a missing
year as the next upcoming occurrence. A single Tesseract worker is reused
across captures; the first run downloads language data into `data/ocr-cache/`.
Disable with `CATALOG_OCR=0`.

## Notes

- CORS is open (`*`) since it only binds to loopback.
- Index writes are serialized and written atomically (temp file + rename) so
  concurrent captures don't corrupt `index.json`.
- Path traversal on `/images/` is rejected (resolved path must stay inside the
  images directory).
