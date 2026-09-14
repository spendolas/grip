#!/usr/bin/env node
// grip-figma-install — the "other half" installer.
//
// A stranger who installed the published *Figma plugin* still has an inert
// plugin: it only opens a WebSocket to 127.0.0.1:7777, and nothing is
// listening. This installs the missing half — the bridge daemon + the MCP
// registration — so their agent (Claude Code, etc.) can drive Figma and the
// plugin strip goes green.
//
// It is DELIBERATELY separate from dist/index.js: that binary's stdout is the
// MCP transport (sacred). This one is an ordinary CLI that prints to stdout.
//
// Default install = stdio, on-demand. No always-on daemon to manage: the shim
// spawns the detached daemon on the first agent call, cross-platform. Pass
// --http (macOS) to additionally install the persistent Login Item daemon and
// register the HTTP transport instead.
//
// Usage:
//   npx grip-figma-bridge install        # stdio, on-demand (recommended)
//   npx grip-figma-bridge install --http # + persistent daemon (macOS)

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = new Set(process.argv.slice(2));
const wantHttp = args.has('--http');
const HOME = homedir();
// Platform seam: GRIP_FAKE_PLATFORM lets the smoke test exercise the win32 /
// linux branches on any host. Falls back to the real platform otherwise.
const PLAT = process.env.GRIP_FAKE_PLATFORM ?? platform();

// This file lives at <pkg>/dist/install.js — the package root is one up.
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Stable home for the bridge, independent of the (ephemeral) npx cache. We
// copy the package here so the path we register in ~/.claude.json survives npx
// cache eviction and package upgrades.
const GRIP_HOME = join(HOME, '.grip', 'bridge');
const ENTRY = join(GRIP_HOME, 'dist', 'index.js');
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

function copyBridge() {
  step(1, `Installing bridge → ${GRIP_HOME}`);
  const builtEntry = join(PKG_ROOT, 'dist', 'index.js');
  if (!existsSync(builtEntry)) {
    die(`built bridge not found at ${builtEntry}\n` +
        `       (the published package must ship dist/. If running from source, ` +
        `run 'npm run build' in bridge/ first.)`);
  }
  rmSync(GRIP_HOME, { recursive: true, force: true });
  mkdirSync(GRIP_HOME, { recursive: true });
  for (const item of ['dist', 'node_modules', 'package.json', 'scripts']) {
    const from = join(PKG_ROOT, item);
    if (existsSync(from)) cpSync(from, join(GRIP_HOME, item), { recursive: true });
  }
  if (!existsSync(ENTRY)) die(`copy failed — ${ENTRY} missing after install`);
  ok(`bridge v${readVersion()} installed`);
}

function readVersion(): string {
  try {
    return JSON.parse(readFileSync(join(GRIP_HOME, 'package.json'), 'utf8')).version ?? '?';
  } catch { return '?'; }
}

function hasClaudeCli(): boolean {
  try { execFileSync('claude', ['--version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

function registerViaCli(): boolean {
  try { execFileSync('claude', ['mcp', 'remove', '-s', 'user', 'grip'], { stdio: 'ignore' }); }
  catch { /* not registered yet — fine */ }
  try {
    if (wantHttp) {
      execFileSync('claude', ['mcp', 'add', '--transport', 'http', '-s', 'user', 'grip', HTTP_URL],
        { stdio: 'ignore' });
    } else {
      execFileSync('claude', ['mcp', 'add', '-s', 'user', 'grip', process.execPath, ENTRY], { stdio: 'ignore' });
    }
    return true;
  } catch { return false; }
}

// Fallback: edit ~/.claude.json directly (the file the CLI actually writes —
// NOT ~/.claude/mcp.json, which Claude Code does not read).
function registerViaJson() {
  const cfgPath = join(HOME, '.claude.json');
  let cfg: any = {};
  if (existsSync(cfgPath)) {
    try { cfg = JSON.parse(readFileSync(cfgPath, 'utf8')); }
    catch { die(`~/.claude.json exists but is not valid JSON — fix or remove it, then re-run`); }
  }
  cfg.mcpServers ??= {};
  cfg.mcpServers.grip = wantHttp
    ? { type: 'http', url: HTTP_URL }
    : { command: process.execPath, args: [ENTRY] };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  ok(`wrote grip server to ${cfgPath}`);
}

function registerMcp() {
  step(2, `Registering MCP server (${wantHttp ? 'http' : 'stdio'})`);
  if (hasClaudeCli() && registerViaCli()) {
    ok(`registered via 'claude mcp add'`);
  } else {
    warn('claude CLI not found (or add failed) — writing config directly');
    registerViaJson();
  }
}

function installPersistentDaemon() {
  step(3, `Installing persistent daemon (${PLAT})`);
  if (PLAT === 'darwin') return installDaemonMac();
  if (PLAT === 'win32') return installDaemonWindows();
  if (PLAT === 'linux') return installDaemonLinux();
  warn(`no persistent-daemon recipe for '${PLAT}'; start it manually:`);
  warn('  node ' + ENTRY + ' --daemon --persistent');
}

// macOS — Login Item .app (the mechanism Claude Hub uses on this box).
function installDaemonMac() {
  const script = join(GRIP_HOME, 'scripts', 'install-loginitem.sh');
  const src = existsSync(script) ? script : join(PKG_ROOT, 'scripts', 'install-loginitem.sh');
  if (!existsSync(src)) {
    warn('install-loginitem.sh not shipped; start manually: node ' + ENTRY + ' --daemon --persistent');
    return;
  }
  try {
    execFileSync('bash', [src], { stdio: 'inherit' });
    ok('login item installed — daemon starts at every login');
  } catch {
    warn('login-item install failed; run it manually: bash ' + src);
  }
}

// Windows — a hidden VBS launcher in the Startup folder. VBS (WScript.Shell
// .Run with window-style 0) starts node with NO console window, unlike a .cmd.
// --persistent disables idle-exit so it stays warm like the mac Login Item.
function installDaemonWindows() {
  const startup = join(
    process.env.APPDATA ?? join(HOME, 'AppData', 'Roaming'),
    'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup',
  );
  mkdirSync(startup, { recursive: true });
  const node = process.execPath;
  const vbs =
    'Set s = CreateObject("WScript.Shell")\r\n' +
    `s.Run """${node}"" ""${ENTRY}"" --daemon --persistent", 0, False\r\n`;
  const vbsPath = join(startup, 'GripDaemon.vbs');
  writeFileSync(vbsPath, vbs);
  ok(`startup launcher written → ${vbsPath}`);
  // Start it now too (best-effort; wscript is present on all Windows).
  try {
    execFileSync('wscript', [vbsPath], { stdio: 'ignore' });
    ok('daemon started');
  } catch {
    warn('could not start now; it will start at next login (or run the .vbs)');
  }
}

// Linux — systemd --user unit. Figma has no native Linux app; this covers the
// bridge for users running Figma in the browser. Falls back to a manual line
// on non-systemd distros.
function installDaemonLinux() {
  const unitDir = join(HOME, '.config', 'systemd', 'user');
  mkdirSync(unitDir, { recursive: true });
  const unit =
    '[Unit]\n' +
    'Description=Grip bridge daemon (Figma <-> MCP)\n\n' +
    '[Service]\n' +
    `ExecStart=${process.execPath} ${ENTRY} --daemon --persistent\n` +
    'Restart=on-failure\n\n' +
    '[Install]\n' +
    'WantedBy=default.target\n';
  const unitPath = join(unitDir, 'grip-bridge.service');
  writeFileSync(unitPath, unit);
  ok(`systemd unit written → ${unitPath}`);
  try {
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    execFileSync('systemctl', ['--user', 'enable', '--now', 'grip-bridge'], { stdio: 'ignore' });
    ok('service enabled + started (systemctl --user)');
    warn('for start-at-boot without an active login: loginctl enable-linger $USER');
  } catch {
    warn('systemctl not available; start manually:');
    warn('  node ' + ENTRY + ' --daemon --persistent &');
  }
}

function finish() {
  log();
  log('\x1b[1m\x1b[32mDone.\x1b[0m Grip bridge is installed.');
  log();
  log('Next:');
  log('  1. Open the \x1b[1mGrip\x1b[0m plugin in Figma (Plugins → Grip).');
  log('  2. In your agent, run any Grip tool (or just ask it to read your');
  log('     Figma selection). The strip in the plugin turns \x1b[32mgreen\x1b[0m.');
  log();
  if (!wantHttp) {
    log('  (stdio, on-demand: no daemon to manage — the first call starts it.)');
  }
  log('Troubleshooting: ~/.grip-bridge.log   Status: ~/.grip-bridge.status');
}

// ---------------------------------------------------------------------------

log();
log('\x1b[1mGrip — installing the bridge (the half Figma can\'t ship)\x1b[0m');
log();
copyBridge();
registerMcp();
if (wantHttp) installPersistentDaemon();
finish();
