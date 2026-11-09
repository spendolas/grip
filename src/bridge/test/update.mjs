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

import { BRIDGE_VERSION } from '../dist/types.js';
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
function freshRelease(over = {}) {
  const bridge = Buffer.from('// fake bridge ' + NEWER + '\n');
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
    ...over,
  };
}
// release asset name -> the true bytes
function assetBytes(r) {
  return {
    'grip-bridge.mjs': r.bridge,
    'grip-plugin-code.js': r.files['code.js'],
    'grip-plugin-ui.html': r.files['ui.html'],
    'grip-plugin-manifest.json': r.files['manifest.json'],
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
  assert.strictEqual(U.getUpdateState().available, true, 'cached in memory');
  assert.strictEqual(changes.length, 1, 'listener fired on change');
  await U.checkForUpdate();
  assert.strictEqual(changes.length, 1, 'no change, no event');
  const cache = JSON.parse(readFileSync(join(home, 'update-check.json'), 'utf8'));
  assert.strictEqual(cache.latest, NEWER, 'cached on disk');
  assert.strictEqual(cache.headline, HEADLINE, 'headline cached on disk');
  assert.strictEqual(U.readCache().headline, HEADLINE);
  off();

  // the request: GitHub accept header, generic UA, nothing identifying
  assert.strictEqual(apiHeaders.accept, 'application/vnd.github+json');
  assert.strictEqual(apiHeaders['user-agent'], `grip-bridge/${BRIDGE_VERSION}`);
  for (const h of ['authorization', 'cookie', 'from', 'x-forwarded-for', 'referer']) {
    assert.ok(!(h in apiHeaders), `no ${h} header sent`);
  }
  assert.deepStrictEqual(Object.keys(apiHeaders).sort(), ['accept', 'connection', 'host', 'user-agent'], 'only the four expected headers');

  // v-prefix is stripped; a bare tag works too
  freshRelease({ tag: NEWER });
  assert.strictEqual((await U.checkForUpdate()).latest, NEWER);

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
  const r = await U.installUpdate();
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
    ['/download/SHA256SUMS.txt', '/download/grip-bridge.mjs', '/download/grip-plugin-code.js', '/download/grip-plugin-manifest.json', '/download/grip-plugin-ui.html'],
    'exactly the five assets the updater needs (not the zip)');
  assert.strictEqual(hits['/cdn/grip-bridge.mjs'], 1, 'redirect followed');

  // rollback restores the previous bridge
  U.rollbackBridge();
  assert.strictEqual(readFileSync(join(home, 'grip-bridge.mjs'), 'utf8'), 'OLD BRIDGE', 'rollback restored it');
  assert.throws(() => { process.env.GRIP_HOME = tmp('grip-empty-'); U.rollbackBridge(); }, /no previous version/);

  // up to date: nothing is downloaded or written
  const home2 = tmp('grip-upd-home-');
  env(home2);
  freshRelease({ version: BRIDGE_VERSION });
  const same = await U.installUpdate();
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
  await assert.rejects(U.installUpdate(), /sha256|size mismatch/);
  untouched('tampered bridge');
  await assert.rejects(U.installUpdate(), /retry in a few minutes/, 'error tells the user to retry later');

  // same length, no declared size: caught by SHA256SUMS.txt alone
  freshRelease({ noSizes: true });
  release.bodies['grip-bridge.mjs'] = Buffer.from(release.bridge.toString().replace('fake', 'evil'));
  assert.strictEqual(release.bodies['grip-bridge.mjs'].length, release.bridge.length);
  await assert.rejects(U.installUpdate(), /failed its sha256 check against SHA256SUMS\.txt/);
  untouched('same-length tamper');

  // a bad PLUGIN file also aborts before the (good) bridge is written
  freshRelease({ noSizes: true });
  release.bodies['grip-plugin-ui.html'] = Buffer.from('<html>tampered</html>');
  await assert.rejects(U.installUpdate(), /grip-plugin-ui\.html/);
  untouched('tampered plugin file');

  // a file missing from SHA256SUMS.txt aborts (every file must be listed AND match)
  for (const name of ['grip-bridge.mjs', 'grip-plugin-code.js', 'grip-plugin-ui.html', 'grip-plugin-manifest.json']) {
    freshRelease({ sumsDrop: [name] });
    await assert.rejects(U.installUpdate(), new RegExp(`does not list ${esc(name)}`), `missing sums line for ${name}`);
    untouched(`sums without ${name}`);
  }
  // SHA256SUMS.txt that is empty / garbage / wrong hash
  freshRelease({ sumsRaw: '' });
  await assert.rejects(U.installUpdate(), /does not list/);
  freshRelease({ sumsRaw: Object.keys(assetBytes(release)).map((n) => `${'0'.repeat(64)}  ${n}`).join('\n') });
  await assert.rejects(U.installUpdate(), /sha256|size mismatch/);
  untouched('wrong sums');

  // an asset (or SHA256SUMS.txt) not on the release at all
  freshRelease({ omitAssets: ['SHA256SUMS.txt'] });
  await assert.rejects(U.installUpdate(), /no SHA256SUMS\.txt asset/);
  freshRelease({ omitAssets: ['grip-plugin-code.js'] });
  await assert.rejects(U.installUpdate(), /no grip-plugin-code\.js asset/);
  untouched('missing asset');
  // asset listed but the download 404s
  freshRelease({ assetUrls: { 'grip-bridge.mjs': `${BASE}nope` } });
  await assert.rejects(U.installUpdate(), /could not download grip-bridge\.mjs/);
  untouched('404 asset');
}

// redirects: GitHub-style hop ok, off-host refused, loops capped; size cap
{
  const home = tmp('grip-upd-home-');
  env(home);
  freshRelease();
  assert.strictEqual((await U.installUpdate()).status, 'updated', 'redirect to another path on the allowed host followed');

  // redirect to a disallowed host: refused, that host never contacted
  const home2 = tmp('grip-upd-home-');
  env(home2);
  freshRelease({ assetUrls: { 'grip-bridge.mjs': `${BASE}redir-off` } });
  await assert.rejects(U.installUpdate(), /not an allowed update host/);
  assert.strictEqual(otherHits, 0, 'the disallowed host was never contacted');
  assert.strictEqual(snapshotDir(home2), '');

  // the FIRST url is checked too (a release JSON pointing straight at another host)
  freshRelease({ assetUrls: { 'grip-bridge.mjs': `http://127.0.0.1:${OTHER_PORT}/x` } });
  await assert.rejects(U.installUpdate(), /not an allowed update host/);
  freshRelease({ assetUrls: { 'grip-bridge.mjs': 'https://evil.example/grip-bridge.mjs' } });
  await assert.rejects(U.installUpdate(), /not an allowed update host/);
  freshRelease({ assetUrls: { 'grip-bridge.mjs': 'http://github.com/spendolas/grip/x' } });
  await assert.rejects(U.installUpdate(), /not an allowed update host/, 'plain http to github.com refused');
  assert.strictEqual(otherHits, 0);

  freshRelease({ assetUrls: { 'grip-bridge.mjs': `${BASE}redir-loop` } });
  await assert.rejects(U.installUpdate(), /too many redirects/);

  freshRelease({ assetUrls: { 'grip-bridge.mjs': `${BASE}big` } });
  await assert.rejects(U.installUpdate(), /too large/);
  assert.strictEqual(snapshotDir(home2), '', 'oversized download wrote nothing');
}

// concurrency: a second install while one runs is refused
{
  const home = tmp('grip-upd-home-');
  env(home);
  freshRelease({ bridgeDelayMs: 300 });
  const first = U.installUpdate();
  await sleep(50);
  assert.strictEqual((await U.installUpdate()).status, 'already_installing');
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
  const r = await U.installUpdate();
  assert.strictEqual(r.status, 'clone_install');
  assert.deepStrictEqual(r.next, ['git pull', 'node bridge/install.mjs']);
  assert.deepStrictEqual([r.from, r.to], [BRIDGE_VERSION, NEWER]);
  assert.strictEqual(readFileSync(join(home, 'grip-bridge.mjs'), 'utf8'), 'CLONE BRIDGE', 'clone install not overwritten');
  assert.strictEqual(snapshotDir(home), before, 'nothing written');
  assert.deepStrictEqual(downloads(), [], 'nothing downloaded for a clone install');
  // check still reports availability
  const s = await U.checkForUpdate();
  assert.strictEqual(s.available, true, 'check still reports the update');
  // up to date wins over clone_install
  freshRelease({ version: BRIDGE_VERSION });
  assert.strictEqual((await U.installUpdate()).status, 'up_to_date');
  // force (CLI only) overrides, and the record flips to release
  freshRelease();
  const f = await U.installUpdate({ force: true });
  assert.strictEqual(f.status, 'updated');
  assert.strictEqual(readFileSync(join(home, 'grip-bridge.mjs'), 'utf8'), release.bridge.toString());
  assert.deepStrictEqual(JSON.parse(readFileSync(join(home, 'install.json'), 'utf8')), { source: 'release', version: NEWER });
  // garbage install.json is treated as release
  writeFileSync(join(home, 'install.json'), '{nope');
  assert.strictEqual(U.readInstallRecord().source, 'release');
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
async function connect(bridge) {
  const live = createSession(bridge);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await live.server.connect(st);
  const client = new Client({ name: 't', version: '0' }, { capabilities: {} });
  await client.connect(ct);
  return { live, client };
}
const fakeBridge = {
  on() {}, off() {},
  snapshot: () => ({ pluginCount: 0, pendingCount: 0, plugins: [] }),
  request: async () => ({ ok: true }),
};
const texts = (r) => r.content.map((c) => c.text);

{
  const home = tmp('grip-upd-home-');
  env(home);
  freshRelease({ version: BRIDGE_VERSION });
  await U.checkForUpdate();   // state: not available
  const a = await connect(fakeBridge);
  assert.ok(!/update is available/i.test(a.client.getInstructions() ?? ''), 'no paragraph when up to date');
  const h0 = await a.client.callTool({ name: 'grip_health', arguments: {} });
  assert.strictEqual(h0.content.length, 1, 'no notice when no update');
  assert.strictEqual(JSON.parse(texts(h0)[0]).update.available, false);

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
  assert.match(texts(h1)[1], /grip_update \{action:'install'\}/);
  JSON.parse(texts(h1)[0]);   // first block is still plain JSON
  assert.deepStrictEqual(
    Object.keys(JSON.parse(texts(h1)[0]).update).sort(), ['available', 'checkedAt', 'current', 'latest'],
    'grip_health.update shape is unchanged');
  assert.strictEqual(JSON.parse(texts(h1)[0]).update.latest, NEWER);
  const h2 = await a.client.callTool({ name: 'grip_health', arguments: {} });
  assert.strictEqual(h2.content.length, 1, 'only once per session');

  // a NEW session: paragraph in instructions + notice again
  const b = await connect(fakeBridge);
  assert.match(b.client.getInstructions(), /update is available/i);
  assert.ok(b.client.getInstructions().includes(`"${HEADLINE}"`), 'instructions carry the headline');
  assert.match(b.client.getInstructions(), /Never install without their explicit yes/);
  const b1 = await b.client.callTool({ name: 'grip_health', arguments: {} });
  assert.strictEqual(b1.content.length, 2);

  // grip_update itself never gets the notice appended; check returns notes
  const c = await connect(fakeBridge);
  const chk = await c.client.callTool({ name: 'grip_update', arguments: {} });
  assert.strictEqual(chk.content.length, 1);
  const chkJ = JSON.parse(texts(chk)[0]);
  assert.strictEqual(chkJ.available, true);
  assert.strictEqual(chkJ.latest, NEWER);
  assert.strictEqual(chkJ.headline, HEADLINE);
  assert.match(chkJ.notes, /Ask your agent to update Grip/, 'check returns the release notes');
  assert.match(chkJ.note, /ask if they want it/);
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
  assert.deepStrictEqual(hits, {}, 'disabled check made no request');
  delete process.env.GRIP_NO_UPDATE_CHECK;

  // grip_update install through MCP: files written + restart scheduled via hook
  let restarted = 0;
  U.setRestartHook(() => { restarted++; }, true);
  process.env.GRIP_UPDATE_RESTART_DELAY_MS = '30';
  const e = await connect(fakeBridge);
  const inst = await e.client.callTool({ name: 'grip_update', arguments: { action: 'install' } });
  assert.ok(!inst.isError, texts(inst)[0]);
  const ij = JSON.parse(texts(inst)[0]);
  assert.deepStrictEqual([ij.status, ij.from, ij.to, ij.restart], ['updated', BRIDGE_VERSION, NEWER, 'scheduled']);
  assert.ok(ij.next.some((s) => /~\/\.grip\/figma-plugin/.test(s) && /git pull/.test(s)), 'plugin guidance for both import styles');
  assert.ok(ij.next.some((s) => /HTTP transport/.test(s)), 'HTTP reconnect guidance');
  assert.ok(existsSync(join(home, 'grip-bridge.mjs')));
  await sleep(150);
  assert.strictEqual(restarted, 1, 'restart hook ran after the response');
  // unmanaged bridge: installed, but not restarted
  U.setRestartHook(() => { restarted++; }, false);
  freshRelease({ version: '99.2.0' });
  const inst2 = JSON.parse(texts(await e.client.callTool({ name: 'grip_update', arguments: { action: 'install' } }))[0]);
  assert.strictEqual(inst2.restart, 'not_managed');
  await sleep(100);
  assert.strictEqual(restarted, 1, 'unmanaged bridge does not restart');
  // failure surfaces as a tool error
  freshRelease({ version: '99.3.0' });
  release.bodies['grip-bridge.mjs'] = Buffer.from('bad');
  const inst3 = await e.client.callTool({ name: 'grip_update', arguments: { action: 'install' } });
  assert.ok(inst3.isError && /retry in a few minutes/.test(texts(inst3)[0]));

  // a clone install: the tool reports it and changes nothing (no force through MCP)
  writeFileSync(join(home, 'install.json'), JSON.stringify({ source: 'clone', version: BRIDGE_VERSION }));
  const before = snapshotDir(home);
  const bridgeBefore = readFileSync(join(home, 'grip-bridge.mjs'), 'utf8');
  freshRelease({ version: '99.4.0' });
  const inst4 = await e.client.callTool({ name: 'grip_update', arguments: { action: 'install' } });
  assert.ok(!inst4.isError, texts(inst4)[0]);
  const i4 = JSON.parse(texts(inst4)[0]);
  assert.strictEqual(i4.status, 'clone_install');
  assert.deepStrictEqual(i4.next, ['git pull', 'node bridge/install.mjs']);
  assert.strictEqual(i4.to, '99.4.0');
  assert.strictEqual(snapshotDir(home), before);
  assert.strictEqual(readFileSync(join(home, 'grip-bridge.mjs'), 'utf8'), bridgeBefore);
  const i4chk = JSON.parse(texts(await e.client.callTool({ name: 'grip_update', arguments: { action: 'check' } }))[0]);
  assert.strictEqual(i4chk.available, true, 'check still reports availability for a clone install');
  U.setRestartHook(null, false);
  delete process.env.GRIP_UPDATE_RESTART_DELAY_MS;

  // registration: in TOOLS, meta (always in scope, incl. core)
  assert.ok(TOOLS.some((t) => t.name === 'grip_update'));
  const tl = await e.client.listTools();
  assert.ok(tl.tools.some((t) => t.name === 'grip_update'), 'grip_update advertised in the default (core) scope');
  const upd = tl.tools.find((t) => t.name === 'grip_update');
  assert.deepStrictEqual(upd.inputSchema.properties.action.enum, ['check', 'install']);
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
  const unwire = U.wireUpdateToBridge(bridge);

  const open = (origin) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, origin ? { origin } : {});
    const msgs = [];
    ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve({ ws, msgs }));
  });
  const hello = (ws) => ws.send(JSON.stringify({ kind: 'hello', version: BRIDGE_VERSION, fileKey: 'k', fileName: 'f', currentPageId: '0:1', currentPageName: 'P' }));
  const waitFor = async (msgs, pred, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { const m = msgs.find(pred); if (m) return m; await sleep(20); } return null; };

  // a plugin with a bad Origin: refused, nothing installed
  const evil = await open('https://evil.example');
  hello(evil.ws);
  await sleep(100);
  evil.ws.send(JSON.stringify({ type: 'update_request' }));
  const refused = await waitFor(evil.msgs, (m) => m.type === 'update_result');
  assert.strictEqual(refused?.status, 'error', 'web-page origin refused');
  await sleep(100);
  assert.deepStrictEqual(downloads(), [], 'refused request downloaded nothing');
  assert.ok(!existsSync(join(home, 'grip-bridge.mjs')));
  evil.ws.close();

  // a real plugin (Origin null): gets the notice (with the headline) on hello, can trigger install
  const plug = await open('null');
  assert.strictEqual((await waitFor(plug.msgs, (m) => m.kind === 'welcome'))?.kind, 'welcome');
  hello(plug.ws);
  const note = await waitFor(plug.msgs, (m) => m.type === 'update');
  assert.deepStrictEqual([note?.available, note?.latest, note?.headline], [true, NEWER, HEADLINE], 'update notice pushed on hello, with the headline');

  // unrelated / unknown frames are ignored (compat), the bridge keeps working
  plug.ws.send(JSON.stringify({ type: 'something_new', x: 1 }));
  plug.ws.send(JSON.stringify({ type: 'update_request' }));
  const res = await waitFor(plug.msgs, (m) => m.type === 'update_result');
  assert.deepStrictEqual([res?.status, res?.to, res?.restart], ['updated', NEWER, 'scheduled']);
  assert.ok(existsSync(join(home, 'grip-bridge.mjs')), 'install ran');
  await sleep(150);
  assert.strictEqual(restarted, 1);

  // state change broadcast (e.g. cleared)
  plug.msgs.length = 0;
  bridge.setUpdateState({ available: false, latest: NEWER });
  assert.strictEqual((await waitFor(plug.msgs, (m) => m.type === 'update'))?.available, false, 'state changes are broadcast');

  // a clone install answers the strip with clone_install and changes nothing
  writeFileSync(join(home, 'install.json'), JSON.stringify({ source: 'clone', version: BRIDGE_VERSION }));
  const bridgeBefore = readFileSync(join(home, 'grip-bridge.mjs'), 'utf8');
  freshRelease({ version: '99.5.0' });
  plug.msgs.length = 0;
  plug.ws.send(JSON.stringify({ type: 'update_request' }));
  const cl = await waitFor(plug.msgs, (m) => m.type === 'update_result');
  assert.deepStrictEqual([cl?.status, cl?.to], ['clone_install', '99.5.0']);
  assert.deepStrictEqual(cl?.next, ['git pull', 'node bridge/install.mjs']);
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

// ---------------------------------------------------------------- 8. CLI (never starts a daemon)
{
  const home = tmp('grip-upd-home-');
  env(home);
  freshRelease();
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

  const chk = await run(['update', '--check']);
  assert.strictEqual(chk.code, 0, chk.err);
  assert.match(chk.out, new RegExp(`Update available: ${esc(BRIDGE_VERSION)} -> ${esc(NEWER)}`));
  assert.match(chk.out, /Self-update, finally/, 'release notes shown');
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

  // --yes installs; rollback restores
  writeFileSync(join(home, 'grip-bridge.mjs'), 'OLD BRIDGE');
  const yes = await run(['update', '--yes']);
  assert.strictEqual(yes.code, 0, yes.err);
  assert.match(yes.out, /Updated/);
  assert.strictEqual(readFileSync(join(home, 'grip-bridge.mjs'), 'utf8'), release.bridge.toString());
  assert.ok(existsSync(join(home, 'figma-plugin', 'ui.html')));
  assert.strictEqual(JSON.parse(readFileSync(join(home, 'install.json'), 'utf8')).source, 'release');
  const rb = await run(['update', '--rollback']);
  assert.strictEqual(rb.code, 0, rb.err);
  assert.strictEqual(readFileSync(join(home, 'grip-bridge.mjs'), 'utf8'), 'OLD BRIDGE');

  // up to date
  freshRelease({ version: BRIDGE_VERSION });
  const utd = await run(['update']);
  assert.strictEqual(utd.code, 0);
  assert.match(utd.out, /up to date/);

  // clone install: refuses to overwrite (even with --yes), points at git pull; --force overrides
  freshRelease();
  writeFileSync(join(home, 'install.json'), JSON.stringify({ source: 'clone', version: BRIDGE_VERSION }));
  writeFileSync(join(home, 'grip-bridge.mjs'), 'CLONE BRIDGE');
  const cl = await run(['update', '--yes']);
  assert.strictEqual(cl.code, 0, cl.err);
  assert.match(cl.out, /developer install/);
  assert.match(cl.out, /git pull && node bridge\/install\.mjs/);
  assert.strictEqual(readFileSync(join(home, 'grip-bridge.mjs'), 'utf8'), 'CLONE BRIDGE', 'clone install untouched by update --yes');
  const clchk = await run(['update', '--check']);
  assert.match(clchk.out, /Update available/, 'check still reports availability');
  assert.match(clchk.out, /git pull && node bridge\/install\.mjs/);
  const forced = await run(['update', '--yes', '--force']);
  assert.strictEqual(forced.code, 0, forced.err);
  assert.match(forced.out, /Updated/);
  assert.strictEqual(readFileSync(join(home, 'grip-bridge.mjs'), 'utf8'), release.bridge.toString(), '--force overwrote it');
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
  }
}

// ---------------------------------------------------------------- 10. nothing leaked into the real home
assert.ok(process.env.GRIP_HOME.startsWith(tmpdir()), 'tests only ever used temp dirs');

server.close();
other.close();
console.log('update.mjs OK');
