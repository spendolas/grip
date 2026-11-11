// `node ~/.grip/grip-bridge.mjs pair [--status|--reset|--close|--require|--auto]`
//
// Pairing (pairing.ts) lets the first Figma plugin that connects pair itself; after that the
// bridge refuses every connection that cannot prove it holds a pairing secret. This command
// is the way to pair ANOTHER plugin install (another Figma profile, a reinstalled plugin) or
// to start over. It talks to the daemon only through files under GRIP_HOME, so it never
// starts a daemon and never touches the MCP stdout stream.
import { PAIR_WINDOW_MS, PairingStore } from './pairing.js';

export function isPairCli(argv: string[]): boolean {
  if (argv.includes('--daemon')) return false;
  return argv.slice(2)[0] === 'pair';
}

function out(msg = '') { process.stdout.write(msg + '\n'); }

// `pair --require` makes every pairing need a window (what a fresh install gets); `--auto` goes back to
// trust on first use (only while nothing is paired). Both are kept in pairing.json.
export function runPairCli(argv: string[]): number {
  const flags = new Set(argv.slice(3));
  const store = new PairingStore();
  if (store.mode === 'off') {
    out('Pairing is switched off (GRIP_PAIRING=off): the bridge accepts every plugin connection.');
    return 0;
  }
  if (flags.has('--status')) {
    const s = store.status();
    out(`pairing: mode ${s.mode}, ${s.paired} plugin install(s) paired, ${s.enforced ? 'enforced' : 'not enforced yet (the first plugin that connects pairs itself; `pair --require` closes that)'}${s.windowOpen ? ', pairing window OPEN' : ''}`);
    return 0;
  }
  if (flags.has('--require')) {
    store.setRequired(true);
    out('Pairing is now required: the bridge refuses every plugin that has not paired, and a plugin can only pair while a window is open (`pair`).');
    out('Plugins that predate pairing (before Grip 0.9.6) stop connecting until they are updated and paired.');
    return 0;
  }
  if (flags.has('--auto')) { store.setRequired(false); out('Pairing mode is automatic again: the first plugin that connects pairs itself.'); return 0; }
  if (flags.has('--close')) { store.closeWindow(); out('Pairing window closed.'); return 0; }
  if (flags.has('--reset')) {
    store.reset();
    out('Every pairing was removed. Plugins must pair again.');
  }
  const until = store.openWindow();
  out(`Pairing window open for ${Math.round(PAIR_WINDOW_MS / 1000)}s (until ${new Date(until).toLocaleTimeString()}).`);
  out('Open the Grip plugin in Figma now: the first plugin install that connects is paired, then the window closes.');
  out('(Only do this on a machine you trust right now. Anything that connects during the window can pair.)');
  return 0;
}
