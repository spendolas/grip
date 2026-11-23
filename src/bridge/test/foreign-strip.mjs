// The insecure-foreign-Grip alert as the plugin strips see it (phase 2B): a tooltip frame
// (replayed on hello, deduped, cleared when resolved) and one toast per window. Alert only:
// the connection stays open and ordinary requests keep working.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { PluginBridge } from '../dist/ws-server.js';
import { ForeignGuard, wireForeignToBridge } from '../dist/foreign-guard.js';
delete process.env.GRIP_PAIRING;

const here = dirname(fileURLToPath(import.meta.url));
const alt = JSON.parse(readFileSync(join(here, 'fixtures', 'flavour-alt', 'flavour.json'), 'utf8'));
const Z = alt.watchlist[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
async function waitFor(fn, ms = 3000) { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout waiting'); await sleep(20); } }
setTimeout(() => { console.error('foreign-strip: timed out'); process.exit(1); }, 30_000).unref();

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
  c.alerts = () => c.frames.filter((f) => f.type === 'foreign_alert');
  c.toasts = () => c.frames.filter((f) => f.method === 'notify');
  return c;
}

const TIP = 'Insecure Grip found: update or uninstall';
const off = wireForeignToBridge(bridge, guard);

// nothing found: a strip is told nothing
const a = await client('A');
await sleep(100);
assert.equal(a.alerts().length, 0, 'no frame when there is nothing to show');
assert.equal(a.toasts().length, 0);

// a healthy foreign Grip at the floor raises nothing
st.probe = { kind: 'welcome', version: '2.0.0', flavour: null };
await guard.refresh();
await sleep(100);
assert.equal(a.alerts().length, 0);
assert.equal(a.toasts().length, 0);

// insecure: tooltip frame + exactly one toast
st.probe = { kind: 'welcome', version: '1.0.0', flavour: null };
await guard.refresh();
await waitFor(() => a.alerts().length === 1 && a.toasts().length === 1);
assert.deepEqual(a.alerts()[0], { type: 'foreign_alert', active: true, tooltip: TIP });
assert.ok(a.toasts()[0].params.message.includes('Insecure Grip'));
assert.ok(a.toasts()[0].params.message.includes('remove-foreign'));

// identical state again, and another session-change: not re-sent, not re-toasted
await guard.refresh();
bridge.emit('session-change');
await sleep(100);
assert.equal(a.alerts().length, 1);
assert.equal(a.toasts().length, 1);

// a window that hellos AFTER the alert is on gets the frame on hello, and one toast
const b = await client('B');
await waitFor(() => b.alerts().length === 1 && b.toasts().length === 1);
assert.deepEqual(b.alerts()[0], { type: 'foreign_alert', active: true, tooltip: TIP });
await sleep(100);
assert.equal(a.toasts().length, 1, 'the first window is not toasted again');

// alert only: nothing was closed, and an ordinary request still completes (review focus 5)
assert.ok(!a.closed && !b.closed);
const mcp = { id: 'm1', activeFileId: null, bind: { name: 'A' }, subscriptions: { selection: false, document: false, currentPage: false }, rateBucket: { tokens: 100, lastRefillMs: Date.now() }, toolScopeSpec: null, updateNoticeSent: false };
const req = bridge.request('get_page_context', {}, mcp);
await waitFor(() => a.frames.some((f) => f.method === 'get_page_context'));
const frame = a.frames.find((f) => f.method === 'get_page_context');
a.ws.send(JSON.stringify({ id: frame.id, result: { ok: true } }));
assert.deepEqual(await req, { ok: true });

// resolved: the alert clears itself
st.probe = { kind: 'closed' };
await guard.refresh();
await waitFor(() => a.alerts().length === 2 && b.alerts().length === 2);
assert.deepEqual(a.alerts()[1], { type: 'foreign_alert', active: false, tooltip: '' });

// and if it comes back it is announced again
st.probe = { kind: 'welcome', version: '1.0.0', flavour: null };
await guard.refresh();
await waitFor(() => a.alerts().length === 3 && a.toasts().length === 2);

off();
for (const s of sockets) try { s.close(); } catch {}
bridge.close();
console.log('foreign-strip: ok');
process.exit(0);
