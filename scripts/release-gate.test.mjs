// Unit tests for scripts/release-gate.mjs. Run: node --test scripts/release-gate.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  REQUIRED_ASSETS, INSTALL_MARKER, GateError, parseVersion, compareVersions, extractNotes, isCompleteRelease, decide, main,
  installFooter, withInstallFooter,
} from './release-gate.mjs';

const CHANGELOG = `# Changelog

## 0.9.0

**Nine.**

- one
- two

## 0.8.0 - 2026-11-09

**Self-update.**

- a

## 0.7.0

**Seven.**
`;

const full = (isDraft = false) => ({ isDraft, assets: REQUIRED_ASSETS.map((name) => ({ name })) });

test('parseVersion / compareVersions', () => {
  assert.deepEqual(parseVersion('0.8.0'), { nums: [0, 8, 0], pre: null });
  assert.deepEqual(parseVersion('1.2.3-beta.1'), { nums: [1, 2, 3], pre: 'beta.1' });
  assert.equal(parseVersion('v0.8.0'), null, 'no v prefix');
  assert.equal(parseVersion('0.8'), null);
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1, 'numeric');
  assert.equal(compareVersions('0.8.0', '0.8.0'), 0);
  assert.equal(compareVersions('0.8.0-beta.2', '0.8.0-beta.10'), -1);
  assert.equal(compareVersions('0.8.0', '0.8.0-beta.1'), 1, 'final > prerelease');
  assert.throws(() => compareVersions('x', '1.0.0'), GateError);
});

test('required assets match what the packager and updater use', () => {
  assert.equal(REQUIRED_ASSETS.length, 9);
  for (const n of ['grip-bridge.mjs', 'install.mjs', 'grip-plugin-code.js', 'grip-plugin-ui.html', 'grip-plugin-manifest.json', 'grip-install.zip', 'compat.json', 'THIRD-PARTY-NOTICES.txt', 'SHA256SUMS.txt']) {
    assert.ok(REQUIRED_ASSETS.includes(n), n);
  }
});

test('extractNotes returns the exact-version section only', () => {
  assert.equal(extractNotes(CHANGELOG, '0.9.0'), '**Nine.**\n\n- one\n- two\n');
  assert.equal(extractNotes(CHANGELOG, '0.8.0'), '**Self-update.**\n\n- a\n', 'a trailing date on the heading is fine');
  assert.equal(extractNotes(CHANGELOG, '0.7.0'), '**Seven.**\n', 'last section, no following heading');
  assert.equal(extractNotes(CHANGELOG, '0.6.0'), null);
  assert.equal(extractNotes(CHANGELOG, '0.8'), null, 'prefixes do not match');
  assert.equal(extractNotes(CHANGELOG.replace('## 0.9.0', '## 0.9.01'), '0.9.0'), null);
  assert.equal(extractNotes('## v0.8.0\n\nx\n', '0.8.0'), null, 'a v-prefixed heading is not the exact version');
  assert.equal(extractNotes('## 0.8.0\r\n\r\n**A.**\r\n\r\n- b\r\n', '0.8.0'), '**A.**\n\n- b\n', 'CRLF');
  assert.equal(extractNotes('## 1.0.0\n### Sub\n- x\n## 0.9.0\n', '1.0.0'), '### Sub\n- x\n', 'sub-headings stay inside');
  assert.equal(extractNotes('## 0.1.0\n', '0.1.0'), '\n', 'empty section yields blank');
});

test('a release without compat.json is not complete (it would never be offered)', () => {
  const noCompat = full();
  noCompat.assets = noCompat.assets.filter((a) => a.name !== 'compat.json');
  assert.equal(isCompleteRelease(noCompat), false);
  assert.equal(decide({ version: '0.8.0', tags: ['v0.8.0'], release: noCompat, changelog: CHANGELOG }).action, 'recover');
});

test('install footer: after the marker, tag-pinned README link, release pointer', () => {
  const f = installFooter('0.9.0');
  assert.match(f, /^\*\*Install:\*\* tell your agent `Install Grip from https:\/\/github\.com\/spendolas\/grip\/releases\/latest`/);
  assert.ok(f.includes('(https://github.com/spendolas/grip/blob/v0.9.0/README.md#install-instructions-for-claude)'), 'tag-pinned README link');
  assert.ok(!f.includes('/main/'), 'never points at main');
  const body = withInstallFooter('**Nine.**\n\n- one\n\n\n', '0.9.0');
  const [notes, footer] = body.split(INSTALL_MARKER + '\n');
  assert.equal(notes, '**Nine.**\n\n- one\n\n', 'notes kept, trailing blank lines normalised, marker on its own line after a blank line');
  assert.equal(footer, f + '\n');
  assert.equal(INSTALL_MARKER, '<!-- grip-install -->');
});

test('isCompleteRelease', () => {
  assert.equal(isCompleteRelease(null), false);
  assert.equal(isCompleteRelease(full(true)), false, 'draft');
  assert.equal(isCompleteRelease(full()), true);
  const missing = full();
  missing.assets.pop();
  assert.equal(isCompleteRelease(missing), false, 'missing SHA256SUMS.txt');
  assert.equal(isCompleteRelease({ isDraft: false }), false, 'no assets');
});

test('decide: create when nothing exists', () => {
  const r = decide({ version: '0.9.0', tags: ['v0.8.0', 'v0.7.0'], release: null, changelog: CHANGELOG });
  assert.equal(r.action, 'create');
  assert.equal(r.notes, '**Nine.**\n\n- one\n- two\n');
});

test('decide: skip when already released with every asset (no changelog needed)', () => {
  const r = decide({ version: '0.8.0', tags: ['v0.8.0'], release: full(), changelog: '' });
  assert.deepEqual(r, { action: 'skip', notes: null });
});

test('decide: recover a draft, or a published release missing assets', () => {
  assert.equal(decide({ version: '0.8.0', tags: [], release: full(true), changelog: CHANGELOG }).action, 'recover');
  const partial = { isDraft: false, assets: [{ name: 'grip-bridge.mjs' }] };
  const r = decide({ version: '0.8.0', tags: ['v0.8.0'], release: partial, changelog: CHANGELOG });
  assert.equal(r.action, 'recover');
  assert.equal(r.notes, '**Self-update.**\n\n- a\n');
  // recover does not re-check tag ordering (the tag already exists)
  assert.equal(decide({ version: '0.8.0', tags: ['v0.9.0'], release: partial, changelog: CHANGELOG }).action, 'recover');
});

test('decide: refuses a version with no changelog section, or an empty one', () => {
  assert.throws(() => decide({ version: '0.9.1', tags: [], release: null, changelog: CHANGELOG }), /no "## 0\.9\.1" heading/);
  assert.throws(() => decide({ version: '0.9.0', tags: [], release: null, changelog: '## 0.9.0\n\n## 0.8.0\n- x\n' }), /no notes under it/);
  assert.throws(() => decide({ version: '0.8.0', tags: [], release: full(true), changelog: '' }), GateError, 'recover needs notes too');
});

test('decide: version must be greater than every existing tag', () => {
  assert.throws(() => decide({ version: '0.8.0', tags: ['v0.9.0'], release: null, changelog: CHANGELOG }), /not greater than existing tag v0\.9\.0/);
  assert.throws(() => decide({ version: '0.8.0', tags: ['v0.8.0-beta.1', 'v0.8.1'], release: null, changelog: CHANGELOG }), /v0\.8\.1/);
  // a prerelease tag of the same x.y.z is lower; unrelated / unparseable tags are ignored
  assert.equal(decide({ version: '0.8.0', tags: ['v0.8.0-beta.1', 'node-v24', 'junk', 'x1.0.0'], release: null, changelog: CHANGELOG }).action, 'create');
});

test('decide: bad version', () => {
  assert.throws(() => decide({ version: 'v0.8.0', tags: [], release: null, changelog: CHANGELOG }), /not major\.minor\.patch/);
  assert.throws(() => decide({ version: '', tags: [], release: null, changelog: CHANGELOG }), GateError);
});

test('main: reads files, writes notes and GITHUB_OUTPUT', () => {
  const d = mkdtempSync(join(tmpdir(), 'grip-gate-'));
  writeFileSync(join(d, 'tags.txt'), 'v0.7.0\n\nv0.8.0\n');
  writeFileSync(join(d, 'release.json'), 'null');
  writeFileSync(join(d, 'CHANGELOG.md'), CHANGELOG);
  const out = join(d, 'gh-output');
  const argv = ['--version', '0.9.0', '--tags-file', join(d, 'tags.txt'), '--release-file', join(d, 'release.json'),
    '--changelog', join(d, 'CHANGELOG.md'), '--notes-out', join(d, 'notes.md')];
  const log = console.log; console.log = () => {};
  try { assert.equal(main(argv, { GITHUB_OUTPUT: out }), 'create'); } finally { console.log = log; }
  assert.equal(readFileSync(join(d, 'notes.md'), 'utf8'), withInstallFooter('**Nine.**\n\n- one\n- two\n', '0.9.0'), 'every release body gets the install footer');
  assert.match(readFileSync(join(d, 'notes.md'), 'utf8'), /\n\n<!-- grip-install -->\n\*\*Install:\*\*.*blob\/v0\.9\.0\/README\.md/s);
  assert.equal(readFileSync(out, 'utf8'), 'action=create\n');

  // empty release file (gh printed nothing) also means "no release"
  writeFileSync(join(d, 'release.json'), '');
  console.log = () => {};
  try { assert.equal(main(argv, {}), 'create'); } finally { console.log = log; }

  // skip writes no notes
  writeFileSync(join(d, 'release.json'), JSON.stringify(full()));
  writeFileSync(join(d, 'notes.md'), 'stale');
  console.log = () => {};
  try { assert.equal(main(argv, {}), 'skip'); } finally { console.log = log; }
  assert.equal(readFileSync(join(d, 'notes.md'), 'utf8'), 'stale', 'skip leaves notes alone');
  assert.throws(() => main(['--version', '0.9.0'], {}), /missing --/);
});

test('CLI exits non-zero with a message when the gate refuses', () => {
  const d = mkdtempSync(join(tmpdir(), 'grip-gate-'));
  writeFileSync(join(d, 'tags.txt'), '');
  writeFileSync(join(d, 'release.json'), 'null');
  writeFileSync(join(d, 'CHANGELOG.md'), CHANGELOG);
  const script = fileURLToPath(new URL('./release-gate.mjs', import.meta.url));
  assert.throws(
    () => execFileSync(process.execPath, [script, '--version', '1.0.0', '--tags-file', join(d, 'tags.txt'), '--release-file', join(d, 'release.json'),
      '--changelog', join(d, 'CHANGELOG.md'), '--notes-out', join(d, 'notes.md')], { stdio: 'pipe' }),
    (e) => e.status === 1 && /no "## 1\.0\.0" heading/.test(String(e.stderr)),
  );
  assert.ok(!existsSync(join(d, 'notes.md')), 'no notes written on refusal');
});
