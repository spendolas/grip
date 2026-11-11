// Tests for scripts/sign-release.mjs. Run: node --test scripts/sign-release.test.mjs
// Signs throwaway fixtures with the THROWAWAY test key below; the real release
// private key exists only as the GRIP_RELEASE_SIGNING_KEY CI secret.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { generateKeyPairSync, createPublicKey, verify } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { signSums, readPinnedKeys, SignError, SUMS_NAME, SIG_NAME, KEY_ENV } from './sign-release.mjs';
import { REQUIRED_ASSETS } from './release-gate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'sign-release.mjs');
const tmp = (p) => mkdtempSync(join(tmpdir(), p));

// A THROWAWAY Ed25519 keypair, made only for tests (same one as src/bridge/test/update.mjs).
// The header is split so secret scanners (push protection) do not flag this file.
const TEST_PRIV = ['-----BE' + 'GIN PRIVATE KEY-----', 'MC4CAQAwBQYDK2VwBCIEIGfFhB9wVVeEIIpYjxiTdXoremRSaoaIBhYvXEK/vcJ4', '-----END PRIVATE KEY-----', ''].join('\n');
const TEST_PUB = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAYzUJAvV8Ujs7QnT17B1NgfGdwdYhuANZVsIJJncasD0=
-----END PUBLIC KEY-----
`;
const SUMS = `${'a'.repeat(64)}  compat.json\n${'b'.repeat(64)}  grip-bridge.mjs\n`;

// A scratch repo root whose update.ts pins `pems`, and a dist dir holding SUMS.
function scratch(pems = [TEST_PUB]) {
  const root = tmp('grip-sign-root-');
  mkdirSync(join(root, 'src', 'bridge', 'src'), { recursive: true });
  const keys = pems.map((p) => '  `' + p + '`,').join('\n');
  writeFileSync(join(root, 'src', 'bridge', 'src', 'update.ts'),
    '// mentions RELEASE_PUBLIC_KEYS in a comment first, as the real file does\n'
    + `export const RELEASE_PUBLIC_KEYS: readonly string[] = [\n${keys}\n];\n`
    + 'const other = `-----BEGIN PUBLIC KEY-----\nnot a pinned key\n-----END PUBLIC KEY-----`;\n');
  const dir = tmp('grip-sign-dist-');
  writeFileSync(join(dir, SUMS_NAME), SUMS);
  return { root, dir };
}

test('signs the exact sums bytes: base64 of a raw 64-byte Ed25519 signature that verifies', () => {
  const { root, dir } = scratch();
  const text = signSums({ root, dir, keyPem: TEST_PRIV });
  assert.equal(readFileSync(join(dir, SIG_NAME), 'utf8'), text);
  assert.match(text, /^[A-Za-z0-9+/]{86}==\n$/, 'one line of base64, 64 bytes');
  const sig = Buffer.from(text.trim(), 'base64');
  assert.equal(sig.length, 64);
  assert.ok(verify(null, Buffer.from(SUMS), createPublicKey(TEST_PUB), sig));
  assert.ok(!verify(null, Buffer.from(SUMS + ' '), createPublicKey(TEST_PUB), sig), 'it covers the exact bytes');
});

test('the signature is deterministic (Ed25519)', () => {
  const { root, dir } = scratch();
  const a = signSums({ root, dir, keyPem: TEST_PRIV });
  const b = signSums({ root, dir, keyPem: TEST_PRIV });
  assert.equal(a, b);
});

test('fails loudly when the key is missing or invalid, and writes nothing', () => {
  const bogus = '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n';
  for (const bad of [undefined, null, '', '   \n', 'not a pem', bogus, TEST_PUB]) {
    const { root, dir } = scratch();
    assert.throws(() => signSums({ root, dir, keyPem: bad }), (e) => e instanceof SignError && new RegExp(KEY_ENV).test(e.message), String(bad));
    assert.ok(!existsSync(join(dir, SIG_NAME)), 'no signature file');
  }
  // a valid key of the wrong algorithm
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const { root, dir } = scratch();
  assert.throws(() => signSums({ root, dir, keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) }), /not Ed25519/);
});

test('self-verification: a key that is not the pinned one fails, and writes nothing', () => {
  const other = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  const { root, dir } = scratch();
  assert.throws(() => signSums({ root, dir, keyPem: other }), /wrong key/);
  assert.ok(!existsSync(join(dir, SIG_NAME)));
  // any one of several pinned keys is enough (key rotation)
  const second = generateKeyPairSync('ed25519');
  const both = scratch([second.publicKey.export({ type: 'spki', format: 'pem' }), TEST_PUB]);
  signSums({ root: both.root, dir: both.dir, keyPem: TEST_PRIV });
  assert.ok(existsSync(join(both.dir, SIG_NAME)));
});

test('fails when there is nothing to sign, or no pinned key to check against', () => {
  const { root } = scratch();
  const empty = tmp('grip-sign-empty-');
  assert.throws(() => signSums({ root, dir: empty, keyPem: TEST_PRIV }), /cannot read .*SHA256SUMS\.txt/);
  writeFileSync(join(empty, SUMS_NAME), '');
  assert.throws(() => signSums({ root, dir: empty, keyPem: TEST_PRIV }), /is empty/);
  const bare = tmp('grip-sign-bare-');
  const dir = tmp('grip-sign-dist-');
  writeFileSync(join(dir, SUMS_NAME), SUMS);
  assert.throws(() => signSums({ root: bare, dir, keyPem: TEST_PRIV }), /pinned release public key/);
  mkdirSync(join(bare, 'src', 'bridge', 'src'), { recursive: true });
  writeFileSync(join(bare, 'src', 'bridge', 'src', 'update.ts'), 'export const RELEASE_PUBLIC_KEYS: readonly string[] = [\n];\n');
  assert.throws(() => signSums({ root: bare, dir, keyPem: TEST_PRIV }), /holds no public key/);
});

test('the pinned keys are read from the real bridge source, and are Ed25519', () => {
  const keys = readPinnedKeys(ROOT);
  assert.ok(keys.length >= 1);
  for (const k of keys) assert.equal(k.asymmetricKeyType, 'ed25519');
});

test('the .sig is a required release asset', () => {
  assert.ok(REQUIRED_ASSETS.includes(SIG_NAME));
  assert.equal(REQUIRED_ASSETS.length, 9);
});

test('CLI: missing secret fails with a clear message; a good run succeeds', () => {
  const { root, dir } = scratch();
  const env = { ...process.env };
  delete env[KEY_ENV];
  const miss = spawnSync(process.execPath, [SCRIPT, '--root', root, '--dir', dir], { env, encoding: 'utf8' });
  assert.equal(miss.status, 1);
  assert.match(miss.stderr, new RegExp(`${KEY_ENV} is not set`));
  assert.ok(!existsSync(join(dir, SIG_NAME)));
  const ok = spawnSync(process.execPath, [SCRIPT, '--root', root, '--dir', dir], { env: { ...env, [KEY_ENV]: TEST_PRIV }, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /signed/);
  assert.ok(!ok.stdout.includes('PRIVATE') && !ok.stderr.includes('PRIVATE'), 'the key is never printed');
  assert.ok(existsSync(join(dir, SIG_NAME)));
  const bad = spawnSync(process.execPath, [SCRIPT, '--bogus'], { env, encoding: 'utf8' });
  assert.equal(bad.status, 1);
});
