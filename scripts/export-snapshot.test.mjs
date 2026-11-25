import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { excluded, scanDenylist, treeHash, check } from './export-snapshot.mjs';

test('excluded: folders by prefix, files exactly', () => {
  assert.ok(excluded('docs/index.html') && excluded('README.md') && excluded('flavour/flavour.json'));
  assert.ok(!excluded('src/bridge/src/types.ts') && !excluded('scripts/release-gate.mjs') && !excluded('docsx/a'));
});

test('denylist: case-insensitive, comments ignored, line numbers', () => {
  const hits = scanDenylist(['# c', 'Secret', ''], ['a.txt', 'b.txt'], (f) => (f === 'a.txt' ? 'x\nthe SECRET here' : 'clean'));
  assert.deepEqual(hits, [{ file: 'a.txt', line: 2, word: 'secret' }]);
});

test('check: intact, edited and missing', () => {
  const d = mkdtempSync(join(tmpdir(), 'snap-'));
  try {
    writeFileSync(join(d, 'a.txt'), 'one'); mkdirSync(join(d, 'sub')); writeFileSync(join(d, 'sub', 'b.txt'), 'two');
    const files = ['a.txt', 'sub/b.txt'];
    writeFileSync(join(d, 'UPSTREAM.json'), JSON.stringify({ commit: 'abc', files, treeHash: treeHash(d, files) }));
    assert.equal(check(d).ok, true);
    writeFileSync(join(d, 'a.txt'), 'changed');
    assert.equal(check(d).ok, false);
    rmSync(join(d, 'sub', 'b.txt'));
    assert.match(check(d).reason, /missing/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('CLI: dry run writes nothing, --apply copies, removes stale files, refuses on a denylist hit', () => {
  const repo = mkdtempSync(join(tmpdir(), 'src-')), out = mkdtempSync(join(tmpdir(), 'dst-')), fl = mkdtempSync(join(tmpdir(), 'fl-'));
  const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });
  try {
    mkdirSync(join(repo, 'scripts')); mkdirSync(join(repo, 'src'));
    execFileSync('cp', [new URL('./export-snapshot.mjs', import.meta.url).pathname, join(repo, 'scripts', 'export-snapshot.mjs')]);
    writeFileSync(join(repo, 'src', 'a.ts'), 'a'); writeFileSync(join(repo, 'README.md'), 'readme'); writeFileSync(join(repo, 'src', 'old.ts'), 'old');
    git('init', '-q'); git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'one');
    writeFileSync(join(fl, 'flavour.json'), '{"slug":"x"}');
    const run = (...a) => execFileSync('node', [join(repo, 'scripts', 'export-snapshot.mjs'), ...a], { encoding: 'utf8', stdio: 'pipe' });
    assert.match(run('--to', out, '--flavour', fl), /dry run/);
    assert.ok(!existsSync(join(out, 'src')), 'dry run writes nothing');
    run('--to', out, '--flavour', fl, '--apply');
    assert.ok(existsSync(join(out, 'src', 'a.ts')) && existsSync(join(out, 'src', 'old.ts')) && existsSync(join(out, 'flavour', 'flavour.json')));
    assert.ok(!existsSync(join(out, 'README.md')), 'excluded files are not exported');
    assert.match(run('--check', out), /snapshot intact/);
    git('rm', '-q', 'src/old.ts'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'two');
    run('--to', out, '--flavour', fl, '--apply');
    assert.ok(!existsSync(join(out, 'src', 'old.ts')), 'a file removed upstream is removed in the target');
    writeFileSync(join(out, 'src', 'a.ts'), 'edited');
    assert.throws(() => run('--check', out), /BROKEN|status 1/);
    const deny = join(fl, 'deny.txt'); writeFileSync(deny, 'x\n');
    assert.throws(() => run('--to', out, '--flavour', fl, '--denylist', deny, '--apply'), (e) => e.status === 2);
  } finally { for (const d of [repo, out, fl]) rmSync(d, { recursive: true, force: true }); }
});
