// Hardening: frames that must not crash the daemon, bounded hello fields, socket and HTTP session
// caps, the file/URL guards, log rotation and the pair CLI against a real daemon process.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, statSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { WebSocket } from 'ws';

const HERE = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
async function waitFor(fn, ms = 4000) { const t = Date.now(); while (!(await fn())) { if (Date.now() - t > ms) throw new Error('timeout waiting'); await sleep(20); } }

// small limits, read at import time
process.env.GRIP_MAX_SOCKETS = '12';
process.env.GRIP_MAX_UNHELLOED = '4';
process.env.GRIP_HELLO_DEADLINE_MS = '1200';
process.env.GRIP_MAX_HTTP_SESSIONS = '3';
const { PluginBridge, clip } = await import('../dist/ws-server.js');
const { HttpServer } = await import('../dist/http-server.js');

// ---- 1. frames that are valid JSON but not a frame
const port = await freePort();
const bridge = new PluginBridge(port);
await new Promise((r) => bridge.once('listening', r));
const open = async (origin = 'null') => { const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin }); ws.closeCode = null; ws.on('close', (c) => { ws.closeCode = c; }); ws.on('error', () => {}); await new Promise((r) => ws.on('open', r)); return ws; };
const probe = await open();
for (const junk of ['null', '5', '"x"', 'true', '[]', '[1,2]', '{', '', '{"kind":"hello"}', '{"event":null}', '{"type":"update_request","version":{"a":1}}', '{"id":{}}', '{"scriptLog":true,"id":{},"line":3}']) probe.send(junk);
await sleep(300);
assert.equal(probe.readyState, 1, 'junk frames neither crash the bridge nor drop the socket');
const after = await open();
after.send(JSON.stringify({ kind: 'hello', version: '0.9.6', fileKey: 'K', fileName: 'Still works', currentPageId: '0:1', currentPageName: 'P' }));
await waitFor(() => bridge.snapshot().plugins.some((p) => p.fileName === 'Still works' && p.hello));

// ---- 2. hello fields are typed and bounded
after.send(JSON.stringify({
  kind: 'hello', version: { a: 1 }, capabilities: 'not-an-array', minBridge: 7,
  fileKey: 'K\nforged', fileName: 'A\n[grip] update_request from deadbeef\u0000' + 'x'.repeat(8 * 1024 * 1024), currentPageId: 5, currentPageName: { o: 1 },
}));
await waitFor(() => bridge.snapshot().plugins.some((p) => p.fileName.startsWith('A ')));
const snap = bridge.snapshot().plugins.find((p) => p.fileName.startsWith('A '));
assert.ok(snap.fileName.length <= 256, `fileName bounded (${snap.fileName.length})`);
assert.ok(!/[\u0000-\u001f]/.test(snap.fileName), 'no control characters (a newline would forge log lines)');
assert.equal(snap.pluginVersion, 'unknown'); assert.equal(snap.fileKey, 'K forged');
assert.equal(clip(123, 5), ''); assert.equal(clip('a\tb', 9), 'a b'); assert.equal(clip('abcdef', 3), 'abc');

// ---- 3. connection caps and the hello deadline
const socks = [];
for (let i = 0; i < 30; i++) { try { socks.push(await open()); } catch { /* refused */ } }
await sleep(300);
const stillOpen = socks.filter((s) => s.readyState === 1).length;
assert.ok(stillOpen <= 4, `at most 4 sockets without hello are kept (kept ${stillOpen})`);
// A page holding every silent slot must not lock the real plugin out: the OLDEST silent socket
// makes room for a newcomer, so the real plugin (the newest connection) gets in.
{
  await sleep(350);   // the idle sockets are now old enough to be evicted
  const realPlugin = await open();
  await sleep(200);
  assert.equal(realPlugin.readyState, 1, 'the real plugin gets a slot even while idle sockets fill the limit');
  realPlugin.send(JSON.stringify({ kind: 'hello', version: '0.9.6', fileKey: 'KR', fileName: 'Real plugin', currentPageId: '0:1', currentPageName: 'P' }));
  await waitFor(() => bridge.snapshot().plugins.some((p) => p.fileName === 'Real plugin' && p.hello));
  assert.ok(socks.some((x) => x.closeCode === 1013), 'the idle sockets were the ones evicted (1013)');
  socks.push(realPlugin);
}
await waitFor(() => socks.every((s) => s.readyState !== 1 || s.helloed), 3000).catch(() => {});
await waitFor(() => socks.filter((s) => s.readyState === 1).length <= 1, 4000);
assert.ok(socks.some((s) => s.closeCode === 4408), 'a socket that never says hello is closed (4408)');
const hi = await open(); hi.send(JSON.stringify({ kind: 'hello', fileKey: 'K2', fileName: 'Stays', version: '0.9.6' }));
await sleep(900);
assert.equal(hi.readyState, 1, 'a socket that said hello is not closed by the deadline');

// the refused-origin log line is clipped and rate-limited (a flood must not evict real history)
{
  let logged = 0; const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (c) => { logged += Buffer.byteLength(String(c)); return true; };
  const evil = 'https://' + 'a'.repeat(2000) + '.example';
  await Promise.all(Array.from({ length: 150 }, () => new Promise((res) => { const w = new WebSocket(`ws://127.0.0.1:${port}`, { origin: evil }); w.on('unexpected-response', (_q, r) => { r.resume(); res(); }); w.on('error', () => res()); w.on('open', () => { w.close(); res(); }); })));
  process.stderr.write = orig;
  assert.ok(logged < 2000, `150 refused handshakes with 2KB origins logged ${logged} bytes`);
}
for (const s of [probe, after, hi, ...socks]) try { s.close(); } catch {}
bridge.close();

// ---- 3b. a paired plugin is not locked out by socket churn (reserved pool, see ws-server.ts)
{
  const { PairingStore, authProof } = await import('../dist/pairing.js');
  const dir = mkdtempSync(join(tmpdir(), 'grip-churn-'));
  const store = new PairingStore(dir, 'auto');
  const tok = store.grant();
  const p = await freePort();
  const b = new PluginBridge(p, { pairing: store });
  await new Promise((r) => b.once('listening', r));
  const attackers = []; let stop = false;
  // a page that opens bursts of anonymous sockets, some guessing a ticket
  const churn = (async () => {
    while (!stop) {
      if (attackers.length > 700) { stop = true; break; }   // enough to saturate the pool without draining the machine's ephemeral ports
      for (let i = 0; i < 20; i++) {
        const w = new WebSocket(`ws://127.0.0.1:${p}${i % 4 === 0 ? '/?t=' + 'f'.repeat(16) : ''}`, { origin: 'null' });
        w.on('error', () => {}); attackers.push(w);
      }
      await sleep(30);
    }
  })();
  await sleep(150);
  for (const gap of [0, 20, 100]) {
    const ws = new WebSocket(`ws://127.0.0.1:${p}/?t=${tok.id}`, { origin: 'null' });
    const frames = []; let closed = null;
    ws.on('message', (m) => frames.push(JSON.parse(m.toString()))); ws.on('close', (c) => { closed = c; }); ws.on('error', () => {});
    await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
    await waitFor(() => frames.some((f) => f.kind === 'welcome'));
    const welcome = frames.find((f) => f.kind === 'welcome');
    await sleep(gap);
    const np = 'ab'.repeat(8);
    ws.send(JSON.stringify({ type: 'auth', tokenId: tok.id, nonce: np, proof: authProof(tok.secret, 'plugin', welcome.nonce, np) }));
    await waitFor(() => frames.some((f) => f.type === 'auth_ok'));
    await sleep(gap);
    ws.send(JSON.stringify({ kind: 'hello', version: '0.9.6', fileKey: 'KC' + gap, fileName: 'Churn ' + gap, currentPageId: '0:1', currentPageName: 'P' }));
    await waitFor(() => b.snapshot().plugins.some((x) => x.fileName === 'Churn ' + gap && x.hello));
    assert.equal(closed, null, `a paired plugin survives churn with ${gap}ms between its steps`);
  }
  stop = true; await churn;
  for (const w of attackers) try { w.terminate(); } catch {}
  b.close(); rmSync(dir, { recursive: true, force: true });
}

// ---- 4. HTTP sessions are capped
{
  const wsPort = await freePort(), httpPort = await freePort();
  const b = new PluginBridge(wsPort); await new Promise((r) => b.once('listening', r));
  const http = new HttpServer(httpPort, b); await http.listen();
  const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '1' } } });
  const post = () => new Promise((res) => { const rq = request({ host: '127.0.0.1', port: httpPort, path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' } }, (r) => { r.resume(); r.on('end', () => res(r.statusCode)); }); rq.on('error', () => res(0)); rq.end(init); });
  const codes = []; for (let i = 0; i < 6; i++) codes.push(await post());
  assert.deepEqual(codes.slice(0, 3), [200, 200, 200]);
  assert.ok(codes.slice(3).every((c) => c === 503), `sessions beyond the cap get 503: ${codes}`);
  assert.equal(http.sessionCount(), 3);
  http.close(); b.close();
}

// ---- 5. file and URL guards
{
  const home = mkdtempSync(join(tmpdir(), 'grip-home-'));
  process.env.HOME = home;                    // os.homedir() follows HOME on POSIX
  delete process.env.GRIP_ALLOW_ANY_PATH;
  const { checkImageRead, checkExportWrite, checkWebUrl, looksLikeImage } = await import('../dist/guards.js');
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  mkdirSync(join(home, 'Pictures')); mkdirSync(join(home, '.ssh')); mkdirSync(join(home, 'Library'));
  writeFileSync(join(home, 'Pictures', 'a.png'), png);
  writeFileSync(join(home, 'Pictures', 'notes.txt'), 'hello');
  writeFileSync(join(home, '.ssh', 'id_rsa'), 'PRIVATE');
  writeFileSync(join(home, '.zshrc'), 'export X=1');
  writeFileSync(join(home, 'Library', 'x.png'), png);
  symlinkSync('/etc', join(home, 'etclink'));
  const refused = async (p, re, label) => { const r = await checkImageRead(p); assert.ok(!r.ok, `${label} must be refused`); assert.match(r.error, re, label); };
  assert.ok((await checkImageRead(join(home, 'Pictures', 'a.png'))).ok, 'a real image in the home directory reads');
  assert.ok((await checkImageRead('~/Pictures/a.png')).ok, '~ expands');
  await refused(join(home, '.ssh', 'id_rsa'), /hidden/, 'a dot directory');
  await refused(join(home, '.zshrc'), /hidden/, 'a dotfile');
  await refused(join(home, 'Library', 'x.png'), /Library/, '~/Library');
  await refused('/etc/hosts', /outside the home/, 'a path outside home and temp');
  await refused(join(home, 'etclink', 'hosts'), /outside the home/, 'a symlink leading out of the home directory');
  await refused(join(home, 'Pictures', 'notes.txt'), /not a PNG/, 'a non-image file');
  await refused(join(home, 'Pictures', 'missing.png'), /Failed to read/, 'a missing file');
  await refused(join(home, 'Pictures'), /not a regular file/, 'a directory');
  assert.ok(looksLikeImage(Buffer.from('GIF89a......')) && looksLikeImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])) && !looksLikeImage(Buffer.from('%PDF-1.7......')));

  const w = (p, fmt, ow = false) => checkExportWrite(p, fmt, ow);
  assert.ok((await w(join(home, 'Pictures', 'new.png'), 'PNG')).ok, 'a new .png in a normal folder');
  assert.ok((await w(join(tmpdir(), 'grip-test-out.svg'), 'SVG')).ok, 'temp directory is fine');
  assert.match((await w(join(home, 'Pictures', 'new.txt'), 'PNG')).error, /must end in \.png/, 'wrong extension for the format');
  assert.match((await w(join(home, '.zshrc'), 'JSON')).error, /hidden/, 'dotfile target');
  assert.match((await w(join(home, '.ssh', 'authorized_keys.svg'), 'SVG')).error, /hidden/, 'dot directory target');
  assert.match((await w(join(home, 'Library', 'a.png'), 'PNG')).error, /Library/);
  assert.match((await w('/etc/x.png', 'PNG')).error, /outside the home/);
  assert.match((await w(join(home, 'etclink', 'x.png'), 'PNG')).error, /outside the home/, 'a symlinked directory cannot lead out');
  assert.match((await w(join(home, 'Pictures', 'a.png'), 'PNG')).error, /already exists/, 'existing files are not replaced silently');
  assert.ok((await w(join(home, 'Pictures', 'a.png'), 'PNG', true)).ok, 'overwrite:true replaces');
  process.env.GRIP_ALLOWED_DIRS = '/opt/shared';
  assert.ok((await w('/opt/shared/out.png', 'PNG')).ok, 'GRIP_ALLOWED_DIRS widens the roots');
  delete process.env.GRIP_ALLOWED_DIRS;
  process.env.GRIP_ALLOW_ANY_PATH = '1';
  assert.ok((await checkImageRead(join(home, '.ssh', 'id_rsa'))).ok === false, 'the image-only rule stays even with the path policy off');
  delete process.env.GRIP_ALLOW_ANY_PATH;

  for (const u of ['https://example.com/a.png', 'http://example.com:8080/x?y=1', 'https://cdn.figma.com/x']) assert.ok(checkWebUrl(u, 't').ok, u);
  for (const u of ['https://8.8.8.8/', 'http://[2606:4700:4700::1111]/', 'https://example.com./', 'http://100.63.0.1/', 'http://172.32.0.1/', 'http://[::ffff:808:808]/']) assert.ok(checkWebUrl(u, 't').ok, `allowed: ${u}`);
  for (const u of ['http://localhost./', 'http://[::ffff:7f00:1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:c0a8:101]/', 'http://[::ffff:a00:1]/', 'http://[64:ff9b::7f00:1]/', 'http://100.64.0.1/', 'http://100.127.255.254/', 'http://[::]/', 'http://printer./', 'http://2130706433/', 'http://0x7f.1/', 'http://0177.0.0.1/', 'http://0.0.0.0/', 'http://172.16.5.5/', 'http://[fe80::1]/', 'http://[fd00::1]/', 'http://[2002:7f00:1::]/', 'http://[0:0:0:0:0:0:0:1]/', 'http://foo.localdomain/', 'http://router.home.arpa/'])
    assert.ok(!checkWebUrl(u, 't').ok, `refused: ${u}`);
  for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'ftp://example.com', 'http://localhost:7777/', 'http://127.0.0.1/', 'http://[::1]/', 'http://10.0.0.5/', 'http://192.168.1.1/', 'http://172.16.0.1/', 'http://169.254.169.254/latest/meta-data', 'http://nas.local/', 'http://intranet/', 'http://user:pw@example.com/', 'not a url', '', 'https://' + 'a'.repeat(3000) + '.com'])
    assert.ok(!checkWebUrl(u, 't').ok, `refused: ${u.slice(0, 50)}`);
  rmSync(home, { recursive: true, force: true });
}

// ---- 5b. IPC framing is linear and bounded
{
  const { SocketTransport } = await import('../dist/socket-transport.js');
  const { createServer: srv, connect } = await import('node:net');
  const path = join(tmpdir(), `grip-ipc-${process.pid}.sock`);
  const got = []; const errs = [];
  const server = srv((sock) => { const t = new SocketTransport(sock); t.onmessage = (m) => got.push(m); t.onerror = (e) => errs.push(e.message); t.start(); });
  await new Promise((r) => server.listen(path, r));
  const c = connect(path); c.on('error', () => {}); await new Promise((r) => c.on('connect', r));
  const ping = (id) => JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' });
  // several frames in one write, and one frame split across writes
  c.write(ping(1) + '\n' + ping(2) + '\n' + ping(3).slice(0, 10)); await sleep(50);
  c.write(ping(3).slice(10) + '\n'); await waitFor(() => got.length === 3);
  assert.deepEqual(got.map((m) => m.id), [1, 2, 3]);
  // 9MB without a newline in 64KB chunks: must not burn CPU (it was quadratic)
  const chunk = 'x'.repeat(64 * 1024); const t0 = process.cpuUsage();
  for (let i = 0; i < 144; i++) { c.write(chunk); if (i % 16 === 0) await sleep(5); }
  await sleep(300);
  const cpu = process.cpuUsage(t0); const cpuMs = (cpu.user + cpu.system) / 1000;
  assert.ok(cpuMs < 1500, `9MB partial frame cost ${Math.round(cpuMs)}ms of CPU`);
  // finishing it yields one error (not JSON), and the connection still works
  c.write('\n' + ping(4) + '\n'); await waitFor(() => got.length === 4);
  // a NEW connection may not park more than the first-frame cap before one valid frame
  {
    const c2 = connect(path); c2.on('error', () => {}); await new Promise((r) => c2.on('connect', r));
    let shut = false; c2.on('close', () => { shut = true; });
    const before = errs.length;
    for (let i = 0; i < 24 && !shut; i++) { c2.write(chunk); await sleep(2); }   // ~1.5MB, no newline, no valid frame yet
    await waitFor(() => shut, 3000);
    assert.ok(errs.slice(before).some((m) => /before the first valid frame/.test(m)), 'an unvalidated connection is capped at the first-frame limit');
  }
  // together, validated connections may not park more than the budget (64MB): nine hold 9.4MB each
  {
    const holders = [];
    for (let i = 0; i < 9; i++) { const h = connect(path); h.on('error', () => {}); await new Promise((r) => h.on('connect', r)); h.closedFlag = false; h.on('close', () => { h.closedFlag = true; }); h.write(ping(100 + i) + '\n'); holders.push(h); }
    await waitFor(() => got.length >= 4 + 9);
    const before = errs.length;
    for (let r = 0; r < 144; r++) { for (const h of holders) if (!h.closedFlag) h.write(chunk); if (r % 12 === 0) await sleep(5); }
    await sleep(400);
    assert.ok(holders.some((h) => h.closedFlag), 'when the connections together hold more than the budget, one is closed');
    assert.ok(errs.slice(before).some((m) => /budget/.test(m)), 'the budget error names itself');
    for (const h of holders) h.destroy();
    await sleep(100);
  }
  // past the cap the socket is destroyed
  const big = 'y'.repeat(64 * 1024); let closed = false; c.on('close', () => { closed = true; });
  for (let i = 0; i < 170 && !closed; i++) { c.write(big); await sleep(2); }
  await waitFor(() => closed, 3000);
  assert.ok(errs.some((m) => /frame_too_large/.test(m)), 'an oversized frame closes the connection');
  server.close(); try { rmSync(path); } catch {}
}

// ---- 6. a real daemon: survives a junk frame, rotates its log, writes owner-only files; pair CLI
{
  const DIST = join(HERE, '..', 'dist', 'index.js');
  const work = mkdtempSync(join(tmpdir(), 'grip-daemon-'));
  const wsPort = await freePort(), httpPort = await freePort();
  const env = { ...process.env, GRIP_HOME: join(work, 'home'), GRIP_WS_PORT: String(wsPort), GRIP_HTTP_PORT: String(httpPort), GRIP_IPC_PATH: join(work, 'ipc.sock'), GRIP_LOG_PATH: join(work, 'log.txt'), GRIP_STATUS_PATH: join(work, 'status.json'), GRIP_LOG_MAX_BYTES: '6000', GRIP_PERSISTENT: '1', GRIP_NO_UPDATE_CHECK: '1', HOME: work };
  const d = spawn(process.execPath, [DIST, '--daemon'], { env, stdio: 'ignore' });
  try {
    await waitFor(() => existsSync(join(work, 'status.json')), 8000);
    const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`, { origin: 'null' });
    await new Promise((r) => ws.on('open', r));
    ws.send('null'); ws.send('5'); ws.send('"x"');
    for (let i = 0; i < 300; i++) ws.send(JSON.stringify({ kind: 'hello', fileKey: 'K', fileName: 'chatty ' + i, version: '0.9.6', currentPageId: '0:1', currentPageName: 'P' }));
    await sleep(800);
    assert.equal(d.exitCode, null, 'the daemon survived junk frames');
    const ws2 = new WebSocket(`ws://127.0.0.1:${wsPort}`, { origin: 'null' });
    await new Promise((r, j) => { ws2.on('open', r); ws2.on('error', j); });
    ws.close(); ws2.close();
    assert.ok(existsSync(join(work, 'log.txt.1')), 'the log was rotated at the size cap');
    assert.ok(statSync(join(work, 'log.txt')).size < 12000, 'the live log stays small');
    if (process.platform !== 'win32') {
      assert.equal(statSync(join(work, 'log.txt')).mode & 0o777, 0o600, 'log is owner-only');
      assert.equal(statSync(join(work, 'status.json')).mode & 0o777, 0o600, 'status file is owner-only');
    }
  } finally { d.kill('SIGKILL'); }

  const cli = (...args) => spawnSync(process.execPath, [DIST, 'pair', ...args], { env, encoding: 'utf8' });
  assert.match(cli('--status').stdout, /0 plugin install\(s\) paired, not enforced yet/);
  const open = cli();
  assert.equal(open.status, 0); assert.match(open.stdout, /Pairing window open for 120s/);
  assert.match(cli('--status').stdout, /window OPEN/);
  assert.match(cli('--close').stdout, /closed/); assert.doesNotMatch(cli('--status').stdout, /OPEN/);
  assert.match(cli('--reset').stdout, /removed/);
  assert.match(spawnSync(process.execPath, [DIST, 'pair', '--status'], { env: { ...env, GRIP_PAIRING: 'off' }, encoding: 'utf8' }).stdout, /switched off/);
  rmSync(work, { recursive: true, force: true });
}

console.log('hardening.mjs OK');
process.exit(0);
