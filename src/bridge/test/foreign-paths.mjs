// Pure foreign-install paths and safety predicates (phase 2B), for all three platforms from any host.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { foreignPaths, homeSafeToDelete, mcpEntryIsForeign } from '../dist/foreign-paths.js';
import { isDaemonCommand } from '../dist/update.js';

const here = dirname(fileURLToPath(import.meta.url));
const alt = JSON.parse(readFileSync(join(here, 'fixtures', 'flavour-alt', 'flavour.json'), 'utf8'));
const Z = alt.watchlist[0];
const U = 'a b\u00fc';
const ctx = (platform, over = {}) => ({ platform, home: platform === 'win32' ? `C:\\Users\\${U}` : `/Users/${U}`, tmp: platform === 'win32' ? 'C:\\tmp' : '/tmp', env: {}, uid: 501, ...over });

// foreignPaths
{
  const d = foreignPaths(ctx('darwin'), Z);
  assert.equal(d.homeDir, `/Users/${U}/.zenith`);
  assert.equal(d.statusFile, `/Users/${U}/.zenith-bridge.status`);
  assert.equal(d.logFile, `/Users/${U}/.zenith-bridge.log`);
  assert.equal(d.installJson, `/Users/${U}/.zenith/install.json`);
  assert.equal(d.entryFile, `/Users/${U}/.zenith/zenith-bridge.mjs`);
  assert.equal(d.ipcSocket, '/tmp/zenith-bridge.sock');
  assert.equal(d.ipcPipe, null);
  assert.deepEqual(d.autostart, [
    { kind: 'app-bundle', path: `/Users/${U}/Applications/Zenith Daemon.app` },
    { kind: 'app-bundle', path: '/Applications/Zenith Daemon.app' },
    { kind: 'launch-agent', path: `/Users/${U}/Library/LaunchAgents/com.zenith.bridge.plist` },
  ]);
  assert.equal(d.claudeConfig, `/Users/${U}/.claude.json`);
  assert.equal(d.figmaSettings, `/Users/${U}/Library/Application Support/Figma/settings.json`);
  assert.equal(foreignPaths(ctx('darwin', { env: { CLAUDE_CONFIG_DIR: '/cfg' } }), Z).claudeConfig, '/cfg/.claude.json');

  const l = foreignPaths(ctx('linux'), Z);
  assert.deepEqual(l.autostart, [
    { kind: 'systemd-unit', path: `/Users/${U}/.config/systemd/user/zenith-bridge.service` },
    { kind: 'xdg-autostart', path: `/Users/${U}/.config/autostart/zenith-bridge.desktop` },
  ]);
  assert.equal(l.ipcSocket, '/tmp/zenith-bridge.sock');
  assert.equal(l.figmaSettings, null);

  const w = foreignPaths(ctx('win32', { env: { APPDATA: `C:\\Users\\${U}\\AppData\\Roaming` } }), Z);
  assert.equal(w.homeDir, `C:\\Users\\${U}\\.zenith`);
  assert.equal(w.entryFile, `C:\\Users\\${U}\\.zenith\\zenith-bridge.mjs`);
  assert.equal(w.ipcSocket, null);
  assert.equal(w.ipcPipe, '\\\\.\\pipe\\zenith-bridge');
  const startup = `C:\\Users\\${U}\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\ZenithDaemon.vbs`;
  assert.deepEqual(w.autostart, [{ kind: 'startup-launcher', path: startup }]);
  assert.equal(w.figmaSettings, `C:\\Users\\${U}\\AppData\\Roaming\\Figma\\settings.json`);
  const w2 = foreignPaths(ctx('win32'), Z);   // no APPDATA: default under the home
  assert.equal(w2.autostart[0].path, startup);
  assert.equal(w2.figmaSettings, null);
}

// homeSafeToDelete: the folder a delete may touch (review focus 3)
{
  const c = ctx('linux');
  const good = { kind: 'dir', realpath: `/Users/${U}/.zenith`, parentRealpath: `/Users/${U}` };
  assert.deepEqual(homeSafeToDelete(c, Z, good), { ok: true });
  // the user's home itself sits behind a link: fine as long as realpath == realpath(parent)/name
  assert.equal(homeSafeToDelete(c, Z, { kind: 'dir', realpath: '/vol/u/.zenith', parentRealpath: '/vol/u' }).ok, true);
  for (const kind of ['symlink', 'file', 'missing']) assert.equal(homeSafeToDelete(c, Z, { ...good, kind }).ok, false, kind);
  assert.equal(homeSafeToDelete(c, Z, { ...good, realpath: '/elsewhere/.zenith' }).ok, false);
  assert.equal(homeSafeToDelete(c, Z, { ...good, realpath: `/Users/${U}/.other` }).ok, false);
  assert.equal(homeSafeToDelete(c, Z, { ...good, realpath: '/elsewhere/.zenith', parentRealpath: '/vol/u' }).ok, false);
  assert.equal(homeSafeToDelete(c, Z, { ...good, realpath: null }).ok, false);
  for (const bad of ['..', 'a/b', '', '.', 'a\\b']) assert.equal(homeSafeToDelete(c, { ...Z, homeDirName: bad }, good).ok, false, `name ${JSON.stringify(bad)}`);
  // case differences: tolerated on darwin and win32, not on linux
  const cased = { ...good, realpath: `/Users/${U}/.Zenith` };
  assert.equal(homeSafeToDelete(ctx('darwin'), Z, cased).ok, true);
  assert.equal(homeSafeToDelete(c, Z, cased).ok, false);
  const wGood = { kind: 'dir', realpath: `c:\\users\\${U}\\.zenith`, parentRealpath: `C:\\Users\\${U}` };
  assert.equal(homeSafeToDelete(ctx('win32'), Z, wGood).ok, true);
}

// mcpEntryIsForeign
{
  const c = ctx('linux');
  assert.equal(mcpEntryIsForeign(c, Z, { type: 'http', url: 'http://127.0.0.1:7978/mcp' }), true);
  assert.equal(mcpEntryIsForeign(c, Z, { command: 'node', args: [`/Users/${U}/.zenith/zenith-bridge.mjs`] }), true);
  assert.equal(mcpEntryIsForeign(c, Z, { type: 'http', url: `http://127.0.0.1:${alt.httpPort}/mcp` }), false, "this flavour's own endpoint");
  assert.equal(mcpEntryIsForeign(c, Z, { command: 'node', args: [`/Users/${U}/.acme/grip-bridge.mjs`] }), false, 'same name, points at this build');
  assert.equal(mcpEntryIsForeign(c, Z, { command: 'node', args: [`/Users/${U}/.zenith-evil/x.mjs`] }), false, 'a lookalike folder');
  assert.equal(mcpEntryIsForeign(c, Z, undefined), false);
}

// isDaemonCommand
assert.equal(isDaemonCommand('node /x/zenith-bridge.mjs --daemon --persistent', 'zenith-bridge'), true);
assert.equal(isDaemonCommand('node /x/zenith-bridge.mjs', 'zenith-bridge'), false);
assert.equal(isDaemonCommand('node /x/other.mjs --daemon', 'zenith-bridge'), false);
assert.equal(isDaemonCommand('node /x/grip-bridge.mjs --daemon', 'grip-bridge'), true);

console.log('foreign-paths: ok');
