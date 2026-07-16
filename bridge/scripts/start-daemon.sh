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

# Claim the port for a PERSISTENT daemon. A shim from an active Claude
# session can respawn a non-persistent daemon the instant the port frees and
# win the bind (and, with Figma attached, hold it warm), so a single try
# races and loses. Retry: kill whatever holds :7777, immediately start our
# persistent daemon, verify it won (status persistent:true). It converges
# because once ours holds the port it never idle-exits, while shim-spawned
# ones lose the next bind and exit. Fully reliable only once the stdio
# registration is gone (no more shims) — see the remove/add step below.
for i in 1 2 3 4 5 6 7 8; do
  if [[ -f "$STATUS" ]] && grep -q '"persistent": true' "$STATUS" 2>/dev/null && lsof -ti:7777 >/dev/null 2>&1; then
    break
  fi
  lsof -ti:7777 2>/dev/null | while read -r pid; do kill "$pid" 2>/dev/null || true; done
  GRIP_PERSISTENT=1 nohup "$NODE" "$DIST" --daemon >>"$LOG" 2>&1 &
  disown || true
  sleep 1.5
done

if [[ -f "$STATUS" ]]; then
  echo "grip daemon started:"
  grep -E '"pid"|"version"|"httpPort"|"persistent"' "$STATUS"
  if ! grep -q '"persistent": true' "$STATUS" 2>/dev/null; then
    echo
    echo "note: a non-persistent daemon keeps winning the port — an active Claude"
    echo "      stdio session's shim is respawning it. HTTP still works, but it may"
    echo "      idle-exit when Figma is closed. It becomes persistent once no stdio"
    echo "      shims remain: switch the registration to HTTP (below) and restart your"
    echo "      Claude/Hub sessions, then re-run this script."
  fi
else
  echo "started; check $LOG"
fi
echo
echo "Register grip by URL (replaces the stdio entry):"
echo "  claude mcp remove -s user grip"
echo "  claude mcp add --transport http -s user grip http://127.0.0.1:7778/mcp"
