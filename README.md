# Event Poster Catalog

Capture event posters from any web page into one shared, date-organized
catalog with duplicate detection. Right-click a poster (or hover it and press
**Ctrl+Shift+E**) to save it; a Chrome side panel shows everyone's captures,
grouped by date.

All captures go straight to a shared AWS backend (see `aws/`), so every
install — Windows or Mac — sees the same catalog. There's nothing to install
on the machine besides Chrome itself: no Node.js, no local server, nothing
to keep running.

## Install (Windows or Mac — identical steps)

1. **Get the code.**
   - On the GitHub repo page, switch the branch selector to
     `aws-shared-catalog` (not yet merged into `main` — check with whoever's
     coordinating this if that's changed), then **Code → Download ZIP**.
   - Unzip it somewhere permanent, e.g. your Documents folder.
   - *(Technical alternative: `git clone -b aws-shared-catalog
     https://github.com/alancameronwills/event-catalog.git`.)*

2. **Load the extension in Chrome.**
   - Go to `chrome://extensions`.
   - Turn on **Developer mode** (top right).
   - Click **Load unpacked** and select the `extension` folder inside the
     folder from step 1.

3. **Pin it.**
   - Click the puzzle-piece icon in Chrome's toolbar, find **Event Poster
     Catalog**, and click its pin icon.

4. **Enter the shared API token.**
   - Click the extension's icon to open the side panel.
   - The first time, it prompts for an **API token** — ask whoever set up
     the shared catalog for this value and paste it in. It's saved in this
     browser only (`chrome.storage.local`), never written into the
     extension's code.

That's it — the panel should now show the shared catalog.

## Using it

- **Capture**: right-click a poster image on any page → **Add to event
  catalog**, or hover an image and press **Ctrl+Shift+E**.
- **Organize**: drag a poster onto another date group, or select it (click),
  copy (**Ctrl/Cmd+C**), click a date group, and paste (**Ctrl/Cmd+V**).
- **Edit**: click a poster to open the editor — title, venue, date/time, and
  a link, with autocomplete for venues you've used before.
- Everyone using the same token sees the same catalog, live.

## If something's wrong

- **Catalog looks empty / a capture didn't show up**: the token may be
  wrong — close and reopen the side panel. A rejected token is forgotten
  automatically, so you'll be prompted for it again.
- **No internet, or the shared backend is down**: a capture you make is
  still saved to this browser's local storage so nothing is lost, but it
  won't appear in the shared catalog (or anyone else's) until you're back
  online and capture it again.
- **Don't have a token**: ask whoever manages the shared catalog for one —
  see `aws/README.md` ("Wiring up the extension") if that's you.

## For whoever manages the shared catalog

Deploying/redeploying the AWS backend, rotating the token, migrating an old
local catalog, and cost/operational notes are all in `aws/README.md`. Repo
internals (data model, extension architecture, the superseded per-machine
local-server mode) are in `CLAUDE.md`.
