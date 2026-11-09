// Release gate for `npm audit` on production dependencies.
//
// `npm audit --audit-level=high` is all-or-nothing: one advisory with no
// available fix (or one that does not apply to how Grip uses a package) would
// block every release forever. This keeps the check strict but explicit: any
// high/critical advisory fails the gate unless scripts/audit-policy.json lists
// it with a written reason and a review date, and an expired entry fails too.
//
// Usage: node scripts/audit-gate.mjs <dir> [<dir> ...]   (e.g. src/bridge src/plugin)
// Needs the network (npm audit); CI runs it only on a release or dry run.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BLOCKING = new Set(['high', 'critical']);

// `npm audit --json` -> [{ id, package, severity, title, url }] (direct advisories only).
export function advisoriesFrom(audit) {
  const out = new Map();
  for (const [name, v] of Object.entries(audit?.vulnerabilities ?? {})) {
    for (const via of v.via ?? []) {
      if (!via || typeof via !== 'object') continue; // a string = "inherited from <pkg>"
      const id = String(via.url ?? '').split('/').pop() || String(via.source ?? '');
      if (!out.has(id)) out.set(id, { id, package: via.name ?? name, severity: via.severity, title: via.title, url: via.url });
    }
  }
  return [...out.values()];
}

// Pure decision: which advisories block, which are accepted, which acceptances expired.
export function evaluate(advisories, policy, now = new Date()) {
  const accepted = new Map((policy?.accepted ?? []).map((a) => [a.id, a]));
  const blocking = [], waived = [], expired = [];
  for (const adv of advisories) {
    if (!BLOCKING.has(adv.severity)) continue;
    const a = accepted.get(adv.id);
    if (!a) { blocking.push(adv); continue; }
    if (!a.reason || !a.reviewBy || Number.isNaN(Date.parse(a.reviewBy)) || new Date(a.reviewBy) < now) { expired.push({ ...adv, reviewBy: a.reviewBy }); continue; }
    waived.push({ ...adv, reason: a.reason, reviewBy: a.reviewBy });
  }
  return { ok: blocking.length === 0 && expired.length === 0, blocking, waived, expired };
}

export function runAudit(dir) {
  const r = spawnSync('npm', ['audit', '--omit=dev', '--json'], { cwd: dir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  // npm audit exits non-zero when it finds anything; only a missing/unparseable report is an error.
  try { return JSON.parse(r.stdout); }
  catch { throw new Error(`npm audit gave no JSON report in ${dir}: ${(r.stderr || r.stdout || '').slice(0, 300)}`); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dirs = process.argv.slice(2);
  if (!dirs.length) { console.error('usage: node scripts/audit-gate.mjs <dir> [<dir> ...]'); process.exit(2); }
  const policy = JSON.parse(readFileSync(join(HERE, 'audit-policy.json'), 'utf8'));
  let failed = false;
  for (const dir of dirs) {
    const res = evaluate(advisoriesFrom(runAudit(dir)), policy);
    console.log(`${dir}: ${res.ok ? 'ok' : 'FAIL'} (${res.blocking.length} blocking, ${res.waived.length} accepted, ${res.expired.length} expired)`);
    for (const a of res.blocking) console.log(`  BLOCKING ${a.severity} ${a.package}: ${a.title} ${a.url}`);
    for (const a of res.expired) console.log(`  EXPIRED acceptance ${a.id} (${a.package}), review was due ${a.reviewBy}`);
    for (const a of res.waived) console.log(`  accepted ${a.id} (${a.package}) until ${a.reviewBy}: ${a.reason}`);
    if (!res.ok) failed = true;
  }
  process.exit(failed ? 1 : 0);
}
