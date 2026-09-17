# Native messaging host — auto-start the local server

Lets the extension's side panel launch the local server (`server/server.js`)
when it isn't already running, so you don't have to start it by hand. When the
panel loads and `http://127.0.0.1:3777/health` doesn't answer, it sends a
message to this host, which spawns the server detached and exits.

Browsers can't start a local process directly; Chrome's [native messaging]
API is the supported bridge. Only the extension listed in the host manifest's
`allowed_origins` may talk to it.

## Files

- `host.mjs` — the host. Reads one framed message, spawns `node ../server/server.js`
  detached (survives the host exiting), replies, exits. A redundant launch is
  harmless: the server refuses a second bind on port 3777.
- `event_catalog_host.bat` — wrapper Chrome launches on Windows (it can only
  run an executable by path there). Runs `host.mjs` with node from `PATH`.
- `install.ps1` / `install.cmd` — Windows: writes the host manifest JSON and
  the Chrome registry key for the current user.
- `event_catalog_host.sh` — the macOS equivalent wrapper; just `exec`s `host.mjs`.
- `install.sh` — macOS: writes the host manifest JSON straight into Chrome's
  per-user `NativeMessagingHosts` directory (no registry on macOS).

## Install (one time)

### Windows

1. Load the extension unpacked at `chrome://extensions` (Developer mode) if you
   haven't. Copy its **ID** from the Event Poster Catalog card.
2. Double-click `install.cmd` (or run it in a terminal) and paste the ID when
   prompted — or `install.cmd <extension-id>`.
3. Back on `chrome://extensions`, click reload (↻) on the extension so the new
   `nativeMessaging` permission takes effect, then reopen the side panel.

### macOS

1. Load the extension unpacked at `chrome://extensions` (Developer mode) if you
   haven't. Copy its **ID** from the Event Poster Catalog card.
2. `cd native-host && ./install.sh <extension-id>` (or run `./install.sh` and
   paste the ID when prompted; `chmod +x install.sh` first if needed).
3. Back on `chrome://extensions`, click reload (↻) on the extension so the new
   `nativeMessaging` permission takes effect, then reopen the side panel.

That's it — from then on, opening the panel with the server down starts it
automatically (a brief "Starting local server…" status shows).

## Notes

- **Windows:** the registry key is
  `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.cameronwills.event_catalog`.
  To uninstall: `reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.cameronwills.event_catalog" /f`.
  For a Chromium-based browser other than Chrome, add the same key under that
  browser's hive (e.g. `HKCU\Software\Chromium\NativeMessagingHosts\...`).
- **macOS:** the manifest lives at
  `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.cameronwills.event_catalog.json`.
  To uninstall: delete that file. For Chrome Beta/Canary or Chromium, copy the
  same manifest into that variant's `NativeMessagingHosts` directory under
  `~/Library/Application Support/`.
- The extension ID changes if you load the extension from a different folder;
  re-run the installer with the new ID if that happens.
- The server starts with no visible console. To see its logs, start it
  manually instead — `event catalog server.cmd` (Windows) or
  `event catalog server.command` (macOS), both in the repo root.

[native messaging]: https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
