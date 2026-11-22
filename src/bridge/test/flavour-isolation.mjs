// Parallel-run and isolation: a build of another flavour carries none of the public
// identity, two bridges of different flavours run side by side in one process and each
// only takes its own plugins, and the two identities share no path or port.
//
// (a) bundles src/index.ts and src/install.ts with the FIXTURE flavour (its flavour.gen.ts
//     generated into a temp dir and resolved in place of ./flavour.gen.js; the real
//     generated file is never touched) and greps the output for the public strings.
//     The whole bundle is checked, bundled dependencies included (they currently carry
//     none of these strings).
// (b) a grip and an acme PluginBridge on free ports, a grip and an acme client on each:
//     only matching pairs register, the others are closed 4409.
// (c) makeIdentity for both flavours: no shared path or port.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { flavourBundler } from './_bundle.mjs';
import { WebSocket } from 'ws';
import { PluginBridge } from '../dist/ws-server.js';
import { makeIdentity } from '../dist/identity.js';
import { FLAVOUR } from '../dist/flavour.gen.js';
delete process.env.GRIP_PAIRING;

const here = dirname(fileURLToPath(import.meta.url));
const bridgeDir = resolve(here, '..');
const repo = resolve(bridgeDir, '..', '..');
const altDir = join(here, 'fixtures', 'flavour-alt');
const alt = JSON.parse(readFileSync(join(altDir, 'flavour.json'), 'utf8'));
const tmp = mkdtempSync(join(tmpdir(), 'flavour-isolation-'));

// ---- (a) bundle with the fixture flavour
const { genFile, bundle } = flavourBundler(altDir, tmp);
assert.match(readFileSync(genFile, 'utf8'), /slug: 'acme'/);

const FORBIDDEN = ['7777', '7778', '.grip-bridge', 'Grip Daemon', 'com.grip.', '1682868744739448629', 'spendolas', '~/.grip'];
const leaks = [];
for (const entry of ['src/index.ts', 'src/install.ts']) {
  const text = await bundle(entry);
  assert.ok(text.includes("slug: \"acme\"") || text.includes("slug: 'acme'"), `${entry}: bundle carries the fixture flavour`);
  const lines = text.split('\n');
  for (const s of FORBIDDEN) {
    lines.forEach((line, i) => { if (line.includes(s)) leaks.push(`${entry} bundle line ${i + 1}: "${s}" in ${line.trim().slice(0, 160)}`); });
  }
}
assert.deepEqual(leaks, [], `public identity strings in an acme build:\n${leaks.join('\n')}`);

// ---- (c) identities share no path or port
{
  const ctx = { env: {}, platform: 'darwin', home: '/h', tmp: '/t' };
  const g = makeIdentity(FLAVOUR, ctx);
  const a = makeIdentity(alt, ctx);
  for (const k of ['wsPort', 'httpPort', 'ipcPath', 'home', 'statusPath', 'logPath', 'exportsDir', 'httpUrl', 'homeLabel']) {
    assert.notEqual(a[k], g[k], `identity ${k} differs`);
  }
  assert.notEqual(a.dumpPath(1), g.dumpPath(1));
  const gv = new Set([g.wsPort, g.httpPort]);
  assert.ok(!gv.has(a.wsPort) && !gv.has(a.httpPort), 'no port shared across flavours');
  const paths = (i) => [i.ipcPath, i.home, i.statusPath, i.logPath, i.exportsDir, i.dumpPath(1)];
  for (const p of paths(a)) assert.ok(!paths(g).includes(p), `no path shared: ${p}`);
  const win = { ...ctx, platform: 'win32' };
  assert.notEqual(makeIdentity(alt, win).ipcPath, makeIdentity(FLAVOUR, win).ipcPath, 'windows pipe differs');
}

// ---- (b) two bridges in one process
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
async function waitFor(fn, ms = 3000) { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout waiting'); await sleep(20); } }
const sockets = [];
async function client(port, flavour, name) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'null' });
  sockets.push(ws);
  const c = { ws, frames: [], closed: null, reason: '' };
  ws.on('message', (raw) => { c.frames.push(JSON.parse(raw.toString())); });
  ws.on('close', (code, reason) => { c.closed = code; c.reason = reason.toString(); });
  ws.on('error', () => {});
  await new Promise((r) => ws.on('open', r));
  await waitFor(() => c.frames.some((f) => f.kind === 'welcome'));
  ws.send(JSON.stringify({ kind: 'hello', version: '0.9.6', capabilities: [], fileKey: 'KEY-' + name, fileName: name, currentPageId: '0:1', currentPageName: 'P', flavour }));
  return c;
}
const helloed = (bridge, name) => bridge.snapshot().plugins.some((p) => p.fileName === name && p.hello);

const gp = await freePort();
const ap = await freePort();
const grip = new PluginBridge(gp, { flavour: 'grip' });
const acme = new PluginBridge(ap, { flavour: 'acme' });
await Promise.all([grip, acme].map((b) => new Promise((r) => b.once('listening', r))));
assert.ok(gp && ap && gp !== ap, 'two bridges on distinct ports');

const gOnG = await client(gp, 'grip', 'GripOnGrip');
const aOnG = await client(gp, 'acme', 'AcmeOnGrip');
const gOnA = await client(ap, 'grip', 'GripOnAcme');
const aOnA = await client(ap, 'acme', 'AcmeOnAcme');
await waitFor(() => helloed(grip, 'GripOnGrip') && helloed(acme, 'AcmeOnAcme'));
await waitFor(() => aOnG.closed !== null && gOnA.closed !== null);
for (const [c, what] of [[aOnG, 'acme client on grip bridge'], [gOnA, 'grip client on acme bridge']]) {
  assert.equal(c.closed, 4409, `${what}: 4409`);
  assert.equal(c.reason, 'flavour mismatch', `${what}: reason`);
}
assert.ok(!helloed(grip, 'AcmeOnGrip') && !helloed(acme, 'GripOnAcme'), 'mismatched pairs never register');
await sleep(100);
assert.equal(gOnG.closed, null, 'grip client stays on grip bridge');
assert.equal(aOnA.closed, null, 'acme client stays on acme bridge');
assert.deepEqual(grip.snapshot().plugins.filter((p) => p.hello).map((p) => p.fileName), ['GripOnGrip']);
assert.deepEqual(acme.snapshot().plugins.filter((p) => p.hello).map((p) => p.fileName), ['AcmeOnAcme']);

for (const s of sockets) { try { s.close(); } catch {} }
grip.close();
acme.close();
rmSync(tmp, { recursive: true, force: true });
console.log('flavour-isolation.mjs OK');
process.exit(0);
