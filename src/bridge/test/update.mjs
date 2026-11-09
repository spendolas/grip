// Self-update tests. NO real network, NO real ~/.grip: a local http server plays
// GitHub raw, GRIP_HOME points at a temp dir, GRIP_STATUS_PATH at a temp file.
import assert from 'node:assert';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { BRIDGE_VERSION } from '../dist/types.js';
import * as U from '../dist/update.js';
import { createSession } from '../dist/mcp-server.js';
import { PluginBridge, originAllowedForUpdate } from '../dist/ws-server.js';
import { TOOLS } from '../dist/tools.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_JS = join(HERE, '..', 'dist', 'index.js');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- fake release
const NEWER = '99.1.0';
let release;     // mutable per test
let hits;        // path -> count
function freshRelease(over = {}) {
  const bridge = Buffer.from('// fake bridge ' + NEWER + '\n');
  const files = {
    'code.js': Buffer.from('// plugin code\n'),
    'ui.html': Buffer.from('<html>ui</html>\n'),
    'manifest.json': Buffer.from('{"name":"Grip"}\n'),
  };
  release = {
    version: NEWER,
    bridge,
    files,
    bodies: {},          // path -> Buffer served instead of the real one (to simulate CDN lag/corruption)
    manifestRaw: null,   // replace version.json body entirely
    bridgeDelayMs: 0,
    bridgePathInManifest: 'bridge/grip-bridge.mjs',
    ...over,
  };
}
function manifestFor(r) {
  return {
    version: r.version,
    bridge: { file: r.bridgePathInManifest, sha256: sha(r.bridge), bytes: r.bridge.length },
    installer: { file: 'bridge/install.mjs', sha256: sha(Buffer.from('x')) },
    plugin: { files: Object.fromEntries(Object.entries(r.files).map(([n, b]) => [n, { path: `figma-plugin/${n}`, sha256: sha(b) }])) },
  };
}

let otherHits = 0;
const other = createServer((req, res) => { otherHits++; res.writeHead(200).end(release.bridge); });
await new Promise((r) => other.listen(0, '127.0.0.1', r));
const OTHER_PORT = other.address().port;

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  hits[path] = (hits[path] ?? 0) + 1;
  const send = (body, status = 200, headers = {}) => { res.writeHead(status, headers); res.end(body); };
  if (release.bodies[path]) return send(release.bodies[path]);
  if (path === '/bridge/version.json') return send(release.manifestRaw ?? JSON.stringify(manifestFor(release)));
  if (path === '/bridge/grip-bridge.mjs') {
    if (release.bridgeDelayMs) await sleep(release.bridgeDelayMs);
    return send(release.bridge);
  }
  if (path.startsWith('/figma-plugin/')) {
    const f = release.files[path.slice('/figma-plugin/'.length)];
    return f ? send(f) : send('nope', 404);
  }
  if (path === '/redir-same') return send('', 302, { location: '/bridge/grip-bridge.mjs' });
  if (path === '/redir-off') return send('', 302, { location: `http://127.0.0.1:${OTHER_PORT}/bridge/grip-bridge.mjs` });
  if (path === '/redir-loop') return send('', 302, { location: '/redir-loop' });
  if (path === '/big') return send(Buffer.alloc(6 * 1024 * 1024, 65));
  return send('nope', 404);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

function env(home) {
  process.env.GRIP_UPDATE_BASE = BASE;
  process.env.GRIP_HOME = home;
  process.env.GRIP_STATUS_PATH = join(home, 'nostatus.json');
  delete process.env.GRIP_NO_UPDATE_CHECK;
  U.resetUpdateState();
  hits = {};
  otherHits = 0;
}
const snapshotDir = (d) => (existsSync(d) ? readdirSync(d, { recursive: true }).sort().join('|') : '(none)');

// ---------------------------------------------------------------- 1. semver
assert.ok(U.compareSemver('0.8.0', '0.7.0') > 0);
assert.ok(U.compareSemver('0.7.0', '0.8.0') < 0);
assert.strictEqual(U.compareSemver('1.2.3', '1.2.3'), 0);
assert.ok(U.compareSemver('0.10.0', '0.9.0') > 0, 'numeric, not lexicographic');
assert.ok(U.compareSemver('1.0.0', '0.99.99') > 0);
assert.ok(U.compareSemver('0.8.0-beta', '0.8.0') < 0, 'prerelease sorts below the release');
assert.strictEqual(U.compareSemver('garbage', '1.0.0'), 0, 'unparseable never claims an update');

// base URL rules
assert.ok(U.normalizeBase('https://example.com/x'), 'https ok');
assert.ok(U.normalizeBase('http://127.0.0.1:1234/').endsWith('/'), 'http loopback ok');
assert.ok(U.normalizeBase('http://localhost:1/'), 'http localhost ok');
assert.strictEqual(U.normalizeBase('http://example.com/'), null, 'plain http to a real host refused');
assert.strictEqual(U.normalizeBase('ftp://example.com/'), null);
assert.strictEqual(U.normalizeBase('https://u:p@example.com/'), null, 'credentials refused');
assert.ok(U.DEFAULT_UPDATE_BASE.startsWith('https://raw.githubusercontent.com/spendolas/grip/main/'));

// ---------------------------------------------------------------- 2. check
{
  const home = tmp('grip-upd-home-');
  env(home);
  freshRelease();
  const changes = [];
  const off = U.onUpdateState((s) => changes.push(s));
  const s = await U.checkForUpdate();
  assert.deepStrictEqual([s.current, s.latest, s.available], [BRIDGE_VERSION, NEWER, true]);
  assert.ok(s.checkedAt && !Number.isNaN(Date.parse(s.checkedAt)));
  assert.strictEqual(U.getUpdateState().available, true, 'cached in memory');
  assert.strictEqual(changes.length, 1, 'listener fired on change');
  await U.checkForUpdate();
  assert.strictEqual(changes.length, 1, 'no change, no event');
  const cache = JSON.parse(readFileSync(join(home, 'update-check.json'), 'utf8'));
  assert.strictEqual(cache.latest, NEWER, 'cached on disk');
  off();

  // not available
  freshRelease({ version: BRIDGE_VERSION });
  const same = await U.checkForUpdate();
  assert.strictEqual(same.available, false);
  freshRelease({ version: '0.0.1' });
  assert.strictEqual((await U.checkForUpdate()).available, false, 'older remote is not an update');

  // cache re-evaluated against the CURRENT version after a restart
  U.resetUpdateState();
  writeFileSync(join(home, 'update-check.json'), JSON.stringify({ latest: BRIDGE_VERSION, checkedAt: 'x', available: true }));
  assert.strictEqual(U.readCache().available, false, 'stale cached "available" is recomputed');

  // network failure: silent, never throws, keeps the previous answer
  freshRelease();
  await U.checkForUpdate();
  process.env.GRIP_UPDATE_BASE = 'http://127.0.0.1:1/';
  const failed = await U.checkForUpdate();
  assert.ok(failed.error, 'failure reported in the result, not thrown');
  assert.strictEqual(failed.available, true, 'previous state carried over');
  process.env.GRIP_UPDATE_BASE = BASE;

  // oversized / malformed manifests
  freshRelease({ manifestRaw: 'x'.repeat(70 * 1024) });
  assert.match((await U.checkForUpdate()).error, /too large/);
  freshRelease({ manifestRaw: 'not json' });
  assert.match((await U.checkForUpdate()).error, /not valid JSON/);
  freshRelease({ manifestRaw: JSON.stringify({ version: '1.0.0', bridge: { file: '../../etc/passwd', sha256: 'a'.repeat(64) } }) });
  assert.match((await U.checkForUpdate()).error, /bridge/);
  freshRelease({ manifestRaw: JSON.stringify({ version: '1.0.0', bridge: { file: 'b.mjs', sha256: 'a'.repeat(64) }, plugin: { files: { '../evil': { path: 'x', sha256: 'a'.repeat(64) } } } }) });
  assert.match((await U.checkForUpdate()).error, /plugin file entry/);
}

// ---------------------------------------------------------------- 3. install
{
  const home = tmp('grip-upd-home-');
  env(home);
  freshRelease();
  writeFileSync(join(home, 'grip-bridge.mjs'), 'OLD BRIDGE');
  const r = await U.installUpdate();
  assert.strictEqual(r.status, 'updated');
  assert.deepStrictEqual([r.from, r.to], [BRIDGE_VERSION, NEWER]);
  assert.strictEqual(readFileSync(join(home, 'grip-bridge.mjs'), 'utf8'), release.bridge.toString(), 'bridge installed');
  assert.strictEqual(readFileSync(join(home, 'grip-bridge.prev.mjs'), 'utf8'), 'OLD BRIDGE', 'previous kept for rollback');
  for (const [n, b] of Object.entries(release.files)) {
    assert.strictEqual(readFileSync(join(home, 'figma-plugin', n)).toString(), b.toString(), `plugin file ${n}`);
  }
  if (process.platform !== 'win32') assert.ok(statSync(join(home, 'grip-bridge.mjs')).mode & 0o100, 'bridge is executable');
  assert.ok(!snapshotDir(home).includes('.tmp-'), 'no temp files left behind');
  const written = readdirSync(home).sort();
  assert.ok(written.every((n) => ['figma-plugin', 'grip-bridge.mjs', 'grip-bridge.prev.mjs', 'update-check.json'].includes(n)), `only expected entries in GRIP_HOME: ${written}`);

  // rollback restores the previous bridge
  U.rollbackBridge();
  assert.strictEqual(readFileSync(join(home, 'grip-bridge.mjs'), 'utf8'), 'OLD BRIDGE', 'rollback restored it');
  assert.throws(() => { process.env.GRIP_HOME = tmp('grip-empty-'); U.rollbackBridge(); }, /no previous version/);

  // up to date: nothing is downloaded or written
  const home2 = tmp('grip-upd-home-');
  env(home2);
  freshRelease({ version: BRIDGE_VERSION });
  const same = await U.installUpdate();
  assert.strictEqual(same.status, 'up_to_date');
  assert.ok(!hits['/bridge/grip-bridge.mjs'], 'no download when up to date');
  assert.strictEqual(snapshotDir(home2), '', 'nothing written');
}

// sha mismatch (CDN lag / tampering) aborts and leaves everything untouched
{
  const home = tmp('grip-upd-home-');
  env(home);
  freshRelease();
  writeFileSync(join(home, 'grip-bridge.mjs'), 'OLD BRIDGE');
  mkdirSync(join(home, 'figma-plugin'));
  writeFileSync(join(home, 'figma-plugin', 'code.js'), 'OLD PLUGIN');
  const before = snapshotDir(home);
  release.bodies['/bridge/grip-bridge.mjs'] = Buffer.from('// tampered bridge ' + NEWER + '\n');
  await assert.rejects(U.installUpdate(), /sha256|size mismatch/);
  assert.strictEqual(snapshotDir(home), before, 'no files added');
  assert.strictEqual(readFileSync(join(home, 'grip-bridge.mjs'), 'utf8'), 'OLD BRIDGE', 'bridge untouched');
  assert.strictEqual(readFileSync(join(home, 'figma-plugin', 'code.js'), 'utf8'), 'OLD PLUGIN', 'plugin untouched');
  await assert.rejects(U.installUpdate(), /retry in a few minutes/, 'error tells the user to retry later');

  // a bad PLUGIN file also aborts before the (good) bridge is written
  delete release.bodies['/bridge/grip-bridge.mjs'];
  release.bodies['/figma-plugin/ui.html'] = Buffer.from('<html>tampered</html>');
  await assert.rejects(U.installUpdate(), /plugin file ui\.html/);
  assert.strictEqual(readFileSync(join(home, 'grip-bridge.mjs'), 'utf8'), 'OLD BRIDGE', 'bridge not written when a plugin file fails');
  assert.strictEqual(snapshotDir(home), before);
}

// redirects: same-origin ok (max 3), off-origin refused, loops capped; size cap
{
  const home = tmp('grip-upd-home-');
  env(home);
  freshRelease({ bridgePathInManifest: 'redir-same' });
  assert.strictEqual((await U.installUpdate()).status, 'updated', 'same-origin redirect followed');

  const home2 = tmp('grip-upd-home-');
  env(home2);
  freshRelease({ bridgePathInManifest: 'redir-off' });
  await assert.rejects(U.installUpdate(), /off-origin/);
  assert.strictEqual(otherHits, 0, 'the off-origin host was never contacted');
  assert.strictEqual(snapshotDir(home2), '');

  freshRelease({ bridgePathInManifest: 'redir-loop' });
  await assert.rejects(U.installUpdate(), /too many redirects/);

  freshRelease({ bridgePathInManifest: 'big' });
  await assert.rejects(U.installUpdate(), /too large/);
  assert.strictEqual(snapshotDir(home2), '', 'oversized download wrote nothing');
}

// concurrency: a second install while one runs is refused
{
  const home = tmp('grip-upd-home-');
  env(home);
  freshRelease({ bridgeDelayMs: 300 });
  const first = U.installUpdate();
  await sleep(50);
  assert.strictEqual((await U.installUpdate()).status, 'already_installing');
  assert.strictEqual((await first).status, 'updated');
}

// ---------------------------------------------------------------- 4. disabled
{
  const home = tmp('grip-upd-home-');
  env(home);
  freshRelease();
  process.env.GRIP_NO_UPDATE_CHECK = '1';
  assert.ok(U.updatesDisabled());
  const stop = U.startUpdateChecks({ delayMs: 10, intervalMs: 20 });
  await sleep(120);
  stop();
  assert.deepStrictEqual(hits, {}, 'GRIP_NO_UPDATE_CHECK: not one request');
  assert.strictEqual(U.getUpdateState(), null);
  delete process.env.GRIP_NO_UPDATE_CHECK;

  // enabled: scheduler checks after the delay
  const stop2 = U.startUpdateChecks({ delayMs: 20, intervalMs: 100000 });
  await sleep(250);
  stop2();
  assert.strictEqual(U.getUpdateState()?.latest, NEWER, 'scheduled check ran');
}

// ---------------------------------------------------------------- 5. MCP surface
async function connect(bridge) {
  const live = createSession(bridge);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await live.server.connect(st);
  const client = new Client({ name: 't', version: '0' }, { capabilities: {} });
  await client.connect(ct);
  return { live, client };
}
const fakeBridge = {
  on() {}, off() {},
  snapshot: () => ({ pluginCount: 0, pendingCount: 0, plugins: [] }),
  request: async () => ({ ok: true }),
};
const texts = (r) => r.content.map((c) => c.text);

{
  const home = tmp('grip-upd-home-');
  env(home);
  freshRelease({ version: BRIDGE_VERSION });
  await U.checkForUpdate();   // state: not available
  const a = await connect(fakeBridge);
  assert.ok(!/update is available/i.test(a.client.getInstructions() ?? ''), 'no paragraph when up to date');
  const h0 = await a.client.callTool({ name: 'grip_health', arguments: {} });
  assert.strictEqual(h0.content.length, 1, 'no notice when no update');
  assert.strictEqual(JSON.parse(texts(h0)[0]).update.available, false);

  // an update appears
  freshRelease();
  await U.checkForUpdate();
  // existing session (notice not yet sent): an ERROR result must not consume it
  const bad = await a.client.callTool({ name: 'set_active_file', arguments: {} });
  assert.ok(bad.isError);
  assert.strictEqual(bad.content.length, 1, 'no notice on an error result');
  const h1 = await a.client.callTool({ name: 'grip_health', arguments: {} });
  assert.strictEqual(h1.content.length, 2, 'notice appended to the first successful result');
  assert.match(texts(h1)[1], new RegExp(`Grip update available: ${BRIDGE_VERSION.replace(/\./g, '\\.')} → ${NEWER.replace(/\./g, '\\.')}`));
  assert.match(texts(h1)[1], /Do NOT install/, 'wording forbids installing without the user');
  assert.match(texts(h1)[1], /grip_update \{action:'install'\}/);
  JSON.parse(texts(h1)[0]);   // first block is still plain JSON
  assert.deepStrictEqual(
    Object.keys(JSON.parse(texts(h1)[0]).update).sort(), ['available', 'checkedAt', 'current', 'latest'],
    'grip_health.update shape');
  assert.strictEqual(JSON.parse(texts(h1)[0]).update.latest, NEWER);
  const h2 = await a.client.callTool({ name: 'grip_health', arguments: {} });
  assert.strictEqual(h2.content.length, 1, 'only once per session');

  // a NEW session: paragraph in instructions + notice again
  const b = await connect(fakeBridge);
  assert.match(b.client.getInstructions(), /update is available/i);
  assert.match(b.client.getInstructions(), /Never install without their explicit yes/);
  const b1 = await b.client.callTool({ name: 'grip_health', arguments: {} });
  assert.strictEqual(b1.content.length, 2);

  // grip_update itself never gets the notice appended
  const c = await connect(fakeBridge);
  const chk = await c.client.callTool({ name: 'grip_update', arguments: {} });
  assert.strictEqual(chk.content.length, 1);
  const chkJ = JSON.parse(texts(chk)[0]);
  assert.strictEqual(chkJ.available, true);
  assert.match(chkJ.note, /ask if they want it/);
  const bogus = await c.client.callTool({ name: 'grip_update', arguments: { action: 'nuke' } });
  assert.ok(bogus.isError, 'unknown action rejected');

  // disabled: no paragraph, no notice, check does not touch the network
  process.env.GRIP_NO_UPDATE_CHECK = '1';
  hits = {};
  const d = await connect(fakeBridge);
  assert.ok(!/update is available/i.test(d.client.getInstructions() ?? ''));
  const dh = await d.client.callTool({ name: 'grip_health', arguments: {} });
  assert.strictEqual(dh.content.length, 1, 'no notice when disabled');
  const dc = JSON.parse(texts(await d.client.callTool({ name: 'grip_update', arguments: { action: 'check' } }))[0]);
  assert.strictEqual(dc.disabled, true);
  assert.deepStrictEqual(hits, {}, 'disabled check made no request');
  delete process.env.GRIP_NO_UPDATE_CHECK;

  // grip_update install through MCP: files written + restart scheduled via hook
  let restarted = 0;
  U.setRestartHook(() => { restarted++; }, true);
  process.env.GRIP_UPDATE_RESTART_DELAY_MS = '30';
  const e = await connect(fakeBridge);
  const inst = await e.client.callTool({ name: 'grip_update', arguments: { action: 'install' } });
  assert.ok(!inst.isError, texts(inst)[0]);
  const ij = JSON.parse(texts(inst)[0]);
  assert.deepStrictEqual([ij.status, ij.from, ij.to, ij.restart], ['updated', BRIDGE_VERSION, NEWER, 'scheduled']);
  assert.ok(ij.next.some((s) => /~\/\.grip\/figma-plugin/.test(s) && /git pull/.test(s)), 'plugin guidance for both import styles');
  assert.ok(ij.next.some((s) => /HTTP transport/.test(s)), 'HTTP reconnect guidance');
  assert.ok(existsSync(join(home, 'grip-bridge.mjs')));
  await sleep(150);
  assert.strictEqual(restarted, 1, 'restart hook ran after the response');
  // unmanaged bridge: installed, but not restarted
  U.setRestartHook(() => { restarted++; }, false);
  freshRelease({ version: '99.2.0' });
  const inst2 = JSON.parse(texts(await e.client.callTool({ name: 'grip_update', arguments: { action: 'install' } }))[0]);
  assert.strictEqual(inst2.restart, 'not_managed');
  await sleep(100);
  assert.strictEqual(restarted, 1, 'unmanaged bridge does not restart');
  // failure surfaces as a tool error
  release.bodies['/bridge/grip-bridge.mjs'] = Buffer.from('bad');
  freshRelease({ version: '99.3.0' });
  release.bodies['/bridge/grip-bridge.mjs'] = Buffer.from('bad');
  const inst3 = await e.client.callTool({ name: 'grip_update', arguments: { action: 'install' } });
  assert.ok(inst3.isError && /retry in a few minutes/.test(texts(inst3)[0]));
  U.setRestartHook(null, false);
  delete process.env.GRIP_UPDATE_RESTART_DELAY_MS;

  // registration: in TOOLS, meta (always in scope, incl. core)
  assert.ok(TOOLS.some((t) => t.name === 'grip_update'));
  const tl = await e.client.listTools();
  assert.ok(tl.tools.some((t) => t.name === 'grip_update'), 'grip_update advertised in the default (core) scope');
  const upd = tl.tools.find((t) => t.name === 'grip_update');
  assert.deepStrictEqual(upd.inputSchema.properties.action.enum, ['check', 'install']);
}

// ---------------------------------------------------------------- 6. WS (plugin strip)
assert.ok(originAllowedForUpdate(undefined) && originAllowedForUpdate('null') && originAllowedForUpdate('https://www.figma.com'));
assert.ok(!originAllowedForUpdate('https://evil.example') && !originAllowedForUpdate('http://localhost:3000'));
{
  const home = tmp('grip-upd-home-');
  env(home);
  freshRelease();
  const port = await new Promise((res) => { const s = createNetServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const bridge = new PluginBridge(port);
  await new Promise((r) => bridge.once('listening', r));
  let restarted = 0;
  U.setRestartHook(() => { restarted++; }, true);
  process.env.GRIP_UPDATE_RESTART_DELAY_MS = '30';
  await U.checkForUpdate();
  const unwire = U.wireUpdateToBridge(bridge);

  const open = (origin) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, origin ? { origin } : {});
    const msgs = [];
    ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve({ ws, msgs }));
  });
  const hello = (ws) => ws.send(JSON.stringify({ kind: 'hello', version: BRIDGE_VERSION, fileKey: 'k', fileName: 'f', currentPageId: '0:1', currentPageName: 'P' }));
  const waitFor = async (msgs, pred, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { const m = msgs.find(pred); if (m) return m; await sleep(20); } return null; };

  // a plugin with a bad Origin: refused, nothing installed
  const evil = await open('https://evil.example');
  hello(evil.ws);
  await sleep(100);
  const hitsBefore = hits['/bridge/grip-bridge.mjs'] ?? 0;
  evil.ws.send(JSON.stringify({ type: 'update_request' }));
  const refused = await waitFor(evil.msgs, (m) => m.type === 'update_result');
  assert.strictEqual(refused?.status, 'error', 'web-page origin refused');
  await sleep(100);
  assert.strictEqual(hits['/bridge/grip-bridge.mjs'] ?? 0, hitsBefore, 'refused request downloaded nothing');
  assert.ok(!existsSync(join(home, 'grip-bridge.mjs')));
  evil.ws.close();

  // a real plugin (Origin null): gets the notice on hello, can trigger install
  const plug = await open('null');
  assert.strictEqual((await waitFor(plug.msgs, (m) => m.kind === 'welcome'))?.kind, 'welcome');
  hello(plug.ws);
  const note = await waitFor(plug.msgs, (m) => m.type === 'update');
  assert.deepStrictEqual([note?.available, note?.latest], [true, NEWER], 'update notice pushed on hello');

  // unrelated / unknown frames are ignored (compat), the bridge keeps working
  plug.ws.send(JSON.stringify({ type: 'something_new', x: 1 }));
  plug.ws.send(JSON.stringify({ type: 'update_request' }));
  const res = await waitFor(plug.msgs, (m) => m.type === 'update_result');
  assert.deepStrictEqual([res?.status, res?.to, res?.restart], ['updated', NEWER, 'scheduled']);
  assert.ok(existsSync(join(home, 'grip-bridge.mjs')), 'install ran');
  await sleep(150);
  assert.strictEqual(restarted, 1);

  // state change broadcast (e.g. cleared)
  plug.msgs.length = 0;
  bridge.setUpdateState({ available: false, latest: NEWER });
  assert.strictEqual((await waitFor(plug.msgs, (m) => m.type === 'update'))?.available, false, 'state changes are broadcast');

  plug.ws.close();
  unwire();
  U.setRestartHook(null, false);
  delete process.env.GRIP_UPDATE_RESTART_DELAY_MS;
  bridge.close();
}

// ---------------------------------------------------------------- 7. stopRunningDaemon is conservative
{
  const home = tmp('grip-upd-home-');
  env(home);
  const statusFile = join(home, 'status.json');
  process.env.GRIP_STATUS_PATH = statusFile;

  assert.strictEqual(U.stopRunningDaemon().stopped, false, 'no status file => nothing');

  // a live process that is NOT a grip daemon must be left alone
  const decoy = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  writeFileSync(statusFile, JSON.stringify({ pid: decoy.pid }));
  const r1 = U.stopRunningDaemon();
  assert.strictEqual(r1.stopped, false, r1.note);
  await sleep(100);
  assert.doesNotThrow(() => process.kill(decoy.pid, 0), 'decoy still alive');
  decoy.kill();

  // stale pid
  writeFileSync(statusFile, JSON.stringify({ pid: 2 ** 22 + 12345 }));
  assert.strictEqual(U.stopRunningDaemon().stopped, false);
  // garbage
  writeFileSync(statusFile, '{"pid":"; rm -rf /"}');
  assert.strictEqual(U.stopRunningDaemon().stopped, false);

  // a process whose command line is "...grip-bridge.mjs --daemon" IS stopped
  if (process.platform !== 'win32') {
    const dir = tmp('grip-fake-daemon-');
    const script = join(dir, 'grip-bridge.mjs');
    writeFileSync(script, 'setInterval(()=>{},1000)\n');
    const fake = spawn(process.execPath, [script, '--daemon'], { stdio: 'ignore' });
    const exited = new Promise((r) => fake.once('exit', r));
    await sleep(150);
    writeFileSync(statusFile, JSON.stringify({ pid: fake.pid }));
    const r2 = U.stopRunningDaemon();
    assert.strictEqual(r2.stopped, true, r2.note);
    await Promise.race([exited, sleep(3000)]);
    assert.ok(fake.killed || fake.exitCode !== null || fake.signalCode, 'fake daemon was terminated');
  }
}

// ---------------------------------------------------------------- 8. CLI (never starts a daemon)
{
  const home = tmp('grip-upd-home-');
  env(home);
  freshRelease();
  const cliEnv = {
    ...process.env,
    GRIP_HOME: home,
    GRIP_UPDATE_BASE: BASE,
    GRIP_STATUS_PATH: join(home, 'nostatus.json'),
    GRIP_IPC_PATH: join(home, 'cli.sock'),
    GRIP_LOG_PATH: join(home, 'cli.log'),
  };
  const run = (args, input) => new Promise((resolve) => {
    const p = spawn(process.execPath, [INDEX_JS, ...args], { env: cliEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code) => resolve({ code, out, err }));
    p.stdin.end(input ?? '');
  });

  const chk = await run(['update', '--check']);
  assert.strictEqual(chk.code, 0, chk.err);
  assert.match(chk.out, new RegExp(`Update available: ${BRIDGE_VERSION.replace(/\./g, '\\.')} -> ${NEWER.replace(/\./g, '\\.')}`));
  assert.ok(!existsSync(join(home, 'grip-bridge.mjs')), '--check installs nothing');
  assert.ok(!existsSync(join(home, 'cli.sock')) && !existsSync(join(home, 'cli.log')), 'CLI started no daemon and wrote no daemon log');

  // `--update` alias; check with the network down still exits 0
  const down = await new Promise((resolve) => {
    const p = spawn(process.execPath, [INDEX_JS, '--update', '--check'], { env: { ...cliEnv, GRIP_UPDATE_BASE: 'http://127.0.0.1:1/' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('exit', (code) => resolve({ code, out }));
  });
  assert.strictEqual(down.code, 0);
  assert.match(down.out, /Could not check/);

  // no TTY and no --yes: refuses, installs nothing
  const noyes = await run(['update']);
  assert.strictEqual(noyes.code, 1);
  assert.match(noyes.out, /--yes/);
  assert.ok(!existsSync(join(home, 'grip-bridge.mjs')));

  // --yes installs; rollback restores
  writeFileSync(join(home, 'grip-bridge.mjs'), 'OLD BRIDGE');
  const yes = await run(['update', '--yes']);
  assert.strictEqual(yes.code, 0, yes.err);
  assert.match(yes.out, /Updated/);
  assert.strictEqual(readFileSync(join(home, 'grip-bridge.mjs'), 'utf8'), release.bridge.toString());
  assert.ok(existsSync(join(home, 'figma-plugin', 'ui.html')));
  const rb = await run(['update', '--rollback']);
  assert.strictEqual(rb.code, 0, rb.err);
  assert.strictEqual(readFileSync(join(home, 'grip-bridge.mjs'), 'utf8'), 'OLD BRIDGE');

  // up to date
  freshRelease({ version: BRIDGE_VERSION });
  const utd = await run(['update']);
  assert.strictEqual(utd.code, 0);
  assert.match(utd.out, /up to date/);
}

// ---------------------------------------------------------------- 9. nothing leaked into the real home
assert.ok(process.env.GRIP_HOME.startsWith(tmpdir()), 'tests only ever used temp dirs');

server.close();
other.close();
console.log('update.mjs OK');
