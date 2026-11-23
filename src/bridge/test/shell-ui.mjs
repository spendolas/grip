// Shell page (templates/ui.html + loader + Ed25519 verifier): the REAL script runs in a
// node:vm fake DOM. Covers what the page will do with a payload: accept a valid one, refuse a
// tampered / foreign / older one while the live plugin keeps running, offline start from the
// cache, a payload that needs a newer shell, the optional ui patch, and that the handshake and
// pairing of the page are unchanged. Throwaway keys only.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHmac, createPublicKey, generateKeyPairSync, webcrypto } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..', '..');
const { loadFlavour } = await import(join(repo, 'scripts', 'gen-flavour.mjs'));
const { buildEnvelope, signEnvelope } = await import(join(repo, 'scripts', 'payload.mjs'));
const { bundleVerifier, renderShellUi, ed25519RawKeys } = await import(join(repo, 'src', 'plugin', 'shell', 'assemble.mjs'));

const acme = loadFlavour(join(here, 'fixtures', 'flavour-alt'));
const template = readFileSync(join(repo, 'src', 'plugin', 'templates', 'ui.html'), 'utf8');
const loaderJs = readFileSync(join(repo, 'src', 'plugin', 'shell', 'loader-ui.js'), 'utf8');
const verifierJs = bundleVerifier();

const pemOf = (k, t) => k.export({ type: t, format: 'pem' });
function newKey() { const kp = generateKeyPairSync('ed25519'); return { kp, pub: pemOf(kp.publicKey, 'spki'), priv: pemOf(kp.privateKey, 'pkcs8') }; }
function pageFor(keys) {
  const f = { ...acme, releaseKeys: keys.map((k) => k.pub) };
  const html = renderShellUi(template, f, { verifierJs, loaderJs });
  assert.ok(!/__[A-Z][A-Z0-9_]*__/.test(html), 'no placeholder survives');
  return /<script>([\s\S]*?)<\/script>/.exec(html)[1];
}
const sign = (key, version, code = 'var a = 1;', ui = '', over = {}) => {
  const e = signEnvelope(buildEnvelope({ shellProtocol: 1, flavour: 'acme', version, ...(over.header || {}) }, code, ui), key.priv, [createPublicKey(key.pub)]);
  return e;
};

function harness(src, { cache = null, autoInstall = true } = {}) {
  let now = 0, seq = 0;
  const timers = new Map();
  const classes = new Set();
  const listeners = {};
  const strip = { classList: { add: (...c) => c.forEach((x) => classes.add(x)), remove: (...c) => c.forEach((x) => classes.delete(x)), contains: (c) => classes.has(c) }, title: '', addEventListener: (t, f) => { (listeners[t] ??= []).push(f); } };
  const instances = [];
  class FakeWS {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.ls = []; instances.push(this); }
    addEventListener(t, f) { if (t === 'message') this.ls.push(f); }
    send(d) { this.sent.push(JSON.parse(d)); }
    open() { this.readyState = 1; this.onopen?.(); }
    deliver(o) { const ev = { data: JSON.stringify(o) }; this.onmessage?.(ev); this.ls.forEach((f) => f(ev)); }
    drop(code = 1006, reason = '') { this.readyState = 3; this.onclose?.({ code, reason }); }
  }
  const posted = [];
  const win = {};
  const store = { token: null, cache };
  const parentObj = {};
  const fromParent = (pluginMessage) => win.onmessage({ source: parentObj, data: { pluginMessage } });
  const mainThread = (m) => {
    if (m.kind === 'pairGet') fromParent({ kind: 'pairToken', token: store.token });
    else if (m.kind === 'pairSet') store.token = m.token;
    else if (m.kind === 'pairClear') store.token = null;
    else if (m.kind === 'payloadGet') fromParent({ kind: 'payloadCache', envelope: store.cache });
    else if (m.kind === 'payloadDrop') store.cache = null;
    else if (m.kind === 'payloadInstall' && autoInstall) fromParent({ kind: 'payloadResult', ok: true, version: m.version });
  };
  const ctx = vm.createContext({
    document: { getElementById: () => strip },
    WebSocket: FakeWS,
    parent: Object.assign(parentObj, { postMessage: (m) => { const c = JSON.parse(JSON.stringify(m)); posted.push(c); mainThread(c.pluginMessage); } }),
    window: win,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: now + (ms || 0) }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    JSON, TextEncoder, atob: (s) => Buffer.from(s, 'base64').toString('binary'), crypto: webcrypto,
  });
  vm.runInContext(src, ctx);
  return {
    ctx, posted, store, instances, strip,
    has: (c) => classes.has(c),
    title: () => strip.title,
    ws: () => instances.at(-1),
    fromMain: fromParent,
    fromElsewhere: (pluginMessage) => win.onmessage({ source: {}, data: { pluginMessage } }),
    installs: () => posted.map((p) => p.pluginMessage).filter((m) => m.kind === 'payloadInstall'),
    drops: () => posted.filter((p) => p.pluginMessage.kind === 'payloadDrop').length,
    advance: (ms) => { now += ms; for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); } },
  };
}

// a paired-less handshake with the acme bridge: trusted, payload_have sent
function connect(h) {
  const ws = h.ws();
  ws.open();
  ws.deliver({ kind: 'welcome', sessionId: 's0', flavour: 'acme', bridgeVersion: '0.9.7' });
  return ws;
}
const haves = (ws) => ws.sent.filter((m) => m.type === 'payload_have');
const reports = (ws) => ws.sent.filter((m) => m.type === 'payload_report');

const K = newKey();
const page = pageFor([K]);

// ---- (a) the verifier agrees with node:crypto and with the committed vector
{
  const v = JSON.parse(readFileSync(join(here, 'fixtures', 'payload-vector.json'), 'utf8'));
  assert.ok(!/\bimport\s|require\(/.test(verifierJs), 'the verifier is a self-contained IIFE');
  assert.ok(verifierJs.length < 60_000, `verifier size ${verifierJs.length}`);
  assert.ok(!verifierJs.includes('</script'), 'cannot close the page script');
  const sandbox = vm.createContext({});
  vm.runInContext(verifierJs, sandbox);
  const { signingMessage } = await import(join(repo, 'scripts', 'payload.mjs'));
  const check = (code) => vm.runInContext(`gripEdVerify(Uint8Array.from(${JSON.stringify([...Buffer.from(v.sigB64, 'base64')])}), Uint8Array.from(${JSON.stringify([...signingMessage(v.header, code, v.ui)])}), Uint8Array.from(${JSON.stringify([...Buffer.from(v.pubHex, 'hex')])}))`, sandbox);
  assert.equal(check(v.code), true, 'the committed vector verifies in the page verifier');
  assert.equal(check(v.code + ' '), false, 'a changed byte does not');
  // and a throwaway signature made by node:crypto
  assert.deepEqual(ed25519RawKeys({ releaseKeys: [K.pub] }), [Buffer.from(createPublicKey(K.pub).export({ format: 'der', type: 'spki' })).subarray(-32).toString('hex')]);
}

// ---- (b) a valid payload from the bridge
{
  const h = harness(page);
  assert.deepEqual(h.posted.filter((p) => p.pluginMessage.kind === 'payloadGet').length, 1, 'asks the main thread for its cache before the first connect');
  const ws = connect(h);
  assert.deepEqual(haves(ws), [{ type: 'payload_have', flavour: 'acme', shellProtocol: 1, version: null }]);
  const h2 = harness(page, { autoInstall: false });
  const ws2 = connect(h2);
  const env = sign(K, '1.0.0');
  ws2.deliver({ type: 'payload', envelope: env });
  const inst = h2.installs();
  assert.equal(inst.length, 1);
  assert.equal(inst[0].version, '1.0.0');
  assert.equal(inst[0].code, 'var a = 1;');
  assert.deepEqual(JSON.parse(inst[0].envelope), env, 'the main thread gets the exact envelope to cache');
  assert.ok(h2.has('updating') && h2.title() === 'Loading Grip…', 'purple while it installs');
  h2.fromMain({ kind: 'payloadResult', ok: true, version: '1.0.0' });
  assert.ok(h2.has('connected') && !h2.has('updating'), 'green once it is live');
  assert.equal(h2.title(), 'Connected');
  assert.deepEqual(reports(ws2).at(-1), { type: 'payload_report', status: 'installed', version: '1.0.0' });
  // after installing, the next socket says which version it has
  ws2.drop(1006); h2.advance(5000);
  const ws3 = h2.ws();
  ws3.open(); ws3.deliver({ kind: 'welcome', sessionId: 's1', flavour: 'acme' });
  assert.equal(haves(ws3)[0].version, '1.0.0');
  // payload_current changes nothing
  const n = h2.posted.length;
  ws3.deliver({ type: 'payload_current' });
  assert.equal(h2.posted.length, n);
  // (h) hello: shellProtocol added, everything else forwarded
  h2.fromMain({ kind: 'hello', version: '1.0.0', capabilities: ['x'], fileKey: 'k', fileName: 'f' });
  assert.deepEqual(ws3.sent.at(-1), { kind: 'hello', flavour: 'acme', version: '1.0.0', capabilities: ['x'], fileKey: 'k', fileName: 'f', shellProtocol: 1 });
}

// ---- (c) rejected payloads: nothing runs, the live plugin and the strip stay as they were
{
  const other = newKey();
  const good = sign(K, '1.1.0', 'var a = 1;', 'x = 1;');
  const cases = [
    ['tampered code', 'bad_signature', (e) => { e.code += ' '; }],
    ['tampered ui', 'bad_signature', (e) => { e.ui += ' '; }],
    ['tampered version (newer)', 'bad_signature', (e) => { e.header.version = '9.9.9'; }],
    ['tampered version (older)', 'bad_signature', (e) => { e.header.version = '0.0.1'; }],
    ['truncated code', 'bad_signature', (e) => { e.code = e.code.slice(0, -1); }],
    ['oversize code', 'bad_signature', (e) => { e.code += 'y'.repeat(1_000_000); }],
    ['truncated signature', 'bad_signature', (e) => { e.sig = e.sig.slice(0, 40); }],
    ['empty signature', 'bad_signature', (e) => { e.sig = ''; }],
    ['bad layout', 'bad_format', (e) => { e.layout = 2; }],
    ['missing header field', 'bad_format', (e) => { delete e.header.flavour; }],
    ['not an object', 'bad_format', null],
  ];
  const h = harness(page);
  const ws = connect(h);
  ws.deliver({ type: 'payload', envelope: sign(K, '1.0.0') });
  assert.equal(h.installs().length, 1);
  const base = h.installs().length;
  const expectUnchanged = (label, code, version) => {
    assert.equal(h.installs().length, base, `${label}: nothing is installed`);
    assert.deepEqual(reports(ws).at(-1), { type: 'payload_report', status: 'rejected', version, code }, `${label}: reported`);
    assert.ok(h.has('error'), `${label}: red flash`);
    h.advance(2500);
    assert.ok(h.has('connected') && !h.has('error') && !h.has('updating') && h.title() === 'Connected', `${label}: strip back to green`);
  };
  for (const [label, code, mut] of cases) {
    const env = structuredClone(good);
    if (mut) mut(env);
    ws.deliver({ type: 'payload', envelope: mut ? env : 'junk' });
    expectUnchanged(label, code, code === 'bad_format' ? '' : env.header.version);
  }
  // another key
  ws.deliver({ type: 'payload', envelope: sign(other, '1.1.0') });
  expectUnchanged('other key', 'bad_signature', '1.1.0');
  // another flavour, validly signed by the right key
  ws.deliver({ type: 'payload', envelope: sign(K, '1.1.0', 'c', '', { header: { flavour: 'grip' } }) });
  expectUnchanged('wrong flavour', 'bad_flavour', '1.1.0');
  // older than live: replay
  ws.deliver({ type: 'payload', envelope: sign(K, '0.9.0') });
  expectUnchanged('older version', 'replay', '0.9.0');
  // the same version again: ignored silently
  const rBefore = reports(ws).length;
  ws.deliver({ type: 'payload', envelope: sign(K, '1.0.0') });
  assert.equal(h.installs().length, base);
  assert.equal(reports(ws).length, rBefore, 'an equal version is ignored without a report');
  // and a newer valid one still goes through afterwards
  ws.deliver({ type: 'payload', envelope: good });
  assert.equal(h.installs().length, base + 1);
}

// ---- (d) a payload that needs a newer shell: the live one stays, nothing is verified or run
{
  const h = harness(page);
  const ws = connect(h);
  ws.deliver({ type: 'payload', envelope: sign(K, '1.0.0') });
  let calls = 0;
  h.ctx.gripEdVerify = () => { calls++; return true; };
  const env = sign(K, '1.1.0', 'c', '', { header: { shellProtocol: 2 } });
  ws.deliver({ type: 'payload', envelope: env });
  assert.equal(calls, 0, 'no verification is attempted');
  assert.equal(h.installs().length, 1);
  assert.ok(h.has('warning') && !h.has('connected'), 'yellow');
  assert.equal(h.title(), 'Update the plugin in Figma');
  assert.deepEqual(reports(ws).at(-1), { type: 'payload_report', status: 'rejected', version: '1.1.0', code: 'shell_outdated' });
}

// ---- (e) nothing from an untrusted socket or a stale one
{
  const h = harness(page);
  const ws = h.ws();
  ws.open();                                   // no welcome yet: not trusted
  ws.deliver({ type: 'payload', envelope: sign(K, '1.0.0') });
  assert.equal(h.installs().length, 0, 'not trusted yet');
  ws.deliver({ kind: 'welcome', sessionId: 's0', flavour: 'acme' });
  ws.drop(1006); h.advance(5000);
  const ws2 = h.ws(); assert.notEqual(ws2, ws);
  ws2.open(); ws2.deliver({ kind: 'welcome', sessionId: 's1', flavour: 'acme' });
  ws.deliver({ type: 'payload', envelope: sign(K, '1.0.0') });
  assert.equal(h.installs().length, 0, 'a frame on the old socket is ignored');
  ws2.deliver({ type: 'payload', envelope: sign(K, '1.0.0') });
  assert.equal(h.installs().length, 1);
}

// ---- (f) offline start from the cache
{
  const env = sign(K, '1.0.0');
  const h = harness(page, { cache: JSON.stringify(env) });
  assert.equal(h.installs().length, 1, 'installs from the cache with no socket at all');
  assert.equal(h.installs()[0].version, '1.0.0');
  // a cache that no longer verifies (another key) is dropped once, never loops
  const bad = sign(newKey(), '1.0.0');
  const h2 = harness(page, { cache: JSON.stringify(bad) });
  assert.equal(h2.installs().length, 0);
  assert.equal(h2.drops(), 1);
  assert.equal(h2.store.cache, null);
  // garbage is dropped too
  const h3 = harness(page, { cache: '{not json' });
  assert.equal(h3.drops(), 1);
  // a cache that installs fine but is older than what the bridge then sends does not block the bridge
  const h4 = harness(page, { cache: JSON.stringify(sign(K, '1.0.0')) });
  const ws = connect(h4);
  assert.equal(haves(ws)[0].version, '1.0.0');
  ws.deliver({ type: 'payload', envelope: sign(K, '1.1.0') });
  assert.equal(h4.installs().length, 2);
  // a cached payload whose install throws in the main thread is dropped (no crash loop)
  const h5 = harness(page, { cache: JSON.stringify(sign(K, '1.0.0')), autoInstall: false });
  h5.fromMain({ kind: 'payloadResult', ok: false, version: '1.0.0', error: 'boom' });
  assert.equal(h5.drops(), 1);
}

// ---- a late old cache never drops the newer cache (replay from the cache is silent)
{
  const h = harness(page, { autoInstall: false });
  const ws = connect(h);
  ws.deliver({ type: 'payload', envelope: sign(K, '1.1.0') });
  h.fromMain({ kind: 'payloadResult', ok: true, version: '1.1.0' });
  h.fromMain({ kind: 'payloadCache', envelope: JSON.stringify(sign(K, '1.0.0')) });
  assert.equal(h.drops(), 0, 'an older cache entry is ignored, not dropped');
}

// ---- (i) the optional ui patch, no stacking
{
  const h = harness(page);
  const ws = connect(h);
  ws.deliver({ type: 'payload', envelope: sign(K, '1.0.0', 'c', "shell.define('tooltip', function () { return 'patched'; });") });
  assert.equal(h.title(), 'patched', 'the patch replaced tooltip');
  ws.deliver({ type: 'payload', envelope: sign(K, '1.1.0', 'c', '') });
  assert.equal(h.title(), 'Connected', 'the next payload starts from the pristine page');
  ws.deliver({ type: 'payload', envelope: sign(K, '1.2.0', 'c', 'throw new Error("bad patch");') });
  assert.equal(h.title(), 'Connected', 'a throwing patch leaves the pristine page');
  ws.deliver({ type: 'payload', envelope: sign(K, '1.3.0', 'c', "shell.define('nope', function () {}); shell.define('render', function () { shell.orig.render(); });") });
  assert.ok(h.has('connected'), 'only PATCHABLE names can be replaced');
}

// ---- (j) 300KB payload
{
  const h = harness(page);
  const ws = connect(h);
  let code = '';
  for (let i = 0; code.length < 300_000; i++) code += `function f${i}(a, b) { return (a * ${i}) + b; } // ${'é'.repeat(5)}\n`;
  const env = sign(K, '1.0.0', code);
  const t0 = Date.now();
  ws.deliver({ type: 'payload', envelope: env });
  const ms = Date.now() - t0;
  assert.equal(h.installs().length, 1);
  assert.ok(ms < 1000, `300KB verified in ${ms} ms`);
}

// ---- a second pinned key slot: either key verifies
{
  const K2 = newKey();
  const h = harness(pageFor([K, K2]));
  const ws = connect(h);
  ws.deliver({ type: 'payload', envelope: sign(K2, '1.0.0') });
  assert.equal(h.installs().length, 1, 'a payload signed by the second pinned key is accepted');
}

// ---- (k) the handshake of the page is unchanged
{
  const h = harness(page);
  const ws = h.ws();
  ws.open(); ws.deliver({ kind: 'welcome', sessionId: 's0' });        // a public bridge: no flavour
  assert.ok(h.has('warning'));
  assert.equal(h.title(), 'Wrong Grip build: this plugin is acme, the bridge is grip');
  assert.equal(ws.sent.length, 0, 'nothing is sent to the wrong bridge');
  assert.equal(h.posted.filter((p) => p.pluginMessage.kind === 'welcome').length, 0, 'no hello');
  // pairing: the same proof as the plain page
  const h2 = harness(page);
  h2.store.token = { id: '0123456789abcdef', secret: 's'.repeat(64) };
  h2.fromMain({ kind: 'pairToken', token: h2.store.token });
  const w = h2.ws(); w.open();
  w.deliver({ kind: 'welcome', sessionId: 's0', flavour: 'acme', nonce: 'n'.repeat(32) });
  const auth = w.sent.find((m) => m.type === 'auth');
  assert.ok(auth && auth.flavour === 'acme');
  assert.equal(auth.proof, createHmac('sha256', h2.store.token.secret).update(`grip-auth:acme|plugin|${'n'.repeat(32)}|${auth.nonce}`).digest('hex'));
  assert.equal(haves(w).length, 0, 'no payload_have before the bridge proved itself');
  w.deliver({ type: 'auth_ok', proof: createHmac('sha256', h2.store.token.secret).update(`grip-auth:acme|bridge|${'n'.repeat(32)}|${auth.nonce}`).digest('hex') });
  assert.equal(haves(w).length, 1, 'payload_have after the pairing gate');
}

// ---- a small-order pinned key must not verify a forged signature (R = identity, S = 0)
{
  const realHex = ed25519RawKeys({ releaseKeys: [K.pub] })[0];
  const identity = '01' + '00'.repeat(31);
  assert.throws(() => pageFor([{ pub: `-----BEGIN PUBLIC KEY-----\n${Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(identity, 'hex')]).toString('base64')}\n-----END PUBLIC KEY-----\n` }]), /unusable release key/, 'the build refuses to pin it');
  const forgedPage = page.replace(realHex, identity);          // as if a bad key had been pinned anyway
  assert.ok(forgedPage !== page);
  const h = harness(forgedPage);
  const ws = connect(h);
  const sig = Buffer.concat([Buffer.from('01', 'hex'), Buffer.alloc(63)]).toString('base64');
  ws.deliver({ type: 'payload', envelope: { layout: 1, header: { shellProtocol: 1, flavour: 'acme', version: '1.0.0' }, code: 'evil()', ui: '', sig } });
  assert.equal(h.installs().length, 0, 'the strict verifier refuses a small-order key');
  assert.deepEqual(reports(ws).at(-1), { type: 'payload_report', status: 'rejected', version: '1.0.0', code: 'bad_signature' });
}

// ---- E: ui patch and failure are tracked per version
{
  const h = harness(page, { autoInstall: false });
  const ws = connect(h);
  const patch = (t) => `shell.define('tooltip', function () { return '${t}'; });`;
  ws.deliver({ type: 'payload', envelope: sign(K, '1.0.0', 'c', patch('A')) });
  ws.deliver({ type: 'payload', envelope: sign(K, '1.1.0', 'c', patch('B')) });
  h.fromMain({ kind: 'payloadResult', ok: true, version: '9.9.9' });
  assert.equal(h.title(), 'Loading Grip…', 'a result for a version that was never sent is ignored');
  h.fromMain({ kind: 'payloadResult', ok: true, version: '1.0.0' });
  assert.equal(h.title(), 'A', 'the result for 1.0.0 applies the ui patch of 1.0.0, not the later one');
  h.fromMain({ kind: 'payloadResult', ok: true, version: '1.1.0' });
  assert.equal(h.title(), 'B');
  ws.deliver({ type: 'payload', envelope: sign(K, '1.2.0', 'c', patch('C')) });
  h.fromMain({ kind: 'payloadResult', ok: false, version: '1.2.0', error: 'boom' });
  assert.equal(h.title(), 'B', 'a failed install leaves the live payload and its patch alone');
  assert.ok(!h.has('updating'));
  h.fromMain({ kind: 'payloadResult', ok: true, version: '1.2.0' });
  assert.notEqual(h.title(), 'C', 'a result for a version that already failed is ignored');
}

// ---- F: message SHAPE is validated; the source is deliberately NOT checked (how Figma delivers
// main-thread messages to the iframe is unverified, and a wrong guess would kill the shell for good)
{
  const h = harness(page, { autoInstall: false });
  const ws = connect(h);
  ws.deliver({ type: 'payload', envelope: sign(K, '1.0.0') });
  const n = h.posted.length;
  for (const bad of [null, 5, 'payloadResult', [], {}, { kind: 5 }, { kind: null, ok: true, version: '1.0.0' }]) {
    assert.doesNotThrow(() => h.fromMain(bad));
  }
  assert.doesNotThrow(() => h.fromMain(undefined));
  assert.equal(h.title(), 'Loading Grip…', 'malformed messages change nothing');
  assert.equal(h.posted.length, n);
  // a well-formed message is accepted whatever its source (documented choice)
  h.fromElsewhere({ kind: 'payloadResult', ok: true, version: '1.0.0' });
  assert.equal(h.title(), 'Connected');
}

// ---- stale entries: a superseded install is answered and forgotten; a later failure returns to the live state
{
  const h = harness(page, { autoInstall: false });
  const ws = connect(h);
  ws.deliver({ type: 'payload', envelope: sign(K, '1.0.0') });
  h.fromMain({ kind: 'payloadResult', ok: true, version: '1.0.0' });              // v1 live
  ws.deliver({ type: 'payload', envelope: sign(K, '2.0.0') });                       // v2 held by the main thread
  ws.deliver({ type: 'payload', envelope: sign(K, '3.0.0') });                       // v3 replaces it
  h.fromMain({ kind: 'payloadResult', ok: false, version: '2.0.0', reason: 'superseded' });
  assert.ok(h.has('updating'), 'v3 is still on its way');
  h.fromMain({ kind: 'payloadResult', ok: false, version: '3.0.0', error: 'boom' });
  h.advance(2500);
  assert.ok(h.has('connected') && !h.has('updating'), 'back to the live state, not stuck on installing');
  assert.equal(h.title(), 'Connected');
  const installs = h.installs().length;
  ws.deliver({ type: 'payload', envelope: sign(K, '3.0.0') });                       // the bridge offers v3 again
  assert.equal(h.installs().length, installs + 1, 'a re-offer of v3 is processed, not ignored as already seen');
}

// ---- H: a string with a lone surrogate is refused (it would be signed as U+FFFD but evaluated as written)
{
  const { signingMessage } = await import(join(repo, 'scripts', 'payload.mjs'));
  const { sign: nodeSign } = await import('node:crypto');
  const { createPrivateKey } = await import('node:crypto');
  const header = { shellProtocol: 1, flavour: 'acme', version: '1.0.0' };
  for (const [code, ui] of [['var a = "\ud800";', ''], ['var a;', 'x = "\udc00";']]) {
    const sig = nodeSign(null, signingMessage(header, code, ui), createPrivateKey(K.priv)).toString('base64');
    const h = harness(page);
    const ws = connect(h);
    ws.deliver({ type: 'payload', envelope: { layout: 1, header, code, ui, sig } });
    assert.equal(h.installs().length, 0, 'not installed');
    assert.deepEqual(reports(ws).at(-1), { type: 'payload_report', status: 'rejected', version: '', code: 'bad_format' });
  }
  // a well-formed astral character is fine
  const h = harness(page);
  connect(h).deliver({ type: 'payload', envelope: sign(K, '1.0.0', 'var a = "\u{1F600}";') });
  assert.equal(h.installs().length, 1);
}

// ---- I: the trust anchors are frozen and the verifier is captured before any payload code runs
{
  const h = harness(page);
  vm.runInContext('try { SHELL_RELEASE_KEYS.push("00"); } catch (e) {}', h.ctx);
  assert.equal(vm.runInContext('SHELL_RELEASE_KEYS.length', h.ctx), 1);
  assert.equal(vm.runInContext('Object.isFrozen(SHELL_RELEASE_KEYS)', h.ctx), true);
  h.ctx.gripEdVerify = () => true;                       // a payload ui patch replacing the global verifier ...
  const ws = connect(h);
  const bad = sign(K, '1.0.0'); bad.code += ' ';
  ws.deliver({ type: 'payload', envelope: bad });
  assert.equal(h.installs().length, 0, '... does not make a forged payload pass');
}

// ---- J: nothing over 8MB is parsed or hashed
{
  const h = harness(page);
  const ws = connect(h);
  const huge = 'x'.repeat(8 * 1024 * 1024 + 1);
  let calls = 0;
  const e = sign(K, '1.0.0'); e.code = huge;
  ws.deliver({ type: 'payload', envelope: e });
  assert.equal(h.installs().length, 0);
  assert.deepEqual(reports(ws).at(-1), { type: 'payload_report', status: 'rejected', version: '', code: 'bad_format' });
  const h2 = harness(page, { cache: huge });
  assert.equal(h2.installs().length, 0);
  assert.equal(h2.drops(), 1, 'an oversize cache is dropped');
  void calls;
}

console.log('shell-ui.mjs OK');
