// Read-only detection of a foreign Grip bridge (phase 2B): verdict rules against a fake io,
// and the real probe against local servers (including ones that hang or misbehave).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { detectForeign, realDetectIo } from '../dist/foreign-detect.js';

const here = dirname(fileURLToPath(import.meta.url));
const alt = JSON.parse(readFileSync(join(here, 'fixtures', 'flavour-alt', 'flavour.json'), 'utf8'));
const Z = alt.watchlist[0];   // zenith, floor 2.0.0, ws 7977
const Q = { ...Z, slug: 'quark', wsPort: 7987, httpPort: 7988, homeDirName: '.quark', statusFile: '.quark-bridge.status', logFile: '.quark-bridge.log', loginItem: 'Quark Daemon', launchLabel: 'com.quark.bridge', mcpName: 'quark', entryName: 'quark-bridge', ipcName: 'quark-bridge', serviceName: 'quark-bridge', startupLauncher: 'QuarkDaemon.vbs', minSecureVersion: '1.0.0' };
const HOME = '/h';

// A fake io: `files` maps absolute path -> text, `probes` maps port -> ProbeResult.
function fakeIo({ probes = {}, files = {}, exists = [], alive = [], platform = 'linux' } = {}) {
  return {
    platform, home: HOME, tmp: '/t', env: {}, uid: 501,
    probe: async (port) => probes[port] ?? { kind: 'closed' },
    readText: (p) => (p in files ? files[p] : null),
    exists: (p) => exists.includes(p) || p in files,
    pidAlive: (pid) => alive.includes(pid),
  };
}
const welcome = (version, flavour = null) => ({ kind: 'welcome', version, flavour });
const one = async (io, entries = [Z]) => (await detectForeign(entries, io)).findings[0];

// ---- verdicts from a live probe
{
  let f = await one(fakeIo({ probes: { 7977: welcome('1.9.9') } }));
  assert.equal(f.state, 'insecure');
  assert.equal(f.version, '1.9.9');
  assert.equal(f.floor, '2.0.0');
  assert.equal(f.running, true);
  assert.ok(f.evidence.includes('listening on port 7977 (version 1.9.9)'), f.evidence.join('|'));
  // at or above the floor: never an alert (review focus 1). 2.0.10 is numeric, not string order.
  for (const v of ['2.0.0', '2.0.10', '10.0.0']) assert.equal((await one(fakeIo({ probes: { 7977: welcome(v) } }))).state, 'ok', v);
  for (const v of ['2.0.0-rc.1', '1.9.9', 'garbage', '']) assert.equal((await one(fakeIo({ probes: { 7977: welcome(v) } }))).state, 'insecure', v);
  f = await one(fakeIo({ probes: { 7977: welcome(null) } }));
  assert.equal(f.state, 'insecure');
  assert.equal(f.version, null);
  // a welcome that says another flavour is not this foreign build
  assert.equal((await one(fakeIo({ probes: { 7977: welcome('1.0.0', 'other') } }))).state, 'unknown_service');
  assert.equal((await one(fakeIo({ probes: { 7977: welcome('1.0.0', 'zenith') } }))).state, 'insecure');
  // a listener that is not Grip: warn only
  f = await one(fakeIo({ probes: { 7977: { kind: 'other' } } }));
  assert.equal(f.state, 'unknown_service');
  assert.ok(f.evidence.includes('unknown service on port 7977'));
  assert.equal(f.running, false);
}

// ---- nothing listening
{
  const r = await detectForeign([Z], fakeIo());
  assert.equal(r.findings[0].state, 'none');
  assert.equal(r.worst, null);
  assert.ok(typeof r.checkedAt === 'string' && !Number.isNaN(Date.parse(r.checkedAt)));
}

// ---- files without a listener
{
  const status = `${HOME}/.zenith-bridge.status`;
  const inst = `${HOME}/.zenith/install.json`;
  let f = await one(fakeIo({ files: { [status]: JSON.stringify({ pid: 123, version: '1.0.0' }) }, alive: [123] }));
  assert.equal(f.state, 'insecure');
  assert.equal(f.running, true);
  assert.equal(f.pid, 123);
  assert.ok(f.evidence.includes('status file: pid 123 alive'));
  assert.ok(f.evidence.includes('status file: version 1.0.0'));
  // a status file whose process is gone is stale: not presence by itself
  f = await one(fakeIo({ files: { [status]: JSON.stringify({ pid: 123, version: '1.0.0' }) } }));
  assert.equal(f.state, 'none');
  assert.equal(f.pid, null);
  // installed but stopped: insecure (it starts at next login)
  f = await one(fakeIo({ files: { [inst]: JSON.stringify({ source: 'release', version: '1.0.0' }) } }));
  assert.equal(f.state, 'insecure');
  assert.equal(f.running, false);
  assert.ok(f.evidence.includes('install.json: version 1.0.0'));
  assert.equal((await one(fakeIo({ files: { [inst]: JSON.stringify({ version: '3.0.0' }) } }))).state, 'ok');
  // the entry file alone: present, version unknown, below the floor
  f = await one(fakeIo({ exists: [`${HOME}/.zenith/zenith-bridge.mjs`] }));
  assert.equal(f.state, 'insecure');
  assert.equal(f.version, null);
  assert.ok(f.evidence.includes('entry file present'));
  // the live probe's version beats the files
  f = await one(fakeIo({ probes: { 7977: welcome('2.1.0') }, files: { [inst]: JSON.stringify({ version: '1.0.0' }) } }));
  assert.equal(f.state, 'ok');
  assert.equal(f.version, '2.1.0');
  // an unknown listener does not hide a stale install
  f = await one(fakeIo({ probes: { 7977: { kind: 'other' } }, files: { [inst]: JSON.stringify({ version: '1.0.0' }) } }));
  assert.equal(f.state, 'insecure');
  assert.ok(f.evidence.includes('unknown service on port 7977'));
  // garbage and unreadable files never throw
  f = await one(fakeIo({ files: { [status]: '{not json', [inst]: '\u0000\u0001' } }));
  assert.ok(['insecure', 'none'].includes(f.state));
}

// ---- autostart, MCP entry: evidence only, never presence
{
  const app = `${HOME}/Applications/Zenith Daemon.app`;
  let f = await one(fakeIo({ platform: 'darwin', exists: [app] }));
  assert.equal(f.state, 'none');
  const cfg = `${HOME}/.claude.json`;
  f = await one(fakeIo({ files: { [cfg]: JSON.stringify({ mcpServers: { zenith: { type: 'http', url: 'http://127.0.0.1:7978/mcp' } } }) } }));
  assert.equal(f.state, 'none');
  // with presence from elsewhere the evidence is listed
  f = await one(fakeIo({ platform: 'darwin', exists: [app], probes: { 7977: welcome('1.0.0') }, files: { [cfg]: JSON.stringify({ mcpServers: { zenith: { type: 'http', url: 'http://127.0.0.1:7978/mcp' }, mine: { type: 'http', url: 'http://127.0.0.1:7878/mcp' } } }) } }));
  assert.ok(f.evidence.includes(`autostart: ${app}`));
  assert.ok(f.evidence.includes('mcp entry: zenith'));
  assert.ok(!f.evidence.includes('mcp entry: mine'), 'this build\'s own entry is not foreign');
}

// ---- several entries: the worst one wins
{
  const r = await detectForeign([Z, Q], fakeIo({ probes: { 7977: welcome('2.0.0'), 7987: welcome('0.5.0') } }));
  assert.equal(r.findings.length, 2);
  assert.equal(r.worst.slug, 'quark');
  assert.equal(r.worst.state, 'insecure');
}

// ---- a throwing probe never throws out of detection
{
  const io = fakeIo();
  io.probe = async () => { throw new Error('boom'); };
  const r = await detectForeign([Z], io);
  assert.equal(r.findings[0].state, 'none');
}

// ---- the real probe against real local servers (review focus 2: never hangs)
{
  const free = () => new Promise((res) => { const s = netServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const real = realDetectIo();
  const open = [];
  const listen = (srv, port) => new Promise((res) => { open.push(srv); srv.listen(port, '127.0.0.1', res); });

  // a ws server sending a welcome: version read, and the client never sends a frame
  {
    const port = await free();
    const got = [];
    const wss = new WebSocketServer({ host: '127.0.0.1', port });
    open.push({ close: (cb) => wss.close(cb) });
    wss.on('connection', (ws) => { ws.on('message', (m) => got.push(String(m))); ws.send(JSON.stringify({ kind: 'welcome', bridgeVersion: '1.0.0', sessionId: 'x' })); });
    await new Promise((r) => wss.once('listening', r));
    const r = await real.probe(port, 1500);
    assert.deepEqual(r, { kind: 'welcome', version: '1.0.0', flavour: null });
    await new Promise((r2) => setTimeout(r2, 100));
    assert.deepEqual(got, [], 'the probe sends nothing');
    const r2 = await detectForeign([{ ...Z, wsPort: port }], real);
    assert.equal(r2.findings[0].state, 'insecure');
    assert.equal(r2.findings[0].version, '1.0.0');
  }
  // a welcome that names a flavour
  {
    const port = await free();
    const wss = new WebSocketServer({ host: '127.0.0.1', port });
    open.push({ close: (cb) => wss.close(cb) });
    wss.on('connection', (ws) => ws.send(JSON.stringify({ kind: 'welcome', bridgeVersion: '3.0.0', flavour: 'acme' })));
    await new Promise((r) => wss.once('listening', r));
    assert.deepEqual(await real.probe(port, 1500), { kind: 'welcome', version: '3.0.0', flavour: 'acme' });
  }
  // a silent TCP listener: resolves as `other`, inside the budget (detectForeign: under 3 s)
  {
    const port = await free();
    // accepts and reads, never answers; the server sees the client's hang-up, so no socket is leaked
    let serverSideClosed = 0;
    const srv = netServer((s) => { s.on('error', () => {}); s.on('close', () => { serverSideClosed++; }); s.resume(); });
    await listen(srv, port);
    const t0 = Date.now();
    const r = await detectForeign([{ ...Z, wsPort: port }], real);
    assert.ok(Date.now() - t0 < 3000, `detection took ${Date.now() - t0}ms`);
    assert.equal(r.findings[0].state, 'unknown_service');
    const t1 = Date.now();
    assert.deepEqual(await real.probe(port, 300), { kind: 'other' });
    assert.ok(Date.now() - t1 < 1500);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(serverSideClosed, 2, 'every probe socket was closed by the client');
  }
  // a plain HTTP server
  {
    const port = await free();
    const srv = httpServer((q, s) => { s.end('hello'); });
    await listen(srv, port);
    assert.deepEqual(await real.probe(port, 1000), { kind: 'other' });
  }
  // a websocket that never sends a welcome
  {
    const port = await free();
    const wss = new WebSocketServer({ host: '127.0.0.1', port });
    open.push({ close: (cb) => wss.close(cb) });
    await new Promise((r) => wss.once('listening', r));
    const t0 = Date.now();
    assert.deepEqual(await real.probe(port, 400), { kind: 'other' });
    assert.ok(Date.now() - t0 < 1500);
  }
  // an oversized message
  {
    const port = await free();
    const wss = new WebSocketServer({ host: '127.0.0.1', port });
    open.push({ close: (cb) => wss.close(cb) });
    wss.on('connection', (ws) => ws.send(JSON.stringify({ kind: 'welcome', bridgeVersion: '1.0.0', pad: 'x'.repeat(8192) })));
    await new Promise((r) => wss.once('listening', r));
    assert.deepEqual(await real.probe(port, 1000), { kind: 'other' });
  }
  // not JSON / not a welcome
  {
    const port = await free();
    const wss = new WebSocketServer({ host: '127.0.0.1', port });
    open.push({ close: (cb) => wss.close(cb) });
    wss.on('connection', (ws) => ws.send('hello there'));
    await new Promise((r) => wss.once('listening', r));
    assert.deepEqual(await real.probe(port, 1000), { kind: 'other' });
  }
  // nothing listening
  assert.deepEqual(await real.probe(await free(), 1000), { kind: 'closed' });
  // real readText: missing file and oversized file give null
  assert.equal(real.readText(join(here, 'definitely-missing.json'), 100), null);
  assert.equal(real.readText(join(here, 'foreign-detect.mjs'), 10), null);
  assert.ok(real.readText(join(here, 'foreign-detect.mjs'), 10_000_000).includes('foreign-detect'));
  assert.equal(real.pidAlive(process.pid), true);
  for (const s of open) await new Promise((r) => s.close(() => r()));
}

console.log('foreign-detect: ok');
// no handle may keep the process alive
setTimeout(() => { console.error('foreign-detect: a handle is still open'); process.exit(1); }, 4000).unref();
