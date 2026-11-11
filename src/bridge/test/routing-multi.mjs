// Multi-file / multi-agent routing: files without a real fileKey ("0:0"),
// re-pinning to the newest window, list_files grouping + binding visibility,
// set_active_file warnings, the ambiguous-name error, truthful
// get_page_context, and the HTTP `?file=` launch bind.
//
// Drives a real PluginBridge on a random port with fake plugin sockets, and
// real MCP sessions (createSession) over in-memory and HTTP transports.
import assert from 'node:assert';
import { createServer as createNetServer } from 'node:net';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// A renamed key-less file is followed when its old file's last window closes
// within this long of the renamed file's first window (Figma respawning the
// iframe). Scaled down so a test can make a copy "older" than a respawn.
process.env.GRIP_RESPAWN_MATCH_MS = '400';
const { PluginBridge, fileIdentity, isRealFileKey } = await import('../dist/ws-server.js');
const { createSession, destroySession } = await import('../dist/mcp-server.js');
const { HttpServer } = await import('../dist/http-server.js');
const { BRIDGE_VERSION } = await import('../dist/types.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => {
  const s = createNetServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

// ---------------------------------------------------------------- identity helper
assert.strictEqual(fileIdentity({ fileKey: '0:0' }), undefined, '"0:0" is not an identity');
assert.strictEqual(fileIdentity({ fileKey: '' }), undefined, 'empty key is not an identity');
assert.strictEqual(fileIdentity({ fileKey: 'AbCdEfGhIjKlMnOp12' }), 'AbCdEfGhIjKlMnOp12', 'a real key is the identity');
assert.strictEqual(fileIdentity({ fileKey: '0:0', fileUid: 'uid-1', fileName: 'F' }), 'uid:uid-1:F', 'key-less: fileUid together with the name');
assert.strictEqual(fileIdentity({ fileKey: 'AbCdEfGhIjKlMnOp12', fileUid: 'uid-2' }), 'AbCdEfGhIjKlMnOp12', 'a real key wins over fileUid (a duplicate can share the uid)');
assert.notStrictEqual(
  fileIdentity({ fileKey: '0:0', fileUid: 'u', fileName: 'A' }),
  fileIdentity({ fileKey: '0:0', fileUid: 'u', fileName: 'A copy' }),
  'key-less windows sharing a uid under different names are different files',
);
assert.ok(!isRealFileKey('0:0') && !isRealFileKey('') && isRealFileKey('k1'));

const port = await freePort();
const bridge = new PluginBridge(port);
await new Promise((r) => bridge.once('listening', r));

// A fake plugin window: answers every request with the window's own identity,
// so a test can tell WHICH window a call was routed to.
async function openPlugin(file) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const state = { ws, sessionId: null, file: { ...file }, calls: [], mute: false };
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.kind === 'welcome') { state.sessionId = m.sessionId; return; }
    if (m.id && m.method) {
      state.calls.push(m.method);
      if (state.mute) return;   // a window that never answers (dying iframe)
      const result = m.method === 'get_page_context'
        ? { file: { key: state.file.fileKey, name: state.file.fileName }, page: { id: '0:1', name: 'Page 1' }, selectionCount: 0, servedBy: state.sessionId }
        : { servedBy: state.sessionId };
      ws.send(JSON.stringify({ id: m.id, result }));
    }
  });
  await new Promise((r) => ws.on('open', r));
  while (!state.sessionId) await sleep(5);
  state.hello = (extra = {}) => {
    Object.assign(state.file, extra);
    ws.send(JSON.stringify({ kind: 'hello', version: BRIDGE_VERSION, currentPageId: '0:1', currentPageName: 'Page 1', ...state.file }));
  };
  state.hello();
  await sleep(30);
  return state;
}
async function closePlugin(p) {
  p.ws.close();
  await sleep(60);
}

// An MCP session (agent) talking to `bridge` over an in-memory transport.
async function agent(b = bridge) {
  const live = createSession(b);
  live.session.toolScopeSpec = 'all';
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await live.server.connect(st);
  const client = new Client({ name: 't', version: '0' }, { capabilities: {} });
  await client.connect(ct);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { isError: !!r.isError, text: r.content[0].text, json: r.isError ? null : JSON.parse(r.content[0].text) };
  };
  return { live, session: live.session, client, call, done: () => destroySession(live) };
}

// ---------------------------------------------------------------- 1. two "0:0" files never merge
{
  const a = await openPlugin({ fileKey: '0:0', fileName: 'Local A' });
  const b = await openPlugin({ fileKey: '0:0', fileName: 'Local B' });
  const ag = await agent();

  const lf = await ag.call('list_files');
  assert.ok(!lf.isError);
  assert.strictEqual(lf.json.files.length, 2, 'two key-less windows are two entries, not one merged "0:0" file');
  for (const f of lf.json.files) {
    assert.strictEqual(f.stableKey, false);
    assert.strictEqual(f.windows.length, 1);
    assert.match(f.note, /no stable file key/);
  }
  assert.deepStrictEqual(lf.json.files.map((f) => f.fileName).sort(), ['Local A', 'Local B']);
  assert.deepStrictEqual(lf.json.myBinding, { state: 'unbound' });

  // unbound call with two key-less windows: loud ambiguity, no guess
  const r = await ag.call('get_node', { nodeId: '1:2' });
  assert.ok(r.isError, 'unbound call errors');
  assert.match(r.text, /^ambiguous_active_file: 2 Figma files\/windows are open/);
  assert.ok(r.text.includes(a.sessionId) && r.text.includes(b.sessionId), 'names each window by sessionId');
  assert.match(r.text, /no stable file key/);
  assert.strictEqual(a.calls.length + b.calls.length, 0, 'nothing reached either plugin');

  // hello again from B (page switch) must not change anything
  b.hello({ currentPageName: 'Other page' });
  await sleep(30);
  assert.match((await ag.call('get_node', { nodeId: '1:2' })).text, /^ambiguous_active_file/);

  // binding by "0:0" is refused (it is not a file identity)
  const z = await ag.call('set_active_file', { target: '0:0' });
  assert.ok(z.isError);
  assert.match(z.text, /^not_a_file_key/);
  assert.strictEqual(ag.session.bind, null, 'a refused target leaves the agent unbound');

  // ---------------------------------------------------------------- 2. bind by name does not hop
  const s = await ag.call('set_active_file', { target: 'Local A' });
  assert.ok(!s.isError, s.text);
  assert.strictEqual(s.json.resolved, true);
  assert.deepStrictEqual(s.json.target, { name: 'Local A' }, 'name bind is kept, never promoted to "0:0"');
  assert.strictEqual(s.json.file.sessionId, a.sessionId);
  assert.ok(!s.json.warnings, 'no warning when nobody else is bound');
  for (let i = 0; i < 4; i++) {
    b.hello({ currentPageName: `B page ${i}` });   // B says hello last, repeatedly
    await sleep(20);
    const g = await ag.call('get_node', { nodeId: '1:2' });
    assert.ok(!g.isError, g.text);
    assert.strictEqual(g.json.servedBy, a.sessionId, 'name-bound call stays on A after B re-hellos');
  }
  assert.strictEqual(b.calls.length, 0, 'B never received a call');
  assert.deepStrictEqual(ag.session.bind, { name: 'Local A' }, 'still bound by name');

  // A respawns (new window, new sessionId): the name bind follows to the new A, not B
  await closePlugin(a);
  const a2 = await openPlugin({ fileKey: '0:0', fileName: 'Local A' });
  const g2 = await ag.call('get_node', { nodeId: '1:2' });
  assert.strictEqual(g2.json.servedBy, a2.sessionId, 'name bind re-resolves to the respawned window');

  // bind by sessionId to B: kept as a window bind with the name as fallback
  const sb = await ag.call('set_active_file', { target: b.sessionId });
  assert.deepStrictEqual(sb.json.target, { sessionId: b.sessionId, name: 'Local B' });
  assert.strictEqual((await ag.call('get_node', { nodeId: '1:2' })).json.servedBy, b.sessionId);
  await closePlugin(b);
  const b2 = await openPlugin({ fileKey: '0:0', fileName: 'Local B' });
  const gb = await ag.call('get_node', { nodeId: '1:2' });
  assert.strictEqual(gb.json.servedBy, b2.sessionId, 'sessionId bind falls back to the same name when its window respawns');
  assert.strictEqual(ag.session.bind.sessionId, b2.sessionId, 'and then follows that window');

  // ---------------------------------------------------------------- 4. ambiguous name
  const b3 = await openPlugin({ fileKey: '0:0', fileName: 'Local B' });   // a second, different "Local B"
  const amb = await ag.call('set_active_file', { target: 'Local B' });
  assert.ok(amb.isError);
  assert.match(amb.text, /^ambiguous_file_name: the file name "Local B" matches 2 open files\/windows/);
  assert.ok(amb.text.includes(b2.sessionId) && amb.text.includes(b3.sessionId), 'lists each candidate sessionId');
  assert.match(amb.text, /fileKey, or with the sessionId/);
  assert.doesNotMatch(amb.text, /isn't open/, 'not the misleading "not open" wording');

  // a held name bind that becomes ambiguous fails loud on the call (not "not open")
  const ag2 = await agent();
  bridge.bindFromLaunch('Local B', ag2.session);   // lenient: kept as a name bind
  assert.deepStrictEqual(ag2.session.bind, { name: 'Local B' });
  const amb2 = await ag2.call('get_node', { nodeId: '1:2' });
  assert.ok(amb2.isError);
  assert.match(amb2.text, /^ambiguous_file_name/);
  assert.doesNotMatch(amb2.text, /bound_file_not_open/);
  const lf2 = await ag2.call('list_files');
  assert.deepStrictEqual([lf2.json.myBinding.state, lf2.json.myBinding.reason], ['waiting', 'ambiguous_name']);
  ag2.done();

  ag.done();
  for (const p of [a2, b2, b3]) await closePlugin(p);
}

// ---------------------------------------------------------------- 3. real keys: grouping, re-pin, myBinding, boundAgents
{
  const KEY_X = 'XxXxXxXxXxXxXxXxXx01';
  const KEY_Y = 'YyYyYyYyYyYyYyYyYy02';
  const x1 = await openPlugin({ fileKey: KEY_X, fileName: 'Design X' });
  const y1 = await openPlugin({ fileKey: KEY_Y, fileName: 'Design Y' });
  const half = new WebSocket(`ws://127.0.0.1:${port}`);   // connects, never says hello
  await new Promise((r) => half.on('open', r));
  await sleep(30);

  const me = await agent();
  const other = await agent();
  const third = await agent();

  // bind me to X, check the pinned window
  const s1 = await me.call('set_active_file', { target: KEY_X });
  assert.strictEqual(s1.json.resolved, true);
  assert.strictEqual((await me.call('get_node', { nodeId: '1:1' })).json.servedBy, x1.sessionId);

  // a NEWER window for X appears while the old one is still open (reconnect overlap)
  const x2 = await openPlugin({ fileKey: KEY_X, fileName: 'Design X' });
  const g = await me.call('get_node', { nodeId: '1:1' });
  assert.strictEqual(g.json.servedBy, x2.sessionId, 'bound agent re-pins to the newest same-file window');
  assert.strictEqual(me.session.activeFileId, x2.sessionId);

  // set_active_file warns when another agent is already bound to the same file
  const w = await other.call('set_active_file', { target: 'Design X' });
  assert.ok(!w.isError);
  assert.deepStrictEqual(w.json.target, { key: KEY_X }, 'name bind on a real-key file is promoted to the key');
  assert.ok(Array.isArray(w.json.warnings) && w.json.warnings.length === 1, 'warns about the other agent');
  assert.match(w.json.warnings[0], /1 other agent is already bound to "Design X"/);
  assert.strictEqual(w.json.file.boundAgents, 1);
  await third.call('set_active_file', { target: KEY_Y });

  // list_files: grouped by file, one entry each, half-connected socket not listed
  const lf = await me.call('list_files');
  assert.strictEqual(lf.json.files.length, 2, 'two files (X has two windows, collapsed)');
  assert.strictEqual(lf.json.connecting, 1, 'the half-connected socket is counted, not listed');
  const fx = lf.json.files.find((f) => f.fileKey === KEY_X);
  const fy = lf.json.files.find((f) => f.fileKey === KEY_Y);
  assert.strictEqual(fx.stableKey, true);
  assert.strictEqual(fx.windows.length, 2, 'both X windows listed under the one file');
  assert.strictEqual(fx.windows[0].sessionId, x2.sessionId, 'newest window first');
  assert.strictEqual(fx.sessionId, x2.sessionId, 'entry sessionId = newest live window');
  assert.strictEqual(fx.active, true);
  assert.strictEqual(fy.active, false);
  assert.strictEqual(fx.boundAgents, 1, 'one OTHER agent on X (me excluded)');
  assert.strictEqual(fy.boundAgents, 1, 'one other agent on Y');
  assert.ok(!('note' in fx));
  assert.deepStrictEqual(lf.json.myBinding, { state: 'live', target: { key: KEY_X }, sessionId: x2.sessionId, fileName: 'Design X' });
  assert.ok(!JSON.stringify(lf.json).includes(other.session.id), 'other agents are never identified');

  // grip_health: own binding + otherAgents count
  const h = await me.call('grip_health');
  assert.deepStrictEqual(h.json.session.bind, { key: KEY_X });
  assert.strictEqual(h.json.session.binding.state, 'live');
  assert.strictEqual(h.json.session.binding.sessionId, x2.sessionId);
  assert.strictEqual(h.json.otherAgents, 2);
  assert.ok(h.json.plugins.every((p) => typeof p.stableKey === 'boolean'));

  // get_page_context: truthful binding state
  const pc = await me.call('get_page_context');
  assert.strictEqual(pc.json.servedBy, x2.sessionId);
  assert.deepStrictEqual(pc.json.bind, { target: { key: KEY_X }, resolved: true, state: 'live' });
  assert.strictEqual(pc.json.binding.state, 'live');
  // an unbound agent with two files open errors (ambiguous); with one file it is 'unbound'
  const un = await agent();
  assert.match((await un.call('get_page_context')).text, /^ambiguous_active_file: 2 Figma files are open/);
  await closePlugin(y1);
  const pu = await un.call('get_page_context');
  assert.strictEqual(pu.json.bind, null, 'unbound: bind stays null (backward compatible)');
  assert.deepStrictEqual([pu.json.binding.state, pu.json.binding.sessionId], ['unbound', x2.sessionId], 'unbound, auto-routed to the only file');
  // a bound agent whose file closed: myBinding waiting / not_open
  const lt = await third.call('list_files');
  assert.deepStrictEqual([lt.json.myBinding.state, lt.json.myBinding.reason], ['waiting', 'not_open']);
  const dead = await third.call('get_node', { nodeId: '1:1' });
  assert.match(dead.text, /^bound_file_not_open/);
  // grip_health of the waiting agent
  assert.strictEqual((await third.call('grip_health')).json.session.binding.state, 'waiting');

  // fileUid: two "0:0" windows with DIFFERENT uids are distinct files, two
  // windows with the SAME uid and name are one file; binding by sessionId
  // stores the uid together with the name
  const u1 = await openPlugin({ fileKey: '0:0', fileName: 'Uid file', fileUid: 'uid-aaa' });
  const u2 = await openPlugin({ fileKey: '0:0', fileName: 'Uid file', fileUid: 'uid-aaa' });
  const u3 = await openPlugin({ fileKey: '0:0', fileName: 'Uid file 2', fileUid: 'uid-bbb' });
  const lu = await un.call('list_files');
  const uf = lu.json.files.filter((f) => f.fileUid);
  assert.strictEqual(uf.length, 2, 'grouped by fileUid');
  assert.strictEqual(uf.find((f) => f.fileUid === 'uid-aaa').windows.length, 2);
  const su = await un.call('set_active_file', { target: u1.sessionId });
  assert.deepStrictEqual(su.json.target, { uid: 'uid-aaa', name: 'Uid file' }, 'a key-less uid file is bound by its uid + name');
  assert.strictEqual((await un.call('get_node', { nodeId: '1:1' })).json.servedBy, u2.sessionId, 'newest window of the uid file');

  for (const a of [me, other, third, un]) a.done();
  half.close();
  for (const p of [x1, x2, u1, u2, u3]) await closePlugin(p);
}

// ---------------------------------------------------------------- 6. a fileUid copied into a duplicate (real keys)
// The plugin re-mints a uid only when it recorded a real key for it, so a uid
// minted while the key was null ends up in every duplicate. Different real keys
// are different files, whatever their uid says.
{
  const KEY_A = 'KeyAKeyAKeyAKeyAKeyA';
  const KEY_B = 'KeyBKeyBKeyBKeyBKeyB';
  const o1 = await openPlugin({ fileKey: KEY_A, fileName: 'Original', fileUid: 'uid-dup' });
  const bound = await agent();
  const s = await bound.call('set_active_file', { target: KEY_A });
  assert.deepStrictEqual(s.json.target, { key: KEY_A });
  assert.strictEqual((await bound.call('get_node', { nodeId: '1:1' })).json.servedBy, o1.sessionId);

  const c1 = await openPlugin({ fileKey: KEY_B, fileName: 'Original (Copy)', fileUid: 'uid-dup' });
  for (let i = 0; i < 3; i++) {
    c1.hello({ currentPageName: `copy page ${i}` });   // the copy keeps saying hello last
    await sleep(20);
    const g = await bound.call('get_node', { nodeId: '1:1' });
    assert.strictEqual(g.json.servedBy, o1.sessionId, 'a key-bound agent never hops to a copy that shares the uid');
  }
  assert.strictEqual(c1.calls.length, 0, 'the copy never received a call');

  const un = await agent();
  const lf = await un.call('list_files');
  assert.strictEqual(lf.json.files.length, 2, 'two files, not one entry with two windows');
  assert.deepStrictEqual(lf.json.files.map((f) => [f.fileName, f.fileKey, f.windows.length]).sort((x, y) => x[0].localeCompare(y[0])),
    [['Original', KEY_A, 1], ['Original (Copy)', KEY_B, 1]], 'each entry carries its own window and name');
  assert.match((await un.call('get_node', { nodeId: '1:1' })).text, /^ambiguous_active_file: 2 Figma files are open/);

  // binding by the shared uid cannot pick one: loud, never a guess
  const byUid = await un.call('set_active_file', { target: 'uid-dup' });
  assert.ok(byUid.isError);
  assert.match(byUid.text, /^ambiguous_file_name: the file id uid-dup matches 2 open files/);
  // binding by the original's name resolves to its key
  const byName = await un.call('set_active_file', { target: 'Original' });
  assert.deepStrictEqual(byName.json.target, { key: KEY_A });
  assert.strictEqual(byName.json.file.sessionId, o1.sessionId);

  // a newer window of the ORIGINAL: the re-pin follows it, not the copy
  const o2 = await openPlugin({ fileKey: KEY_A, fileName: 'Original', fileUid: 'uid-dup' });
  c1.hello({ currentPageName: 'copy again' });
  await sleep(20);
  assert.strictEqual((await bound.call('get_node', { nodeId: '1:1' })).json.servedBy, o2.sessionId, 're-pins to the newest window of the bound file');

  // the original closes: the bound agent waits, it never falls to the copy
  await closePlugin(o1);
  await closePlugin(o2);
  assert.match((await bound.call('get_node', { nodeId: '1:1' })).text, /^bound_file_not_open/);
  assert.strictEqual(c1.calls.length, 0, 'still nothing reached the copy');
  for (const a of [bound, un]) a.done();
  await closePlugin(c1);
}

// ---------------------------------------------------------------- 7. key-less windows sharing a fileUid
{
  // same uid + same name = one file (two windows of one local file)
  const l1 = await openPlugin({ fileKey: '0:0', fileName: 'Local doc', fileUid: 'uid-local' });
  const l2 = await openPlugin({ fileKey: '0:0', fileName: 'Local doc', fileUid: 'uid-local' });
  const un = await agent();
  let lf = await un.call('list_files');
  assert.strictEqual(lf.json.files.length, 1, 'same uid and name: one file');
  assert.strictEqual(lf.json.files[0].windows.length, 2);
  assert.strictEqual(lf.json.files[0].stableKey, true);
  assert.strictEqual((await un.call('get_node', { nodeId: '1:1' })).json.servedBy, l2.sessionId, 'unbound: routes to the newest window');

  // a duplicate (same uid, another name) is another file: listed apart, unbound is ambiguous
  const d1 = await openPlugin({ fileKey: '0:0', fileName: 'Local doc copy', fileUid: 'uid-local' });
  lf = await un.call('list_files');
  assert.deepStrictEqual(lf.json.files.map((f) => [f.fileName, f.windows.length]).sort((x, y) => x[0].localeCompare(y[0])),
    [['Local doc', 2], ['Local doc copy', 1]]);
  const amb = await un.call('get_node', { nodeId: '1:1' });
  assert.match(amb.text, /^ambiguous_active_file: 2 Figma files\/windows are open/);
  assert.match(amb.text, /file id uid-local/);
  assert.strictEqual(d1.calls.length, 0);

  // binding by the original's name works and sticks
  const b = await agent();
  const s = await b.call('set_active_file', { target: 'Local doc' });
  assert.ok(!s.isError, s.text);
  assert.deepStrictEqual(s.json.target, { uid: 'uid-local', name: 'Local doc' });
  assert.strictEqual((await b.call('get_node', { nodeId: '1:1' })).json.servedBy, l2.sessionId);
  d1.hello({ currentPageName: 'copy page' });
  await sleep(20);
  assert.strictEqual((await b.call('get_node', { nodeId: '1:1' })).json.servedBy, l2.sessionId, 'stays on the original after the copy says hello');
  // a launch-time bind by name after both are open (the reviewer's probe)
  const lb = await agent();
  bridge.bindFromLaunch('Local doc', lb.session);
  assert.strictEqual((await lb.call('get_node', { nodeId: '1:1' })).json.servedBy, l2.sessionId);
  // the copy, bound by its window, gets its own uid + name
  const c = await agent();
  const sc = await c.call('set_active_file', { target: d1.sessionId });
  assert.deepStrictEqual(sc.json.target, { uid: 'uid-local', name: 'Local doc copy' });
  assert.strictEqual((await c.call('get_node', { nodeId: '1:1' })).json.servedBy, d1.sessionId);
  // a bare uid bind matches both files: ambiguous, never a guess
  const bu = await un.call('set_active_file', { target: 'uid-local' });
  assert.ok(bu.isError);
  assert.match(bu.text, /^ambiguous_file_name: the file id uid-local matches 2/);

  // the original closes entirely: its agent waits, never hops to the copy
  // (the copy has been open far longer than an iframe respawn overlap, so it
  // is not taken for the original renamed)
  await sleep(500);
  const copyCalls = d1.calls.length;
  await closePlugin(l1);
  await closePlugin(l2);
  assert.match((await b.call('get_node', { nodeId: '1:1' })).text, /^bound_file_not_open: this agent is bound to file id uid-local \("Local doc"\)/);
  assert.strictEqual(d1.calls.length, copyCalls, 'the copy got nothing from the original\'s agent');
  for (const a of [un, b, lb, c]) a.done();
  await closePlugin(d1);
}

// ---------------------------------------------------------------- 8. renaming a key-less file keeps the binding
{
  const bindTo = async (p) => {
    const a = await agent();
    const r = await a.call('set_active_file', { target: p.sessionId });
    assert.ok(!r.isError, r.text);
    assert.strictEqual((await a.call('get_node', { nodeId: '1:1' })).json.servedBy, p.sessionId);
    return a;
  };
  // (a) the window says hello under the new name (rename, then a page switch),
  //     then Figma respawns the iframe: no call in between
  const s1 = await openPlugin({ fileKey: '0:0', fileName: 'Untitled', fileUid: 'uid-ren-a' });
  const a = await bindTo(s1);
  assert.deepStrictEqual(a.session.bind, { uid: 'uid-ren-a', name: 'Untitled' });
  s1.hello({ fileName: 'Landing page' });
  await sleep(30);
  assert.deepStrictEqual(a.session.bind, { uid: 'uid-ren-a', name: 'Landing page' }, 'the stored name follows the pinned window');
  const s2 = await openPlugin({ fileKey: '0:0', fileName: 'Landing page', fileUid: 'uid-ren-a' });
  await closePlugin(s1);
  assert.strictEqual((await a.call('get_node', { nodeId: '1:1' })).json.servedBy, s2.sessionId, 'still bound after the respawn');

  // (b) the old window never reports the new name: the respawned window under
  //     the new name appears and the old one closes right after
  const t1 = await openPlugin({ fileKey: '0:0', fileName: 'Draft', fileUid: 'uid-ren-b' });
  const b = await bindTo(t1);
  const t2 = await openPlugin({ fileKey: '0:0', fileName: 'Draft v2', fileUid: 'uid-ren-b' });
  assert.strictEqual((await b.call('get_node', { nodeId: '1:1' })).json.servedBy, t1.sessionId, 'stays on its window while it is open');
  await closePlugin(t1);
  assert.strictEqual((await b.call('get_node', { nodeId: '1:1' })).json.servedBy, t2.sessionId, 'follows the renamed file');
  assert.deepStrictEqual(b.session.bind, { uid: 'uid-ren-b', name: 'Draft v2' });

  // (c) the old window closes first, the renamed one connects within the grace
  const r1 = await openPlugin({ fileKey: '0:0', fileName: 'Alpha', fileUid: 'uid-ren-c' });
  const c = await bindTo(r1);
  await closePlugin(r1);
  const r2 = await openPlugin({ fileKey: '0:0', fileName: 'Beta', fileUid: 'uid-ren-c' });
  assert.strictEqual((await c.call('get_node', { nodeId: '1:1' })).json.servedBy, r2.sessionId);

  // (d) a read in flight on the old window is re-sent on the renamed file
  const q1 = await openPlugin({ fileKey: '0:0', fileName: 'Old name', fileUid: 'uid-ren-d' });
  const d = await bindTo(q1);
  q1.mute = true;
  const inflight = d.call('get_node', { nodeId: '1:1' });
  await sleep(30);
  const q2 = await openPlugin({ fileKey: '0:0', fileName: 'New name', fileUid: 'uid-ren-d' });
  await closePlugin(q1);
  const rr = await inflight;
  assert.ok(!rr.isError, rr.text);
  assert.strictEqual(rr.json.servedBy, q2.sessionId, 'rehome finds the renamed file');

  // (e) a copy (same uid, other name) opened long after the original closed
  //     is another file: the binding waits, it never hops
  const x1 = await openPlugin({ fileKey: '0:0', fileName: 'Gamma', fileUid: 'uid-ren-e' });
  const e = await bindTo(x1);
  await closePlugin(x1);
  await sleep(500);
  const x2 = await openPlugin({ fileKey: '0:0', fileName: 'Gamma copy', fileUid: 'uid-ren-e' });
  assert.match((await e.call('get_node', { nodeId: '1:1' })).text, /^bound_file_not_open/);
  assert.strictEqual(x2.calls.length, 0);

  // (f) two open windows sharing a uid under different names at once: still
  //     ambiguous for an unbound agent
  const y1 = await openPlugin({ fileKey: '0:0', fileName: 'Delta', fileUid: 'uid-ren-f' });
  const y2 = await openPlugin({ fileKey: '0:0', fileName: 'Delta copy', fileUid: 'uid-ren-f' });
  for (const p of [s2, t2, r2, q2, x2]) await closePlugin(p);
  const un = await agent();
  assert.match((await un.call('get_node', { nodeId: '1:1' })).text, /^ambiguous_active_file: 2 Figma files\/windows are open/);
  for (const ag of [a, b, c, d, e, un]) ag.done();
  for (const p of [y1, y2]) await closePlugin(p);
}

// ---------------------------------------------------------------- 9. a page switch never makes an older window "newer"
{
  const KEY = 'PgPgPgPgPgPgPgPgPg09';
  const w1 = await openPlugin({ fileKey: KEY, fileName: 'Pages' });
  const w2 = await openPlugin({ fileKey: KEY, fileName: 'Pages' });   // the respawned iframe
  const bound = await agent();
  await bound.call('set_active_file', { target: KEY });
  const un = await agent();
  assert.strictEqual((await bound.call('get_node', { nodeId: '1:1' })).json.servedBy, w2.sessionId);
  // the OLDER window re-sends hello (page switch): it must not become the newest
  w1.hello({ currentPageId: '0:2', currentPageName: 'Other page' });
  await sleep(30);
  assert.strictEqual((await bound.call('get_node', { nodeId: '1:1' })).json.servedBy, w2.sessionId, 'bound: still the newer window');
  assert.strictEqual((await un.call('get_node', { nodeId: '1:1' })).json.servedBy, w2.sessionId, 'unbound: still the newer window');
  const lf = await un.call('list_files');
  assert.strictEqual(lf.json.files[0].sessionId, w2.sessionId, 'list_files: entry = the newer window');
  assert.deepStrictEqual(lf.json.files[0].windows.map((x) => x.sessionId), [w2.sessionId, w1.sessionId], 'newest window first');
  assert.strictEqual(w1.calls.length, 0, 'nothing went to the older window');
  for (const ag of [bound, un]) ag.done();
  for (const p of [w1, w2]) await closePlugin(p);
}

// ---------------------------------------------------------------- 5. HTTP ?file= launch bind
{
  const httpPort = await freePort();
  const http = new HttpServer(httpPort, bridge);
  assert.strictEqual(await http.listen(), true);
  const p1 = await openPlugin({ fileKey: 'HttpHttpHttpHttp0001', fileName: 'Http One' });
  const p2 = await openPlugin({ fileKey: '0:0', fileName: 'Http Local' });

  const connectHttp = async (query) => {
    const client = new Client({ name: 'h', version: '0' }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${httpPort}/mcp${query}`)));
    const call = async (name, args = {}) => {
      const r = await client.callTool({ name, arguments: args });
      return { isError: !!r.isError, text: r.content[0].text, json: r.isError ? null : JSON.parse(r.content[0].text) };
    };
    return { client, call };
  };

  // no ?file=: two files open, unbound → ambiguous
  const plain = await connectHttp('?tools=all');
  assert.match((await plain.call('get_node', { nodeId: '1:1' })).text, /^ambiguous_active_file/);

  // ?file=<name> of a real-key file → bound (promoted to the key) at initialize
  const byName = await connectHttp('?tools=all&file=' + encodeURIComponent('Http One'));
  const r1 = await byName.call('get_node', { nodeId: '1:1' });
  assert.ok(!r1.isError, r1.text);
  assert.strictEqual(r1.json.servedBy, p1.sessionId, '?file= binds the session at initialize');
  assert.deepStrictEqual((await byName.call('get_page_context')).json.bind, { target: { key: 'HttpHttpHttpHttp0001' }, resolved: true, state: 'live' });

  // ?file=<name> of a key-less file → name bind, routed to that window
  const byLocal = await connectHttp('?file=' + encodeURIComponent('Http Local'));
  assert.strictEqual((await byLocal.call('get_page_context')).json.servedBy, p2.sessionId);

  // ?file=<figma URL>
  const byUrl = await connectHttp('?file=' + encodeURIComponent('https://www.figma.com/design/HttpHttpHttpHttp0001/x?node-id=1-2'));
  assert.strictEqual((await byUrl.call('get_page_context')).json.servedBy, p1.sessionId);

  for (const c of [plain, byName, byLocal, byUrl]) await c.client.close();
  http.close();
  await closePlugin(p1);
  await closePlugin(p2);
}

bridge.close();
console.log('routing-multi.mjs OK');
process.exit(0);
