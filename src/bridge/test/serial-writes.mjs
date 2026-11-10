// Serialized writes end to end: a real PluginBridge talking to fake plugin
// sockets that run the REAL plugin write queue (the grip:mutation-queue and
// grip:request-budget blocks cut out of figma-plugin/code.js, evaluated in
// node:vm, as test/plugin-mutex.mjs does). Budgets are scaled down (600ms
// default, 300ms busy threshold) and a write takes 250ms, the shape of the
// reviewer's probe that used to produce request_timeout / plugin_busy for
// healthy writes.
//
// Covered: with `serialMutations` the bridge keeps one write in flight per
// plugin and queues the rest round-robin per agent, so a write's budget starts
// when it can run; reads keep their own slots and are never turned away because
// of writes; the request frame carries timeoutMs and the plugin queue obeys it;
// a write the bridge reported failed is either never applied or was reported as
// maybe_applied; pump() fails queued calls fast on a wedged plugin; a plugin
// without the capability behaves as before.
import assert from 'node:assert';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { WebSocket } from 'ws';

process.env.GRIP_REQUEST_TIMEOUT_MS = '600';
process.env.GRIP_BUSY_THRESHOLD_MS = '300';
process.env.GRIP_MAX_INFLIGHT = '2';
process.env.GRIP_MAX_WRITE_WAIT_MS = '1500';
process.env.GRIP_NO_UPDATE_CHECK = '1';

const { PluginBridge } = await import('../dist/ws-server.js');
const { UNDO_CONTROL_METHODS, serializedByPlugin } = await import('../dist/methods.js');

setTimeout(() => { console.error('serial-writes.mjs: timed out (a request never settled)'); process.exit(1); }, 90_000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (pred, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (pred()) return true; await sleep(5); } return false; };
const settle = (pr) => pr.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));

// ---------------------------------------------------------------- the real plugin queue
const code = readFileSync(new URL('../../../figma-plugin/code.js', import.meta.url), 'utf8');
function block(name) {
  const m = new RegExp(`// ---- grip:${name} begin[^\\n]*\\n([\\s\\S]*?)// ---- grip:${name} end ----`).exec(code);
  assert.ok(m, `code.js carries the grip:${name} block (built from src/plugin/code.ts)`);
  return m[1];
}
const pluginCtx = vm.createContext({ Date, setTimeout, clearTimeout, Promise, Error, Math });
vm.runInContext(block('mutation-queue') + '\n' + block('request-budget'), pluginCtx);
const { createMutationQueue, mutationQueueOpts } = pluginCtx;

// The bridge's write lane and the plugin's queue must agree on what is a write.
{
  const src = readFileSync(new URL('../../plugin/code.ts', import.meta.url), 'utf8');
  const m = /const UNDO_CONTROL_METHODS = new Set<string>\(\[([^\]]*)\]\)/.exec(src);
  assert.ok(m, 'parsed the plugin UNDO_CONTROL_METHODS');
  const plugin = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
  assert.deepStrictEqual([...UNDO_CONTROL_METHODS].sort(), plugin, 'methods.ts UNDO_CONTROL_METHODS mirrors code.ts');
  assert.ok(serializedByPlugin('set_node_property') && serializedByPlugin('run_script') && serializedByPlugin('trigger_undo'));
  assert.ok(!serializedByPlugin('get_node') && !serializedByPlugin('export_node'));
  // the plugin's budget: the frame's timeoutMs wins over its table
  assert.strictEqual(mutationQueueOpts({ method: 'set_node_property', timeoutMs: 600 }).maxWaitMs, 540);
  assert.strictEqual(mutationQueueOpts({ method: 'set_node_property' }).maxWaitMs, 9_750, 'no frame budget: 10s table less the margin');
  assert.strictEqual(mutationQueueOpts({ method: 'map_nodes', timeoutMs: 600 }).maxWaitMs, 540);
}

// ---------------------------------------------------------------- bridge + fake plugins
const port = await new Promise((res) => { const s = createNetServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const bridge = new PluginBridge(port);
await new Promise((r) => bridge.once('listening', r));

// A fake plugin. Writes go through the real mutation queue; each takes
// `writeMs` (or params.ms). Reads answer at once unless their method is held.
async function plugin(fileKey, { serial = true, writeMs = 250 } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const queue = createMutationQueue(() => {});
  const p = { ws, got: [], applied: [], running: 0, maxRunning: 0, hold: new Set(), held: new Map() };
  const reply = (id, body) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id, ...body })); };
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.kind === 'welcome') {
      ws.send(JSON.stringify({
        kind: 'hello', version: '0.8.0', fileKey, fileName: fileKey, currentPageId: '0:1', currentPageName: 'P',
        capabilities: serial ? ['nodeBudget', 'serialMutations'] : ['nodeBudget'],
      }));
      return;
    }
    if (!m.id || !m.method) return;
    p.got.push(m);
    const tag = m.params?.tag ?? null;
    if (!serializedByPlugin(m.method)) {
      if (p.hold.has(m.method)) p.held.set(m.id, m);
      else reply(m.id, { result: { ok: m.method, tag } });
      return;
    }
    queue.run(m.method, mutationQueueOpts(m), async () => {
      p.running++; p.maxRunning = Math.max(p.maxRunning, p.running);
      try {
        await sleep(m.params?.ms ?? writeMs);
        p.applied.push(tag);
        return { ok: m.method, tag };
      } finally { p.running--; }
    }).then((result) => reply(m.id, { result }), (err) => reply(m.id, { error: err.message }));
  });
  p.release = (pred = () => true) => {
    for (const [id, m] of p.held) if (pred(m)) { p.held.delete(id); reply(id, { result: { ok: m.method, tag: m.params?.tag ?? null } }); }
  };
  await new Promise((r) => ws.on('open', r));
  await waitUntil(() => bridge.snapshot().plugins.some((x) => x.fileKey === fileKey && x.hello));
  p.close = async () => { ws.close(); await waitUntil(() => !bridge.snapshot().plugins.some((x) => x.fileKey === fileKey)); };
  return p;
}

let n = 0;
const mcp = (key) => ({
  id: `mcp-${++n}`, activeFileId: null, bind: { key },
  subscriptions: { selection: false, document: false, currentPage: false },
  rateBucket: { tokens: 1e9, lastRefillMs: Date.now() }, toolScopeSpec: null, updateNoticeSent: true,
});
const write = (agent, tag, extra = {}) => settle(bridge.request('set_node_property', { nodeId: '1:1', property: 'opacity', value: 1, tag, ...extra }, agent));

// ---------------------------------------------------------------- 1. the probe: queued writes from several agents
{
  const P = await plugin('kProbe');
  const [A, B, C, D, R] = ['kProbe', 'kProbe', 'kProbe', 'kProbe', 'kProbe'].map(mcp);
  const t0 = Date.now();
  const ws4 = [write(A, 'A'), write(B, 'B'), write(C, 'C'), write(D, 'D')];   // 4 x 250ms = 1s, budget 600ms each
  await sleep(20);
  assert.strictEqual(P.got.length, 1, 'only one write is in flight on a serialMutations plugin');
  assert.strictEqual(bridge.snapshot().plugins.find((x) => x.fileKey === 'kProbe').writeLane.queued, 3);
  await sleep(630);   // A done, B done, C running: the read the probe sent at 650ms
  const tr = Date.now();
  const read = await settle(bridge.request('get_node', { nodeId: '1:1', tag: 'R' }, R));
  assert.ok(read.ok && read.v.tag === 'R', `a read while writes queue is answered, got ${read.e?.message}`);
  assert.ok(Date.now() - tr < 150, 'and answered at once');
  const res = await Promise.all(ws4);
  for (const r of res) assert.ok(r.ok, `a healthy queued write never fails: ${r.e?.message}`);
  assert.deepStrictEqual(P.applied, ['A', 'B', 'C', 'D'], 'applied once each, in arrival order');
  assert.strictEqual(P.maxRunning, 1, 'one write at a time in the plugin');
  assert.ok(Date.now() - t0 >= 1000, 'they really did take longer than one budget in total');
  for (const m of P.got) assert.strictEqual(typeof m.timeoutMs, 'number', 'every frame carries timeoutMs');
  assert.strictEqual(P.got.find((m) => m.method === 'set_node_property').timeoutMs, 600, 'the effective (env) budget');
  await P.close();
}

// ---------------------------------------------------------------- 2. round-robin on the write lane
{
  const P = await plugin('kRR', { writeMs: 60 });
  const [A, B, C] = ['kRR', 'kRR', 'kRR'].map(mcp);
  const all = [write(A, 'A1'), write(A, 'A2'), write(A, 'A3'), write(A, 'A4'), write(B, 'B1'), write(C, 'C1')];
  const res = await Promise.all(all);
  assert.ok(res.every((r) => r.ok), res.map((r) => r.e?.message).join(' | '));
  // A1 goes out at once; then the ring is A, B, C: one write per agent per turn.
  assert.deepStrictEqual(P.applied, ['A1', 'A2', 'B1', 'C1', 'A3', 'A4']);
  await P.close();
}

// ---------------------------------------------------------------- 3. writes do not take read slots
{
  const P = await plugin('kSlots', { writeMs: 200 });
  const W = mcp('kSlots'), R1 = mcp('kSlots'), R2 = mcp('kSlots');
  const writes = [];
  for (let i = 0; i < 6; i++) writes.push(write(W, `W${i}`));   // one agent floods writes (MAX_INFLIGHT=2)
  await sleep(20);
  P.hold.add('get_node');
  const r1 = settle(bridge.request('get_node', { nodeId: '1:1', tag: 'R1' }, R1));
  const r2 = settle(bridge.request('get_node', { nodeId: '1:1', tag: 'R2' }, R2));
  await sleep(20);
  const sentReads = P.got.filter((m) => m.method === 'get_node').length;
  assert.strictEqual(sentReads, 2, 'both read slots are free for reads while writes queue');
  const snap = bridge.snapshot().plugins.find((x) => x.fileKey === 'kSlots');
  assert.deepStrictEqual([snap.writeLane.inflight, snap.writeLane.queued], [1, 5]);
  assert.strictEqual(snap.inflight, 3, 'snapshot inflight counts both lanes');
  P.release();
  assert.ok((await r1).ok && (await r2).ok);
  P.hold.clear();
  const res = await Promise.all(writes);
  assert.ok(res.every((r) => r.ok), res.map((r) => r.e?.message).join(' | '));
  await P.close();
}

// ---------------------------------------------------------------- 4. busy messages do not blame the other lane
{
  const P = await plugin('kLane');
  const A = mcp('kLane'), B = mcp('kLane');
  const slow = write(A, 'slow', { ms: 450 });                     // past the 300ms threshold, inside 600ms
  await sleep(350);
  const r = await settle(bridge.request('get_node', { nodeId: '1:1', tag: 'R' }, B));
  assert.ok(r.ok, `a read is not turned away because a write runs long: ${r.e?.message}`);
  assert.ok((await slow).ok);
  // and a long read does not turn a write away
  P.hold.add('get_node');
  const lr = settle(bridge.request('get_node', { nodeId: '1:1', tag: 'LR' }, B));
  await sleep(350);
  const w = await write(A, 'after-read');
  assert.ok(w.ok, `a write is not turned away because a read runs long: ${w.e?.message}`);
  P.release();
  assert.ok((await lr).ok);
  P.hold.clear();
  await P.close();
}

// ---------------------------------------------------------------- 5. failed writes: never applied later, or reported maybe_applied
{
  const P = await plugin('kFail');
  const A = mcp('kFail'), B = mcp('kFail');
  // (a) a write that runs past its own budget: the plugin cannot abort it, so
  //     the error must say maybe_applied (it IS applied later).
  const long = await write(A, 'long', { ms: 800 });
  assert.ok(!long.ok && /^request_timeout: 'set_node_property' exceeded 0.6s/.test(long.e.message), long.e?.message);
  assert.match(long.e.message, /maybe_applied/);
  await waitUntil(() => P.applied.includes('long'));
  await sleep(50);                     // its late reply clears the wedge evidence
  // (b) a write that reaches the plugin while an earlier, timed-out write still
  //     runs there: the plugin skips it once its (frame) budget is used up, so
  //     the bridge's failure report is the truth.
  P.hold.add('get_node');
  const hog = write(A, 'hog', { ms: 1500 });
  const rd = settle(bridge.request('get_node', { nodeId: '1:1', tag: 'clear' }, B));
  await sleep(700);                    // hog timed out on the bridge at 600ms (still running in the plugin)
  P.release();                         // a reply proves the thread is alive: wedge evidence cleared
  const rdr = await rd;
  assert.ok(rdr.ok, rdr.e?.message);
  const late = await write(B, 'late');   // sent now, waits in the plugin behind hog
  assert.ok(!late.ok, 'the late write fails on the bridge');
  assert.match(late.e.message, /^(request_timeout|plugin_queue_timeout): /);
  assert.ok(!(await hog).ok);
  await sleep(1200);                   // hog finishes; the plugin would run 'late' now if it ignored the frame budget
  assert.ok(P.applied.includes('hog'));
  assert.ok(!P.applied.includes('late'), 'a write the bridge reported failed is never applied later');
  P.hold.clear();
  await P.close();
}

// ---------------------------------------------------------------- 6. pump runs the wedge check
{
  // Write lane: one hung write, three queued behind it from other agents.
  const P = await plugin('kWedge');
  const agents = ['kWedge', 'kWedge', 'kWedge', 'kWedge'].map(mcp);
  const t0 = Date.now();
  const hung = write(agents[0], 'hung', { ms: 60_000 });
  await sleep(20);
  const queued = [1, 2, 3].map((i) => write(agents[i], `q${i}`));
  const res = await Promise.all(queued);
  const took = Date.now() - t0;
  for (const r of res) assert.ok(!r.ok && /^plugin_busy: 'set_node_property' has run/.test(r.e.message), r.e?.message);
  assert.ok(took < 1000, `queued writes fail fast after the first timeout, not one budget each (${took}ms)`);
  assert.deepStrictEqual(P.got.map((m) => m.params.tag), ['hung'], 'the queued writes were never sent');
  assert.ok(!(await hung).ok);
  P.ws.terminate();
  await waitUntil(() => !bridge.snapshot().plugins.some((x) => x.fileKey === 'kWedge'));
}
{
  // Main lane (plugin without the capability): 2 hung reads fill both slots,
  // 4 more queue. Before, they went out in a second wave and each burned 600ms.
  const P = await plugin('kWedgeR', { serial: false });
  const A = mcp('kWedgeR');
  P.hold.add('get_selection');
  const t0 = Date.now();
  const all = [];
  for (let i = 0; i < 6; i++) all.push(settle(bridge.request('get_selection', { tag: `r${i}` }, A)));
  const res = await Promise.all(all);
  assert.ok(Date.now() - t0 < 1000, 'queued reads fail fast once the in-flight ones time out');
  assert.strictEqual(res.filter((r) => !r.ok && /^request_timeout/.test(r.e.message)).length, 2);
  assert.strictEqual(res.filter((r) => !r.ok && /^plugin_busy: /.test(r.e.message)).length, 4);
  assert.strictEqual(P.got.length, 2, 'the queued reads were never sent');
  P.ws.terminate();
  await waitUntil(() => !bridge.snapshot().plugins.some((x) => x.fileKey === 'kWedgeR'));
}

// ---------------------------------------------------------------- 7. a write never waits forever behind a long one
{
  const P = await plugin('kLong');
  const A = mcp('kLong'), B = mcp('kLong');
  const long = settle(bridge.request('run_script', { code: 'x', timeoutMs: 3000, ms: 2500, tag: 'script' }, A));
  await sleep(20);
  assert.strictEqual(P.got[0].timeoutMs, 3000, 'run_script frame carries its own timeoutMs');
  const w = await write(B, 'behind');
  assert.ok(!w.ok && /^plugin_working: 'set_node_property' waited 1\.\d+s .* behind 'run_script' .*NOT sent, so nothing was changed/.test(w.e.message), w.e?.message);
  assert.ok(w.e.retryAfterMs >= 500);
  assert.ok((await long).ok, 'the long script itself completes');
  assert.ok(!P.applied.includes('behind') && !P.got.some((m) => m.params.tag === 'behind'));
  await P.close();
}

// ---------------------------------------------------------------- 8. plugins without the capability: as before
{
  const P = await plugin('kOld', { serial: false, writeMs: 200 });
  const [A, B, C] = ['kOld', 'kOld', 'kOld'].map(mcp);
  const ws3 = [write(A, 'A'), write(B, 'B'), write(C, 'C')];
  await sleep(20);
  assert.strictEqual(P.got.length, 2, 'writes share the MAX_INFLIGHT=2 slots, sent without a write lane');
  const snap = bridge.snapshot().plugins.find((x) => x.fileKey === 'kOld');
  assert.deepStrictEqual([snap.writeLane.serial, snap.writeLane.inflight, snap.inflight, snap.queued], [false, 0, 2, 1]);
  const res = await Promise.all(ws3);
  assert.ok(res.every((r) => r.ok), res.map((r) => r.e?.message).join(' | '));
  assert.deepStrictEqual(P.applied, ['A', 'B', 'C']);
  // the old busy rule is unchanged: an ordinary call past the threshold turns others away
  const slow = write(A, 'slow', { ms: 450 });
  await sleep(350);
  const r = await settle(bridge.request('get_node', { nodeId: '1:1' }, B));
  assert.ok(!r.ok && /^plugin_working: /.test(r.e.message), r.e?.message);
  assert.ok((await slow).ok);
  await P.close();
}

bridge.close();
console.log('serial-writes.mjs OK');
process.exit(0);
