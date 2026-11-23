// The updater and installer carry the plugin payload for a payloadLoader flavour, and that
// flavour switches off the plugin-copy handling that the shell makes pointless. The public
// flavour must behave as before. NO real network, NO real home dir: a local http server plays
// the release.
//
// The loader build here is the acme fixture with lockOverrides off (so it may talk to the local
// server) and the generated flavour file patched to payloadLoader:true; gen-flavour.mjs itself
// refuses that combination for a real flavour, which is exactly what the patch sidesteps.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, sign as edSign } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { flavourBundler } from './_bundle.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const tmp = mkdtempSync(join(tmpdir(), 'payload-update-'));
const TEST_PRIV = ['-----BE' + 'GIN PRIVATE KEY-----', 'MC4CAQAwBQYDK2VwBCIEIGfFhB9wVVeEIIpYjxiTdXoremRSaoaIBhYvXEK/vcJ4', '-----END PRIVATE KEY-----', ''].join('\n');
const TEST_PUB = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAYzUJAvV8Ujs7QnT17B1NgfGdwdYhuANZVsIJJncasD0=\n-----END PUBLIC KEY-----\n';

// ---- fake release (flavour acme)
const NEWER = '99.1.0';
const PAYLOAD = Buffer.from(JSON.stringify({ layout: 1, header: { shellProtocol: 1, flavour: 'acme', version: NEWER }, code: 'var p;', ui: '', sig: 'A'.repeat(86) + '==' }));
let sumsOverride = null;            // replaces the payload's line in SHA256SUMS.txt
let payloadServed = PAYLOAD;        // what the download route returns
let withPayload = true;
const bridgeSrc = Buffer.from(`if (process.argv.includes('--selftest')) { process.stdout.write('grip-bridge ${NEWER} ok\\n'); process.exit(0); }\n`);
const assets = () => ({
  'grip-bridge.mjs': bridgeSrc,
  'grip-plugin-code.js': Buffer.from('// shell code\n'),
  'grip-plugin-ui.html': Buffer.from('<html></html>\n'),
  'grip-plugin-manifest.json': Buffer.from(JSON.stringify({ id: '1000000000000000001' }) + '\n'),
  'compat.json': Buffer.from(JSON.stringify({ version: NEWER, minPlugin: '0.6.0', flavour: 'acme', protocol: 1, minPluginProtocol: 1 }) + '\n'),
  ...(withPayload ? { 'grip-plugin-payload.json': PAYLOAD } : {}),
});
const sumsText = () => Object.entries(assets()).map(([n, b]) => (n === 'grip-plugin-payload.json' && sumsOverride ? sumsOverride : `${sha(b)}  ${n}`)).join('\n') + '\n';
const served = (name) => {
  if (name === 'SHA256SUMS.txt') return Buffer.from(sumsText());
  if (name === 'SHA256SUMS.txt.sig') return Buffer.from(edSign(null, Buffer.from(sumsText()), TEST_PRIV).toString('base64') + '\n');
  if (name === 'grip-plugin-payload.json' && withPayload) return payloadServed;
  return assets()[name];
};
let hits = {};
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
process.env.GRIP_TEST = '1';
process.env.GRIP_NO_UPDATE_CHECK = '';          // (the notice/help code under test must run)
delete process.env.GRIP_NO_UPDATE_CHECK;
process.env.GRIP_RELEASES_API = BASE + 'api';
process.env.GRIP_RELEASE_PUBKEY = TEST_PUB;
process.env.GRIP_FIGMA_SETTINGS = join(tmp, 'no-such-settings.json');

// ---- bundles: loader acme, plain acme (payloadLoader false), public
const altDir = join(here, 'fixtures', 'flavour-alt');
async function bundleUpdate(label, loader) {
  const dir = join(tmp, `flavour-${label}`);
  mkdirSync(dir, { recursive: true });
  const alt = JSON.parse(readFileSync(join(altDir, 'flavour.json'), 'utf8'));
  writeFileSync(join(dir, 'flavour.json'), JSON.stringify({ ...alt, releaseKeys: [TEST_PUB], lockOverrides: false, payloadLoader: false }, null, 2));
  const gen = join(tmp, `gen-${label}`);
  mkdirSync(gen);
  const b = flavourBundler(dir, gen);
  if (loader) writeFileSync(b.genFile, readFileSync(b.genFile, 'utf8').replace('payloadLoader: false', 'payloadLoader: true'));
  const f = join(tmp, `update-${label}.mjs`);
  writeFileSync(f, await b.bundle('src/update.ts'));
  return import(pathToFileURL(f).href);
}
const L = await bundleUpdate('loader', true);
const P = await bundleUpdate('plain', false);                 // acme, not a loader: the updater must never touch a payload
const G = await import('../dist/update.js');                  // the real public build

// ---- asset lists
assert.equal(G.ASSET_PAYLOAD, 'grip-plugin-payload.json');
assert.deepEqual(G.pluginAssets(), G.PLUGIN_ASSETS, 'the public flavour installs exactly the three plugin files');
assert.deepEqual(L.pluginAssets(), { ...L.PLUGIN_ASSETS, 'grip-plugin-payload.json': 'payload.json' });
assert.deepEqual([...G.UPDATE_ASSET_NAMES].sort(), ['SHA256SUMS.txt', 'SHA256SUMS.txt.sig', 'compat.json', 'grip-bridge.mjs', 'grip-plugin-code.js', 'grip-plugin-manifest.json', 'grip-plugin-ui.html']);

const plugins = [{ pluginVersion: '0.9.6', protocol: 1, wsReady: true, hello: true }];
const homeFor = (name) => { const h = join(tmp, name); mkdirSync(h, { recursive: true }); process.env.GRIP_HOME = h; return h; };

// (a) the loader installs the payload byte for byte, verified before anything is written
{
  const home = homeFor('home-a');
  const r = await L.installUpdate({ version: NEWER, plugins, api: BASE + 'api' });
  assert.equal(r.status, 'updated');
  assert.ok(readFileSync(join(home, 'figma-plugin', 'payload.json')).equals(PAYLOAD), 'payload.json is the asset');
  assert.ok(r.pluginFilesWritten.includes('payload.json'));
  assert.ok(existsSync(join(home, 'grip-bridge.mjs')));
}
// a payload whose hash does not match the signed sums: nothing at all is written, not even the bridge
{
  const home = homeFor('home-b');
  payloadServed = Buffer.from(PAYLOAD.toString().replace('var p;', 'var q;'));
  await assert.rejects(L.installUpdate({ version: NEWER, plugins, api: BASE + 'api' }), /sha256|Nothing was changed/);
  assert.deepEqual(readdirSync(home), [], 'nothing written');
  payloadServed = PAYLOAD;
}
// the sums do not list it
{
  const home = homeFor('home-c');
  sumsOverride = `${'0'.repeat(64)}  other-file.txt`;
  await assert.rejects(L.installUpdate({ version: NEWER, plugins, api: BASE + 'api' }), /does not list|Nothing was changed/);
  assert.deepEqual(readdirSync(home), []);
  sumsOverride = null;
}
// a release without the payload asset: a loader flavour cannot install it
{
  const home = homeFor('home-d');
  withPayload = false;
  await assert.rejects(L.installUpdate({ version: NEWER, plugins, api: BASE + 'api' }));
  assert.deepEqual(readdirSync(home), []);
  withPayload = true;
}

// (b) a flavour that is not a loader never asks for the payload and writes none
{
  const home = homeFor('home-e');
  hits = {};
  const r = await P.installUpdate({ version: NEWER, plugins, api: BASE + 'api' });
  assert.equal(r.status, 'updated');
  assert.equal(hits['/download/grip-plugin-payload.json'] ?? 0, 0);
  assert.ok(!existsSync(join(home, 'figma-plugin', 'payload.json')));
}

// (c)(d) the plugin-copy handling: off for a loader, as before otherwise
{
  const home = homeFor('home-f');
  mkdirSync(join(home, 'figma-plugin'), { recursive: true });
  writeFileSync(join(home, 'figma-plugin', 'code.js'), "const PLUGIN_VERSION = '0.9.6';\n");
  const old = [{ pluginVersion: '0.9.0', protocol: 1, fileName: 'F', wsReady: true, hello: true }];
  assert.equal(L.installedPluginVersion(), null, 'a loader flavour has no installed plugin version');
  assert.deepEqual(L.pluginsBehind(old), []);
  assert.deepEqual(L.syncPluginCopies(), { updated: [], skipped: [] });
  assert.deepEqual(L.findPluginCopies(true), { known: false, copies: [] });
  assert.ok(!L.helpNotices(old).some((n) => n.kind === 'plugin'), 'no plugin-behind notice for a loader');
  // the same fixture on the non-loader acme build and on the public build keeps the old behaviour
  for (const [name, U] of [['plain acme', P], ['public', G]]) {
    assert.equal(U.installedPluginVersion(), '0.9.6', `${name}: installed version read`);
    assert.equal(U.pluginsBehind(old).length, 1, `${name}: a window behind is reported`);
    assert.ok(U.helpNotices(old).some((n) => n.kind === 'plugin'), `${name}: the plugin-behind notice stays`);
  }
}

// (e) a shell window is compatible by construction (its payload arrives in the same install)
{
  const shell = { pluginVersion: '0.5.0', protocol: 0, shellProtocol: 1, fileName: 'F', wsReady: true, hello: true };
  const noShell = { pluginVersion: '0.5.0', protocol: 0, fileName: 'F', wsReady: true, hello: true };
  assert.equal(L.pluginIncompatibility('0.6.0', NEWER, shell, 1), null, 'loader: shell window never blocks the offer');
  assert.equal(L.pluginIncompatibility('0.6.0', NEWER, shell, null), null);
  assert.match(L.pluginIncompatibility('0.6.0', NEWER, noShell, 1) ?? '', /protocol/, 'a window that is not a shell is judged as before');
  assert.equal(L.pluginIncompatibility('0.6.0', NEWER, { ...shell, shellProtocol: 0 }, 1) === null, false, 'shellProtocol 0 is not a shell');
  for (const [name, U] of [['plain acme', P], ['public', G]]) {
    assert.notEqual(U.pluginIncompatibility('0.6.0', NEWER, shell, 1), null, `${name}: shellProtocol changes nothing`);
  }
  const st = { current: '0.9.6', latest: NEWER, available: true, checkedAt: null, minPlugin: '0.6.0', minPluginProtocol: 1 };
  assert.equal(L.updateSignal(st, [shell]).signal, true);
}

// (f) pluginInfos carries a bounded shellProtocol
{
  const row = (shellProtocol) => ({ snapshot: () => ({ plugins: [{ sessionId: 's', pluginVersion: '1.0.0', wsReady: true, hello: true, shellProtocol }] }) });
  assert.equal(G.pluginInfos(row(1))[0].shellProtocol, 1);
  assert.equal(G.pluginInfos(row(null))[0].shellProtocol, null);
  assert.equal(G.pluginInfos(row(undefined))[0].shellProtocol, null);
}

// (g) the hello parser (ws-server): a bounded integer, else dropped
{
  const { PluginBridge } = await import('../dist/ws-server.js');
  const { createServer: net } = await import('node:net');
  const { WebSocket } = await import('ws');
  const port = await new Promise((res) => { const s = net().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const bridge = new PluginBridge(port);
  await new Promise((r) => bridge.once('listening', r));
  const open = async (name, shellProtocol) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'null' });
    ws.on('error', () => {});
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ kind: 'hello', version: '0.9.6', capabilities: [], fileKey: 'K' + name, fileName: name, currentPageId: '0:1', currentPageName: 'P', ...(shellProtocol === undefined ? {} : { shellProtocol }) }));
    for (let i = 0; i < 100 && !bridge.snapshot().plugins.some((p) => p.fileName === name && p.hello); i++) await new Promise((r) => setTimeout(r, 20));
    return { ws, row: bridge.snapshot().plugins.find((p) => p.fileName === name) };
  };
  const a = await open('A', 1);
  assert.equal(a.row.shellProtocol, 1);
  const b = await open('B', 'x');
  assert.equal(b.row.shellProtocol, null);
  const c = await open('C', 99999);
  assert.equal(c.row.shellProtocol, null);
  const d = await open('D');
  assert.equal(d.row.shellProtocol, null);
  for (const x of [a, b, c, d]) x.ws.close();
  bridge.close?.();
}

server.close();
console.log('payload-update.mjs OK');
process.exit(0);
