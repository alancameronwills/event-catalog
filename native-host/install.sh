#!/bin/bash
# Registers the Event Catalog native-messaging host with Chrome for the
# current macOS user. Run:
#   ./install.sh <extensionId>
# or just `./install.sh` and paste the ID when prompted.
#
# The extension ID is shown on chrome://extensions (Developer mode) under the
# Event Poster Catalog card. It's stable for an unpacked extension as long as
# you keep loading it from the same folder.

set -euo pipefail

host_name="com.cameronwills.event_catalog"
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
wrapper_path="$dir/event_catalog_host.sh"

extension_id="${1:-}"
if [ -z "$extension_id" ]; then
  read -r -p "Extension ID (from chrome://extensions): " extension_id
fi
extension_id="$(echo "$extension_id" | xargs)"
if [ -z "$extension_id" ]; then
  echo "No extension ID given." >&2
  exit 1
fi

chmod +x "$wrapper_path" "$dir/host.mjs" 2>/dev/null || true

# Chrome on macOS reads the host manifest straight from this per-user
# directory — no registry indirection like Windows needs. `path` points at
# the wrapper script; `allowed_origins` restricts which extension may talk
# to it.
target_dir="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
mkdir -p "$target_dir"
manifest_path="$target_dir/$host_name.json"

cat > "$manifest_path" <<JSON
{
  "name": "$host_name",
  "description": "Starts the Event Catalog local server for the extension.",
  "path": "$wrapper_path",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$extension_id/"]
}
JSON

echo ""
echo "Installed native messaging host:"
echo "  manifest:    $manifest_path"
echo "  host script: $wrapper_path"
echo "  extension:   $extension_id"
echo ""
echo "Reload the extension at chrome://extensions so the nativeMessaging"
echo "permission takes effect, then reopen the side panel."
