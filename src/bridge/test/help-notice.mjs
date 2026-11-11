// The bridge refreshes imported plugin copies by itself (one click); the agent is
// told only about what is left. No network, temp GRIP_HOME, fake Figma settings.
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as U from '../dist/update.js';
import { BRIDGE_VERSION } from '../dist/types.js';
import { createSession } from '../dist/mcp-server.js';

const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const ID = '1234567890';
const manifest = (o = {}) => JSON.stringify({ name: 'Grip', id: ID, main: 'code.js', ui: 'ui.html', ...o });
function mkPlugin(dir, ver, o = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), o.manifest ?? manifest());
  writeFileSync(join(dir, 'code.js'), `(() => { const PLUGIN_VERSION = '${ver}'; })();`);
  writeFileSync(join(dir, 'ui.html'), o.ui ?? `UI ${ver}`);
  if (o.when) utimesSync(join(dir, 'code.js'), o.when, o.when);
}
// A fresh world: GRIP_HOME with the installed plugin, plus a fake Figma settings file.
function world(entries = [], installed = '0.9.0') {
  const root = tmp('grip-help-');
  const home = join(root, 'home');
  mkPlugin(join(home, 'figma-plugin'), installed);
  const settings = join(root, 'settings.json');
  const write = (es) => writeFileSync(settings, JSON.stringify({ clientID: 'must-not-matter', localFileExtensions: es.map((p, i) => ({ id: i + 1, manifestPath: join(p, 'manifest.json'), fileMetadata: { type: 'manifest' } })) }));
  write(entries);
  process.env.GRIP_HOME = home;
  process.env.GRIP_STATUS_PATH = join(root, 'nostatus.json');
  process.env.GRIP_FIGMA_SETTINGS = settings;
  process.env.GRIP_RELEASES_API = 'http://127.0.0.1:9/none';
  delete process.env.GRIP_NO_UPDATE_CHECK;
  U.resetUpdateState();
  return { root, home, settings, write };
}
const win = (v, name = 'File', o = {}) => ({ pluginVersion: v, fileName: name, wsReady: true, hello: true, ...o });
const makeBridge = (plugins) => ({ on() {}, off() {}, snapshot: () => ({ pluginCount: plugins.length, pendingCount: 0, plugins }), request: async () => ({ ok: true }) });
async function connect(bridge) {
  const live = createSession(bridge);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await live.server.connect(st);
  const client = new Client({ name: 't', version: '0' }, { capabilities: {} });
  await client.connect(ct);
  return { live, client };
}
const texts = (r) => r.content.map((c) => c.text);
const health = (c) => c.client.callTool({ name: 'grip_health', arguments: {} });

// ---- the installed copy's version: read, cached by mtime, null when missing/odd
{
  const w = world();
  assert.strictEqual(U.installedPluginVersion(), '0.9.0');
  mkPlugin(join(w.home, 'figma-plugin'), '0.9.5', { when: new Date(5_000_000) });
  assert.strictEqual(U.installedPluginVersion(), '0.9.5', 'a changed file is re-read');
  writeFileSync(join(w.home, 'figma-plugin', 'code.js'), 'no version here');
  assert.strictEqual(U.installedPluginVersion(), null);
}

// ---- finding the imported copies
{
  const w = world();
  const picked = join(w.root, 'picked'); mkPlugin(picked, '0.8.0');
  const current = join(w.root, 'current'); mkPlugin(current, '0.9.0');
  const newer = join(w.root, 'newer'); mkPlugin(newer, '1.0.0');
  const clone = join(w.root, 'clone'); mkPlugin(clone, '0.8.0'); mkdirSync(join(clone, '.git'));
  const odd = join(w.root, 'odd'); mkPlugin(odd, '0.8.0', { manifest: manifest({ main: 'dist/main.js' }) });
  const other = join(w.root, 'other'); mkPlugin(other, '0.1.0', { manifest: manifest({ id: 'someone-elses' }) });
  w.write([picked, picked, current, newer, clone, odd, other, join(w.home, 'figma-plugin'), join(w.root, 'gone')]);
  const { known, copies } = U.findPluginCopies(true);
  assert.strictEqual(known, true);
  const by = Object.fromEntries(copies.map((c) => [c.dir.split('/').pop(), c]));
  assert.deepStrictEqual(Object.keys(by).sort(), ['clone', 'current', 'newer', 'odd', 'picked'], 'other plugins, the ~/.grip copy, duplicates and missing folders are ignored');
  assert.deepStrictEqual([by.picked.behind, by.picked.skip], [true, undefined]);
  assert.deepStrictEqual([by.current.behind, by.newer.behind], [false, false]);
  assert.strictEqual(by.clone.skip, 'git_checkout');
  assert.strictEqual(by.odd.skip, 'not_a_plain_copy');

  // refreshing: only the behind, plain, non-git copy; never a downgrade; atomic, no temp files
  const r = U.syncPluginCopies();
  assert.deepStrictEqual(r.updated, [picked]);
  assert.deepStrictEqual(r.skipped.map((s) => [s.dir.split('/').pop(), s.reason]).sort(), [['clone', 'git_checkout'], ['odd', 'not_a_plain_copy']]);
  for (const f of ['code.js', 'ui.html', 'manifest.json']) assert.strictEqual(readFileSync(join(picked, f), 'utf8'), readFileSync(join(w.home, 'figma-plugin', f), 'utf8'), f);
  assert.strictEqual(readFileSync(join(newer, 'ui.html'), 'utf8'), 'UI 1.0.0', 'never a downgrade');
  assert.strictEqual(readFileSync(join(clone, 'ui.html'), 'utf8'), 'UI 0.8.0', 'a git checkout is never written');
  assert.ok(readdirSync(picked).every((n) => !n.includes('.tmp-')), 'no temp files');
  assert.deepStrictEqual(U.syncPluginCopies().updated, [], 'second run: nothing left to do');
}

// ---- Figma's list unreadable: known:false and nothing is touched
{
  const w = world([]);
  writeFileSync(w.settings, '{ not json');
  assert.deepStrictEqual(U.findPluginCopies(true), { known: false, copies: [] });
  writeFileSync(w.settings, JSON.stringify({ localFileExtensions: 'nope' }));
  assert.strictEqual(U.findPluginCopies(true).known, false);
  process.env.GRIP_FIGMA_SETTINGS = join(w.root, 'missing.json');
  assert.strictEqual(U.findPluginCopies(true).known, false);
  assert.deepStrictEqual(U.syncPluginCopies(), { updated: [], skipped: [] });
}

// ---- the agent is told only about what the bridge cannot do
{
  const behind = [win('0.8.0', 'Sombra')];
  // refreshable copy: the strip handles it, no agent notice
  let w = world(); let picked = join(w.root, 'picked'); mkPlugin(picked, '0.8.0'); w.write([picked]);
  assert.deepStrictEqual(U.helpNotices(behind), [], 'a refreshable copy needs no agent');
  // after the refresh the window is still behind until the dev plugin reloads itself: still nothing to ask
  U.syncPluginCopies();
  assert.deepStrictEqual(U.helpNotices(behind), [], 'dev plugins hot swap: nothing to do');
  // Figma's list is readable and has no copy of Grip: a Community plugin, Figma updates it
  w = world([]);
  const [cn] = U.helpNotices(behind);
  assert.strictEqual(cn.kind, 'plugin', 'Community plugin: only reopening helps, so the agent can say so');
  assert.match(cn.text, /most likely came from Figma Community/);
  assert.match(cn.text, /close the Grip plugin and open it again/);
  assert.match(cn.text, /not published the newer version yet/, 'hedged: the review may not be done');
  assert.match(cn.text, /Grip already showed a notice inside Figma/);
  // only a git checkout: the bridge will not write there
  w = world(); const clone = join(w.root, 'clone'); mkPlugin(clone, '0.8.0'); mkdirSync(join(clone, '.git')); w.write([clone]);
  let [n] = U.helpNotices(behind);
  assert.strictEqual(n.kind, 'plugin');
  assert.match(n.text, /"Sombra" runs 0\.8\.0/);
  assert.ok(n.text.includes(clone) && /git pull and npm run build/.test(n.text));
  assert.ok(n.text.includes(join(w.home, 'figma-plugin', 'manifest.json')));
  assert.match(n.text, /do not change anything on your own/);
  // the bridge cannot tell where the plugin came from (no Figma settings)
  w = world(); process.env.GRIP_FIGMA_SETTINGS = join(w.root, 'missing.json');
  [n] = U.helpNotices(behind);
  assert.match(n.text, /could not tell where this plugin was imported from/);
  assert.match(n.text, /Figma Community, Figma updates it by itself/);
  // nothing in any text tells the user to re-run or hot reload
  for (const t of [n.text, U.helpNotices([win('0.8.0')])[0].text]) assert.ok(!/re-run|run the plugin again|Hot reload/i.test(t), t);
}

// ---- the toast in Figma: a Community window older than the plugin this bridge ships
{
  const mkBridge = (plugins) => {
    const b = new EventEmitter();
    const toasts = [];
    Object.assign(b, { snapshot: () => ({ plugins }), setUpdateState() {}, sendTo() {}, pushUpdate() {}, toast: (sid, msg) => { toasts.push([sid, msg]); return true; } });
    return { b, toasts };
  };
  const plugins = [win('0.8.0', 'Sombra', { sessionId: 'old' }), win('0.9.0', 'Fresh', { sessionId: 'new' })];
  // Figma's list is readable and has no Grip: Community. One toast, to the old window only.
  world([]);
  let { b, toasts } = mkBridge(plugins);
  let off = U.wireUpdateToBridge(b);
  assert.strictEqual(toasts.length, 1);
  assert.strictEqual(toasts[0][0], 'old');
  assert.strictEqual(toasts[0][1], 'Grip was updated. Reopen the plugin to load its new version.');
  b.emit('session-change'); b.emit('session-change');
  assert.strictEqual(toasts.length, 1, 'reconnect churn does not repeat it');
  off();
  // the bridge restarts (the update itself does): still not repeated within 3 days
  ({ b, toasts } = mkBridge(plugins));
  off = U.wireUpdateToBridge(b);
  assert.strictEqual(toasts.length, 0, 'throttled across restarts');
  off();
  // an imported dev copy exists (even a git checkout): a dev plugin hot-swaps, no toast
  const w = world(); const clone = join(w.root, 'clone'); mkPlugin(clone, '0.8.0'); mkdirSync(join(clone, '.git')); w.write([clone]);
  ({ b, toasts } = mkBridge(plugins));
  off = U.wireUpdateToBridge(b);
  assert.strictEqual(toasts.length, 0, 'dev copy: no toast');
  off();
  // checks off: silent
  world([]); process.env.GRIP_NO_UPDATE_CHECK = '1';
  ({ b, toasts } = mkBridge(plugins));
  off = U.wireUpdateToBridge(b);
  assert.strictEqual(toasts.length, 0);
  off();
  delete process.env.GRIP_NO_UPDATE_CHECK;
  // a window that is not behind, or a stub bridge without toast(): nothing, no crash
  world([]);
  ({ b, toasts } = mkBridge([win('0.9.0', 'Fresh', { sessionId: 'new' })]));
  off = U.wireUpdateToBridge(b);
  assert.strictEqual(toasts.length, 0);
  off();
  const plain = new EventEmitter();
  Object.assign(plain, { snapshot: () => ({ plugins }), setUpdateState() {}, sendTo() {}, pushUpdate() {} });
  world([]);
  U.wireUpdateToBridge(plain)();
}

// ---- "Grip updated" confirmation: marker, one toast per open file, merged with the reopen nudge
{
  const mkBridge = (plugins) => {
    const b = new EventEmitter();
    const toasts = [];
    Object.assign(b, { snapshot: () => ({ plugins }), setUpdateState() {}, sendTo() {}, pushUpdate() {}, toast: (sid, msg) => { toasts.push([sid, msg]); return true; } });
    return { b, toasts, plugins };
  };
  const w = world([]);
  const markerFile = join(w.home, 'update-done.json');
  const now = Date.now();
  // the marker counts only for this running version and only while fresh
  assert.strictEqual(U.readUpdateMarker(), null, 'no marker');
  U.writeUpdateMarker({ version: '99.0.0', from: BRIDGE_VERSION, at: new Date(now).toISOString(), refreshed: 0 });
  assert.strictEqual(U.readUpdateMarker(), null, 'announces another version: not ours');
  U.writeUpdateMarker({ version: BRIDGE_VERSION, from: '0.0.1', at: new Date(now - 11 * 60_000).toISOString(), refreshed: 0 });
  assert.strictEqual(U.readUpdateMarker(), null, 'older than ten minutes');
  assert.ok(!existsSync(markerFile), 'a stale marker is removed');
  U.writeUpdateMarker({ version: BRIDGE_VERSION, from: '0.0.1', at: new Date(now).toISOString(), refreshed: 2 });
  assert.deepStrictEqual(U.readUpdateMarker(), { version: BRIDGE_VERSION, from: '0.0.1', at: new Date(now).toISOString(), refreshed: 2 });
  writeFileSync(markerFile, '{ nope');
  assert.strictEqual(U.readUpdateMarker(), null, 'garbage: ignored');

  // every open file gets exactly one confirmation, also across reconnect churn (new session id, same file)
  U.writeUpdateMarker({ version: BRIDGE_VERSION, from: '0.0.1', at: new Date().toISOString(), refreshed: 1 });
  const cur = [win(BRIDGE_VERSION, 'A', { sessionId: 'a1', fileKey: 'ka' }), win(BRIDGE_VERSION, 'B', { sessionId: 'b1', fileKey: 'kb' })];
  let { b, toasts, plugins } = mkBridge(cur);
  let off = U.wireUpdateToBridge(b);
  assert.deepStrictEqual(toasts.map((t) => t[0]).sort(), ['a1', 'b1']);
  assert.strictEqual(toasts[0][1], `Grip updated to ${BRIDGE_VERSION}.`, 'short and plain, also when a plugin copy was refreshed');
  plugins[0] = win(BRIDGE_VERSION, 'A', { sessionId: 'a2', fileKey: 'ka' });   // Figma respawned the iframe
  b.emit('session-change');
  assert.strictEqual(toasts.length, 2, 'not again for the same file');
  plugins.push(win(BRIDGE_VERSION, 'C', { sessionId: 'c1', fileKey: 'kc' }));   // a file opened later (still within ten minutes)
  b.emit('session-change');
  assert.strictEqual(toasts.length, 3);
  assert.strictEqual(toasts[2][0], 'c1');
  off();
  // no marker: no confirmation
  fs.rmSync(markerFile, { force: true });
  ({ b, toasts } = mkBridge(cur));
  off = U.wireUpdateToBridge(b);
  assert.strictEqual(toasts.length, 0);
  off();
  // a Community window that is also behind: ONE message with both
  U.writeUpdateMarker({ version: BRIDGE_VERSION, from: '0.0.1', at: new Date().toISOString(), refreshed: 0 });
  ({ b, toasts } = mkBridge([win('0.1.0', 'Old', { sessionId: 'o1', fileKey: 'ko' })]));
  off = U.wireUpdateToBridge(b);
  assert.strictEqual(toasts.length, 1);
  assert.strictEqual(toasts[0][1], `Grip updated to ${BRIDGE_VERSION}. Reopen the plugin to load its new version.`, 'one short message when both apply');
  off();
  // checks off: the confirmation still shows (the user did update), the reopen nudge does not
  world([]); process.env.GRIP_NO_UPDATE_CHECK = '1';
  U.writeUpdateMarker({ version: BRIDGE_VERSION, from: '0.0.1', at: new Date().toISOString(), refreshed: 0 });
  ({ b, toasts } = mkBridge([win('0.1.0', 'Old', { sessionId: 'o1', fileKey: 'ko' })]));
  off = U.wireUpdateToBridge(b);
  assert.deepStrictEqual(toasts.map((t) => t[1]), [`Grip updated to ${BRIDGE_VERSION}.`]);
  off();
  delete process.env.GRIP_NO_UPDATE_CHECK;
}

// ---- the strip: purple for a refreshable copy, one click refreshes it
{
  const w = world(); const picked = join(w.root, 'picked'); mkPlugin(picked, '0.8.0'); w.write([picked]);
  const plugins = [win('0.8.0', 'Sombra', { sessionId: 'old' }), win('0.9.0', 'Fresh', { sessionId: 'new' }), win('0.8.0', 'Dead', { sessionId: 'dead', wsReady: false })];
  const bridge = new EventEmitter();
  const states = []; const sent = []; let pushes = 0;
  Object.assign(bridge, { snapshot: () => ({ plugins }), setUpdateState: (s) => states.push(s), sendTo: (id, m) => sent.push([id, m]), pushUpdate: () => { pushes++; } });
  const off = U.wireUpdateToBridge(bridge);
  const st = states.at(-1);
  assert.deepStrictEqual([st.available, st.latest, st.current], [true, '0.9.0', '0.8.0']);
  assert.match(st.headline, /Refresh the Grip plugin you imported \(1 folder\)/);
  assert.deepStrictEqual([st.eligible('old'), st.eligible('new'), st.eligible('dead'), st.eligible('nobody')], [true, false, false, false], 'only a window older than the installed plugin turns purple');
  bridge.emit('update-request', { sessionId: 'old', version: '0.9.0' });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepStrictEqual(sent.at(-1), ['old', { type: 'update_result', status: 'updated', to: '0.9.0', restart: 'none', copies: 1 }]);
  assert.strictEqual(readFileSync(join(picked, 'ui.html'), 'utf8'), 'UI 0.9.0');
  assert.strictEqual(states.at(-1), null, 'nothing left to offer');
  off();
}

// ---- end to end: instructions, first result, throttle, health, switch-off (git-only copy = the bridge cannot do it)
{
  const w = world(); const clone = join(w.root, 'clone'); mkPlugin(clone, '0.8.0'); mkdirSync(join(clone, '.git')); w.write([clone]);
  const plugins = [win('0.8.0', 'Sombra'), win('0.9.0', 'Fresh')];
  const a = await connect(makeBridge(plugins));
  assert.match(a.client.getInstructions() ?? '', /"Sombra" runs 0\.8\.0/, 'session instructions carry the help');
  const r1 = await health(a);
  assert.strictEqual(r1.content.length, 2, 'first successful result carries one extra block');
  const u1 = JSON.parse(texts(r1)[0]).update;
  assert.deepStrictEqual(u1.pluginBehind, [{ window: 'Sombra', running: '0.8.0', installed: '0.9.0' }]);
  assert.match(u1.pluginHelp, /git pull and npm run build/);
  assert.deepStrictEqual(u1.pluginCopies, { refreshable: [], needsYou: [{ dir: clone, reason: 'git_checkout' }] });
  assert.strictEqual((await health(a)).content.length, 1, 'only once per session');
  const b = await connect(makeBridge(plugins));
  assert.ok(!/runs 0\.8\.0/.test(b.client.getInstructions() ?? ''), 'throttled across sessions');
  const r2 = await health(b);
  assert.strictEqual(r2.content.length, 1);
  assert.ok(JSON.parse(texts(r2)[0]).update.pluginHelp, 'health is never throttled');
  // a plugin that arrives later is picked up on the next result
  world(); { const w2 = world(); const c2 = join(w2.root, 'clone'); mkPlugin(c2, '0.8.0'); mkdirSync(join(c2, '.git')); w2.write([c2]); }
  const dyn = [];
  const c = await connect(makeBridge(dyn));
  assert.strictEqual((await health(c)).content.length, 1, 'no plugin yet: nothing');
  dyn.push(win('0.8.0', 'Late'));
  assert.strictEqual((await health(c)).content.length, 2, 'plugin appears later: notice on the next result');
  // a refreshable copy: the bridge's job, health says so, no agent block
  const w3 = world(); const p3 = join(w3.root, 'picked'); mkPlugin(p3, '0.8.0'); w3.write([p3]);
  const e = await connect(makeBridge([win('0.8.0', 'Sombra')]));
  const re = await health(e);
  assert.strictEqual(re.content.length, 1, 'refreshable copy: no agent block');
  const ue = JSON.parse(texts(re)[0]).update;
  assert.deepStrictEqual(ue.pluginCopies, { refreshable: [p3], needsYou: [] });
  assert.ok(!ue.pluginHelp);
  // GRIP_NO_UPDATE_CHECK silences every notice
  const w4 = world(); const c4 = join(w4.root, 'clone'); mkPlugin(c4, '0.8.0'); mkdirSync(join(c4, '.git')); w4.write([c4]);
  process.env.GRIP_NO_UPDATE_CHECK = '1';
  const d = await connect(makeBridge([win('0.8.0', 'Quiet')]));
  assert.ok(!/runs 0\.8\.0/.test(d.client.getInstructions() ?? ''));
  assert.strictEqual((await health(d)).content.length, 1);
  delete process.env.GRIP_NO_UPDATE_CHECK;
}

// ---- a plugin that needs a newer bridge, and no update is on offer: release vs developer install
{
  const w = world();
  const stale = [win('9.0.0', 'Fresh', { minBridge: '9.0.0' })];
  const rel = U.helpNotices(stale).find((n) => n.kind === 'bridge');
  assert.strictEqual(rel.key, 'bridge-behind:9.0.0');
  assert.match(rel.text, /needs Grip bridge >= 9\.0\.0/);
  assert.match(rel.text, /No update is being offered/);
  assert.match(rel.text, /Install Grip from https:\/\/github\.com\/spendolas\/grip\/releases\/latest/);
  U.writeInstallRecord('clone', '0.9.0');
  const clone = U.helpNotices(stale).find((n) => n.kind === 'bridge').text;
  assert.match(clone, /developer install/);
  assert.match(clone, /git pull, npm run build and node bridge\/install\.mjs/);
  const s = await connect(makeBridge(stale));
  const r = await health(s);
  const u = JSON.parse(texts(r)[0]).update;
  assert.match(u.bridgeHelp, /developer install/);
  assert.strictEqual(u.updateRecommended, true);
  void w;
}

delete process.env.GRIP_FIGMA_SETTINGS;
console.log('help-notice: ok');
