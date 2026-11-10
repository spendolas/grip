// The stdio shim (proxy.ts): when its socket to the daemon drops mid-call it
// answers every in-flight request with a typed error. `maybeApplied` (re-read
// before retrying) must be set only for tools that can change the document,
// never for reads, read-only merged ops or bridge-side tools.
import assert from 'node:assert';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GRIP_NO_UPDATE_CHECK = '1';
const { toolMayChangeDocument } = await import('../dist/methods.js');

// ---------------------------------------------------------------- 1. the classifier
const cases = [
  // [tool, args, mayChange]
  ['get_node', {}, false],
  ['export_node', {}, false],
  ['set_node_property', {}, true],
  ['run_script', {}, true],
  ['create_node', {}, true],
  ['list_files', {}, false],
  ['set_active_file', { target: 'x' }, false],
  ['grip_health', {}, false],
  ['grip_diagnose', {}, false],
  ['grip_capabilities', {}, false],
  ['grip_load_tools', { categories: ['all'] }, false],
  ['grip_update', { action: 'check' }, false],
  ['subscribe', { target: 'selection' }, false],
  ['client_storage', { op: 'get' }, false],
  ['measurement', { op: 'list' }, false],
  ['dev_resource', { op: 'get' }, false],
  ['measurement', { op: 'add' }, true],
  ['group', { op: 'group' }, true],
  ['variable', { op: 'delete' }, true],
  ['group', {}, false],          // no op: refused by the bridge before the plugin
  ['upload_image_finish', {}, true],
  [undefined, {}, true],         // unknown: assume it may have changed something
];
for (const [tool, args, want] of cases) {
  assert.strictEqual(toolMayChangeDocument(tool, args), want, `${tool} ${JSON.stringify(args)} -> ${want}`);
}

// ---------------------------------------------------------------- 2. end to end through a real shim
const dir = mkdtempSync(join(tmpdir(), 'grip-shim-'));
const sockPath = join(dir, 's.sock');
const requests = [
  { id: 1, name: 'list_files', arguments: {} },
  { id: 2, name: 'grip_load_tools', arguments: { categories: ['all'] } },
  { id: 3, name: 'client_storage', arguments: { op: 'get', key: 'k' } },
  { id: 4, name: 'subscribe', arguments: { target: 'selection' } },
  { id: 5, name: 'get_node', arguments: { nodeId: '1:1' } },
  { id: 6, name: 'set_node_property', arguments: { nodeId: '1:1', property: 'opacity', value: 1 } },
  { id: 7, name: 'run_script', arguments: { code: '1' } },
  { id: 8, name: 'group', arguments: { op: 'group', nodeIds: ['1:1'] } },
];
const expectMaybe = { 1: false, 2: false, 3: false, 4: false, 5: false, 6: true, 7: true, 8: true, 9: false };

let seen = 0;
const server = createServer((sock) => {
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (d) => {
    buf += d;
    seen = buf.split('\n').filter((l) => l.includes('"jsonrpc"')).length;
    if (seen === requests.length + 1) sock.destroy();   // the "daemon" dies with every call in flight
  });
});
await new Promise((r) => server.listen(sockPath, r));

const proxyUrl = new URL('../dist/proxy.js', import.meta.url).href;
const env = { ...process.env };
delete env.GRIP_FILE;
delete env.GRIP_TOOLS;
const child = spawn(process.execPath, ['--input-type=module', '-e',
  `const { runProxy } = await import(${JSON.stringify(proxyUrl)}); await runProxy(${JSON.stringify(sockPath)}); process.exit(0);`],
  { stdio: ['pipe', 'pipe', 'ignore'], env });
let out = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (d) => { out += d; });
for (const r of requests) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, method: 'tools/call', params: { name: r.name, arguments: r.arguments } }) + '\n');
}
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }) + '\n');
const code = await new Promise((r) => {
  const t = setTimeout(() => { child.kill(); r('timeout'); }, 15_000);
  child.on('exit', (c) => { clearTimeout(t); r(c); });
});
assert.strictEqual(code, 0, `shim exited (${code}); saw ${seen} requests`);
const errs = out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
assert.strictEqual(errs.length, requests.length + 1, 'one typed error per in-flight request');
for (const e of errs) {
  assert.strictEqual(e.error.data.code, 'leader_dropped');
  assert.strictEqual(e.error.data.maybeApplied, expectMaybe[e.id], `id ${e.id} (${e.error.data.tool ?? e.error.data.method}) maybeApplied`);
  if (expectMaybe[e.id]) assert.match(e.error.message, /may already have been applied/);
  else assert.match(e.error.message, /safe to retry/);
}

server.close();
rmSync(dir, { recursive: true, force: true });
console.log('proxy-shim.mjs OK');
process.exit(0);
