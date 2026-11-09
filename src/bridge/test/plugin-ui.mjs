// Plugin status-strip tests (figma-plugin/ui.html). No jsdom: the page's own
// <script> runs in a node:vm context against a tiny fake DOM / WebSocket /
// timer, so the real state machine is exercised (colour classes, tooltips, the
// single click, the failure flash, the post-update reconnect). What this cannot
// show: how the colours LOOK and whether Figma renders `title` tooltips in its
// plugin iframe: that needs a live Figma check (see the report / README).
import assert from 'node:assert';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
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
    deliver(o) { this.onmessage?.({ data: JSON.stringify(o) }); }
    drop(code = 1006, reason = '') { this.readyState = 3; this.onclose?.({ code, reason }); }
  }
  const posted = [];
  const win = {};
  const ctx = vm.createContext({
    document: { getElementById: (id) => { requested.push(id); return strip; } },
    WebSocket: FakeWS,
    parent: { postMessage: (m) => posted.push(JSON.parse(JSON.stringify(m))) },   // plain host-realm copy
    window: win,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: now + (ms || 0) }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    JSON,
  });
  vm.runInContext(script, ctx);
  const h = {
    classes: () => [...classes].sort(),
    has: (c) => classes.has(c),
    title: () => strip.title,
    click: () => (listeners.click ?? []).forEach((f) => f()),
    ws: () => instances.at(-1),
    instances,
    posted,
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
  ws.open();
  assert.ok(h.has('connected') && !purple(h) && !h.has('actionable'));
  assert.strictEqual(h.title(), 'Connected');
  ws.deliver({ kind: 'welcome', sessionId: 's1', bridgeVersion: '0.8.0' });
  assert.deepStrictEqual(h.posted.at(-1), { pluginMessage: { kind: 'welcome', sessionId: 's1' } });
  h.fromMain({ kind: 'hello', version: '0.8.0', minBridge: '0.7.0', capabilities: ['x'], fileKey: 'k', fileName: 'f', currentPageId: '0:1', currentPageName: 'P' });
  assert.deepStrictEqual(ws.sent.at(-1), { kind: 'hello', version: '0.8.0', minBridge: '0.7.0', capabilities: ['x'], fileKey: 'k', fileName: 'f', currentPageId: '0:1', currentPageName: 'P' }, 'full hello forwarded, minBridge included');
  assert.strictEqual(h.title(), CONNECTED_TITLE);

  // busy pulse (existing behaviour) while connected and nothing on offer
  h.fromMain({ kind: 'busy', busy: true });
  assert.ok(h.has('pulsing') && h.has('connected'));
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
  h.ws().open();
  assert.ok(h.has('connected') && !purple(h), 'back to green on the new bridge (nothing pending)');
  assert.strictEqual(h.title(), CONNECTED_TITLE);
}

// ------------------------------------------------------------ failure: brief red flash, then purple with a retry tooltip
{
  const h = harness();
  const ws = h.ws();
  ws.open();
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
  ws.open();
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
  ws.open();
  ws.deliver({ type: 'update', available: true, latest: '0.9.0', current: '0.8.0' });
  assert.ok(h.has('update'));
  ws.drop(1006);
  assert.ok(!purple(h) && !h.has('connected'), 'a disconnected strip stays grey');
  assert.ok(h.has('actionable'));
  assert.strictEqual(h.title(), 'Bridge not running. Click for setup');
  h.advance(2000);
  const ws2 = h.ws();
  ws2.open();
  assert.ok(h.has('connected') && !purple(h), 'a fresh connection starts without an offer until the bridge announces one');
  ws2.deliver({ type: 'update', available: true, latest: '0.9.0', current: '0.8.0' });
  assert.ok(h.has('update'), 'the bridge re-announces on hello');
  // the existing warning state (duplicate plugin window) is not purple either
  ws2.drop(1000, 'duplicate');
  assert.ok(h.has('warning') && !purple(h));
}

console.log('plugin-ui.mjs OK');
