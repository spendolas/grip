#!/usr/bin/env node
// Proves a flavour repo's shared tree is the snapshot it was exported as (see export-snapshot.mjs):
//   node scripts/snapshot-check.mjs [<dir>]     (default: the repo root)
// Reads <dir>/UPSTREAM.json {commit, files, treeHash}, recomputes the hash over the listed files and
// exits 1 on any difference or missing file. No dependencies, no names: it ships in the snapshot itself.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function sha(buf) { return createHash('sha256').update(buf).digest('hex'); }

// One hash over "path<TAB>sha256(content)" lines, sorted by path.
export function treeHash(dir, files) {
  const lines = [...files].sort().map((f) => `${f}\t${sha(readFileSync(join(dir, f)))}`);
  return sha(lines.join('\n') + '\n');
}

export function check(target) {
  const m = JSON.parse(readFileSync(join(target, 'UPSTREAM.json'), 'utf8'));
  const missing = m.files.filter((f) => !existsSync(join(target, f)));
  if (missing.length) return { ok: false, reason: `missing: ${missing.slice(0, 5).join(', ')}` };
  return treeHash(target, m.files) === m.treeHash
    ? { ok: true, commit: m.commit }
    : { ok: false, reason: 'the shared tree differs from the snapshot (a shared file was edited in this repo)' };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const dir = resolve(process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..'));
  const r = check(dir);
  console.log(r.ok ? `snapshot intact (from ${r.commit})` : `snapshot BROKEN: ${r.reason}`);
  process.exit(r.ok ? 0 : 1);
}
