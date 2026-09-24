# Event Poster Catalog

Capture event posters from any web page straight into the Pawb events
listing (`gigiau.uk/pawb`), with duplicate detection. Right-click a poster
(or hover it and press **Ctrl+Shift+E** or **Cmd+Shift+E**) to save it; a
Chrome side panel is an editor for everything currently on Pawb, grouped by
date.

## Install (Windows or Mac — identical steps)

1. **Get the code.**
   - On the GitHub repo page, click **Code → Download ZIP**.
   - Unzip it somewhere permanent, e.g. your Documents folder.
   - *(Technical alternative: `git clone
     https://github.com/alancameronwills/event-catalog.git`.)*

2. **Load the extension in Chrome.**
   - Go to `chrome://extensions`.
   - Turn on **Developer mode** (top right).
   - Click **Load unpacked** and select the `extension` folder inside the
     folder from step 1.

3. **Pin it.**
   - Click the puzzle-piece icon in Chrome's toolbar, find **Event Poster
     Catalog**, and click its pin icon.

4. **Sign in to Pawb.**
   - Click the extension's icon to open the side panel.
   - The first time it needs to talk to Pawb, it prompts for your
     **gigiau.uk username** and a WordPress **Application Password** — this
     is *not* your normal WordPress login password. It's a separate,
     revocable code for that account (create one under your WordPress profile → Application
     Passwords — ask whoever administers the site if you don't have an
     account with edit rights there). Both are saved in this browser only
     (`chrome.storage.local`), never written into the extension's code.

That's it — the panel should now show everything currently on Pawb.

## Using it

- **Capture**: right-click a poster image on any page → **Add to event
  catalog**, or hover an image and press **Ctrl+Shift+E**/**Cmd+Shift+E**.
  You can also copy an image (e.g. **Copy Image** on a web page, or copy a
  file) and click the **Paste** button in the panel header — it opens as a
  new event, ready to edit.
- **Organize**: drag a poster onto another date group, or select it (click),
  copy (**Ctrl/Cmd+C**), click a date group, and paste (**Ctrl/Cmd+V**).
- **Edit**: click a poster to open the editor — title, venue, date/time, and
  a link, with autocomplete for venues you've used before. A poster with a
  title and venue saves straight to Pawb; anything missing is held on this
  computer until you fill it in (shown with a red marker; the filter button
  in the header narrows the view to just these).
- Everyone with edit access sees the same catalog, live — the panel checks
  for other people's changes every minute or so while it's open.

## If something's wrong

- **Catalog looks empty, or edits don't stick**: your Pawb credentials may
  be wrong or expired — close and reopen the side panel, or make any edit;
  a rejected credential is forgotten automatically and you'll be prompted
  again.
- **No internet, or Pawb is unreachable**: a capture you make is still saved
  to this browser's local storage so nothing is lost, but it won't reach
  Pawb (or show up for anyone else) until you're back online — open the
  panel again once you are and it'll retry automatically.
- **Don't have Pawb credentials**: ask whoever administers gigiau.uk for a
  WordPress account with edit rights, then create an Application Password
  for it under your WordPress profile.
