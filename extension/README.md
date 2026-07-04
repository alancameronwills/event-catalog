# Event Poster Catalog — Chrome Extension

Assisted capture of Facebook event posters into a local, date-organized
catalog. This is the extension half of the project (see `../plan.md`).

## Status

**Steps 1–2 (done).** Manifest, right-click capture, keyboard shortcut, and a
working side-panel catalog. Captures POST to the local Node server (see
`../server`), which stores images on disk and keeps a JSON index; the side
panel reads back from it. If the server is offline, captures fall back to
`chrome.storage.local` and the panel keeps showing them until the server is
back. Perceptual hashing and OCR come next (steps 3–4).

> Start the server first: `cd server && npm start`. It listens on
> `http://127.0.0.1:3777`, matching `SERVER_URL` in `background.js` /
> `sidepanel/sidepanel.js`.

## Load it in Chrome

1. Go to `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this `extension/` folder.
4. Pin the extension and click its icon to open the side panel.

## Use it

- **Right-click** any image on Facebook → **Add to event catalog**.
- Or hover an image and press **Ctrl+Shift+E**.
- The side panel shows captured posters grouped by event date (falling back to
  capture date), newest first.

On a proper Facebook **Event** page, structured details (name, start/end date,
venue) are pulled from the page's JSON-LD. On ordinary posts, the nearby
caption text is captured instead; date extraction from the poster image itself
comes later via OCR (step 4).

### Organizing by date

- **New date**: click **+ New date** in the panel header and pick a day. Empty
  dates show a drop zone so you can pre-create the days you expect events on.
- **Move an item — drag**: drag a thumbnail onto another date group.
- **Move an item — copy/paste**: click a thumbnail to select it, press
  **Ctrl/Cmd+C**, click the target date group (it highlights), then press
  **Ctrl/Cmd+V**. `Esc` clears the selection.
- Moving reassigns the item's date on the server and relocates its image file
  into the matching date folder. Remove an empty date with the **×** on its
  heading.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest, permissions, side panel + command |
| `background.js` | Service worker: context menu, capture flow, storage |
| `content.js` | Runs on Facebook: finds the image + scrapes metadata |
| `sidepanel/` | Catalog UI (grouped thumbnail grid) |

## Known limitations (expected; addressed in later steps)

- Facebook may block or expire image URLs; the content script inlines image
  bytes as a data URL to avoid re-fetching. These bytes now go to the server
  and are written to disk — `chrome.storage.local` only holds captures made
  while the server was offline.
- Caption/date scraping depends on Facebook's DOM and may need occasional
  maintenance (step 6).
- No duplicate detection yet (steps 3–4).
