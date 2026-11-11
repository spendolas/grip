// The bridge must not be reachable from the network, and a web page on this machine must not
// be able to drive it: loopback-only WebSocket bind, handshake Origin check, HTTP Host/Origin guard.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { networkInterfaces } from 'node:os';
import { createServer as createNetServer } from 'node:net';
import { WebSocket } from 'ws';
import { PluginBridge, WS_HOST, originAllowedForUpdate } from '../dist/ws-server.js';
import { HttpServer, hostAllowed, originAllowed } from '../dist/http-server.js';

const freePort = () => new Promise((res) => { const s = createNetServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

// ---- pure rules
assert.strictEqual(WS_HOST, '127.0.0.1');
for (const h of ['127.0.0.1:7778', 'localhost:7778', 'localhost', '[::1]:7778']) assert.ok(hostAllowed(h), `host ${h} allowed`);
for (const h of [undefined, '', 'evil.example', 'evil.example:7778', '127.0.0.1.evil.example', '192.168.1.5:7778', 'localhost.evil.example']) assert.ok(!hostAllowed(h), `host ${h} refused`);
assert.ok(originAllowed(undefined), 'native clients send no Origin');
assert.ok(originAllowed('http://localhost:6274') && originAllowed('http://127.0.0.1:3000'));
for (const o of ['https://evil.example', 'null', 'http://127.0.0.1.evil.example', 'file://', 'not a url']) assert.ok(!originAllowed(o), `origin ${o} refused`);
assert.ok(originAllowedForUpdate('null') && originAllowedForUpdate('https://www.figma.com') && originAllowedForUpdate(undefined));
assert.ok(!originAllowedForUpdate('https://evil.example'));

// ---- WebSocket: loopback bind
const wsPort = await freePort();
const bridge = new PluginBridge(wsPort);
await new Promise((r) => bridge.once('listening', r));
const addr = bridge.wss.address();
assert.strictEqual(addr.address, '127.0.0.1', `ws must bind loopback only, bound ${addr.address}`);

// every non-loopback IPv4 address of this machine must refuse the connection
const lan = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
for (const ip of lan) {
  const outcome = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://${ip}:${wsPort}`, { handshakeTimeout: 1500 });
    ws.on('open', () => { resolve('open'); ws.close(); });
    ws.on('error', (e) => resolve(e.code ?? 'error'));
  });
  assert.notStrictEqual(outcome, 'open', `ws reachable on LAN address ${ip}`);
}
console.log(`network-exposure: checked ${lan.length} LAN address(es)`);

// ---- WebSocket: handshake Origin
const handshake = (origin) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`, origin === undefined ? {} : { origin });
  ws.on('unexpected-response', (_q, res) => { resolve(res.statusCode); ws.terminate(); });
  ws.on('open', () => { resolve('open'); ws.close(); });
  ws.on('error', () => {});
});
assert.strictEqual(await handshake(undefined), 'open', 'no Origin (native client) ok');
assert.strictEqual(await handshake('null'), 'open', 'Figma plugin iframe (Origin null) ok');
assert.strictEqual(await handshake('https://www.figma.com'), 'open', 'figma.com ok');
assert.strictEqual(await handshake('https://evil.example'), 403, 'web page refused');
assert.strictEqual(await handshake('http://localhost:3000'), 403, 'a local web page is a web page too');

// ---- IPv6 loopback: `localhost` may resolve to ::1 first, so it must work and follow the same rules
const handshake6 = (origin) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://[::1]:${wsPort}`, origin === undefined ? {} : { origin });
  ws.on('unexpected-response', (_q, res) => { resolve(res.statusCode); ws.terminate(); });
  ws.on('open', () => { resolve('open'); ws.close(); });
  ws.on('error', (e) => resolve(e.code ?? 'error'));
});
const v6 = await handshake6('null');
if (v6 === 'open') {
  assert.strictEqual(await handshake6(undefined), 'open');
  assert.strictEqual(await handshake6('https://evil.example'), 403, 'web page refused on ::1 too');
  console.log('network-exposure: ::1 listener ok');
} else {
  console.log(`network-exposure: ::1 listener not available here (${v6}), skipped`);
}

// ---- HTTP: Host / Origin guard
const httpPort = await freePort();
const http = new HttpServer(httpPort, bridge);
assert.strictEqual(await http.listen(), true);
const get = (headers) => new Promise((resolve, reject) => {
  const r = request({ host: '127.0.0.1', port: httpPort, path: '/', method: 'GET', headers }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
  r.on('error', reject);
  r.end();
});
assert.strictEqual(await get({}), 200, 'normal request (Host 127.0.0.1) ok');
assert.strictEqual(await get({ host: `localhost:${httpPort}` }), 200, 'localhost Host ok');
assert.strictEqual(await get({ host: `evil.example:${httpPort}` }), 403, 'DNS-rebinding Host refused');
assert.strictEqual(await get({ origin: 'https://evil.example' }), 403, 'web Origin refused');
assert.strictEqual(await get({ origin: 'null' }), 403, 'Origin null refused on the MCP endpoint');

await http.close?.();
bridge.close?.();
console.log('network-exposure OK');
process.exit(0);
