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
//   node install.js            # stdio, on-demand (recommended)
//   node install.js --http     # + always-on daemon

import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = new Set(process.argv.slice(2));
const wantHttp = args.has('--http');
const HOME = homedir();
// Platform seam so the test suite can exercise win32/linux branches anywhere.
const PLAT = process.env.GRIP_FAKE_PLATFORM ?? platform();

// This file ships next to the bundled bridge.
const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_BRIDGE = join(HERE, 'grip-bridge.mjs');

// Stable home, so the path registered with the agent survives repo moves,
// rebuilds, and the repo being deleted entirely.
const GRIP_HOME = join(HOME, '.grip');
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

function registerMcp() {
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
  writeFileSync(launcher, `#!/bin/bash\nexec "${process.execPath}" "${ENTRY}" --daemon --persistent\n`);
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
    'Restart=on-failure\n\n' +
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

log();
log('\x1b[1mGrip — installing the local bridge\x1b[0m');
log();
installBridge();
registerMcp();
if (wantHttp) installPersistentDaemon();
log();
log('\x1b[1m\x1b[32mDone.\x1b[0m');
log();
log('Next:');
log('  1. Restart your agent so it picks up the new server.');
log('  2. In Figma: Plugins → Development → Import plugin from manifest…');
log('     and choose the \x1b[1mfigma-plugin\x1b[0m folder.');
log('  3. Run the plugin. Ask your agent to read your selection —');
log('     the strip turns \x1b[32mgreen\x1b[0m.');
log();
if (!wantHttp) log('  (on-demand: nothing stays running; the first call starts it.)');
log(`Logs: ~/.grip-bridge.log   Status: ~/.grip-bridge.status`);
