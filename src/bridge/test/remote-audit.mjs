// Chunk B: MCP tool annotations derived from the remote classification, and the remote
// audit log (remote-audit.ts, the hook in mcp-server.ts, `remote log` / `remote status`).
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createNetServer } from 'node:net';
import { WebSocket } from 'ws';

const HOME = mkdtempSync(join(tmpdir(), 'grip-audit-'));
process.env.GRIP_TEST = '1';
process.env.GRIP_HOME = HOME;
process.env.GRIP_NO_UPDATE_CHECK = '1';
process.env.GRIP_REQUEST_TIMEOUT_MS = '2000';

const P = await import('../dist/remote-policy.js');
const A = await import('../dist/remote-audit.js');
const { runRemoteCli } = await import('../dist/remote-cli.js');
const { TOOLS, MERGED_TOOLS } = await import('../dist/tools.js');
const { PluginBridge } = await import('../dist/ws-server.js');
const { createSession, destroySession } = await import('../dist/mcp-server.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

setTimeout(() => { console.error('remote-audit.mjs: timed out'); process.exit(1); }, 60_000).unref();
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); checks++; };
const KEY_A = 'AAAAAAAAAAAAAAAAAAAAAA';
const KEY_B = 'BBBBBBBBBBBBBBBBBBBBBB';

// ---------------------------------------------------------------- 1. annotations
{
  const isRead = (tool, tier) => tier === 'read' || (tier === 'never' && P.NEVER_READ_NAMES.includes(tool));
  for (const t of TOOLS) {
    const a = P.toolAnnotations(t.name);
    ok(a && typeof a.readOnlyHint === 'boolean' && typeof a.destructiveHint === 'boolean', `${t.name} has annotations`);
    const c = P.REMOTE_TOOL_CLASS[t.name];
    const tiers = typeof c === 'string' ? [[t.name, c]] : Object.entries(c);
    const allRead = tiers.every(([, tier]) => isRead(t.name, tier));
    eq(a.readOnlyHint, allRead, `${t.name}: readOnlyHint agrees with the classification`);
    if (typeof c === 'string' && c === 'read') eq(a.readOnlyHint, true, `${t.name}: read class => readOnly`);
    if (tiers.some(([, tier]) => tier === 'write' || tier === 'extended')) eq(a.readOnlyHint, false, `${t.name}: changes the file => not readOnly`);
    if (a.readOnlyHint) eq(a.destructiveHint, false, `${t.name}: a read is never destructive`);
  }
  // every DESTRUCTIVE / NEVER_READS name refers to a real tool (or tool:op)
  for (const n of P.DESTRUCTIVE_NAMES) {
    const [tool, op] = n.split(':');
    ok(TOOLS.some((t) => t.name === tool), `destructive entry ${n}: tool exists`);
    if (op) ok(MERGED_TOOLS[tool] && op in MERGED_TOOLS[tool].map, `destructive entry ${n}: op exists`);
  }
  for (const n of P.NEVER_READ_NAMES) eq(P.REMOTE_TOOL_CLASS[n], 'never', `${n}: NEVER_READS only lists never tools`);
  eq(P.toolAnnotations('get_node'), { readOnlyHint: true, destructiveHint: false }, 'get_node');
  eq(P.toolAnnotations('set_node_property'), { readOnlyHint: false, destructiveHint: false }, 'set_node_property');
  eq(P.toolAnnotations('delete_node'), { readOnlyHint: false, destructiveHint: true }, 'delete_node');
  eq(P.toolAnnotations('measurement'), { readOnlyHint: false, destructiveHint: true }, 'merged tool with a delete op');
  eq(P.toolAnnotations('slides_canvas'), { readOnlyHint: false, destructiveHint: false }, 'merged tool without a destructive op');
  eq(P.toolAnnotations('nope'), undefined, 'unknown tool: none');
}

// ---------------------------------------------------------------- 2. args summary + file writing
{
  const big = 'x'.repeat(5000);
  const s = A.summarizeArgsForAudit({ nodeId: '1:2', op: 'add', text: 'secret words', base64: big, props: { a: 1, b: 2 }, nodeIds: ['1', '2'], x: 12, inline: true, format: 'PNG' });
  eq(s, 'nodeId=1:2 op=add text=str(12) base64=str(5000) props=obj(2) nodeIds=arr(2) x=num inline=true format=PNG', 'keys and sizes only');
  ok(!s.includes('secret') && !s.includes('xxxx'), 'no raw text or base64');
  eq(A.summarizeArgsForAudit({ nodeId: 'has spaces and is way too long to be an id 1234567890' }), 'nodeId=str(53)', 'non-id-like value hidden even for a shown key');
  const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`key${i}`, 'v']));
  ok(A.summarizeArgsForAudit(many).length <= A.ARGS_SUMMARY_MAX, 'capped at 200 chars');

  const dir = mkdtempSync(join(tmpdir(), 'grip-audit-rot-'));
  process.env.GRIP_AUDIT_MAX_BYTES = '600';
  for (let i = 0; i < 10; i++) A.auditPolicy({ event: 'allow_file', by: 'cli', fileKey: KEY_A }, dir);
  const path = A.auditPath(dir);
  ok(existsSync(`${path}.1`), 'rotated to .1');
  ok(statSync(path).size <= 600, 'current file under the cap');
  if (process.platform !== 'win32') eq(statSync(path).mode & 0o777, 0o600, 'audit file is 0600');
  eq(A.readAudit(dir).length, 10 - 0, 'reader joins .1 and current') ;
  delete process.env.GRIP_AUDIT_MAX_BYTES;
  // a failure to write never throws
  const blocked = mkdtempSync(join(tmpdir(), 'grip-audit-blk-'));
  mkdirSync(A.auditPath(blocked));   // the log path is a directory: every append fails
  A.auditPolicy({ event: 'remote_on', by: 'cli' }, blocked);
  ok(true, 'append to an unwritable path does not throw');
  eq(A.parseSince('90s'), 90_000, 'since s'); eq(A.parseSince('1h'), 3_600_000, 'since h'); eq(A.parseSince('x'), undefined, 'since bad');
  rmSync(dir, { recursive: true, force: true }); rmSync(blocked, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 3. end to end
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (pred, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (pred()) return true; await sleep(10); } return false; };
const port = await new Promise((res) => { const s = createNetServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const bridge = new PluginBridge(port);
await new Promise((r) => bridge.once('listening', r));

async function plugin(fileKey, fileName) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.kind === 'welcome') { ws.send(JSON.stringify({ kind: 'hello', version: '0.8.0', fileKey, fileName, currentPageId: '0:1', currentPageName: 'P' })); return; }
    if (!m.id || !m.method) return;
    if (m.params?.nodeId === '9:9') { ws.send(JSON.stringify({ id: m.id, error: 'node_not_found: Node not found: 9:9' })); return; }
    ws.send(JSON.stringify({ id: m.id, result: { served: fileName, text: 'some layer text' } }));
  });
  await new Promise((r) => ws.on('open', r));
  await waitUntil(() => bridge.snapshot().plugins.some((x) => x.fileKey === fileKey && x.hello));
  return ws;
}
async function agent(opts) {
  const live = createSession(bridge, opts);
  live.session.updateNoticeSent = true;
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await live.server.connect(st);
  const client = new Client({ name: 't', version: '0' }, { capabilities: {} });
  await client.connect(ct);
  const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); return { isError: !!r.isError, text: r.content?.[0]?.text ?? '' }; };
  return { live, client, call };
}
const wsA = await plugin(KEY_A, 'File A');
const wsB = await plugin(KEY_B, 'File B');
const store = P.remotePolicyStore();
const calls = () => A.readAudit(HOME).filter((e) => e.kind === 'call');

// local session first: tools/list carries annotations (and the SDK client accepts them), nothing is logged
{
  const l = await agent();
  l.live.session.toolScopeSpec = 'all';
  const tools = (await l.client.listTools()).tools;
  eq(tools.length, TOOLS.length, 'all tools listed');
  ok(tools.every((t) => t.annotations && typeof t.annotations.readOnlyHint === 'boolean' && typeof t.annotations.destructiveHint === 'boolean'), 'every listed tool has annotations');
  eq(tools.find((t) => t.name === 'delete_node').annotations, { readOnlyHint: false, destructiveHint: true }, 'annotations on the wire');
  await l.call('set_active_file', { target: KEY_A });
  await l.call('get_node', { nodeId: '1:1' });
  await l.call('get_node', { nodeId: '9:9' });
  await l.call('run_script', { code: 'return 1' });
  eq(calls().length, 0, 'local sessions write nothing to the audit log');
  await l.client.close(); destroySession(l.live);
}

store.write({ enabled: true, mode: 'read', files: [KEY_A] });
{
  const r = await agent({ remote: { clientId: 'cloud-7' } });
  const rl = (await r.client.listTools()).tools;
  ok(rl.length > 0 && rl.every((t) => t.annotations?.readOnlyHint === true || t.annotations?.readOnlyHint === false), 'remote tools/list carries annotations');
  await r.call('get_node', { nodeId: '1:1', depth: 2 });
  await r.call('get_node', { nodeId: '9:9' });
  await r.call('set_node_property', { nodeId: '1:1', property: 'characters', value: 'top secret copy' });
  await r.call('measurement', { op: 'list' });
  const rows = calls();
  eq(rows.length, 4, 'one line per remote call');
  const [okRow, errRow, denRow, opRow] = rows;
  eq([okRow.status, errRow.status, denRow.status], ['ok', 'error', 'denied'], 'ok / error / denied');
  eq(okRow.clientId, 'cloud-7', 'clientId'); eq(okRow.sessionId, r.live.session.id, 'sessionId');
  eq(okRow.file, { fileKey: KEY_A, name: 'File A' }, 'file key and name');
  eq(okRow.args, 'nodeId=1:1 depth=2', 'args summary');
  ok(okRow.bytes > 0 && typeof okRow.ms === 'number', 'bytes and ms');
  eq(errRow.code, 'node_not_found', 'error code');
  ok(/write access is not armed/.test(denRow.code), 'denial reason recorded');
  ok(!JSON.stringify(rows).includes('top secret') && !JSON.stringify(rows).includes('some layer text'), 'no argument or result values');
  eq(opRow.op, 'list', 'merged op recorded');

  // write window expiry is logged once by the daemon
  store.write({ enabled: true, mode: 'write', writeUntil: Date.now() - 1000, files: [KEY_A] });
  await r.call('get_node', { nodeId: '1:1' });
  await r.call('get_node', { nodeId: '1:1' });
  eq(A.readAudit(HOME).filter((e) => e.kind === 'policy' && e.event === 'write_expired').length, 1, 'expiry logged once');

  // an unwritable audit log never breaks a call
  const n = calls().length;
  rmSync(A.auditPath(HOME), { force: true }); rmSync(`${A.auditPath(HOME)}.1`, { force: true });
  mkdirSync(A.auditPath(HOME));
  const t0 = Date.now();
  const g = await r.call('get_node', { nodeId: '1:1' });
  ok(!g.isError, 'call still succeeds when the audit log cannot be written');
  ok(Date.now() - t0 < 1500, 'and is not slowed');
  rmSync(A.auditPath(HOME), { recursive: true, force: true });
  ok(n > 0, 'had lines before');
  await r.client.close(); destroySession(r.live);
}

// ---------------------------------------------------------------- 4. CLI
{
  const lines = [];
  const NOW = Date.now();
  const cli = (...args) => { lines.length = 0; const code = runRemoteCli(['node', 'grip-bridge.mjs', 'remote', ...args], {
    store, statusPath: join(HOME, 'none.json'), now: () => NOW, out: (m = '') => lines.push(m), err: (m = '') => lines.push('ERR ' + m) }); return code; };
  // seed: an old call, two recent calls (one denied)
  A.appendAudit({ ts: new Date(NOW - 3 * 86_400_000).toISOString(), kind: 'call', clientId: 'old', sessionId: 's', tool: 'get_node', args: '', status: 'ok' }, HOME);
  A.auditCall({ clientId: 'c', sessionId: 's', tool: 'get_node', args: 'nodeId=1:1', status: 'ok', bytes: 10, ms: 3 }, HOME);
  A.auditCall({ clientId: 'c', sessionId: 's', tool: 'run_script', args: 'code=str(9)', status: 'denied', code: 'run_script is never available remotely' }, HOME);
  eq(cli('off'), 0, 'off');
  eq(cli('allow-file', KEY_B), 0, 'allow');
  eq(cli('on'), 0, 'on');
  eq(cli('mode', 'write', '--minutes', '5'), 0, 'arm');
  eq(cli('mode', 'read'), 0, 'read');
  eq(cli('deny-file', KEY_B), 0, 'deny');
  const ev = A.readAudit(HOME).filter((e) => e.kind === 'policy' && e.by === 'cli').map((e) => e.event);
  eq(ev, ['remote_off', 'allow_file', 'remote_on', 'write_armed', 'mode_read', 'deny_file'], 'CLI policy events logged');
  eq(cli('status'), 0, 'status');
  ok(lines.some((l) => /audit, last 24h: 2 remote call\(s\), 1 denied, 0 error/.test(l)), `status shows the 24h summary: ${lines.join(' | ')}`);
  eq(cli('log', '--denied'), 0, 'log --denied');
  eq(lines.length, 1, 'only the denial'); ok(/denied\s+run_script/.test(lines[0]), lines[0]);
  eq(cli('log', '--since', '1h', '--json'), 0, 'log --since --json');
  ok(lines.every((l) => JSON.parse(l)) && !lines.some((l) => l.includes('"old"')), 'json lines, old entry filtered out');
  eq(cli('log', '--tail', '2'), 0, 'log --tail');
  eq(lines.length, 2, 'two lines');
  eq(cli('log', '--since', 'soon'), 2, 'bad duration');
}

wsA.close(); wsB.close();
await bridge.close?.();
rmSync(HOME, { recursive: true, force: true });
console.log(`remote-audit: ${checks} checks passed`);
process.exit(0);
