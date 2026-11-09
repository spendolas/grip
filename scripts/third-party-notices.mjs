#!/usr/bin/env node
// License allowlist + THIRD-PARTY-NOTICES.txt for the bundled bridge. No dependencies.
//
//   node scripts/third-party-notices.mjs [--lock src/bridge/package-lock.json] [--out THIRD-PARTY-NOTICES.txt]
//
// The bridge bundle (bridge/grip-bridge.mjs, bridge/install.mjs) inlines the
// production dependencies of src/bridge. This walks that production tree from the
// lockfile (every package not marked "dev": true, i.e. what `npm ci --omit=dev`
// would install), reads each one's package.json and license file from the
// node_modules next to the lockfile (so `npm ci` must have run), and
//   - FAILS (exit 1, nothing written) on any package whose license is not in
//     ALLOWED, has no license field, or has no license file;
//   - otherwise writes the notices file: one section per package with its name,
//     version, license id and full license text (plus its NOTICE file, if any;
//     Apache-2.0 requires redistributing it).
// The list is the lockfile's production closure, a (tiny) superset of what esbuild
// actually inlines. Over-reporting a notice is harmless; the allowlist is the gate.
// The Figma plugin (figma-plugin/code.js) bundles no third-party code.
//
// ALLOWED is an SPDX-id allowlist; "A OR B" passes if either passes, "A AND B" needs
// both. Widening it is a deliberate legal decision: do it here, in review, nowhere else.
// CI (release.yml) runs this on every build and ships the output as
// grip/THIRD-PARTY-NOTICES.txt in grip-install.zip and as a plain release asset.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ALLOWED = ['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD'];

// SPDX expression check.
export function licenseAllowed(expr) {
  const clean = String(expr ?? '').replace(/[()]/g, ' ').trim();
  if (!clean) return false;
  return clean.split(/\s+OR\s+/i).some((alt) => alt.split(/\s+AND\s+/i).every((id) => ALLOWED.includes(id.trim())));
}

function licenseString(pj) {
  let l = pj.license;
  if (l && typeof l === 'object') l = l.type;
  if (!l && Array.isArray(pj.licenses)) l = pj.licenses.map((x) => x.type || x).join(' OR ');
  return typeof l === 'string' ? l : '';
}

// -> sorted [{ key: 'node_modules/ws', name, version }] for the production closure.
export function productionPackages(lock) {
  const out = [];
  for (const [key, v] of Object.entries(lock.packages ?? {})) {
    if (!key || v.dev) continue;                       // '' is the root project
    const i = key.lastIndexOf('node_modules/');
    if (i === -1) continue;                            // a workspace/link entry, not an installed package
    out.push({ key, name: key.slice(i + 'node_modules/'.length), version: v.version });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

// LICENSE-ish files first, then NOTICE files.
function findLicenseFiles(dir) {
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir).filter((n) => /^(licen[sc]e|copying|notice)([-._].*)?$/i.test(n)).sort();
  const lic = names.filter((n) => /^(licen[sc]e|copying)/i.test(n));
  const notice = names.filter((n) => /^notice/i.test(n));
  return [...lic.slice(0, 1), ...notice.slice(0, 1)].map((n) => join(dir, n));
}

// lockDir: the directory that holds package-lock.json and node_modules.
export function buildNotices(lock, lockDir) {
  const problems = [];
  const entries = [];
  for (const p of productionPackages(lock)) {
    const dir = join(lockDir, p.key);
    let pj;
    try { pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); }
    catch { problems.push(`${p.key}: package.json not found in ${dir} (run npm ci)`); continue; }
    const name = pj.name || p.name;
    const version = pj.version || p.version;
    const license = licenseString(pj) || lock.packages[p.key].license || '';
    const files = findLicenseFiles(dir);
    if (!license) problems.push(`${name} ${version}: no license field in package.json`);
    else if (!licenseAllowed(license)) problems.push(`${name} ${version}: license "${license}" is outside the allowlist (${ALLOWED.join(', ')})`);
    if (!files.length) problems.push(`${name} ${version}: no license file found in ${dir}`);
    if (license && files.length) {
      entries.push({ name, version, license, text: files.map((f) => readFileSync(f, 'utf8').trim()).join('\n\n') });
    }
  }
  if (problems.length) return { problems };
  const out = [
    'Grip third-party notices',
    '',
    'The Grip bridge (grip-bridge.mjs, install.mjs) bundles the open source packages listed below.',
    'Grip itself is licensed under LICENSE.md. The Figma plugin bundles no third-party code.',
    'Node.js is not part of this package (MIT license, https://github.com/nodejs/node/blob/main/LICENSE).',
    '',
  ];
  for (const e of entries) {
    out.push('='.repeat(78), `${e.name} ${e.version} (${e.license})`, '='.repeat(78), e.text, '');
  }
  return { text: out.join('\n'), count: entries.length };
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--lock' || a === '--out') && argv[i + 1] !== undefined) o[a.slice(2)] = argv[++i];
    else { console.error('usage: node scripts/third-party-notices.mjs [--lock <package-lock.json>] [--out <file>]'); process.exit(2); }
  }
  return o;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const o = parseArgs(process.argv.slice(2));
  const lockPath = resolve(o.lock ?? join(root, 'src', 'bridge', 'package-lock.json'));
  const outPath = resolve(o.out ?? join(root, 'THIRD-PARTY-NOTICES.txt'));
  const res = buildNotices(JSON.parse(readFileSync(lockPath, 'utf8')), dirname(lockPath));
  if (res.problems) {
    console.error('third-party notices FAILED:');
    for (const p of res.problems) console.error('  ' + p);
    process.exit(1);
  }
  writeFileSync(outPath, res.text);
  console.log(`Wrote ${outPath} (${res.count} packages, ${Math.round(res.text.length / 1024)} KB)`);
}
