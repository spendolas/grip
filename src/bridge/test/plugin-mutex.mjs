// Plugin main-thread concurrency tests (figma-plugin/code.js, the tsc output of
// src/plugin/code.ts). No Figma runtime: (1) the self-contained mutation-queue
// and yield-clock blocks are cut out of code.js by their marker comments and run
// in node:vm with a fake clock; (2) the WHOLE code.js runs in node:vm against a
// small fake `figma` so the real message handler is exercised: undo bracketing
// around serialized writes, reads that bypass the queue, busy balance, the hello
// fileUid, documentchange origins, and the keepPage / pageId page handling.
// What this cannot show: Figma's real undo stack, real page loading, real
// plugin-data persistence. Those need a live Figma check (see the report).
import assert from 'node:assert';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(HERE, '..', '..', '..', 'figma-plugin', 'code.js'), 'utf8');

function block(name) {
  const m = new RegExp(`// ---- grip:${name} begin[^\\n]*\\n([\\s\\S]*?)// ---- grip:${name} end ----`).exec(code);
  assert.ok(m, `code.js carries the grip:${name} block (built from src/plugin/code.ts)`);
  return m[1];
}

// A fake clock + timers for the extracted blocks.
function fakeClock() {
  let now = 1_000_000, seq = 0;
  const timers = new Map();
  const ctx = vm.createContext({
    Date: { now: () => now },
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: now + (ms || 0) }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    Promise,
    Error,
  });
  const flush = () => new Promise((r) => setImmediate(r));
  return {
    ctx,
    timers,
    work: (ms) => { now += ms; },                   // synchronous "work" that takes ms
    async advance(ms) {                              // let ms pass, firing due timers
      const end = now + ms;
      await flush();
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await flush();
      }
      now = end;
      await flush();
    },
    flush,
  };
}

const deferred = () => { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; };

// ============================================================ mutation queue (extracted)
{
  const clk = fakeClock();
  vm.runInContext(block('mutation-queue'), clk.ctx);
  const stuck = [];
  const q = clk.ctx.createMutationQueue((label, ms) => stuck.push([label, ms]));
  const BIG = { holdMs: 60_000 };

  // FIFO, one at a time
  let running = 0, maxRunning = 0;
  const order = [];
  const gates = [deferred(), deferred(), deferred()];
  const results = gates.map((g, i) => q.run(`w${i}`, BIG, async () => {
    running++; maxRunning = Math.max(maxRunning, running); order.push(`start${i}`);
    await g.p;
    order.push(`end${i}`); running--;
    return i;
  }));
  await clk.flush();
  assert.deepStrictEqual(order, ['start0'], 'only the first write runs');
  assert.strictEqual(q.depth(), 3, 'depth counts running + waiting');
  gates[2].resolve(); gates[1].resolve();           // later ones finishing early changes nothing
  await clk.flush();
  assert.deepStrictEqual(order, ['start0'], 'w1/w2 still wait for w0');
  gates[0].resolve();
  assert.deepStrictEqual(await Promise.all(results), [0, 1, 2]);
  assert.deepStrictEqual(order, ['start0', 'end0', 'start1', 'end1', 'start2', 'end2'], 'FIFO, never interleaved');
  assert.strictEqual(maxRunning, 1);
  assert.strictEqual(q.depth(), 0);

  // a throwing call releases the queue and its error reaches the caller
  const boom = q.run('boom', BIG, async () => { throw new Error('nope'); });
  const after = q.run('after', BIG, async () => 'ran');
  await assert.rejects(boom, /nope/);
  assert.strictEqual(await after, 'ran', 'the next write runs after a throw');
  assert.strictEqual(q.depth(), 0);

  // a call that never settles is released after holdMs; the next one then runs
  const never = q.run('hang', { holdMs: 15_000 }, () => new Promise(() => {}));
  let nextRan = false;
  const next = q.run('next', BIG, async () => { nextRan = true; return 'ok'; });
  await clk.advance(14_000);
  assert.ok(!nextRan, 'still held before holdMs');
  await clk.advance(1_500);
  assert.ok(nextRan, 'released after holdMs');
  assert.strictEqual(await next, 'ok');
  assert.deepStrictEqual(stuck.map(([l]) => l), ['hang'], 'onStuck reported the hung call');
  assert.ok(stuck[0][1] >= 15_000);
  void never;
  assert.strictEqual(clk.timers.size, 0, 'no watchdog timer left behind');

  // a call that waited past its budget is NOT run
  const slow = deferred();
  const head = q.run('head', BIG, () => slow.p);
  let staleRan = false;
  const stale = q.run('stale', { holdMs: 15_000, maxWaitMs: 10_000 }, async () => { staleRan = true; });
  const fresh = q.run('fresh', { holdMs: 15_000, maxWaitMs: 60_000 }, async () => 'fresh-ran');
  clk.work(11_000);
  slow.resolve('h');
  assert.strictEqual(await head, 'h');
  await assert.rejects(stale, /plugin_queue_timeout: 'stale' waited 11\.0s .*NOT run, so nothing changed/);
  assert.ok(!staleRan, 'the stale call body never ran');
  assert.strictEqual(await fresh, 'fresh-ran', 'a skipped call still releases the queue');
  assert.strictEqual(q.depth(), 0);
}

// ============================================================ yield clock (extracted)
{
  const clk = fakeClock();
  vm.runInContext(block('yield-clock'), clk.ctx);
  const realYields = () => clk.timers.size;
  const a = clk.ctx.createYieldClock();
  clk.work(100);
  await a();
  assert.strictEqual(realYields(), 0, 'a fresh clock never charges the first work window');
  clk.work(450);
  const ya = a();                                   // 550ms of work since the clock started
  assert.strictEqual(realYields(), 1, 'past 500ms of work: one real (macrotask) yield');
  // A second invocation started now has its OWN clock: A's yield does not reset it
  // and B's calls do not consume or reset A's.
  const b = clk.ctx.createYieldClock();
  await clk.advance(0); await ya;
  clk.work(300);
  await b();
  assert.strictEqual(realYields(), 0, 'B at 300ms: microtask only');
  clk.work(250);                                    // A: 550ms since its last real yield; B: 550ms since start
  const ya2 = a();
  assert.strictEqual(realYields(), 1, 'A yields on its own schedule');
  const yb2 = b();
  assert.strictEqual(realYields(), 2, 'B yields on its own schedule, untouched by A');
  await clk.advance(0); await ya2; await yb2;
  // Old shared-clock bug: a third invocation starting would reset everyone. Now it can't.
  clk.work(400);
  clk.ctx.createYieldClock();                       // a new run_script starts
  clk.work(150);
  const ya3 = a();
  assert.strictEqual(realYields(), 1, 'a new invocation does not reset A (A still yields at 550ms)');
  await clk.advance(0); await ya3;
  assert.ok(!/resetYieldClock|_lastRealYieldAt/.test(code), 'no module-level shared yield clock remains');
}

// ============================================================ whole plugin in a fake Figma
function makePage(id, name) {
  const page = {
    type: 'PAGE', id, name, parent: null, children: [], selection: [],
    loaded: false,
    async loadAsync() { page.loaded = true; },
    findAllWithCriteria(c) { return page.children.filter((n) => !c.types || c.types.includes(n.type)); },
    appendChild(n) { n.parent = page; page.children.push(n); },
  };
  return page;
}
function makePlugin({ fileKey = null, pluginData = {}, setPluginDataThrows = false, crypto } = {}) {
  const marks = [];
  const posted = [];
  const handlers = {};
  const data = { ...pluginData };
  const page1 = makePage('0:1', 'Page 1');
  const page2 = makePage('0:2', 'Page 2');
  const registry = { '0:1': page1, '0:2': page2 };
  let seq = 0;
  const node = (type, page) => {
    const n = { type, id: `9:${++seq}`, name: type, parent: null, x: 0, y: 0, width: 10, height: 10, resize() {} };
    registry[n.id] = n;
    if (page) page.appendChild(n);
    return n;
  };
  const figma = {
    fileKey,
    editorType: 'figma',
    root: {
      id: '0:0', name: 'Test file', type: 'DOCUMENT', children: [page1, page2],
      getPluginData: (k) => data[k] ?? '',
      setPluginData: (k, v) => { if (setPluginDataThrows) throw new Error('read-only'); data[k] = v; },
    },
    currentPage: page1,
    showUI() {},
    ui: { postMessage: (m) => posted.push(JSON.parse(JSON.stringify(m))), onmessage: null },
    on: (ev, fn) => { handlers[ev] = fn; },
    loadAllPagesAsync: async () => {},
    commitUndo: () => marks.push('commit'),
    triggerUndo: () => marks.push('UNDO'),
    mark: (x) => marks.push(x),
    async setCurrentPageAsync(p) { marks.push(`switch:${p.id}`); figma.currentPage = p; },
    getNodeByIdAsync: async (id) => registry[id] ?? null,
    viewport: { scrollAndZoomIntoView: () => marks.push('scroll') },
    createRectangle: () => node('RECTANGLE'),
    clientStorage: { getAsync: async (k) => `v:${k}` },
  };
  const ctx = vm.createContext({
    figma, __html__: '', console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, Date, Promise, JSON, Math, Error,
    ...(crypto ? { crypto } : {}),
  });
  vm.runInContext(code, ctx);
  let id = 0;
  const responses = new Map();
  const waiters = new Map();
  const origPost = figma.ui.postMessage;
  figma.ui.postMessage = (raw) => {
    origPost(raw);
    const m = JSON.parse(JSON.stringify(raw));      // plain host-realm copy
    if (m && m.kind === 'response') {
      responses.set(m.id, m);
      waiters.get(m.id)?.(m);
    }
  };
  return {
    figma, marks, posted, handlers, data, page1, page2, node,
    send(method, params = {}) {
      const rid = `r${++id}`;
      const done = new Promise((r) => waiters.set(rid, r));
      figma.ui.onmessage({ kind: 'request', id: rid, method, params });
      return done;
    },
    busy: () => posted.filter((m) => m.kind === 'busy').reduce((a, m) => a + (m.busy ? 1 : -1), 0),
    busyFrames: () => posted.filter((m) => m.kind === 'busy').length,
    hello() { figma.ui.onmessage({ kind: 'welcome' }); return posted.filter((m) => m.kind === 'hello').at(-1); },
  };
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const script = (tag, ms) => `figma.mark('${tag}:start'); await new Promise((r) => setTimeout(r, ${ms})); figma.mark('${tag}:end'); return '${tag}';`;

// ---- overlapping writes: one undo group each, FIFO; reads do not wait
{
  const P = makePlugin();
  const a = P.send('run_script', { code: script('A', 40) });
  const b = P.send('run_script', { code: script('B', 5) });
  const u = P.send('trigger_undo');
  await tick(5);
  assert.strictEqual(P.busy(), 3, 'queued writes count as busy');
  const read = await P.send('client_storage_get', { key: 'k' });
  assert.deepStrictEqual(read.result, { key: 'k', value: 'v:k' }, 'a read answers while a write is still running');
  assert.ok(!P.marks.includes('A:end'), 'the read did not wait for the write');
  const [ra, rb, ru] = await Promise.all([a, b, u]);
  assert.strictEqual(ra.result.result, 'A');
  assert.strictEqual(rb.result.result, 'B');
  assert.deepStrictEqual(ru.result, { success: true });
  assert.deepStrictEqual(
    P.marks,
    ['commit', 'A:start', 'A:end', 'commit', 'commit', 'B:start', 'B:end', 'commit', 'UNDO'],
    `each write is exactly one undo group, B never inside A, trigger_undo after both: ${P.marks}`,
  );
  assert.strictEqual(P.busy(), 0, 'busy balanced');
  assert.strictEqual(P.busyFrames(), 8, 'one busy:true and one busy:false per call');
}

// ---- a throwing write releases the queue; busy stays balanced; red flash posted
{
  const P = makePlugin();
  const bad = P.send('run_script', { code: "figma.mark('X'); throw new Error('kaput');" });
  const good = P.send('run_script', { code: script('G', 1) });
  const [rbad, rgood] = await Promise.all([bad, good]);
  assert.match(rbad.error, /run_script failed: kaput/);
  assert.strictEqual(rgood.result.result, 'G');
  assert.deepStrictEqual(P.marks, ['commit', 'X', 'commit', 'commit', 'G:start', 'G:end', 'commit']);
  assert.ok(P.posted.some((m) => m.kind === 'error'));
  assert.strictEqual(P.busy(), 0);
}

// ---- concurrent run_scripts get their own yield clocks (helper signatures unchanged)
{
  const P = makePlugin();
  const r = await P.send('run_script', { code: "return [typeof yieldNow, typeof forEachNode, forEachNode.length, typeof mapNodes, typeof findNodes, await forEachNode([1,2,3], () => {}, {chunk:1})]" });
  assert.deepStrictEqual(r.result.result, ['function', 'function', 3, 'function', 'function', 3], 'script-visible helpers keep their shape');
}

// ---- hello carries a per-file UID, created once, tolerant of failure
{
  const P = makePlugin();
  const h = P.hello();
  assert.match(h.fileUid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, `UUID v4 shape: ${h.fileUid}`);
  assert.strictEqual(P.data['grip.fileUid'], h.fileUid, 'stored in document plugin data');
  assert.strictEqual(h.fileKey, '0:0', 'fileKey fallback unchanged');
  assert.ok(h.capabilities.includes('fileUid'));
  assert.strictEqual(P.hello().fileUid, h.fileUid, 'stable within a run');
  // a later plugin run in the same file reuses it
  const P2 = makePlugin({ pluginData: P.data });
  assert.strictEqual(P2.hello().fileUid, h.fileUid, 'stable across runs');
  // read-only file: no fileUid, no throw
  const P3 = makePlugin({ setPluginDataThrows: true });
  const h3 = P3.hello();
  assert.ok(!('fileUid' in h3), 'no fileUid when plugin data cannot be written');
  assert.strictEqual(h3.version.length > 0, true);
  // read-only file that already has one: still reported
  const P4 = makePlugin({ setPluginDataThrows: true, pluginData: { 'grip.fileUid': 'abc' } });
  assert.strictEqual(P4.hello().fileUid, 'abc');
  // crypto.randomUUID is used when present
  const P5 = makePlugin({ crypto: { randomUUID: () => '11111111-2222-4333-8444-555555555555' } });
  assert.strictEqual(P5.hello().fileUid, '11111111-2222-4333-8444-555555555555');
  // a duplicate of a cloud file (UID minted for another fileKey) gets a fresh UID
  const P6 = makePlugin({ fileKey: 'KEY_B', pluginData: { 'grip.fileUid': 'orig', 'grip.fileUidFileKey': 'KEY_A' } });
  const u6 = P6.hello().fileUid;
  assert.ok(u6 && u6 !== 'orig', 'duplicate with a different real fileKey re-mints');
  assert.strictEqual(P6.data['grip.fileUidFileKey'], 'KEY_B');
  const P7 = makePlugin({ fileKey: 'KEY_A', pluginData: { 'grip.fileUid': 'orig', 'grip.fileUidFileKey': 'KEY_A' } });
  assert.strictEqual(P7.hello().fileUid, 'orig', 'same fileKey keeps its UID');
  const P8 = makePlugin({ fileKey: 'KEY_A', pluginData: { 'grip.fileUid': 'orig', 'grip.fileUidFileKey': '' } });
  assert.strictEqual(P8.hello().fileUid, 'orig', 'a UID minted while the key was unknown is kept');
}

// ---- documentchange: origins counted over the whole debounce window
{
  const P = makePlugin();
  await tick(0);
  assert.ok(P.handlers.documentchange, 'documentchange registered');
  P.handlers.documentchange({ documentChanges: [{ origin: 'LOCAL' }, { origin: 'REMOTE' }] });
  P.handlers.documentchange({ documentChanges: [{ origin: 'LOCAL' }, { origin: 'LOCAL' }, { origin: 'REMOTE' }] });
  await tick(600);
  const evs = P.posted.filter((m) => m.kind === 'event' && m.event === 'documentchange');
  assert.strictEqual(evs.length, 1, 'debounced to one event');
  assert.deepStrictEqual(evs[0].data, { changes: 5, origins: { LOCAL: 3, REMOTE: 2 } });
  P.handlers.documentchange({ documentChanges: [{ origin: 'REMOTE' }] });
  await tick(600);
  assert.deepStrictEqual(P.posted.filter((m) => m.event === 'documentchange').at(-1).data, { changes: 1, origins: { LOCAL: 0, REMOTE: 1 } }, 'counters reset per window');
}

// ---- keepPage / pageId
{
  const P = makePlugin();
  const onP1 = P.node('RECTANGLE', P.page1);
  const onP2 = P.node('RECTANGLE', P.page2);
  // default unchanged: switches page
  let r = await P.send('set_selection', { nodeIds: [onP2.id] });
  assert.deepStrictEqual(r.result, { selected: [onP2.id] });
  assert.ok(P.marks.includes('switch:0:2'));
  await P.figma.setCurrentPageAsync(P.page1); P.marks.length = 0;
  // keepPage: refuses, no switch, no selection change
  r = await P.send('set_selection', { nodeIds: [onP2.id], keepPage: true });
  assert.match(r.error, /^node_on_other_page: set_selection with keepPage:true .*"Page 2" \(0:2\).*"Page 1" \(0:1\)/);
  assert.strictEqual(P.figma.currentPage, P.page1);
  assert.ok(!P.marks.some((m) => m.startsWith('switch')));
  r = await P.send('set_selection', { nodeIds: [onP1.id], keepPage: true });
  assert.deepStrictEqual(r.result, { selected: [onP1.id] }, 'keepPage with on-page nodes works');
  r = await P.send('scroll_to', { nodeId: onP2.id, keepPage: true });
  assert.match(r.error, /^node_on_other_page: scroll_to/);
  assert.ok(!P.marks.includes('scroll'));
  r = await P.send('scroll_to', { nodeId: onP1.id, keepPage: true });
  assert.deepStrictEqual(r.result, { focused: [onP1.id] });
  // find_with_criteria pageId: searches that page, current page untouched
  r = await P.send('find_with_criteria', { pageId: '0:2', types: ['RECTANGLE'] });
  assert.deepStrictEqual(r.result.map((n) => n.id), [onP2.id]);
  assert.ok(P.page2.loaded, 'page loaded before searching');
  assert.strictEqual(P.figma.currentPage, P.page1);
  r = await P.send('find_with_criteria', { pageId: onP1.id });
  assert.match(r.error, /Not a page/);
  // create_node pageId: lands on that page, current page untouched, selectAfter selects there
  r = await P.send('create_node', { type: 'RECTANGLE', pageId: '0:2', selectAfter: true });
  const made = P.page2.children.find((n) => n.id === r.result.id);
  assert.ok(made, 'created on page 2');
  assert.deepStrictEqual(Array.from(P.page2.selection, (n) => n.id), [made.id], 'selected on its own page');
  assert.strictEqual(P.figma.currentPage, P.page1);
  r = await P.send('create_node', { type: 'RECTANGLE' });
  assert.ok(P.page1.children.some((n) => n.id === r.result.id), 'default still the current page');
  // get_selection pageId reads that page's selection (empty here, so no serializer needed)
  P.page2.selection = [];
  r = await P.send('get_selection', { pageId: '0:2' });
  assert.deepStrictEqual(r.result, []);
  assert.strictEqual(P.figma.currentPage, P.page1);
  assert.ok(!P.marks.some((m) => m.startsWith('switch')), 'no pageId path switched pages');
}

console.log('plugin-mutex: ok');
