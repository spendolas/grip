// Grip loader shell, main thread (runs as code.js in a `payloadLoader` flavour).
//
// Plain ES2017, no imports, one script. It owns only what must exist before any payload
// does and what must survive a bad payload: pairing-token storage, the payload cache, and
// evaluation / hot swap of the payload. The Figma API handlers live in the payload (the
// full plugin, see scripts/build-shell.mjs), which is verified in the UI iframe
// (src/plugin/shell/loader-ui.js) before it ever reaches this file.
//
// Messages: see "Wire reference" in docs/superpowers/plans/2026-11-23-phase3-loader-shell.md.
// Changing this file needs a manual re-publish of the plugin in Figma.
const SHELL_PROTOCOL = 1;
const PAIR_STORAGE_KEY = 'grip.pairing';
const PAYLOAD_STORAGE_KEY = 'grip.payload';
const TICK_MS = 500;
// A swap waits for the calls in flight, but never longer than this: one call that never settles
// must not block updates forever. A call that outlives the swap keeps running on the old
// payload's closure (and a timed-out bridge request may still complete there); that is the price
// of liveness, and the next release replaces it anyway.
const SWAP_DEFER_MAX_MS = 120000;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

figma.showUI(__html__, { width: 120, height: 32 });

let current = null;       // { version, host, handler }   the live payload
let pending = null;       // { version, code, envelope }   verified, waiting for an idle moment
let inflight = 0;         // messages handed to the live handler that have not settled
let welcomeMsg = null;    // last welcome from the UI, replayed into every new payload
let ticking = false;
let pendingSince = 0;       // when something first started waiting for an idle moment

function post(m) { figma.ui.postMessage(m); }

// The `figma` stand-in a payload gets as `__shell`: the three calls that bind a plugin to the
// iframe and to Figma events go through it, so a replaced payload can be cut off completely.
function makeHost() {
  const host = { dead: false, handler: null, listeners: [], api: null };
  host.api = {
    showUI() {},
    ui: {
      get onmessage() { return host.handler; },
      set onmessage(fn) { if (!host.dead) host.handler = fn; },
    },
    on(ev, cb) { if (host.dead) return; figma.on(ev, cb); host.listeners.push([ev, cb]); },
    once(ev, cb) { if (host.dead) return; figma.once(ev, cb); host.listeners.push([ev, cb]); },
    off(ev, cb) { figma.off(ev, cb); },
  };
  return host;
}

function kill(host) {
  host.dead = true;
  for (const [ev, cb] of host.listeners) { try { figma.off(ev, cb); } catch (e) { /* already gone */ } }
  host.listeners = [];
}

function evaluate(p) {
  const host = makeHost();
  try {
    const fn = new Function('figma', '__shell', '__html__', p.code + '\n//# sourceURL=payload-v' + p.version + '.js');
    fn(figma, host.api, '');
    if (typeof host.handler !== 'function') throw new Error('the payload did not register a message handler');
  } catch (e) {
    kill(host);
    return { ok: false, error: String((e && e.message) || e).slice(0, 300) };
  }
  return { ok: true, host };
}

// Counts the calls in flight: a swap waits for zero, so it never lands in the middle of a write.
function wrap(host) {
  const raw = host.handler;
  return async (m) => {
    inflight++;
    try { return await raw(m); } finally { inflight--; tryApply(); }
  };
}

function schedule() {
  if (ticking) return;
  ticking = true;
  setTimeout(() => { ticking = false; tryApply(); }, TICK_MS);
}

function tryApply() {
  if (!pending) return;
  if (inflight > 0) {
    if (pendingSince === 0) pendingSince = Date.now();
    if (Date.now() - pendingSince < SWAP_DEFER_MAX_MS) { schedule(); return; }
  }
  const p = pending;
  pending = null;
  pendingSince = 0;
  const r = evaluate(p);
  if (!r.ok) { post({ kind: 'payloadResult', ok: false, version: p.version, error: r.error }); return; }
  const old = current;
  current = { version: p.version, host: r.host, handler: wrap(r.host) };
  if (old) kill(old.host);
  // The cache is written only for a payload that installed.
  Promise.resolve().then(() => figma.clientStorage.setAsync(PAYLOAD_STORAGE_KEY, p.envelope)).catch(() => {});
  post({ kind: 'payloadResult', ok: true, version: p.version });
  if (welcomeMsg) current.handler(welcomeMsg);
}

figma.ui.onmessage = async (msg) => {
  if (!msg || typeof msg !== 'object') return;
  const kind = msg.kind;
  // Pairing token (bridge pairing.ts): the UI keeps no storage, the secret lives in clientStorage.
  if (kind === 'pairGet') {
    let token = null;
    try { token = (await figma.clientStorage.getAsync(PAIR_STORAGE_KEY)) || null; } catch (e) { token = null; }
    post({ kind: 'pairToken', token });
    return;
  }
  if (kind === 'pairSet') {
    const t = msg.token;
    if (t && typeof t.id === 'string' && typeof t.secret === 'string') {
      try { await figma.clientStorage.setAsync(PAIR_STORAGE_KEY, { id: t.id, secret: t.secret }); } catch (e) { /* retried on the next connect */ }
    }
    return;
  }
  if (kind === 'pairClear') {
    try { await figma.clientStorage.deleteAsync(PAIR_STORAGE_KEY); } catch (e) { /* none */ }
    return;
  }
  if (kind === 'payloadGet') {
    let envelope = null;
    try { const v = await figma.clientStorage.getAsync(PAYLOAD_STORAGE_KEY); envelope = typeof v === 'string' ? v : null; } catch (e) { envelope = null; }
    post({ kind: 'payloadCache', envelope });
    return;
  }
  if (kind === 'payloadDrop') {
    try { await figma.clientStorage.deleteAsync(PAYLOAD_STORAGE_KEY); } catch (e) { /* none */ }
    return;
  }
  if (kind === 'payloadInstall') {
    if (typeof msg.version !== 'string' || !VERSION_RE.test(msg.version) || typeof msg.code !== 'string' || msg.code === '' || typeof msg.envelope !== 'string') return;
    pending = { version: msg.version, code: msg.code, envelope: msg.envelope };
    if (inflight > 0) post({ kind: 'payloadPending', version: msg.version });
    tryApply();
    return;
  }
  if (kind === 'welcome') {
    welcomeMsg = msg;
    if (current) return current.handler(msg);
    return;
  }
  if (kind === 'openSetup' && !current) {
    figma.openExternal('__PAGES_URL__');
    return;
  }
  if (current) return current.handler(msg);
  if (kind === 'request') post({ kind: 'response', id: msg.id, error: 'plugin_loading: the plugin code has not been delivered by the bridge yet; retry in a moment' });
};
