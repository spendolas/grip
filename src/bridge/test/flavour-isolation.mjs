// Parallel-run and isolation: a build of another flavour carries none of the public
// identity, two bridges of different flavours run side by side in one process and each
// only takes its own plugins, and the two identities share no path or port.
//
// (a) bundles src/index.ts and src/install.ts with the FIXTURE flavour (its flavour.gen.ts
//     generated into a temp dir and resolved in place of ./flavour.gen.js; the real
//     generated file is never touched) and greps the output for the public strings.
//     The whole bundle is checked, bundled dependencies included (they currently carry
//     none of these strings).
// (b) a grip and an acme PluginBridge on free ports, a grip and an acme client on each:
//     only matching pairs register, the others are closed 4409.
// (c) makeIdentity for both flavours: no shared path or port.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { flavourBundler } from './_bundle.mjs';
import { WebSocket } from 'ws';
import { PluginBridge } from '../dist/ws-server.js';
import { makeIdentity } from '../dist/identity.js';
import { FLAVOUR } from '../dist/flavour.gen.js';
delete process.env.GRIP_PAIRING;

const here = dirname(fileURLToPath(import.meta.url));
const bridgeDir = resolve(here, '..');
const repo = resolve(bridgeDir, '..', '..');
const altDir = join(here, 'fixtures', 'flavour-alt');
const alt = JSON.parse(readFileSync(join(altDir, 'flavour.json'), 'utf8'));
const tmp = mkdtempSync(join(tmpdir(), 'flavour-isolation-'));

// ---- (a) bundle with the fixture flavour
const { genFile, bundle } = flavourBundler(altDir, tmp);
assert.match(readFileSync(genFile, 'utf8'), /slug: 'acme'/);

const FORBIDDEN = ['7777', '7778', '.grip-bridge', 'Grip Daemon', 'com.grip.', '1682868744739448629', 'spendolas', '~/.grip'];
const leaks = [];
for (const entry of ['src/index.ts', 'src/install.ts']) {
  const text = await bundle(entry);
  assert.ok(text.includes("slug: \"acme\"") || text.includes("slug: 'acme'"), `${entry}: bundle carries the fixture flavour`);
  const lines = text.split('\n');
  for (const s of FORBIDDEN) {
    lines.forEach((line, i) => { if (line.includes(s)) leaks.push(`${entry} bundle line ${i + 1}: "${s}" in ${line.trim().slice(0, 160)}`); });
  }
}
assert.deepEqual(leaks, [], `public identity strings in an acme build:\n${leaks.join('\n')}`);


// ---- (a3) the foreign watchlist (data) never reaches the plugin, and code never names it
{
  for (const n of ['figma-plugin/ui.html', 'figma-plugin/manifest.json', 'plugin.gen.ts']) {
    const t = readFileSync(join(tmp, n), 'utf8');
    for (const w of ['zenith', 'watchlist', 'enforcement']) assert.ok(!t.includes(w), `${n} has no ${w}`);
  }
  const acmeBundle = await bundle('src/index.ts');
  const stray = acmeBundle.split('\n').filter((l) => (/zenith/i.test(l) || l.includes('7977')) && !l.includes('watchlist: Object.freeze'));
  assert.deepEqual(stray, [], `foreign identity strings outside the watchlist literal:\n${stray.join('\n')}`);
  const pubTmp2 = mkdtempSync(join(tmpdir(), 'flavour-isolation-pub2-'));
  const pubText = await flavourBundler(join(repo, 'flavour'), pubTmp2).bundle('src/index.ts');
  assert.ok(!/zenith/i.test(pubText), 'public bundle has no zenith');
}

// ---- (a2) the rendered plugin UI names the flavour's own home dir, and the MCP server its own name
{
  const ui = readFileSync(join(tmp, 'figma-plugin', 'ui.html'), 'utf8');
  assert.ok(ui.includes('~/.acme/grip-bridge.mjs') || ui.includes('~/.acme'), 'acme ui.html names ~/.acme');
  assert.ok(!ui.includes('~/.grip'), 'acme ui.html has no ~/.grip');
  const pubTmp = mkdtempSync(join(tmpdir(), 'flavour-isolation-pub-'));
  const pubB = flavourBundler(join(repo, 'flavour'), pubTmp);
  assert.ok(readFileSync(join(pubTmp, 'figma-plugin', 'ui.html'), 'utf8').includes('~/.grip'), 'public ui.html keeps ~/.grip');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const freeP = () => new Promise((res) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  for (const [what, b, dir, want] of [['acme', { bundle: bundle }, tmp, 'acme'], ['public', pubB, pubTmp, 'grip']]) {
    const entry = join(dir, `entry-${what}.ts`);
    writeFileSync(entry, `export { PluginBridge } from ${JSON.stringify(join(bridgeDir, 'src', 'ws-server.ts'))};\nexport { createSession, destroySession } from ${JSON.stringify(join(bridgeDir, 'src', 'mcp-server.ts'))};\n`);
    const file = join(dir, `session-${what}.mjs`);
    // the ESM bundle holds CommonJS dependencies (ws), which need a require
    writeFileSync(file, "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);\n" + await b.bundle(relative(bridgeDir, entry)));
    const m = await import(pathToFileURL(file).href);
    const bridge = new m.PluginBridge(await freeP());
    await new Promise((r) => bridge.once('listening', r));
    const live = m.createSession(bridge);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await live.server.connect(st);
    const client = new Client({ name: 't', version: '0' }, { capabilities: {} });
    await client.connect(ct);
    assert.equal(client.getServerVersion().name, want, `${what}: MCP serverInfo.name`);
    await client.close();
    m.destroySession(live);
    bridge.close();
  }
}

// ---- (c) identities share no path or port
{
  const ctx = { env: {}, platform: 'darwin', home: '/h', tmp: '/t' };
  const g = makeIdentity(FLAVOUR, ctx);
  const a = makeIdentity(alt, ctx);
  for (const k of ['wsPort', 'httpPort', 'ipcPath', 'home', 'statusPath', 'logPath', 'exportsDir', 'httpUrl', 'homeLabel']) {
    assert.notEqual(a[k], g[k], `identity ${k} differs`);
  }
  assert.notEqual(a.dumpPath(1), g.dumpPath(1));
  const gv = new Set([g.wsPort, g.httpPort]);
  assert.ok(!gv.has(a.wsPort) && !gv.has(a.httpPort), 'no port shared across flavours');
  const paths = (i) => [i.ipcPath, i.home, i.statusPath, i.logPath, i.exportsDir, i.dumpPath(1)];
  for (const p of paths(a)) assert.ok(!paths(g).includes(p), `no path shared: ${p}`);
  const win = { ...ctx, platform: 'win32' };
  assert.notEqual(makeIdentity(alt, win).ipcPath, makeIdentity(FLAVOUR, win).ipcPath, 'windows pipe differs');
}

// ---- (d) a locked flavour ignores the release-URL and test-key overrides, even in a test run
{
  const THROWAWAY = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEASF7Su4ZqXdmFbDJvwm56w5wBAqqhQ8BcLDwJlGjTneo=\n-----END PUBLIC KEY-----\n';
  const body = (pem) => pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  const env = { GRIP_RELEASES_API: 'http://127.0.0.1:9/x', GRIP_RELEASE_PUBKEY: THROWAWAY, GRIP_TEST: '1' };
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    for (const [what, dir, locked] of [['acme', altDir, true], ['public', join(repo, 'flavour'), false]]) {
      const f = flavourBundler(dir, tmp);
      const file = join(tmp, `update-${what}.mjs`);
      writeFileSync(file, await f.bundle('src/update.ts'));
      const u = await import(pathToFileURL(file).href);
      const keys = u.trustedReleaseKeys().map((k) => body(k.export({ type: 'spki', format: 'pem' })));
      if (locked) {
        assert.equal(u.releasesApi(), alt.releasesApi, 'acme: the override URL is ignored');
        assert.deepEqual(keys, [body(alt.releaseKeys[0])], 'acme: the override key is ignored');
        assert.equal(u.hostAllowed(new URL('http://127.0.0.1:9/x')), false, 'acme: no override origin is allowed');
        // the download pin, end to end through fetchRelease (a fake transport stands in
        // for the network): the locked flavour's own releases URL gives the pin, an asset
        // outside it is dropped, one inside survives (owner/repo compared case-insensitively),
        // and the one stderr line names the dropped asset, never its URL.
        assert.equal(alt.releasesApi, 'https://api.github.com/repos/acme-example/acme/releases/latest');
        const outside = 'https://github.com/someone-else/acme/releases/download/v9.0.0/grip-bridge.mjs';
        let askedFor = null;
        const fakeGet = async (url) => {
          askedFor = url;
          return Buffer.from(JSON.stringify({ tag_name: 'v9.0.0', body: '', assets: [
            { name: 'grip-bridge.mjs', browser_download_url: outside, size: 1 },
            { name: 'compat.json', browser_download_url: 'https://github.com/Acme-Example/ACME/releases/download/v9.0.0/compat.json', size: 1 },
            { name: 'SHA256SUMS.txt', browser_download_url: 'https://github.com/acme-example/acme/releases/download/v9.0.0/SHA256SUMS.txt', size: 1 },
          ] }));
        };
        const lines = [];
        const write = process.stderr.write;
        process.stderr.write = (chunk, ...rest) => { lines.push(String(chunk)); return true; };
        let rel;
        try { rel = await u.fetchRelease(undefined, fakeGet); } finally { process.stderr.write = write; }
        assert.equal(askedFor, alt.releasesApi, 'acme: the release is read from the flavour URL');
        assert.deepEqual(Object.keys(rel.assets).sort(), ['SHA256SUMS.txt', 'compat.json'], 'acme: the asset outside the pin is dropped');
        const dropped = lines.filter((l) => /grip-bridge\.mjs/.test(l));
        assert.equal(dropped.length, 1, `one stderr line names the dropped asset: ${lines.join('')}`);
        assert.ok(!lines.join('').includes('someone-else') && !lines.join('').includes('https://'), 'the URL text never reaches the log');
      } else {
        assert.equal(u.releasesApi(), 'http://127.0.0.1:9/x', 'public: the override URL still applies');
        assert.deepEqual(keys, [body(THROWAWAY)], 'public: the test key still applies');
        assert.equal(u.hostAllowed(new URL('http://127.0.0.1:9/x')), true, 'public: the override origin is allowed');
      }
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

// ---- (b) two bridges in one process
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
async function waitFor(fn, ms = 3000) { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout waiting'); await sleep(20); } }
const sockets = [];
async function client(port, flavour, name) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'null' });
  sockets.push(ws);
  const c = { ws, frames: [], closed: null, reason: '' };
  ws.on('message', (raw) => { c.frames.push(JSON.parse(raw.toString())); });
  ws.on('close', (code, reason) => { c.closed = code; c.reason = reason.toString(); });
  ws.on('error', () => {});
  await new Promise((r) => ws.on('open', r));
  await waitFor(() => c.frames.some((f) => f.kind === 'welcome'));
  ws.send(JSON.stringify({ kind: 'hello', version: '0.9.6', capabilities: [], fileKey: 'KEY-' + name, fileName: name, currentPageId: '0:1', currentPageName: 'P', flavour }));
  return c;
}
const helloed = (bridge, name) => bridge.snapshot().plugins.some((p) => p.fileName === name && p.hello);

const gp = await freePort();
const ap = await freePort();
const grip = new PluginBridge(gp, { flavour: 'grip' });
const acme = new PluginBridge(ap, { flavour: 'acme' });
await Promise.all([grip, acme].map((b) => new Promise((r) => b.once('listening', r))));
assert.ok(gp && ap && gp !== ap, 'two bridges on distinct ports');

const gOnG = await client(gp, 'grip', 'GripOnGrip');
const aOnG = await client(gp, 'acme', 'AcmeOnGrip');
const gOnA = await client(ap, 'grip', 'GripOnAcme');
const aOnA = await client(ap, 'acme', 'AcmeOnAcme');
await waitFor(() => helloed(grip, 'GripOnGrip') && helloed(acme, 'AcmeOnAcme'));
await waitFor(() => aOnG.closed !== null && gOnA.closed !== null);
for (const [c, what] of [[aOnG, 'acme client on grip bridge'], [gOnA, 'grip client on acme bridge']]) {
  assert.equal(c.closed, 4409, `${what}: 4409`);
  assert.equal(c.reason, 'flavour mismatch', `${what}: reason`);
}
assert.ok(!helloed(grip, 'AcmeOnGrip') && !helloed(acme, 'GripOnAcme'), 'mismatched pairs never register');
await sleep(100);
assert.equal(gOnG.closed, null, 'grip client stays on grip bridge');
assert.equal(aOnA.closed, null, 'acme client stays on acme bridge');
assert.deepEqual(grip.snapshot().plugins.filter((p) => p.hello).map((p) => p.fileName), ['GripOnGrip']);
assert.deepEqual(acme.snapshot().plugins.filter((p) => p.hello).map((p) => p.fileName), ['AcmeOnAcme']);

for (const s of sockets) { try { s.close(); } catch {} }
grip.close();
acme.close();
rmSync(tmp, { recursive: true, force: true });
console.log('flavour-isolation.mjs OK');
process.exit(0);
