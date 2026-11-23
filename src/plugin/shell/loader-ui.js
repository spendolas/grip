// Loader block of the shell page. Injected into the SAME <script> as the (unedited) status
// strip template, just before its first render(), so it can read and hook its globals
// (trusted, ws, current, pairIssue, el, send, toCode, flashError, render, tooltip, sayHello).
// Handshake, pairing and WebSocket logic stay in the template: a change to THAT needs a
// manual re-publish; everything else ships as payload or as a signed `ui` patch.
// Names here are prefixed shell/SHELL to stay clear of the template's.
const SHELL_PROTOCOL = 1;
const SHELL_RELEASE_KEYS = Object.freeze(JSON.parse('__RELEASE_KEYS__'));   // raw Ed25519 public keys, hex (frozen trust anchor)
const shellVerify = gripEdVerify;      // captured before any payload code or ui patch can run
const SHELL_MAX_BYTES = 8 * 1024 * 1024;   // nothing bigger is parsed, hashed or cached (the bridge serves at most 8MB)
let shellPhase = 'idle';          // idle | installing | ready | outdated
let shellInstalled = null;        // version of the payload that is live
let shellNewest = null;           // highest version accepted so far (live or on its way)
const shellPending = {};          // version -> { ui, source } of every payload sent to the main thread and not yet answered

// ---- hooks (by reassignment; the template is never edited) --------------------------------
// Functions a payload ui patch may replace. The globals are dispatchers into shellBase, so the
// patch is swapped without stacking: every install starts from the pristine functions again.
const shellPristine = { render, tooltip, bridgeOutdated, bridgeHearsUpdates, onUpdateNotice, onUpdateResult, startUpdate, shortReason };
let shellBase = Object.assign({}, shellPristine);
render = function () { shellBase.render.apply(this, arguments); shellApplyClasses(); };
tooltip = function () { const t = shellTooltip(); return t !== null ? t : shellBase.tooltip.apply(this, arguments); };
bridgeOutdated = function () { return shellBase.bridgeOutdated.apply(this, arguments); };
bridgeHearsUpdates = function () { return shellBase.bridgeHearsUpdates.apply(this, arguments); };
onUpdateNotice = function () { return shellBase.onUpdateNotice.apply(this, arguments); };
onUpdateResult = function () { return shellBase.onUpdateResult.apply(this, arguments); };
startUpdate = function () { return shellBase.startUpdate.apply(this, arguments); };
shortReason = function () { return shellBase.shortReason.apply(this, arguments); };

function shellLoading() { return current === 'connected' && !pairIssue && (shellPhase === 'installing' || (trusted && !shellInstalled)); }
function shellApplyClasses() {
  if (pairIssue) return;
  if (shellPhase === 'outdated') {
    el.classList.remove('connected', 'update', 'updating', 'pulsing', 'clickable', 'actionable');
    el.classList.add('warning');
  } else if (shellLoading()) {
    el.classList.remove('pulsing', 'clickable', 'actionable');
    el.classList.add('updating');
  }
}
function shellTooltip() {
  if (pairIssue) return null;
  if (shellPhase === 'outdated') return 'Update the plugin in Figma';
  if (shellLoading()) return 'Loading Grip…';
  return null;
}

// ---- messages ---------------------------------------------------------------------------------
const shellPrevSayHello = sayHello;
sayHello = function () {
  shellPrevSayHello();
  send({ type: 'payload_have', flavour: FLAVOUR, shellProtocol: SHELL_PROTOCOL, version: shellInstalled });
};
function shellReport(status, version, code, message) {
  if (!trusted) return;
  const m = { type: 'payload_report', status, version: version || '' };
  if (code) m.code = code;
  if (message) m.message = String(message).slice(0, 200);
  send(m);
}

const shellPrevOnMessage = window.onmessage;
window.onmessage = function (ev) {
  if (ev && ev.source !== parent) return;      // only the plugin main thread talks to this page
  const m = ev && ev.data && ev.data.pluginMessage;
  if (m && typeof m === 'object') {
    if (m.kind === 'payloadCache') { shellOnCache(m.envelope); return; }
    if (m.kind === 'payloadPending') { render(); return; }
    if (m.kind === 'payloadResult') { shellOnResult(m); return; }
    if (m.kind === 'hello') m.shellProtocol = SHELL_PROTOCOL;   // lets the bridge tell a shell window
  }
  return shellPrevOnMessage.apply(this, arguments);
};

// Frames from the bridge. A subclass, so the template's own onopen/onmessage/onclose stay as they are.
const ShellRealWebSocket = WebSocket;
WebSocket = class extends ShellRealWebSocket {
  constructor(u) {
    super(u);
    this.addEventListener('message', (ev) => {
      if (!trusted || ws !== this) return;       // nothing from a socket that has not proven itself
      if (typeof ev.data !== 'string') return;
      let msg;
      if (ev.data.length > SHELL_MAX_BYTES) { shellReject('bad_format', '', 'bridge'); return; }
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg && msg.type === 'payload') shellAccept(msg.envelope, 'bridge');
    });
  }
};

// ---- verification -----------------------------------------------------------------------------
function shellCmp(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}
function shellHex(h) { const o = new Uint8Array(h.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16); return o; }
// The signed bytes: same construction as signingMessage() in scripts/payload.mjs.
function shellMessage(h, code, ui) {
  const enc = new TextEncoder();
  const c = enc.encode(code), u = enc.encode(ui);
  const head = enc.encode('grip-payload|1|' + h.shellProtocol + '|' + h.flavour + '|' + h.version + '|' + c.length + '|' + u.length + '\n');
  const out = new Uint8Array(head.length + c.length + u.length);
  out.set(head, 0); out.set(c, head.length); out.set(u, head.length + c.length);
  return out;
}
// A lone surrogate is signed as U+FFFD but would be evaluated as written: refuse such strings.
function shellWellFormed(str) { return !/[\ud800-\udbff](?![\udc00-\udfff])|(?:^|[^\ud800-\udbff])[\udc00-\udfff]/.test(str); }
function shellReject(code, version, source) {
  if (source === 'cache' && code !== 'replay') toCode({ kind: 'payloadDrop' });
  if (source === 'bridge') flashError(false);
  if (!(source === 'cache' && code === 'replay')) shellReport('rejected', version, code);
}

function shellAccept(env, source) {
  let h;
  if (!env || typeof env !== 'object' || env.layout !== 1 || typeof env.code !== 'string' || typeof env.ui !== 'string' || typeof env.sig !== 'string'
    || !(h = env.header) || typeof h !== 'object' || !Number.isInteger(h.shellProtocol) || h.shellProtocol < 1
    || typeof h.flavour !== 'string' || typeof h.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(h.version)
    || env.code.length > SHELL_MAX_BYTES || env.ui.length > SHELL_MAX_BYTES || !shellWellFormed(env.code) || !shellWellFormed(env.ui)) {
    shellReject('bad_format', '', source); return;
  }
  // A payload that needs a newer shell cannot be trusted to follow this layout, so this is judged
  // from the unsigned header and never runs anything: the plugin that is live stays live.
  if (h.shellProtocol > SHELL_PROTOCOL) {
    shellPhase = 'outdated'; render();
    shellReport('rejected', h.version, 'shell_outdated');
    return;
  }
  if (h.flavour !== FLAVOUR) { shellReject('bad_flavour', h.version, source); return; }
  if (!/^[A-Za-z0-9+/]{86}==$/.test(env.sig)) { shellReject('bad_signature', h.version, source); return; }
  const sig = Uint8Array.from(atob(env.sig), (c) => c.charCodeAt(0));
  const msg = shellMessage(h, env.code, env.ui);
  if (!SHELL_RELEASE_KEYS.some((k) => shellVerify(sig, msg, shellHex(k)))) { shellReject('bad_signature', h.version, source); return; }
  if (shellNewest !== null) {
    const c = shellCmp(h.version, shellNewest);
    if (c === 0) return;                                    // the same payload again: nothing to do
    if (c < 0) { shellReject('replay', h.version, source); return; }
  }
  shellNewest = h.version; shellPending[h.version] = { ui: env.ui, source };
  shellPhase = 'installing'; render();
  toCode({ kind: 'payloadInstall', version: h.version, code: env.code, envelope: JSON.stringify(env) });
}

function shellOnCache(text) {
  if (typeof text !== 'string') return;
  if (text.length > SHELL_MAX_BYTES) { toCode({ kind: 'payloadDrop' }); return; }
  let env; try { env = JSON.parse(text); } catch (e) { toCode({ kind: 'payloadDrop' }); return; }
  shellAccept(env, 'cache');
}

function shellOnResult(m) {
  const rec = typeof m.version === 'string' ? shellPending[m.version] : undefined;
  if (!rec) return;                                          // not a payload this page sent (or already answered)
  delete shellPending[m.version];
  if (m.ok === true) {
    shellInstalled = m.version; shellPhase = 'ready';
    shellBase = Object.assign({}, shellPristine);            // every payload starts from the pristine page
    if (rec.ui.trim() !== '') {
      try {
        new Function('shell', rec.ui)({ orig: shellPristine, define: (name, fn) => { if (name in shellPristine && typeof fn === 'function') shellBase[name] = fn; } });
      } catch (e) { shellBase = Object.assign({}, shellPristine); }
    }
    shellReport('installed', m.version);
  } else {
    // The live payload (and its ui patch) are untouched: a failed install never applies a patch.
    const open = Object.keys(shellPending);
    shellNewest = open.concat(shellInstalled ? [shellInstalled] : []).sort(shellCmp).pop() || null;
    if (open.length === 0) shellPhase = shellInstalled ? 'ready' : 'idle';
    if (rec.source === 'cache') toCode({ kind: 'payloadDrop' }); else flashError(false);
    shellReport('rejected', m.version, 'install_failed', m.error);
  }
  render();
}

toCode({ kind: 'payloadGet' });

