#!/usr/bin/env node
import { createRequire as __createRequire } from "module";
const require = __createRequire(import.meta.url);

// src/install.ts
import { execFileSync as execFileSync2 } from "node:child_process";
import { chmodSync as chmodSync2, copyFileSync as copyFileSync2, existsSync as existsSync2, mkdirSync as mkdirSync2, readdirSync, readFileSync as readFileSync2, renameSync as renameSync2, rmSync as rmSync2, statSync, writeFileSync as writeFileSync2 } from "node:fs";
import { homedir as homedir2, platform } from "node:os";
import { dirname as dirname2, join as join2 } from "node:path";
import { fileURLToPath } from "node:url";

// src/update.ts
import { execFile, execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

// src/types.ts
var BRIDGE_VERSION = "0.8.0";

// src/update.ts
var ASSET_BRIDGE = "grip-bridge.mjs";
var ASSET_SUMS = "SHA256SUMS.txt";
var ASSET_COMPAT = "compat.json";
var PLUGIN_ASSETS = {
  "grip-plugin-code.js": "code.js",
  "grip-plugin-ui.html": "ui.html",
  "grip-plugin-manifest.json": "manifest.json"
};
var UPDATE_ASSET_NAMES = [ASSET_BRIDGE, ...Object.keys(PLUGIN_ASSETS), ASSET_SUMS, ASSET_COMPAT];
var RELEASE_MAX_BYTES = 256 * 1024;
var SUMS_MAX_BYTES = 64 * 1024;
var COMPAT_MAX_BYTES = 4 * 1024;
var NOTICE_INTERVAL_MS = 3 * 24 * 60 * 60 * 1e3;
var FILE_MAX_BYTES = 5 * 1024 * 1024;
var CHECK_INTERVAL_MS = 24 * 60 * 60 * 1e3;
function gripHome() {
  return process.env.GRIP_HOME || join(homedir(), ".grip");
}
function statusFilePath() {
  return process.env.GRIP_STATUS_PATH ?? join(homedir(), ".grip-bridge.status");
}
function installRecordPath() {
  return join(gripHome(), "install.json");
}
function detectInstallSource(dir) {
  let d = resolve(dir);
  for (; ; ) {
    if (existsSync(join(d, ".git"))) return "clone";
    const up = dirname(d);
    if (up === d) return "release";
    d = up;
  }
}
function writeInstallRecord(source, version) {
  mkdirSync(gripHome(), { recursive: true });
  atomicWrite(installRecordPath(), Buffer.from(JSON.stringify({ source, version }, null, 2) + "\n"));
}
function atomicWrite(dest, data, mode) {
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, data, mode !== void 0 ? { mode } : void 0);
    renameSync(tmp, dest);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
    }
    throw err;
  }
}
function processCommandLine(pid) {
  try {
    if (process.platform === "win32") {
      return execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`
        ],
        { encoding: "utf8", timeout: 8e3, stdio: ["ignore", "pipe", "ignore"] }
      ).trim() || null;
    }
    return execFileSync(
      "ps",
      ["-o", "command=", "-p", String(pid)],
      { encoding: "utf8", timeout: 5e3, stdio: ["ignore", "pipe", "ignore"] }
    ).trim() || null;
  } catch {
    return null;
  }
}
function stopRunningDaemon() {
  let pid;
  try {
    const j = JSON.parse(readFileSync(statusFilePath(), "utf8"));
    pid = Number(j?.pid);
  } catch {
    return { stopped: false, note: "no running Grip daemon found (no status file)" };
  }
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) {
    return { stopped: false, note: "status file has no usable daemon pid; left it alone" };
  }
  try {
    process.kill(pid, 0);
  } catch {
    return { stopped: false, note: "status file is stale (that process is gone)" };
  }
  const cmd = processCommandLine(pid);
  if (!cmd) return { stopped: false, note: `could not verify pid ${pid} is a Grip daemon; left it running (restart your agent / Figma plugin to pick up the new bridge)` };
  if (!/grip-bridge/.test(cmd) || !/--daemon/.test(cmd)) {
    return { stopped: false, note: `pid ${pid} does not look like a Grip daemon; left it alone` };
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    return { stopped: false, note: `could not stop pid ${pid}: ${err.message}` };
  }
  return { stopped: true, note: `stopped the running Grip daemon (pid ${pid}); the new version starts on the next agent call` };
}

// src/install.ts
var args = new Set(process.argv.slice(2));
var wantHttp = args.has("--http");
var HOME = homedir2();
var PLAT = process.env.GRIP_FAKE_PLATFORM ?? platform();
var HERE = dirname2(fileURLToPath(import.meta.url));
var SOURCE_BRIDGE = join2(HERE, "grip-bridge.mjs");
var GRIP_HOME = gripHome();
var SOURCE_PLUGIN = [join2(HERE, "..", "figma-plugin"), join2(HERE, "figma-plugin")].find((d) => existsSync2(join2(d, "manifest.json")));
var INSTALL_TYPE = detectInstallSource(HERE);
var PLUGIN_DIR = join2(GRIP_HOME, "figma-plugin");
var ENTRY = join2(GRIP_HOME, "grip-bridge.mjs");
var HTTP_URL = "http://127.0.0.1:7778/mcp";
function log(msg = "") {
  process.stdout.write(msg + "\n");
}
function step(n, msg) {
  log(`\x1B[1m[${n}]\x1B[0m ${msg}`);
}
function ok(msg) {
  log(`  \x1B[32m\u2713\x1B[0m ${msg}`);
}
function warn(msg) {
  log(`  \x1B[33m!\x1B[0m ${msg}`);
}
function die(msg) {
  process.stderr.write(`\x1B[31merror:\x1B[0m ${msg}
`);
  process.exit(1);
}
function installBridge() {
  step(1, `Installing bridge \u2192 ${ENTRY}`);
  if (!existsSync2(SOURCE_BRIDGE)) {
    die(`grip-bridge.mjs not found next to this installer (looked in ${HERE}).
       Run this from the bridge/ folder of the Grip repo, or rebuild with 'npm run build'.`);
  }
  mkdirSync2(GRIP_HOME, { recursive: true });
  copyFileSync2(SOURCE_BRIDGE, ENTRY);
  try {
    chmodSync2(ENTRY, 493);
  } catch {
  }
  const kb = Math.round(readFileSync2(ENTRY).length / 1024);
  ok(`single file installed (${kb} KB, no dependencies)`);
  try {
    writeInstallRecord(INSTALL_TYPE, BRIDGE_VERSION);
    ok(`install type: ${INSTALL_TYPE === "clone" ? "developer clone (update with git pull)" : "release"}`);
  } catch {
    warn("could not write install.json; updates will treat this as a release install");
  }
}
function installPlugin() {
  if (!SOURCE_PLUGIN) {
    warn(`figma-plugin/ not found next to the installer (looked beside ${HERE}); skipped.`);
    warn("Import the plugin from your Grip checkout instead, and update it with git pull.");
    return false;
  }
  mkdirSync2(PLUGIN_DIR, { recursive: true });
  let n = 0;
  for (const name of readdirSync(SOURCE_PLUGIN)) {
    const src = join2(SOURCE_PLUGIN, name);
    if (name.startsWith(".") || !statSync(src).isFile()) continue;
    const dest = join2(PLUGIN_DIR, name);
    const tmp = `${dest}.tmp-${process.pid}`;
    copyFileSync2(src, tmp);
    renameSync2(tmp, dest);
    n++;
  }
  ok(`plugin copied (${n} files) \u2192 ${PLUGIN_DIR}`);
  return true;
}
function replaceRunningDaemon() {
  const r = stopRunningDaemon();
  if (r.stopped) ok(r.note);
  else log(`  \xB7 ${r.note}`);
}
function hasClaudeCli() {
  try {
    execFileSync2("claude", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
function registerViaCli() {
  try {
    execFileSync2("claude", ["mcp", "remove", "-s", "user", "grip"], { stdio: "ignore" });
  } catch {
  }
  try {
    const add = wantHttp ? ["mcp", "add", "--transport", "http", "-s", "user", "grip", HTTP_URL] : ["mcp", "add", "-s", "user", "grip", process.execPath, ENTRY];
    execFileSync2("claude", add, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
function registerViaJson() {
  const cfgPath = join2(HOME, ".claude.json");
  let cfg = {};
  if (existsSync2(cfgPath)) {
    try {
      cfg = JSON.parse(readFileSync2(cfgPath, "utf8"));
    } catch {
      die(`~/.claude.json exists but isn't valid JSON \u2014 fix or remove it, then re-run.`);
    }
  }
  cfg.mcpServers ??= {};
  cfg.mcpServers.grip = wantHttp ? { type: "http", url: HTTP_URL } : { command: process.execPath, args: [ENTRY] };
  writeFileSync2(cfgPath, JSON.stringify(cfg, null, 2));
  ok(`wrote grip server to ${cfgPath}`);
}
function registerMcp() {
  step(2, `Registering with your agent (${wantHttp ? "http" : "stdio"})`);
  if (hasClaudeCli() && registerViaCli()) ok(`registered via 'claude mcp add'`);
  else {
    warn("claude CLI not found (or add failed) \u2014 writing config directly");
    registerViaJson();
  }
}
function installPersistentDaemon() {
  step(3, `Installing always-on daemon (${PLAT})`);
  if (PLAT === "darwin") return daemonMac();
  if (PLAT === "win32") return daemonWindows();
  if (PLAT === "linux") return daemonLinux();
  warn(`no recipe for '${PLAT}'; start it yourself: node ${ENTRY} --daemon --persistent`);
}
function daemonMac() {
  const app = join2(HOME, "Applications", "Grip Daemon.app");
  const macos = join2(app, "Contents", "MacOS");
  rmSync2(app, { recursive: true, force: true });
  mkdirSync2(macos, { recursive: true });
  writeFileSync2(
    join2(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Grip Daemon</string>
  <key>CFBundleIdentifier</key><string>com.grip.bridge.daemon</string>
  <key>CFBundleExecutable</key><string>grip-daemon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
`
  );
  const launcher = join2(macos, "grip-daemon");
  writeFileSync2(launcher, [
    "#!/bin/bash",
    `trap 'kill "$CHILD" 2>/dev/null; exit 0' TERM INT`,
    "while true; do",
    `  GRIP_SUPERVISED=1 "${process.execPath}" "${ENTRY}" --daemon --persistent &`,
    "  CHILD=$!",
    '  wait "$CHILD"',
    "  sleep 5",
    "done",
    ""
  ].join("\n"));
  chmodSync2(launcher, 493);
  try {
    execFileSync2(
      "osascript",
      [
        "-e",
        'tell application "System Events" to delete (every login item whose name is "Grip Daemon")'
      ],
      { stdio: "ignore" }
    );
  } catch {
  }
  try {
    execFileSync2(
      "osascript",
      [
        "-e",
        `tell application "System Events" to make login item at end with properties {path:"${app}", hidden:true}`
      ],
      { stdio: "ignore" }
    );
    execFileSync2("open", [app], { stdio: "ignore" });
    ok("login item installed and started \u2014 runs at every login");
  } catch {
    warn(`could not register the login item; start it yourself: open "${app}"`);
  }
}
function daemonWindows() {
  const startup = join2(
    process.env.APPDATA ?? join2(HOME, "AppData", "Roaming"),
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup"
  );
  mkdirSync2(startup, { recursive: true });
  const vbsPath = join2(startup, "GripDaemon.vbs");
  writeFileSync2(
    vbsPath,
    `Set s = CreateObject("WScript.Shell")\r
s.Run """${process.execPath}"" ""${ENTRY}"" --daemon --persistent", 0, False\r
`
  );
  ok(`startup launcher written \u2192 ${vbsPath}`);
  try {
    execFileSync2("wscript", [vbsPath], { stdio: "ignore" });
    ok("daemon started");
  } catch {
    warn("could not start now; it will start at next sign-in");
  }
}
function daemonLinux() {
  const unitDir = join2(HOME, ".config", "systemd", "user");
  mkdirSync2(unitDir, { recursive: true });
  const unitPath = join2(unitDir, "grip-bridge.service");
  writeFileSync2(
    unitPath,
    `[Unit]
Description=Grip bridge daemon (Figma <-> MCP)

[Service]
ExecStart=${process.execPath} ${ENTRY} --daemon --persistent
Environment=GRIP_SUPERVISED=1
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`
  );
  ok(`systemd unit written \u2192 ${unitPath}`);
  try {
    execFileSync2("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
    execFileSync2("systemctl", ["--user", "enable", "--now", "grip-bridge"], { stdio: "ignore" });
    ok("service enabled and started");
    warn("to survive logout: loginctl enable-linger $USER");
  } catch {
    warn(`systemctl unavailable; start it yourself: node ${ENTRY} --daemon --persistent &`);
  }
}
log();
log("\x1B[1mGrip \u2014 installing the local bridge\x1B[0m");
log();
installBridge();
var pluginInstalled = installPlugin();
registerMcp();
replaceRunningDaemon();
if (wantHttp) installPersistentDaemon();
log();
log(`\x1B[1m\x1B[32mDone.\x1B[0m Grip ${BRIDGE_VERSION} installed.`);
log();
log("Next:");
log("  1. Restart your agent so it picks up the new server.");
if (pluginInstalled) {
  log("  2. In Figma: Plugins \u2192 Development \u2192 Import plugin from manifest\u2026");
  log(`     and choose \x1B[1m${join2(PLUGIN_DIR, "manifest.json")}\x1B[0m`);
  log("     (import THIS copy, not the repo folder, so updates can refresh it in place).");
} else {
  log("  2. In Figma: Plugins \u2192 Development \u2192 Import plugin from manifest\u2026");
  log("     and choose the \x1B[1mfigma-plugin\x1B[0m folder of your Grip checkout.");
}
log("  3. Run the plugin. Ask your agent to read your selection \u2014");
log("     the strip turns \x1B[32mgreen\x1B[0m.");
log();
if (INSTALL_TYPE === "clone") {
  log("Updating later: this is a developer install. Run `git pull && node bridge/install.mjs`");
  log("in your clone (the in-place updater never overwrites a clone install).");
} else {
  log('Updating later: ask your agent to "update Grip", click the plugin strip when it');
  log(`turns purple, or run: node ${ENTRY} update`);
}
log();
if (!wantHttp) log("  (on-demand: nothing stays running; the first call starts it.)");
log(`Logs: ~/.grip-bridge.log   Status: ~/.grip-bridge.status`);
