// Self-update tests. NO real network, NO real ~/.grip: a local http server plays
// the GitHub Releases API + release asset downloads, GRIP_HOME points at a temp
// dir, GRIP_STATUS_PATH at a temp file, GRIP_RELEASES_API at the fake API.
import assert from 'node:assert';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { BRIDGE_VERSION, MIN_PLUGIN_VERSION } from '../dist/types.js';
import * as U from '../dist/update.js';
import { createSession } from '../dist/mcp-server.js';
import { PluginBridge, originAllowedForUpdate } from '../dist/ws-server.js';
import { TOOLS } from '../dist/tools.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_JS = join(HERE, '..', 'dist', 'index.js');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => s.replace(/\./g, '\\.');

// ---------------------------------------------------------------- fake release
const NEWER = '99.1.0';
const HEADLINE = 'Self-update, finally.';
const API_PATH = '/repos/spendolas/grip/releases/latest';
let release;     // mutable per test
let hits;        // path -> count
let apiHeaders;  // headers of the last API request
// A bridge the self-test can run: `--selftest` prints `grip-bridge <version> ok`.
const bridgeSrc = (v) => Buffer.from(`// fake bridge ${v}\nif (process.argv.includes('--selftest')) { process.stdout.write('grip-bridge ${v} ok\\n'); process.exit(0); }\n`);
// The plugin windows connected "now": one compatible plugin.
const GOOD = [{ pluginVersion: '0.8.0', fileName: 'Fidelity', wsReady: true, hello: true }];
function freshRelease(over = {}) {
  const bridge = bridgeSrc(over.version ?? NEWER);
  const files = {
    'code.js': Buffer.from('// plugin code\n'),
    'ui.html': Buffer.from('<html>ui</html>\n'),
    'manifest.json': Buffer.from('{"name":"Grip"}\n'),
  };
  release = {
    version: NEWER,
    tag: null,                // override tag_name
    bridge,
    files,
    body: `**${HEADLINE}**\n\n- Ask your agent to update Grip.\n- Or click the arrow in the plugin strip.\n`,
    draft: false,
    prerelease: false,
    bodies: {},               // asset name -> Buffer served instead of the real one (CDN lag / corruption)
    omitAssets: [],           // asset names left out of the release JSON
    assetUrls: {},            // asset name -> browser_download_url override
    sumsRaw: null,            // replace SHA256SUMS.txt entirely
    sumsDrop: [],             // asset names removed from SHA256SUMS.txt
    noSizes: false,           // leave `size` out of the asset JSON
    apiRaw: null,             // replace the API response body entirely
    apiStatus: 200,
    bridgeDelayMs: 0,
    minPlugin: '0.7.0',       // what compat.json says
    compatRaw: null,          // replace compat.json's bytes entirely
    ...over,
  };
  if (!over.bridge) release.bridge = bridgeSrc(release.version);
}
const inst = (over = {}) => U.installUpdate({ version: release.version, plugins: GOOD, ...over });
// release asset name -> the true bytes
function assetBytes(r) {
  return {
    'grip-bridge.mjs': r.bridge,
    'grip-plugin-code.js': r.files['code.js'],
    'grip-plugin-ui.html': r.files['ui.html'],
    'grip-plugin-manifest.json': r.files['manifest.json'],
    'compat.json': r.compatRaw ?? Buffer.from(JSON.stringify({ version: r.version, minPlugin: r.minPlugin }) + '\n'),
  };
}
function sumsText(r) {
  if (r.sumsRaw !== null) return r.sumsRaw;
  return Object.entries(assetBytes(r))
    .filter(([n]) => !r.sumsDrop.includes(n))
    .map(([n, b]) => `${sha(b)}  ${n}`).join('\n') + '\n';
}
function servedBytes(r, name) {
  if (r.bodies[name]) return r.bodies[name];
  if (name === 'SHA256SUMS.txt') return Buffer.from(sumsText(r));
  return assetBytes(r)[name];
}
function apiJson(r) {
  const names = [...Object.keys(assetBytes(r)), 'SHA256SUMS.txt', 'grip-install.zip'];
  return {
    tag_name: r.tag ?? 'v' + r.version,
    name: 'v' + r.version,
    draft: r.draft,
    prerelease: r.prerelease,
    body: r.body,
    assets: names.filter((n) => !r.omitAssets.includes(n)).map((n) => ({
      name: n,
      ...(r.noSizes ? {} : { size: (servedBytes(r, n) ?? Buffer.from('zip')).length }),
      browser_download_url: r.assetUrls[n] ?? `${BASE}download/${n}`,
    })),
  };
}

let otherHits = 0;
const other = createServer((req, res) => { otherHits++; res.writeHead(200).end(release.bridge); });
await new Promise((r) => other.listen(0, '127.0.0.1', r));
const OTHER_PORT = other.address().port;

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  hits[path] = (hits[path] ?? 0) + 1;
  const send = (body, status = 200, headers = {}) => { res.writeHead(status, headers); res.end(body); };
  if (path === API_PATH) {
    apiHeaders = req.headers;
    return send(release.apiRaw ?? JSON.stringify(apiJson(release)), release.apiStatus, { 'content-type': 'application/json' });
  }
  // GitHub-style: /download/<asset> issues ONE redirect to a CDN path on the (allowed) test host.
  if (path.startsWith('/download/')) {
    const name = path.slice('/download/'.length);
    if (name === 'grip-bridge.mjs' && release.bridgeDelayMs) await sleep(release.bridgeDelayMs);
    return send('', 302, { location: `/cdn/${name}` });
  }
  if (path.startsWith('/cdn/')) {
    const body = servedBytes(release, path.slice('/cdn/'.length));
    return body ? send(body) : send('nope', 404);
  }
  if (path === '/redir-off') return send('', 302, { location: `http://127.0.0.1:${OTHER_PORT}/cdn/grip-bridge.mjs` });
  if (path === '/redir-loop') return send('', 302, { location: '/redir-loop' });
  if (path === '/big') return send(Buffer.alloc(6 * 1024 * 1024, 65));
  return send('nope', 404);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;
const API = BASE.slice(0, -1) + API_PATH;

function env(home) {
  process.env.GRIP_RELEASES_API = API;
  process.env.GRIP_HOME = home;
  process.env.GRIP_STATUS_PATH = join(home, 'nostatus.json');
  delete process.env.GRIP_NO_UPDATE_CHECK;
  U.resetUpdateState();
  hits = {};
  otherHits = 0;
}
const snapshotDir = (d) => (existsSync(d) ? readdirSync(d, { recursive: true }).sort().join('|') : '(none)');
const downloads = () => Object.keys(hits).filter((p) => p.startsWith('/download/') || p.startsWith('/cdn/'));

// ---------------------------------------------------------------- 1. pure helpers
assert.ok(U.compareSemver('0.8.0', '0.7.0') > 0);
assert.ok(U.compareSemver('0.7.0', '0.8.0') < 0);
assert.strictEqual(U.compareSemver('1.2.3', '1.2.3'), 0);
assert.ok(U.compareSemver('0.10.0', '0.9.0') > 0, 'numeric, not lexicographic');
assert.ok(U.compareSemver('1.0.0', '0.99.99') > 0);
assert.ok(U.compareSemver('0.8.0-beta', '0.8.0') < 0, 'prerelease sorts below the release');
assert.strictEqual(U.compareSemver('garbage', '1.0.0'), 0, 'unparseable never claims an update');

// API URL rules
assert.ok(U.normalizeUrl('https://example.com/x'), 'https ok');
assert.ok(U.normalizeUrl('http://127.0.0.1:1234/a/b')?.endsWith('/a/b'), 'http loopback ok, path kept');
assert.ok(U.normalizeUrl('http://localhost:1/'), 'http localhost ok');
assert.strictEqual(U.normalizeUrl('http://example.com/'), null, 'plain http to a real host refused');
assert.strictEqual(U.normalizeUrl('ftp://example.com/'), null);
assert.strictEqual(U.normalizeUrl('https://u:p@example.com/'), null, 'credentials refused');
assert.strictEqual(U.DEFAULT_RELEASES_API, 'https://api.github.com/repos/spendolas/grip/releases/latest');

// download host allowlist (no override set here)
{
  const saved = process.env.GRIP_RELEASES_API;
  delete process.env.GRIP_RELEASES_API;
  const ok = (u) => U.hostAllowed(new URL(u));
  assert.ok(ok('https://github.com/spendolas/grip/releases/download/v1.0.0/grip-bridge.mjs'));
  assert.ok(ok('https://api.github.com/repos/spendolas/grip/releases/latest'));
  assert.ok(ok('https://release-assets.githubusercontent.com/github-production-release-asset/x'));
  assert.ok(ok('https://objects.githubusercontent.com/x'));
  assert.ok(!ok('http://github.com/x'), 'http refused');
  assert.ok(!ok('https://github.com:8443/x'), 'odd port refused');
  assert.ok(!ok('https://evil.example/x'));
  assert.ok(!ok('https://githubusercontent.com.evil.example/x'), 'suffix tricks refused');
  assert.ok(!ok('https://evilgithubusercontent.com/x'), 'must be a real subdomain');
  assert.ok(!ok('https://u:p@github.com/x'));
  assert.ok(!ok(`http://127.0.0.1:${OTHER_PORT}/x`), 'loopback is NOT allowed without the override');
  process.env.GRIP_RELEASES_API = API;
  assert.ok(ok(`${BASE}download/x`), 'the override host is allowed');
  assert.ok(!ok(`http://127.0.0.1:${OTHER_PORT}/x`), 'only the override origin, not any loopback');
  process.env.GRIP_RELEASES_API = saved ?? '';
  if (!saved) delete process.env.GRIP_RELEASES_API;
}

// SHA256SUMS parsing
{
  const a = 'a'.repeat(64), b = 'B'.repeat(64);
  const m = U.parseSums(`${a}  one.txt\n${b} *two.txt\nnot a line\n\n`);
  assert.deepStrictEqual([...m.entries()], [['one.txt', a], ['two.txt', 'b'.repeat(64)]]);
  assert.throws(() => U.parseSums(`${a}  x\n${'c'.repeat(64)}  x\n`), /twice/);
  assert.strictEqual(U.parseSums('').size, 0);
}

// release notes / headline
assert.strictEqual(U.releaseHeadline('**A smoother install.**\n\n- one'), 'A smoother install.');
assert.strictEqual(U.releaseHeadline('\n\n## v0.9 [Big](https://x.y) `thing`\nmore'), 'v0.9 Big thing');
assert.strictEqual(U.releaseHeadline('- __bold__ bullet'), 'bold bullet');
assert.strictEqual(U.releaseHeadline(''), '');
assert.strictEqual(U.releaseHeadline(null), '');
assert.ok(U.releaseHeadline('x'.repeat(500)).length <= 160, 'headline is length-capped');
assert.ok(!U.releaseHeadline('line\nsecond').includes('\n'), 'headline is one line');
assert.strictEqual(U.releaseNotes('short'), 'short');
{
  const long = Array.from({ length: 200 }, (_, i) => `- bullet number ${i}`).join('\n');
  const n = U.releaseNotes(long);
  assert.ok(n.length <= 1210 && n.length > 1000, `notes capped near 1200 chars (${n.length})`);
  assert.ok(n.endsWith('…'), 'truncation marked');
  assert.strictEqual(U.releaseNotes(undefined), '');
}

// release-page install footer: cut from the marker on, in notes AND headline
{
  const footer = `${U.INSTALL_MARKER}\n**Install:** tell your agent \`Install Grip from https://github.com/spendolas/grip/releases/latest\``;
  const body = `**Real headline.**\n\n- one\n- two\n\n${footer}\n`;
  assert.strictEqual(U.INSTALL_MARKER, '<!-- grip-install -->');
  assert.strictEqual(U.releaseNotes(body), '**Real headline.**\n\n- one\n- two', 'footer cut from the notes');
  assert.ok(!U.releaseNotes(body).includes('Install Grip'), 'no install text in notes');
  assert.strictEqual(U.releaseHeadline(body), 'Real headline.');
  // a body that is ONLY the footer has no headline and no notes (never the install pointer)
  assert.strictEqual(U.releaseHeadline(footer), '');
  assert.strictEqual(U.releaseNotes(footer), '');
  assert.strictEqual(U.releaseHeadline(`\n\n${footer}`), '', 'headline never falls through to the footer');
  // the marker is cut BEFORE the length cap, so a long body still ends at its notes
  assert.ok(!U.releaseNotes('x '.repeat(400) + '\n' + footer).includes('grip-install'));
  // no marker: untouched
  assert.strictEqual(U.releaseNotes('plain'), 'plain');
  assert.strictEqual(U.stripInstallFooter('a\nb'), 'a\nb');
}

// compat: the pure signal rule (updateSignal) and the plugin verdict
{
  const st = (o = {}) => ({ current: BRIDGE_VERSION, latest: '0.9.0', available: true, checkedAt: 'x', minPlugin: '0.8.0', ...o });
  const pl = (v, file = 'F', o = {}) => ({ pluginVersion: v, fileName: file, wsReady: true, hello: true, ...o });
  // compatible
  assert.deepStrictEqual(U.updateSignal(st(), [pl('0.8.0')]), { signal: true });
  assert.deepStrictEqual(U.updateSignal(st(), [pl('0.9.0')]), { signal: true }, 'a newer plugin is fine');
  assert.strictEqual(U.updateSignal(st(), [pl('0.8.0'), pl('1.2.0', 'G')]).signal, true, 'every plugin new enough');
  // plugin too old: the exact message the owner specified
  const old = U.updateSignal(st(), [pl('0.6.0', 'Fidelity')]);
  assert.strictEqual(old.signal, false);
  assert.strictEqual(old.blockedReason, 'plugin 0.6.0 in "Fidelity" is older than 0.9.0 requires (>=0.8.0); update the Grip plugin in Figma first');
  // unknown / missing / garbage version = incompatible
  for (const v of ['unknown', undefined, null, '', 'soon']) {
    const r = U.updateSignal(st(), [pl(v, 'F')]);
    assert.strictEqual(r.signal, false, `version ${JSON.stringify(v)} blocks`);
    assert.match(r.blockedReason, /did not report a version/);
  }
  // one of two plugins incompatible blocks (an update replaces the bridge for ALL windows)
  const mixed = U.updateSignal(st(), [pl('0.8.0', 'Good'), pl('0.7.0', 'Old')]);
  assert.strictEqual(mixed.signal, false);
  assert.match(mixed.blockedReason, /plugin 0\.7\.0 in "Old"/);
  // no plugin connected: not signalled, says why
  for (const none of [[], null, undefined]) {
    const r = U.updateSignal(st(), none);
    assert.strictEqual(r.signal, false);
    assert.match(r.blockedReason, /no Grip plugin is connected/);
  }
  // a socket that has not said hello yet / is not ready is not counted either way
  assert.strictEqual(U.updateSignal(st(), [pl('0.8.0'), pl(undefined, 'new', { hello: false })]).signal, true, 'pre-hello socket does not block');
  assert.strictEqual(U.updateSignal(st(), [pl('0.6.0', 'x', { wsReady: false })]).signal, false, 'only a dead socket: nothing to verify against');
  // not available -> nothing to signal and nothing to explain
  assert.deepStrictEqual(U.updateSignal(st({ available: false }), [pl('0.8.0')]), { signal: false });
  assert.deepStrictEqual(U.updateSignal(null, [pl('0.8.0')]), { signal: false });
  // fail closed: no (verified) compat info
  for (const o of [{ minPlugin: null }, { minPlugin: undefined }]) {
    const r = U.updateSignal(st(o), [pl('0.9.0')]);
    assert.strictEqual(r.signal, false);
    assert.match(r.blockedReason, /no verified compatibility info/);
  }
  assert.match(U.updateSignal(st({ minPlugin: null, compatError: 'it does not match SHA256SUMS.txt' }), [pl('9.9.9')]).blockedReason, /does not match SHA256SUMS/);
  // prerelease plugin sorts below the release
  assert.strictEqual(U.updateSignal(st(), [pl('0.8.0-beta')]).signal, false);

  // reverse direction (informational): a plugin that needs a NEWER bridge
  assert.match(U.bridgeStaleReason([pl('0.9.0', 'Fidelity', { minBridge: '0.9.0' })]), /needs Grip bridge >= 0\.9\.0 but this bridge is 0\.8\.0/);
  assert.strictEqual(U.bridgeStaleReason([pl('0.8.0', 'F', { minBridge: '0.7.0' })]), undefined);
  assert.strictEqual(U.bridgeStaleReason([pl('0.8.0')]), undefined, 'older plugins without minBridge say nothing');
  assert.ok(MIN_PLUGIN_VERSION && /^\d+\.\d+\.\d+$/.test(MIN_PLUGIN_VERSION));
}

// install source detection
{
  const root = tmp('grip-src-');
  mkdirSync(join(root, 'clone', '.git'), { recursive: true });
  mkdirSync(join(root, 'clone', 'bridge'), { recursive: true });
  assert.strictEqual(U.detectInstallSource(join(root, 'clone', 'bridge')), 'clone', '.git directory above');
  mkdirSync(join(root, 'worktree', 'bridge'), { recursive: true });
  writeFileSync(join(root, 'worktree', '.git'), 'gitdir: /elsewhere\n');
  assert.strictEqual(U.detectInstallSource(join(root, 'worktree', 'bridge')), 'clone', '.git file (worktree) counts too');
  mkdirSync(join(root, 'zip', 'grip', 'bridge'), { recursive: true });
  mkdirSync(join(root, 'zip', 'grip', 'figma-plugin'), { recursive: true });
  assert.strictEqual(U.detectInstallSource(join(root, 'zip', 'grip', 'bridge')), 'release', 'extracted zip layout, no work tree');
}

// ---------------------------------------------------------------- 2. check
{
  const home = tmp('grip-upd-home-');
  env(home);
  freshRelease();
  const changes = [];
  const off = U.onUpdateState((s) => changes.push(s));
  const s = await U.checkForUpdate();
  assert.deepStrictEqual([s.current, s.latest, s.available], [BRIDGE_VERSION, NEWER, true]);
  assert.ok(s.checkedAt && !Number.isNaN(Date.parse(s.checkedAt)));
  assert.strictEqual(s.headline, HEADLINE, 'headline from the release body');
  assert.match(s.notes, /Ask your agent to update Grip/, 'notes from the release body');
  assert.strictEqual(s.minPlugin, '0.7.0', 'minPlugin comes from the verified compat.json');
  assert.strictEqual(s.compatError, null);
  assert.strictEqual(U.getUpdateState().available, true, 'cached in memory');
  assert.strictEqual(changes.length, 1, 'listener fired on change');
  await U.checkForUpdate();
  assert.strictEqual(changes.length, 1, 'no change, no event');
  const cache = JSON.parse(readFileSync(join(home, 'update-check.json'), 'utf8'));
  assert.strictEqual(cache.latest, NEWER, 'cached on disk');
  assert.strictEqual(cache.headline, HEADLINE, 'headline cached on disk');
  assert.strictEqual(cache.minPlugin, '0.7.0', 'minPlugin cached on disk');
  assert.strictEqual(U.readCache().minPlugin, '0.7.0');
  assert.strictEqual(U.readCache().headline, HEADLINE);
  off();

  // the request: GitHub accept header, generic UA, nothing identifying
  assert.strictEqual(apiHeaders.accept, 'application/vnd.github+json');
  assert.strictEqual(apiHeaders['user-agent'], `grip-bridge/${BRIDGE_VERSION}`);
  for (const h of ['authorization', 'cookie', 'from', 'x-forwarded-for', 'referer']) {
    assert.ok(!(h in apiHeaders), `no ${h} header sent`);
  }
  assert.deepStrictEqual(Object.keys(apiHeaders).sort(), ['accept', 'connection', 'host', 'user-agent'], 'only the four expected headers');

  // the release body's install footer never reaches the notices
  freshRelease({ body: `**${HEADLINE}**\n\n- one\n\n<!-- grip-install -->\n**Install:** tell your agent \`Install Grip from https://github.com/spendolas/grip/releases/latest\`\n` });
  {
    const f = await U.checkForUpdate();
    assert.strictEqual(f.headline, HEADLINE);
    assert.ok(!/Install Grip|grip-install/.test(f.notes), `footer cut from notes: ${f.notes}`);
  }
  freshRelease();

  // v-prefix is stripped; a bare tag works too
  freshRelease({ tag: NEWER });
  assert.strictEqual((await U.checkForUpdate()).latest, NEWER);

  // compat gate (fail closed): the check still reports the truth (available:true)
  // but minPlugin is null + compatError says why, and the signal is withheld
  const gate = async (over, mutate, why) => {
    U.resetUpdateState();
    freshRelease(over);
    mutate?.();
    const g = await U.checkForUpdate();
    assert.strictEqual(g.available, true, `${why}: still reported as available`);
    assert.strictEqual(g.minPlugin, null, `${why}: no minPlugin`);
    assert.ok(g.compatError, `${why}: reason recorded`);
    assert.strictEqual(U.updateSignal(g, GOOD).signal, false, `${why}: not signalled`);
    assert.match(U.updateSignal(g, GOOD).blockedReason, /no verified compatibility info/);
    return g;
  };
  assert.match((await gate({ omitAssets: ['compat.json'] }, null, 'no compat.json asset')).compatError, /no such asset/);
  assert.match((await gate({ sumsDrop: ['compat.json'] }, null, 'compat.json not in the sums')).compatError, /does not list it/);
  assert.match((await gate({}, () => { release.bodies['compat.json'] = Buffer.from(JSON.stringify({ version: NEWER, minPlugin: '0.1.0' }) + ' '); }, 'tampered compat.json')).compatError, /does not match SHA256SUMS/);
  assert.match((await gate({ compatRaw: Buffer.from('not json') }, null, 'garbage compat.json')).compatError, /not valid JSON/);
  assert.match((await gate({ compatRaw: Buffer.from(JSON.stringify({ version: '1.0.0', minPlugin: '0.7.0' })) }, null, 'compat.json for another version')).compatError, /describes version 1\.0\.0/);
  assert.match((await gate({ minPlugin: 'soon' }, null, 'bad minPlugin')).compatError, /minPlugin is not a version/);
  assert.match((await gate({ minPlugin: '100.0.0' }, null, 'minPlugin above the release')).compatError, /newer than the release/);
  assert.match((await gate({ omitAssets: ['SHA256SUMS.txt'] }, null, 'no sums at all')).compatError, /no SHA256SUMS\.txt asset/);
  assert.match((await gate({ assetUrls: { 'compat.json': 'https://evil.example/compat.json' } }, null, 'compat.json from a foreign host')).compatError, /not an allowed update host/);
  {
    // big compat.json is capped (4KB)
    const huge = Buffer.from(JSON.stringify({ version: NEWER, minPlugin: '0.7.0', pad: 'x'.repeat(8000) }));
    assert.match((await gate({ compatRaw: huge }, null, 'oversized compat.json')).compatError, /too large/);
  }
  // an unsigned compat state is cached as minPlugin:null (never as a stale value)
  assert.strictEqual(U.readCache().minPlugin, null);
  // a good release re-opens the gate
  U.resetUpdateState();
  freshRelease();
  assert.strictEqual((await U.checkForUpdate()).minPlugin, '0.7.0');
  // compat.json is only fetched when there is something newer
  freshRelease({ version: BRIDGE_VERSION });
  hits = {};
  await U.checkForUpdate();
  assert.ok(!hits['/download/compat.json'], 'no compat fetch when up to date');

  // not available
  freshRelease({ version: BRIDGE_VERSION });
  const same = await U.checkForUpdate();
  assert.strictEqual(same.available, false);
  freshRelease({ version: '0.0.1' });
  assert.strictEqual((await U.checkForUpdate()).available, false, 'older remote is not an update');

  // cache re-evaluated against the CURRENT version after a restart
  U.resetUpdateState();
  writeFileSync(join(home, 'update-check.json'), JSON.stringify({ latest: BRIDGE_VERSION, checkedAt: 'x', available: true }));
  assert.strictEqual(U.readCache().available, false, 'stale cached "available" is recomputed');

  // network failure: silent, never throws, keeps the previous answer
  freshRelease();
  await U.checkForUpdate();
  process.env.GRIP_RELEASES_API = 'http://127.0.0.1:1/x';
  const failed = await U.checkForUpdate();
  assert.ok(failed.error, 'failure reported in the result, not thrown');
  assert.strictEqual(failed.available, true, 'previous state carried over');
  assert.strictEqual(failed.headline, HEADLINE, 'previous headline carried over');
  process.env.GRIP_RELEASES_API = API;

  // bad API answers
  freshRelease({ apiRaw: 'x'.repeat(300 * 1024) });
  assert.match((await U.checkForUpdate()).error, /too large/);
  freshRelease({ apiRaw: 'not json' });
  assert.match((await U.checkForUpdate()).error, /valid JSON/);
  freshRelease({ apiStatus: 404, apiRaw: '{"message":"Not Found"}' });
  assert.match((await U.checkForUpdate()).error, /HTTP 404/);
  freshRelease({ apiStatus: 403, apiRaw: '{"message":"rate limit"}' });
  assert.match((await U.checkForUpdate()).error, /rate limit/i);
  freshRelease({ draft: true });
  assert.match((await U.checkForUpdate()).error, /draft or prerelease/, 'drafts ignored');
  freshRelease({ prerelease: true });
  assert.match((await U.checkForUpdate()).error, /draft or prerelease/, 'prereleases ignored');
  freshRelease({ tag: 'nightly' });
  assert.match((await U.checkForUpdate()).error, /valid version tag/);
  freshRelease({ apiRaw: JSON.stringify({ tag_name: 'v1.0.0', assets: 'nope', body: null }) });
  const odd = await U.checkForUpdate();
  assert.ok(!odd.error && odd.latest === '1.0.0' && odd.headline === null, 'tolerates a null body and odd assets for a plain check');
}

// ---------------------------------------------------------------- 3. install
{
  const home = tmp('grip-upd-home-');
  env(home);
  freshRelease();
  writeFileSync(join(home, 'grip-bridge.mjs'), 'OLD BRIDGE');
  const r = await inst();
  assert.strictEqual(r.status, 'updated');
  assert.deepStrictEqual([r.from, r.to], [BRIDGE_VERSION, NEWER]);
  assert.strictEqual(readFileSync(join(home, 'grip-bridge.mjs'), 'utf8'), release.bridge.toString(), 'bridge installed');
  assert.strictEqual(readFileSync(join(home, 'grip-bridge.prev.mjs'), 'utf8'), 'OLD BRIDGE', 'previous kept for rollback');
  for (const [n, b] of Object.entries(release.files)) {
    assert.strictEqual(readFileSync(join(home, 'figma-plugin', n)).toString(), b.toString(), `plugin file ${n}`);
  }
  assert.deepStrictEqual(readdirSync(join(home, 'figma-plugin')).sort(), ['code.js', 'manifest.json', 'ui.html']);
  assert.deepStrictEqual(JSON.parse(readFileSync(join(home, 'install.json'), 'utf8')), { source: 'release', version: NEWER }, 'install.json recorded');
  assert.strictEqual(U.readInstallRecord().source, 'release');
  if (process.platform !== 'win32') assert.ok(statSync(join(home, 'grip-bridge.mjs')).mode & 0o100, 'bridge is executable');
  assert.ok(!snapshotDir(home).includes('.tmp-'), 'no temp files left behind');
  const written = readdirSync(home).sort();
  assert.ok(written.every((n) => ['figma-plugin', 'grip-bridge.mjs', 'grip-bridge.prev.mjs', 'install.json', 'update-check.json'].includes(n)), `only expected entries in GRIP_HOME: ${written}`);
  // every asset came through the GitHub-style redirect, once
  assert.deepStrictEqual(
    downloads().filter((p) => p.startsWith('/download/')).sort(),
    ['/download/SHA256SUMS.txt', '/download/compat.json', '/download/grip-bridge.mjs', '/download/grip-plugin-code.js', '/download/grip-plugin-manifest.json', '/download/grip-plugin-ui.html'].sort(),
    'exactly the six assets the updater needs (not the install zip or installer)');
  assert.strictEqual(hits['/cdn/grip-bridge.mjs'], 1, 'redirect followed');

  // rollback restores the previous bridge
  U.rollbackBridge();
  assert.strictEqual(readFileSync(join(home, 'grip-bridge.mjs'), 'utf8'), 'OLD BRIDGE', 'rollback restored it');
  assert.throws(() => { process.env.GRIP_HOME = tmp('grip-empty-'); U.rollbackBridge(); }, /no previous version/);

  // up to date: nothing is downloaded or written
  const home2 = tmp('grip-upd-home-');
  env(home2);
  freshRelease({ version: BRIDGE_VERSION });
  const same = await inst();
  assert.strictEqual(same.status, 'up_to_date');
  assert.deepStrictEqual(downloads(), [], 'no download when up to date');
  assert.strictEqual(snapshotDir(home2), '', 'nothing written');
}

// verification failures abort and leave everything untouched
{
  const home = tmp('grip-upd-home-');
  env(home);
  freshRelease();
  writeFileSync(join(home, 'grip-bridge.mjs'), 'OLD BRIDGE');
  mkdirSync(join(home, 'figma-plugin'));
  writeFileSync(join(home, 'figma-plugin', 'code.js'), 'OLD PLUGIN');
  const before = snapshotDir(home);
  const untouched = (why) => {
    assert.strictEqual(snapshotDir(home), before, `${why}: no files added`);
    assert.strictEqual(readFileSync(join(home, 'grip-bridge.mjs'), 'utf8'), 'OLD BRIDGE', `${why}: bridge untouched`);
    assert.strictEqual(readFileSync(join(home, 'figma-plugin', 'code.js'), 'utf8'), 'OLD PLUGIN', `${why}: plugin untouched`);
  };

  // different length (CDN lag): caught by the size the release declares
  release.bodies['grip-bridge.mjs'] = Buffer.from('// tampered bridge ' + NEWER + '\n');
  await assert.rejects(inst(), /sha256|SHA256SUMS|size mismatch/);
  untouched('tampered bridge');
  await assert.rejects(inst(), /retry in a few minutes/, 'error tells the user to retry later');

  // same length, no declared size: caught by SHA256SUMS.txt alone
  freshRelease({ noSizes: true });
  release.bodies['grip-bridge.mjs'] = Buffer.from(release.bridge.toString().replace('fake', 'evil'));
  assert.strictEqual(release.bodies['grip-bridge.mjs'].length, release.bridge.length);
  await assert.rejects(inst(), /failed its sha256 check against SHA256SUMS\.txt/);
  untouched('same-length tamper');

  // a bad PLUGIN file also aborts before the (good) bridge is written
  freshRelease({ noSizes: true });
  release.bodies['grip-plugin-ui.html'] = Buffer.from('<html>tampered</html>');
  await assert.rejects(inst(), /grip-plugin-ui\.html/);
  untouched('tampered plugin file');

  // a file missing from SHA256SUMS.txt aborts (every file must be listed AND match)
  for (const name of ['grip-bridge.mjs', 'grip-plugin-code.js', 'grip-plugin-ui.html', 'grip-plugin-manifest.json']) {
    freshRelease({ sumsDrop: [name] });
    await assert.rejects(inst(), new RegExp(`does not list ${esc(name)}`), `missing sums line for ${name}`);
    untouched(`sums without ${name}`);
  }
  // SHA256SUMS.txt that is empty / garbage / wrong hash
  freshRelease({ sumsRaw: '' });
  await assert.rejects(inst(), /does not list/);
  freshRelease({ sumsRaw: Object.keys(assetBytes(release)).map((n) => `${'0'.repeat(64)}  ${n}`).join('\n') });
  await assert.rejects(inst(), /sha256|SHA256SUMS|size mismatch/);
  untouched('wrong sums');

  // an asset (or SHA256SUMS.txt) not on the release at all
  freshRelease({ omitAssets: ['SHA256SUMS.txt'] });
  await assert.rejects(inst(), /no SHA256SUMS\.txt asset/);
  freshRelease({ omitAssets: ['grip-plugin-code.js'] });
  await assert.rejects(inst(), /no grip-plugin-code\.js asset/);
  untouched('missing asset');
  // asset listed but the download 404s
  freshRelease({ assetUrls: { 'grip-bridge.mjs': `${BASE}nope` } });
  await assert.rejects(inst(), /could not download grip-bridge\.mjs/);
  untouched('404 asset');
}

// redirects: GitHub-style hop ok, off-host refused, loops capped; size cap
{
  const home = tmp('grip-upd-home-');
  env(home);
  freshRelease();
  assert.strictEqual((await inst()).status, 'updated', 'redirect to another path on the allowed host followed');

  // redirect to a disallowed host: refused, that host never contacted
  const home2 = tmp('grip-upd-home-');
  env(home2);
  freshRelease({ assetUrls: { 'grip-bridge.mjs': `${BASE}redir-off` } });
  await assert.rejects(inst(), /not an allowed update host/);
  assert.strictEqual(otherHits, 0, 'the disallowed host was never contacted');
  assert.strictEqual(snapshotDir(home2), '');

  // the FIRST url is checked too (a release JSON pointing straight at another host)
  freshRelease({ assetUrls: { 'grip-bridge.mjs': `http://127.0.0.1:${OTHER_PORT}/x` } });
  await assert.rejects(inst(), /not an allowed update host/);
  freshRelease({ assetUrls: { 'grip-bridge.mjs': 'https://evil.example/grip-bridge.mjs' } });
  await assert.rejects(inst(), /not an allowed update host/);
  freshRelease({ assetUrls: { 'grip-bridge.mjs': 'http://github.com/spendolas/grip/x' } });
  await assert.rejects(inst(), /not an allowed update host/, 'plain http to github.com refused');
  assert.strictEqual(otherHits, 0);

  freshRelease({ assetUrls: { 'grip-bridge.mjs': `${BASE}redir-loop` } });
  await assert.rejects(inst(), /too many redirects/);

  freshRelease({ assetUrls: { 'grip-bridge.mjs': `${BASE}big` } });
  await assert.rejects(inst(), /too large/);
  assert.strictEqual(snapshotDir(home2), '', 'oversized download wrote nothing');
}

// concurrency: a second install while one runs is refused
{
  const home = tmp('grip-upd-home-');
  env(home);
  freshRelease({ bridgeDelayMs: 300 });
  const first = inst();
  await sleep(50);
  assert.strictEqual((await inst()).status, 'already_installing');
  assert.strictEqual((await first).status, 'updated');
}

// clone installs are never overwritten (git pull is the update path)
{
  const home = tmp('grip-upd-home-');
  env(home);
  freshRelease();
  assert.strictEqual(U.readInstallRecord().source, 'release', 'no install.json (pre-0.8) counts as a release install');
  writeFileSync(join(home, 'install.json'), JSON.stringify({ source: 'clone', version: BRIDGE_VERSION }));
  writeFileSync(join(home, 'grip-bridge.mjs'), 'CLONE BRIDGE');
  assert.strictEqual(U.readInstallRecord().source, 'clone');
  const before = snapshotDir(home);
  const r = await inst();
  assert.strictEqual(r.status, 'clone_install');
  assert.deepStrictEqual(r.next, ['git pull', 'npm run build', 'node bridge/install.mjs']);
  assert.deepStrictEqual([r.from, r.to], [BRIDGE_VERSION, NEWER]);
  assert.strictEqual(readFileSync(join(home, 'grip-bridge.mjs'), 'utf8'), 'CLONE BRIDGE', 'clone install not overwritten');
  assert.strictEqual(snapshotDir(home), before, 'nothing written');
  assert.deepStrictEqual(downloads(), [], 'nothing downloaded for a clone install');
  // check still reports availability
  const s = await U.checkForUpdate();
  assert.strictEqual(s.available, true, 'check still reports the update');
  // up to date wins over clone_install
  freshRelease({ version: BRIDGE_VERSION });
  assert.strictEqual((await inst()).status, 'up_to_date');
  // force (CLI only) overrides, and the record flips to release
  freshRelease();
  const f = await inst({ force: true });
  assert.strictEqual(f.status, 'updated');
  assert.strictEqual(readFileSync(join(home, 'grip-bridge.mjs'), 'utf8'), release.bridge.toString());
  assert.deepStrictEqual(JSON.parse(readFileSync(join(home, 'install.json'), 'utf8')), { source: 'release', version: NEWER });
  // garbage install.json is treated as release
  writeFileSync(join(home, 'install.json'), '{nope');
  assert.strictEqual(U.readInstallRecord().source, 'release');
}

// ---------------------------------------------------------------- 3b. install-time rules: pin, compat, self-test, consent
{
  const fresh = (over = {}) => {
    const home = tmp('grip-upd-home-');
    env(home);
    freshRelease(over);
    writeFileSync(join(home, 'grip-bridge.mjs'), 'OLD BRIDGE');
    mkdirSync(join(home, 'figma-plugin'));
    writeFileSync(join(home, 'figma-plugin', 'code.js'), 'OLD PLUGIN');
    return { home, before: snapshotDir(home) };
  };
  const untouched = (h, why) => {
    assert.strictEqual(snapshotDir(h.home), h.before, `${why}: nothing added or removed`);
    assert.strictEqual(readFileSync(join(h.home, 'grip-bridge.mjs'), 'utf8'), 'OLD BRIDGE', `${why}: bridge untouched`);
    assert.strictEqual(readFileSync(join(h.home, 'figma-plugin', 'code.js'), 'utf8'), 'OLD PLUGIN', `${why}: plugin untouched`);
  };
  const noPayload = (why) => assert.ok(!hits['/download/grip-bridge.mjs'] && !hits['/download/grip-plugin-code.js'], `${why}: the bridge/plugin files were never downloaded`);

  // --- the version pin: the user must have been shown THIS version
  {
    const h = fresh();
    const r = await inst({ version: '99.0.5' });
    assert.strictEqual(r.status, 'version_changed');
    assert.deepStrictEqual([r.from, r.to, r.headline], [BRIDGE_VERSION, NEWER, HEADLINE]);
    assert.match(r.notes, /Ask your agent to update Grip/, "the new version's notes come back so the user can review it");
    untouched(h, 'version_changed'); noPayload('version_changed');
    assert.strictEqual(U.getUpdateState().latest, NEWER, 'shared state refreshed to the real latest');
    assert.strictEqual(U.getUpdateState().minPlugin, '0.7.0', '...including its verified compat info');
    assert.strictEqual((await inst({ version: NEWER })).status, 'updated', 'the shown version installs');
    // a shown version NEWER than the latest is a mismatch too
    const h2 = fresh();
    assert.strictEqual((await inst({ version: '99.1.1' })).status, 'version_changed');
    untouched(h2, 'newer-than-latest pin');
  }

  // --- compat.json missing / unverifiable: not installable (fail closed); --force is the only override
  for (const [why, over] of [
    ['no compat.json asset', { omitAssets: ['compat.json'] }],
    ['compat.json not in the sums', { sumsDrop: ['compat.json'] }],
    ['garbage compat.json', { compatRaw: Buffer.from('nope') }],
    ['compat.json for another version', { compatRaw: Buffer.from(JSON.stringify({ version: '1.0.0', minPlugin: '0.7.0' })) }],
  ]) {
    const h = fresh(over);
    await assert.rejects(inst(), (e) => e.code === 'compat_unverified' && /no verifiable compatibility info/.test(e.message), why);
    untouched(h, why); noPayload(why);
    assert.strictEqual(U.updateSignal(U.getUpdateState(), GOOD).signal, false, `${why}: and the state is not signalled`);
  }
  {
    const h = fresh({ omitAssets: ['compat.json'] });
    const r = await inst({ force: true });
    assert.strictEqual(r.status, 'updated', '--force installs anyway');
    assert.match(r.compatWarning, /^WARNING: .*no verifiable compatibility info.*--force.*nothing checked/s, 'loud warning');
    assert.strictEqual(readFileSync(join(h.home, 'grip-bridge.mjs'), 'utf8'), release.bridge.toString());
    // ...but --force never overrides a KNOWN incompatible plugin when compat is verified
    const h2 = fresh();
    const bad = await inst({ force: true, plugins: [{ pluginVersion: '0.6.0', fileName: 'Old', wsReady: true, hello: true }] });
    assert.strictEqual(bad.status, 'incompatible_plugin', '--force does not override a known-incompatible plugin');
    untouched(h2, 'force + incompatible');
  }

  // --- connected plugins are re-verified at install time, against the sessions connected NOW
  {
    const pl = (v, file = 'F', o = {}) => ({ pluginVersion: v, fileName: file, wsReady: true, hello: true, ...o });
    for (const [why, plugins, re] of [
      ['plugin too old', [pl('0.6.0', 'Fidelity')], /^plugin 0\.6\.0 in "Fidelity" is older than 99\.1\.0 requires \(>=0\.7\.0\); update the Grip plugin in Figma first$/],
      ['one of two plugins incompatible', [pl('0.8.0', 'Good'), pl('0.5.0', 'Old')], /plugin 0\.5\.0 in "Old"/],
      ['unknown version', [pl('unknown', 'Mystery')], /did not report a version/],
      ['missing version', [pl(undefined, 'Mystery')], /did not report a version/],
    ]) {
      const h = fresh();
      const r = await inst({ plugins });
      assert.strictEqual(r.status, 'incompatible_plugin', why);
      assert.match(r.reason, re, why);
      untouched(h, why); noPayload(why);
    }
    // nothing to verify against: refused unless the caller says the user accepted that
    for (const none of [[], null, undefined, [pl('0.6.0', 'x', { wsReady: false })]]) {
      const h = fresh();
      const r = await inst({ plugins: none });
      assert.strictEqual(r.status, 'plugins_unverifiable');
      assert.match(r.reason, /no Grip plugin is connected, so compatibility cannot be verified; open the Grip plugin in Figma first/);
      untouched(h, 'unverifiable'); noPayload('unverifiable');
    }
    fresh();
    assert.strictEqual((await inst({ plugins: null, acceptUnverified: true })).status, 'updated', 'CLI --yes accepts an unverifiable check');
    fresh();
    assert.strictEqual((await inst({ plugins: [], force: true })).status, 'updated', '--force too');
    // a compatible plugin plus a not-yet-hello socket is fine
    fresh();
    assert.strictEqual((await inst({ plugins: [pl('0.8.0'), pl(undefined, 'new', { hello: false })] })).status, 'updated');
  }

  // --- self-test: the downloaded bridge must run and say its own version before anything is replaced
  {
    const h = fresh();
    assert.strictEqual((await inst()).status, 'updated');
    assert.ok(!readdirSync(h.home).some((n) => n.includes('selftest')), 'the self-test file is removed again');
    assert.strictEqual(hits['/download/grip-bridge.mjs'], 1, 'one download serves both the self-test and the install');

    const broken = [
      ['throws on start', 'throw new Error("boom: missing module");\n', /failed its self-test \(.*boom/],
      ['syntax error', 'this is ( not javascript\n', /failed its self-test/],
      ['exits non-zero', `process.stdout.write('grip-bridge ${NEWER} ok\\n'); process.exit(3);\n`, /failed its self-test/],
      ['prints another version', `if (process.argv.includes('--selftest')) { process.stdout.write('grip-bridge 1.0.0 ok\\n'); process.exit(0); }\n`, /expected "grip-bridge 99\.1\.0 ok"/],
      ['prints nothing', `if (process.argv.includes('--selftest')) process.exit(0);\n`, /failed its self-test \(it reported ""/],
      ['ignores --selftest and starts up', `setInterval(() => {}, 1000);\n`, /no answer within/],
    ];
    process.env.GRIP_SELFTEST_TIMEOUT_MS = '700';
    for (const [why, src, re] of broken) {
      const h2 = fresh({ bridge: Buffer.from(src) });
      await assert.rejects(inst(), (e) => e.code === 'selftest_failed' && re.test(e.message) && /nothing was changed/.test(e.message), why);
      untouched(h2, `broken bridge (${why})`);
    }
    delete process.env.GRIP_SELFTEST_TIMEOUT_MS;
    // a bridge that writes to stderr still passes (only stdout is judged)
    fresh({ bridge: Buffer.from(`process.stderr.write('noise\\n'); process.stdout.write('grip-bridge ${NEWER} ok\\n');\n`) });
    assert.strictEqual((await inst()).status, 'updated');
    // a failed self-test never leaves a home behind when the home did not exist
    const home3 = join(tmp('grip-upd-parent-'), 'fresh-home');
    env(home3);
    freshRelease({ bridge: Buffer.from('throw new Error("x")\n') });
    await assert.rejects(inst(), /self-test/);
    assert.ok(!existsSync(home3), 'a failed self-test did not create ~/.grip');
  }

  // --- consent callback: asked only after every gate passed, and before anything is downloaded
  {
    const h = fresh();
    const asked = [];
    const no = await inst({ confirm: async (i) => { asked.push(i); return false; } });
    assert.strictEqual(no.status, 'declined');
    assert.deepStrictEqual(asked, [{ from: BRIDGE_VERSION, to: NEWER, headline: HEADLINE }]);
    untouched(h, 'declined'); noPayload('declined');
    const yes = await inst({ confirm: async () => true });
    assert.strictEqual(yes.status, 'updated');
    // not asked when a gate fails first
    for (const [why, o] of [['pin', { version: '1.0.0' }], ['plugin', { plugins: [{ pluginVersion: '0.1.0', wsReady: true, hello: true }] }], ['unverifiable', { plugins: [] }]]) {
      fresh();
      let n = 0;
      await inst({ ...o, confirm: async () => { n++; return true; } });
      assert.strictEqual(n, 0, `confirm not called when ${why} fails`);
    }
  }
}

// ---------------------------------------------------------------- 4. disabled
{
  const home = tmp('grip-upd-home-');
  env(home);
  freshRelease();
  process.env.GRIP_NO_UPDATE_CHECK = '1';
  assert.ok(U.updatesDisabled());
  const stop = U.startUpdateChecks({ delayMs: 10, intervalMs: 20 });
  await sleep(120);
  stop();
  assert.deepStrictEqual(hits, {}, 'GRIP_NO_UPDATE_CHECK: not one request');
  assert.strictEqual(U.getUpdateState(), null);
  delete process.env.GRIP_NO_UPDATE_CHECK;

  // enabled: scheduler checks after the delay
  const stop2 = U.startUpdateChecks({ delayMs: 20, intervalMs: 100000 });
  await sleep(250);
  stop2();
  assert.strictEqual(U.getUpdateState()?.latest, NEWER, 'scheduled check ran');
}

// ---------------------------------------------------------------- 5. MCP surface
// `elicit`: undefined = a client WITHOUT the elicitation capability; otherwise
// { caps, answer } where answer(params) -> the elicitation result.
async function connect(bridge, elicit) {
  const live = createSession(bridge);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await live.server.connect(st);
  const client = new Client({ name: 't', version: '0' }, { capabilities: elicit ? { elicitation: elicit.caps } : {} });
  if (elicit) client.setRequestHandler(ElicitRequestSchema, async (req) => elicit.answer(req.params));
  await client.connect(ct);
  return { live, client };
}
// A stand-in PluginBridge: only what the session code touches.
const makeBridge = (plugins = GOOD) => ({
  on() {}, off() {},
  snapshot: () => ({ pluginCount: plugins.length, pendingCount: 0, plugins }),
  request: async () => ({ ok: true }),
});
const texts = (r) => r.content.map((c) => c.text);
const OLD_PLUGIN = [{ pluginVersion: '0.5.0', fileName: 'Old file', wsReady: true, hello: true }];

{
  const home = tmp('grip-upd-home-');
  env(home);
  freshRelease({ version: BRIDGE_VERSION });
  await U.checkForUpdate();   // state: not available
  const fakeBridge = makeBridge();
  const a = await connect(fakeBridge);
  assert.ok(!/update is available/i.test(a.client.getInstructions() ?? ''), 'no paragraph when up to date');
  const h0 = await a.client.callTool({ name: 'grip_health', arguments: {} });
  assert.strictEqual(h0.content.length, 1, 'no notice when no update');
  const h0u = JSON.parse(texts(h0)[0]).update;
  assert.strictEqual(h0u.available, false);
  assert.strictEqual(h0u.signalled, false);

  // an update appears
  freshRelease();
  await U.checkForUpdate();
  // existing session (notice not yet sent): an ERROR result must not consume it
  const bad = await a.client.callTool({ name: 'set_active_file', arguments: {} });
  assert.ok(bad.isError);
  assert.strictEqual(bad.content.length, 1, 'no notice on an error result');
  const h1 = await a.client.callTool({ name: 'grip_health', arguments: {} });
  assert.strictEqual(h1.content.length, 2, 'notice appended to the first successful result');
  assert.match(texts(h1)[1], new RegExp(`Grip update available: ${esc(BRIDGE_VERSION)} → ${esc(NEWER)}`));
  assert.ok(texts(h1)[1].includes(`"${HEADLINE}"`), 'notice carries the release headline');
  assert.match(texts(h1)[1], /Do NOT install/, 'wording forbids installing without the user');
  assert.ok(texts(h1)[1].includes(`grip_update {action:'install', version:'${NEWER}'}`), 'the notice tells the agent to pin the version');
  JSON.parse(texts(h1)[0]);   // first block is still plain JSON
  const hu = JSON.parse(texts(h1)[0]).update;
  assert.deepStrictEqual(
    Object.keys(hu).sort(), ['available', 'checkedAt', 'current', 'latest', 'minPlugin', 'signalled'],
    'grip_health.update always reports available, latest, minPlugin, signalled (+ blockedReason when withheld)');
  assert.deepStrictEqual([hu.latest, hu.available, hu.minPlugin, hu.signalled], [NEWER, true, '0.7.0', true]);
  const h2 = await a.client.callTool({ name: 'grip_health', arguments: {} });
  assert.strictEqual(h2.content.length, 1, 'only once per session');

  // ---- notice throttle: once per version per 3 days, ACROSS sessions (state persisted in update-check.json)
  const b = await connect(fakeBridge);
  assert.ok(!/update is available/i.test(b.client.getInstructions() ?? ''), 'a second session within 3 days: no instructions paragraph');
  const b1 = await b.client.callTool({ name: 'grip_health', arguments: {} });
  assert.strictEqual(b1.content.length, 1, '...and no notice on its first tool result');
  const b1u = JSON.parse(texts(b1)[0]).update;
  assert.deepStrictEqual([b1u.available, b1u.signalled, b1u.latest], [true, true, NEWER], 'grip_health still tells the truth when the notice is throttled');
  const bchk = JSON.parse(texts(await b.client.callTool({ name: 'grip_update', arguments: {} }))[0]);
  assert.strictEqual(bchk.available, true, 'grip_update check always reports');
  assert.match(bchk.note, /Update available/);
  const persisted = JSON.parse(readFileSync(join(home, 'update-check.json'), 'utf8')).notifiedAt;
  assert.ok(persisted[NEWER] && Math.abs(Date.now() - Date.parse(persisted[NEWER])) < 60_000, 'notifiedAt persisted per version in ~/.grip/update-check.json');
  // a later check rewrites the cache but keeps the throttle
  await U.checkForUpdate();
  assert.ok(JSON.parse(readFileSync(join(home, 'update-check.json'), 'utf8')).notifiedAt[NEWER], 'checks keep notifiedAt');
  // a NEW version is a new notice
  freshRelease({ version: '99.2.0' });
  await U.checkForUpdate();
  const c2 = await connect(fakeBridge);
  assert.match(c2.client.getInstructions(), /update is available/i, 'another version is not throttled by the first');
  assert.ok(c2.client.getInstructions().includes("version:'99.2.0'"));
  assert.strictEqual((await c2.client.callTool({ name: 'grip_health', arguments: {} })).content.length, 2, 'instructions + first result both carry it (one claim)');
  // process restart (memory gone), same home: still throttled from disk
  freshRelease();   // back to NEWER (99.1.0) for the rest, notified earlier
  U.resetUpdateState();
  await U.checkForUpdate();
  const d0 = await connect(fakeBridge);
  assert.ok(!/update is available/i.test(d0.client.getInstructions() ?? ''), 'throttle survives a restart (read from disk)');
  // 3 days later (disk says 4 days ago): shown again
  const cacheFile = join(home, 'update-check.json');
  const cj = JSON.parse(readFileSync(cacheFile, 'utf8'));
  cj.notifiedAt[NEWER] = new Date(Date.now() - 4 * 24 * 3600 * 1000).toISOString();
  writeFileSync(cacheFile, JSON.stringify(cj));
  U.resetUpdateState();
  await U.checkForUpdate();
  const d1 = await connect(fakeBridge);
  assert.match(d1.client.getInstructions(), /update is available/i, 'after 3 days the notice comes back');
  assert.ok(d1.client.getInstructions().includes(`"${HEADLINE}"`), 'instructions carry the headline');
  assert.match(d1.client.getInstructions(), /Never install without their explicit yes/);
  assert.strictEqual((await d1.client.callTool({ name: 'grip_health', arguments: {} })).content.length, 2);
  // 2 days ago is still inside the window
  cj.notifiedAt[NEWER] = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
  writeFileSync(cacheFile, JSON.stringify(cj));
  U.resetUpdateState();
  await U.checkForUpdate();
  assert.ok(!/update is available/i.test((await connect(fakeBridge)).client.getInstructions() ?? ''), '2 days: still throttled');
  // claimNotice directly: boundary
  U.resetUpdateState();
  const T0 = Date.parse('2030-01-01T00:00:00Z');
  assert.strictEqual(U.claimNotice('7.7.7', T0), true);
  assert.strictEqual(U.claimNotice('7.7.7', T0 + 3 * 24 * 3600 * 1000 - 1), false);
  assert.strictEqual(U.claimNotice('7.7.7', T0 + 3 * 24 * 3600 * 1000), true);
  // honours GRIP_HOME: another home has its own throttle file
  const otherHome = tmp('grip-upd-home-');
  process.env.GRIP_HOME = otherHome;
  U.resetUpdateState();
  assert.strictEqual(U.claimNotice('7.7.7', T0 + 3 * 24 * 3600 * 1000), true, 'fresh GRIP_HOME, fresh throttle');
  assert.ok(JSON.parse(readFileSync(join(otherHome, 'update-check.json'), 'utf8')).notifiedAt['7.7.7']);
  process.env.GRIP_HOME = home;

  // ---- the notice is gated by the SIGNAL: incompatible / absent plugins => no notice, but truth in health
  env(tmp('grip-upd-home-'));
  freshRelease();
  await U.checkForUpdate();
  const oldPl = await connect(makeBridge(OLD_PLUGIN));
  assert.ok(!/update is available/i.test(oldPl.client.getInstructions() ?? ''), 'plugin too old: no paragraph');
  const oh = await oldPl.client.callTool({ name: 'grip_health', arguments: {} });
  assert.strictEqual(oh.content.length, 1, 'plugin too old: no notice');
  const ohu = JSON.parse(texts(oh)[0]).update;
  assert.deepStrictEqual([ohu.available, ohu.signalled, ohu.minPlugin, ohu.latest], [true, false, '0.7.0', NEWER]);
  assert.strictEqual(ohu.blockedReason, `plugin 0.5.0 in "Old file" is older than ${NEWER} requires (>=0.7.0); update the Grip plugin in Figma first`);
  const none = await connect(makeBridge([]));
  assert.ok(!/update is available/i.test(none.client.getInstructions() ?? ''), 'no plugin connected: no paragraph');
  assert.match(JSON.parse(texts(await none.client.callTool({ name: 'grip_health', arguments: {} }))[0]).update.blockedReason, /no Grip plugin is connected/);
  const nchk = JSON.parse(texts(await none.client.callTool({ name: 'grip_update', arguments: {} }))[0]);
  assert.strictEqual(nchk.signalled, false);
  assert.match(nchk.note, /NOT offered.*Do not install/);
  assert.strictEqual(nchk.latest, NEWER, 'check still reports the truth');
  // a plugin coming online LATER flips it for sessions already running (first-result notice re-evaluates)
  const dyn = [];
  const late = await connect(makeBridge(dyn));
  assert.strictEqual((await late.client.callTool({ name: 'grip_health', arguments: {} })).content.length, 1, 'no plugin yet: nothing shown');
  dyn.push(...GOOD);
  assert.strictEqual((await late.client.callTool({ name: 'grip_health', arguments: {} })).content.length, 2, 'plugin connected: the notice appears on the next result');
  // fail closed: no compat.json => not signalled even with a perfect plugin
  env(tmp('grip-upd-home-'));
  freshRelease({ omitAssets: ['compat.json'] });
  await U.checkForUpdate();
  const nc = await connect(makeBridge());
  assert.ok(!/update is available/i.test(nc.client.getInstructions() ?? ''));
  const nch = JSON.parse(texts(await nc.client.callTool({ name: 'grip_health', arguments: {} }))[0]).update;
  assert.deepStrictEqual([nch.available, nch.minPlugin, nch.signalled], [true, null, false]);
  assert.match(nch.blockedReason, /no verified compatibility info/);

  // ---- the reverse direction shows in health: a plugin that needs a newer bridge
  {
    const stale = await connect(makeBridge([{ pluginVersion: '0.9.0', fileName: 'Fresh', wsReady: true, hello: true, minBridge: '0.9.0' }]));
    const su = JSON.parse(texts(await stale.client.callTool({ name: 'grip_health', arguments: {} }))[0]).update;
    assert.match(su.bridgeStale, /needs Grip bridge >= 0\.9\.0/);
    assert.strictEqual(su.updateRecommended, true);
  }

  // ---- grip_update itself never gets the notice appended; check returns notes
  env(tmp('grip-upd-home-'));
  freshRelease();
  await U.checkForUpdate();
  const c = await connect(fakeBridge);
  const chk = await c.client.callTool({ name: 'grip_update', arguments: {} });
  assert.strictEqual(chk.content.length, 1);
  const chkJ = JSON.parse(texts(chk)[0]);
  assert.strictEqual(chkJ.available, true);
  assert.strictEqual(chkJ.latest, NEWER);
  assert.strictEqual(chkJ.signalled, true);
  assert.strictEqual(chkJ.headline, HEADLINE);
  assert.match(chkJ.notes, /Ask your agent to update Grip/, 'check returns the release notes');
  assert.ok(chkJ.note.includes(`call grip_update {action:'install', version:'${NEWER}'}`), 'the check note tells the agent how to pin');
  const bogus = await c.client.callTool({ name: 'grip_update', arguments: { action: 'nuke' } });
  assert.ok(bogus.isError, 'unknown action rejected');
  // notes are capped
  freshRelease({ body: '**Big.**\n\n' + 'word '.repeat(2000) });
  const bigJ = JSON.parse(texts(await c.client.callTool({ name: 'grip_update', arguments: { action: 'check' } }))[0]);
  assert.ok(bigJ.notes.length <= 1210, `notes capped (${bigJ.notes.length})`);
  freshRelease();

  // disabled: no paragraph, no notice, check does not touch the network
  process.env.GRIP_NO_UPDATE_CHECK = '1';
  hits = {};
  const d = await connect(fakeBridge);
  assert.ok(!/update is available/i.test(d.client.getInstructions() ?? ''));
  const dh = await d.client.callTool({ name: 'grip_health', arguments: {} });
  assert.strictEqual(dh.content.length, 1, 'no notice when disabled');
  const dc = JSON.parse(texts(await d.client.callTool({ name: 'grip_update', arguments: { action: 'check' } }))[0]);
  assert.strictEqual(dc.disabled, true);
  assert.strictEqual(dc.signalled, false, 'disabled: never signalled');
  assert.deepStrictEqual(hits, {}, 'disabled check made no request');
  delete process.env.GRIP_NO_UPDATE_CHECK;

  // ---- grip_update {install}: pin, consent, compat, then files written + restart scheduled via the hook
  let restarted = 0;
  U.setRestartHook(() => { restarted++; }, true);
  process.env.GRIP_UPDATE_RESTART_DELAY_MS = '30';
  const call = (cl, args) => cl.callTool({ name: 'grip_update', arguments: args });
  const home2 = tmp('grip-upd-home-');
  env(home2);
  freshRelease();
  await U.checkForUpdate();
  const noElicit = await connect(fakeBridge);   // a client that cannot ask the user

  // version is REQUIRED
  const nov = await call(noElicit.client, { action: 'install' });
  assert.ok(nov.isError && /version_required/.test(texts(nov)[0]) && /explicitly said yes/.test(texts(nov)[0]), texts(nov)[0]);
  assert.ok(!existsSync(join(home2, 'grip-bridge.mjs')));
  // a stale version: version_changed, with the new version and its notes, nothing installed
  const stale = await call(noElicit.client, { action: 'install', version: '99.0.9' });
  assert.ok(stale.isError);
  const sj = JSON.parse(texts(stale)[0]);
  assert.deepStrictEqual([sj.error, sj.requested, sj.latest, sj.headline], ['version_changed', '99.0.9', NEWER, HEADLINE]);
  assert.match(sj.notes, /Ask your agent to update Grip/);
  assert.ok(sj.note.includes(`version:'${NEWER}'`));
  assert.ok(!existsSync(join(home2, 'grip-bridge.mjs')), 'version_changed installed nothing');

  // incompatible plugin / no plugin: refused before anything else
  const oldClient = await connect(makeBridge(OLD_PLUGIN));
  const inc = await call(oldClient.client, { action: 'install', version: NEWER });
  assert.ok(inc.isError && /^incompatible_plugin: plugin 0\.5\.0 in "Old file" is older than/.test(texts(inc)[0]), texts(inc)[0]);
  const noPlug = await connect(makeBridge([]));
  const unv = await call(noPlug.client, { action: 'install', version: NEWER });
  assert.ok(unv.isError && /plugins_unverifiable/.test(texts(unv)[0]) && /open the Grip plugin in Figma first so compatibility can be verified/i.test(texts(unv)[0]), texts(unv)[0]);
  assert.ok(!existsSync(join(home2, 'grip-bridge.mjs')));
  assert.ok(!hits['/download/grip-bridge.mjs'], 'refusals downloaded no payload');

  // no elicitation support: the version pin is the gate, and the result says the consent was only attested by the agent
  const inst1 = await call(noElicit.client, { action: 'install', version: NEWER });
  assert.ok(!inst1.isError, texts(inst1)[0]);
  const ij = JSON.parse(texts(inst1)[0]);
  assert.deepStrictEqual([ij.status, ij.from, ij.to, ij.restart, ij.consent], ['updated', BRIDGE_VERSION, NEWER, 'scheduled', 'agent_attested']);
  assert.ok(ij.next.some((s) => /~\/\.grip\/figma-plugin/.test(s) && /git pull/.test(s)), 'plugin guidance for both import styles');
  assert.ok(ij.next.some((s) => /HTTP transport/.test(s)), 'HTTP reconnect guidance');
  assert.ok(ij.next.some((s) => /--rollback/.test(s) && /plugin files stay at the new version/.test(s)), 'rollback leaves the plugin files: said so');
  assert.ok(existsSync(join(home2, 'grip-bridge.mjs')));
  await sleep(150);
  assert.strictEqual(restarted, 1, 'restart hook ran after the response');

  // elicitation: accept installs and says the user confirmed; decline/cancel/error/timeout => declined, nothing changes
  const asks = [];
  const mk = (answer, caps = { form: {} }) => connect(fakeBridge, { caps, answer: (p) => { asks.push(p); return answer(p); } });
  for (const caps of [{ form: {} }, {}]) {
    const home3 = tmp('grip-upd-home-');
    env(home3);
    freshRelease();
    await U.checkForUpdate();
    writeFileSync(join(home3, 'grip-bridge.mjs'), 'OLD BRIDGE');
    const label = JSON.stringify(caps);
    asks.length = 0;
    // decline
    const dec = await (await mk(async () => ({ action: 'decline' }), caps)).client.callTool({ name: 'grip_update', arguments: { action: 'install', version: NEWER } });
    assert.ok(!dec.isError, texts(dec)[0]);
    assert.strictEqual(JSON.parse(texts(dec)[0]).status, 'declined', `decline ${label}`);
    assert.strictEqual(asks.length, 1);
    assert.match(asks[0].message, new RegExp(`^Install Grip ${esc(BRIDGE_VERSION)} → ${esc(NEWER)}\\? ${esc(HEADLINE)}$`), 'short, form-less confirmation with the headline');
    assert.deepStrictEqual(asks[0].requestedSchema, { type: 'object', properties: {} }, 'a form with no fields');
    assert.strictEqual(readFileSync(join(home3, 'grip-bridge.mjs'), 'utf8'), 'OLD BRIDGE', 'declined: nothing installed');
    assert.ok(!hits['/download/grip-bridge.mjs'], 'declined: payload never downloaded');
    // cancel
    const can = await (await mk(async () => ({ action: 'cancel' }), caps)).client.callTool({ name: 'grip_update', arguments: { action: 'install', version: NEWER } });
    assert.strictEqual(JSON.parse(texts(can)[0]).status, 'declined', `cancel ${label}`);
    // the client's handler throws: counts as a decline
    const thr = await (await mk(async () => { throw new Error('ui crashed'); }, caps)).client.callTool({ name: 'grip_update', arguments: { action: 'install', version: NEWER } });
    assert.strictEqual(JSON.parse(texts(thr)[0]).status, 'declined', `error ${label}`);
    // timeout (lowered for the test; the real ceiling is 60s)
    process.env.GRIP_ELICIT_TIMEOUT_MS = '300';
    const slow = await (await mk(() => new Promise(() => {}), caps)).client.callTool({ name: 'grip_update', arguments: { action: 'install', version: NEWER } });
    assert.strictEqual(JSON.parse(texts(slow)[0]).status, 'declined', `timeout ${label}`);
    delete process.env.GRIP_ELICIT_TIMEOUT_MS;
    assert.strictEqual(readFileSync(join(home3, 'grip-bridge.mjs'), 'utf8'), 'OLD BRIDGE', 'still nothing installed');
    // accept
    asks.length = 0;
    const acc = await (await mk(async () => ({ action: 'accept', content: {} }), caps)).client.callTool({ name: 'grip_update', arguments: { action: 'install', version: NEWER } });
    assert.ok(!acc.isError, texts(acc)[0]);
    const aj = JSON.parse(texts(acc)[0]);
    assert.deepStrictEqual([aj.status, aj.consent], ['updated', 'user_confirmed'], `accept ${label}`);
    assert.strictEqual(readFileSync(join(home3, 'grip-bridge.mjs'), 'utf8'), release.bridge.toString());
    await sleep(100);
  }
  // a url-only elicitation client cannot show a form: treated as "cannot ask" (the pin is the gate), consent only attested
  {
    const home4 = tmp('grip-upd-home-');
    env(home4);
    freshRelease();
    await U.checkForUpdate();
    asks.length = 0;
    const urlOnly = await mk(async () => ({ action: 'decline' }), { url: {} });
    const r = await call(urlOnly.client, { action: 'install', version: NEWER });
    assert.ok(!r.isError, texts(r)[0]);
    assert.deepStrictEqual([JSON.parse(texts(r)[0]).status, JSON.parse(texts(r)[0]).consent], ['updated', 'agent_attested']);
    assert.strictEqual(asks.length, 0, 'no form was sent to a url-only client');
    await sleep(100);
  }
  // the elicitation is NOT asked when a gate fails first (pin / compat)
  {
    env(tmp('grip-upd-home-'));
    freshRelease();
    await U.checkForUpdate();
    asks.length = 0;
    const oldWithElicit = await connect(makeBridge(OLD_PLUGIN), { caps: { form: {} }, answer: (p) => { asks.push(p); return { action: 'accept' }; } });
    const r = await call(oldWithElicit.client, { action: 'install', version: NEWER });
    assert.ok(r.isError);
    assert.strictEqual(asks.length, 0, 'the user is not bothered with an update that cannot install');
    const r2 = await call((await mk(async () => ({ action: 'accept' }))).client, { action: 'install', version: '1.2.3' });
    assert.ok(r2.isError);
    assert.strictEqual(asks.length, 0, 'nor with a stale version');
  }

  // unmanaged bridge: installed, but not restarted
  const home5 = tmp('grip-upd-home-');
  env(home5);
  U.setRestartHook(() => { restarted++; }, false);
  freshRelease({ version: '99.2.0' });
  const inst2 = JSON.parse(texts(await call(noElicit.client, { action: 'install', version: '99.2.0' }))[0]);
  assert.strictEqual(inst2.restart, 'not_managed');
  const rBefore = restarted;
  await sleep(100);
  assert.strictEqual(restarted, rBefore, 'unmanaged bridge does not restart');
  // failure surfaces as a tool error (bad download), and a broken bridge fails its self-test
  freshRelease({ version: '99.3.0' });
  release.bodies['grip-bridge.mjs'] = Buffer.from('bad');
  const inst3 = await call(noElicit.client, { action: 'install', version: '99.3.0' });
  assert.ok(inst3.isError && /retry in a few minutes/.test(texts(inst3)[0]));
  freshRelease({ version: '99.3.1', bridge: Buffer.from('process.exit(1)\n') });
  const st3 = await call(noElicit.client, { action: 'install', version: '99.3.1' });
  assert.ok(st3.isError && /selftest_failed: update failed: the downloaded bridge failed its self-test/.test(texts(st3)[0]), texts(st3)[0]);
  // a release with no compat.json: not installable through the tool
  freshRelease({ version: '99.3.2', omitAssets: ['compat.json'] });
  const st4 = await call(noElicit.client, { action: 'install', version: '99.3.2' });
  assert.ok(st4.isError && /compat_unverified/.test(texts(st4)[0]), texts(st4)[0]);

  // a clone install: the tool reports it and changes nothing (no force through MCP)
  writeFileSync(join(home5, 'install.json'), JSON.stringify({ source: 'clone', version: BRIDGE_VERSION }));
  const before = snapshotDir(home5);
  const bridgeBefore = readFileSync(join(home5, 'grip-bridge.mjs'), 'utf8');
  freshRelease({ version: '99.4.0' });
  const inst4 = await call(noElicit.client, { action: 'install', version: '99.4.0' });
  assert.ok(!inst4.isError, texts(inst4)[0]);
  const i4 = JSON.parse(texts(inst4)[0]);
  assert.strictEqual(i4.status, 'clone_install');
  assert.deepStrictEqual(i4.next, ['git pull', 'npm run build', 'node bridge/install.mjs']);
  assert.strictEqual(i4.to, '99.4.0');
  assert.strictEqual(snapshotDir(home5), before);
  assert.strictEqual(readFileSync(join(home5, 'grip-bridge.mjs'), 'utf8'), bridgeBefore);
  const i4chk = JSON.parse(texts(await call(noElicit.client, { action: 'check' }))[0]);
  assert.strictEqual(i4chk.available, true, 'check still reports availability for a clone install');
  U.setRestartHook(null, false);
  delete process.env.GRIP_UPDATE_RESTART_DELAY_MS;

  // registration: in TOOLS, meta (always in scope, incl. core); `version` is in the schema, not required (check needs none)
  assert.ok(TOOLS.some((t) => t.name === 'grip_update'));
  const tl = await noElicit.client.listTools();
  assert.ok(tl.tools.some((t) => t.name === 'grip_update'), 'grip_update advertised in the default (core) scope');
  const upd = tl.tools.find((t) => t.name === 'grip_update');
  assert.deepStrictEqual(upd.inputSchema.properties.action.enum, ['check', 'install']);
  assert.strictEqual(upd.inputSchema.properties.version.type, 'string');
  assert.match(upd.inputSchema.properties.version.description, /REQUIRED/);
  assert.ok(!(upd.inputSchema.required ?? []).includes('version'), 'check needs no version');
  const det = (await noElicit.client.callTool({ name: 'grip_capabilities', arguments: { tool: 'grip_update' } }));
  assert.match(texts(det)[0], /version_changed/, 'the long guidance lives in detail (grip_capabilities {tool})');
  assert.match(texts(det)[0], /elicitation/);
}

// ---------------------------------------------------------------- 6. WS (plugin strip)
assert.ok(originAllowedForUpdate(undefined) && originAllowedForUpdate('null') && originAllowedForUpdate('https://www.figma.com'));
assert.ok(!originAllowedForUpdate('https://evil.example') && !originAllowedForUpdate('http://localhost:3000'));
{
  const home = tmp('grip-upd-home-');
  env(home);
  freshRelease();
  const port = await new Promise((res) => { const s = createNetServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const bridge = new PluginBridge(port);
  await new Promise((r) => bridge.once('listening', r));
  let restarted = 0;
  U.setRestartHook(() => { restarted++; }, true);
  process.env.GRIP_UPDATE_RESTART_DELAY_MS = '30';
  await U.checkForUpdate();
  hits = {};   // from here on: any download is the install route's doing
  const unwire = U.wireUpdateToBridge(bridge);
  const sig = () => U.updateSignal(U.getUpdateState(), U.pluginInfos(bridge));
  assert.strictEqual(sig().signal, false, 'no plugin connected yet: not signalled');

  const open = (origin) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, origin ? { origin } : {});
    const msgs = [];
    ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve({ ws, msgs }));
  });
  const hello = (ws, o = {}) => ws.send(JSON.stringify({ kind: 'hello', version: BRIDGE_VERSION, fileKey: 'k', fileName: 'f', currentPageId: '0:1', currentPageName: 'P', ...o }));
  const waitFor = async (msgs, pred, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { const m = msgs.find(pred); if (m) return m; await sleep(20); } return null; };
  const updates = (c) => c.msgs.filter((m) => m.type === 'update');
  const lastUpdate = (c) => updates(c).at(-1);

  // a plugin with a bad Origin: refused, nothing installed
  const evil = await open('https://evil.example');
  hello(evil.ws);
  await sleep(100);
  evil.ws.send(JSON.stringify({ type: 'update_request', version: NEWER }));
  const refused = await waitFor(evil.msgs, (m) => m.type === 'update_result');
  assert.deepStrictEqual([refused?.status, refused?.code], ['error', 'origin'], 'web-page origin refused');
  await sleep(100);
  assert.deepStrictEqual(downloads(), [], 'refused request downloaded nothing');
  assert.ok(!existsSync(join(home, 'grip-bridge.mjs')));
  evil.ws.close();
  await sleep(50);

  // a real plugin (Origin null), compatible: gets the signal frame on hello
  const plug = await open('null');
  assert.strictEqual((await waitFor(plug.msgs, (m) => m.kind === 'welcome'))?.kind, 'welcome');
  assert.strictEqual(plug.msgs.find((m) => m.kind === 'welcome').bridgeVersion, BRIDGE_VERSION);
  hello(plug.ws, { minBridge: '0.7.0' });
  const note = await waitFor(plug.msgs, (m) => m.type === 'update');
  assert.deepStrictEqual(
    [note?.available, note?.latest, note?.current, note?.headline], [true, NEWER, BRIDGE_VERSION, HEADLINE],
    'update frame on hello: {available:<signal>, latest, current, headline}');
  assert.strictEqual(sig().signal, true);
  assert.strictEqual(bridge.snapshot().plugins[0].minBridge, '0.7.0', 'hello.minBridge is kept and reported');
  assert.strictEqual(U.bridgeStaleReason(U.pluginInfos(bridge)), undefined, 'minBridge <= this bridge: fine');
  await sleep(50);
  assert.strictEqual(updates(plug).length, 1, 'one frame, not one per recompute (deduped)');

  // recompute on plugin connect: a second window with an OLD plugin withholds the signal from everyone
  const oldP = await open('null');
  await waitFor(oldP.msgs, (m) => m.kind === 'welcome');
  hello(oldP.ws, { version: '0.6.0', fileName: 'Legacy file' });
  assert.strictEqual((await waitFor(plug.msgs, (m) => m.type === 'update' && m.available === false))?.available, false, 'the first strip loses its purple when an incompatible plugin connects');
  assert.strictEqual(oldP.msgs.filter((m) => m.type === 'update' && m.available).length, 0, 'the old plugin never sees an available frame');
  assert.strictEqual(sig().signal, false);
  assert.match(sig().blockedReason, /plugin 0\.6\.0 in "Legacy file" is older than 99\.1\.0 requires \(>=0\.7\.0\)/);
  // install-time re-verify through the WS route: refused with incompatible_plugin, nothing installed
  plug.msgs.length = 0;
  plug.ws.send(JSON.stringify({ type: 'update_request', version: NEWER }));
  const incompat = await waitFor(plug.msgs, (m) => m.type === 'update_result');
  assert.deepStrictEqual([incompat?.status, incompat?.code], ['error', 'incompatible_plugin']);
  assert.match(incompat?.message, /plugin 0\.6\.0 in "Legacy file"/);
  assert.ok(!existsSync(join(home, 'grip-bridge.mjs')), 'nothing installed while an incompatible plugin is connected');
  // ...and it recomputes when that plugin goes away
  oldP.ws.close();
  assert.strictEqual((await waitFor(plug.msgs, (m) => m.type === 'update' && m.available === true))?.latest, NEWER, 'signal returns when the incompatible plugin leaves');
  // a plugin with NO version (older builds) blocks too
  const mystery = await open('null');
  await waitFor(mystery.msgs, (m) => m.kind === 'welcome');
  mystery.ws.send(JSON.stringify({ kind: 'hello', fileKey: 'z', fileName: 'Mystery', currentPageId: '0:1', currentPageName: 'P' }));
  await sleep(150);
  assert.strictEqual(sig().signal, false, 'unknown version blocks');
  mystery.ws.close();
  await sleep(150);
  assert.strictEqual(sig().signal, true);

  // the plugin says it needs a NEWER bridge: logged, in health, bridge is the stale side
  const fresher = await open('null');
  await waitFor(fresher.msgs, (m) => m.kind === 'welcome');
  hello(fresher.ws, { version: '0.9.0', minBridge: '0.9.0', fileName: 'Fresh' });
  await sleep(150);
  assert.match(U.bridgeStaleReason(U.pluginInfos(bridge)), /plugin 0\.9\.0 in "Fresh" needs Grip bridge >= 0\.9\.0/);
  fresher.ws.close();
  await sleep(100);

  // unrelated / unknown frames are ignored (compat), the bridge keeps working
  plug.msgs.length = 0;
  plug.ws.send(JSON.stringify({ type: 'something_new', x: 1 }));
  // a request with NO version (an older plugin build) is refused, not guessed
  plug.ws.send(JSON.stringify({ type: 'update_request' }));
  const nov = await waitFor(plug.msgs, (m) => m.type === 'update_result');
  assert.deepStrictEqual([nov?.status, nov?.code], ['error', 'version_required']);
  assert.ok(!existsSync(join(home, 'grip-bridge.mjs')));
  // a version that is no longer the latest: refused with version_changed, and the strip is re-pushed the truth AFTER the result
  plug.msgs.length = 0;
  plug.ws.send(JSON.stringify({ type: 'update_request', version: '99.0.1' }));
  const vc = await waitFor(plug.msgs, (m) => m.type === 'update_result');
  assert.deepStrictEqual([vc?.status, vc?.code, vc?.latest], ['error', 'version_changed', NEWER]);
  const after = await waitFor(plug.msgs, (m) => m.type === 'update' && m.latest === NEWER);
  assert.ok(after, 'state re-pushed');
  assert.ok(plug.msgs.indexOf(vc) < plug.msgs.indexOf(after), 'result first, then the refreshed frame');
  assert.ok(!existsSync(join(home, 'grip-bridge.mjs')));

  // the right version installs
  plug.msgs.length = 0;
  plug.ws.send(JSON.stringify({ type: 'update_request', version: NEWER }));
  const res = await waitFor(plug.msgs, (m) => m.type === 'update_result');
  assert.deepStrictEqual([res?.status, res?.to, res?.restart], ['updated', NEWER, 'scheduled']);
  assert.ok(existsSync(join(home, 'grip-bridge.mjs')), 'install ran');
  await sleep(150);
  assert.strictEqual(restarted, 1);

  // a failing install (bad download) comes back as status:error with a code + message
  freshRelease({ version: '99.6.0' });
  release.bodies['grip-bridge.mjs'] = Buffer.from('tampered');
  await U.checkForUpdate();
  plug.msgs.length = 0;
  plug.ws.send(JSON.stringify({ type: 'update_request', version: '99.6.0' }));
  const fail = await waitFor(plug.msgs, (m) => m.type === 'update_result');
  assert.strictEqual(fail?.status, 'error');
  assert.strictEqual(fail?.code, 'install_failed');
  assert.match(fail?.message, /retry in a few minutes/);
  // a broken new bridge: selftest_failed
  freshRelease({ version: '99.6.1', bridge: Buffer.from('process.exit(2)\n') });
  await U.checkForUpdate();
  plug.msgs.length = 0;
  plug.ws.send(JSON.stringify({ type: 'update_request', version: '99.6.1' }));
  const stf = await waitFor(plug.msgs, (m) => m.type === 'update_result');
  assert.deepStrictEqual([stf?.status, stf?.code], ['error', 'selftest_failed']);
  // a release with no compat.json: not signalled, not installable
  freshRelease({ version: '99.6.2', omitAssets: ['compat.json'] });
  plug.msgs.length = 0;
  await U.checkForUpdate();
  assert.strictEqual((await waitFor(plug.msgs, (m) => m.type === 'update' && m.available === false))?.available, false, 'unverifiable release: the purple goes away');
  plug.ws.send(JSON.stringify({ type: 'update_request', version: '99.6.2' }));
  const cu = await waitFor(plug.msgs, (m) => m.type === 'update_result');
  assert.deepStrictEqual([cu?.status, cu?.code], ['error', 'compat_unverified']);

  // state change broadcast (e.g. cleared)
  freshRelease();
  await U.checkForUpdate();
  assert.strictEqual((await waitFor(plug.msgs, (m) => m.type === 'update' && m.available === true))?.latest, NEWER);
  plug.msgs.length = 0;
  bridge.setUpdateState({ available: false, latest: NEWER });
  assert.strictEqual((await waitFor(plug.msgs, (m) => m.type === 'update'))?.available, false, 'state changes are broadcast');
  // GRIP_NO_UPDATE_CHECK suppresses the indicator entirely
  process.env.GRIP_NO_UPDATE_CHECK = '1';
  plug.msgs.length = 0;
  await U.checkForUpdate();   // (explicit user action style call: state updates, signal stays off)
  await sleep(100);
  assert.ok(!plug.msgs.some((m) => m.type === 'update' && m.available), 'disabled: never purple');
  delete process.env.GRIP_NO_UPDATE_CHECK;
  await U.checkForUpdate();

  // a clone install answers the strip with clone_install and changes nothing
  writeFileSync(join(home, 'install.json'), JSON.stringify({ source: 'clone', version: BRIDGE_VERSION }));
  const bridgeBefore = readFileSync(join(home, 'grip-bridge.mjs'), 'utf8');
  freshRelease({ version: '99.5.0' });
  plug.msgs.length = 0;
  plug.ws.send(JSON.stringify({ type: 'update_request', version: '99.5.0' }));
  const cl = await waitFor(plug.msgs, (m) => m.type === 'update_result');
  assert.deepStrictEqual([cl?.status, cl?.to], ['clone_install', '99.5.0']);
  assert.deepStrictEqual(cl?.next, ['git pull', 'npm run build', 'node bridge/install.mjs']);
  assert.strictEqual(readFileSync(join(home, 'grip-bridge.mjs'), 'utf8'), bridgeBefore, 'strip click did not overwrite a clone install');

  plug.ws.close();
  unwire();
  U.setRestartHook(null, false);
  delete process.env.GRIP_UPDATE_RESTART_DELAY_MS;
  bridge.close();
}

// ---------------------------------------------------------------- 7. stopRunningDaemon is conservative
{
  const home = tmp('grip-upd-home-');
  env(home);
  const statusFile = join(home, 'status.json');
  process.env.GRIP_STATUS_PATH = statusFile;

  assert.strictEqual(U.stopRunningDaemon().stopped, false, 'no status file => nothing');

  // a live process that is NOT a grip daemon must be left alone
  const decoy = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  writeFileSync(statusFile, JSON.stringify({ pid: decoy.pid }));
  const r1 = U.stopRunningDaemon();
  assert.strictEqual(r1.stopped, false, r1.note);
  await sleep(100);
  assert.doesNotThrow(() => process.kill(decoy.pid, 0), 'decoy still alive');
  decoy.kill();

  // stale pid
  writeFileSync(statusFile, JSON.stringify({ pid: 2 ** 22 + 12345 }));
  assert.strictEqual(U.stopRunningDaemon().stopped, false);
  // garbage
  writeFileSync(statusFile, '{"pid":"; rm -rf /"}');
  assert.strictEqual(U.stopRunningDaemon().stopped, false);

  // a process whose command line is "...grip-bridge.mjs --daemon" IS stopped
  if (process.platform !== 'win32') {
    const dir = tmp('grip-fake-daemon-');
    const script = join(dir, 'grip-bridge.mjs');
    writeFileSync(script, 'setInterval(()=>{},1000)\n');
    const fake = spawn(process.execPath, [script, '--daemon'], { stdio: 'ignore' });
    const exited = new Promise((r) => fake.once('exit', r));
    await sleep(150);
    writeFileSync(statusFile, JSON.stringify({ pid: fake.pid }));
    const r2 = U.stopRunningDaemon();
    assert.strictEqual(r2.stopped, true, r2.note);
    await Promise.race([exited, sleep(3000)]);
    assert.ok(fake.killed || fake.exitCode !== null || fake.signalCode, 'fake daemon was terminated');
  }
}

// ---------------------------------------------------------------- 7b. readDaemonPlugins (what the CLI knows about plugins)
{
  const home = tmp('grip-upd-home-');
  env(home);
  const statusFile = join(home, 'status.json');
  process.env.GRIP_STATUS_PATH = statusFile;
  assert.strictEqual(U.readDaemonPlugins(), null, 'no status file: cannot tell');
  writeFileSync(statusFile, JSON.stringify({ pid: process.pid, pluginCount: 0 }));
  assert.strictEqual(U.readDaemonPlugins(), null, 'a daemon older than 0.8.0 (no plugins list): cannot tell');
  writeFileSync(statusFile, JSON.stringify({ pid: 2 ** 22 + 99, plugins: [{ pluginVersion: '0.8.0' }] }));
  assert.strictEqual(U.readDaemonPlugins(), null, 'stale file (pid gone): cannot tell');
  writeFileSync(statusFile, JSON.stringify({ pid: process.pid, plugins: [] }));
  assert.deepStrictEqual(U.readDaemonPlugins(), [], 'running daemon, no plugin open');
  writeFileSync(statusFile, JSON.stringify({ pid: process.pid, plugins: [{ pluginVersion: '0.8.0', fileName: 'F', wsReady: true, hello: true, minBridge: '0.7.0' }, { pluginVersion: 5 }] }));
  const pl = U.readDaemonPlugins();
  assert.deepStrictEqual(pl[0], { pluginVersion: '0.8.0', fileName: 'F', wsReady: true, hello: true, minBridge: '0.7.0' });
  assert.strictEqual(pl[1].pluginVersion, null, 'a non-string version is unknown, never trusted');
  writeFileSync(statusFile, '{not json');
  assert.strictEqual(U.readDaemonPlugins(), null);
}

// ---------------------------------------------------------------- 8. CLI (never starts a daemon)
{
  const home = tmp('grip-upd-home-');
  env(home);
  freshRelease();
  const statusFile = join(home, 'status.json');
  const cliEnv = {
    ...process.env,
    GRIP_HOME: home,
    GRIP_RELEASES_API: API,
    GRIP_STATUS_PATH: join(home, 'nostatus.json'),
    GRIP_IPC_PATH: join(home, 'cli.sock'),
    GRIP_LOG_PATH: join(home, 'cli.log'),
  };
  const run = (args, input, extraEnv = {}) => new Promise((resolve) => {
    const p = spawn(process.execPath, [INDEX_JS, ...args], { env: { ...cliEnv, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code) => resolve({ code, out, err }));
    p.stdin.end(input ?? '');
  });
  // a "running daemon" status file: this test process is the live pid; its plugin list is what we say
  const daemonWith = (plugins) => { writeFileSync(statusFile, JSON.stringify({ pid: process.pid, plugins })); return { GRIP_STATUS_PATH: statusFile }; };
  const plug = (v, file = 'Fidelity') => ({ pluginVersion: v, fileName: file, wsReady: true, hello: true });

  const chk = await run(['update', '--check']);
  assert.strictEqual(chk.code, 0, chk.err);
  assert.match(chk.out, new RegExp(`Update available: ${esc(BRIDGE_VERSION)} -> ${esc(NEWER)}`));
  assert.match(chk.out, /Self-update, finally/, 'release notes shown');
  assert.match(chk.out, /needs a Figma plugin >= 0\.7\.0/, 'the compat requirement is shown');
  assert.match(chk.out, /Could not verify your plugin/, 'no running daemon: says it cannot verify');
  assert.ok(!existsSync(join(home, 'grip-bridge.mjs')), '--check installs nothing');
  assert.ok(!existsSync(join(home, 'cli.sock')) && !existsSync(join(home, 'cli.log')), 'CLI started no daemon and wrote no daemon log');

  // `--update` alias; check with the network down still exits 0
  const down = await run(['--update', '--check'], '', { GRIP_RELEASES_API: 'http://127.0.0.1:1/x' });
  assert.strictEqual(down.code, 0);
  assert.match(down.out, /Could not check/);

  // no TTY and no --yes: refuses, installs nothing
  const noyes = await run(['update']);
  assert.strictEqual(noyes.code, 1);
  assert.match(noyes.out, /--yes/);
  assert.ok(!existsSync(join(home, 'grip-bridge.mjs')));

  // no daemon / no plugin to ask: --yes accepts the unverifiable check and installs (and rollback restores)
  writeFileSync(join(home, 'grip-bridge.mjs'), 'OLD BRIDGE');
  const yes = await run(['update', '--yes']);
  assert.strictEqual(yes.code, 0, yes.err);
  assert.match(yes.out, /Could not verify your plugin/);
  assert.match(yes.out, /Updated/);
  assert.match(yes.out, /Rolling back restores the bridge only; the plugin files stay at the new version/, 'rollback caveat printed');
  assert.strictEqual(readFileSync(join(home, 'grip-bridge.mjs'), 'utf8'), release.bridge.toString());
  assert.ok(existsSync(join(home, 'figma-plugin', 'ui.html')));
  assert.strictEqual(JSON.parse(readFileSync(join(home, 'install.json'), 'utf8')).source, 'release');
  const rb = await run(['update', '--rollback']);
  assert.strictEqual(rb.code, 0, rb.err);
  assert.match(rb.out, /plugin files .* stay at the new version/);
  assert.strictEqual(readFileSync(join(home, 'grip-bridge.mjs'), 'utf8'), 'OLD BRIDGE');

  // a running daemon with a COMPATIBLE plugin: verified, installs with --yes
  const okd = await run(['update', '--yes'], '', daemonWith([plug('0.8.0')]));
  assert.strictEqual(okd.code, 0, okd.err + okd.out);
  assert.ok(!/Could not verify/.test(okd.out), 'verified through the status file');
  assert.match(okd.out, /Updated/);
  writeFileSync(join(home, 'grip-bridge.mjs'), 'OLD BRIDGE');

  // a running daemon with an INCOMPATIBLE plugin: refuses (even with --yes and --force)
  for (const flagsList of [['update', '--yes'], ['update', '--yes', '--force']]) {
    const inc = await run(flagsList, '', daemonWith([plug('0.8.0', 'Good'), plug('0.6.0', 'Legacy')]));
    assert.strictEqual(inc.code, 1, inc.out);
    assert.match(inc.out, /Not installing: plugin 0\.6\.0 in "Legacy" is older than 99\.1\.0 requires \(>=0\.7\.0\); update the Grip plugin in Figma first/);
    assert.strictEqual(readFileSync(join(home, 'grip-bridge.mjs'), 'utf8'), 'OLD BRIDGE', `${flagsList.join(' ')}: untouched`);
  }
  const incChk = await run(['update', '--check'], '', daemonWith([plug('0.6.0', 'Legacy')]));
  assert.strictEqual(incChk.code, 0);
  assert.match(incChk.out, /Not installing: plugin 0\.6\.0/);
  // a daemon with no plugin open: cannot verify, says so, needs --yes
  const empty = await run(['update'], '', daemonWith([]));
  assert.strictEqual(empty.code, 1);
  assert.match(empty.out, /no Grip plugin is connected/);
  assert.match(empty.out, /--yes/);

  // up to date
  freshRelease({ version: BRIDGE_VERSION });
  const utd = await run(['update']);
  assert.strictEqual(utd.code, 0);
  assert.match(utd.out, /up to date/);

  // a release with no verifiable compat.json: loud warning, not installed; --force installs with a loud warning
  freshRelease({ omitAssets: ['compat.json'] });
  const nc = await run(['update', '--yes']);
  assert.strictEqual(nc.code, 1);
  assert.match(nc.out, /WARNING: Grip 99\.1\.0 has no verified compatibility info/);
  assert.match(nc.out, /not installed/);
  assert.strictEqual(readFileSync(join(home, 'grip-bridge.mjs'), 'utf8'), 'OLD BRIDGE');
  const ncc = await run(['update', '--check']);
  assert.strictEqual(ncc.code, 0);
  assert.match(ncc.out, /WARNING: .*no verified compatibility info/);
  const ncf = await run(['update', '--yes', '--force']);
  assert.strictEqual(ncf.code, 0, ncf.err + ncf.out);
  assert.match(ncf.out, /WARNING: .*no verifiable compatibility info/);
  assert.match(ncf.out, /Updated/);
  writeFileSync(join(home, 'grip-bridge.mjs'), 'OLD BRIDGE');

  // a broken new bridge fails its self-test: nothing changes
  freshRelease({ bridge: Buffer.from('throw new Error("cannot start")\n') });
  const sf = await run(['update', '--yes']);
  assert.strictEqual(sf.code, 1);
  assert.match(sf.err, /Update failed: .*self-test/);
  assert.strictEqual(readFileSync(join(home, 'grip-bridge.mjs'), 'utf8'), 'OLD BRIDGE', 'a bridge that cannot start was never swapped in');

  // clone install: refuses to overwrite (even with --yes), points at git pull; --force overrides
  freshRelease();
  writeFileSync(join(home, 'install.json'), JSON.stringify({ source: 'clone', version: BRIDGE_VERSION }));
  writeFileSync(join(home, 'grip-bridge.mjs'), 'CLONE BRIDGE');
  const cl = await run(['update', '--yes']);
  assert.strictEqual(cl.code, 0, cl.err);
  assert.match(cl.out, /developer install/);
  assert.match(cl.out, /git pull && npm run build && node bridge\/install\.mjs/);
  assert.strictEqual(readFileSync(join(home, 'grip-bridge.mjs'), 'utf8'), 'CLONE BRIDGE', 'clone install untouched by update --yes');
  const clchk = await run(['update', '--check']);
  assert.match(clchk.out, /Update available/, 'check still reports availability');
  assert.match(clchk.out, /git pull && npm run build && node bridge\/install\.mjs/);
  const forced = await run(['update', '--yes', '--force']);
  assert.strictEqual(forced.code, 0, forced.err);
  assert.match(forced.out, /Updated/);
  assert.strictEqual(readFileSync(join(home, 'grip-bridge.mjs'), 'utf8'), release.bridge.toString(), '--force overwrote it');
}

// ---------------------------------------------------------------- 8b. --selftest: the flag the updater relies on
{
  const home = tmp('grip-selftest-home-');
  const fakeHome = tmp('grip-selftest-userhome-');
  const runSelf = (entry) => new Promise((resolve) => {
    const p = spawn(process.execPath, [entry, '--selftest'], {
      env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, GRIP_HOME: home, GRIP_STATUS_PATH: join(home, 'st.json'), GRIP_LOG_PATH: join(home, 'selftest.log'), GRIP_IPC_PATH: join(home, 'selftest.sock') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code) => resolve({ code, out, err }));
  });
  const entries = [['dist/index.js', INDEX_JS]];
  const bundle = join(HERE, '..', '..', '..', 'bridge', 'grip-bridge.mjs');
  if (existsSync(bundle)) entries.push(['bridge/grip-bridge.mjs (the shipped bundle)', bundle]);
  for (const [label, entry] of entries) {
    const t0 = Date.now();
    const r = await runSelf(entry);
    assert.strictEqual(r.code, 0, `${label}: ${r.err}`);
    assert.strictEqual(r.out, `grip-bridge ${BRIDGE_VERSION} ok\n`, `${label}: prints exactly its version`);
    assert.ok(Date.now() - t0 < 8000, `${label}: answers quickly`);
    // no ports, no ~/.grip, no log, no status file, nothing in the (fake) home dir
    assert.deepStrictEqual(readdirSync(home), [], `${label}: wrote nothing under GRIP_HOME / log / status / socket paths`);
    assert.deepStrictEqual(readdirSync(fakeHome), [], `${label}: wrote nothing in the user's home`);
  }
}

// ---------------------------------------------------------------- 9. installer records the install type
{
  const REPO = join(HERE, '..', '..', '..');
  const runInstaller = (installerDir, home) => {
    const fakeHome = tmp('grip-fakehome-');                 // ~/.claude.json lands here, never in the real home
    const stub = tmp('grip-stub-');                         // a `claude` that fails -> JSON fallback path
    writeFileSync(join(stub, 'claude'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    return new Promise((resolve) => {
      const p = spawn(process.execPath, [join(installerDir, 'install.mjs')], {
        env: {
          ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, GRIP_HOME: home,
          GRIP_STATUS_PATH: join(home, 'nostatus.json'),
          PATH: process.platform === 'win32' ? process.env.PATH : `${stub}:${process.env.PATH}`,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '', err = '';
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { err += d; });
      p.on('exit', (code) => resolve({ code, out, err }));
    });
  };
  const built = existsSync(join(REPO, 'bridge', 'install.mjs')) && existsSync(join(REPO, 'bridge', 'grip-bridge.mjs'));
  if (!built) {
    console.log('  (skipping installer install.json test: bridge/install.mjs not built)');
  } else {
    // from the repo (inside a work tree): clone
    const homeA = tmp('grip-inst-clone-');
    const a = await runInstaller(join(REPO, 'bridge'), homeA);
    assert.strictEqual(a.code, 0, a.err + a.out);
    const inGit = U.detectInstallSource(join(REPO, 'bridge')) === 'clone';
    assert.deepStrictEqual(JSON.parse(readFileSync(join(homeA, 'install.json'), 'utf8')),
      { source: inGit ? 'clone' : 'release', version: BRIDGE_VERSION });
    if (inGit) assert.match(a.out, /developer install/);

    // from an extracted grip-install.zip layout (grip/bridge + grip/figma-plugin, no work tree): release
    const zipRoot = tmp('grip-zip-');
    mkdirSync(join(zipRoot, 'grip', 'bridge'), { recursive: true });
    mkdirSync(join(zipRoot, 'grip', 'figma-plugin'), { recursive: true });
    for (const f of ['install.mjs', 'grip-bridge.mjs']) writeFileSync(join(zipRoot, 'grip', 'bridge', f), readFileSync(join(REPO, 'bridge', f)));
    for (const f of ['manifest.json', 'code.js', 'ui.html']) writeFileSync(join(zipRoot, 'grip', 'figma-plugin', f), readFileSync(join(REPO, 'figma-plugin', f)));
    if (U.detectInstallSource(join(zipRoot, 'grip', 'bridge')) === 'release') {
      const homeB = tmp('grip-inst-release-');
      const b = await runInstaller(join(zipRoot, 'grip', 'bridge'), homeB);
      assert.strictEqual(b.code, 0, b.err + b.out);
      assert.deepStrictEqual(JSON.parse(readFileSync(join(homeB, 'install.json'), 'utf8')), { source: 'release', version: BRIDGE_VERSION });
      assert.ok(existsSync(join(homeB, 'figma-plugin', 'manifest.json')), 'plugin copied from the zip layout');
      assert.match(b.out, /update Grip/, 'release installs are told how to update in place');
    }

    // a clone that was never built has manifest.json but no code.js: warn clearly, copy no half plugin
    const unbuilt = tmp('grip-unbuilt-');
    mkdirSync(join(unbuilt, 'bridge'), { recursive: true });
    mkdirSync(join(unbuilt, 'figma-plugin'), { recursive: true });
    for (const f of ['install.mjs', 'grip-bridge.mjs']) writeFileSync(join(unbuilt, 'bridge', f), readFileSync(join(REPO, 'bridge', f)));
    for (const f of ['manifest.json', 'ui.html']) writeFileSync(join(unbuilt, 'figma-plugin', f), readFileSync(join(REPO, 'figma-plugin', f)));
    const homeC = tmp('grip-inst-unbuilt-');
    const c = await runInstaller(join(unbuilt, 'bridge'), homeC);
    assert.strictEqual(c.code, 0, c.err + c.out);
    assert.match(c.out, /code\.js is missing/, 'says what is missing');
    assert.match(c.out, /npm run build/, 'says how to fix it');
    assert.ok(!existsSync(join(homeC, 'figma-plugin')), 'no half-built plugin was copied');
  }
}

// ---------------------------------------------------------------- 10. nothing leaked into the real home
assert.ok(process.env.GRIP_HOME.startsWith(tmpdir()), 'tests only ever used temp dirs');

server.close();
other.close();
console.log('update.mjs OK');
