// Chains multiple MCP calls in one bridge run so state (active file) persists.
// Usage:  node test-chain.mjs '[["tool",{...}], ...]'
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const calls = JSON.parse(process.argv[2]);

const bridge = spawn('node', [resolve('dist/index.js')], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buf = '';
const pending = new Map();
let nextId = 1;

bridge.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { console.error('non-json:', line); continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function send(method, params) {
  const id = nextId++;
  return new Promise((res) => {
    pending.set(id, res);
    bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
function notify(method, params) {
  bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

(async () => {
  await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'grip-chain', version: '0.0.1' },
  });
  notify('notifications/initialized', {});

  // UI reconnect uses exponential backoff up to 10s; wait past that.
  await new Promise((r) => setTimeout(r, 11000));

  for (const [tool, args] of calls) {
    const r = await send('tools/call', { name: tool, arguments: args ?? {} });
    const text = r.result?.content?.[0]?.text ?? JSON.stringify(r);
    console.log(`\n=== ${tool} ===\n${text}`);
  }

  bridge.kill();
})().catch((err) => {
  console.error('fatal:', err);
  bridge.kill();
  process.exit(1);
});
