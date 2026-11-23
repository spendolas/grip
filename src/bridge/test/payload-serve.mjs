// The bridge serves the signed plugin payload (payload.json) to a shell plugin after the
// handshake, only when the flavour is a loader. The bundle under test is the neutral acme
// loader flavour; the public bundle must ignore the frames.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { flavourBundler } from './_bundle.mjs';
import { PairingStore } from '../dist/pairing.js';

const here = dirname(fileURLToPath(import.meta.url));
const bridgeDir = resolve(here, '..');
const repo = resolve(bridgeDir, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
async function waitFor(fn, ms = 3000) { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout waiting'); await sleep(20); } }

const home = mkdtempSync(join(tmpdir(), 'payload-serve-'));
process.env.GRIP_HOME = home;      // honoured by the acme bundle only with GRIP_TEST=1 (a locked flavour)
process.env.GRIP_TEST = '1';
const pdir = join(home, 'figma-plugin');
mkdirSync(pdir, { recursive: true });
delete process.env.GRIP_PAIRING;

async function load(flavourDir, label) {
  const tmp = mkdtempSync(join(tmpdir(), `payload-bundle-${label}-`));
  const b = flavourBundler(flavourDir, tmp);
  const entry = join(tmp, 'entry.ts');
  writeFileSync(entry, `export { PluginBridge } from ${JSON.stringify(join(bridgeDir, 'src', 'ws-server.ts'))};\nexport { readPayload, payloadReply } from ${JSON.stringify(join(bridgeDir, 'src', 'payload.ts'))};\n`);
  const file = join(tmp, 'm.mjs');
  writeFileSync(file, "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);\n" + await b.bundle(relative(bridgeDir, entry)));
  return import(pathToFileURL(file).href);
}
const acme = await load(join(here, 'fixtures', 'flavour-alt'), 'acme');
const pub = await load(join(repo, 'flavour'), 'public');

const env = (version, over = {}) => ({ layout: 1, header: { shellProtocol: 1, flavour: 'acme', version }, code: 'var a;', ui: '', sig: 'A'.repeat(86) + '==', ...over });
const put = (obj, name = 'payload.json') => writeFileSync(join(pdir, name), typeof obj === 'string' ? obj : JSON.stringify(obj));
const errLines = [];
const realWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (c, ...r) => { errLines.push(String(c)); return realWrite(c, ...r); };

// ---- (a) readPayload validation
{
  const f = join(pdir, 'payload.json');
  rmSync(f, { force: true });
  assert.equal(acme.readPayload(pdir), null, 'no file');
  put('{not json'); assert.equal(acme.readPayload(pdir), null, 'bad json');
  put(env('0.9.7', { header: { shellProtocol: 1, flavour: 'grip', version: '0.9.7' } })); assert.equal(acme.readPayload(pdir), null, 'another flavour');
  put(env('1.2')); assert.equal(acme.readPayload(pdir), null, 'version not x.y.z');
  put(env('0.9.7', { sig: '' })); assert.equal(acme.readPayload(pdir), null, 'empty signature');
  put(env('0.9.7', { layout: 2 })); assert.equal(acme.readPayload(pdir), null, 'wrong layout');
  put(env('0.9.7', { code: 5 })); assert.equal(acme.readPayload(pdir), null, 'wrong type');
  put(env('0.9.7', { code: 'x'.repeat(8 * 1024 * 1024 + 1) })); assert.equal(acme.readPayload(pdir), null, 'over 8MB');
  put(env('0.9.7'));
  const ok = acme.readPayload(pdir);
  assert.equal(ok.version, '0.9.7');
  assert.equal(ok.envelope.code, 'var a;');
  // a rewritten file is picked up (mtime/size memo)
  put(env('0.9.8', { code: 'var bb;' }));
  utimesSync(f, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  assert.equal(acme.readPayload(pdir).version, '0.9.8');
  // the problem was said on stderr (not stdout), without echoing the payload
  assert.ok(errLines.some((l) => /payload/i.test(l)));
}

// ---- (b) the reply
{
  put(env('1.0.0'));
  const r = (v) => acme.payloadReply({ version: v }, pdir);
  assert.equal(r(null).type, 'payload');
  assert.equal(r('0.9.0').type, 'payload');
  assert.equal(r('junk').type, 'payload');
  assert.equal(r('1.0.0').type, 'payload_current');
  assert.equal(r('1.0.1').type, 'payload_current');
  assert.equal(r(null).envelope.header.version, '1.0.0');
  rmSync(join(pdir, 'payload.json'));
  assert.equal(r(null).type, 'payload_unavailable', 'nothing to serve');
}

// ---- over the socket
const bridges = [], sockets = [];
async function startBridge(m, opts = {}) {
  const port = await freePort();
  const bridge = new m.PluginBridge(port, { flavour: m === acme ? 'acme' : undefined, ...opts });
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
  c.send = (o) => ws.send(JSON.stringify(o));
  return c;
}
const have = (v, flavour = 'acme') => ({ type: 'payload_have', flavour, shellProtocol: 1, version: v });

// (c) a loader bridge serves the paired/open client
{
  put(env('1.0.0'));
  const { bridge, port } = await startBridge(acme);
  const c = await client(port);
  c.send(have(null));
  const got = await waitFor(() => c.frames.some((f) => f.type === 'payload')) ?? c.frames.find((f) => f.type === 'payload');
  void got;
  const frame = c.frames.find((f) => f.type === 'payload');
  assert.equal(frame.envelope.header.version, '1.0.0');
  assert.equal(frame.envelope.code, 'var a;');
  // current: nothing newer
  c.send(have('1.0.0'));
  await waitFor(() => c.frames.some((f) => f.type === 'payload_current'));
  // payload_have is not a hello: the session is not live
  assert.equal(bridge.snapshot().plugins.filter((p) => p.hello).length, 0);
  // payload_report is logged and not answered
  const n = c.frames.length;
  c.send({ type: 'payload_report', status: 'rejected', version: '1.0.1', code: 'bad_signature' });
  await waitFor(() => errLines.some((l) => /payload rejected 1\.0\.1 bad_signature/.test(l)));
  await sleep(100);
  assert.equal(c.frames.length, n, 'no answer to a report');
  // another flavour: closed like a hello of another flavour
  const d = await client(port);
  d.send(have(null, 'grip'));
  await waitFor(() => d.closed !== null);
  assert.equal(d.closed, 4409);
  assert.ok(!d.frames.some((f) => f.type === 'payload'));
  // a flavour that is not a string
  const e = await client(port);
  e.send({ ...have(null), flavour: 7 });
  await waitFor(() => e.closed !== null);
  assert.equal(e.closed, 4409);
}

// (c2) an unauthenticated socket (pairing required, no proof) gets nothing
{
  put(env('1.0.0'));
  const store = new PairingStore(mkdtempSync(join(tmpdir(), 'payload-pair-')), 'required');
  const { port } = await startBridge(acme, { pairing: store });
  const c = await client(port);
  c.send(have(null));
  await sleep(300);
  assert.ok(!c.frames.some((f) => f.type === 'payload' || f.type === 'payload_current' || f.type === 'payload_unavailable'));
}

// (d) the public bridge ignores the frames, silently
{
  put(env('1.0.0', { header: { shellProtocol: 1, flavour: 'grip', version: '1.0.0' } }));
  const { bridge, port } = await startBridge(pub);
  const c = await client(port);
  c.send(have(null, 'grip'));
  c.send({ type: 'payload_report', status: 'installed', version: '1.0.0' });
  await sleep(300);
  assert.equal(c.closed, null);
  assert.ok(!c.frames.some((f) => String(f.type || '').startsWith('payload')));
  assert.equal(bridge.snapshot().plugins.length, 1);
}

for (const s of sockets) try { s.close(); } catch {}
for (const b of bridges) try { b.close?.(); } catch {}
process.stderr.write = realWrite;
console.log('payload-serve.mjs OK');
process.exit(0);
