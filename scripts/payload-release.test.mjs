// Release plumbing of a payloadLoader flavour (phase 3): packaging, release gate, signing check,
// notices, hygiene file list, workflow step. Run: node --test scripts/payload-release.test.mjs
// Needs `npm run build` first for the public cases (the root `npm test` builds).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { packageRelease, checkLockstep, PackageError } from './package-release.mjs';
import { REQUIRED_ASSETS, requiredAssets, isCompleteRelease } from './release-gate.mjs';
import { signSums, SignError, SUMS_NAME } from './sign-release.mjs';
import { buildEnvelope, signEnvelope, PAYLOAD_NAME } from './payload.mjs';
import { buildNotices } from './third-party-notices.mjs';
import { defaultFiles, DEFAULT_FILES, LOADER_FILES } from './bundle-hygiene.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const pem = (k, t) => k.export({ type: t, format: 'pem' });
const SIG_ASSET = 'SHA256SUMS.txt.sig';

// ---- release gate ----

test('requiredAssets: the payload asset only for a loader flavour', () => {
  assert.deepEqual(requiredAssets({ payloadLoader: false }), REQUIRED_ASSETS);
  assert.deepEqual(requiredAssets({}), REQUIRED_ASSETS);
  const loader = requiredAssets({ payloadLoader: true });
  assert.equal(loader.length, REQUIRED_ASSETS.length + 1);
  assert.ok(loader.includes('grip-plugin-payload.json'));
  assert.equal(REQUIRED_ASSETS.length, 9, 'the public list is unchanged');
});

test('isCompleteRelease honours the required list', () => {
  const rel = { isDraft: false, assets: REQUIRED_ASSETS.map((name) => ({ name })) };
  assert.equal(isCompleteRelease(rel), true);
  assert.equal(isCompleteRelease(rel, requiredAssets({ payloadLoader: true })), false);
  rel.assets.push({ name: 'grip-plugin-payload.json' });
  assert.equal(isCompleteRelease(rel, requiredAssets({ payloadLoader: true })), true);
});

// ---- packaging ----

function scratchRoot() {
  const r = tmp('grip-root-');
  for (const rel of ['bridge/grip-bridge.mjs', 'bridge/install.mjs', 'bridge/THIRD-PARTY-NOTICES.txt', 'figma-plugin/manifest.json', 'figma-plugin/code.js', 'figma-plugin/ui.html',
    'src/bridge/src/types.ts', 'src/bridge/package.json', 'src/plugin/package.json', 'src/plugin/code.ts', 'flavour/flavour.json']) {
    mkdirSync(join(r, dirname(rel)), { recursive: true });
    cpSync(join(ROOT, rel), join(r, rel));
  }
  return r;
}
function loaderRoot(over = {}) {
  const r = scratchRoot();
  const f = JSON.parse(readFileSync(join(ROOT, 'src', 'bridge', 'test', 'fixtures', 'flavour-alt', 'flavour.json'), 'utf8'));
  writeFileSync(join(r, 'flavour', 'flavour.json'), JSON.stringify(f));
  const version = checkLockstep(r);
  const env = buildEnvelope({ shellProtocol: 1, flavour: 'acme', version, ...(over.header || {}) }, 'var plugin = 1;', '');
  mkdirSync(join(r, 'build', 'payload'), { recursive: true });
  if (!over.missing) writeFileSync(join(r, 'build', 'payload', 'payload.json'), JSON.stringify(env));
  writeFileSync(join(r, 'figma-plugin', 'code.js'), '// Grip loader shell, main thread\n');   // the shell carries no release version
  return r;
}

test('loader flavour: the payload is an asset, is listed in the sums, and is in the zip; output is deterministic', () => {
  const r = loaderRoot();
  const a = tmp('grip-pkg-'), b = tmp('grip-pkg-');
  packageRelease({ root: r, out: a });
  packageRelease({ root: r, out: b });
  assert.deepEqual(readdirSync(a).sort(), [...REQUIRED_ASSETS.filter((n) => n !== SIG_ASSET), PAYLOAD_NAME].sort());
  const payload = readFileSync(join(r, 'build', 'payload', 'payload.json'));
  assert.ok(readFileSync(join(a, PAYLOAD_NAME)).equals(payload));
  assert.ok(readFileSync(join(a, 'SHA256SUMS.txt'), 'utf8').includes(`${sha(payload)}  ${PAYLOAD_NAME}`));
  assert.ok(readFileSync(join(a, 'grip-install.zip')).includes(Buffer.from('grip/figma-plugin/payload.json')), 'the zip lists payload.json');
  for (const n of readdirSync(a)) assert.ok(readFileSync(join(a, n)).equals(readFileSync(join(b, n))), `${n} identical across runs`);
});

test('loader flavour: a missing payload, a payload of another version or flavour, or a bad layout fails', () => {
  assert.throws(() => packageRelease({ root: loaderRoot({ missing: true }), out: tmp('grip-pkg-') }), /missing build\/payload\/payload\.json; run `node scripts\/payload\.mjs`/);
  assert.throws(() => packageRelease({ root: loaderRoot({ header: { version: '0.0.1' } }), out: tmp('grip-pkg-') }), /payload header version/);
  assert.throws(() => packageRelease({ root: loaderRoot({ header: { flavour: 'grip' } }), out: tmp('grip-pkg-') }), /payload flavour/);
  const r = loaderRoot();
  writeFileSync(join(r, 'build', 'payload', 'payload.json'), '{"layout":2}');
  assert.throws(() => packageRelease({ root: r, out: tmp('grip-pkg-') }), PackageError);
});

test('a public flavour never packages a payload, even when one is lying around', () => {
  const r = scratchRoot();
  mkdirSync(join(r, 'build', 'payload'), { recursive: true });
  writeFileSync(join(r, 'build', 'payload', 'payload.json'), '{}');
  const out = tmp('grip-pkg-');
  packageRelease({ root: r, out });
  assert.ok(!existsSync(join(out, PAYLOAD_NAME)));
  assert.equal(readdirSync(out).length, 8);
});

// ---- signing check ----

function signScratch({ signed = true, tamperSums = false, wrongKey = false } = {}) {
  const k = generateKeyPairSync('ed25519');
  const root = tmp('grip-sign-root-');
  mkdirSync(join(root, 'flavour'));
  writeFileSync(join(root, 'flavour', 'flavour.json'), JSON.stringify({ slug: 'acme', payloadLoader: true, releaseKeys: [pem(k.publicKey, 'spki')] }));
  const dir = tmp('grip-sign-dist-');
  let env = buildEnvelope({ shellProtocol: 1, flavour: 'acme', version: '1.0.0' }, 'var a;', '');
  if (signed) env = signEnvelope(env, pem((wrongKey ? generateKeyPairSync('ed25519') : k).privateKey, 'pkcs8'), wrongKey ? [] : [createPublicKey(pem(k.publicKey, 'spki'))]);
  writeFileSync(join(dir, PAYLOAD_NAME), JSON.stringify(env));
  writeFileSync(join(dir, SUMS_NAME), `${sha(tamperSums ? 'other' : readFileSync(join(dir, PAYLOAD_NAME)))}  ${PAYLOAD_NAME}\n`);
  return { root, dir, key: pem(k.privateKey, 'pkcs8') };
}

test('sign-release: a loader flavour needs a signed payload that matches the sums', () => {
  const ok = signScratch();
  assert.doesNotThrow(() => signSums({ root: ok.root, dir: ok.dir, keyPem: ok.key }));
  const unsigned = signScratch({ signed: false });
  assert.throws(() => signSums({ root: unsigned.root, dir: unsigned.dir, keyPem: unsigned.key }), (e) => e instanceof SignError && /not signed/.test(e.message));
  assert.throws(() => { const s = signScratch(); writeFileSync(join(s.dir, PAYLOAD_NAME), readFileSync(join(s.dir, PAYLOAD_NAME), 'utf8').replace('var a;', 'var b;')); signSums({ root: s.root, dir: s.dir, keyPem: s.key }); }, (e) => e instanceof SignError && /does not verify/.test(e.message), 'a tampered payload');
  const other = signScratch();
  const foreign = JSON.parse(readFileSync(join(signScratch().dir, PAYLOAD_NAME), 'utf8'));
  writeFileSync(join(other.dir, PAYLOAD_NAME), JSON.stringify(foreign));
  assert.throws(() => signSums({ root: other.root, dir: other.dir, keyPem: other.key }), SignError, 'signed by another key');
  const stale = signScratch({ tamperSums: true });
  assert.throws(() => signSums({ root: stale.root, dir: stale.dir, keyPem: stale.key }), (e) => e instanceof SignError && /does not list/.test(e.message));
  const gone = signScratch();
  writeFileSync(join(gone.dir, PAYLOAD_NAME), 'not json');
  assert.throws(() => signSums({ root: gone.root, dir: gone.dir, keyPem: gone.key }), SignError);
});

test('sign-release: the public flavour does not look at a payload', () => {
  const k = generateKeyPairSync('ed25519');
  const root = tmp('grip-sign-root-');
  mkdirSync(join(root, 'flavour'));
  writeFileSync(join(root, 'flavour', 'flavour.json'), JSON.stringify({ slug: 'x', payloadLoader: false, releaseKeys: [pem(k.publicKey, 'spki')] }));
  const dir = tmp('grip-sign-dist-');
  writeFileSync(join(dir, SUMS_NAME), `${'a'.repeat(64)}  compat.json\n`);
  assert.doesNotThrow(() => signSums({ root, dir, keyPem: pem(k.privateKey, 'pkcs8') }));
});

// ---- notices ----

function pkgFixture(pkgs) {
  const dir = tmp('grip-tpn-');
  const lock = { lockfileVersion: 3, packages: { '': { name: 'root' } } };
  for (const [key, p] of Object.entries(pkgs)) {
    lock.packages[key] = { version: '1.0.0', ...(p.dev ? { dev: true } : {}) };
    mkdirSync(join(dir, key), { recursive: true });
    writeFileSync(join(dir, key, 'package.json'), JSON.stringify({ name: key.slice(13), version: '1.0.0', license: p.license }));
    writeFileSync(join(dir, key, 'LICENSE'), p.text);
  }
  return { dir, lock };
}

test('notices: a loader flavour adds the plugin lock, tagged; without it the output is the old one', () => {
  const bridge = pkgFixture({ 'node_modules/ws': { license: 'MIT', text: 'ws license' } });
  const plugin = pkgFixture({ 'node_modules/noble': { license: 'MIT', text: 'noble license' }, 'node_modules/devtool': { dev: true, license: 'GPL-3.0', text: 'x' } });
  const plain = buildNotices(bridge.lock, bridge.dir);
  assert.match(plain.text, /The Figma plugin bundles no third-party code\./);
  assert.ok(!plain.text.includes('(plugin)') && !plain.text.includes('noble'));
  const both = buildNotices(bridge.lock, bridge.dir, { pluginLock: plugin.lock, pluginLockDir: plugin.dir });
  assert.equal(both.count, 2);
  assert.match(both.text, /\nnoble 1\.0\.0 \(MIT\) \(plugin\)\n/);
  assert.match(both.text, /The Figma plugin shell \(ui\.html\) bundles the open source packages marked \(plugin\) below\./);
  assert.ok(!both.text.includes('The Figma plugin bundles no third-party code.'));
  const bad = pkgFixture({ 'node_modules/copyleft': { license: 'GPL-3.0', text: 'x' } });
  assert.ok(buildNotices(bridge.lock, bridge.dir, { pluginLock: bad.lock, pluginLockDir: bad.dir }).problems.length === 1, 'the allowlist gates the plugin lock too');
});

test('the real plugin lockfile lists the two verifier packages as production MIT dependencies', () => {
  const lock = JSON.parse(readFileSync(join(ROOT, 'src', 'plugin', 'package-lock.json'), 'utf8'));
  for (const [name, version] of [['@noble/ed25519', '2.1.0'], ['@noble/hashes', '1.5.0']]) {
    const e = lock.packages[`node_modules/${name}`];
    assert.equal(e.version, version);
    assert.ok(!e.dev, `${name} is a production dependency (so the notices cover it)`);
    assert.equal(e.license, 'MIT');
  }
});

// ---- hygiene ----

test('hygiene: a loader flavour also checks the shell page and the payload', () => {
  assert.deepEqual(defaultFiles({ payloadLoader: false }), DEFAULT_FILES);
  assert.deepEqual(defaultFiles({ payloadLoader: true }), [...DEFAULT_FILES, ...LOADER_FILES]);
  assert.deepEqual(LOADER_FILES, ['figma-plugin/ui.html', 'build/payload/payload.json']);
});

// ---- workflow ----

test('release.yml builds and signs the payload with the secret, after the build and before hygiene and packaging', () => {
  const yml = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  const at = (name) => yml.indexOf(`- name: ${name}`);
  const step = at('Build and sign plugin payload');
  assert.ok(step > at('Build bundles and third-party notices'));
  assert.ok(step < at('Bundle hygiene') && step < at('Package'));
  const body = yml.slice(step, at('Bundle hygiene'));
  assert.match(body, /GRIP_RELEASE_SIGNING_KEY: \$\{\{ secrets\.GRIP_RELEASE_SIGNING_KEY \}\}/);
  assert.match(body, /node scripts\/payload\.mjs/);
});

test('release.yml publish job handles the payload asset for a loader flavour (check, recover upload, recomputed sums)', () => {
  const yml = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  const pub = yml.slice(yml.indexOf('- name: Publish'));
  const at = pub.indexOf('ASSETS="grip-bridge.mjs');
  assert.ok(at >= 0);
  const guard = pub.indexOf('payloadLoader === true', at);
  assert.ok(guard > at, 'the ASSETS list grows for a loader flavour');
  assert.ok(pub.slice(guard, guard + 200).includes('ASSETS="$ASSETS grip-plugin-payload.json"'));
  // everything that iterates the list comes after the guard, so check, recover upload and the sums all see it
  for (const use of ['for asset in $ASSETS', 'for n in $ASSETS; do', 'printf \'%s\\n\' $ASSETS']) {
    assert.ok(pub.indexOf(use) > guard, `${use} sees the payload asset`);
  }
});
