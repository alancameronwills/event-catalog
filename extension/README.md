# Event Poster Catalog — Chrome Extension

Assisted capture of event posters from any web page, saved straight to the
Pawb WordPress site (`gigiau.uk/pawb`). See the top-level `CLAUDE.md` for the
full architecture.

## Status

Captures POST directly to Pawb's REST API once they have a title and venue.
Anything missing is held in `chrome.storage.local` until completed in the
side panel, then synced automatically. The side panel is an editor for
whatever's currently on Pawb — it reads `GET /events` (authenticated via a
WordPress Application Password) and writes back with `POST`/`DELETE
/events/<id>`.

## Load it in Chrome

1. Go to `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this `extension/` folder.
4. Pin the extension and click its icon to open the side panel.

## Use it

- **Right-click** any image on any page → **Add to event catalog**.
- Or hover an image and press **Ctrl+Shift+E**.
- The side panel shows every event on Pawb, grouped by date (newest month
  first, current month expanded by default).

On a Facebook **Event** page, structured details (name, start/end date,
venue) are pulled from the page's JSON-LD or, failing that, the visible
event header. Elsewhere, generic `og:`/JSON-LD scraping and OCR of the
poster image itself fill in what they can; the editor is always shown after
a capture so anything missing can be filled in by hand.

### Organizing by date

- **New date**: click **+ New date** in the panel header and pick a day —
  a local-only placeholder so you can pre-create days you expect events on.
- **Move an item — drag**: drag a thumbnail onto another date group.
- **Move an item — copy/paste**: click a thumbnail to select it, press
  **Ctrl/Cmd+C**, click the target date group (it highlights), then press
  **Ctrl/Cmd+V**. `Esc` clears the selection.
- Moving a Pawb-backed poster updates its date on Pawb directly.

### Items not yet on Pawb

A capture missing a title or venue can't be posted yet — it's held locally
with a red indicator on the thumbnail. Fill in the details in the editor and
save; once it's valid it's created on Pawb automatically and the local copy
is dropped. The filter button (header) narrows the view to just these
not-yet-synced items.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest, permissions, side panel + command |
| `background.js` | Service worker: context menu, capture flow, image fetch |
| `content.js` | Runs on every page: finds the image + scrapes metadata |
| `dhash.js` | Client-side perceptual image hashing for duplicate detection |
| `sidepanel/` | Catalog UI — an editor for Pawb's content |

## Known limitations

- Caption/date scraping depends on page DOM structure (especially Facebook's)
  and may need occasional maintenance.
- Recurring Pawb events (weekly/fortnightly patterns set up in WordPress) are
  shown but not date-editable here — edit their recurrence in WordPress.
