#!/usr/bin/env node
// Windows (+ Linux) install-path smoke test.
//
// SCOPE: this exercises the platform-specific *logic* — the win32 named-pipe
// IPC endpoint, the Startup-folder VBS launcher, the systemd unit, and the MCP
// registration — by forcing the branches with GRIP_FAKE_PLATFORM on this host.
// It does NOT boot a real daemon on Windows; true runtime confirmation still
// needs an actual Windows machine (named-pipe bind/connect, detached spawn).
//
// Run: node test/win-smoke.mjs   (after `npm run build`)

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const INSTALL_JS = join(REPO, 'bridge', 'install.mjs');
const INDEX_JS = join(REPO, 'bridge', 'grip-bridge.mjs');
const NODE = process.execPath;

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { console.log(`  \x1b[31m✗ ${name}\x1b[0m ${extra}`); failures++; }
}

// A `claude` stub that fails, forcing the ~/.claude.json fallback path so the
// test asserts the config writer deterministically (no real agent required).
function stubDir() {
  const d = mkdtempSync(join(tmpdir(), 'grip-stub-'));
  const p = join(d, 'claude');
  execFileSync('sh', ['-c', `printf '#!/bin/sh\\nexit 1\\n' > "${p}" && chmod +x "${p}"`]);
  return d;
}

function runInstaller({ fakePlatform, http }) {
  const home = mkdtempSync(join(tmpdir(), 'grip-home-'));
  const appdata = join(home, 'AppData', 'Roaming');
  mkdirSync(appdata, { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,          // Windows homedir()
    APPDATA: appdata,
    GRIP_FAKE_PLATFORM: fakePlatform,
    PATH: `${stubDir()}:${process.env.PATH}`,
  };
  const argv = http ? ['--http'] : [];
  const out = execFileSync(NODE, [INSTALL_JS, ...argv], { env, encoding: 'utf8' });
  return { home, appdata, out };
}

console.log('\n1. Static: bundled bridge carries the win32 branches');
{
  const src = readFileSync(INDEX_JS, 'utf8');
  // Match regardless of backslash-escape depth in the emitted source.
  check('IPC endpoint uses a named pipe on win32', /\\+\.\\+pipe\\+grip-bridge/.test(src));
  check('detached spawn sets windowsHide', /windowsHide:\s*true/.test(src));
  check('socket-vanished self-heal guarded off win32', /if\s*\(!IS_WIN\)\s*setInterval/.test(src));
}

console.log('\n2. Windows install (GRIP_FAKE_PLATFORM=win32 --http)');
{
  const { home, appdata } = runInstaller({ fakePlatform: 'win32', http: true });
  const entry = join(home, '.grip', 'grip-bridge.mjs');
  check('bridge copied to ~/.grip/bridge', existsSync(entry));

  const cfg = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
  check('MCP registered as http', cfg.mcpServers?.grip?.type === 'http',
    JSON.stringify(cfg.mcpServers?.grip));

  const vbs = join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'GripDaemon.vbs');
  check('Startup VBS launcher written', existsSync(vbs));
  if (existsSync(vbs)) {
    const v = readFileSync(vbs, 'utf8');
    check('VBS runs node + entry hidden (window style 0)',
      v.includes('.Run') && v.includes('--daemon --persistent') && /,\s*0\s*,/.test(v));
    check('VBS references the copied entry', v.includes(join(home, '.grip', 'grip-bridge.mjs')));
  }
}

console.log('\n3. Windows install stdio (GRIP_FAKE_PLATFORM=win32, no --http)');
{
  const { home } = runInstaller({ fakePlatform: 'win32', http: false });
  const cfg = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
  const g = cfg.mcpServers?.grip;
  check('stdio registration uses absolute node + entry',
    g?.command === NODE && g?.args?.[0]?.endsWith(join('.grip', 'grip-bridge.mjs')),
    JSON.stringify(g));
}

console.log('\n4. Linux install (GRIP_FAKE_PLATFORM=linux --http)');
{
  const { home } = runInstaller({ fakePlatform: 'linux', http: true });
  const unit = join(home, '.config', 'systemd', 'user', 'grip-bridge.service');
  check('systemd user unit written', existsSync(unit));
  if (existsSync(unit)) {
    const u = readFileSync(unit, 'utf8');
    check('unit ExecStart runs entry --daemon --persistent',
      u.includes('--daemon --persistent') && u.includes(join(home, '.grip', 'grip-bridge.mjs')));
    check('unit installs to default.target', u.includes('WantedBy=default.target'));
  }
}

console.log(failures === 0
  ? '\n\x1b[32mAll Windows/Linux install-path checks passed.\x1b[0m\n(Real Windows runtime — named-pipe bind + detached spawn — still needs a Windows box.)\n'
  : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
