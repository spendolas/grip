#!/usr/bin/env node
// Export the SHARED tree of this repo as a read-only snapshot into another checkout (the
// "trimmed source" a flavour repo holds; spec Amendment A: this repo is the only place shared
// code is edited, the target never edits it).
//
//   node scripts/export-snapshot.mjs --to <dir> [--flavour <dir>] [--denylist <file>] [--apply]
//   node scripts/export-snapshot.mjs --check <dir>            (run it IN the target's CI)
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
// --check <dir>: recompute the hash over the files listed in <dir>/UPSTREAM.json and compare
// (exit 1 on any difference): proves the shared tree was not edited in the target.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Never exported (matched against the tracked path; a trailing / means a folder).
export const EXCLUDE = [
  'docs/', 'assets/', 'ROADMAP.md', 'README.md', 'CLAUDE.md', 'CHANGELOG.md', 'LICENSE.md',
  'flavour/flavour.json', 'scripts/public-plugin-golden.json', '.github/workflows/test.yml',
  'UPSTREAM.json',
];
export function excluded(path, extra = []) {
  return [...EXCLUDE, ...extra].some((e) => (e.endsWith('/') ? path.startsWith(e) : path === e));
}

export function sha(buf) { return createHash('sha256').update(buf).digest('hex'); }

// One hash over "path<TAB>sha256(content)" lines, sorted by path.
export function treeHash(dir, files) {
  const lines = [...files].sort().map((f) => `${f}\t${sha(readFileSync(join(dir, f)))}`);
  return sha(lines.join('\n') + '\n');
}

export function sharedFiles(repo, extra = []) {
  return execFileSync('git', ['ls-files', '-z'], { cwd: repo, encoding: 'utf8' })
    .split('\0').filter(Boolean).filter((f) => !excluded(f, extra) && existsSync(join(repo, f)));
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

export function check(target) {
  const m = JSON.parse(readFileSync(join(target, 'UPSTREAM.json'), 'utf8'));
  const missing = m.files.filter((f) => !existsSync(join(target, f)));
  if (missing.length) return { ok: false, reason: `missing: ${missing.slice(0, 5).join(', ')}` };
  const h = treeHash(target, m.files);
  return h === m.treeHash ? { ok: true, commit: m.commit } : { ok: false, reason: 'the shared tree differs from the snapshot (a shared file was edited in this repo)' };
}

function main() {
  const a = process.argv.slice(2);
  const get = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  if (get('--check')) {
    const r = check(resolve(get('--check')));
    console.log(r.ok ? `snapshot intact (from ${r.commit})` : `snapshot BROKEN: ${r.reason}`);
    process.exit(r.ok ? 0 : 1);
  }
  const to = get('--to');
  if (!to) { console.error('usage: export-snapshot.mjs --to <dir> [--flavour <dir>] [--denylist <file>] [--apply] | --check <dir>'); process.exit(64); }
  const target = resolve(to);
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim();
  if (dirty) { console.error('refusing: tracked files in this repo have uncommitted changes (export is of the committed tree)'); process.exit(1); }
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const files = sharedFiles(root);
  const flavourDir = get('--flavour') ? resolve(get('--flavour')) : null;
  const flavourText = flavourDir ? readFileSync(join(flavourDir, 'flavour.json'), 'utf8') : null;
  if (get('--denylist')) {
    const hits = scanDenylist(readFileSync(get('--denylist'), 'utf8').split('\n'), [...files, ...(flavourText ? ['flavour/flavour.json'] : [])],
      (f) => (f === 'flavour/flavour.json' && flavourText !== null ? flavourText : readFileSync(join(root, f), 'utf8')));
    if (hits.length) {
      for (const h of hits) console.error(`denylist hit: ${h.file}:${h.line} (${h.word})`);
      console.error(`refused: ${hits.length} hit(s)`); process.exit(2);
    }
  }
  let old = [];
  try { old = JSON.parse(readFileSync(join(target, 'UPSTREAM.json'), 'utf8')).files; } catch { /* first export */ }
  const all = flavourText ? [...files, 'flavour/flavour.json'] : files;
  const stale = old.filter((f) => !all.includes(f));
  const changed = all.filter((f) => {
    const src = f === 'flavour/flavour.json' && flavourText !== null ? Buffer.from(flavourText) : readFileSync(join(root, f));
    return !existsSync(join(target, f)) || sha(readFileSync(join(target, f))) !== sha(src);
  });
  console.log(`${files.length} shared files from ${commit.slice(0, 12)}; ${changed.length} to write, ${stale.length} to remove`);
  if (!a.includes('--apply')) { console.log('dry run (add --apply to write)'); return; }
  for (const f of files) { mkdirSync(dirname(join(target, f)), { recursive: true }); cpSync(join(root, f), join(target, f)); }
  if (flavourText) { mkdirSync(join(target, 'flavour'), { recursive: true }); writeFileSync(join(target, 'flavour', 'flavour.json'), flavourText); }
  for (const f of stale) rmSync(join(target, f), { force: true });
  writeFileSync(join(target, 'UPSTREAM.json'), JSON.stringify({ commit, files: all, treeHash: treeHash(target, all) }, null, 2) + '\n');
  console.log('written; commit and push it yourself');
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
