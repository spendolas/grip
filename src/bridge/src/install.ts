// grip install — sets up the local half of Grip.
//
// The Figma plugin is inert on its own: it opens a WebSocket to 127.0.0.1:7777
// and nothing is listening until this bridge runs. This installs it.
//
// Ships as a BUNDLE (bridge/install.js) sitting next to bridge/grip-bridge.js,
// which is itself a single self-contained file. So installing is: copy one file
// to a stable home, then register it with the agent. No npm, no node_modules.
//
// Default is stdio + on-demand: nothing stays running, and the first agent call
// spawns the daemon. --http installs an always-on daemon instead, using each
// platform's own mechanism (all inlined here — no shell scripts shipped).
//
// Usage:
//   node install.js                # stdio, on-demand (recommended); registers with Claude
//   node install.js --http         # + always-on daemon
//   node install.js --no-register  # install the files only; the agent registers Grip in ITS client
//   node install.js --print-config # print the connection details and ready-to-paste snippets, install nothing

import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectInstallSource, gripHome, stopRunningDaemon, writeInstallRecord } from './update.js';
import { BRIDGE_VERSION } from './types.js';

const args = new Set(process.argv.slice(2));
const wantHttp = args.has('--http');
const noRegister = args.has('--no-register');
const printConfig = args.has('--print-config');
const HOME = homedir();
// Platform seam so the test suite can exercise win32/linux branches anywhere.
const PLAT = process.env.GRIP_FAKE_PLATFORM ?? platform();

// This file ships next to the bundled bridge.
const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_BRIDGE = join(HERE, 'grip-bridge.mjs');

// Stable home, so the path registered with the agent survives repo moves,
// rebuilds, and the repo being deleted entirely.
// (GRIP_HOME in the environment overrides ~/.grip — used by tests.)
const GRIP_HOME = gripHome();
const SOURCE_PLUGIN = [join(HERE, '..', 'figma-plugin'), join(HERE, 'figma-plugin')]
  .find((d) => existsSync(join(d, 'manifest.json')));
// 'clone' when this installer sits inside a work tree of the repo (a developer
// install: updates are `git pull`, and the updater never overwrites it);
// 'release' when it runs from an extracted grip-install.zip. Recorded in
// ~/.grip/install.json.
const INSTALL_TYPE = detectInstallSource(HERE);
const PLUGIN_DIR = join(GRIP_HOME, 'figma-plugin');
const ENTRY = join(GRIP_HOME, 'grip-bridge.mjs');
const HTTP_URL = 'http://127.0.0.1:7778/mcp';

function log(msg = '') { process.stdout.write(msg + '\n'); }
function step(n: number, msg: string) { log(`\x1b[1m[${n}]\x1b[0m ${msg}`); }
function ok(msg: string) { log(`  \x1b[32m✓\x1b[0m ${msg}`); }
function warn(msg: string) { log(`  \x1b[33m!\x1b[0m ${msg}`); }
function die(msg: string): never {
  process.stderr.write(`\x1b[31merror:\x1b[0m ${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------

function installBridge() {
  step(1, `Installing bridge → ${ENTRY}`);
  if (!existsSync(SOURCE_BRIDGE)) {
    die(`grip-bridge.mjs not found next to this installer (looked in ${HERE}).\n` +
        `       Run this from the bridge/ folder of the Grip repo, or rebuild with 'npm run build'.`);
  }
  mkdirSync(GRIP_HOME, { recursive: true });
  copyFileSync(SOURCE_BRIDGE, ENTRY);
  try { chmodSync(ENTRY, 0o755); } catch { /* non-fatal on Windows */ }
  const kb = Math.round(readFileSync(ENTRY).length / 1024);
  ok(`single file installed (${kb} KB, no dependencies)`);
  try {
    writeInstallRecord(INSTALL_TYPE, BRIDGE_VERSION);
    ok(`install type: ${INSTALL_TYPE === 'clone' ? 'developer clone (update with git pull)' : 'release'}`);
  } catch { warn('could not write install.json; updates will treat this as a release install'); }
}

// Copy the plugin next to the bridge. Import THAT copy in Figma and later
// updates (`grip_update`, the plugin's "update" button, `update` CLI) can refresh
// it in place. Optional: when the installer runs from a bare copy with no
// figma-plugin/ beside it, just warn.
function installPlugin(): boolean {
  // The bundles are build output, not committed: a clone that has not been built
  // has the bridge (we are running it) but no code.js beside manifest.json.
  if (SOURCE_PLUGIN && !existsSync(join(SOURCE_PLUGIN, 'code.js'))) {
    warn(`code.js is missing in ${SOURCE_PLUGIN}: the plugin has not been built. Run \`npm run build\` in your Grip clone, then run this installer again.`);
    warn('Skipped copying the plugin; an existing ~/.grip/figma-plugin was left as it was.');
    return false;
  }
  if (!SOURCE_PLUGIN) {
    warn(`figma-plugin/ not found next to the installer (looked beside ${HERE}); skipped.`);
    warn('Import the plugin from your Grip checkout instead (after `npm run build` there), and update it with git pull && npm run build.');
    return false;
  }
  mkdirSync(PLUGIN_DIR, { recursive: true });
  let n = 0;
  for (const name of readdirSync(SOURCE_PLUGIN)) {
    const src = join(SOURCE_PLUGIN, name);
    if (name.startsWith('.') || !statSync(src).isFile()) continue;
    // tmp + rename so a running Figma never reads a half-written plugin file
    const dest = join(PLUGIN_DIR, name);
    const tmp = `${dest}.tmp-${process.pid}`;
    copyFileSync(src, tmp);
    renameSync(tmp, dest);
    n++;
  }
  ok(`plugin copied (${n} files) → ${PLUGIN_DIR}`);
  return true;
}

// A daemon from a previous install keeps running the OLD bridge in memory
// (and re-running this installer used to leave it there). Stop it so the new
// file takes over. Conservative: only a verified grip daemon, see update.ts.
function replaceRunningDaemon() {
  const r = stopRunningDaemon();
  if (r.stopped) ok(r.note); else log(`  · ${r.note}`);
}

function hasClaudeCli(): boolean {
  try { execFileSync('claude', ['--version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

function registerViaCli(): boolean {
  try { execFileSync('claude', ['mcp', 'remove', '-s', 'user', 'grip'], { stdio: 'ignore' }); }
  catch { /* wasn't registered — fine */ }
  try {
    const add = wantHttp
      ? ['mcp', 'add', '--transport', 'http', '-s', 'user', 'grip', HTTP_URL]
      : ['mcp', 'add', '-s', 'user', 'grip', process.execPath, ENTRY];
    execFileSync('claude', add, { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

// Fallback: write ~/.claude.json directly (the file the CLI actually uses —
// NOT ~/.claude/mcp.json, which Claude Code does not read).
function registerViaJson() {
  const cfgPath = join(HOME, '.claude.json');
  let cfg: Record<string, any> = {};
  if (existsSync(cfgPath)) {
    try { cfg = JSON.parse(readFileSync(cfgPath, 'utf8')); }
    catch { die(`~/.claude.json exists but isn't valid JSON — fix or remove it, then re-run.`); }
  }
  cfg.mcpServers ??= {};
  cfg.mcpServers.grip = wantHttp
    ? { type: 'http', url: HTTP_URL }
    : { command: process.execPath, args: [ENTRY] };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  ok(`wrote grip server to ${cfgPath}`);
}

// What ANY MCP client needs to reach Grip, plus examples for common clients.
// Examples only: a client's config format can change, so its own docs win.
function connectionDetails(): string {
  const stdioArgs = JSON.stringify([ENTRY]);
  return [
    'Connect Grip to your MCP client (any client works):',
    `  HTTP (needs the always-on daemon, install with --http):  ${HTTP_URL}`,
    `  stdio (on demand, nothing stays running):               ${process.execPath} ${ENTRY}`,
    '',
    'Examples (check your client\'s docs if its format differs):',
    '  Claude Code:  claude mcp add -s user grip ' + process.execPath + ' ' + ENTRY,
    '  Cursor (~/.cursor/mcp.json):',
    '    ' + JSON.stringify({ mcpServers: { grip: { command: process.execPath, args: [ENTRY] } } }),
    '  Codex (~/.codex/config.toml):',
    '    [mcp_servers.grip]',
    '    command = ' + JSON.stringify(process.execPath),
    '    args = ' + stdioArgs,
  ].join('\n');
}

function registerMcp() {
  if (noRegister) {
    step(2, 'Not registering (--no-register)');
    log(connectionDetails());
    return;
  }
  step(2, `Registering with your agent (${wantHttp ? 'http' : 'stdio'})`);
  if (hasClaudeCli() && registerViaCli()) ok(`registered via 'claude mcp add'`);
  else {
    warn('claude CLI not found (or add failed) — writing config directly');
    registerViaJson();
  }
}

// --- always-on daemon, per platform (only with --http) ---------------------

function installPersistentDaemon() {
  step(3, `Installing always-on daemon (${PLAT})`);
  if (PLAT === 'darwin') return daemonMac();
  if (PLAT === 'win32') return daemonWindows();
  if (PLAT === 'linux') return daemonLinux();
  warn(`no recipe for '${PLAT}'; start it yourself: node ${ENTRY} --daemon --persistent`);
}

// macOS: a hidden Login Item .app whose executable IS the daemon. Built in
// ~/Applications so no admin password is ever needed.
function daemonMac() {
  const app = join(HOME, 'Applications', 'Grip Daemon.app');
  const macos = join(app, 'Contents', 'MacOS');
  rmSync(app, { recursive: true, force: true });
  mkdirSync(macos, { recursive: true });
  writeFileSync(join(app, 'Contents', 'Info.plist'),
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
`);
  const launcher = join(macos, 'grip-daemon');
  // Keep-alive: launchd can't be used (program lives on a noowners volume for
  // some setups), so this app supervises the daemon itself and respawns it.
  // Quitting the app (TERM/INT) stops the child and ends the loop.
  writeFileSync(launcher, [
    '#!/bin/bash',
    'trap \'kill "$CHILD" 2>/dev/null; exit 0\' TERM INT',
    'while true; do',
    `  GRIP_SUPERVISED=1 "${process.execPath}" "${ENTRY}" --daemon --persistent &`,
    '  CHILD=$!',
    '  wait "$CHILD"',
    '  sleep 5',
    'done',
    '',
  ].join('\n'));
  chmodSync(launcher, 0o755);
  try {
    execFileSync('osascript', ['-e',
      'tell application "System Events" to delete (every login item whose name is "Grip Daemon")'],
      { stdio: 'ignore' });
  } catch { /* none registered yet */ }
  try {
    execFileSync('osascript', ['-e',
      `tell application "System Events" to make login item at end with properties {path:"${app}", hidden:true}`],
      { stdio: 'ignore' });
    execFileSync('open', [app], { stdio: 'ignore' });
    ok('login item installed and started — runs at every login');
  } catch {
    warn(`could not register the login item; start it yourself: open "${app}"`);
  }
}

// Windows: a hidden VBS launcher in the Startup folder. VBS (window style 0)
// starts node with NO console window, unlike a .cmd.
function daemonWindows() {
  const startup = join(
    process.env.APPDATA ?? join(HOME, 'AppData', 'Roaming'),
    'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup',
  );
  mkdirSync(startup, { recursive: true });
  const vbsPath = join(startup, 'GripDaemon.vbs');
  writeFileSync(vbsPath,
    'Set s = CreateObject("WScript.Shell")\r\n' +
    `s.Run """${process.execPath}"" ""${ENTRY}"" --daemon --persistent", 0, False\r\n`);
  ok(`startup launcher written → ${vbsPath}`);
  try {
    execFileSync('wscript', [vbsPath], { stdio: 'ignore' });
    ok('daemon started');
  } catch {
    warn('could not start now; it will start at next sign-in');
  }
}

// Linux: a systemd --user service. (Figma has no Linux desktop app; this is
// for people running Figma in the browser.)
function daemonLinux() {
  const unitDir = join(HOME, '.config', 'systemd', 'user');
  mkdirSync(unitDir, { recursive: true });
  const unitPath = join(unitDir, 'grip-bridge.service');
  writeFileSync(unitPath,
    '[Unit]\nDescription=Grip bridge daemon (Figma <-> MCP)\n\n' +
    '[Service]\n' +
    `ExecStart=${process.execPath} ${ENTRY} --daemon --persistent\n` +
    // Always (not on-failure): a self-update restarts the daemon with a clean exit.
    'Environment=GRIP_SUPERVISED=1\nRestart=always\nRestartSec=2\n\n' +
    '[Install]\nWantedBy=default.target\n');
  ok(`systemd unit written → ${unitPath}`);
  try {
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    execFileSync('systemctl', ['--user', 'enable', '--now', 'grip-bridge'], { stdio: 'ignore' });
    ok('service enabled and started');
    warn('to survive logout: loginctl enable-linger $USER');
  } catch {
    warn(`systemctl unavailable; start it yourself: node ${ENTRY} --daemon --persistent &`);
  }
}

// ---------------------------------------------------------------------------

if (printConfig) {
  log(connectionDetails());
  process.exit(0);
}

log();
log('\x1b[1mGrip — installing the local bridge\x1b[0m');
log();
installBridge();
const pluginInstalled = installPlugin();
registerMcp();
replaceRunningDaemon();
if (wantHttp) installPersistentDaemon();
log();
log(`\x1b[1m\x1b[32mDone.\x1b[0m Grip ${BRIDGE_VERSION} installed.`);
log();
log('Next:');
log(noRegister
  ? '  1. Register Grip in your MCP client (details above), then restart it.'
  : '  1. Restart your agent so it picks up the new server.');
if (pluginInstalled) {
  log('  2. In Figma: Plugins → Development → Import plugin from manifest…');
  log(`     and choose \x1b[1m${join(PLUGIN_DIR, 'manifest.json')}\x1b[0m`);
  log('     (import THIS copy, not the repo folder, so updates can refresh it in place).');
} else {
  log('  2. In Figma: Plugins → Development → Import plugin from manifest…');
  log('     and choose the \x1b[1mfigma-plugin\x1b[0m folder of your Grip checkout (after `npm run build` there).');
}
log('  3. Run the plugin. Ask your agent to read your selection —');
log('     the strip turns \x1b[32mgreen\x1b[0m.');
log();
if (INSTALL_TYPE === 'clone') {
  log('Updating later: this is a developer install. Run `git pull && npm run build && node bridge/install.mjs`');
  log('in your clone (the in-place updater never overwrites a clone install).');
} else {
  log('Updating later: ask your agent to "update Grip", click the plugin strip when it');
  log(`turns purple, or run: node ${ENTRY} update`);
}
log();
if (!wantHttp) log('  (on-demand: nothing stays running; the first call starts it.)');
log(`Logs: ~/.grip-bridge.log   Status: ~/.grip-bridge.status`);
