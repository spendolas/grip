#!/usr/bin/env node
import { createRequire as __createRequire } from "module";
const require = __createRequire(import.meta.url);

// src/install.ts
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
var args = new Set(process.argv.slice(2));
var wantHttp = args.has("--http");
var HOME = homedir();
var PLAT = process.env.GRIP_FAKE_PLATFORM ?? platform();
var HERE = dirname(fileURLToPath(import.meta.url));
var SOURCE_BRIDGE = join(HERE, "grip-bridge.mjs");
var GRIP_HOME = join(HOME, ".grip");
var ENTRY = join(GRIP_HOME, "grip-bridge.mjs");
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
  if (!existsSync(SOURCE_BRIDGE)) {
    die(`grip-bridge.mjs not found next to this installer (looked in ${HERE}).
       Run this from the bridge/ folder of the Grip repo, or rebuild with 'npm run build'.`);
  }
  mkdirSync(GRIP_HOME, { recursive: true });
  copyFileSync(SOURCE_BRIDGE, ENTRY);
  try {
    chmodSync(ENTRY, 493);
  } catch {
  }
  const kb = Math.round(readFileSync(ENTRY).length / 1024);
  ok(`single file installed (${kb} KB, no dependencies)`);
}
function hasClaudeCli() {
  try {
    execFileSync("claude", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
function registerViaCli() {
  try {
    execFileSync("claude", ["mcp", "remove", "-s", "user", "grip"], { stdio: "ignore" });
  } catch {
  }
  try {
    const add = wantHttp ? ["mcp", "add", "--transport", "http", "-s", "user", "grip", HTTP_URL] : ["mcp", "add", "-s", "user", "grip", process.execPath, ENTRY];
    execFileSync("claude", add, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
function registerViaJson() {
  const cfgPath = join(HOME, ".claude.json");
  let cfg = {};
  if (existsSync(cfgPath)) {
    try {
      cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    } catch {
      die(`~/.claude.json exists but isn't valid JSON \u2014 fix or remove it, then re-run.`);
    }
  }
  cfg.mcpServers ??= {};
  cfg.mcpServers.grip = wantHttp ? { type: "http", url: HTTP_URL } : { command: process.execPath, args: [ENTRY] };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
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
  const app = join(HOME, "Applications", "Grip Daemon.app");
  const macos = join(app, "Contents", "MacOS");
  rmSync(app, { recursive: true, force: true });
  mkdirSync(macos, { recursive: true });
  writeFileSync(
    join(app, "Contents", "Info.plist"),
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
  const launcher = join(macos, "grip-daemon");
  writeFileSync(launcher, `#!/bin/bash
exec "${process.execPath}" "${ENTRY}" --daemon --persistent
`);
  chmodSync(launcher, 493);
  try {
    execFileSync(
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
    execFileSync(
      "osascript",
      [
        "-e",
        `tell application "System Events" to make login item at end with properties {path:"${app}", hidden:true}`
      ],
      { stdio: "ignore" }
    );
    execFileSync("open", [app], { stdio: "ignore" });
    ok("login item installed and started \u2014 runs at every login");
  } catch {
    warn(`could not register the login item; start it yourself: open "${app}"`);
  }
}
function daemonWindows() {
  const startup = join(
    process.env.APPDATA ?? join(HOME, "AppData", "Roaming"),
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup"
  );
  mkdirSync(startup, { recursive: true });
  const vbsPath = join(startup, "GripDaemon.vbs");
  writeFileSync(
    vbsPath,
    `Set s = CreateObject("WScript.Shell")\r
s.Run """${process.execPath}"" ""${ENTRY}"" --daemon --persistent", 0, False\r
`
  );
  ok(`startup launcher written \u2192 ${vbsPath}`);
  try {
    execFileSync("wscript", [vbsPath], { stdio: "ignore" });
    ok("daemon started");
  } catch {
    warn("could not start now; it will start at next sign-in");
  }
}
function daemonLinux() {
  const unitDir = join(HOME, ".config", "systemd", "user");
  mkdirSync(unitDir, { recursive: true });
  const unitPath = join(unitDir, "grip-bridge.service");
  writeFileSync(
    unitPath,
    `[Unit]
Description=Grip bridge daemon (Figma <-> MCP)

[Service]
ExecStart=${process.execPath} ${ENTRY} --daemon --persistent
Restart=on-failure

[Install]
WantedBy=default.target
`
  );
  ok(`systemd unit written \u2192 ${unitPath}`);
  try {
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
    execFileSync("systemctl", ["--user", "enable", "--now", "grip-bridge"], { stdio: "ignore" });
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
registerMcp();
if (wantHttp) installPersistentDaemon();
log();
log("\x1B[1m\x1B[32mDone.\x1B[0m");
log();
log("Next:");
log("  1. Restart your agent so it picks up the new server.");
log("  2. In Figma: Plugins \u2192 Development \u2192 Import plugin from manifest\u2026");
log("     and choose the \x1B[1mfigma-plugin\x1B[0m folder.");
log("  3. Run the plugin. Ask your agent to read your selection \u2014");
log("     the strip turns \x1B[32mgreen\x1B[0m.");
log();
if (!wantHttp) log("  (on-demand: nothing stays running; the first call starts it.)");
log(`Logs: ~/.grip-bridge.log   Status: ~/.grip-bridge.status`);
