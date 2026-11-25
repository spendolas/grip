#!/usr/bin/env node
// Export the SHARED tree of this repo as a read-only snapshot into another checkout (the
// "trimmed source" a flavour repo holds; spec Amendment A: this repo is the only place shared
// code is edited, the target never edits it).
//
//   node scripts/export-snapshot.mjs --to <dir> [--flavour <dir>] [--denylist <file>] [--apply]
//   node scripts/snapshot-check.mjs [<dir>]                  (ships in the snapshot; run it IN the target's CI)
//
// Without --apply nothing is written: it prints what would change. With --apply it copies every
// tracked file except the excluded ones (docs, marketing, licence, changelog, the public
// flavour's own files), removes files a previous export wrote and this one no longer has,
// copies <flavour>/flavour.json to flavour/flavour.json, and writes UPSTREAM.json:
// {commit, files, treeHash}. The target keeps its own README, LICENSE, CHANGELOG, CI test
// workflow and golden file; it never touches git (the owner commits and pushes).
// --denylist: a text file OUTSIDE both repos, one word or phrase per line (# comments); every
// exported file (and the flavour file) is scanned case-insensitively, hits are listed and the
// export is refused (exit 2) unless there are none.
// Every exported text file is scrubbed (SCRUB below: no personal handle, no sibling-tool name); the
// hash in UPSTREAM.json covers the scrubbed bytes, and scripts/snapshot-check.mjs (exported too)
// recomputes it in the target's CI to prove nobody edited the shared tree there.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha, treeHash } from './snapshot-check.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Never exported (matched against the tracked path; a trailing / means a folder).
export const EXCLUDE = [
  'docs/', 'assets/', 'ROADMAP.md', 'README.md', 'CLAUDE.md', 'CHANGELOG.md', 'LICENSE.md',
  'flavour/flavour.json', 'scripts/public-plugin-golden.json', '.github/workflows/test.yml',
  'UPSTREAM.json', 'scripts/export-snapshot.mjs', 'scripts/export-snapshot.test.mjs',
];
export function excluded(path, extra = []) {
  return [...EXCLUDE, ...extra].some((e) => (e.endsWith('/') ? path.startsWith(e) : path === e));
}

export function sharedFiles(repo, extra = []) {
  return execFileSync('git', ['ls-files', '-z'], { cwd: repo, encoding: 'utf8' })
    .split('\0').filter(Boolean).filter((f) => !excluded(f, extra) && existsSync(join(repo, f)));
}


// Applied to every exported text file, in order, so the snapshot carries no personal handle and no
// mention of a sibling tool (the tree hash in UPSTREAM.json is over the scrubbed bytes). The
// specific rules keep sentences readable; the last two are a catch-all, counted and reported.
export const SCRUB = [
  [/ ?\(the same model as Gaffer\)/g, ''],
  [/ ?Modelled on Gaffer's bundle-daemon\.sh\./g, ''],
  [/Modelled on Gaffer's gate \(spendolas\/gaffer-ae\)\. Differences:/g, 'Differences from the earlier gate it follows:'],
  [/the gaffer approach/g, 'the usual approach'],
  [/gaffer's AE panel/g, "another tool's panel"],
  [/spendolas\.github\.io/g, 'example-org.github.io'],
  [/spendolas\/grip/g, 'example-org/grip'],
];
export const CATCH_ALL = [[/spendolas/gi, 'example-org'], [/gaffer/gi, 'sibling-tool']];
export function scrub(buf) {
  if (buf.includes(0)) return { buf, generic: 0 };   // binary: untouched
  let t = buf.toString('utf8');
  for (const [re, to] of SCRUB) t = t.replace(re, to);
  let generic = 0;
  for (const [re, to] of CATCH_ALL) t = t.replace(re, () => { generic++; return to; });
  return { buf: Buffer.from(t), generic };
}

export function scanDenylist(entries, files, read) {
  const words = entries.map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => l.toLowerCase());
  const hits = [];
  for (const f of files) {
    const text = read(f).toLowerCase();
    for (const w of words) {
      const i = text.indexOf(w);
      if (i >= 0) hits.push({ file: f, line: text.slice(0, i).split('\n').length, word: w });
    }
  }
  return hits;
}

function main() {
  const a = process.argv.slice(2);
  const get = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const to = get('--to');
  if (!to) { console.error('usage: export-snapshot.mjs --to <dir> [--flavour <dir>] [--denylist <file>] [--apply]   (check a target with scripts/snapshot-check.mjs)'); process.exit(64); }
  const target = resolve(to);
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim();
  if (dirty) { console.error('refusing: tracked files in this repo have uncommitted changes (export is of the committed tree)'); process.exit(1); }
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const flavourDir = get('--flavour') ? resolve(get('--flavour')) : null;
  // What each exported file will contain: the scrubbed committed bytes (the flavour file is used as is).
  const content = new Map();
  let generic = 0;
  for (const f of sharedFiles(root)) { const r = scrub(readFileSync(join(root, f))); generic += r.generic; content.set(f, r.buf); }
  if (flavourDir) content.set('flavour/flavour.json', readFileSync(join(flavourDir, 'flavour.json')));
  const all = [...content.keys()];
  if (get('--denylist')) {
    const hits = scanDenylist(readFileSync(get('--denylist'), 'utf8').split('\n'), all, (f) => content.get(f).toString('utf8'));
    if (hits.length) {
      for (const h of hits) console.error(`denylist hit: ${h.file}:${h.line} (${h.word})`);
      console.error(`refused: ${hits.length} hit(s)`); process.exit(2);
    }
  }
  let old = [];
  try { old = JSON.parse(readFileSync(join(target, 'UPSTREAM.json'), 'utf8')).files; } catch { /* first export */ }
  const stale = old.filter((f) => !content.has(f));
  const changed = all.filter((f) => !existsSync(join(target, f)) || sha(readFileSync(join(target, f))) !== sha(content.get(f)));
  console.log(`${all.length} files from ${commit.slice(0, 12)}; ${changed.length} to write, ${stale.length} to remove` + (generic ? `; ${generic} catch-all scrub(s): add a specific rule` : ''));
  if (!a.includes('--apply')) { console.log('dry run (add --apply to write)'); return; }
  for (const f of all) { mkdirSync(dirname(join(target, f)), { recursive: true }); writeFileSync(join(target, f), content.get(f)); }
  for (const f of stale) rmSync(join(target, f), { force: true });
  writeFileSync(join(target, 'UPSTREAM.json'), JSON.stringify({ commit, files: all, treeHash: treeHash(target, all) }, null, 2) + '\n');
  console.log('written; commit and push it yourself');
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
