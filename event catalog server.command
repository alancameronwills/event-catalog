#!/bin/bash
# Ensure the Event Catalog server is running on 127.0.0.1:3777.
#
# Idempotent: if the server already answers /health it does nothing, so this
# is safe to double-click anytime, or add to Login Items (System Settings ->
# General -> Login Items & Extensions) so the panel always has its backend.
#
# Double-clicking a .command file opens it in Terminal.app and runs it there,
# so logs stay visible; closing that window stops the server (it doesn't
# hot-reload, so that's also how you restart it after editing server/).

dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
port=3777

if curl -fsS --max-time 2 "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
  echo "Event Catalog server already running on 127.0.0.1:$port."
  sleep 2
  exit 0
fi

echo "Starting Event Catalog server..."
cd "$dir/server" || exit 1
exec node server.js
