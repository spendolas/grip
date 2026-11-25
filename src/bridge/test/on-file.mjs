// Per-call file targeting: on_file {file, tool, args} and the optional `file`
// argument on run_script / reads. Real PluginBridge + MCP client, fake plugins.
// Checks: the call lands on the NAMED file, the caller's own binding never
// moves, a receipt names the file that served it, ambiguity / unknown / refused
// targets fail loudly, and an unbound agent with two files open can still reach
// a file explicitly.
import assert from 'node:assert';
import { createServer as createNetServer } from 'node:net';
import { WebSocket } from 'ws';

process.env.GRIP_NO_UPDATE_CHECK = '1';
process.env.GRIP_REQUEST_TIMEOUT_MS = '2000';

const { PluginBridge } = await import('../dist/ws-server.js');
const { createSession } = await import('../dist/mcp-server.js');
const { toolMayChangeDocument } = await import('../dist/methods.js');
const { TOOLS, toolInputSchema } = await import('../dist/tools.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

setTimeout(() => { console.error('on-file.mjs: timed out'); process.exit(1); }, 30_000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (pred, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (pred()) return true; await sleep(10); } return false; };

const port = await new Promise((res) => { const s = createNetServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const bridge = new PluginBridge(port);
await new Promise((r) => bridge.once('listening', r));

async function plugin(fileKey, fileName) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const p = { ws, got: [] };
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.kind === 'welcome') {
      ws.send(JSON.stringify({ kind: 'hello', version: '0.8.0', fileKey, fileName, currentPageId: '0:1', currentPageName: 'P' }));
      return;
    }
    if (!m.id || !m.method) return;
    p.got.push(m);
    ws.send(JSON.stringify({ id: m.id, result: { served: fileName, method: m.method, params: m.params } }));
  });
  await new Promise((r) => ws.on('open', r));
  await waitUntil(() => bridge.snapshot().plugins.some((x) => x.fileKey === fileKey && x.hello));
  return p;
}

async function agent(bind = null) {
  const live = createSession(bridge);
  live.session.bind = bind;
  live.session.updateNoticeSent = true;
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await live.server.connect(st);
  const client = new Client({ name: 't', version: '0' }, { capabilities: {} });
  await client.connect(ct);
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? '';
    let json; try { json = JSON.parse(text); } catch { /* error text */ }
    return { isError: !!r.isError, text, json, meta: r._meta };
  };
  return { live, client, call };
}

const A = await plugin('kA', 'File A');
const B = await plugin('kB', 'File B');

// ---- 1. unbound agent, two files open: plain calls are ambiguous, on_file is not.
{
  const a = await agent();
  const plain = await a.call('get_node', { nodeId: '1:1' });
  assert.ok(plain.isError && /ambiguous_active_file/.test(plain.text), 'unbound + two files: ambiguous');
  const r = await a.call('on_file', { file: 'kB', tool: 'get_node', args: { nodeId: '1:1' } });
  assert.ok(!r.isError, r.text);
  assert.strictEqual(r.json.served, 'File B', 'on_file by key reaches B');
  assert.deepStrictEqual(r.meta['grip/file'].fileKey, 'kB', 'receipt names the file that served it');
  assert.strictEqual(r.meta['grip/file'].fileName, 'File B');
  assert.strictEqual(a.live.session.bind, null, 'on_file never binds the caller');
  assert.strictEqual(a.live.session.activeFileId, null, 'nor pins it');
  const byName = await a.call('on_file', { file: 'File A', tool: 'get_node', args: { nodeId: '1:1' } });
  assert.strictEqual(byName.json.served, 'File A', 'exact name works');
}

// ---- 2. bound agent: its own calls stay on its file, per-call overrides go elsewhere and do not move it.
{
  const a = await agent({ key: 'kA' });
  assert.strictEqual((await a.call('get_node', { nodeId: '1:1' })).json.served, 'File A');
  const other = await a.call('get_node', { nodeId: '1:1', file: 'kB' });
  assert.ok(!other.isError, other.text);
  assert.strictEqual(other.json.served, 'File B', '`file` argument reaches B');
  assert.ok(!('file' in other.json.params), 'the `file` argument is not forwarded to the plugin');
  assert.strictEqual(other.meta['grip/file'].fileKey, 'kB');
  assert.strictEqual((await a.call('get_node', { nodeId: '1:1' })).json.served, 'File A', 'still bound to A afterwards');
  assert.deepStrictEqual(a.live.session.bind, { key: 'kA' }, 'bind untouched');
  const rs = await a.call('run_script', { code: 'return 1', file: 'File B' });
  assert.strictEqual(rs.json.served, 'File B', 'run_script takes `file`');
}

// ---- 3. a figma.com URL names the file.
{
  const a = await agent();
  const r = await a.call('on_file', { file: 'https://www.figma.com/design/kA/x?node-id=1-2', tool: 'get_node', args: { nodeId: '1:2' } });
  assert.strictEqual(r.json.served, 'File A', 'figma.com URL resolves to its file');
}

// ---- 4. loud failures: unknown file, bridge tools, placeholder key, ambiguity, bad params.
{
  const a = await agent();
  const nf = await a.call('on_file', { file: 'kZ', tool: 'get_node', args: { nodeId: '1:1' } });
  assert.ok(nf.isError && /bound_file_not_open|not open/.test(nf.text), 'unknown file fails, never falls to another file: ' + nf.text);
  const before = A.got.length + B.got.length;
  await a.call('on_file', { file: 'kZ', tool: 'get_node', args: { nodeId: '9:9' } });
  assert.strictEqual(A.got.length + B.got.length, before, 'a missing file sends nothing to any open file');
  for (const tool of ['list_files', 'set_active_file', 'on_file', 'grip_health', 'subscribe']) {
    const r = await a.call('on_file', { file: 'kA', tool, args: {} });
    assert.ok(r.isError && /bridge-side/.test(r.text), `${tool} refused: ${r.text}`);
  }
  const ph = await a.call('on_file', { file: '0:0', tool: 'get_node', args: { nodeId: '1:1' } });
  assert.ok(ph.isError && /not_a_file_key/.test(ph.text), '0:0 refused');
  const unk = await a.call('on_file', { file: 'kA', tool: 'no_such_tool' });
  assert.ok(unk.isError && /unknown tool/.test(unk.text));
  const empty = await a.call('on_file', { file: ' ', tool: 'get_node' });
  assert.ok(empty.isError);
}

// ---- 5. two open files with the same name: ambiguous, listing candidates.
{
  const C = await plugin('kC', 'File A');
  const a = await agent();
  const r = await a.call('on_file', { file: 'File A', tool: 'get_node', args: { nodeId: '1:1' } });
  assert.ok(r.isError && /ambiguous_file_name/.test(r.text), r.text);
  assert.ok(/kA/.test(r.text) && /kC/.test(r.text), 'candidates listed');
  const ok = await a.call('on_file', { file: 'kC', tool: 'get_node', args: { nodeId: '1:1' } });
  assert.strictEqual(ok.meta['grip/file'].fileKey, 'kC', 'the key disambiguates');
  C.ws.close();
}

// ---- 6. document-change judgement and schema surface.
assert.strictEqual(toolMayChangeDocument('on_file', { file: 'x', tool: 'get_node', args: {} }), false, 'a wrapped read is retry-safe');
assert.strictEqual(toolMayChangeDocument('on_file', { file: 'x', tool: 'set_node_property', args: {} }), true, 'a wrapped write may change the document');
assert.strictEqual(toolMayChangeDocument('on_file', { file: 'x' }), true, 'unknown inner tool: assume yes');
assert.ok(TOOLS.some((t) => t.name === 'on_file'));
for (const t of ['run_script', 'get_node', 'get_nodes', 'get_page', 'search_nodes', 'export_node']) {
  assert.ok(toolInputSchema(t).properties.file, `${t} advertises \`file\``);
}
assert.ok(!toolInputSchema('set_node_property').properties?.file, 'writes do not advertise `file` (use on_file)');
assert.deepStrictEqual(toolInputSchema('on_file').required?.sort?.() ?? null, ['file', 'tool']);

for (const p of [A, B]) p.ws.close();
await sleep(50);
console.log('on-file.mjs OK');
process.exit(0);
