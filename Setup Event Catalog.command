#!/bin/bash
# One-time setup for the Event Catalog local server on macOS. Double-click
# this file (right-click > Open the very first time — macOS blocks a freshly
# downloaded script by default). It:
#
#   1. Checks Node.js is installed (Node's own installer needs a human to
#      click through it, so this just opens the download page if it's missing).
#   2. Installs the server's dependencies (npm install).
#   3. Registers a background service (launchd) that starts the local server
#      automatically at login and restarts it if it ever crashes — so there's
#      nothing to remember to start by hand, and no Terminal step for the
#      browser extension to reach it.
#
# Safe to double-click again later (e.g. after downloading an update) — every
# step here is idempotent.

set -u
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
server_dir="$dir/server"
label="com.cameronwills.event-catalog-server"
plist="$HOME/Library/LaunchAgents/$label.plist"
port=3777

say() { echo ""; echo "== $1 =="; }
notify() {
  osascript -e "display dialog \"$1\" buttons {\"OK\"} default button 1 with icon $2 with title \"Event Catalog Setup\"" >/dev/null 2>&1
}
fail() {
  notify "$1" "stop"
  echo "ERROR: $1" >&2
  read -r -p "Press Return to close this window..." _ignored
  exit 1
}

say "Checking for Node.js"
node_path="$(command -v node || true)"
if [ -z "$node_path" ]; then
  notify "Event Catalog needs Node.js, which isn't installed yet. This will open the Node.js download page — install it (the button labeled LTS), then double-click this setup file again." "note"
  open "https://nodejs.org/"
  exit 0
fi
echo "Found node at $node_path ($("$node_path" --version))"

say "Installing server dependencies (this can take a minute)"
if ! ( cd "$server_dir" && npm install ); then
  fail "Installing dependencies failed. Check you're connected to the internet, then run this setup again."
fi

say "Setting up the background server"
mkdir -p "$HOME/Library/LaunchAgents" "$server_dir/data"
log_file="$server_dir/data/server.log"

cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$node_path</string>
    <string>$server_dir/server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$server_dir</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$log_file</string>
  <key>StandardErrorPath</key>
  <string>$log_file</string>
</dict>
</plist>
PLIST

launchctl unload "$plist" >/dev/null 2>&1
if ! launchctl load "$plist"; then
  fail "Could not start the background service. Try restarting your Mac and running this setup again."
fi

say "Waiting for the server to answer"
ok=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS --max-time 1 "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 1
done

if [ -z "$ok" ]; then
  fail "The server didn't start. Look at $log_file for details, or try restarting your Mac and running this setup again."
fi

say "Done"
echo "The Event Catalog server is running at http://127.0.0.1:$port"
echo "It will start automatically every time you log in from now on."
echo ""
echo "Next: open Chrome and load the extension folder — see the setup guide."
notify "The Event Catalog server is set up and running in the background — it will start automatically every time you log in.\n\nNext: open Chrome and load the extension. See the setup guide for those steps." "note"

read -r -p "Press Return to close this window..." _ignored
