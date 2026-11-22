#!/usr/bin/env bash
# Install the bridge as a launchd LaunchAgent — one long-lived daemon
# (WS + IPC socket + HTTP) that starts at login and respawns on
# crash. This is what makes the HTTP transport reliable for any MCP client:
# clients connect directly by URL with no per-process shim to die mid-call.
# Names and ports come from the flavour file (see _flavour.sh).
#
# After running this, register the bridge by URL:
#   claude mcp add --transport http -s user <mcp name> http://127.0.0.1:<http port>/mcp
#
# Uninstall: launchctl unload ~/Library/LaunchAgents/<label>.plist && rm it.
#
# GRIP_DRYRUN=1 prints the rendered plist and each planned action to stdout and
# runs no launchctl and no kill (used by test/launchd-render.mjs).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/_flavour.sh"
LABEL="$F_LAUNCH_LABEL"
DIST="$(cd "$SCRIPT_DIR/.." && pwd)/dist/index.js"
NODE="$(command -v node)"
PLIST_DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
TEMPLATE="$SCRIPT_DIR/launchd.plist.template"
STATUS="$HOME/${F_PREFIX}.status"
DRYRUN="${GRIP_DRYRUN:-}"

if [[ -z "$DRYRUN" && ! -f "$DIST" ]]; then
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

# Preflight: launchd refuses to bootstrap an agent whose program lives on a
# volume mounted `noowners` (secondary APFS, cloud mounts like
# /Volumes/…/CloudStorage). It returns a cryptic "Bootstrap failed: 5:
# Input/output error". Detect it up front and redirect to the nohup starter.
if [[ -z "$DRYRUN" ]] && mount | grep -F " $(df "$DIST" | awk 'NR==2{print $NF}') " | grep -q noowners 2>/dev/null; then
  echo
  echo "error: '$DIST' is on a 'noowners' volume — launchd will not run an agent from here" >&2
  echo "       (this is why 'Bootstrap failed: 5: Input/output error' happens)." >&2
  echo "       Use the nohup starter instead (no launchd needed):" >&2
  echo "         bash \"$SCRIPT_DIR/start-daemon.sh\"" >&2
  exit 1
fi

# Refuse before touching anything when the port is held by something that is
# not our own daemon.
OWN_PID="$(own_pid)"
while read -r pid; do
  [[ -z "$pid" ]] && continue
  if [[ "$pid" != "$OWN_PID" ]]; then
    echo "port ${F_WS_PORT} is held by another program (pid $pid), not stopping it" >&2
    exit 1
  fi
done < <(lsof -ti:"${F_WS_PORT}" 2>/dev/null || true)

DOMAIN="gui/$(id -u)"

# Fill the template's placeholders from the flavour (values XML-escaped).
render_plist() {
  F_LABEL="$LABEL" F_WS="$F_WS_PORT" F_HTTP="$F_HTTP_PORT" F_FILE_PREFIX="$F_PREFIX" \
  F_HOMEPATH="$HOME" F_NODEPATH="$NODE" F_DISTPATH="$DIST" node -e '
    const e = process.env;
    const x = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const map = {
      __LABEL__: e.F_LABEL, __WS_PORT__: e.F_WS, __HTTP_PORT__: e.F_HTTP,
      __FILE_PREFIX__: e.F_FILE_PREFIX, __HOME__: e.F_HOMEPATH, __NODE__: e.F_NODEPATH, __DIST__: e.F_DISTPATH,
    };
    let s = require("fs").readFileSync(process.argv[1], "utf8");
    for (const k in map) s = s.split(k).join(x(map[k]));
    process.stdout.write(s);
  ' "$TEMPLATE"
}

if [[ -n "$DRYRUN" ]]; then
  echo "plan: launchctl bootout $DOMAIN/$LABEL"
  echo "plan: write $PLIST_DEST"
  render_plist
  echo "launchctl bootstrap $DOMAIN $PLIST_DEST"
  [[ -n "$OWN_PID" ]] && lsof -ti:"${F_WS_PORT}" 2>/dev/null | grep -qx "$OWN_PID" && echo "kill $OWN_PID"
  echo "launchctl kickstart -k $DOMAIN/$LABEL"
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents"

# Tear down any previous instance (modern launchctl; ignore errors).
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true

render_plist > "$PLIST_DEST"

# Load into the GUI domain (launchctl load is deprecated + I/O-errors on
# modern macOS; bootstrap is the current path).
launchctl bootstrap "$DOMAIN" "$PLIST_DEST"

# Hand the port to the persistent daemon: stop our own on-demand daemon (the
# pid in our status file, never another program) holding the port, then
# (re)start our service. On-demand daemons exit on a lost bind, so once ours
# holds the port (GRIP_PERSISTENT, never idle-exits) it keeps it; any racing
# shim-spawned daemon loses and exits. Retry until the status file reports
# persistent:true.
for i in 1 2 3 4 5; do
  free_own_port
  launchctl kickstart -k "$DOMAIN/$LABEL" 2>/dev/null || true
  sleep 1
  if grep -q '"persistent": true' "$STATUS" 2>/dev/null; then break; fi
done

echo
if [[ -f "$STATUS" ]]; then
  echo "${F_DISPLAY} daemon status:"
  cat "$STATUS"
else
  echo "warning: no status file yet — check ~/${F_PREFIX}.log"
fi
echo
echo "Next: register ${F_MCP_NAME} by URL (once):"
echo "  claude mcp add --transport http -s user ${F_MCP_NAME} http://127.0.0.1:${F_HTTP_PORT}/mcp"
