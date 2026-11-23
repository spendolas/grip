// The pure removal planner (phase 2B): what `remove-foreign` would do, per OS, as data.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { foreignPaths } from '../dist/foreign-paths.js';
import { planForeignRemoval, formatPlan } from '../dist/foreign-remove.js';

const here = dirname(fileURLToPath(import.meta.url));
const alt = JSON.parse(readFileSync(join(here, 'fixtures', 'flavour-alt', 'flavour.json'), 'utf8'));
const Z = alt.watchlist[0];
const ctx = (platform) => ({ platform, home: platform === 'win32' ? 'C:\\Users\\u' : '/Users/u', tmp: platform === 'win32' ? 'C:\\tmp' : '/tmp', env: platform === 'win32' ? { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' } : {}, uid: 501 });

// facts where everything exists
function full(platform, over = {}) {
  const c = ctx(platform);
  const p = foreignPaths(c, Z);
  const exists = {};
  for (const a of p.autostart) exists[a.path] = true;
  for (const k of [p.statusFile, p.logFile, p.ipcSocket, p.figmaSettings]) if (k) exists[k] = true;
  return {
    c, p,
    facts: {
      pid: 4242, running: true, exists,
      home: { kind: 'dir', realpath: p.homeDir, parentRealpath: c.home },
      mcp: { entry: { type: 'http', url: 'http://127.0.0.1:7978/mcp' }, claudeCli: true },
      pluginCopies: ['/some/plugin'],
      ...over,
    },
  };
}
const kinds = (items) => items.map((i) => i.kind);

// ---- exact sequences per OS
{
  const { c, facts } = full('darwin');
  const items = planForeignRemoval(c, Z, facts);
  assert.deepEqual(kinds(items), ['macos-login-item', 'launch-agent', 'stop-supervisor', 'stop-daemon', 'app-bundle', 'app-bundle', 'launch-agent', 'mcp-entry', 'ipc-socket', 'log-file', 'status-file', 'home-dir', 'plugin-note']);
  assert.deepEqual(items.map((i) => i.action), ['disable', 'unload', 'stop', 'stop', 'delete', 'delete', 'delete', 'run-cli-or-edit-json', 'delete', 'delete', 'delete', 'delete', 'instruct']);
  assert.equal(items[0].target, 'Zenith Daemon');
  assert.equal(items[3].target, 'pid 4242');
  assert.equal(items[11].target, '/Users/u/.zenith');
  assert.equal(items.filter((i) => i.action === 'refuse').length, 0);
}
{
  const { c, facts } = full('linux');
  const items = planForeignRemoval(c, Z, facts);
  assert.deepEqual(kinds(items), ['systemd-unit', 'xdg-autostart', 'stop-daemon', 'systemd-unit', 'systemd-reload', 'mcp-entry', 'ipc-socket', 'log-file', 'status-file', 'home-dir', 'plugin-note']);
  assert.equal(items[0].action, 'disable');
  assert.equal(items[0].target, 'zenith-bridge');
  assert.equal(items.findIndex((i) => i.kind === 'systemd-reload') > items.findLastIndex((i) => i.kind === 'systemd-unit'), true);
  assert.ok(!kinds(items).includes('stop-supervisor'));
}
{
  const { c, facts } = full('win32');
  const items = planForeignRemoval(c, Z, facts);
  assert.deepEqual(kinds(items), ['startup-launcher', 'stop-daemon', 'mcp-entry', 'log-file', 'status-file', 'home-dir', 'plugin-note']);
  assert.ok(!kinds(items).includes('stop-supervisor') && !kinds(items).includes('ipc-socket'), 'the named pipe vanishes with its process');
}

// ---- order: autostart off, then stop, then deletes; the home folder is the last delete
for (const platform of ['darwin', 'linux', 'win32']) {
  const { c, facts } = full(platform);
  const items = planForeignRemoval(c, Z, facts);
  const stop = items.findIndex((i) => i.kind === 'stop-daemon');
  const stopSup = items.findIndex((i) => i.kind === 'stop-supervisor');
  items.forEach((i, idx) => {
    if (['macos-login-item', 'systemd-unit', 'xdg-autostart', 'startup-launcher'].includes(i.kind) && i.action !== 'delete') assert.ok(idx < stop, `${platform}: ${i.kind} before the stop`);
    if (i.kind === 'launch-agent' && i.action === 'unload') assert.ok(idx < stop);
    if (i.action === 'delete' && i.kind !== 'xdg-autostart' && i.kind !== 'startup-launcher') assert.ok(idx > stop, `${platform}: ${i.kind} delete after the stop`);
  });
  if (stopSup >= 0) assert.ok(stopSup < stop);
  const homeIdx = items.findIndex((i) => i.kind === 'home-dir');
  const lastDelete = Math.max(...items.map((i, idx) => (i.action === 'delete' || i.action === 'refuse' ? idx : -1)));
  assert.equal(homeIdx, lastDelete, `${platform}: the home folder is last`);
  assert.equal(items.at(-1).kind, 'plugin-note');
}

// ---- nothing there, nothing planned
{
  const { c, facts } = full('linux', { running: false, pid: null, exists: {}, home: { kind: 'missing', realpath: null, parentRealpath: '/Users/u' }, mcp: { entry: undefined, claudeCli: false }, pluginCopies: [] });
  assert.deepEqual(planForeignRemoval(c, Z, facts), []);
}

// ---- running but the process could not be identified: say so, do not guess
{
  const { c, facts } = full('linux', { pid: null });
  const stop = planForeignRemoval(c, Z, facts).find((i) => i.kind === 'stop-daemon');
  assert.equal(stop.action, 'instruct');
  assert.ok(stop.note.includes('7977'), stop.note);
}

// ---- the home folder: refused unless exactly <home>/<name> (review focus 3); the rest is still planned
for (const [what, home] of [
  ['symlink', { kind: 'symlink', realpath: '/elsewhere/.zenith', parentRealpath: '/Users/u' }],
  ['file', { kind: 'file', realpath: '/Users/u/.zenith', parentRealpath: '/Users/u' }],
  ['elsewhere', { kind: 'dir', realpath: '/elsewhere/.zenith', parentRealpath: '/Users/u' }],
]) {
  const { c, facts } = full('linux', { home });
  const items = planForeignRemoval(c, Z, facts);
  const h = items.find((i) => i.kind === 'home-dir');
  assert.equal(h.action, 'refuse', what);
  assert.ok(h.note && h.note.length > 0);
  assert.ok(kinds(items).includes('log-file') && kinds(items).includes('stop-daemon'), `${what}: the other items are still planned`);
}
{
  const { c, facts } = full('linux');
  const items = planForeignRemoval(c, { ...Z, homeDirName: '../x' }, { ...facts, home: { kind: 'dir', realpath: '/Users/x', parentRealpath: '/Users/u' } });
  assert.equal(items.find((i) => i.kind === 'home-dir').action, 'refuse', 'a hostile folder name is refused');
}

// ---- the MCP entry: only one that points at the foreign bridge (review focus 5)
{
  const same = { type: 'http', url: `http://127.0.0.1:${alt.httpPort}/mcp` };   // this build's own endpoint under the foreign name
  const { c, facts } = full('linux', { mcp: { entry: same, claudeCli: true } });
  assert.ok(!kinds(planForeignRemoval(c, Z, facts)).includes('mcp-entry'));
  const stdio = { command: 'node', args: ['/Users/u/.acme/grip-bridge.mjs'] };
  assert.ok(!kinds(planForeignRemoval(c, Z, { ...facts, mcp: { entry: stdio, claudeCli: false } })).includes('mcp-entry'));
  const foreign = { command: 'node', args: ['/Users/u/.zenith/zenith-bridge.mjs'] };
  assert.ok(kinds(planForeignRemoval(c, Z, { ...facts, mcp: { entry: foreign, claudeCli: false } })).includes('mcp-entry'));
}

// ---- purity
{
  const { c, facts } = full('darwin');
  const snapshot = JSON.stringify(facts);
  const a = planForeignRemoval(c, Z, facts);
  const b = planForeignRemoval(c, Z, facts);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(facts), snapshot, 'the input is not mutated');
}

// ---- typed pids on the stop items, never parsed from the display text
{
  const { c, facts } = full('darwin');
  const items = planForeignRemoval(c, Z, facts);
  assert.equal(items.find((i) => i.kind === 'stop-daemon').pid, 4242);
  assert.equal(items.find((i) => i.kind === 'stop-supervisor').pid, 4242);
}
// ---- rotated log and dump files named from the watchlist prefix (and only those)
{
  const { c, facts } = full('linux');
  const h = c.home;
  const items = planForeignRemoval(c, Z, { ...facts, extraFiles: [`${h}/.zenith-bridge.log.1`, `${h}/.zenith-bridge.dump-1.json`, `${h}/.zenith-bridge.dump-x.json`, '/etc/hosts'] });
  assert.deepEqual(items.filter((i) => i.kind === 'log-file').map((i) => i.target), [`${h}/.zenith-bridge.log`, `${h}/.zenith-bridge.log.1`, `${h}/.zenith-bridge.dump-1.json`]);
}

// ---- formatPlan
{
  const { c, facts } = full('darwin');
  const items = planForeignRemoval(c, Z, facts);
  const lines = formatPlan(items);
  assert.equal(lines.length, items.length);
  items.forEach((i, idx) => assert.ok(lines[idx].includes(i.target), lines[idx]));
  assert.ok(lines.at(-1).toLowerCase().includes('figma'));
  assert.ok(lines.some((l) => l.startsWith('delete the folder and everything in it: /Users/u/.zenith')), lines.join('|'));
}

console.log('foreign-plan: ok');
