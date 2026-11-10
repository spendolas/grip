// Multi-agent flow control against a real PluginBridge and fake plugin sockets:
// busy guard vs. slow calls, round-robin fairness, retryAfterMs, event routing
// (bound file only, fileKey + causedBy), reconnect retry of reads, maybe_applied.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { WebSocket } from 'ws';

// Short budgets so the timing cases run in seconds. Set before importing.
process.env.GRIP_REQUEST_TIMEOUT_MS = '600';
process.env.GRIP_BUSY_THRESHOLD_MS = '300';
process.env.GRIP_EXPORT_TIMEOUT_MS = '4000';
process.env.GRIP_MAX_INFLIGHT = '2';
process.env.GRIP_MAX_QUEUE_PER_SESSION = '4';
process.env.GRIP_NO_UPDATE_CHECK = '1';

const { PluginBridge } = await import('../dist/ws-server.js');
const { createSession } = await import('../dist/mcp-server.js');
const { READ_ONLY_METHODS, isRetrySafe } = await import('../dist/methods.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { LoggingMessageNotificationSchema } = await import('@modelcontextprotocol/sdk/types.js');

setTimeout(() => { console.error('flow-multi.mjs: timed out (a request never settled)'); process.exit(1); }, 60_000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (pred, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (pred()) return true; await sleep(10); } return false; };

// ---------------------------------------------------------------- 0. one list
// The bridge's READ_ONLY_METHODS must mirror the plugin's exactly.
{
  const src = readFileSync(new URL('../../plugin/code.ts', import.meta.url), 'utf8');
  const start = src.indexOf('const READ_ONLY_METHODS = new Set<string>([');
  const body = src.slice(start, src.indexOf(']);', start));
  const plugin = new Set([...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
  assert.ok(plugin.size > 40, 'parsed the plugin list');
  assert.deepStrictEqual([...READ_ONLY_METHODS].sort(), [...plugin].sort(), 'bridge methods.ts mirrors plugin READ_ONLY_METHODS');
  assert.ok(isRetrySafe('get_node') && !isRetrySafe('trigger_undo') && !isRetrySafe('set_node_property') && !isRetrySafe('run_script'));
}

const port = await new Promise((res) => { const s = createNetServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const bridge = new PluginBridge(port);
await new Promise((r) => bridge.once('listening', r));

// A fake plugin. Methods in `hold` are recorded but not answered until reply().
async function plugin(fileKey, fileName) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const p = { ws, got: [], hold: new Set(), held: new Map() };
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.kind === 'welcome') {
      ws.send(JSON.stringify({ kind: 'hello', version: '0.8.0', fileKey, fileName, currentPageId: '0:1', currentPageName: 'P' }));
      return;
    }
    if (!m.id || !m.method) return;
    p.got.push(m);
    if (p.hold.has(m.method)) p.held.set(m.id, m);
    else ws.send(JSON.stringify({ id: m.id, result: { ok: m.method, tag: m.params?.tag ?? null } }));
  });
  p.reply = (pred = () => true) => {
    for (const [id, m] of p.held) if (pred(m)) { p.held.delete(id); ws.send(JSON.stringify({ id, result: { ok: m.method, tag: m.params?.tag ?? null } })); return m; }
    return null;
  };
  p.replyAll = () => { while (p.reply()); };
  await new Promise((r) => ws.on('open', r));
  await waitUntil(() => bridge.snapshot().plugins.some((x) => x.fileKey === fileKey && x.hello));
  return p;
}

let n = 0;
const mcp = (bind = null) => ({
  id: `mcp-${++n}`, activeFileId: null, bind,
  subscriptions: { selection: false, document: false, currentPage: false },
  rateBucket: { tokens: 100, lastRefillMs: Date.now() }, toolScopeSpec: null, updateNoticeSent: true,
});
const settle = (pr) => pr.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));

const P1 = await plugin('kA', 'File A');
const A = mcp(); const B = mcp();

// ---------------------------------------------------------------- 1. busy guard
{
  // A slow call inside its own (long) budget is NOT wedge evidence.
  P1.hold.add('export_node');
  const exp = settle(bridge.request('export_node', { nodeId: '1:1', format: 'PNG' }, A));
  await sleep(450);   // past the 300ms busy threshold, well inside the 4s export budget
  const r = await bridge.request('get_node', { nodeId: '1:2' }, B);
  assert.strictEqual(r.ok, 'get_node', 'another agent is not told plugin_busy while a slow call runs within budget');

  // An ordinary call that times out BEHIND the slow call: plugin_working, not a wedge.
  P1.hold.add('get_selection');
  const sel = await settle(bridge.request('get_selection', {}, A));
  assert.ok(!sel.ok && /^plugin_working: 'get_selection' got no reply/.test(sel.e.message), sel.e?.message);
  assert.match(sel.e.message, /busy with 'export_node'/);
  assert.ok(sel.e.retryAfterMs > 0, 'plugin_working carries retryAfterMs');
  const r2 = await bridge.request('get_node', { nodeId: '1:3' }, B);
  assert.strictEqual(r2.ok, 'get_node', 'an overdue call explained by an in-budget slow call does not trip plugin_busy');
  P1.replyAll();
  assert.ok((await exp).ok, 'the slow export completes normally');
  P1.hold.clear();
}
{
  // An ordinary call past the threshold: plugin_working (retryable) for others...
  P1.hold.add('get_selection');
  const stuck = settle(bridge.request('get_selection', {}, A));
  await sleep(350);
  const w = await settle(bridge.request('get_node', { nodeId: '1:1' }, B));
  assert.ok(!w.ok && /^plugin_working: /.test(w.e.message), w.e?.message);
  assert.match(w.e.message, /'get_selection' \(running \d/);
  assert.match(w.e.message, /retryAfterMs=\d+/);
  assert.ok(!/reload/i.test(w.e.message), 'plugin_working never says reload');
  assert.ok(w.e.retryAfterMs >= 500 && w.e.retryAfterMs <= 10_000);
  // ...and once it is truly past its own budget with no reply: plugin_busy.
  const t = await stuck;
  assert.ok(!t.ok && /^request_timeout: 'get_selection' exceeded 0.6s/.test(t.e.message), t.e?.message);
  const b = await settle(bridge.request('get_node', { nodeId: '1:1' }, B));
  assert.ok(!b.ok && /^plugin_busy: 'get_selection' has run .* past its 0.6s budget/.test(b.e.message), b.e?.message);
  assert.match(b.e.message, /reload/);
  assert.ok(b.e.retryAfterMs >= 1000);
  // A late reply proves the thread is alive: calls flow again.
  P1.replyAll();
  await sleep(30);
  P1.hold.clear();
  assert.strictEqual((await bridge.request('get_node', { nodeId: '1:1' }, B)).ok, 'get_node');
}

// ---------------------------------------------------------------- 2. fairness
{
  P1.hold.add('get_node');
  P1.got.length = 0;
  const as = [];
  for (let i = 0; i < 6; i++) as.push(settle(bridge.request('get_node', { nodeId: '1:1', tag: `A${i}` }, A)));
  await sleep(20);
  assert.strictEqual(P1.got.length, 2, 'MAX_INFLIGHT=2: two sent, four queued');
  // per-agent queue cap (4): A's next call is shed with retryAfterMs, B is still accepted
  const shed = await settle(bridge.request('get_node', { nodeId: '1:1', tag: 'A6' }, A));
  assert.ok(!shed.ok && /^plugin_overloaded: this agent already has 4 requests queued/.test(shed.e.message), shed.e?.message);
  assert.ok(shed.e.retryAfterMs >= 250 && shed.e.retryAfterMs <= 30_000);
  assert.match(shed.e.message, /retryAfterMs=\d+/);
  const bCall = settle(bridge.request('get_node', { nodeId: '1:1', tag: 'B0' }, B));
  await sleep(20);
  const snap = bridge.snapshot().plugins.find((p) => p.fileKey === 'kA');
  assert.deepStrictEqual([snap.inflight, snap.queued, snap.queuedSessions], [2, 5, 2]);
  // capacity frees one slot at a time: B's single call goes out after at most one more A call
  const before = P1.got.length;
  P1.reply(); await sleep(20);
  P1.reply(); await sleep(20);
  const next = P1.got.slice(before).map((m) => m.params.tag);
  assert.ok(next.slice(0, 2).includes('B0'), `B served within the next two sends, got ${next}`);
  // drain everything
  while (P1.held.size || bridge.snapshot().plugins.find((p) => p.fileKey === 'kA').queued) { P1.replyAll(); await sleep(10); }
  const all = await Promise.all([...as, bCall]);
  assert.ok(all.every((x) => x.ok), 'every accepted call completes');
  P1.hold.clear();
}

// ---------------------------------------------------------------- 3. events
{
  const clients = [];
  async function agent(bind) {
    const live = createSession(bridge);
    live.session.bind = bind;
    live.session.subscriptions.selection = true;
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await live.server.connect(st);
    const client = new Client({ name: 't', version: '0' }, { capabilities: {} });
    const seen = [];
    client.setNotificationHandler(LoggingMessageNotificationSchema, (m) => seen.push(m.params.data));
    await client.connect(ct);
    clients.push(client);
    return { live, client, seen };
  }
  const emit = (p, data = { ids: ['1:1'] }) => p.ws.send(JSON.stringify({ event: 'selectionchange', data }));
  const sA = await agent({ key: 'kA' });
  const sA2 = await agent({ key: 'kA' });
  const sB = await agent({ key: 'kB' });
  const sU = await agent(null);

  // one file open: the unbound agent routes there and gets it; the kB-bound one does not
  emit(P1);
  await waitUntil(() => sU.seen.length && sA.seen.length && sA2.seen.length);
  await sleep(50);
  assert.strictEqual(sB.seen.length, 0, 'an agent bound to another file gets nothing');
  const e = sA.seen[0];
  assert.deepStrictEqual([e.event, e.fileKey, e.fileName, e.causedBy], ['selectionchange', 'kA', 'File A', 'unknown']);
  assert.deepStrictEqual(e.payload, { ids: ['1:1'] }, 'payload unchanged (backward compatible)');
  assert.ok(typeof e.pluginSessionId === 'string' && e.pluginSessionId.length > 8);
  assert.strictEqual(sU.seen.length, 1);

  // second file opens: unbound agent is now ambiguous -> nothing; kB-bound gets only kB events
  const P2 = await plugin('kB', 'File B');
  for (const s of [sA, sA2, sB, sU]) s.seen.length = 0;
  emit(P2, { ids: ['9:9'] });
  await waitUntil(() => sB.seen.length);
  await sleep(50);
  assert.deepStrictEqual(sB.seen.map((x) => [x.fileKey, x.payload.ids[0]]), [['kB', '9:9']]);
  assert.strictEqual(sA.seen.length + sA2.seen.length + sU.seen.length, 0, 'kB events reach only the kB agent');

  // causedBy: a change in flight from sA -> 'self' for sA, 'other' for sA2
  P1.hold.add('set_node_property');
  const mut = settle(bridge.request('set_node_property', { nodeId: '1:1', property: 'opacity', value: 0.5 }, sA.live.session));
  await sleep(30);
  emit(P1);
  await waitUntil(() => sA.seen.length && sA2.seen.length);
  assert.strictEqual(sA.seen[0].causedBy, 'self');
  assert.strictEqual(sA2.seen[0].causedBy, 'other');
  assert.strictEqual(sU.seen.length, 0);
  P1.replyAll();
  assert.ok((await mut).ok);
  P1.hold.clear();

  // queued wait over 2s is reported in the tool result _meta
  P1.hold.add('export_node');
  const ex1 = settle(bridge.request('export_node', { nodeId: '1:1', format: 'PNG' }, sA2.live.session));
  const ex2 = settle(bridge.request('export_node', { nodeId: '1:1', format: 'PNG' }, sA2.live.session));
  await sleep(20);
  sA.live.session.toolScopeSpec = 'all';
  const call = sA.client.callTool({ name: 'get_node', arguments: { nodeId: '1:1' } });
  await sleep(2100);
  P1.reply();
  const res = await call;
  assert.ok(!res.isError, JSON.stringify(res));
  assert.ok(res._meta?.['grip/queuedMs'] >= 2000, `queuedMs in _meta: ${JSON.stringify(res._meta)}`);
  P1.replyAll();
  await Promise.all([ex1, ex2]);
  P1.hold.clear();

  P2.ws.close();
  await waitUntil(() => bridge.snapshot().plugins.length === 1);
  for (const c of clients) await c.close();
}

// ---------------------------------------------------------------- 4. reconnect
{
  // the iframe respawns during a call (old socket silent, new session for the same file)
  P1.hold.add('get_selection');   // an ordinary (0.6s budget here) read; get_node has the long page budget
  P1.hold.add('set_node_property');
  const read = settle(bridge.request('get_selection', { tag: 'Z' }, A));
  const change = settle(bridge.request('set_node_property', { nodeId: '1:1', property: 'opacity', value: 1 }, A));
  await sleep(20);
  const fresh = await plugin('kA', 'File A');
  const r = await read;
  assert.ok(r.ok && r.v.tag === 'Z', 'a read lost to a respawn is re-sent once on the new session');
  const c = await change;
  assert.ok(!c.ok && /^maybe_applied: .*reconnected/.test(c.e.message), c.e?.message);
  assert.ok(!/Retry it/.test(c.e.message));
  P1.replyAll();   // late replies from the old iframe are ignored
  fresh.ws.close();
  await waitUntil(() => bridge.snapshot().plugins.length === 1);
  P1.hold.clear();
}
{
  // sent read + sent change + queued change when the plugin drops
  P1.hold.add('get_node');
  P1.hold.add('set_node_property');
  const read = settle(bridge.request('get_node', { nodeId: '1:1', tag: 'R' }, A));
  const sentChange = settle(bridge.request('set_node_property', { nodeId: '1:1', property: 'opacity', value: 1, tag: 'W1' }, A));
  const queuedChange = settle(bridge.request('set_node_property', { nodeId: '1:1', property: 'opacity', value: 1, tag: 'W2' }, A));
  await sleep(20);
  assert.strictEqual(P1.held.size, 2, 'two sent, the second change is queued');
  P1.ws.terminate();
  const w1 = await sentChange;
  assert.ok(!w1.ok && /^maybe_applied: /.test(w1.e.message), w1.e?.message);
  assert.match(w1.e.message, /may already have been applied/);
  assert.match(w1.e.message, /Re-read/);
  // the file's plugin comes back within the grace: the read and the never-sent change are re-sent there
  const P1b = await plugin('kA', 'File A');
  const r = await read;
  assert.ok(r.ok && r.v.tag === 'R', 'the read is retried once on the new session');
  const w2 = await queuedChange;
  assert.ok(w2.ok && w2.v.tag === 'W2', 'a queued (never sent) change is re-sent on the new session');
  assert.deepStrictEqual(P1b.got.map((m) => m.params.tag).sort(), ['R', 'W2']);

  // no plugin comes back: the read is rejected after the grace with a safe-to-retry message
  P1b.hold.add('get_node');
  const lost = settle(bridge.request('get_node', { nodeId: '1:1' }, A));
  await sleep(20);
  P1b.ws.terminate();
  const l = await lost;
  assert.ok(!l.ok && /^plugin_disconnected: .*no plugin for that file reconnected/.test(l.e.message), l.e?.message);
  assert.match(l.e.message, /safe to retry/);
}

// Two live windows of one file: wait until both have said hello (plugin()
// only waits for the first window of a fileKey).
const twoWindows = (key) => waitUntil(() => bridge.snapshot().plugins.filter((x) => x.fileKey === key && x.hello).length === 2);
{
  // A genuine wedge on the NEWEST window of a file is a timeout, even though an
  // OLDER window of the same file is still open: only a newer window means the
  // call was lost to a reconnect.
  const W1 = await plugin('kW', 'File W');
  await sleep(5);
  const W2 = await plugin('kW', 'File W');
  await twoWindows('kW');
  W2.hold.add('get_selection');
  const t = await settle(bridge.request('get_selection', {}, mcp()));
  assert.ok(!t.ok && /^request_timeout: 'get_selection' exceeded 0.6s/.test(t.e.message), t.e?.message);
  assert.ok(!/plugin_reconnected/.test(t.e.message));
  assert.strictEqual(W1.got.length, 0, 'the older window was not used');
  assert.strictEqual(W2.got.length, 1, 'sent once, not re-sent to the older window');
  W2.replyAll();   // a late reply clears the wedge evidence
  W1.ws.close(); W2.ws.close();
  await waitUntil(() => bridge.snapshot().plugins.length === 0);
}
{
  // Calls still QUEUED on an old window move to a newer window of the same file
  // as soon as it says hello; calls already sent stay on the old one.
  const Q1 = await plugin('kQ', 'File Q');
  Q1.hold.add('get_node');
  const ag = mcp();
  const sent = [settle(bridge.request('get_node', { nodeId: '1:1', tag: 'S1' }, ag)), settle(bridge.request('get_node', { nodeId: '1:1', tag: 'S2' }, ag))];
  const queued = [
    settle(bridge.request('set_node_property', { nodeId: '1:1', property: 'opacity', value: 1, tag: 'Q1' }, ag)),
    settle(bridge.request('set_node_property', { nodeId: '1:1', property: 'opacity', value: 1, tag: 'Q2' }, ag)),
  ];
  await sleep(20);
  assert.strictEqual(Q1.held.size, 2, 'two sent (max in flight), two queued');
  const Q2 = await plugin('kQ', 'File Q');
  await twoWindows('kQ');
  const q = await Promise.all(queued);
  assert.deepStrictEqual(q.map((x) => x.ok && x.v.tag), ['Q1', 'Q2'], 'the queued calls ran on the newer window');
  assert.deepStrictEqual(Q2.got.map((m) => m.params.tag), ['Q1', 'Q2'], 'in order');
  assert.deepStrictEqual(Q1.got.map((m) => m.params.tag), ['S1', 'S2'], 'the old window only ever got the calls already sent to it');
  Q1.replyAll();
  const s = await Promise.all(sent);
  assert.ok(s.every((x) => x.ok), 'the sent calls are answered by the old window');
  Q1.ws.close(); Q2.ws.close();
  await waitUntil(() => bridge.snapshot().plugins.length === 0);
}
{
  // run_script log lines: buffered while the call is pending and attached to its
  // timeout; a line that arrives after the call settled is dropped, not kept in
  // a buffer nothing will ever clear.
  const L = await plugin('kL', 'File L');
  L.hold.add('run_script');
  const run = settle(bridge.request('run_script', { code: 'x' }, mcp()));
  await waitUntil(() => L.held.size === 1);
  const [id] = [...L.held.keys()];
  L.ws.send(JSON.stringify({ scriptLog: true, id, line: 'step 1' }));
  const r = await run;
  assert.ok(!r.ok && /^request_timeout: 'run_script'/.test(r.e.message), r.e?.message);
  assert.match(r.e.message, /Partial logs before timeout \(1\): step 1/);
  assert.strictEqual(bridge.scriptLogs.size, 0, 'cleared on settle');
  L.ws.send(JSON.stringify({ scriptLog: true, id, line: 'late line' }));
  await sleep(50);
  assert.strictEqual(bridge.scriptLogs.size, 0, 'a late log line does not recreate the buffer');
  L.replyAll();
  L.ws.close();
  await waitUntil(() => bridge.snapshot().plugins.length === 0);
}

bridge.close();
console.log('flow-multi.mjs OK');
process.exit(0);
