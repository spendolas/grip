// Plugin pairing: a shared secret between this bridge and each Figma plugin install.
//
// Why: the plugin WebSocket has no authentication, and Figma's plugin iframe sends the
// Origin "null" that ANY sandboxed iframe, data: page or file: page also sends. So a web
// page, or another local process squatting the port before the daemon, could pose as the
// plugin (steal agent calls, feed an agent poisoned answers) or as the bridge (drive the
// plugin). A secret only the real pair knows fixes both directions, and the proofs below
// never put the secret on the wire.
//
// Model:
//   - The bridge keeps tokens {id, secret} in <GRIP_HOME>/pairing.json (mode 0600).
//   - Every connection gets a fresh bridge nonce in its welcome frame. A paired plugin
//     answers with HMAC(secret, "<label>|plugin|<bridgeNonce>|<pluginNonce>"); the bridge
//     verifies it and answers with the "bridge" proof, which the plugin verifies BEFORE it
//     sends a hello or obeys one request. A squatter without the secret cannot produce it.
//     <label> is authLabel(flavour): "grip-auth" for the public build, "grip-auth:<slug>" else.
//   - First pairing is trust-on-first-use: while no token exists, the first plugin that asks
//     gets one. From then on the bridge enforces: unpaired clients are refused. Another
//     plugin install (another Figma profile) is paired by opening a window on the machine:
//     `node ~/.grip/grip-bridge.mjs pair` (2 minutes; one grant closes it).
//   - A fresh install is different: the installer writes {"required":true} into pairing.json
//     and opens a 5 minute window (prepareInstall), so no open-ended trust on first use ever
//     exists on an installed machine. Pairing then needs the window the installer opened (or
//     `pair`). Installs that predate this stay in auto mode until `pair --require`.
//   - GRIP_PAIRING=off never enforces (the old open behaviour), =required enforces even
//     with no token (every pairing then needs a window), =auto ignores the file's flag.
// Bridges that do not do this send no nonce in welcome; plugins that predate it send no
// proof. Both keep working until a plugin has actually paired.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { liveIdentity } from './identity.js';

export type PairingMode = 'auto' | 'off' | 'required';
export const PAIR_WINDOW_MS = 120_000;
export const INSTALL_WINDOW_MS = 300_000;
// A pairing newer than this makes a denied pair_request say "someone paired first" (see recentGrant).
export const RECENT_GRANT_MS = 15 * 60_000;
export const PAIR_NONCE_BYTES = 16;

export interface PairToken { id: string; secret: string; createdAt: string; origin?: string }

export function parsePairingMode(v: string | undefined): PairingMode {
  const s = (v ?? '').trim().toLowerCase();
  if (s === 'off' || s === '0' || s === 'false') return 'off';
  if (s === 'required') return 'required';
  return 'auto';
}

export function newNonce(): string { return randomBytes(PAIR_NONCE_BYTES).toString('hex'); }

// The label that starts every proof. It names the build flavour, so a proof made for one
// flavour never verifies on a bridge of another. The public flavour keeps the legacy label,
// which keeps every proof an already-published plugin makes byte-identical.
export function authLabel(slug: string): string {
  return slug === 'grip' ? 'grip-auth' : `grip-auth:${slug}`;
}

// The proof one side shows the other. `role` says who is proving ('plugin' or 'bridge'), so a
// proof can never be replayed in the other direction. The key is the secret string itself
// (its UTF-8 bytes), which keeps the plugin side a few lines of plain JS.
export function authProof(secret: string, role: 'plugin' | 'bridge', bridgeNonce: string, pluginNonce: string, slug = 'grip'): string {
  return createHmac('sha256', secret).update(`${authLabel(slug)}|${role}|${bridgeNonce}|${pluginNonce}`).digest('hex');
}

function sameHex(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length > 256) return false;
  const x = Buffer.from(a, 'utf8'), y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

export class PairingStore {
  readonly dir: string;
  // An explicit mode (constructor argument or GRIP_PAIRING) wins; otherwise pairing.json says:
  // {"required":true} (written by the installer or `pair --require`) means required, else auto.
  private readonly explicit?: PairingMode;
  private cache: PairToken[] = [];
  private requiredFlag = false;
  private cacheKey = '';

  constructor(dir?: string, mode?: PairingMode) {
    this.dir = dir ?? liveIdentity().home;
    const env = (process.env.GRIP_PAIRING ?? '').trim();
    this.explicit = mode ?? (env !== '' ? parsePairingMode(env) : undefined);
  }

  get mode(): PairingMode {
    if (this.explicit) return this.explicit;
    this.load();
    return this.requiredFlag ? 'required' : 'auto';
  }

  private get tokensPath(): string { return join(this.dir, 'pairing.json'); }
  private get windowPath(): string { return join(this.dir, 'pairing-window.json'); }

  // The CLI (a separate process) edits these files, so every decision re-reads them when
  // their mtime or size changed. Cheap: two stat calls on a handshake.
  private load(): void {
    try {
      const st = statSync(this.tokensPath);
      const key = `${st.mtimeMs}:${st.size}`;
      if (key === this.cacheKey) return;
      const raw = JSON.parse(readFileSync(this.tokensPath, 'utf8')) as { tokens?: unknown; required?: unknown };
      const list = Array.isArray(raw.tokens) ? raw.tokens : [];
      this.cache = list.filter((t): t is PairToken =>
        !!t && typeof (t as PairToken).id === 'string' && typeof (t as PairToken).secret === 'string' && (t as PairToken).secret.length >= 32);
      this.requiredFlag = raw.required === true;
      this.cacheKey = key;
    } catch {
      this.cache = [];
      this.requiredFlag = false;
      this.cacheKey = '';
    }
  }

  tokens(): PairToken[] { this.load(); return this.cache; }

  // Persist tokens and the `required` flag together (atomic, owner-only).
  private save(tokens: PairToken[], required: boolean): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.tokensPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ required, tokens }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.tokensPath);
    try { chmodSync(this.tokensPath, 0o600); } catch { /* non-fatal (Windows) */ }
    this.cacheKey = '';
  }

  // `pair --require` / `--auto`: the persistent mode, kept across grants and resets.
  setRequired(required: boolean): void { this.load(); this.save(this.cache, required); }
  hasFile(): boolean { return existsSync(this.tokensPath); }

  // Does the bridge take part in pairing at all (does it send a nonce)?
  active(): boolean { return this.mode !== 'off'; }

  // Must a connection prove itself before it may say hello?
  enforced(): boolean {
    if (this.mode === 'off') return false;
    if (this.mode === 'required') return true;
    return this.tokens().length > 0;
  }

  windowOpen(): boolean {
    try {
      const w = JSON.parse(readFileSync(this.windowPath, 'utf8')) as { until?: unknown };
      return typeof w.until === 'number' && w.until > Date.now();
    } catch { return false; }
  }

  // May a pair_request be granted right now? First use (auto mode, nothing paired yet) or a
  // window the user opened on this machine.
  mayGrant(): boolean {
    if (this.mode === 'off') return false;
    return this.windowOpen() || (this.mode === 'auto' && this.tokens().length === 0);
  }

  // Mint a token. Fail closed: if it cannot be saved, nobody is paired.
  grant(origin?: string): PairToken | null {
    try {
      const token: PairToken = { id: randomBytes(8).toString('hex'), secret: randomBytes(32).toString('hex'), createdAt: new Date().toISOString(), origin: (origin ?? 'none').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 100) };
      this.load();
      this.save([...this.cache, token], this.requiredFlag);
      this.closeWindow();   // one grant per window
      return token;
    } catch (err) {
      process.stderr.write(`[grip] pairing: could not save the token (${(err as Error).message})\n`);
      return null;
    }
  }

  find(tokenId: unknown): PairToken | null {
    if (typeof tokenId !== 'string') return null;
    return this.tokens().find((t) => t.id === tokenId) ?? null;
  }

  // Verify a plugin's proof for a token. Returns the token on success.
  // `slug` is the bridge's flavour: the proof must carry its label.
  verify(tokenId: unknown, bridgeNonce: string, pluginNonce: unknown, proof: unknown, slug = 'grip'): PairToken | null {
    const t = this.find(tokenId);
    if (!t || typeof pluginNonce !== 'string' || pluginNonce.length < 8 || pluginNonce.length > 128 || typeof proof !== 'string') return null;
    return sameHex(proof, authProof(t.secret, 'plugin', bridgeNonce, pluginNonce, slug)) ? t : null;
  }

  openWindow(ms = PAIR_WINDOW_MS): number {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const until = Date.now() + ms;
    writeFileSync(this.windowPath, JSON.stringify({ until }), { mode: 0o600 });
    return until;
  }

  closeWindow(): void { try { rmSync(this.windowPath, { force: true }); } catch { /* none */ } }

  // Forget every pairing (CLI `pair --reset`): all plugins must pair again.
  reset(): void {
    this.load();
    if (this.requiredFlag) { try { this.save([], true); } catch { /* none */ } }   // keep the mode, drop the tokens
    else { try { rmSync(this.tokensPath, { force: true }); } catch { /* none */ } }
    this.cacheKey = '';
    this.cache = [];
  }

  // Was a plugin paired in the last RECENT_GRANT_MS? A pair_request that is refused right after
  // another client paired is how a window race shows up to the loser (see ws-server onPairRequest).
  recentGrant(): boolean {
    const newest = this.tokens().map((t) => Date.parse(t.createdAt)).filter(Number.isFinite).sort((a, b) => b - a)[0];
    return newest !== undefined && Date.now() - newest < RECENT_GRANT_MS;
  }

  status(): { mode: PairingMode; enforced: boolean; paired: number; windowOpen: boolean; lastPairedAt?: string; lastPairedOrigin?: string } {
    const last = [...this.tokens()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    return {
      mode: this.mode, enforced: this.enforced(), paired: this.tokens().length, windowOpen: this.windowOpen(),
      ...(last ? { lastPairedAt: last.createdAt, lastPairedOrigin: last.origin ?? 'unknown' } : {}),
    };
  }
}

// Fresh install (src/install.ts): the installer is run by a person who is present, so it is the
// one moment pairing can be set up without trust on first use. Writes {"required":true} and opens
// a window long enough to open Figma and run the plugin. An existing pairing.json is left alone.
export function prepareInstall(dir?: string): 'prepared' | 'kept' | 'off' {
  const store = new PairingStore(dir);
  if (!store.active()) return 'off';
  if (store.hasFile()) return 'kept';
  store.setRequired(true);
  store.openWindow(INSTALL_WINDOW_MS);
  return 'prepared';
}
