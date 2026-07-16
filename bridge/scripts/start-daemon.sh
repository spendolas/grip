#!/usr/bin/env bash
# Start the grip daemon detached + persistent (HTTP :7778 + WS :7777 + IPC),
# nohup-style — the gaffer approach. Use this instead of launchd: grip's code
# lives on a secondary APFS volume mounted `noowners` (/Volumes/…/CloudStorage),
# and launchd refuses to bootstrap an agent whose program is on such a volume
# ("Bootstrap failed: 5: Input/output error"). nohup has no such restriction.
#
# Idempotent. Run it once, and/or have Claude Hub run it at startup (the way
# gaffer's AE panel runs its start.sh), and/or add it to your shell profile.
# It survives the launching shell (reparented to init) but does NOT restart on
# crash — re-run to recover (or let Hub re-run it on its next launch).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST="$(cd "$SCRIPT_DIR/.." && pwd)/dist/index.js"
NODE="$(command -v node)"
LOG="$HOME/.grip-bridge.log"
STATUS="$HOME/.grip-bridge.status"

if [[ ! -f "$DIST" ]]; then
  echo "error: $DIST not found — run 'npm run build' in bridge/ first." >&2
  exit 1
fi

# Already running persistently? Nothing to do.
if [[ -f "$STATUS" ]] && grep -q '"persistent": true' "$STATUS" 2>/dev/null && lsof -ti:7777 >/dev/null 2>&1; then
  echo "grip persistent daemon already running:"
  grep -E '"pid"|"version"|"httpPort"|"persistent"' "$STATUS"
  exit 0
fi

# An on-demand (non-persistent) daemon may hold the port; replace it so the
# persistent one — which never idle-exits — owns :7777.
lsof -ti:7777 2>/dev/null | while read -r pid; do kill "$pid" 2>/dev/null || true; done
sleep 1

GRIP_PERSISTENT=1 nohup "$NODE" "$DIST" --daemon >>"$LOG" 2>&1 &
disown || true
sleep 2

if [[ -f "$STATUS" ]]; then
  echo "grip daemon started:"
  grep -E '"pid"|"version"|"httpPort"|"persistent"' "$STATUS"
else
  echo "started; check $LOG"
fi
echo
echo "Register grip by URL (once):"
echo "  claude mcp add --transport http -s user grip http://127.0.0.1:7778/mcp"
