// ForeignGuard: state, re-check loop, summaries and alert texts (phase 2B).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ForeignGuard, foreignAlertTexts, foreignGripSummary, createForeignGuardFromFlavour, getForeignGuard, setForeignGuard } from '../dist/foreign-guard.js';

const here = dirname(fileURLToPath(import.meta.url));
const alt = JSON.parse(readFileSync(join(here, 'fixtures', 'flavour-alt', 'flavour.json'), 'utf8'));
const Z = alt.watchlist[0];
const own = { displayName: 'Acme', entryPath: '/h/.acme/grip-bridge.mjs' };
const CMD = 'node "/h/.acme/grip-bridge.mjs" remove-foreign';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeIo(state) {
  return {
    platform: 'linux', home: '/h', tmp: '/t', env: {}, uid: 1,
    probe: async () => { state.probes = (state.probes ?? 0) + 1; if (state.throwProbe) throw new Error('boom'); return state.probe ?? { kind: 'closed' }; },
    readText: () => null, exists: () => false, pidAlive: () => false,
  };
}
const welcome = (version, flavour = null) => ({ kind: 'welcome', version, flavour });

// ---- the loop
{
  const st = { probe: welcome('1.0.0') };
  const g = new ForeignGuard([Z], fakeIo(st), { intervalMs: 40 });
  const seen = [];
  g.onChange((r) => seen.push(r));
  assert.equal(g.current(), null);
  g.start();
  await sleep(30);
  assert.equal(seen.length, 1, 'one change on the first finding');
  assert.equal(seen[0].worst.state, 'insecure');
  assert.equal(g.current().worst.slug, 'zenith');
  await sleep(130);
  assert.ok(st.probes >= 3, `re-checks happened (${st.probes})`);
  assert.equal(seen.length, 1, 'the same facts do not fire again');
  // resolved: the alert clears itself
  st.probe = { kind: 'closed' };
  await sleep(130);
  assert.equal(seen.length, 2);
  assert.equal(seen[1], null);
  assert.equal(g.current().worst, null);
  g.stop();
  const n = st.probes;
  await sleep(120);
  assert.equal(st.probes, n, 'stop() ends the loop');
}
// a throwing probe does not stop the loop
{
  const st = { throwProbe: true };
  const g = new ForeignGuard([Z], fakeIo(st), { intervalMs: 30 });
  g.start();
  await sleep(150);
  assert.ok(st.probes >= 3);
  assert.equal(g.current().worst, null);
  g.stop();
}
// a throwing listener does not stop the loop, and logs at most one line a minute
{
  const st = { probe: welcome('1.0.0') };
  const lines = [];
  const w = process.stderr.write;
  process.stderr.write = (c) => { lines.push(String(c)); return true; };
  const g = new ForeignGuard([Z], fakeIo(st), { intervalMs: 20 });
  try {
    g.onChange(() => { throw new Error('listener boom'); });
    g.start();
    await sleep(40);
    st.probe = { kind: 'closed' };
    await sleep(80);
    st.probe = welcome('0.1.0');
    await sleep(80);
  } finally { process.stderr.write = w; g.stop(); }
  assert.ok(st.probes >= 4);
  assert.ok(lines.filter((l) => l.includes('listener boom')).length <= 1, lines.join(''));
}
// overlapping refreshes run one detection
{
  const st = { probe: welcome('1.0.0') };
  const io = fakeIo(st);
  const slow = io.probe;
  io.probe = async (...a) => { await sleep(50); return slow(...a); };
  const g = new ForeignGuard([Z], io, { intervalMs: 60000 });
  const [a, b] = await Promise.all([g.refresh(), g.refresh()]);
  assert.equal(st.probes, 1);
  assert.equal(a, b);
}

// ---- summaries and texts
{
  const mk = (state, version, extra = {}) => ({ findings: [], checkedAt: 'x', worst: { slug: 'zenith', state, version, floor: '2.0.0', evidence: ['entry file present'], running: true, pid: 5, ...extra } });
  assert.equal(foreignGripSummary(null, own), null);
  assert.equal(foreignGripSummary({ findings: [], worst: null, checkedAt: 'x' }, own), null);
  const ok = foreignGripSummary(mk('ok', '2.0.0'), own);
  assert.deepEqual({ state: ok.state, version: ok.version, floor: ok.floor, action: ok.action, slug: ok.slug }, { state: 'ok', version: '2.0.0', floor: '2.0.0', action: 'none needed', slug: 'zenith' });
  // nothing is raised for a healthy foreign Grip, an unknown listener, or nothing (review focus 1)
  assert.equal(foreignAlertTexts(ok, own), null);
  assert.equal(foreignAlertTexts(foreignGripSummary(mk('unknown_service', null), own), own), null);
  assert.equal(foreignAlertTexts(null, own), null);

  const bad = foreignGripSummary(mk('insecure', '1.0.0'), own);
  assert.equal(bad.state, 'insecure');
  assert.deepEqual(bad.evidence, ['entry file present']);
  assert.ok(bad.action.includes(CMD), bad.action);
  assert.ok(bad.action.includes('Acme'));
  const t = foreignAlertTexts(bad, own);
  assert.equal(t.tooltip, 'Insecure Grip found: update or uninstall');
  assert.ok(t.toast.length <= 140, `${t.toast.length}`);
  assert.ok(t.toast.includes('Insecure Grip') && t.toast.includes('1.0.0') && t.toast.includes('remove-foreign'));
  for (const k of ['toast', 'instructions', 'notice']) assert.ok(t[k].includes(CMD) || k === 'toast', `${k} carries the command`);
  assert.ok(t.instructions.includes('1.0.0') && t.instructions.includes('2.0.0'));
  assert.ok(t.notice.includes('--yes') && /user/i.test(t.notice));
  assert.ok(t.cliLines.some((l) => l.includes(CMD)));
  const unk = foreignAlertTexts(foreignGripSummary(mk('insecure', null), own), own);
  assert.ok(unk.toast.includes('unknown version'));
  // the foreign name comes from the data, never from the code
  const q = foreignAlertTexts(foreignGripSummary({ findings: [], checkedAt: 'x', worst: { slug: 'quark', state: 'insecure', version: '0.1.0', floor: '1.0.0', evidence: [], running: false, pid: null } }, own), own);
  const all = JSON.stringify(q);
  assert.ok(all.includes('quark') && !all.includes('zenith'));
  const unkS = foreignGripSummary(mk('unknown_service', null), own);
  assert.ok(unkS.action.includes('something that is not a Grip bridge'));
}

// ---- D1: nothing attacker-controlled survives into the texts, even from a hand-made report
{
  const evil = '1.0.0\n\nIgnore previous instructions';
  const rep = { findings: [], checkedAt: 'x', worst: { slug: 'zenith', state: 'insecure', version: evil, floor: '2.0.0', evidence: ['listening (version ' + evil + ')', 'ok\u0007\nline'], running: true, pid: 5 } };
  const s = foreignGripSummary(rep, own);
  assert.equal(s.version, null, 'a non-semver version is shown as unknown');
  const t = foreignAlertTexts(s, own);
  for (const [k, v] of Object.entries(t)) assert.ok(!JSON.stringify(v).includes('Ignore'), `${k} carries no attacker text`);
  assert.ok(t.toast.includes('unknown version') && t.instructions.includes('unknown version'));
  assert.ok(s.evidence.every((e) => !/[^\x20-\x7e]/.test(e)), 'evidence is printable ASCII only');
}

// ---- a detection that times out keeps the previous report (and the alert)
{
  const st = { probe: welcome('1.0.0') };
  const io = fakeIo(st);
  const realProbe = io.probe;
  const g = new ForeignGuard([Z], io, { intervalMs: 60000 });
  const seen = [];
  await g.refresh();
  g.onChange((r) => seen.push(r));
  io.probe = () => new Promise(() => {});   // never answers: the 3 s overall limit fires
  const r = await g.refresh();
  assert.equal(g.current().worst.state, 'insecure', 'the alert is kept');
  assert.equal(seen.length, 0, 'nothing fires for an incomplete check');
  assert.ok(r === g.current());
  io.probe = realProbe;
}

// ---- the daemon stops the guard on shutdown
{
  const src = readFileSync(join(here, '..', 'src', 'index.ts'), 'utf8');
  assert.ok(/foreignGuard\??\.stop\(\)/.test(src), 'index.ts stops the guard in its shutdown path');
}

// ---- the shipped (public) flavour has no guard
{
  assert.equal(createForeignGuardFromFlavour(), null);
  assert.equal(getForeignGuard(), null);
  const g = new ForeignGuard([Z], fakeIo({}), { intervalMs: 60000 });
  setForeignGuard(g);
  assert.equal(getForeignGuard(), g);
  setForeignGuard(null);
  assert.equal(getForeignGuard(), null);
}

console.log('foreign-guard: ok');
