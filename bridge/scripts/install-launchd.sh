#!/usr/bin/env bash
# Install grip's bridge as a launchd LaunchAgent — one long-lived daemon
# (WS :7777 + IPC socket + HTTP :7778) that starts at login and respawns on
# crash. This is what makes the HTTP transport reliable for Claude Hub:
# clients connect directly by URL with no per-process shim to die mid-call.
#
# After running this, register grip by URL:
#   claude mcp add --transport http -s user grip http://127.0.0.1:7778/mcp
#
# Uninstall: launchctl unload ~/Library/LaunchAgents/com.grip.bridge.plist && rm it.
set -euo pipefail

LABEL="com.grip.bridge"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST="$(cd "$SCRIPT_DIR/.." && pwd)/dist/index.js"
NODE="$(command -v node)"
PLIST_DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
TEMPLATE="$SCRIPT_DIR/$LABEL.plist.template"

if [[ ! -f "$DIST" ]]; then
  echo "error: $DIST not found — run 'npm run build' in bridge/ first." >&2
  exit 1
fi
if [[ -z "$NODE" ]]; then
  echo "error: node not found on PATH." >&2
  exit 1
fi

echo "node:  $NODE"
echo "dist:  $DIST"
echo "plist: $PLIST_DEST"

mkdir -p "$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"

# Tear down any previous instance (modern launchctl; ignore errors).
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true

sed -e "s|__NODE__|$NODE|g" \
    -e "s|__DIST__|$DIST|g" \
    -e "s|__HOME__|$HOME|g" \
    "$TEMPLATE" > "$PLIST_DEST"

# Load into the GUI domain (launchctl load is deprecated + I/O-errors on
# modern macOS; bootstrap is the current path).
launchctl bootstrap "$DOMAIN" "$PLIST_DEST"

# Hand the port to the persistent daemon: kill any on-demand daemon holding
# :7777, then (re)start our service. On-demand daemons exit on a lost bind,
# so once ours holds the port (GRIP_PERSISTENT, never idle-exits) it keeps
# it; any racing shim-spawned daemon loses and exits. Retry until the status
# file reports persistent:true.
for i in 1 2 3 4 5; do
  lsof -ti:7777 2>/dev/null | while read -r pid; do kill "$pid" 2>/dev/null || true; done
  launchctl kickstart -k "$DOMAIN/$LABEL" 2>/dev/null || true
  sleep 1
  if grep -q '"persistent": true' "$HOME/.grip-bridge.status" 2>/dev/null; then break; fi
done

echo
if [[ -f "$HOME/.grip-bridge.status" ]]; then
  echo "grip daemon status:"
  cat "$HOME/.grip-bridge.status"
else
  echo "warning: no status file yet — check ~/.grip-bridge.log"
fi
echo
echo "Next: register grip by URL (once):"
echo "  claude mcp add --transport http -s user grip http://127.0.0.1:7778/mcp"
