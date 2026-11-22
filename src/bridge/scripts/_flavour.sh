# Sourced by the other scripts: reads names and ports from flavour/flavour.json
# (the single source of build identity) into shell variables.
_FLAVOUR_JSON="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)/flavour/flavour.json"
eval "$(node -e '
const f = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const q = (v) => "\x27" + String(v).replace(/\x27/g, "\x27\\\x27\x27") + "\x27";
const out = {
  F_SLUG: f.slug, F_WS_PORT: f.wsPort, F_HTTP_PORT: f.httpPort, F_PREFIX: f.filePrefix,
  F_IPC_NAME: f.ipcName, F_MCP_NAME: f.mcpName, F_APP_NAME: f.daemonAppName, F_BUNDLE_ID: f.daemonBundleId,
};
for (const k in out) console.log(k + "=" + q(out[k]));
' "$_FLAVOUR_JSON")"
