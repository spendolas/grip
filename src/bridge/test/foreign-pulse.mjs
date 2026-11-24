// The insecure-foreign-Grip alert pulses: the first announcement of a file gets a toast and one red
// pulse frame, then both repeat about once a minute (here: every 200 ms) for as long as the alert
// lasts, once per FILE (not per window), and stop when it is resolved. Alert only: connections stay open.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { PluginBridge } from '../dist/ws-server.js';
import { ForeignGuard, wireForeignToBridge, FOREIGN_PULSE_MS } from '../dist/foreign-guard.js';
delete process.env.GRIP_PAIRING;

const here = dirname(fileURLToPath(import.meta.url));
const alt = JSON.parse(readFileSync(join(here, 'fixtures', 'flavour-alt', 'flavour.json'), 'utf8'));
const Z = alt.watchlist[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
async function waitFor(fn, ms = 4000) { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout waiting'); await sleep(20); } }
setTimeout(() => { console.error('foreign-pulse: timed out'); process.exit(1); }, 30_000).unref();

assert.equal(FOREIGN_PULSE_MS, 60000, 'the default is about once a minute');

const st = { probe: { kind: 'closed' } };
const io = { platform: 'linux', home: '/h', tmp: '/t', env: {}, uid: 1, probe: async () => st.probe, readText: () => null, exists: () => false, pidAlive: () => false };
const guard = new ForeignGuard([Z], io, { intervalMs: 60000 });
const port = await freePort();
const bridge = new PluginBridge(port);
await new Promise((r) => bridge.once('listening', r));
const sockets = [];
async function client(name) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'null' });
  sockets.push(ws);
  const c = { ws, frames: [], closed: false };
  ws.on('message', (raw) => { c.frames.push(JSON.parse(raw.toString())); });
  ws.on('close', () => { c.closed = true; });
  ws.on('error', () => {});
  await new Promise((r) => ws.on('open', r));
  await waitFor(() => c.frames.some((f) => f.kind === 'welcome'));
  ws.send(JSON.stringify({ kind: 'hello', version: '0.9.6', capabilities: [], fileKey: 'KEY-' + name, fileName: name, currentPageId: '0:1', currentPageName: 'P' }));
  await waitFor(() => bridge.snapshot().plugins.some((p) => p.fileName === name && p.hello));
  c.pulses = () => c.frames.filter((f) => f.type === 'foreign_alert' && f.pulse === true);
  c.toasts = () => c.frames.filter((f) => f.method === 'notify');
  return c;
}

const off = wireForeignToBridge(bridge, guard, { pulseMs: 200 });
const a = await client('A');
await sleep(500);
assert.equal(a.pulses().length, 0, 'nothing to show, nothing pulses');

st.probe = { kind: 'welcome', version: '1.0.0', flavour: null };
await guard.refresh();
await waitFor(() => a.pulses().length >= 1 && a.toasts().length >= 1);   // the first announcement
const first = a.pulses().length;
await waitFor(() => a.pulses().length >= first + 2 && a.toasts().length >= first + 2);   // and it repeats
assert.equal(a.pulses()[0].active, true);
assert.equal(a.pulses()[0].tooltip, 'Insecure Grip found: update or uninstall');
assert.ok(a.toasts()[0].params.message.includes('Insecure Grip'));

// two windows of the same file: one pulse and one toast per tick for the file, not two
a.ws.close(); await waitFor(() => a.closed);
const a1 = await client('A'); const a2 = await client('A');
await sleep(150);
const p1 = a1.pulses().length + a2.pulses().length, t1 = a1.toasts().length + a2.toasts().length;
await sleep(1000);
const dp = a1.pulses().length + a2.pulses().length - p1, dt = a1.toasts().length + a2.toasts().length - t1;
assert.ok(dp >= 3 && dp <= 7, 'about one pulse per tick for the file, got ' + dp);
assert.ok(dt >= 3 && dt <= 7, 'about one toast per tick for the file, got ' + dt);

// a second file pulses too, and nothing is closed
const b = await client('B');
await waitFor(() => b.pulses().length >= 2);
assert.ok(!a1.closed && !a2.closed && !b.closed, 'alert only: no connection is closed');

// resolved: it stops
st.probe = { kind: 'closed' };
await guard.refresh();
await sleep(300);
const after = b.pulses().length, afterT = b.toasts().length;
await sleep(700);
assert.equal(b.pulses().length, after, 'no more pulses once resolved');
assert.equal(b.toasts().length, afterT, 'no more toasts once resolved');

off();
for (const s of sockets) try { s.close(); } catch {}
bridge.close();
console.log('foreign-pulse: ok');
process.exit(0);
