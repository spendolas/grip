// Pure identity derivation: ports, paths and names from a Flavour.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { makeIdentity } = await import('../dist/identity.js');
const { FLAVOUR } = await import('../dist/flavour.gen.js');
const alt = JSON.parse(readFileSync(join(here, 'fixtures', 'flavour-alt', 'flavour.json'), 'utf8'));

const ctx = (env = {}, platform = 'darwin') => ({ env, platform, home: '/h', tmp: '/t' });

// public flavour reproduces today's constants
const p = makeIdentity(FLAVOUR, ctx());
assert.equal(p.wsPort, 7777);
assert.equal(p.httpPort, 7778);
assert.equal(p.home, join('/h', '.grip'));
assert.equal(p.homeLabel, '~/.grip');
assert.equal(p.statusPath, join('/h', '.grip-bridge.status'));
assert.equal(p.logPath, join('/h', '.grip-bridge.log'));
assert.equal(p.dumpPath(5), join('/h', '.grip-bridge.dump-5.json'));
assert.equal(p.ipcPath, join('/t', 'grip-bridge.sock'));
assert.equal(p.exportsDir, join('/t', 'grip-exports'));
assert.equal(p.httpUrl, 'http://127.0.0.1:7778/mcp');
assert.equal(p.figmaSettingsPath, join('/h', 'Library', 'Application Support', 'Figma', 'settings.json'));
assert.deepEqual(p.overridesIgnored, []);

// alt flavour shares nothing
const a = makeIdentity(alt, ctx());
for (const k of ['wsPort', 'httpPort', 'home', 'statusPath', 'logPath', 'ipcPath', 'exportsDir', 'httpUrl', 'homeLabel']) {
  assert.notEqual(a[k], p[k], k);
}
assert.notEqual(a.dumpPath(5), p.dumpPath(5));

// overrides: applied for public
const o = makeIdentity(FLAVOUR, ctx({ GRIP_WS_PORT: '9999', GRIP_HOME: '/x', GRIP_IPC_PATH: '/s', GRIP_STATUS_PATH: '/st', GRIP_LOG_PATH: '/l', GRIP_HTTP_PORT: '9998', GRIP_FIGMA_SETTINGS: '/f' }));
assert.equal(o.wsPort, 9999);
assert.equal(o.httpPort, 9998);
assert.equal(o.httpUrl, 'http://127.0.0.1:9998/mcp');
assert.equal(o.home, '/x');
assert.equal(o.ipcPath, '/s');
assert.equal(o.statusPath, '/st');
assert.equal(o.logPath, '/l');
assert.equal(o.figmaSettingsPath, '/f');

// locked alt: ignored and listed, unless GRIP_TEST=1
const ig = makeIdentity(alt, ctx({ GRIP_WS_PORT: '9999' }));
assert.equal(ig.wsPort, 7877);
assert.deepEqual(ig.overridesIgnored, ['GRIP_WS_PORT']);
const ok = makeIdentity(alt, ctx({ GRIP_WS_PORT: '9999', GRIP_TEST: '1' }));
assert.equal(ok.wsPort, 9999);
assert.deepEqual(ok.overridesIgnored, []);

// windows
const w = makeIdentity(FLAVOUR, { env: { APPDATA: 'C:\\A' }, platform: 'win32', home: '/h', tmp: '/t' });
assert.equal(w.ipcPath, '\\\\.\\pipe\\grip-bridge');
assert.equal(makeIdentity(alt, { env: {}, platform: 'win32', home: '/h', tmp: '/t' }).ipcPath, '\\\\.\\pipe\\acme-bridge');
assert.equal(w.figmaSettingsPath, join('C:\\A', 'Figma', 'settings.json'));
assert.equal(makeIdentity(FLAVOUR, { env: {}, platform: 'linux', home: '/h', tmp: '/t' }).figmaSettingsPath, undefined);
console.log('identity ok');
