// Flavour file validation + generator CLI.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..', '..');
const script = join(repo, 'scripts', 'gen-flavour.mjs');
const { loadFlavour } = await import(script);

const realDir = join(repo, 'flavour');
const altDir = join(here, 'fixtures', 'flavour-alt');
const tmp = mkdtempSync(join(tmpdir(), 'flavour-test-'));

assert.equal(loadFlavour(realDir).slug, 'grip');
assert.equal(loadFlavour(altDir).slug, 'acme');

function variant(name, mutate) {
  const d = join(tmp, name);
  mkdirSync(d, { recursive: true });
  const f = JSON.parse(readFileSync(join(realDir, 'flavour.json'), 'utf8'));
  mutate(f);
  writeFileSync(join(d, 'flavour.json'), JSON.stringify(f));
  return d;
}
function rejects(name, mutate, field) {
  const d = variant(name, mutate);
  assert.throws(() => loadFlavour(d), (e) => e instanceof Error && e.message.includes(field), name);
}
rejects('missing-ws', (f) => { delete f.wsPort; }, 'wsPort');
rejects('str-ws', (f) => { f.wsPort = '7777'; }, 'wsPort');
rejects('same-port', (f) => { f.httpPort = f.wsPort; }, 'httpPort');
rejects('bad-slug', (f) => { f.slug = 'Bad Slug'; }, 'slug');
rejects('missing-keys', (f) => { delete f.releaseKeys; }, 'releaseKeys');
rejects('empty-keys', (f) => { f.releaseKeys = []; }, 'releaseKeys');
rejects('keys-not-array', (f) => { f.releaseKeys = 'x'; }, 'releaseKeys');
rejects('key-not-pem', (f) => { f.releaseKeys = ['not a pem']; }, 'releaseKeys');
rejects('key-rsa', (f) => { f.releaseKeys = [generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' })]; }, 'releaseKeys');
assert.equal(loadFlavour(altDir).releaseKeys.length, 1);
// exactly ONE public PEM block per entry: no private key, second block or junk riding along
{ const pub = (generateKeyPairSync('ed25519').publicKey).export({ type: 'spki', format: 'pem' });
  const priv = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  rejects('key-public-then-private', (f) => { f.releaseKeys = [pub + priv]; }, 'releaseKeys');
  rejects('key-two-public', (f) => { f.releaseKeys = [pub + pub]; }, 'releaseKeys');
  rejects('key-trailing-junk', (f) => { f.releaseKeys = [pub + 'junk\n']; }, 'releaseKeys');
  rejects('key-leading-junk', (f) => { f.releaseKeys = ['junk\n' + pub]; }, 'releaseKeys');
  assert.equal(loadFlavour(variant('key-padded', (f) => { f.releaseKeys = ['\n' + pub + '\n']; })).releaseKeys.length, 1, 'surrounding whitespace is fine'); }
{ // the generator's copy of the MCP name rule must equal the installer's
  const { MCP_NAME_RE } = await import('../dist/mcp-name.js');
  const gen = readFileSync(script, 'utf8').match(/const MCP_NAME_RE = (\/.*\/);/)[1];
  assert.equal(gen, String(MCP_NAME_RE), 'gen-flavour MCP_NAME_RE matches mcp-name.ts'); }
// a locked flavour must name a GitHub releases URL, or its download pin would be silently absent
rejects('locked-non-github', (f) => { f.lockOverrides = true; f.releasesApi = 'https://example.invalid/acme/releases/latest'; }, 'releasesApi');
rejects('locked-github-query', (f) => { f.lockOverrides = true; f.releasesApi = 'https://api.github.com/repos/o/r/releases/latest?x=1'; }, 'releasesApi');
assert.equal(loadFlavour(variant('locked-github', (f) => { f.lockOverrides = true; f.releasesApi = 'https://api.github.com/repos/acme-example/acme/releases/latest'; })).lockOverrides, true);
assert.equal(loadFlavour(variant('unlocked-any-url', (f) => { f.lockOverrides = false; f.releasesApi = 'https://example.invalid/x'; })).releasesApi, 'https://example.invalid/x', 'an unlocked flavour may point anywhere');
{ // the generator's GitHub-shape rule must agree with update-policy.ts downloadPrefixFor
  const { downloadPrefixFor } = await import('../dist/update-policy.js');
  const { isGithubReleasesApi } = await import(script);
  for (const u of ['https://api.github.com/repos/o/r/releases/latest', 'https://api.github.com/repos/o/r/releases/latest/', 'https://API.github.com/repos/O.x/r_y-z/releases/latest',
    'https://example.invalid/x', 'http://api.github.com/repos/o/r/releases/latest', 'https://api.github.com:8443/repos/o/r/releases/latest',
    'https://u:p@api.github.com/repos/o/r/releases/latest', 'https://api.github.com/repos/o/r/releases/latest#x', 'https://api.github.com/repos/o/releases/latest',
    'https://api.github.com.evil.test/repos/o/r/releases/latest', 'not a url']) {
    assert.equal(isGithubReleasesApi(u), downloadPrefixFor(u) !== null, u);
  }
}
{ // the plugin's generated flavour carries no release key (it never uses one); the bridge's does
  const out = join(tmp, 'gen-keys');
  execFileSync('node', [script, '--dir', altDir, '--out-bridge', join(out, 'b.ts'), '--out-plugin', join(out, 'p.ts'), '--out-plugin-dir', join(out, 'fp')], { stdio: 'pipe' });
  assert.ok(readFileSync(join(out, 'b.ts'), 'utf8').includes('BEGIN PUBLIC KEY'), 'bridge flavour keeps releaseKeys');
  const p = readFileSync(join(out, 'p.ts'), 'utf8');
  assert.ok(!p.includes('BEGIN PUBLIC KEY') && !p.includes('releaseKeys'), 'plugin flavour has no releaseKeys');
  assert.ok(p.includes('pagesUrl'), 'plugin flavour keeps what the plugin uses');
}
rejects('mcp-name-space', (f) => { f.mcpName = 'a b'; }, 'mcpName');
rejects('plugin-id-letters', (f) => { f.pluginId = 'abc'; }, 'pluginId');
{ const kp = generateKeyPairSync('ed25519');
  rejects('key-private', (f) => { f.releaseKeys = [kp.privateKey.export({ type: 'pkcs8', format: 'pem' })]; }, 'releaseKeys');
  rejects('key-object', (f) => { f.releaseKeys = [{ key: kp.publicKey.export({ type: 'spki', format: 'pem' }), format: 'pem' }]; }, 'releaseKeys');
  rejects('key-jwk', (f) => { f.releaseKeys = [kp.publicKey.export({ format: 'jwk' })]; }, 'releaseKeys'); }
rejects('extra', (f) => { f.bogusKey = 1; }, 'bogusKey');
// names that reach AppleScript, plist XML, shell and paths: safe characters only
for (const k of ['filePrefix', 'homeDirName', 'ipcName', 'launchLabel', 'daemonBundleId']) {
  for (const [tag, bad] of [['quote', 'a"b'], ['squote', "a'b"], ['space', 'a b'], ['slash', 'a/b'], ['lt', 'a<b'], ['amp', 'a&b'], ['dollar', 'a$b'], ['backslash', 'a\\b'], ['newline', 'a\nb'], ['dotdot', '..'], ['dot', '.']]) {
    rejects(`${k}-${tag}`, (f) => { f[k] = bad; }, k);
  }
}
for (const [tag, bad] of [['quote', 'Grip "D"'], ['squote', "Grip's"], ['slash', 'a/b'], ['lt', 'a<b'], ['amp', 'a&b'], ['backslash', 'a\\b'], ['newline', 'a\nb'], ['dotdot', '..'], ['lead-space', ' Grip'], ['trail-space', 'Grip ']]) {
  rejects(`daemonAppName-${tag}`, (f) => { f.daemonAppName = bad; }, 'daemonAppName');
}
// the allowed shapes still load
assert.equal(loadFlavour(variant('ok-names', (f) => { f.daemonAppName = 'My App_2.0-x'; f.homeDirName = '.my_home-2'; f.launchLabel = 'com.x-y.z_1'; })).daemonAppName, 'My App_2.0-x');

const outB = join(tmp, 'out', 'bridge.gen.ts');
const outP = join(tmp, 'out', 'plugin.gen.ts');
const outDir = join(tmp, 'out', 'figma-plugin');
execFileSync('node', [script, '--dir', altDir, '--out-bridge', outB, '--out-plugin', outP, '--out-plugin-dir', outDir], { stdio: 'pipe' });
for (const o of [outB, outP]) {
  assert.ok(existsSync(o), o);
  assert.match(readFileSync(o, 'utf8'), /slug: 'acme'/);
}
// the bridge file is an ES module ...
assert.match(readFileSync(outB, 'utf8'), /export interface Flavour/);
assert.match(readFileSync(outB, 'utf8'), /export const FLAVOUR/);
// ... the plugin file the same values as a global script (tsc outFile, no module syntax)
const pluginGen = readFileSync(outP, 'utf8');
assert.ok(!/\b(export|import)\b/.test(pluginGen), 'the plugin flavour file has no module syntax');
assert.match(pluginGen, /^const FLAVOUR: Flavour = /m);
// the same values, minus the release keys (the plugin never verifies a release)
assert.equal(pluginGen.replace(/^interface /m, 'export interface ').replace(/^const FLAVOUR/m, 'export const FLAVOUR'), readFileSync(outB, 'utf8').replace(/^  (releaseKeys|payloadLoader): .*\n/gm, '').replace(/^export interface WatchEntry \{[\s\S]*?\n\}\n\n/m, '').replace(/^  (watchlist|enforcement): .*\n/gm, ''));
// templates rendered, no placeholder left
for (const n of ['ui.html', 'manifest.json']) assert.ok(!/__[A-Z][A-Z0-9_]*__/.test(readFileSync(join(outDir, n), 'utf8')), n);
// a placeholder the generator does not know is an error
const { renderTemplate } = await import(script);
assert.throws(() => renderTemplate('x.html', 'a __NOPE__ b', loadFlavour(altDir)), /__NOPE__/);
assert.equal(renderTemplate('x', 'ws://localhost:__WS_PORT__ __FLAVOUR__', loadFlavour(altDir)), 'ws://localhost:7877 acme');
{ // the CLI runs through a symlinked path to the script and still writes its outputs
  const linkDir = mkdtempSync(join(tmpdir(), 'flavour-link-'));
  const link = join(linkDir, 'gen-flavour-link.mjs');
  symlinkSync(script, link);
  const o = mkdtempSync(join(tmpdir(), 'flavour-linkout-'));
  execFileSync(process.execPath, [link, '--dir', altDir, '--out-bridge', join(o, 'b.ts'), '--out-plugin', join(o, 'p.ts'), '--out-plugin-dir', join(o, 'pd')]);
  for (const f of ['b.ts', 'p.ts', 'pd/ui.html', 'pd/manifest.json']) assert.ok(existsSync(join(o, f)), `symlinked run wrote ${f}`);
}
// a small-order key (the identity point) must never be pinned, loader or not
{
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from('01' + '00'.repeat(31), 'hex')]);
  const pem = `-----BEGIN PUBLIC KEY-----\n${spki.toString('base64')}\n-----END PUBLIC KEY-----\n`;
  rejects('key-small-order', (f) => { f.releaseKeys = [pem]; }, 'releaseKeys');
  rejects('key-small-order-second-slot', (f) => { f.releaseKeys = [f.releaseKeys[0], pem]; }, 'releaseKeys');
}
// payloadLoader (phase 3)
rejects('loader-missing', (f) => { delete f.payloadLoader; }, 'payloadLoader');
rejects('loader-string', (f) => { f.payloadLoader = 'yes'; }, 'payloadLoader');
rejects('loader-unlocked', (f) => { f.payloadLoader = true; f.lockOverrides = false; }, 'lockOverrides');
assert.equal(loadFlavour(altDir).payloadLoader, true);
assert.equal(loadFlavour(realDir).payloadLoader, false);
{
  const { renderFlavourGlobal, renderFlavour } = await import(script);
  assert.ok(!renderFlavourGlobal(loadFlavour(altDir)).includes('payloadLoader'), 'the plugin global FLAVOUR never carries payloadLoader (it is compiled into code.js)');
  assert.ok(renderFlavour(loadFlavour(altDir)).includes('payloadLoader'), 'the bridge flavour does');
}
// ---- phase 2B: watchlist + enforcement
{
  const ent = () => JSON.parse(JSON.stringify(loadFlavour(altDir).watchlist[0]));
  const alert = (f, mut) => { f.enforcement = 'alert'; f.watchlist = [ent()]; if (mut) mut(f.watchlist[0], f); };
  rejects('wl-missing', (f) => { delete f.watchlist; }, 'watchlist');
  rejects('enf-missing', (f) => { delete f.enforcement; }, 'enforcement');
  rejects('enf-block', (f) => { f.enforcement = 'block'; }, 'enforcement');
  rejects('enf-alert-empty', (f) => { f.enforcement = 'alert'; f.watchlist = []; }, 'watchlist');
  rejects('wl-missing-floor', (f) => alert(f, (e) => { delete e.minSecureVersion; }), 'minSecureVersion');
  rejects('wl-extra', (f) => alert(f, (e) => { e.x = 1; }), 'watchlist');
  rejects('wl-floor-short', (f) => alert(f, (e) => { e.minSecureVersion = '0.9'; }), 'minSecureVersion');
  rejects('wl-own-slug', (f) => alert(f, (e, ff) => { e.slug = ff.slug; }), 'slug');
  rejects('wl-dup-slug', (f) => { alert(f); f.watchlist.push({ ...ent(), wsPort: 7990, httpPort: 7991 }); }, 'slug');
  rejects('wl-own-ws', (f) => alert(f, (e, ff) => { e.wsPort = ff.wsPort; }), 'wsPort');
  rejects('wl-own-http', (f) => alert(f, (e, ff) => { e.httpPort = ff.httpPort; }), 'httpPort');
  rejects('wl-same-ports', (f) => alert(f, (e) => { e.httpPort = e.wsPort; }), 'httpPort');
  rejects('wl-home-dotdot', (f) => alert(f, (e) => { e.homeDirName = '..'; }), 'homeDirName');
  rejects('wl-home-slash', (f) => alert(f, (e) => { e.homeDirName = 'a/b'; }), 'homeDirName');
  rejects('wl-home-own', (f) => alert(f, (e, ff) => { e.homeDirName = ff.homeDirName; }), 'homeDirName');
  rejects('wl-mcp-space', (f) => alert(f, (e) => { e.mcpName = 'a b'; }), 'mcpName');
  // every name a removal deletes must differ from OUR build's, case-insensitively
  const own = (f) => ({ home: f.homeDirName, item: f.daemonAppName, status: `${f.filePrefix}.status`, log: `${f.filePrefix}.log`, ipc: f.ipcName, label: f.launchLabel, unit: `${f.slug}-bridge`, vbs: `${f.daemonAppName.replace(/\s+/g, '')}.vbs` });
  for (const [field, key, fn] of [['homeDirName', 'home', (s) => s.toUpperCase()], ['loginItem', 'item', (s) => s.toLowerCase()], ['statusFile', 'status', (s) => s], ['logFile', 'log', (s) => s.toUpperCase()],
    ['ipcName', 'ipc', (s) => s], ['launchLabel', 'label', (s) => s.toUpperCase()], ['serviceName', 'unit', (s) => s], ['startupLauncher', 'vbs', (s) => s.toLowerCase()]]) {
    rejects(`wl-own-${field}`, (f) => alert(f, (e, ff) => { e[field] = fn(own(ff)[key]); }), field);
  }
  assert.equal(loadFlavour(altDir).watchlist[0].slug, 'zenith');
  assert.equal(loadFlavour(altDir).enforcement, 'alert');
  // the shipped public flavour watches nothing
  const pub = loadFlavour(realDir);
  assert.equal(pub.enforcement, 'off');
  assert.equal(pub.watchlist.length, 0);
  // the watchlist reaches the bridge's flavour file but never the plugin's
  const o = join(tmp, 'gen-wl');
  execFileSync('node', [script, '--dir', altDir, '--out-bridge', join(o, 'b.ts'), '--out-plugin', join(o, 'p.ts'), '--out-plugin-dir', join(o, 'fp')], { stdio: 'pipe' });
  assert.match(readFileSync(join(o, 'b.ts'), 'utf8'), /export interface WatchEntry/);
  assert.match(readFileSync(join(o, 'b.ts'), 'utf8'), /watchlist: Object\.freeze\(/);
}
console.log('flavour: ok');
