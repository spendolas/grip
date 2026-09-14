#!/usr/bin/env bash
# Install the grip daemon as a macOS **Login Item** — the same mechanism
# Claude Hub and FigmaAgent use (a .app launched at login, reparented to
# launchd). This is what actually works on this machine: a hand-rolled
# LaunchAgent plist `launchctl bootstrap` errored, but Login Item .apps run
# fine from the cloud/secondary volume (Hub proves it).
#
# Builds "Grip Daemon.app" in /Applications whose executable IS the
# persistent daemon (GRIP_PERSISTENT=1 → never idle-exits), registers it as a
# hidden login item, and launches it now.
#
# Run as YOURSELF (not sudo) — the login item must belong to your user. The
# script builds the bundle in a temp dir and elevates ONLY the copy into
# /Applications (sudo prompts just for that step if needed).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST="$(cd "$SCRIPT_DIR/.." && pwd)/dist/index.js"
NODE="$(command -v node)"
APP="/Applications/Grip Daemon.app"

if [[ $EUID -eq 0 ]]; then
  echo "error: don't run this with sudo — the login item would be registered for root." >&2
  echo "       Run it as yourself; it will sudo only the /Applications copy if needed." >&2
  exit 1
fi
if [[ ! -f "$DIST" ]]; then
  echo "error: $DIST not found — run 'npm run build' in bridge/ first." >&2
  exit 1
fi

# Remove a stale copy from the old ~/Applications location, if present.
rm -rf "$HOME/Applications/Grip Daemon.app" 2>/dev/null || true

echo "node: $NODE"
echo "dist: $DIST"
echo "app:  $APP"

# --- build the .app bundle in a temp dir, then place it in /Applications ---
BUILD="$(mktemp -d)/Grip Daemon.app"
mkdir -p "$BUILD/Contents/MacOS"

cat > "$BUILD/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Grip Daemon</string>
  <key>CFBundleIdentifier</key><string>com.grip.bridge.daemon</string>
  <key>CFBundleExecutable</key><string>grip-daemon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <!-- LSUIElement: no Dock icon, no window — a background agent. -->
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

# The bundle executable IS the daemon (exec → the .app process becomes node).
cat > "$BUILD/Contents/MacOS/grip-daemon" <<LAUNCHER
#!/bin/bash
export GRIP_PERSISTENT=1
# A daemon may already own the port (e.g. an on-demand shim spawned one);
# ours exits immediately on a lost bind, which macOS may relaunch. That's
# fine — steady state is one persistent daemon holding the port.
exec "$NODE" "$DIST" --daemon
LAUNCHER
chmod +x "$BUILD/Contents/MacOS/grip-daemon"

# Place into /Applications, elevating only if the dir isn't user-writable.
if [[ -w "/Applications" ]]; then
  rm -rf "$APP"; mv "$BUILD" "$APP"
else
  echo "(/Applications needs admin — sudo will prompt for the copy only)"
  sudo rm -rf "$APP"; sudo mv "$BUILD" "$APP"
  sudo chown -R "$(id -u):$(id -g)" "$APP" 2>/dev/null || true
fi

# --- register as a login item (idempotent: remove any prior, then add) ---
osascript -e 'tell application "System Events" to delete (every login item whose name is "Grip Daemon")' 2>/dev/null || true
osascript -e "tell application \"System Events\" to make login item at end with properties {path:\"$APP\", hidden:true}" >/dev/null

echo
echo "registered login item:"
osascript -e 'tell application "System Events" to get the name of every login item' 2>/dev/null | tr ',' '\n' | grep -i grip || true

# --- start it now (frees the port for the persistent daemon first) ---
lsof -ti:7777 2>/dev/null | while read -r pid; do kill "$pid" 2>/dev/null || true; done
sleep 1
open "$APP"
sleep 2
echo
if grep -q '"persistent": true' "$HOME/.grip-bridge.status" 2>/dev/null; then
  echo "grip persistent daemon running:"
  grep -E '"pid"|"version"|"httpPort"|"persistent"' "$HOME/.grip-bridge.status"
else
  echo "started (check ~/.grip-bridge.log); if a non-persistent daemon still holds"
  echo "the port, it's an active stdio shim — resolves once grip is HTTP-only."
fi
echo
echo "Grip will now start at every login. Register it (once) if not already:"
echo "  claude mcp remove -s user grip; claude mcp add --transport http -s user grip http://127.0.0.1:7778/mcp"
