// Agent-facing surfaces of the insecure-Grip guard: session instructions, the notice on the
// first successful result of EVERY session (no throttle), grip_health, grip_update check.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSession, destroySession } from '../dist/mcp-server.js';
import { ForeignGuard, setForeignGuard, foreignGripSummary, foreignAlertTexts, ownInfo } from '../dist/foreign-guard.js';
import * as U from '../dist/update.js';

const here = dirname(fileURLToPath(import.meta.url));
const alt = JSON.parse(readFileSync(join(here, 'fixtures', 'flavour-alt', 'flavour.json'), 'utf8'));
const Z = alt.watchlist[0];
const root = mkdtempSync(join(tmpdir(), 'foreign-surfaces-'));
process.env.GRIP_HOME = join(root, 'home');
process.env.GRIP_STATUS_PATH = join(root, 'nostatus.json');
process.env.GRIP_RELEASES_API = 'http://127.0.0.1:9/none';
delete process.env.GRIP_NO_UPDATE_CHECK;
U.resetUpdateState();

const makeBridge = () => ({ on() {}, off() {}, snapshot: () => ({ pluginCount: 0, pendingCount: 0, plugins: [] }), request: async () => ({ ok: true }) });
async function connect() {
  const live = createSession(makeBridge());
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await live.server.connect(st);
  const client = new Client({ name: 't', version: '0' }, { capabilities: {} });
  await client.connect(ct);
  return { live, client };
}
const texts = (r) => r.content.map((c) => c.text);
const health = (c) => c.client.callTool({ name: 'grip_health', arguments: {} });
const json = (r) => JSON.parse(r.content[0].text);

async function guardWith(probe) {
  const io = { platform: 'linux', home: '/h', tmp: '/t', env: {}, uid: 1, probe: async () => probe, readText: () => null, exists: () => false, pidAlive: () => false };
  const g = new ForeignGuard([Z], io, { intervalMs: 60000 });
  await g.refresh();
  return g;
}
const own = ownInfo();
const bad = foreignAlertTexts(foreignGripSummary((await guardWith({ kind: 'welcome', version: '1.0.0', flavour: null })).current(), own), own);
assert.ok(bad && bad.notice.includes('remove-foreign'));

try {
  // ---- insecure
  setForeignGuard(await guardWith({ kind: 'welcome', version: '1.0.0', flavour: null }));
  {
    const a = await connect();
    assert.ok(a.client.getInstructions().includes(bad.instructions), 'instructions carry the paragraph');
    const r1 = await health(a);
    assert.equal(r1.content.length, 2, 'first successful result: one extra block');
    assert.equal(texts(r1)[1], bad.notice);
    assert.equal((await health(a)).content.length, 1, 'only once per session');
    const f = json(r1).foreignGrip;
    assert.equal(f.state, 'insecure');
    assert.equal(f.version, '1.0.0');
    assert.equal(f.floor, '2.0.0');
    assert.ok(Array.isArray(f.evidence) && f.evidence.length > 0);
    assert.ok(f.action.includes('remove-foreign'));
    assert.equal(f.slug, 'zenith');

    // another session, another tool: the notice again (no 3-day throttle)
    U.claimNotice('anything-else');
    const b = await connect();
    assert.ok(b.client.getInstructions().includes(bad.instructions));
    const rb = await b.client.callTool({ name: 'grip_capabilities', arguments: {} });
    assert.equal(rb.isError ?? false, false);
    assert.equal(texts(rb)[texts(rb).length - 1], bad.notice, 'every session is told');
    assert.equal(texts(rb).filter((t) => t === bad.notice).length, 1);

    // an erroring first call gets nothing; the next success does
    const c = await connect();
    const bogus = await c.client.callTool({ name: 'no_such_tool', arguments: {} });
    assert.equal(bogus.isError, true);
    assert.ok(!texts(bogus).includes(bad.notice));
    assert.ok(texts(await health(c)).includes(bad.notice));

    // grip_update check: the field and the notice at the start of the note
    const u = json(await c.client.callTool({ name: 'grip_update', arguments: { action: 'check' } }));
    assert.equal(u.foreignGrip.state, 'insecure');
    assert.ok(u.note.startsWith(bad.notice), u.note);

    // GRIP_NO_UPDATE_CHECK changes none of it
    process.env.GRIP_NO_UPDATE_CHECK = '1';
    const d = await connect();
    assert.ok(d.client.getInstructions().includes(bad.instructions));
    assert.deepEqual(texts(await health(d)).slice(1), [bad.notice]);
    const u2 = json(await d.client.callTool({ name: 'grip_update', arguments: { action: 'check' } }));
    assert.equal(u2.foreignGrip.state, 'insecure');
    assert.ok(u2.note.startsWith(bad.notice));
    delete process.env.GRIP_NO_UPDATE_CHECK;
    for (const s of [a, b, c, d]) destroySession(s.live);
  }

  // ---- healthy foreign Grip at the floor: reported in health, raises nothing (review focus 1)
  setForeignGuard(await guardWith({ kind: 'welcome', version: '2.0.0', flavour: null }));
  {
    const a = await connect();
    assert.ok(!a.client.getInstructions().includes('SECURITY NOTICE'));
    const r = await health(a);
    assert.equal(r.content.length, 1);
    assert.equal(json(r).foreignGrip.state, 'ok');
    assert.equal(json(r).foreignGrip.action, 'none needed');
    destroySession(a.live);
  }

  // ---- an unknown listener: health only
  setForeignGuard(await guardWith({ kind: 'other' }));
  {
    const a = await connect();
    assert.ok(!a.client.getInstructions().includes('SECURITY NOTICE'));
    const r = await health(a);
    assert.equal(r.content.length, 1);
    assert.equal(json(r).foreignGrip.state, 'unknown_service');
    destroySession(a.live);
  }

  // ---- resolved: nothing left anywhere on the next call / session
  {
    const g = await guardWith({ kind: 'welcome', version: '1.0.0', flavour: null });
    setForeignGuard(g);
    const a = await connect();
    setForeignGuard(await guardWith({ kind: 'closed' }));
    const r = await health(a);
    assert.equal(r.content.length, 1, 'a cleared alert is not announced');
    assert.ok(!('foreignGrip' in json(r)));
    destroySession(a.live);
  }
} finally {
  setForeignGuard(null);
}

// ---- no guard (the public flavour): nothing at all
{
  const a = await connect();
  assert.ok(!a.client.getInstructions().includes('SECURITY NOTICE'));
  const r = await health(a);
  assert.equal(r.content.length, 1);
  assert.ok(!('foreignGrip' in json(r)));
  destroySession(a.live);
}

console.log('foreign-surfaces: ok');
process.exit(0);
