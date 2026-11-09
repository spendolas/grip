// Tests for scripts/package-release.mjs. Run: node --test scripts/package-release.test.mjs
// Packages the real committed artifacts into a temp dir (never into ./dist).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, statSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { packageRelease, buildZip, crc32, checkLockstep, readLockstepVersions, readMinPluginVersion, buildCompat, PackageError } from './package-release.mjs';
import { REQUIRED_ASSETS, INSTALL_MARKER } from './release-gate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const tmp = (p) => mkdtempSync(join(tmpdir(), p));

// A small pure-node zip reader (central directory), to verify the writer without `unzip`.
function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, 'end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, 'central header signature');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const attr = buf.readUInt32LE(p + 38) >>> 16;
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    assert.equal(buf.readUInt32LE(lho), 0x04034b50, 'local header signature');
    const ln = buf.readUInt16LE(lho + 26), lx = buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(lho + 30 + ln + lx, lho + 30 + ln + lx + csize);
    assert.equal(method, 8);
    const data = inflateRawSync(raw);
    assert.equal(data.length, usize, `${name} size`);
    assert.equal(crc32(data), crc, `${name} crc`);
    out[name] = { data, mode: attr & 0o7777, type: attr & 0o170000 };
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

test('crc32 known vector', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('lockstep: the repo has one version in all four places', () => {
  const v = readLockstepVersions(ROOT);
  assert.equal(Object.keys(v).length, 4);
  assert.equal(new Set(Object.values(v)).size, 1, JSON.stringify(v));
  assert.match(checkLockstep(ROOT), /^\d+\.\d+\.\d+/);
});

test('packages every release asset with correct names and sums', () => {
  const out = tmp('grip-pkg-');
  const r = packageRelease({ root: ROOT, out });
  assert.equal(r.version, checkLockstep(ROOT));
  assert.deepEqual(readdirSync(out).sort(), [...REQUIRED_ASSETS].sort(), 'exactly the gate\'s required assets');
  assert.deepEqual([...r.files].sort(), [...REQUIRED_ASSETS].sort());

  // copies are byte-identical to the committed artifacts
  const same = {
    'grip-bridge.mjs': 'bridge/grip-bridge.mjs',
    'install.mjs': 'bridge/install.mjs',
    'grip-plugin-code.js': 'figma-plugin/code.js',
    'grip-plugin-ui.html': 'figma-plugin/ui.html',
    'grip-plugin-manifest.json': 'figma-plugin/manifest.json',
  };
  for (const [asset, src] of Object.entries(same)) {
    assert.ok(readFileSync(join(out, asset)).equals(readFileSync(join(ROOT, src))), `${asset} == ${src}`);
  }

  // SHA256SUMS.txt: `<sha256>  <name>` for every asset except itself, and every sum verifies
  const text = readFileSync(join(out, 'SHA256SUMS.txt'), 'utf8');
  assert.ok(text.endsWith('\n'));
  const lines = text.trim().split('\n');
  const expected = REQUIRED_ASSETS.filter((n) => n !== 'SHA256SUMS.txt').sort();
  assert.deepEqual(lines.map((l) => l.split('  ')[1]), expected, 'sorted, every asset incl. the zip, not itself');
  for (const l of lines) {
    assert.match(l, /^[0-9a-f]{64}  \S+$/, 'sha256sum format (two spaces)');
    const [hash, name] = l.split('  ');
    assert.equal(sha(readFileSync(join(out, name))), hash, `${name} verifies`);
  }
  // and the system tool agrees, where it exists
  const tool = spawnSync('sha256sum', ['-c', 'SHA256SUMS.txt'], { cwd: out, encoding: 'utf8' });
  if (!tool.error) assert.equal(tool.status, 0, tool.stdout + tool.stderr);
  else {
    const shasum = spawnSync('shasum', ['-a', '256', '-c', 'SHA256SUMS.txt'], { cwd: out, encoding: 'utf8' });
    if (!shasum.error) assert.equal(shasum.status, 0, shasum.stdout + shasum.stderr);
  }
});

test('compat.json is generated from types.ts, and listed in SHA256SUMS.txt', () => {
  const out = tmp('grip-pkg-');
  const r = packageRelease({ root: ROOT, out });
  const compat = JSON.parse(readFileSync(join(out, 'compat.json'), 'utf8'));
  assert.deepEqual(Object.keys(compat), ['version', 'minPlugin']);
  assert.equal(compat.version, r.version);
  assert.equal(compat.minPlugin, readMinPluginVersion(ROOT));
  assert.match(compat.minPlugin, /^\d+\.\d+\.\d+$/);
  assert.ok(readFileSync(join(out, 'compat.json'), 'utf8').endsWith('\n'));
  const sums = readFileSync(join(out, 'SHA256SUMS.txt'), 'utf8');
  assert.ok(sums.includes(`${sha(readFileSync(join(out, 'compat.json')))}  compat.json`), 'compat.json is in SHA256SUMS.txt');
  // the same bytes the updater would be handed; no hand-edited copy exists in the repo
  assert.ok(!existsSync(join(ROOT, 'compat.json')) && !existsSync(join(ROOT, 'bridge', 'compat.json')));
});

test('compat.json: refuses a missing or nonsensical MIN_PLUGIN_VERSION', () => {
  const r = scratchRoot();
  const t = join(r, 'src', 'bridge', 'src', 'types.ts');
  const orig = readFileSync(t, 'utf8');
  writeFileSync(t, orig.replace(/export const MIN_PLUGIN_VERSION = '[^']+';/, ''));
  assert.throws(() => packageRelease({ root: r, out: tmp('grip-pkg-') }), /MIN_PLUGIN_VERSION/);
  writeFileSync(t, orig.replace(/MIN_PLUGIN_VERSION = '[^']+'/, "MIN_PLUGIN_VERSION = '99.0.0'"));
  assert.throws(() => packageRelease({ root: r, out: tmp('grip-pkg-') }), /newer than this release/);
  writeFileSync(t, orig.replace(/MIN_PLUGIN_VERSION = '[^']+'/, "MIN_PLUGIN_VERSION = 'soon'"));
  assert.throws(() => packageRelease({ root: r, out: tmp('grip-pkg-') }), /not major\.minor\.patch/);
  assert.deepEqual(JSON.parse(buildCompat(ROOT, '1.2.3')), { version: '1.2.3', minPlugin: readMinPluginVersion(ROOT) });
});

test('grip-install.zip has the install layout, contents and modes', () => {
  const out = tmp('grip-pkg-');
  packageRelease({ root: ROOT, out });
  const zip = readZip(readFileSync(join(out, 'grip-install.zip')));
  assert.deepEqual(Object.keys(zip), [
    'grip/bridge/grip-bridge.mjs',
    'grip/bridge/install.mjs',
    'grip/figma-plugin/code.js',
    'grip/figma-plugin/manifest.json',
    'grip/figma-plugin/ui.html',
  ]);
  const want = {
    'grip/bridge/grip-bridge.mjs': 'bridge/grip-bridge.mjs',
    'grip/bridge/install.mjs': 'bridge/install.mjs',
    'grip/figma-plugin/code.js': 'figma-plugin/code.js',
    'grip/figma-plugin/manifest.json': 'figma-plugin/manifest.json',
    'grip/figma-plugin/ui.html': 'figma-plugin/ui.html',
  };
  for (const [name, src] of Object.entries(want)) assert.ok(zip[name].data.equals(readFileSync(join(ROOT, src))), name);
  assert.equal(zip['grip/bridge/install.mjs'].mode, 0o755);
  assert.equal(zip['grip/bridge/grip-bridge.mjs'].mode, 0o755);
  assert.equal(zip['grip/figma-plugin/manifest.json'].mode, 0o644);
  assert.equal(zip['grip/bridge/install.mjs'].type, 0o100000, 'regular files');

  // a real unzip agrees, where one exists
  const dest = tmp('grip-unzip-');
  const u = spawnSync('unzip', ['-q', join(out, 'grip-install.zip'), '-d', dest], { encoding: 'utf8' });
  if (!u.error) {
    assert.equal(u.status, 0, u.stderr);
    assert.ok(readFileSync(join(dest, 'grip', 'bridge', 'install.mjs')).equals(readFileSync(join(ROOT, 'bridge', 'install.mjs'))));
    if (process.platform !== 'win32') assert.ok(statSync(join(dest, 'grip', 'bridge', 'install.mjs')).mode & 0o100, 'install.mjs stays executable');
    const t = spawnSync('unzip', ['-tq', join(out, 'grip-install.zip')], { encoding: 'utf8' });
    assert.equal(t.status, 0, t.stdout + t.stderr);
  }
});

test('the zip is deterministic', () => {
  const a = tmp('grip-pkg-'), b = tmp('grip-pkg-');
  packageRelease({ root: ROOT, out: a });
  packageRelease({ root: ROOT, out: b });
  for (const n of REQUIRED_ASSETS) assert.ok(readFileSync(join(a, n)).equals(readFileSync(join(b, n))), `${n} identical across runs`);
});

test('an extracted zip is what the installer expects (release layout)', () => {
  // install.mjs looks for ../figma-plugin beside bridge/ — the zip must provide it.
  const out = tmp('grip-pkg-');
  packageRelease({ root: ROOT, out });
  const zip = readZip(readFileSync(join(out, 'grip-install.zip')));
  const names = Object.keys(zip);
  assert.ok(names.includes('grip/figma-plugin/manifest.json'));
  assert.ok(names.every((n) => n.startsWith('grip/bridge/') || n.startsWith('grip/figma-plugin/')));
});

test('asset names agree with the updater (src/bridge/dist/update.js)', async (t) => {
  const distJs = join(ROOT, 'src', 'bridge', 'dist', 'update.js');
  if (!existsSync(distJs)) return t.skip('src/bridge/dist not compiled');
  const U = await import(distJs);
  for (const n of U.UPDATE_ASSET_NAMES) assert.ok(REQUIRED_ASSETS.includes(n), `updater downloads ${n}, which a release must carry`);
  // each plugin asset maps to the file the updater writes into ~/.grip/figma-plugin
  assert.deepEqual(
    Object.entries(U.PLUGIN_ASSETS).sort(),
    [['grip-plugin-code.js', 'code.js'], ['grip-plugin-manifest.json', 'manifest.json'], ['grip-plugin-ui.html', 'ui.html']],
  );
  assert.equal(U.ASSET_BRIDGE, 'grip-bridge.mjs');
  assert.equal(U.ASSET_SUMS, 'SHA256SUMS.txt');
  assert.equal(U.ASSET_COMPAT, 'compat.json');
  // the updater and the gate must cut the same footer marker
  assert.equal(U.INSTALL_MARKER, INSTALL_MARKER);
  // eight release assets in all; the updater downloads six of them (not install.mjs / the zip)
  assert.equal(REQUIRED_ASSETS.length, 8);
  assert.deepEqual([...U.UPDATE_ASSET_NAMES].sort(), ['SHA256SUMS.txt', 'compat.json', 'grip-bridge.mjs', 'grip-plugin-code.js', 'grip-plugin-manifest.json', 'grip-plugin-ui.html']);
  // ...and those figma-plugin files all exist
  for (const local of Object.values(U.PLUGIN_ASSETS)) assert.ok(existsSync(join(ROOT, 'figma-plugin', local)), local);
});

// ---- failure modes, on a scratch copy of the inputs ----

function scratchRoot() {
  const r = tmp('grip-root-');
  for (const rel of ['bridge/grip-bridge.mjs', 'bridge/install.mjs', 'figma-plugin/manifest.json', 'figma-plugin/code.js', 'figma-plugin/ui.html',
    'src/bridge/src/types.ts', 'src/bridge/package.json', 'src/plugin/package.json', 'src/plugin/code.ts']) {
    mkdirSync(join(r, dirname(rel)), { recursive: true });
    cpSync(join(ROOT, rel), join(r, rel));
  }
  return r;
}

test('fails when the four version places disagree', () => {
  const r = scratchRoot();
  const p = join(r, 'src', 'plugin', 'package.json');
  writeFileSync(p, readFileSync(p, 'utf8').replace(/"version": "[^"]+"/, '"version": "9.9.9"'));
  assert.throws(() => packageRelease({ root: r, out: tmp('grip-pkg-') }), (e) => e instanceof PackageError && /version mismatch/.test(e.message) && /9\.9\.9/.test(e.message));
});

test('fails when a bundle is stale or missing', () => {
  const r = scratchRoot();
  const t = join(r, 'src', 'bridge', 'src', 'types.ts');
  const v = checkLockstep(r);
  // bump every version place but leave the bundles on the old version
  const bump = (file, re, to) => writeFileSync(file, readFileSync(file, 'utf8').replace(re, to));
  bump(t, /BRIDGE_VERSION = '[^']+'/, "BRIDGE_VERSION = '77.0.0'");
  bump(join(r, 'src', 'bridge', 'package.json'), /"version": "[^"]+"/, '"version": "77.0.0"');
  bump(join(r, 'src', 'plugin', 'package.json'), /"version": "[^"]+"/, '"version": "77.0.0"');
  bump(join(r, 'src', 'plugin', 'code.ts'), /const PLUGIN_VERSION = '[^']+'/, "const PLUGIN_VERSION = '77.0.0'");
  assert.notEqual(v, '77.0.0');
  assert.throws(() => packageRelease({ root: r, out: tmp('grip-pkg-') }), /does not contain version 77\.0\.0/);

  const r2 = scratchRoot();
  writeFileSync(join(r2, 'figma-plugin', 'ui.html'), '');
  // (an empty file still packages; a MISSING one does not)
  rmSync(join(r2, 'bridge', 'install.mjs'));
  assert.throws(() => packageRelease({ root: r2, out: tmp('grip-pkg-') }), /missing bridge\/install\.mjs/);
});

test('refuses to write into the repo root', () => {
  const r = scratchRoot();
  assert.throws(() => packageRelease({ root: r, out: r }), /repo root/);
});

test('buildZip rejects unsafe names', () => {
  assert.throws(() => buildZip([{ name: '../evil', data: Buffer.from('x') }]), PackageError);
  assert.throws(() => buildZip([{ name: '/abs', data: Buffer.from('x') }]), PackageError);
});

test('CLI: --print-version and a default run', () => {
  const script = join(ROOT, 'scripts', 'package-release.mjs');
  const v = execFileSync(process.execPath, [script, '--print-version'], { encoding: 'utf8' }).trim();
  assert.equal(v, checkLockstep(ROOT));
  const out = tmp('grip-cli-');
  const o = execFileSync(process.execPath, [script, '--out', out], { encoding: 'utf8' });
  assert.match(o, /grip-install\.zip/);
  assert.ok(existsSync(join(out, 'SHA256SUMS.txt')));
  const bad = spawnSync(process.execPath, [script, '--bogus'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
});

// Nothing a user downloads or runs may be a native binary. Gatekeeper warns about
// unsigned/unnotarized executables ("could not verify ... is free of malware"),
// and the only binary on a user's machine must be Node itself. esbuild is a
// build-time tool that runs in CI and on developer machines, never in a release.
test('no release asset (or file inside the zip) is a native executable', () => {
  const out = tmp('grip-nobin-');
  packageRelease({ root: ROOT, out });
  const MAGIC = [
    ['Mach-O', [0xfe, 0xed, 0xfa, 0xce]], ['Mach-O 64', [0xfe, 0xed, 0xfa, 0xcf]],
    ['Mach-O (le)', [0xce, 0xfa, 0xed, 0xfe]], ['Mach-O 64 (le)', [0xcf, 0xfa, 0xed, 0xfe]],
    ['Mach-O universal', [0xca, 0xfe, 0xba, 0xbe]], ['ELF', [0x7f, 0x45, 0x4c, 0x46]],
    ['Windows PE', [0x4d, 0x5a]], ['Windows PE (shortcut/zone)', [0x4c, 0x00, 0x00, 0x00]],
  ];
  const isNative = (buf) => MAGIC.find(([, m]) => m.every((b, i) => buf[i] === b))?.[0] ?? null;
  const zipName = 'grip-install.zip';
  for (const name of readdirSync(out)) {
    const buf = readFileSync(join(out, name));
    if (name === zipName) {
      for (const [inner, entry] of Object.entries(readZip(buf))) {
        const data = entry.data ?? entry;
        assert.equal(isNative(Buffer.from(data)), null, `${zipName}:${inner} is a native executable`);
      }
    } else {
      assert.equal(isNative(buf), null, `${name} is a native executable`);
    }
  }
  assert.ok(!readdirSync(out).some((n) => /esbuild/i.test(n)), 'esbuild is never a release asset');
});
