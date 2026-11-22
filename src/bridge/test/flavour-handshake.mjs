// The connect handshake carries the build flavour and the bridge refuses a plugin of another
// flavour (close 4409 "flavour mismatch") before it registers or answers anything, in every
// pairing mode. A hello with no flavour is a legacy plugin and counts as the public 'grip'.
// The pairing proof label depends on the flavour, so a proof made for one flavour never
// verifies on a bridge of another.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { WebSocket } from 'ws';
import { PluginBridge } from '../dist/ws-server.js';
import { PairingStore, authProof, authLabel } from '../dist/pairing.js';
delete process.env.GRIP_PAIRING;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
async function waitFor(fn, ms = 3000) { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout waiting'); await sleep(20); } }

const bridges = [];
const sockets = [];
const dirs = [];
async function startBridge(opts) {
  const port = await freePort();
  const bridge = new PluginBridge(port, opts);
  await new Promise((r) => bridge.once('listening', r));
  bridges.push(bridge);
  return { bridge, port };
}
async function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'null' });
  sockets.push(ws);
  const c = { ws, frames: [], closed: null, reason: '' };
  ws.on('message', (raw) => { c.frames.push(JSON.parse(raw.toString())); });
  ws.on('close', (code, reason) => { c.closed = code; c.reason = reason.toString(); });
  ws.on('error', () => {});
  await new Promise((r) => ws.on('open', r));
  await waitFor(() => c.frames.some((f) => f.kind === 'welcome'));
  c.welcome = c.frames.find((f) => f.kind === 'welcome');
  c.next = async (pred) => { await waitFor(() => c.frames.some(pred)); return c.frames.find(pred); };
  c.send = (o) => ws.send(JSON.stringify(o));
  c.hello = (name, flavour) => c.send({ kind: 'hello', version: '0.9.6', capabilities: [], fileKey: 'KEY-' + name, fileName: name, currentPageId: '0:1', currentPageName: 'P', ...(flavour === undefined ? {} : { flavour }) });
  return c;
}
const helloed = (bridge, name) => bridge.snapshot().plugins.some((p) => p.fileName === name && p.hello);
async function expectMismatch(c, bridge, name, what, since = 0) {
  await waitFor(() => c.closed !== null);
  assert.equal(c.closed, 4409, `${what}: closed with 4409`);
  assert.equal(c.reason, 'flavour mismatch', `${what}: reason`);
  if (name) assert.ok(!helloed(bridge, name), `${what}: never registered`);
  assert.ok(!c.frames.slice(since).some((f) => f.type === 'paired' || f.type === 'auth_ok' || f.id), `${what}: nothing answered`);
}

// ---- label + proof (e)
assert.equal(authLabel('grip'), 'grip-auth', 'the public flavour keeps the legacy label');
assert.equal(authLabel('acme'), 'grip-auth:acme');
assert.equal(authProof('s', 'plugin', 'a', 'b'), authProof('s', 'plugin', 'a', 'b', 'grip'), 'the slug defaults to grip');
assert.notEqual(authProof('s', 'plugin', 'a', 'b', 'acme'), authProof('s', 'plugin', 'a', 'b', 'grip'), 'acme proof differs from grip');

// ---- pairing off (no store at all, the in-process default)
{
  const { bridge, port } = await startBridge({ flavour: 'acme' });
  // (f) the welcome carries the flavour
  const a = await client(port);
  assert.equal(a.welcome.flavour, 'acme', 'welcome carries the flavour');
  // (a) acme bridge, hello without flavour (legacy = grip): refused
  a.hello('LegacyOnAcme');
  await expectMismatch(a, bridge, 'LegacyOnAcme', '(a) legacy hello on an acme bridge');
  // (b) acme hello on an acme bridge: accepted
  const b = await client(port);
  b.hello('AcmeOnAcme', 'acme');
  await waitFor(() => helloed(bridge, 'AcmeOnAcme'));
  assert.equal(b.closed, null);
  // a non-string flavour is not a flavour
  const junk = await client(port);
  junk.hello('Junk', 7);
  await expectMismatch(junk, bridge, 'Junk', 'non-string flavour');
}
{
  const { bridge, port } = await startBridge({});
  // (f) a public bridge says grip
  const c = await client(port);
  assert.equal(c.welcome.flavour, 'grip');
  // (c) public bridge accepts a legacy hello (no flavour) and an explicit grip hello
  c.hello('Legacy');
  await waitFor(() => helloed(bridge, 'Legacy'));
  const g = await client(port);
  g.hello('Explicit', 'grip');
  await waitFor(() => helloed(bridge, 'Explicit'));
  // (d) public bridge refuses acme
  const d = await client(port);
  d.hello('AcmeOnGrip', 'acme');
  await expectMismatch(d, bridge, 'AcmeOnGrip', '(d) acme hello on a public bridge');
  assert.ok(helloed(bridge, 'Legacy') && helloed(bridge, 'Explicit'), 'the refusal touches no other window');
}

// ---- pairing store in mode off (GRIP_PAIRING=off)
{
  const dir = mkdtempSync(join(tmpdir(), 'grip-flavour-')); dirs.push(dir);
  const { bridge, port } = await startBridge({ flavour: 'acme', pairing: new PairingStore(dir, 'off') });
  const c = await client(port);
  assert.equal(c.welcome.flavour, 'acme');
  assert.equal(c.welcome.nonce, undefined, 'pairing off sends no nonce');
  c.hello('OffGrip', 'grip');
  await expectMismatch(c, bridge, 'OffGrip', 'pairing off');
}

// ---- pairing auto, no tokens yet (trust on first use)
{
  const dir = mkdtempSync(join(tmpdir(), 'grip-flavour-')); dirs.push(dir);
  const store = new PairingStore(dir, 'auto');
  const { bridge, port } = await startBridge({ pairing: store });
  // a foreign plugin cannot capture the first pairing
  const p = await client(port);
  p.send({ type: 'pair_request', flavour: 'acme' });
  await expectMismatch(p, bridge, null, 'auto: foreign pair_request');
  assert.equal(store.tokens().length, 0, 'no token granted to another flavour');
  // an unauthenticated foreign hello: closed 4409 (not processed, nothing about the files sent)
  const h = await client(port);
  h.hello('AutoAcme', 'acme');
  await expectMismatch(h, bridge, 'AutoAcme', 'auto: foreign hello');
  // a legacy pair_request (no flavour) on a public bridge still pairs
  const ok = await client(port);
  ok.send({ type: 'pair_request' });
  const paired = await ok.next((f) => f.type === 'paired');
  assert.ok(paired.secret);
  ok.hello('AutoGrip');
  await waitFor(() => helloed(bridge, 'AutoGrip'));
  // once enforced, an unpaired foreign hello is still a flavour mismatch (4409), not 4403
  const late = await client(port);
  late.hello('LateAcme', 'acme');
  await expectMismatch(late, bridge, 'LateAcme', 'enforced: unauthenticated foreign hello');
}

// ---- pairing required with a valid proof
{
  const dir = mkdtempSync(join(tmpdir(), 'grip-flavour-')); dirs.push(dir);
  const store = new PairingStore(dir, 'required');
  store.openWindow();
  const tok = store.grant('test');
  assert.ok(tok);
  // (e) a grip proof never verifies for acme
  assert.equal(store.verify(tok.id, 'bn', 'pluginnonce', authProof(tok.secret, 'plugin', 'bn', 'pluginnonce', 'grip'), 'acme'), null, 'a grip proof fails on acme');
  assert.ok(store.verify(tok.id, 'bn', 'pluginnonce', authProof(tok.secret, 'plugin', 'bn', 'pluginnonce', 'acme'), 'acme'), 'an acme proof verifies on acme');
  assert.ok(store.verify(tok.id, 'bn', 'pluginnonce', authProof(tok.secret, 'plugin', 'bn', 'pluginnonce')), 'a grip proof verifies by default');
  const { bridge, port } = await startBridge({ flavour: 'acme', pairing: store });
  const np = randomBytes(16).toString('hex');
  // valid acme proof, then a hello that claims grip: authenticated, but refused at hello
  const a = await client(port);
  assert.equal(a.welcome.flavour, 'acme');
  a.send({ type: 'auth', flavour: 'acme', tokenId: tok.id, nonce: np, proof: authProof(tok.secret, 'plugin', a.welcome.nonce, np, 'acme') });
  const ok = await a.next((f) => f.type === 'auth_ok');
  assert.equal(ok.proof, authProof(tok.secret, 'bridge', a.welcome.nonce, np, 'acme'), 'the bridge proves itself with its own label');
  const mark = a.frames.length;
  a.hello('ReqGrip', 'grip');
  await expectMismatch(a, bridge, 'ReqGrip', 'required: valid proof, foreign hello', mark);
  // valid acme proof + acme hello: accepted
  const b = await client(port);
  b.send({ type: 'auth', flavour: 'acme', tokenId: tok.id, nonce: np, proof: authProof(tok.secret, 'plugin', b.welcome.nonce, np, 'acme') });
  await b.next((f) => f.type === 'auth_ok');
  b.hello('ReqAcme', 'acme');
  await waitFor(() => helloed(bridge, 'ReqAcme'));
  // (e) a grip proof on an acme bridge fails verification
  const g = await client(port);
  g.send({ type: 'auth', flavour: 'acme', tokenId: tok.id, nonce: np, proof: authProof(tok.secret, 'plugin', g.welcome.nonce, np, 'grip') });
  await g.next((f) => f.type === 'auth_failed');
  await waitFor(() => g.closed === 4401);
  // an auth frame from a foreign (here: legacy = grip) plugin is a mismatch before any proof check
  const l = await client(port);
  l.send({ type: 'auth', tokenId: tok.id, nonce: np, proof: authProof(tok.secret, 'plugin', l.welcome.nonce, np, 'grip') });
  await expectMismatch(l, bridge, null, 'required: legacy auth frame on an acme bridge');
}

for (const s of sockets) { try { s.close(); } catch {} }
for (const b of bridges) b.close();
for (const d of dirs) rmSync(d, { recursive: true, force: true });
console.log('flavour-handshake.mjs OK');
process.exit(0);
