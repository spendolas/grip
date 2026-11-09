// Tests for scripts/third-party-notices.mjs. Run: node --test scripts/third-party-notices.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ALLOWED, licenseAllowed, productionPackages, buildNotices } from './third-party-notices.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'third-party-notices.mjs');

// A scratch "install": pkgs = { 'node_modules/foo': { license, files: {name: text}, version, dev } }
function fixture(pkgs) {
  const dir = mkdtempSync(join(tmpdir(), 'grip-tpn-'));
  const lock = { lockfileVersion: 3, packages: { '': { name: 'root' } } };
  for (const [key, p] of Object.entries(pkgs)) {
    lock.packages[key] = { version: p.version ?? '1.0.0', ...(p.dev ? { dev: true } : {}) };
    const d = join(dir, key);
    mkdirSync(d, { recursive: true });
    const pj = { name: key.slice(key.lastIndexOf('node_modules/') + 13), version: p.version ?? '1.0.0' };
    if (p.license !== undefined) pj.license = p.license;
    if (p.licenseObj) pj.license = p.licenseObj;
    writeFileSync(join(d, 'package.json'), JSON.stringify(pj));
    for (const [n, t] of Object.entries(p.files ?? {})) writeFileSync(join(d, n), t);
  }
  return { dir, lock };
}

test('allowlist is exactly the approved set', () => {
  assert.deepEqual(ALLOWED, ['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD']);
});

test('licenseAllowed: ids, OR, AND, parentheses, junk', () => {
  for (const ok of ['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', '(MIT OR GPL-3.0)', 'MIT OR Apache-2.0', 'MIT AND ISC', '(MIT AND (ISC OR GPL-2.0))']) {
    assert.ok(licenseAllowed(ok), ok);
  }
  for (const bad of ['GPL-3.0', 'LGPL-2.1', 'AGPL-3.0', 'MPL-2.0', 'CC-BY-4.0', 'UNLICENSED', 'SEE LICENSE IN LICENSE', 'MIT AND GPL-3.0', 'GPL-3.0 OR MPL-2.0', '', undefined, 'mit']) {
    assert.ok(!licenseAllowed(bad), String(bad));
  }
});

test('productionPackages: skips dev and the root, keeps nested installs, sorted', () => {
  const { lock } = fixture({
    'node_modules/zed': {}, 'node_modules/alpha': {}, 'node_modules/devtool': { dev: true },
    'node_modules/alpha/node_modules/inner': {}, 'node_modules/@scope/pkg': {},
  });
  assert.deepEqual(productionPackages(lock).map((p) => p.key),
    ['node_modules/@scope/pkg', 'node_modules/alpha', 'node_modules/alpha/node_modules/inner', 'node_modules/zed']);
  assert.deepEqual(productionPackages(lock).map((p) => p.name), ['@scope/pkg', 'alpha', 'inner', 'zed']);
});

test('buildNotices: writes name, version, license id and text for every production package', () => {
  const { dir, lock } = fixture({
    'node_modules/a': { license: 'MIT', version: '2.3.4', files: { LICENSE: 'MIT text for a' } },
    'node_modules/@s/b': { license: 'ISC', files: { 'LICENSE.md': 'ISC text for b' } },
    'node_modules/c': { licenseObj: { type: 'BSD-3-Clause' }, files: { LICENCE: 'BSD text for c' } },
    'node_modules/d': { license: 'Apache-2.0', files: { LICENSE: 'Apache text', NOTICE: 'Apache notice d' } },
    'node_modules/devonly': { dev: true, license: 'GPL-3.0', files: {} },       // dev: never inspected
  });
  const r = buildNotices(lock, dir);
  assert.equal(r.problems, undefined);
  assert.equal(r.count, 4);
  assert.match(r.text, /^Grip third-party notices/);
  assert.match(r.text, /\na 2\.3\.4 \(MIT\)\n=+\nMIT text for a\n/);
  assert.match(r.text, /@s\/b 1\.0\.0 \(ISC\)/);
  assert.match(r.text, /BSD text for c/);
  assert.match(r.text, /Apache text\n\nApache notice d/, 'the NOTICE file travels with an Apache license');
  assert.ok(!r.text.includes('devonly'));
});

test('buildNotices: a license outside the allowlist fails and names the package', () => {
  const { dir, lock } = fixture({
    'node_modules/good': { license: 'MIT', files: { LICENSE: 'x' } },
    'node_modules/copyleft': { license: 'GPL-3.0', version: '9.9.9', files: { LICENSE: 'gpl' } },
  });
  const r = buildNotices(lock, dir);
  assert.equal(r.text, undefined, 'nothing is produced');
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /copyleft 9\.9\.9: license "GPL-3\.0" is outside the allowlist/);
});

test('buildNotices: missing license file, missing license field, missing package all fail', () => {
  const { dir, lock } = fixture({
    'node_modules/nofile': { license: 'MIT', files: { 'README.md': 'x' } },
    'node_modules/nofield': { files: { LICENSE: 'x' } },
  });
  lock.packages['node_modules/ghost'] = { version: '1.0.0' };
  const r = buildNotices(lock, dir);
  const all = r.problems.join('\n');
  assert.match(all, /nofile 1\.0\.0: no license file found/);
  assert.match(all, /nofield 1\.0\.0: no license field/);
  assert.match(all, /node_modules\/ghost: package\.json not found/);
});

test('CLI on the real tree: passes the allowlist and writes the notices (needs npm ci)', () => {
  const lock = join(ROOT, 'src', 'bridge', 'package-lock.json');
  assert.ok(existsSync(join(ROOT, 'src', 'bridge', 'node_modules')), 'run `npm run setup` first');
  const out = join(mkdtempSync(join(tmpdir(), 'grip-tpn-out-')), 'THIRD-PARTY-NOTICES.txt');
  const r = spawnSync(process.execPath, [SCRIPT, '--lock', lock, '--out', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const text = readFileSync(out, 'utf8');
  for (const must of ['@modelcontextprotocol/sdk', 'ws ', 'zod ', 'uuid ']) assert.ok(text.includes(must), must);
  assert.ok(productionPackages(JSON.parse(readFileSync(lock, 'utf8'))).length > 20);
  // every production package appears with its license text
  const n = (text.match(/^={78}$/gm) || []).length;
  assert.equal(n, productionPackages(JSON.parse(readFileSync(lock, 'utf8'))).length * 2);
});

test('CLI: a failing tree exits 1 and writes nothing; bad usage exits 2', () => {
  const { dir, lock } = fixture({ 'node_modules/bad': { license: 'GPL-3.0', files: { LICENSE: 'x' } } });
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(lock));
  const out = join(dir, 'out.txt');
  const r = spawnSync(process.execPath, [SCRIPT, '--lock', join(dir, 'package-lock.json'), '--out', out], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /bad 1\.0\.0: license "GPL-3\.0"/);
  assert.ok(!existsSync(out));
  assert.equal(spawnSync(process.execPath, [SCRIPT, '--nope'], { encoding: 'utf8' }).status, 2);
});
