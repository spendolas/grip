# Sourced by the other scripts: reads names and ports from flavour/flavour.json
# (the single source of build identity) into shell variables.
# GRIP_FLAVOUR_FILE points it at another flavour.json (tests only).
_FLAVOUR_JSON="${GRIP_FLAVOUR_FILE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)/flavour/flavour.json}"
eval "$(node -e '
const f = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const q = (v) => "\x27" + String(v).replace(/\x27/g, "\x27\\\x27\x27") + "\x27";
const out = {
  F_SLUG: f.slug, F_WS_PORT: f.wsPort, F_HTTP_PORT: f.httpPort, F_PREFIX: f.filePrefix,
  F_IPC_NAME: f.ipcName, F_MCP_NAME: f.mcpName, F_APP_NAME: f.daemonAppName, F_BUNDLE_ID: f.daemonBundleId,
  F_LAUNCH_LABEL: f.launchLabel, F_HOME_DIR: f.homeDirName, F_DISPLAY: f.displayName,
};
for (const k in out) console.log(k + "=" + q(out[k]));
' "$_FLAVOUR_JSON")"

# The pid this flavour's own daemon recorded in its status file (empty when there
# is none). Only this pid may be stopped to free the port: another flavour, or any
# other program, may legitimately hold it.
own_pid() {
  node -e '
    try {
      const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).pid;
      if (Number.isInteger(p) && p > 0) console.log(p);
    } catch {}
  ' "$HOME/${F_PREFIX}.status" 2>/dev/null || true
}

# Stop our own daemon if it holds the WS port; leave any other holder alone.
free_own_port() {
  local own pid
  own="$(own_pid)"
  [[ -z "$own" ]] && return 0
  for pid in $(lsof -ti:"${F_WS_PORT}" 2>/dev/null || true); do
    [[ "$pid" == "$own" ]] && { kill "$pid" 2>/dev/null || true; }
  done
}
