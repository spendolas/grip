import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createPublicKey, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signingMessage, buildEnvelope, signEnvelope, verifyEnvelope, PayloadError, PAYLOAD_NAME, PAYLOAD_LAYOUT } from './payload.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const H = { shellProtocol: 1, flavour: 'acme', version: '0.9.7' };
const kp = () => generateKeyPairSync('ed25519');
const pem = (k, t) => k.export({ type: t, format: 'pem' });

test('constants', () => {
  assert.equal(PAYLOAD_LAYOUT, 1);
  assert.equal(PAYLOAD_NAME, 'grip-plugin-payload.json');
});

test('signing message uses byte lengths and fixed framing', () => {
  const m = signingMessage(H, 'ab', 'é');
  assert.deepEqual(m, Buffer.concat([Buffer.from('grip-payload|1|1|acme|0.9.7|2|2\n'), Buffer.from('ab'), Buffer.from('é')]));
});

test('round trip, and every tampered or foreign case is rejected', () => {
  const a = kp(), b = kp();
  const keysA = [createPublicKey(pem(a.publicKey, 'spki'))];
  const env = signEnvelope(buildEnvelope(H, 'console.log(1)', 'x=1'), pem(a.privateKey, 'pkcs8'), keysA);
  assert.deepEqual(verifyEnvelope(env, keysA), { ok: true });
  const bad = (m, code, expect) => assert.deepEqual(verifyEnvelope(m(structuredClone(env)), keysA, expect), { ok: false, code });
  bad((e) => { e.code += ' '; return e; }, 'bad_signature');
  bad((e) => { e.ui += ' '; return e; }, 'bad_signature');
  bad((e) => { e.header.version = '0.9.8'; return e; }, 'bad_signature');
  bad((e) => { e.header.flavour = 'grip'; return e; }, 'bad_signature');
  bad((e) => { e.header.shellProtocol = 2; return e; }, 'bad_signature');
  bad((e) => { e.code = e.code.slice(0, -1); return e; }, 'bad_signature');          // truncated
  bad((e) => { e.code += 'x'.repeat(100000); return e; }, 'bad_signature');          // oversize / appended
  bad((e) => { e.sig = Buffer.alloc(63).toString('base64'); return e; }, 'bad_signature');
  bad((e) => { e.sig = ''; return e; }, 'bad_signature');
  bad((e) => e, 'bad_flavour', { flavour: 'grip' });
  bad((e) => { e.layout = 2; return e; }, 'bad_format');
  bad((e) => { delete e.header.version; return e; }, 'bad_format');
  bad((e) => { delete e.code; return e; }, 'bad_format');
  bad((e) => { e.header.version = '1.2'; return e; }, 'bad_format');
  assert.deepEqual(verifyEnvelope(env, [createPublicKey(pem(b.publicKey, 'spki'))]), { ok: false, code: 'bad_signature' });
  // a second pinned key (rotation slot): any of the keys may verify
  assert.deepEqual(verifyEnvelope(env, [createPublicKey(pem(b.publicKey, 'spki')), keysA[0]]), { ok: true });
});

test('signEnvelope refuses a key that is not pinned, and a non-Ed25519 key', () => {
  const a = kp(), b = kp();
  const pinned = [createPublicKey(pem(a.publicKey, 'spki'))];
  assert.throws(() => signEnvelope(buildEnvelope(H, 'c', ''), pem(b.privateKey, 'pkcs8'), pinned), PayloadError);
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(() => signEnvelope(buildEnvelope(H, 'c', ''), pem(rsa.privateKey, 'pkcs8'), pinned), PayloadError);
  assert.throws(() => signEnvelope(buildEnvelope(H, 'c', ''), '', pinned), PayloadError);
});

test('buildEnvelope validates the header', () => {
  assert.throws(() => buildEnvelope({ ...H, version: '1.2' }, 'c', ''), PayloadError);
  assert.throws(() => buildEnvelope({ ...H, shellProtocol: 0 }, 'c', ''), PayloadError);
  assert.throws(() => buildEnvelope({ ...H, flavour: 'Bad Slug' }, 'c', ''), PayloadError);
});

function fakeRoot(loader, key) {
  const root = mkdtempSync(join(tmpdir(), 'payload-cli-'));
  const f = JSON.parse(readFileSync(join(repo, 'src', 'bridge', 'test', 'fixtures', 'flavour-alt', 'flavour.json'), 'utf8'));
  f.payloadLoader = loader;
  f.releaseKeys = [pem(key.publicKey, 'spki')];
  mkdirSync(join(root, 'flavour')); writeFileSync(join(root, 'flavour', 'flavour.json'), JSON.stringify(f));
  mkdirSync(join(root, 'build', 'payload'), { recursive: true }); writeFileSync(join(root, 'build', 'payload', 'code.js'), 'var x = 1;');
  mkdirSync(join(root, 'src', 'plugin', 'shell'), { recursive: true });
  writeFileSync(join(root, 'src', 'plugin', 'shell', 'payload-meta.json'), '{"requiresShell":1}');
  mkdirSync(join(root, 'src', 'bridge', 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'bridge', 'src', 'types.ts'), "export const BRIDGE_VERSION = '0.9.7';\n");
  writeFileSync(join(root, 'src', 'bridge', 'package.json'), '{"version":"0.9.7"}');
  writeFileSync(join(root, 'src', 'plugin', 'package.json'), '{"version":"0.9.7"}');
  writeFileSync(join(root, 'src', 'plugin', 'code.ts'), "const PLUGIN_VERSION = '0.9.7';\n");
  return root;
}
const cli = (root, env) => execFileSync(process.execPath, [join(here, 'payload.mjs'), '--root', root], { env: { ...process.env, GRIP_RELEASE_SIGNING_KEY: '', ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('CLI: signs for a loader flavour, writes unsigned without the key, skips the public flavour', () => {
  const k = kp();
  const root = fakeRoot(true, k);
  cli(root, { GRIP_RELEASE_SIGNING_KEY: pem(k.privateKey, 'pkcs8') });
  const env = JSON.parse(readFileSync(join(root, 'build', 'payload', 'payload.json'), 'utf8'));
  assert.equal(env.header.version, '0.9.7');
  assert.equal(env.header.flavour, 'acme');
  assert.deepEqual(verifyEnvelope(env, [createPublicKey(pem(k.publicKey, 'spki'))], { flavour: 'acme' }), { ok: true });
  cli(root, {});
  assert.equal(JSON.parse(readFileSync(join(root, 'build', 'payload', 'payload.json'), 'utf8')).sig, '');
  // the wrong secret fails loudly
  assert.throws(() => cli(root, { GRIP_RELEASE_SIGNING_KEY: pem(kp().privateKey, 'pkcs8') }));
  const pub = fakeRoot(false, k);
  assert.match(cli(pub, {}), /skipped/);
  assert.ok(!existsSync(join(pub, 'build', 'payload', 'payload.json')));
});

test('the committed vector verifies (the UI verifier must agree on it)', () => {
  const v = JSON.parse(readFileSync(join(repo, 'src', 'bridge', 'test', 'fixtures', 'payload-vector.json'), 'utf8'));
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(v.pubHex, 'hex')]);
  const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  const env = { layout: 1, header: v.header, code: v.code, ui: v.ui, sig: v.sigB64 };
  assert.deepEqual(verifyEnvelope(env, [key]), { ok: true });
  assert.equal(createHash('sha256').update(signingMessage(v.header, v.code, v.ui)).digest('hex'), v.messageSha256);
});
