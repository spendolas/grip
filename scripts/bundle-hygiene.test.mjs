// Tests for scripts/bundle-hygiene.mjs. Run: node --test scripts/bundle-hygiene.test.mjs
// Secret-shaped fixtures are assembled at runtime so this file never contains a
// literal token (secret scanners and push protection would flag it).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findProblems, checkFiles, PATTERNS, ALLOWLIST, DEFAULT_FILES } from './bundle-hygiene.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'bundle-hygiene.mjs');
const A = (n, c = 'a') => c.repeat(n);
const ids = (text) => findProblems(text).map((p) => p.id);

const MUST_FLAG = {
  'path-users': ['const p = "/Users/jane/work/grip"', '// built in /Users/ci-runner/x'],
  'path-volumes': ['readFile("/Volumes/Origami/x")'],
  'path-home': ['"/home/runner/work/grip/grip"', 'at /home/jane.doe/app/index.js:3'],
  'path-windows-users': ['"C:\\Users\\jane\\x"', '"C:\\\\Users\\\\jane\\\\x"', 'd:\\Users\\bob'],
  'github-token': ['token=gh' + 'p_' + A(36), 'gh' + 'o_' + A(30, 'B'), 'gh' + 's_' + A(24, '1')],
  'github-pat': ['github' + '_pat_' + A(30, 'Z') + '_' + A(20)],
  'aws-access-key': ['AK' + 'IA' + 'ABCDEFGHIJKLMNOP'],
  'pem-block': ['-----BE' + 'GIN RSA PRIVATE KEY-----', '-----BE' + 'GIN OPENSSH PRIVATE KEY-----', '-----BE' + 'GIN CERTIFICATE-----', '-----BE' + 'GIN PRIVATE KEY-----', '-----BE' + 'GIN EC PRIVATE KEY-----'],
  'anthropic-key': ['sk-' + 'ant-api03-' + A(40)],
  'openai-key': ['sk-' + A(48, 'x')],
  'npm-token': ['npm' + '_' + A(36, 'q')],
  'slack-token': ['xox' + 'b-' + '1234567890-abcdefghij'],
};

const MUST_PASS = [
  'plain text',
  'see /usr/local/bin and /tmp/grip and ~/.grip',
  'a path like users/home/volumes without leading slash',
  'the "/Users/" directory on macOS',          // no user name after it
  'visit /home/ for more',                      // no name + slash
  'C:\\Program Files\\Node',
  'ask-ant-colony, sk-short, sk-', 'npm_config_cache', 'npm_short',
  'github_pat_ and ghp_ alone are not tokens', 'AKIA-too-short', 'XAKIAABCDEFGHIJKLMNOP',
  '----- BEGIN something ----- (spaced, not a PEM header)',
];

test('every pattern id has a flagged fixture', () => {
  assert.deepEqual(Object.keys(MUST_FLAG).sort(), PATTERNS.map((p) => p.id).sort());
});

for (const [id, samples] of Object.entries(MUST_FLAG)) {
  test(`flags ${id}`, () => {
    for (const s of samples) assert.ok(ids(`line one\nx ${s} y\nline three`).includes(id), `${id} should flag: ${s}`);
  });
}

test('reports file line and pattern, one entry per offending pattern', () => {
  const p = findProblems('ok\nconst a = "/Users/jane/x";\nok');
  assert.deepEqual(p.map((x) => [x.id, x.line]), [['path-users', 2]]);
  assert.match(p[0].text, /\/Users\/jane/);
});

test('does not flag innocuous text', () => {
  for (const s of MUST_PASS) assert.deepEqual(ids(s), [], `should pass: ${s}`);
});

test('the allowlist is empty by default, and an entry skips only its own line', () => {
  assert.deepEqual(ALLOWLIST, ['-----BEGIN PUBLIC KEY-----'], 'document each entry in bundle-hygiene.mjs if one is ever added');
  const text = 'a /Users/example/docs sample\nb /Users/jane/x';
  assert.equal(findProblems(text, ['/Users/example/docs']).length, 1);
  assert.equal(findProblems(text, ['/Users/example/docs'])[0].line, 2);
});

test('CLI: exit 1 on a dirty file, exit 0 on a clean one, exit 1 on a missing one', () => {
  const d = mkdtempSync(join(tmpdir(), 'grip-hyg-'));
  const dirty = join(d, 'dirty.mjs'), clean = join(d, 'clean.mjs');
  writeFileSync(dirty, 'x\nconst p = "/Volumes/Disk/x";\n');
  writeFileSync(clean, 'const ok = 1;\n');
  const run = (...f) => spawnSync(process.execPath, [SCRIPT, ...f], { encoding: 'utf8' });
  const bad = run(dirty);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /dirty\.mjs:2 \[path-volumes\]/);
  assert.equal(run(clean).status, 0);
  assert.equal(run(join(d, 'nope.mjs')).status, 1);
  assert.equal(run(clean, dirty).status, 1, 'any dirty file fails the run');
  assert.equal(checkFiles([clean]).length, 0);
});

test('the real built bundles and notices are clean (run `npm run build` first; `npm test` does)', () => {
  for (const f of DEFAULT_FILES) assert.ok(existsSync(join(ROOT, f)), `${f} missing: run \`npm run build\``);
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /4 file\(s\) clean/);
});

test('the pinned release PUBLIC key passes, every private key block still fails', () => {
  const pub = '-----BEGIN PUBLIC KEY-----\\nMCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\\n-----END PUBLIC KEY-----\\n';
  assert.deepEqual(ids(`export const KEYS = [\`${pub}\`];`), [], 'a public key is not a secret');
  for (const kind of ['PRIVATE KEY', 'EC PRIVATE KEY', 'RSA PRIVATE KEY', 'ENCRYPTED PRIVATE KEY']) {
    assert.deepEqual(ids(`x = "-----BE${'GIN'} ${kind}-----"`), ['pem-block'], `${kind} flagged`);
  }
});
