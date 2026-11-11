// Plugin status-strip tests (figma-plugin/ui.html). No jsdom: the page's own
// <script> runs in a node:vm context against a tiny fake DOM / WebSocket /
// timer, so the real state machine is exercised (colour classes, tooltips, the
// single click, the failure flash, the post-update reconnect). What this cannot
// show: how the colours LOOK and whether Figma renders `title` tooltips in its
// plugin iframe: that needs a live Figma check (see the report / README).
import assert from 'node:assert';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(HERE, '..', '..', '..', 'figma-plugin', 'ui.html'), 'utf8');

// ------------------------------------------------------------ static shape
assert.ok(!/click to confirm/i.test(html), 'the two-click confirm is gone');
assert.ok(!html.includes('↑ update') && !/↑\s*update/.test(html), 'no "↑ update" label');
assert.ok(!/id="upd"/.test(html), 'no pill element: the strip is the only element');
assert.ok(!/textContent\s*=/.test(html) && !/innerText/.test(html) && !/innerHTML/.test(html), 'no text is ever rendered into the strip (colour + tooltip only)');
assert.strictEqual((html.match(/<div\b/g) || []).length, 1, 'exactly one element in the body');
for (const cls of ['#state.update', '#state.updating', '@keyframes grip-update-pulse', '@keyframes grip-updating-pulse']) {
  assert.ok(html.includes(cls), `CSS has ${cls}`);
}
const colour = (name) => {
  const m = new RegExp(`--${name}:\\s*#([0-9a-fA-F]{6})`).exec(html);
  assert.ok(m, `--${name} defined`);
  return m[1].toLowerCase();
};
const states = ['disconnected', 'connected', 'warning', 'error', 'update'].map((n) => [n, colour('c-' + n)]);
assert.strictEqual(colour('c-update'), 'a855f7', 'purple');
assert.strictEqual(new Set(states.map(([, c]) => c)).size, states.length, 'every state has its own colour');
const rgb = (h) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
const dist = (a, b) => Math.hypot(...rgb(a).map((v, i) => v - rgb(b)[i]));
for (const [n, c] of states.filter(([n]) => n !== 'update')) assert.ok(dist(c, 'a855f7') > 100, `purple is clearly distinct from ${n} (${dist(c, 'a855f7').toFixed(0)})`);
assert.ok(/used by no other state/i.test(html), 'the colour choice is documented in the CSS');
assert.ok(html.indexOf('#state.connected {') < html.indexOf('#state.update {') && html.indexOf('#state.update {') < html.indexOf('#state.updating {'), 'purple rules come after the green one, so they win');
assert.ok(html.includes("type: 'update_request', version: updLatest"), 'the click sends the version that is shown');
assert.ok(html.includes('...rest'), 'the FULL hello is forwarded (minBridge and any future field)');

// ------------------------------------------------------------ harness
const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];

function harness() {
  let now = 0, seq = 0;
  const timers = new Map();
  const classes = new Set();
  const listeners = {};
  const strip = {
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (c) => classes.has(c),
    },
    title: '',
    addEventListener: (t, f) => { (listeners[t] ??= []).push(f); },
  };
  const requested = [];
  const instances = [];
  class FakeWS {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; instances.push(this); }
    send(d) { this.sent.push(JSON.parse(d)); }
    open() { this.readyState = 1; this.onopen?.(); }
    // a real bridge always welcomes first; this is the plain, pairing-less welcome
    openWelcomed() { this.open(); this.deliver({ kind: 'welcome', sessionId: 's0' }); }
    deliver(o) { this.onmessage?.({ data: JSON.stringify(o) }); }
    close(code = 1000, reason = '') { this.drop(code, reason); }
    drop(code = 1006, reason = '') { this.readyState = 3; this.onclose?.({ code, reason }); }
  }
  const posted = [];
  const win = {};
  // What the plugin main thread keeps in clientStorage (grip.pairing). Replies are synchronous.
  const store = { token: null };
  const mainThread = (m) => {
    if (m.kind === 'pairGet') win.onmessage({ data: { pluginMessage: { kind: 'pairToken', token: store.token } } });
    else if (m.kind === 'pairSet') store.token = m.token;
    else if (m.kind === 'pairClear') store.token = null;
  };
  const ctx = vm.createContext({
    document: { getElementById: (id) => { requested.push(id); return strip; } },
    WebSocket: FakeWS,
    parent: { postMessage: (m) => { const c = JSON.parse(JSON.stringify(m)); posted.push(c); mainThread(c.pluginMessage); } },   // plain host-realm copy
    window: win,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: now + (ms || 0) }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    JSON,
    TextEncoder,
    crypto: webcrypto,
  });
  vm.runInContext(script, ctx);
  const h = {
    classes: () => [...classes].sort(),
    has: (c) => classes.has(c),
    title: () => strip.title,
    click: () => (listeners.click ?? []).forEach((f) => f()),
    ws: () => instances.at(-1),
    store,
    instances,
    posted,
    ctx,
    requested,
    // fromMain: what the plugin main thread posts to the iframe
    fromMain: (pluginMessage) => win.onmessage({ data: { pluginMessage } }),
    advance: (ms) => {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
    pendingTimers: () => [...timers.values()].map((t) => t.at - now),
  };
  return h;
}

const purple = (h) => h.has('update') || h.has('updating');
const CONNECTED_TITLE = 'Connected';

// ------------------------------------------------------------ states
{
  const h = harness();
  assert.deepStrictEqual([...new Set(h.requested)], ['state'], 'the script only ever touches #state');

  // disconnected: grey, setup tooltip, clickable
  assert.ok(!h.has('connected') && !purple(h), 'starts grey');
  assert.strictEqual(h.title(), 'Bridge not running. Click for setup');
  assert.ok(h.has('actionable'));
  h.click();
  assert.deepStrictEqual(h.posted.at(-1), { pluginMessage: { kind: 'openSetup' } }, 'a grey click still opens the setup pointer');

  // connected: green; the tooltip names the plugin version once its hello is known
  const ws = h.ws();
  ws.openWelcomed();
  assert.ok(h.has('connected') && !purple(h) && !h.has('actionable'));
  assert.strictEqual(h.title(), 'Connected');
  ws.deliver({ kind: 'welcome', sessionId: 's1', bridgeVersion: '0.8.0' });
  assert.deepStrictEqual(h.posted.at(-1), { pluginMessage: { kind: 'welcome', sessionId: 's1' } });
  h.fromMain({ kind: 'hello', version: '0.8.0', minBridge: '0.7.0', capabilities: ['x'], fileKey: 'k', fileName: 'f', currentPageId: '0:1', currentPageName: 'P' });
  assert.deepStrictEqual(ws.sent.at(-1), { kind: 'hello', version: '0.8.0', minBridge: '0.7.0', capabilities: ['x'], fileKey: 'k', fileName: 'f', currentPageId: '0:1', currentPageName: 'P' }, 'full hello forwarded, minBridge included');
  assert.strictEqual(h.title(), CONNECTED_TITLE);
  // the per-file UID (additive field) is forwarded too
  h.fromMain({ kind: 'hello', version: '0.8.0', capabilities: ['fileUid'], fileKey: '0:0', fileUid: 'u-1', fileName: 'f', currentPageId: '0:1', currentPageName: 'P' });
  assert.deepStrictEqual(ws.sent.at(-1), { kind: 'hello', version: '0.8.0', capabilities: ['fileUid'], fileKey: '0:0', fileUid: 'u-1', fileName: 'f', currentPageId: '0:1', currentPageName: 'P' }, 'fileUid forwarded');

  // request frames reach the plugin whole: the bridge's timeoutMs (and any later
  // additive field) is not dropped by the relay
  ws.deliver({ id: 'r1', method: 'set_node_property', params: { nodeId: '1:1' }, timeoutMs: 600, extra: 1 });
  assert.deepStrictEqual(h.posted.at(-1), { pluginMessage: { id: 'r1', method: 'set_node_property', params: { nodeId: '1:1' }, timeoutMs: 600, extra: 1, kind: 'request' } });
  ws.deliver({ id: 'r2', method: 'get_node' });
  assert.deepStrictEqual(h.posted.at(-1), { pluginMessage: { id: 'r2', method: 'get_node', params: {}, kind: 'request' } }, 'params default to {}');

  // busy pulse (existing behaviour) while connected and nothing on offer
  h.fromMain({ kind: 'busy', busy: true });
  assert.ok(h.has('pulsing') && h.has('connected'));
  h.fromMain({ kind: 'busy', busy: false });
  assert.ok(!h.has('pulsing'));
  // calls queued in the plugin each send busy:true up front and busy:false when done:
  // the pulse lasts until the LAST one ends, and a stray extra false never goes negative
  for (let i = 0; i < 3; i++) h.fromMain({ kind: 'busy', busy: true });
  h.fromMain({ kind: 'busy', busy: false });
  h.fromMain({ kind: 'busy', busy: false });
  assert.ok(h.has('pulsing'), 'still pulsing while one queued call remains');
  h.fromMain({ kind: 'busy', busy: false });
  assert.ok(!h.has('pulsing'));
  h.fromMain({ kind: 'busy', busy: false });
  h.fromMain({ kind: 'busy', busy: true });
  assert.ok(h.has('pulsing'), 'an extra busy:false did not push the count below zero');
  h.fromMain({ kind: 'busy', busy: false });
  assert.ok(!h.has('pulsing'));

  // unknown frames from a newer bridge are ignored
  assert.doesNotThrow(() => ws.deliver({ type: 'future_frame', x: 1 }));
  assert.ok(h.has('connected'));

  // a compatible update is on offer: purple + pulse (class), tooltip with versions and the headline, no other change
  ws.deliver({ type: 'update', available: true, latest: '0.9.0', current: '0.8.0', headline: 'Faster, with fewer bugs.' });
  assert.ok(h.has('update') && h.has('clickable'), `purple: ${h.classes()}`);   // (.connected stays on; the later #state.update rule wins, asserted statically above)
  assert.ok(!h.has('updating') && !h.has('pulsing'));
  assert.strictEqual(h.title(), 'Update available. Click to install', 'very short: no versions, no headline');
  ws.deliver({ type: 'update', available: true, latest: '0.9.0', current: '0.8.0', headline: null });
  assert.strictEqual(h.title(), 'Update available. Click to install');

  // ONE click installs the version that is shown
  h.click();
  assert.deepStrictEqual(ws.sent.at(-1), { type: 'update_request', version: '0.9.0' });
  assert.ok(h.has('updating') && !h.has('update') && !h.has('clickable'), `installing: purple, faster pulse: ${h.classes()}`);
  assert.strictEqual(h.title(), 'Updating…');
  const sentBefore = ws.sent.length;
  h.click();
  assert.strictEqual(ws.sent.length, sentBefore, 'clicking while updating does nothing');
  // the bridge answers "updated, restart scheduled": still updating
  ws.deliver({ type: 'update_result', status: 'updated', from: '0.8.0', to: '0.9.0', restart: 'scheduled' });
  assert.ok(h.has('updating'));
  // frames during the install are ignored (they describe the old bridge)
  ws.deliver({ type: 'update', available: false, latest: '0.9.0' });
  assert.ok(h.has('updating'));

  // the bridge restarts: grey, then a QUICK reconnect, then green
  ws.drop(1006);
  assert.ok(!purple(h) && !h.has('connected'), `grey while the bridge restarts: ${h.classes()}`);
  assert.strictEqual(h.title(), 'Restarting…', 'the grey strip says why');
  assert.ok(!h.has('actionable'), 'no setup click while restarting');
  const n = h.instances.length;
  h.ws().onerror?.();
  assert.ok(!h.has('error') && !h.has('connected'), 'failed reconnects during the restart stay grey, no red flicker');
  assert.ok(Math.min(...h.pendingTimers()) <= 300, `reconnect is scheduled fast: ${h.pendingTimers()}`);
  h.advance(300);
  assert.strictEqual(h.instances.length, n + 1, 'reconnected within 300ms');
  h.ws().openWelcomed();
  assert.ok(h.has('connected') && !purple(h), 'back to green on the new bridge (nothing pending)');
  assert.strictEqual(h.title(), CONNECTED_TITLE);
}

// ------------------------------------------------------------ failure: brief red flash, then purple with a retry tooltip
{
  const h = harness();
  const ws = h.ws();
  ws.openWelcomed();
  h.fromMain({ kind: 'hello', version: '0.8.0' });
  ws.deliver({ type: 'update', available: true, latest: '0.9.0', current: '0.8.0', headline: '' });
  h.click();
  ws.deliver({ type: 'update_result', status: 'error', code: 'install_failed', message: 'grip-bridge.mjs failed its sha256 check.  Nothing was changed.' });
  assert.ok(h.has('error') && !purple(h), `red flash: ${h.classes()}`);
  assert.ok(!h.has('actionable'), 'the flash is not a "no bridge" state: a click does not open the setup page');
  h.advance(1999);
  assert.ok(h.has('error'));
  h.advance(2);
  assert.ok(h.has('update') && h.has('clickable') && !h.has('error'), `back to purple: ${h.classes()}`);
  assert.strictEqual(h.title(), 'Update failed. Click to retry');
  // a retry sends the request again
  h.click();
  assert.deepStrictEqual(ws.sent.at(-1), { type: 'update_request', version: '0.9.0' });
  assert.ok(h.has('updating'));

  // long reasons are shortened for the tooltip
  ws.deliver({ type: 'update_result', status: 'error', code: 'incompatible_plugin', message: 'x'.repeat(500) });
  h.advance(2001);
  assert.ok(h.title().length < 260, 'tooltip stays short');

  // the bridge then withdraws the offer (e.g. incompatible plugin): no purple at all
  ws.deliver({ type: 'update', available: false, latest: '0.9.0', current: '0.8.0' });
  assert.ok(h.has('connected') && !purple(h));
  assert.strictEqual(h.title(), CONNECTED_TITLE);

  // version_changed: not a failure; the refreshed frame re-arms the strip for the NEW version
  ws.deliver({ type: 'update', available: true, latest: '0.9.0', current: '0.8.0' });
  h.click();
  ws.deliver({ type: 'update_result', status: 'error', code: 'version_changed', latest: '0.9.1', message: 'newer' });
  assert.ok(!h.has('error'), 'no red flash for version_changed');
  assert.ok(h.has('update'), 'still purple');
  ws.deliver({ type: 'update', available: true, latest: '0.9.1', current: '0.8.0', headline: 'Newer.' });
  assert.strictEqual(h.title(), 'Update available. Click to install');
  h.click();
  assert.deepStrictEqual(ws.sent.at(-1), { type: 'update_request', version: '0.9.1' }, 'the next click names the version now shown');

  // no answer at all within a minute: do not sit on "Updating..." forever
  h.advance(61000);
  assert.ok(h.has('update') && h.title() === 'Update failed. Click to retry', h.title());
}

// ------------------------------------------------------------ developer install: never purple, tooltip says why
{
  const h = harness();
  const ws = h.ws();
  ws.openWelcomed();
  h.fromMain({ kind: 'hello', version: '0.8.0' });
  ws.deliver({ type: 'update', available: true, latest: '0.9.0', current: '0.8.0' });
  h.click();
  ws.deliver({ type: 'update_result', status: 'clone_install', from: '0.8.0', to: '0.9.0', next: ['git pull', 'npm run build', 'node bridge/install.mjs'] });
  assert.ok(h.has('connected') && !purple(h), 'the indicator stops being purple for a developer install');
  assert.match(h.title(), /developer install/);
  // a repeated frame for the same version does not bring the purple back
  ws.deliver({ type: 'update', available: true, latest: '0.9.0', current: '0.8.0' });
  assert.ok(!purple(h), 'still not purple');
  // a DIFFERENT version is a new offer (still a clone: the bridge will answer clone_install again)
  ws.deliver({ type: 'update', available: true, latest: '0.9.2', current: '0.8.0' });
  assert.ok(h.has('update'));
}

// ------------------------------------------------------------ purple only while connected
{
  const h = harness();
  const ws = h.ws();
  ws.openWelcomed();
  ws.deliver({ type: 'update', available: true, latest: '0.9.0', current: '0.8.0' });
  assert.ok(h.has('update'));
  ws.drop(1006);
  assert.ok(!purple(h) && !h.has('connected'), 'a disconnected strip stays grey');
  assert.ok(h.has('actionable'));
  assert.strictEqual(h.title(), 'Bridge not running. Click for setup');
  h.advance(2000);
  const ws2 = h.ws();
  ws2.openWelcomed();
  assert.ok(h.has('connected') && !purple(h), 'a fresh connection starts without an offer until the bridge announces one');
  ws2.deliver({ type: 'update', available: true, latest: '0.9.0', current: '0.8.0' });
  assert.ok(h.has('update'), 'the bridge re-announces on hello');
  // the existing warning state (duplicate plugin window) is not purple either
  ws2.drop(1000, 'duplicate');
  assert.ok(h.has('warning') && !purple(h));
}

// ------------------------------------------------------------ the PLUGIN wants a newer bridge than the one it talks to
{
  const hello = (h, minBridge) => h.fromMain({ kind: 'hello', version: '0.8.0', minBridge, capabilities: [], fileKey: 'k', fileName: 'f', currentPageId: '0:1', currentPageName: 'P' });
  // old bridge (no self-update): purple, a click opens the install page (the plugin cannot install a bridge itself)
  {
    const h = harness();
    const ws = h.ws();
    ws.openWelcomed();
    ws.deliver({ kind: 'welcome', sessionId: 's1', bridgeVersion: '0.7.0' });
    hello(h, '0.8.0');
    assert.ok(h.has('update') && h.has('actionable') && h.has('connected'), `purple: ${h.classes()}`);
    assert.strictEqual(h.title(), 'Bridge update needed. Click for steps');
    h.click();
    assert.deepStrictEqual(h.posted.at(-1), { pluginMessage: { kind: 'openSetup' } }, 'opens the install page, not an in-place update');
    assert.ok(!ws.sent.some((m) => m.type === 'update_request'), 'no in-place update request');
  }
  // bridge new enough: plain green
  {
    const h = harness();
    const ws = h.ws();
    ws.openWelcomed();
    ws.deliver({ kind: 'welcome', sessionId: 's1', bridgeVersion: '0.8.0' });
    hello(h, '0.8.0');
    assert.ok(h.has('connected') && !purple(h));
  }
  // an old bridge that cannot say its version: never nag on a guess
  {
    const h = harness();
    const ws = h.ws();
    ws.openWelcomed();
    ws.deliver({ kind: 'welcome', sessionId: 's1' });
    hello(h, '0.8.0');
    assert.ok(h.has('connected') && !purple(h));
  }
  // when the bridge itself offers an in-place update, that path wins (one click installs)
  {
    const h = harness();
    const ws = h.ws();
    ws.openWelcomed();
    ws.deliver({ kind: 'welcome', sessionId: 's1', bridgeVersion: '0.8.0' });
    hello(h, '0.9.0');
    assert.ok(purple(h) && h.has('clickable') && !h.has('actionable'), 'a bridge that can update itself: the click is an update request, not the page');
    ws.deliver({ type: 'update', available: true, latest: '0.9.0', current: '0.8.0' });
    assert.ok(h.has('clickable') && !h.has('actionable'));
    assert.strictEqual(h.title(), 'Update available. Click to install');
    h.click();
    assert.deepStrictEqual(ws.sent.at(-1), { type: 'update_request', version: '0.9.0' });
  }
}

// ------------------------------------------------------------ the click always asks a bridge that can hear it; only older bridges get the page
{
  const hello = (h, minBridge) => h.fromMain({ kind: 'hello', version: '0.9.0', minBridge, capabilities: [], fileKey: 'k', fileName: 'f', currentPageId: '0:1', currentPageName: 'P' });
  const setup = (bridgeVersion, minBridge = '0.9.0') => {
    const h = harness(); const ws = h.ws(); ws.openWelcomed();
    ws.deliver({ kind: 'welcome', sessionId: 's1', bridgeVersion });
    hello(h, minBridge);
    return { h, ws };
  };
  // 0.8.0 bridge, plugin wants 0.9.0, nothing offered: purple, "click to update", the click sends the request
  {
    const { h, ws } = setup('0.8.0');
    assert.ok(h.has('update') && h.has('clickable') && !h.has('actionable'));
    assert.strictEqual(h.title(), 'Bridge update needed. Click to update');
    h.click();
    assert.deepStrictEqual(ws.sent.at(-1), { type: 'update_request', version: 'latest' });
    assert.ok(!h.posted.some((m) => m.pluginMessage?.kind === 'openSetup'), 'the install page is not opened');
    assert.ok(h.has('updating') && h.title() === 'Updating…');
    ws.deliver({ type: 'update_result', status: 'updated', restart: 'scheduled', to: '0.9.0' });
    assert.ok(h.has('updating'), 'waits for the restart');
  }
  // nothing newer published yet: a short failure, then it can be clicked again
  {
    const { h, ws } = setup('0.8.0');
    h.click();
    ws.deliver({ type: 'update_result', status: 'error', code: 'no_update_available', message: 'no newer bridge is published yet' });
    assert.ok(h.has('connected') || h.has('error'));
    h.advance(3000);
    assert.ok(h.has('update') && h.has('clickable'), `back to purple: ${h.classes()}`);
    assert.match(h.title(), /Update failed/);
    h.click();
    assert.deepStrictEqual(ws.sent.at(-1), { type: 'update_request', version: 'latest' }, 'retry asks again');
  }
  // developer install answers clone_install: no longer purple-clickable, says so
  {
    const { h, ws } = setup('0.8.0');
    h.click();
    ws.deliver({ type: 'update_result', status: 'clone_install', to: '0.9.0' });
    assert.strictEqual(h.title(), 'Update available (developer install)');
    assert.ok(!h.has('clickable'));
  }
  // a bridge that cannot hear (older than 0.8.0): the page, never a request
  {
    const { h, ws } = setup('0.7.0', '0.8.0');
    assert.ok(h.has('actionable') && !h.has('clickable'));
    h.click();
    assert.deepStrictEqual(h.posted.at(-1), { pluginMessage: { kind: 'openSetup' } });
    assert.ok(!ws.sent.some((m) => m.type === 'update_request'));
  }
  // nothing wrong: green, a click does nothing
  {
    const { h, ws } = setup('0.9.0');
    assert.ok(h.has('connected') && !purple(h));
    h.click();
    assert.ok(!ws.sent.some((m) => m.type === 'update_request'));
  }
}

// ------------------------------------------------------------ pairing (bridge/src/pairing.ts)
{
  const { createHmac } = await import('node:crypto');
  const proof = (secret, role, nb, np) => createHmac('sha256', secret).update(`grip-auth|${role}|${nb}|${np}`).digest('hex');
  const SECRET = 'ab'.repeat(32), NB = 'cd'.repeat(16);
  const fresh = (token) => { const h = harness(); h.store.token = token ?? null; h.fromMain({ kind: 'pairToken', token: token ?? null }); return h; };
  const requestFrame = { id: 'q1', method: 'get_node', params: { nodeId: '1:1' } };
  const forwarded = (h) => h.posted.some((m) => m.pluginMessage.kind === 'request');
  const helloAsked = (h) => h.posted.some((m) => m.pluginMessage.kind === 'welcome');

  // first use: no token stored -> ask to pair; the grant is saved and the plugin goes on
  {
    const h = fresh(); const ws = h.ws(); ws.open();
    ws.deliver({ kind: 'welcome', sessionId: 's1', bridgeVersion: '0.9.6', nonce: NB, pairing: 'open' });
    assert.deepStrictEqual(ws.sent.at(-1), { type: 'pair_request' });
    assert.ok(!helloAsked(h), 'no hello before the bridge answered');
    ws.deliver(requestFrame);
    assert.ok(!forwarded(h), 'a request on an untrusted socket is not obeyed');
    ws.deliver({ type: 'paired', tokenId: 't1', secret: SECRET });
    assert.deepStrictEqual(h.store.token, { id: 't1', secret: SECRET }, 'the token reaches clientStorage');
    assert.ok(helloAsked(h), 'hello follows the pairing');
    ws.deliver(requestFrame);
    assert.ok(forwarded(h), 'requests flow once trusted');
  }
  // a stored token: prove ourselves, verify the bridge, only then hello and obey
  {
    const h = fresh({ id: 't1', secret: SECRET }); const ws = h.ws(); ws.open();
    ws.deliver({ kind: 'welcome', sessionId: 's1', bridgeVersion: '0.9.6', nonce: NB, pairing: 'enforced' });
    const auth = ws.sent.at(-1);
    assert.strictEqual(auth.type, 'auth'); assert.strictEqual(auth.tokenId, 't1');
    assert.strictEqual(auth.proof, proof(SECRET, 'plugin', NB, auth.nonce), 'plugin proof matches node:crypto HMAC');
    assert.ok(!JSON.stringify(ws.sent).includes(SECRET), 'the secret never goes on the wire');
    assert.ok(!helloAsked(h));
    ws.deliver({ type: 'auth_ok', proof: proof(SECRET, 'bridge', NB, auth.nonce) });
    assert.ok(helloAsked(h)); ws.deliver(requestFrame); assert.ok(forwarded(h));
  }
  // an impostor that cannot prove the bridge half: refused, no hello, no requests
  {
    const h = fresh({ id: 't1', secret: SECRET }); const ws = h.ws(); ws.open();
    ws.deliver({ kind: 'welcome', sessionId: 's1', nonce: NB });
    const auth = ws.sent.at(-1);
    ws.deliver({ type: 'auth_ok', proof: proof('ff'.repeat(32), 'bridge', NB, auth.nonce) });
    assert.ok(!helloAsked(h), 'no file name or key is sent to a bridge that failed the proof');
    ws.deliver(requestFrame); assert.ok(!forwarded(h));
    assert.ok(h.has('warning')); assert.match(h.title(), /could not prove who it is/);
    // the plugin's own proof must not be replayable as the bridge's
    const h2 = fresh({ id: 't1', secret: SECRET }); const ws2 = h2.ws(); ws2.open();
    ws2.deliver({ kind: 'welcome', sessionId: 's1', nonce: NB });
    const a2 = ws2.sent.at(-1);
    ws2.deliver({ type: 'auth_ok', proof: a2.proof });
    assert.ok(!helloAsked(h2), 'reflecting the plugin proof does not pass');
  }
  // a squatter with NO pairing support while we hold a token: refused (downgrade)
  {
    const h = fresh({ id: 't1', secret: SECRET }); const ws = h.ws(); ws.open();
    ws.deliver({ kind: 'welcome', sessionId: 's1', bridgeVersion: '0.9.5' });
    assert.ok(!helloAsked(h)); ws.deliver(requestFrame); assert.ok(!forwarded(h));
    assert.ok(h.has('warning'));
  }
  // not paired and not allowed to: says what to run, click retries
  {
    const h = fresh(); const ws = h.ws(); ws.open();
    ws.deliver({ kind: 'welcome', sessionId: 's1', nonce: NB, pairing: 'enforced' });
    ws.deliver({ type: 'pair_denied', reason: 'pairing_required' });
    assert.ok(h.has('warning') && h.has('actionable'));
    assert.match(h.title(), /grip-bridge\.mjs pair/);
    const n = h.instances.length;
    h.click();
    assert.strictEqual(h.instances.length, n + 1, 'a click reconnects at once');
    assert.ok(!helloAsked(h));
  }
  // refused right after someone else paired: say so, with the recovery
  {
    const h = fresh(); const ws = h.ws(); ws.open();
    ws.deliver({ kind: 'welcome', sessionId: 's1', nonce: NB, pairing: 'enforced' });
    ws.deliver({ type: 'pair_denied', reason: 'pairing_required', recentGrant: true });
    assert.ok(h.has('warning'));
    assert.match(h.title(), /Another client paired first/);
    assert.match(h.title(), /pair --reset/);
  }
  // two windows pair at the same moment: the loser must pick up the winner's token on its next connect
  {
    const TOKEN = { id: '0123456789abcdef', secret: SECRET };
    const h = fresh(); const ws = h.ws(); ws.open();
    ws.deliver({ kind: 'welcome', sessionId: 's1', nonce: NB, pairing: 'enforced' });
    ws.deliver({ type: 'pair_denied', reason: 'pairing_required', recentGrant: true });
    assert.match(h.title(), /Another client paired first/);
    h.store.token = TOKEN;                                   // the other window saved its token meanwhile
    h.advance(9000);                                         // slow reconnect
    const ws2 = h.ws(); assert.notStrictEqual(ws2, ws, 'reconnected');
    ws2.open();
    ws2.deliver({ kind: 'welcome', sessionId: 's2', nonce: NB, pairing: 'enforced' });
    assert.strictEqual(ws2.sent.at(-1).type, 'auth', 'the loser authenticates with the winner\'s token instead of asking to pair again');
    assert.strictEqual(ws2.sent.at(-1).tokenId, TOKEN.id);
  }
  // the bridge forgot us: tell the user, a click drops the old token and pairs again
  {
    const h = fresh({ id: 't1', secret: SECRET }); const ws = h.ws(); ws.open();
    ws.deliver({ kind: 'welcome', sessionId: 's1', nonce: NB });
    ws.deliver({ type: 'auth_failed' });
    assert.match(h.title(), /Pairing lost/);
    h.click();
    assert.strictEqual(h.store.token, null, 'the stale token is cleared');
    assert.ok(!h.has('warning') || h.title() !== 'Pairing lost. Click to pair again');
  }
}

// ------------------------------------------------------------ admission ticket (reserved pool)
{
  const TOKEN = { id: '0123456789abcdef', secret: 'ab'.repeat(32) };
  // a paired plugin carries its token id (never the secret) in the connect URL
  {
    const h = harness(); h.store.token = TOKEN; h.fromMain({ kind: 'pairToken', token: TOKEN });
    h.ws().drop(1006); h.advance(5000);
    assert.strictEqual(h.ws().url, 'ws://localhost:7777/?t=0123456789abcdef', 'the reconnect carries the ticket');
    assert.ok(!h.ws().url.includes(TOKEN.secret));
  }
  // unpaired: plain URL
  {
    const h = harness();
    assert.strictEqual(h.ws().url, 'ws://localhost:7777');
  }
  // if Figma refused a URL with a query, the third attempt goes without it and the ticket is then dropped
  {
    const h = harness(); h.store.token = TOKEN; h.fromMain({ kind: 'pairToken', token: TOKEN });
    h.ws().drop(1006); h.advance(5000);                                    // attempt with ticket (fails)
    assert.ok(h.ws().url.includes('?t='));
    h.ws().drop(1006); h.advance(5000);                                    // ticket again (fails)
    assert.ok(h.ws().url.includes('?t='));
    h.ws().drop(1006); h.advance(5000);                                    // two failures: try without
    assert.strictEqual(h.ws().url, 'ws://localhost:7777', 'the third attempt goes without the ticket');
    h.ws().openWelcomed();
    h.ws().drop(1006); h.advance(5000);
    assert.strictEqual(h.ws().url, 'ws://localhost:7777', 'a ticketless success drops the ticket for this window');
  }
  // a working ticket keeps being used
  {
    const h = harness(); h.store.token = TOKEN; h.fromMain({ kind: 'pairToken', token: TOKEN });
    h.ws().drop(1006); h.advance(5000);
    h.ws().open(); h.ws().drop(1006); h.advance(5000);
    assert.ok(h.ws().url.includes('?t='));
  }
}

console.log('plugin-ui.mjs OK');
