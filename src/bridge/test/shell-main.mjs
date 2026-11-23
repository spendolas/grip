// Shell main thread (src/plugin/shell/shell-code.js): payload install, hot swap, cache,
// rollback on a throwing payload, pairing storage. The REAL script runs in a node:vm
// context against a fake `figma`; no Figma needed.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..', '..');
const { loadFlavour, renderTemplate } = await import(join(repo, 'scripts', 'gen-flavour.mjs'));
const acme = loadFlavour(join(here, 'fixtures', 'flavour-alt'));
const source = renderTemplate('shell-code.js', readFileSync(join(repo, 'src', 'plugin', 'shell', 'shell-code.js'), 'utf8'), acme);
assert.ok(!/__[A-Z][A-Z0-9_]*__/.test(source.replace(/__html__|__shell/g, '')), 'no placeholder is left in the shell code');

const flush = () => new Promise((r) => setImmediate(r));

function boot(initialStorage = {}) {
  const store = new Map(Object.entries(initialStorage));
  const posted = [];
  const registered = [];          // live [ev, cb] pairs on the real figma
  const opened = [];
  let now = 0;
  const timers = [];
  const figma = {
    showUI: (...a) => { figma.shown = a; },
    ui: { postMessage: (m) => posted.push(JSON.parse(JSON.stringify(m))), onmessage: null },
    clientStorage: {
      getAsync: async (k) => store.get(k),
      setAsync: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); },
      deleteAsync: async (k) => { store.delete(k); },
    },
    on: (ev, cb) => registered.push([ev, cb]),
    once: (ev, cb) => registered.push([ev, cb]),
    off: (ev, cb) => { const i = registered.findIndex(([e, c]) => e === ev && c === cb); if (i >= 0) registered.splice(i, 1); },
    openExternal: (u) => opened.push(u),
  };
  const ctx = vm.createContext({
    figma, __html__: '<html>', console, Date: { now: () => now },
    setTimeout: (fn, ms) => { const t = { fn, at: now + ms, id: timers.length }; timers.push(t); return t.id; },
    clearTimeout: (id) => { const t = timers[id]; if (t) t.fn = null; },
  });
  vm.runInContext(source, ctx, { filename: 'shell-code.js' });
  const send = async (m) => { await figma.ui.onmessage(m); await flush(); };
  const advance = async (ms) => { now += ms; for (const t of timers) if (t.fn && t.at <= now) { const f = t.fn; t.fn = null; f(); } await flush(); };
  const kinds = (k) => posted.filter((p) => p.kind === k);
  return { ctx, figma, store, posted, registered, opened, send, advance, kinds };
}

const env = (v) => JSON.stringify({ layout: 1, header: { version: v }, code: 'x', ui: '', sig: 's' + v });
// A payload: records requests; optionally holds the response until released.
const goodCode = (tag, extra = '') => `
  const calls = (globalThis.__calls = globalThis.__calls || []);
  __shell.ui.onmessage = async (m) => { calls.push([${JSON.stringify(tag)}, m.kind]); if (m.kind === 'request') { if (m.hold) await m.hold; figma.ui.postMessage({ kind: 'response', id: m.id, result: ${JSON.stringify(tag)} }); } };
  __shell.on('selectionchange', function ${tag.replace(/\W/g, '_')}() {});
  ${extra}`;

// ---- shell basics
{
  const t = boot();
  assert.equal(JSON.stringify(t.figma.shown), JSON.stringify(['<html>', { width: 120, height: 32 }]), 'the shell shows the strip UI');
}

// (g) pairing storage, same key as code.ts
{
  const t = boot();
  await t.send({ kind: 'pairGet' });
  assert.deepEqual(t.kinds('pairToken'), [{ kind: 'pairToken', token: null }]);
  await t.send({ kind: 'pairSet', token: { id: 'abcd', secret: 's'.repeat(40), extra: 1 } });
  assert.deepEqual(t.store.get('grip.pairing'), { id: 'abcd', secret: 's'.repeat(40) });
  await t.send({ kind: 'pairGet' });
  assert.deepEqual(t.kinds('pairToken')[1].token, { id: 'abcd', secret: 's'.repeat(40) });
  await t.send({ kind: 'pairClear' });
  assert.equal(t.store.has('grip.pairing'), false);
}

// (h) before any payload
{
  const t = boot();
  await t.send({ kind: 'welcome', sessionId: 's1' });
  await t.send({ kind: 'request', id: 'r1', method: 'get_node' });
  const r = t.kinds('response');
  assert.equal(r.length, 1);
  assert.equal(r[0].id, 'r1');
  assert.match(r[0].error, /plugin_loading/);
  await t.send({ kind: 'openSetup' });
  assert.deepEqual(t.opened, ['https://example.invalid/acme/']);
}

// (a)(b)(i) install runs the payload, caches it after success, replays the stored welcome
{
  const t = boot();
  await t.send({ kind: 'welcome', sessionId: 's1' });
  await t.send({ kind: 'payloadInstall', version: '1.0.0', code: goodCode('v1'), envelope: env('1.0.0') });
  assert.deepEqual(t.kinds('payloadResult'), [{ kind: 'payloadResult', ok: true, version: '1.0.0' }]);
  assert.equal(t.store.get('grip.payload'), env('1.0.0'), 'cached after a successful install');
  assert.deepEqual(t.registered.map(([e]) => e), ['selectionchange']);
  await t.send({ kind: 'request', id: 'r2', method: 'x' });
  assert.deepEqual(t.kinds('response').map((r) => [r.id, r.result]), [['r2', 'v1']]);
  // a welcome that arrives later is forwarded; the stored one was replayed at install
  await t.send({ kind: 'welcome', sessionId: 's2' });
  // payload-side open setup is forwarded, not handled by the shell
  await t.send({ kind: 'openSetup' });
  assert.deepEqual(t.opened, [], 'with a live payload openSetup is the payload\'s');
}
{
  // the sourceURL line is attached
  const t = boot();
  await t.send({ kind: 'payloadInstall', version: '1.2.3', code: goodCode('v1', 'globalThis.__stack = new Error("probe").stack;'), envelope: env('1.2.3') });
  assert.equal(t.kinds('payloadResult')[0].ok, true);
  assert.match(t.ctx.__stack, /payload-v1\.2\.3\.js/, 'the evaluated code carries its sourceURL');
}

// (c) swap deferral while a call is in flight
{
  const t = boot();
  await t.send({ kind: 'payloadInstall', version: '1.0.0', code: goodCode('v1'), envelope: env('1.0.0') });
  let release;
  const hold = new Promise((r) => { release = r; });
  const slow = t.figma.ui.onmessage({ kind: 'request', id: 'slow', method: 'w', hold });
  await flush();
  await t.send({ kind: 'payloadInstall', version: '1.1.0', code: goodCode('v2'), envelope: env('1.1.0') });
  assert.deepEqual(t.kinds('payloadPending'), [{ kind: 'payloadPending', version: '1.1.0' }]);
  assert.equal(t.kinds('payloadResult').length, 1, 'not applied while busy');
  // the OLD handler still answers a new request
  await t.send({ kind: 'request', id: 'other', method: 'r' });
  assert.equal(t.kinds('response').find((r) => r.id === 'other').result, 'v1');
  await t.advance(2000);
  assert.equal(t.kinds('payloadResult').length, 1, 'the timer does not force a swap');
  // a newer pending replaces the older pending one
  await t.send({ kind: 'payloadInstall', version: '1.2.0', code: goodCode('v3'), envelope: env('1.2.0') });
  release(); await slow; await flush();
  const res = t.kinds('payloadResult');
  assert.equal(res.length, 2);
  assert.equal(res[1].version, '1.2.0', 'the held payload was replaced by the newer one, 1.1.0 never ran');
  assert.equal(t.store.get('grip.payload'), env('1.2.0'));
  await t.send({ kind: 'request', id: 'after', method: 'r' });
  assert.equal(t.kinds('response').find((r) => r.id === 'after').result, 'v3');
  // (e) the old payload's listeners were removed, the new one's are live
  assert.deepEqual(t.registered.map(([, c]) => c.name), ['v3']);
}

// (d) a payload that throws: previous handler, cache and listeners are kept
{
  const t = boot();
  await t.send({ kind: 'payloadInstall', version: '1.0.0', code: goodCode('v1'), envelope: env('1.0.0') });
  await t.send({ kind: 'payloadInstall', version: '1.1.0', code: goodCode('bad', 'throw new Error("boom");'), envelope: env('1.1.0') });
  const res = t.kinds('payloadResult');
  assert.equal(res[1].ok, false);
  assert.match(res[1].error, /boom/);
  assert.equal(t.store.get('grip.payload'), env('1.0.0'), 'cache untouched');
  assert.deepEqual(t.registered.map(([, c]) => c.name), ['v1'], 'no listener of the failing payload remains');
  await t.send({ kind: 'request', id: 'q', method: 'r' });
  assert.equal(t.kinds('response').find((r) => r.id === 'q').result, 'v1');
  // a payload that registers nothing is a failed install too
  await t.send({ kind: 'payloadInstall', version: '1.2.0', code: '/* no handler */', envelope: env('1.2.0') });
  assert.equal(t.kinds('payloadResult')[2].ok, false);
  // a syntax error
  await t.send({ kind: 'payloadInstall', version: '1.3.0', code: 'function (', envelope: env('1.3.0') });
  assert.equal(t.kinds('payloadResult')[3].ok, false);
  assert.equal(t.store.get('grip.payload'), env('1.0.0'));
}
// registrations by a replaced payload after the swap are ignored
{
  const t = boot();
  await t.send({ kind: 'payloadInstall', version: '1.0.0', code: goodCode('v1', 'globalThis.__host = __shell;'), envelope: env('1.0.0') });
  await t.send({ kind: 'payloadInstall', version: '1.1.0', code: goodCode('v2'), envelope: env('1.1.0') });
  t.ctx.__host.on('late', function lateCb() {});
  t.ctx.__host.ui.onmessage = async () => {};
  assert.deepEqual(t.registered.map(([, c]) => c.name), ['v2']);
}

// (f) cache
{
  const t = boot({ 'grip.payload': env('1.0.0') });
  await t.send({ kind: 'payloadGet' });
  assert.deepEqual(t.kinds('payloadCache'), [{ kind: 'payloadCache', envelope: env('1.0.0') }]);
  await t.send({ kind: 'payloadDrop' });
  assert.equal(t.store.has('grip.payload'), false);
  await t.send({ kind: 'payloadGet' });
  assert.deepEqual(t.kinds('payloadCache')[1], { kind: 'payloadCache', envelope: null });
}
// junk from the UI never installs
{
  const t = boot();
  await t.send({ kind: 'payloadInstall', version: 5, code: 'x', envelope: 'e' });
  await t.send({ kind: 'payloadInstall', version: '1.0.0', code: '', envelope: 'e' });
  await t.send({ kind: 'payloadInstall', version: '1.0.0', code: 'x' });
  assert.equal(t.kinds('payloadResult').filter((r) => r.ok).length, 0);
  assert.equal(t.store.has('grip.payload'), false);
}

// F: the version string goes into the sourceURL line, so only x.y.z may reach the evaluator
{
  const t = boot();
  await t.send({ kind: 'payloadInstall', version: '1.0.0\n;globalThis.__pwned = 1;//', code: goodCode('v1'), envelope: env('1.0.0') });
  await t.send({ kind: 'payloadInstall', version: '1.0', code: goodCode('v1'), envelope: env('1.0.0') });
  await t.send({ kind: 'payloadInstall', version: '1.0.0 ', code: goodCode('v1'), envelope: env('1.0.0') });
  assert.equal(t.kinds('payloadResult').length, 0, 'nothing is evaluated');
  assert.equal(t.ctx.__pwned, undefined);
  assert.equal(t.store.has('grip.payload'), false);
}

// G: a call that never settles cannot block an update forever (cap SWAP_DEFER_MAX_MS = 120 s)
{
  const t = boot();
  await t.send({ kind: 'payloadInstall', version: '1.0.0', code: goodCode('v1'), envelope: env('1.0.0') });
  void t.figma.ui.onmessage({ kind: 'request', id: 'stuck', method: 'w', hold: new Promise(() => {}) });
  await flush();
  await t.send({ kind: 'payloadInstall', version: '1.1.0', code: goodCode('v2'), envelope: env('1.1.0') });
  for (let i = 0; i < 230; i++) await t.advance(500);           // 115 s: still waiting
  assert.equal(t.kinds('payloadResult').length, 1, 'still deferred before the cap');
  for (let i = 0; i < 30; i++) await t.advance(500);            // past 120 s
  const res = t.kinds('payloadResult');
  assert.equal(res.length, 2, 'applied after the cap');
  assert.equal(res[1].version, '1.1.0');
  await t.send({ kind: 'request', id: 'after', method: 'r' });
  assert.equal(t.kinds('response').find((r) => r.id === 'after').result, 'v2');
}

console.log('shell-main.mjs OK');
