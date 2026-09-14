// Throwaway end-to-end probe. Spawns the bridge over stdio, runs the
// MCP initialize handshake, then calls one tool. Prints results to stderr.
// Usage: node test-call.mjs <tool> [json-args]
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const tool = process.argv[2] ?? 'get_document';
const args = process.argv[3] ? JSON.parse(process.argv[3]) : {};

const bridge = spawn('node', [resolve(new URL('../dist/index.js', import.meta.url).pathname)], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buf = '';
const pending = new Map();

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
    } else {
      console.error('notif/other:', JSON.stringify(msg));
    }
  }
});

let nextId = 1;
function send(method, params) {
  const id = nextId++;
  const req = { jsonrpc: '2.0', id, method, params };
  return new Promise((res) => {
    pending.set(id, res);
    bridge.stdin.write(JSON.stringify(req) + '\n');
  });
}
function notify(method, params) {
  bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

(async () => {
  const init = await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'grip-test', version: '0.0.1' },
  });
  console.error('init:', init.result?.serverInfo);
  notify('notifications/initialized', {});

  // Give plugin time to reconnect — UI uses exponential backoff up to 10s
  await new Promise((r) => setTimeout(r, 11000));

  const list = await send('tools/list', {});
  console.error('tools:', list.result?.tools?.map((t) => t.name).join(', '));

  const call = await send('tools/call', { name: tool, arguments: args });
  if (call.error) {
    console.error('error:', call.error);
  } else if (call.result?.isError) {
    console.error('tool error:', call.result.content?.[0]?.text);
  } else {
    const text = call.result?.content?.[0]?.text ?? '';
    console.log(text);
  }

  bridge.kill();
})().catch((err) => {
  console.error('fatal:', err);
  bridge.kill();
  process.exit(1);
});
