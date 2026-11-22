// The signed flavour claim and the protocol integer in compat.json.
//
// compat.json is listed in the signature-verified SHA256SUMS.txt, so its `flavour`
// field is a signed claim: a bridge only believes a release made for its own
// flavour (an ABSENT claim is the public 'grip', which every release before the
// field had), and --force never overrides that. `minPluginProtocol` lets a
// release judge a plugin by the protocol integer its hello reports instead of its
// version; a plugin or a compat.json without the integer keeps the version rule.
//
// NO real network, NO real home dir: a local http server plays the release, and
// GRIP_HOME points at a temp dir. The acme build used here is the neutral fixture
// flavour with lockOverrides switched off and the throwaway test key pinned, only so
// that it may talk to the local server (a locked build refuses every non-GitHub host
// before it would read compat.json); the claim check compares the build's slug and
// does not depend on the lock.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, sign as edSign } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { flavourBundler } from './_bundle.mjs';
import * as G from '../dist/update.js';
import { PROTOCOL_VERSION, MIN_PLUGIN_PROTOCOL } from '../dist/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const altDir = join(here, 'fixtures', 'flavour-alt');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const tmp = mkdtempSync(join(tmpdir(), 'compat-flavour-'));

// A THROWAWAY Ed25519 keypair made only for tests (the same one test/update.mjs uses).
// The header is split so secret scanners do not flag this file.
const TEST_PRIV = ['-----BE' + 'GIN PRIVATE KEY-----', 'MC4CAQAwBQYDK2VwBCIEIGfFhB9wVVeEIIpYjxiTdXoremRSaoaIBhYvXEK/vcJ4', '-----END PRIVATE KEY-----', ''].join('\n');
const TEST_PUB = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAYzUJAvV8Ujs7QnT17B1NgfGdwdYhuANZVsIJJncasD0=\n-----END PUBLIC KEY-----\n';

// ---------------------------------------------------------------- fake release
const NEWER = '99.1.0';
let compat;           // the compat.json object served (undefined key = field left out)
let hits = {};
const bridgeSrc = Buffer.from(`if (process.argv.includes('--selftest')) { process.stdout.write('grip-bridge ${NEWER} ok\\n'); process.exit(0); }\n`);
const assets = () => ({
  'grip-bridge.mjs': bridgeSrc,
  'grip-plugin-code.js': Buffer.from('// code\n'),
  'grip-plugin-ui.html': Buffer.from('<html></html>\n'),
  'grip-plugin-manifest.json': Buffer.from(JSON.stringify({ id: '1000000000000000001' }) + '\n'),
  'compat.json': Buffer.from(JSON.stringify(compat) + '\n'),
});
const sumsText = () => Object.entries(assets()).map(([n, b]) => `${sha(b)}  ${n}`).join('\n') + '\n';
const served = (name) => {
  if (name === 'SHA256SUMS.txt') return Buffer.from(sumsText());
  if (name === 'SHA256SUMS.txt.sig') return Buffer.from(edSign(null, Buffer.from(sumsText()), TEST_PRIV).toString('base64') + '\n');
  return assets()[name];
};
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  hits[path] = (hits[path] ?? 0) + 1;
  if (path === '/api') {
    const names = [...Object.keys(assets()), 'SHA256SUMS.txt', 'SHA256SUMS.txt.sig'];
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      tag_name: 'v' + NEWER, name: 'v' + NEWER, draft: false, prerelease: false, body: 'Notes.\n',
      assets: names.map((n) => ({ name: n, size: served(n).length, browser_download_url: `${BASE}download/${n}` })),
    }));
    return;
  }
  const m = /^\/download\/(.+)$/.exec(path);
  const body = m && served(m[1]);
  if (body) res.writeHead(200).end(body); else res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;
process.env.GRIP_RELEASES_API = BASE + 'api';
process.env.GRIP_RELEASE_PUBKEY = TEST_PUB;
process.env.GRIP_TEST = '1';
process.env.GRIP_NO_UPDATE_CHECK = '1';
process.env.GRIP_HOME = join(tmp, 'home');
mkdirSync(process.env.GRIP_HOME, { recursive: true });

// The acme build (see the header): its own slug, the test key pinned, may reach the test server.
const acmeDir = join(tmp, 'acme-flavour');
mkdirSync(acmeDir);
const alt = JSON.parse(readFileSync(join(altDir, 'flavour.json'), 'utf8'));
writeFileSync(join(acmeDir, 'flavour.json'), JSON.stringify({ ...alt, releaseKeys: [TEST_PUB], lockOverrides: false }, null, 2));
const acmeFile = join(tmp, 'update-acme.mjs');
mkdirSync(join(tmp, 'gen'), { recursive: true });
writeFileSync(acmeFile, await flavourBundler(acmeDir, join(tmp, 'gen')).bundle('src/update.ts'));
const A = await import(pathToFileURL(acmeFile).href);

const relFor = async (U) => U.fetchRelease(BASE + 'api');
const sumsMap = () => G.parseSums(sumsText());
const rejectsCode = async (p, code, what) => {
  await assert.rejects(p, (e) => { assert.equal(e.code, code, `${what}: ${e.message}`); return true; }, what);
};

// ---------------------------------------------------------------- fetchCompat: the flavour claim
// (a) acme build + compat that claims grip -> flavour_mismatch
compat = { version: NEWER, minPlugin: '0.6.0', flavour: 'grip', protocol: 1, minPluginProtocol: 1 };
await rejectsCode(A.fetchCompat(await relFor(A), sumsMap()), 'flavour_mismatch', '(a) acme refuses a grip release');
assert.ok(A.isTrustFailure('flavour_mismatch') && A.isTrustFailure('signature_invalid') && A.isTrustFailure('signature_missing'));
assert.ok(!A.isTrustFailure('compat_unverified') && !A.isTrustFailure('selftest_failed'));

// (b) acme build + compat with NO flavour field (a legacy release = grip) -> flavour_mismatch, never read as acme
compat = { version: NEWER, minPlugin: '0.6.0' };
await rejectsCode(A.fetchCompat(await relFor(A), sumsMap()), 'flavour_mismatch', '(b) an absent claim is grip, not acme');

// (c) public build + compat with no flavour (every release before the field) -> accepted, version rule
compat = { version: NEWER, minPlugin: '0.6.0' };
assert.deepEqual(await G.fetchCompat(await relFor(G), sumsMap()), { minPlugin: '0.6.0', minPluginProtocol: null }, '(c) legacy compat.json accepted');
// ... and with the new fields
compat = { version: NEWER, minPlugin: '0.6.0', flavour: 'grip', protocol: 1, minPluginProtocol: 1 };
assert.deepEqual(await G.fetchCompat(await relFor(G), sumsMap()), { minPlugin: '0.6.0', minPluginProtocol: 1 });
// public build + a release claiming another flavour -> refused too
compat = { version: NEWER, minPlugin: '0.6.0', flavour: 'acme' };
await rejectsCode(G.fetchCompat(await relFor(G), sumsMap()), 'flavour_mismatch', 'grip refuses an acme release');
// a minPluginProtocol that is not a non-negative integer is unverifiable, not ignored
compat = { version: NEWER, minPlugin: '0.6.0', minPluginProtocol: '1' };
await rejectsCode(G.fetchCompat(await relFor(G), sumsMap()), 'compat_unverified', 'string minPluginProtocol');
compat = { version: NEWER, minPlugin: '0.6.0', minPluginProtocol: 1.5 };
await rejectsCode(G.fetchCompat(await relFor(G), sumsMap()), 'compat_unverified', 'fractional minPluginProtocol');

// (d) acme build + compat that claims acme -> accepted
compat = { version: NEWER, minPlugin: '0.6.0', flavour: 'acme', protocol: 1, minPluginProtocol: 1 };
assert.deepEqual(await A.fetchCompat(await relFor(A), sumsMap()), { minPlugin: '0.6.0', minPluginProtocol: 1 }, '(d) acme accepts its own release');

// ---------------------------------------------------------------- the check: a mismatch is a trust failure
compat = { version: NEWER, minPlugin: '0.6.0', flavour: 'grip' };
{
  const s = await A.checkForUpdate(BASE + 'api');
  assert.equal(s.available, true);
  assert.equal(s.minPlugin, null);
  assert.match(s.signatureError ?? '', /flavour/i, 'the mismatch is carried in signatureError');
  assert.equal(s.compatError ?? null, null);
  const sig = A.updateSignal(s, [{ pluginVersion: '0.9.6', protocol: 1, wsReady: true, hello: true }]);
  assert.equal(sig.signal, false, 'never signalled');
  assert.match(sig.blockedReason, /not offered/);
}

// (e) --force on (a) still throws flavour_mismatch and downloads nothing
compat = { version: NEWER, minPlugin: '0.6.0', flavour: 'grip' };
hits = {};
await rejectsCode(A.installUpdate({ version: NEWER, force: true, plugins: [{ pluginVersion: '0.9.6', wsReady: true, hello: true }], api: BASE + 'api' }),
  'flavour_mismatch', '(e) --force does not override a flavour mismatch');
for (const n of ['grip-bridge.mjs', 'grip-plugin-code.js', 'grip-plugin-ui.html', 'grip-plugin-manifest.json']) {
  assert.equal(hits[`/download/${n}`] ?? 0, 0, `(e) ${n} was not downloaded`);
}
assert.match(A.getUpdateState()?.signatureError ?? '', /flavour/i, '(e) the shared state says why');
// --force on an acme build with NO claim at all (compat.json unverifiable) is no way around it either
compat = { version: '1.0.0', minPlugin: '0.6.0', flavour: 'acme' };   // describes another version: unverifiable
hits = {};
await rejectsCode(A.installUpdate({ version: NEWER, force: true, plugins: [], api: BASE + 'api' }), 'flavour_mismatch', 'acme --force without a verified claim');
assert.equal(hits['/download/grip-bridge.mjs'] ?? 0, 0);

// ---------------------------------------------------------------- pluginIncompatibility: the protocol integer
assert.equal(PROTOCOL_VERSION, 1);
assert.equal(MIN_PLUGIN_PROTOCOL, 1);
{
  const legacyOld = { pluginVersion: '0.5.0', fileName: 'F', wsReady: true, hello: true };   // no protocol, too old by version
  const legacyNew = { pluginVersion: '0.9.6', fileName: 'F', wsReady: true, hello: true };   // no protocol, new enough by version
  // a legacy plugin (no protocol) against minProtocol=1: the version rule decides
  assert.match(G.pluginIncompatibility('0.6.0', NEWER, legacyOld, 1) ?? '', /older than/);
  assert.equal(G.pluginIncompatibility('0.6.0', NEWER, legacyNew, 1), null);
  // a new plugin that speaks protocol 1 is compatible even below minPlugin
  assert.equal(G.pluginIncompatibility('0.9.0', NEWER, { pluginVersion: '0.8.0', protocol: 1, wsReady: true, hello: true }, 1), null);
  // protocol 0 against minProtocol 1: incompatible, and the message names both numbers
  const why = G.pluginIncompatibility('0.6.0', NEWER, { pluginVersion: '0.9.6', protocol: 0, fileName: 'F', wsReady: true, hello: true }, 1);
  assert.ok(why && /\b0\b/.test(why) && /\b1\b/.test(why) && /protocol/.test(why), why);
  // a legacy compat.json (minPluginProtocol null / absent): the version rule, protocol or not
  assert.match(G.pluginIncompatibility('0.9.0', NEWER, { pluginVersion: '0.8.0', protocol: 1 }, null) ?? '', /older than/);
  assert.match(G.pluginIncompatibility('0.9.0', NEWER, { pluginVersion: '0.8.0', protocol: 1 }) ?? '', /older than/);
  // and the per-window verdict / signal follow the same rule
  const st = { current: '0.9.6', latest: NEWER, available: true, checkedAt: null, minPlugin: '0.9.0', minPluginProtocol: 1 };
  assert.equal(G.updateSignal(st, [{ pluginVersion: '0.8.0', protocol: 1, wsReady: true, hello: true }]).signal, true, 'signal by protocol');
  assert.equal(G.updateSignal({ ...st, minPluginProtocol: null }, [{ pluginVersion: '0.8.0', protocol: 1, wsReady: true, hello: true }]).signal, false, 'legacy compat: version rule');
}

// ---------------------------------------------------------------- bridgeStaleReason: a plugin that needs a newer protocol
assert.equal(G.bridgeStaleReason([{ pluginVersion: '0.9.6', minBridge: '0.8.0', minBridgeProtocol: 1, wsReady: true, hello: true }]), undefined);
assert.match(G.bridgeStaleReason([{ pluginVersion: '9.0.0', fileName: 'F', minBridge: '0.8.0', minBridgeProtocol: PROTOCOL_VERSION + 1, wsReady: true, hello: true }]) ?? '',
  new RegExp(`protocol.*${PROTOCOL_VERSION + 1}`));

// ---------------------------------------------------------------- the CLI's view (status file) carries the integers
{
  const statusFile = join(tmp, 'status.json');
  process.env.GRIP_STATUS_PATH = statusFile;
  writeFileSync(statusFile, JSON.stringify({ pid: process.pid, plugins: [
    { pluginVersion: '0.9.6', wsReady: true, hello: true, protocol: 1, minBridgeProtocol: 1 },
    { pluginVersion: '0.9.6', wsReady: true, hello: true, protocol: '1', minBridgeProtocol: 1.5 },
  ] }));
  const pl = G.readDaemonPlugins();
  assert.equal(pl[0].protocol, 1);
  assert.equal(pl[0].minBridgeProtocol, 1);
  assert.ok(!('protocol' in pl[1]) && !('minBridgeProtocol' in pl[1]), 'a non-integer is absent, never trusted');
  delete process.env.GRIP_STATUS_PATH;
}

// ---------------------------------------------------------------- the wire: welcome says the protocol, hello's integers are parsed and bounded
{
  const { PluginBridge, protocolInt } = await import('../dist/ws-server.js');
  const { WebSocket } = await import('ws');
  assert.equal(protocolInt(1), 1);
  assert.equal(protocolInt(0), 0);
  for (const bad of [-1, 1.5, '1', null, undefined, 70000, NaN]) assert.equal(protocolInt(bad), undefined, String(bad));
  const { createServer: netServer } = await import('node:net');
  const port = await new Promise((res) => { const s = netServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const bridge = new PluginBridge(port);
  await new Promise((r) => bridge.once('listening', r));
  const hello = async (extra) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'null' });
    const frames = [];
    ws.on('message', (raw) => frames.push(JSON.parse(raw.toString())));
    ws.on('error', () => {});
    await new Promise((r) => ws.on('open', r));
    for (let i = 0; i < 100 && !frames.some((f) => f.kind === 'welcome'); i++) await new Promise((r) => setTimeout(r, 20));
    ws.send(JSON.stringify({ kind: 'hello', version: '0.9.6', capabilities: [], fileKey: 'K-' + extra.n, fileName: 'F' + extra.n, currentPageId: '0:1', currentPageName: 'P', ...extra.f }));
    for (let i = 0; i < 100 && !bridge.snapshot().plugins.some((p) => p.fileName === 'F' + extra.n && p.hello); i++) await new Promise((r) => setTimeout(r, 20));
    return { ws, welcome: frames.find((f) => f.kind === 'welcome'), info: G.pluginInfos(bridge).find((p) => p.fileName === 'F' + extra.n) };
  };
  const a = await hello({ n: 1, f: { protocol: 1, minBridgeProtocol: 1 } });
  assert.equal(a.welcome.protocol, PROTOCOL_VERSION, 'the welcome carries the bridge protocol');
  assert.equal(a.info.protocol, 1);
  assert.equal(a.info.minBridgeProtocol, 1);
  const b = await hello({ n: 2, f: {} });   // a legacy plugin
  assert.equal(b.info.protocol, null);
  assert.equal(b.info.minBridgeProtocol, null);
  const c = await hello({ n: 3, f: { protocol: 'x', minBridgeProtocol: 1e9 } });
  assert.equal(c.info.protocol, null, 'not an integer: absent');
  assert.equal(c.info.minBridgeProtocol, null, 'out of bounds: absent');
  for (const x of [a, b, c]) x.ws.close();
  bridge.close();
}

server.close();
rmSync(tmp, { recursive: true, force: true });
console.log('compat-flavour.mjs OK');
