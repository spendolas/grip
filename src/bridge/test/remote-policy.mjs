// Remote access policy (remote-policy.ts, remote-cli.ts, the remote gate in mcp-server.ts).
// 1. Pure policy: every tool classified, tiers per mode, the never-list, export/file rules.
// 2. remote.json store: 0600, re-read on change, garbage = safe default.
// 3. CLI: on/off/allow-file/deny-file/mode, `on` refuses with no file.
// 4. End to end with a real PluginBridge, fake plugins and an in-memory MCP client: a remote
//    session is pre-bound to its one file, sees and may call only what the policy allows,
//    gets keepPage / inline forced, follows policy edits live; local sessions are unchanged.
import assert from 'node:assert';
import { mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createNetServer } from 'node:net';
import { WebSocket } from 'ws';

const HOME = mkdtempSync(join(tmpdir(), 'grip-remote-'));
process.env.GRIP_TEST = '1';
process.env.GRIP_HOME = HOME;
process.env.GRIP_NO_UPDATE_CHECK = '1';
process.env.GRIP_REQUEST_TIMEOUT_MS = '2000';

const P = await import('../dist/remote-policy.js');
const { runRemoteCli, resolveFileArg } = await import('../dist/remote-cli.js');
const { TOOLS, MERGED_TOOLS, resolveToolScope, toolInScope } = await import('../dist/tools.js');
const { PluginBridge } = await import('../dist/ws-server.js');
const { createSession, destroySession } = await import('../dist/mcp-server.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

setTimeout(() => { console.error('remote-policy.mjs: timed out'); process.exit(1); }, 60_000).unref();
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); checks++; };

const KEY_A = 'AAAAAAAAAAAAAAAAAAAAAA';
const KEY_B = 'BBBBBBBBBBBBBBBBBBBBBB';
const NOW = 1_800_000_000_000;
const pol = (o = {}) => ({ enabled: true, mode: 'read', files: [KEY_A], ...o });
const armed = (o = {}) => pol({ mode: 'write', writeUntil: NOW + 60_000, ...o });
const allowed = (p, t, a = {}) => P.remoteToolAllowed(p, t, a, NOW).ok;

// ---------------------------------------------------------------- 1. pure policy
{
  // Every tool, and every op of every merged tool, is classified (a new tool fails here
  // until someone decides; until then it is `never`).
  const unclassified = TOOLS.map((t) => t.name).filter((n) => !Object.prototype.hasOwnProperty.call(P.REMOTE_TOOL_CLASS, n));
  eq(unclassified, [], `unclassified tools: ${unclassified.join(', ')}`);
  const stale = Object.keys(P.REMOTE_TOOL_CLASS).filter((n) => !TOOLS.some((t) => t.name === n));
  eq(stale, [], `classified tools that no longer exist: ${stale.join(', ')}`);
  for (const [name, def] of Object.entries(MERGED_TOOLS)) {
    const c = P.REMOTE_TOOL_CLASS[name];
    if (typeof c === 'string') { eq(c, 'never', `${name}: a merged tool classified as a whole must be never`); continue; }
    const missing = Object.keys(def.map).filter((op) => !(op in c));
    eq(missing, [], `${name}: unclassified ops ${missing.join(', ')}`);
    const extra = Object.keys(c).filter((op) => !(op in def.map));
    eq(extra, [], `${name}: classified ops that do not exist ${extra.join(', ')}`);
  }
  eq(P.remoteTierOf('a_tool_added_tomorrow', {}), 'never', 'unknown tool => never');
  eq(P.remoteTierOf('measurement', { op: 'teleport' }), 'never', 'unknown op => never');
  eq(P.remoteTierOf('measurement', {}), 'never', 'missing op => never');
  eq(P.remoteTierOf('bind_to_variable', { target: 'paint' }), 'write', 'target discriminator read');

  // The never-list from the plan: denied in every mode, even armed + explicitly listed.
  const NEVER = ['run_script', 'map_nodes', 'grip_update', 'grip_load_tools', 'upload_image_from_path',
    'upload_image_begin', 'upload_image_chunk', 'upload_image_finish', 'open_external_url', 'create_image_from_url',
    'create_link_preview', 'client_storage', 'trigger_undo', 'commit_undo', 'copy_between_files', 'on_file',
    'set_active_file', 'subscribe', 'set_plugin_data', 'set_shared_plugin_data', 'notify'];
  const everything = TOOLS.map((t) => t.name);
  for (const t of NEVER) {
    const args = { op: 'get', target: 'selection' };
    ok(!allowed(pol(), t, args), `${t} denied in read mode`);
    ok(!allowed(armed({ tools: everything }), t, args), `${t} denied in armed write mode even when listed`);
    ok(!P.remoteToolListed(armed({ tools: everything }), t, NOW), `${t} never listed`);
  }

  // read mode
  for (const t of ['get_node', 'get_nodes', 'search_nodes', 'get_page_context', 'get_selection', 'get_variables']) ok(allowed(pol(), t), `${t} allowed in read mode`);
  ok(allowed(pol(), 'measurement', { op: 'list' }), 'read op of a merged tool allowed in read mode');
  ok(!allowed(pol(), 'measurement', { op: 'add' }), 'write op of a merged tool denied in read mode');
  for (const t of ['set_node_property', 'create_node', 'delete_node', 'save_version', 'set_selection']) ok(!allowed(pol(), t), `${t} denied in read mode`);
  // write mode needs an unexpired window
  ok(!allowed(pol({ mode: 'write' }), 'set_node_property'), 'write mode with no writeUntil = read');
  ok(!allowed(pol({ mode: 'write', writeUntil: NOW - 1 }), 'set_node_property'), 'expired window = read');
  ok(!allowed(pol({ mode: 'read', writeUntil: NOW + 60_000 }), 'set_node_property'), 'read mode ignores writeUntil');
  for (const t of ['set_node_property', 'create_node', 'delete_node', 'save_version', 'set_selection']) ok(allowed(armed(), t), `${t} allowed when armed`);
  ok(allowed(armed(), 'group', { op: 'ungroup' }), 'merged write op allowed when armed');
  // extended: armed + listed
  ok(!allowed(armed(), 'set_style'), 'extended denied without a tool list');
  ok(!allowed(pol({ tools: ['set_style'] }), 'set_style'), 'extended denied in read mode even when listed');
  ok(allowed(armed({ tools: ['set_style'] }), 'set_style'), 'extended allowed when armed and listed');
  ok(allowed(armed({ tools: ['variable'] }), 'variable', { op: 'create' }), 'extended merged op');
  // tools narrows
  ok(!allowed(pol({ tools: ['get_node'] }), 'get_nodes'), 'tool list narrows reads');
  ok(allowed(pol({ tools: ['get_node'] }), 'get_node'), 'listed read allowed');
  // disabled
  ok(!allowed(pol({ enabled: false }), 'get_node'), 'disabled denies everything');
  ok(!P.remoteToolListed(pol({ enabled: false }), 'get_node', NOW), 'disabled lists nothing');
  // export_node
  ok(allowed(pol(), 'export_node', { nodeId: '1:1', format: 'PNG' }), 'export to inline allowed');
  ok(!allowed(pol(), 'export_node', { nodeId: '1:1', format: 'PNG', path: '/tmp/x.png' }), 'export with path denied');
  ok(!allowed(armed(), 'export_node', { nodeId: '1:1', format: 'MP4' }), 'video export denied');
  // per-call file argument
  ok(!allowed(pol(), 'get_node', { nodeId: '1:1', file: KEY_B }), '`file` argument denied');
  // files
  ok(P.remoteFileAllowed(pol(), KEY_A), 'listed key allowed');
  ok(!P.remoteFileAllowed(pol(), KEY_B), 'other key denied');
  ok(!P.remoteFileAllowed(pol({ files: ['0:0'] }), '0:0'), 'placeholder key never allowed');
  ok(!P.remoteFileAllowed(pol({ enabled: false }), KEY_A), 'disabled: no file');
  // parse
  eq(P.parseRemotePolicy(null), { enabled: false, mode: 'read', files: [] }, 'null => default');
  eq(P.parseRemotePolicy({ enabled: 'yes', mode: 'admin', files: ['0:0', KEY_A, KEY_A, 3], writeUntil: NOW }),
    { enabled: false, mode: 'read', files: [KEY_A] }, 'garbage fields => safe values');
  eq(P.parseRemotePolicy({ enabled: true, mode: 'write', writeUntil: NOW, files: [], tools: ['get_node', 7] }),
    { enabled: true, mode: 'write', writeUntil: NOW, files: [], tools: ['get_node'] }, 'tools kept, junk dropped');
}

// ---------------------------------------------------------------- 2. store
{
  const dir = mkdtempSync(join(tmpdir(), 'grip-remote-store-'));
  const store = new P.RemotePolicyStore(dir);
  eq(store.read(), { enabled: false, mode: 'read', files: [] }, 'no file => disabled default');
  store.write(pol());
  if (process.platform !== 'win32') eq(statSync(store.path).mode & 0o777, 0o600, 'remote.json is 0600');
  eq(store.read().enabled, true, 'reads what it wrote');
  // another process edits it (different size => re-read)
  writeFileSync(store.path, JSON.stringify({ enabled: false, mode: 'read', files: [KEY_A, KEY_B] }));
  eq(store.read().files, [KEY_A, KEY_B], 're-read after an outside edit');
  writeFileSync(store.path, '{not json');
  eq(store.read(), { enabled: false, mode: 'read', files: [] }, 'malformed => disabled default');
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 3. CLI
{
  const dir = mkdtempSync(join(tmpdir(), 'grip-remote-cli-'));
  const store = new P.RemotePolicyStore(dir);
  const statusPath = join(dir, 'status.json');
  writeFileSync(statusPath, JSON.stringify({ pid: process.pid, plugins: [
    { fileName: 'Design A', fileKey: KEY_A }, { fileName: 'Twin', fileKey: KEY_A.replace(/A/g, 'C') },
    { fileName: 'Twin', fileKey: KEY_B }, { fileName: 'Local', fileKey: '0:0' },
  ] }));
  const lines = [];
  const cli = (...args) => runRemoteCli(['node', 'grip-bridge.mjs', 'remote', ...args], {
    store, statusPath, now: () => NOW, out: (m = '') => lines.push(m), err: (m = '') => lines.push('ERR ' + m),
  });
  eq(cli('status'), 0, 'status works on a fresh home');
  eq(cli('on'), 1, '`on` refuses with no file');
  eq(store.read().enabled, false, 'still off');
  eq(cli('allow-file', 'Design A'), 0, 'allow by exact open file name');
  eq(store.read().files, [KEY_A], 'name resolved to its key');
  eq(cli('allow-file', 'Twin'), 1, 'ambiguous name refused');
  eq(cli('allow-file', 'Local'), 1, 'key-less file refused');
  eq(cli('allow-file', `https://www.figma.com/design/${KEY_B}/Whatever?node-id=1-2`), 0, 'allow by URL');
  eq(store.read().files, [KEY_A, KEY_B], 'URL key added');
  eq(cli('on'), 0, '`on` with files');
  eq(store.read().enabled, true, 'on');
  eq(cli('mode', 'write', '--minutes', '15'), 0, 'arm write');
  eq(store.read().writeUntil, NOW + 15 * 60_000, 'window = now + minutes');
  eq(cli('mode', 'write', '--minutes', '100000'), 2, 'too long a window refused');
  eq(cli('mode', 'read'), 0, 'back to read');
  eq(store.read().writeUntil, undefined, 'read mode drops the window');
  eq(cli('deny-file', KEY_A), 0, 'deny a file');
  eq(cli('deny-file', KEY_B), 0, 'deny the last file');
  eq(store.read().enabled, false, 'no file left => off');
  eq(cli('off'), 0, 'off');
  eq(cli('bogus'), 2, 'unknown subcommand = usage');
  ok('error' in resolveFileArg('Design A', join(dir, 'missing.json')), 'no daemon status: names cannot resolve');
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 4. end to end
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

async function agent(opts) {
  const live = createSession(bridge, opts);
  live.session.updateNoticeSent = true;
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await live.server.connect(st);
  const client = new Client({ name: 't', version: '0' }, { capabilities: {} });
  await client.connect(ct);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? '';
    let json; try { json = JSON.parse(text); } catch { /* error text */ }
    return { isError: !!r.isError, text, json };
  };
  const names = async () => (await client.listTools()).tools.map((t) => t.name);
  return { live, client, call, names };
}

const A = await plugin(KEY_A, 'File A');
const B = await plugin(KEY_B, 'File B');
const store = P.remotePolicyStore();
eq(store.dir, HOME, 'daemon store lives in GRIP_HOME');

// Creation is refused unless the policy allows a session.
const refuse = (opts, code, m) => assert.throws(() => createSession(bridge, opts), (e) => e.code === code, m) || checks++;
refuse({ remote: { clientId: 'c1' } }, 'remote_disabled', 'no remote.json => refused');
store.write({ enabled: true, mode: 'read', files: [] });
refuse({ remote: { clientId: 'c1' } }, 'remote_no_files', 'enabled but no files => refused');
store.write({ enabled: true, mode: 'read', files: [KEY_A, KEY_B] });
refuse({ remote: { clientId: 'c1' } }, 'remote_file_required', 'two files and none named => refused');
refuse({ remote: { clientId: 'c1', file: 'ZZZZZZZZZZZZZZZZZZZZZZ' } }, 'remote_file_denied', 'a file not in the list => refused');
store.write({ enabled: true, mode: 'read', files: [KEY_A] });

{
  const r = await agent({ remote: { clientId: 'cloud-1' } });
  eq(r.live.session.bind, { key: KEY_A }, 'pre-bound to the one allowed file');
  eq(r.live.session.remote, { clientId: 'cloud-1', fileKey: KEY_A }, 'marked remote');

  const listed = await r.names();
  const expectRead = TOOLS.map((t) => t.name).filter((n) => P.remoteToolListed(store.read(), n));
  eq(listed, expectRead, 'tools/list = what the policy allows');
  for (const t of ['run_script', 'set_active_file', 'list_files', 'set_node_property', 'grip_update', 'on_file', 'subscribe']) ok(!listed.includes(t), `${t} not listed in read mode`);
  ok(listed.includes('get_node') && listed.includes('measurement'), 'reads (and merged tools with a read op) listed');

  // Reads go to the bound file even with two files open (an unbound local agent would be ambiguous).
  const g = await r.call('get_node', { nodeId: '1:1' });
  ok(!g.isError, g.text);
  eq(g.json.served, 'File A', 'read served by the allowed file');
  ok(!B.got.length, 'other file never touched');

  for (const [t, a] of [['set_node_property', { nodeId: '1:1', property: 'name', value: 'x' }], ['run_script', { code: '1' }],
    ['set_active_file', { target: KEY_B }], ['on_file', { file: KEY_B, tool: 'get_node', args: { nodeId: '1:1' } }],
    ['get_node', { nodeId: '1:1', file: KEY_B }], ['subscribe', { target: 'selection' }], ['list_files', {}],
    ['export_node', { nodeId: '1:1', format: 'PNG', path: join(HOME, 'x.png') }]]) {
    const d = await r.call(t, a);
    ok(d.isError && /^remote_denied: /.test(d.text), `${t} denied: ${d.text}`);
  }
  eq(r.live.session.bind, { key: KEY_A }, 'binding unchanged after denied rebinds');
  ok(!B.got.length, 'other file still never touched');
  ok(!r.live.session.subscriptions.selection, 'no subscription');

  // Arm write: node-level writes go through, keepPage is forced, raster export is forced inline.
  store.write({ enabled: true, mode: 'write', writeUntil: Date.now() + 60_000, files: [KEY_A] });
  ok((await r.names()).includes('set_node_property'), 'write tools listed once armed');
  const w = await r.call('set_node_property', { nodeId: '1:1', property: 'name', value: 'x' });
  ok(!w.isError, w.text);
  const sel = await r.call('set_selection', { nodeIds: ['1:1'] });
  ok(!sel.isError, sel.text);
  eq(A.got.find((m) => m.method === 'set_selection')?.params.keepPage, true, 'keepPage forced');
  await r.call('export_node', { nodeId: '1:1', format: 'PNG' });
  const ex = A.got.find((m) => m.method === 'export_node');
  ok(ex && ex.params.path === undefined, 'remote export never gets a path');
  const ext = await r.call('set_style', { styleType: 'PAINT', name: 's' });
  ok(ext.isError && /remote_denied/.test(ext.text), 'extended tool denied without explicit listing');

  // Live policy edits apply from the next call.
  store.write({ enabled: true, mode: 'write', writeUntil: Date.now() - 1, files: [KEY_A] });
  ok((await r.call('set_node_property', { nodeId: '1:1', property: 'name', value: 'y' })).isError, 'expired window: write denied');
  store.write({ enabled: true, mode: 'read', files: [KEY_B] });
  const gone = await r.call('get_node', { nodeId: '1:1' });
  ok(gone.isError && /no longer allowed/.test(gone.text), 'file removed from the list: denied');
  store.write({ enabled: false, mode: 'read', files: [KEY_A] });
  const off = await r.call('get_node', { nodeId: '1:1' });
  ok(off.isError && /switched off/.test(off.text), 'remote off: denied');
  eq(await r.names(), [], 'remote off: nothing listed');
  ok(!B.got.length, 'other file never touched by the remote session');
  await r.client.close();
  destroySession(r.live);
}

// Local sessions are exactly as before, whatever remote.json says.
store.write({ enabled: true, mode: 'read', files: [KEY_A] });
{
  const l = await agent();
  eq(l.live.session.remote, undefined, 'local session not remote');
  const scope = resolveToolScope(null);
  eq(await l.names(), TOOLS.filter((t) => toolInScope(t.name, scope)).map((t) => t.name), 'local tools/list = core scope, unchanged');
  ok((await l.names()).includes('run_script'), 'local agents still see run_script');
  const amb = await l.call('get_node', { nodeId: '1:1' });
  ok(amb.isError && /ambiguous_active_file/.test(amb.text), 'unbound local agent with two files: ambiguous as before');
  const b = await l.call('set_active_file', { target: KEY_B });
  ok(!b.isError, b.text);
  const s = await l.call('run_script', { code: 'return 1' });
  ok(!s.isError, s.text);
  eq(s.json.served, 'File B', 'local run_script reaches the plugin');
  const before = B.got.length;
  await l.call('set_selection', { nodeIds: ['1:1'] });
  eq(B.got[before].params.keepPage, undefined, 'local set_selection: no keepPage injected');
  const sub = await l.call('subscribe', { target: 'selection' });
  ok(!sub.isError && l.live.session.subscriptions.selection, 'local subscribe works');
  await l.client.close();
  destroySession(l.live);
}

A.ws.close(); B.ws.close();
await bridge.close?.();
rmSync(HOME, { recursive: true, force: true });
console.log(`remote-policy: ${checks} checks passed`);
process.exit(0);
