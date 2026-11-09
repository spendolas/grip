// Run: node --test scripts/audit-gate.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { advisoriesFrom, evaluate } from './audit-gate.mjs';

const audit = {
  vulnerabilities: {
    zod: { via: [{ name: 'zod', severity: 'high', title: 'memory', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc' }] },
    sdk: { via: ['zod'] },
    ws: { via: [{ name: 'ws', severity: 'moderate', title: 'meh', url: 'https://github.com/advisories/GHSA-1111-2222-3333' }] },
  },
};
const NOW = new Date('2026-12-01');

test('advisoriesFrom keeps direct advisories and skips inherited ones', () => {
  const ids = advisoriesFrom(audit).map((a) => a.id).sort();
  assert.deepEqual(ids, ['GHSA-1111-2222-3333', 'GHSA-aaaa-bbbb-cccc']);
});
test('a high advisory with no policy entry blocks; moderate does not', () => {
  const r = evaluate(advisoriesFrom(audit), { accepted: [] }, NOW);
  assert.equal(r.ok, false);
  assert.deepEqual(r.blocking.map((a) => a.package), ['zod']);
});
test('an accepted advisory with a reason and a future review date passes', () => {
  const r = evaluate(advisoriesFrom(audit), { accepted: [{ id: 'GHSA-aaaa-bbbb-cccc', reason: 'x', reviewBy: '2027-01-01' }] }, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.waived.length, 1);
});
test('an expired or reason-less acceptance fails', () => {
  assert.equal(evaluate(advisoriesFrom(audit), { accepted: [{ id: 'GHSA-aaaa-bbbb-cccc', reason: 'x', reviewBy: '2026-01-01' }] }, NOW).ok, false);
  assert.equal(evaluate(advisoriesFrom(audit), { accepted: [{ id: 'GHSA-aaaa-bbbb-cccc', reviewBy: '2027-01-01' }] }, NOW).ok, false);
});
test('the committed policy is well formed', () => {
  const p = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'audit-policy.json'), 'utf8'));
  for (const a of p.accepted) {
    assert.match(a.id, /^GHSA-[a-z0-9-]+$/);
    assert.ok(a.reason.length > 20 && !Number.isNaN(Date.parse(a.reviewBy)), a.id);
  }
});
