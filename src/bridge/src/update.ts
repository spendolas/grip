// Self-update for the Grip bridge. USER-TRIGGERED ONLY.
//
// Two halves:
//   1. CHECK  — ask GitHub for the latest published Release of this repo
//      (api.github.com/repos/spendolas/grip/releases/latest), compare its tag to
//      BRIDGE_VERSION, remember the answer plus the release notes and the
//      release's compat.json (the oldest Figma plugin it works with, verified
//      against a SIGNED SHA256SUMS.txt). The daemon does this ~30s after startup and
//      every 24h. Pure information: it never installs anything, and every
//      failure is silent.
//   2. INSTALL — only when a human said yes (the user's click on the purple
//      plugin strip, an agent after the user agrees, or the CLI). Downloads the
//      release's bridge + plugin assets and SHA256SUMS.txt, verifies every file
//      against SHA256SUMS.txt (whose Ed25519 signature, SHA256SUMS.txt.sig, must
//      verify against a key pinned in this file) and a size cap, runs the new bridge once with
//      --selftest, and only THEN writes (tmp file + rename) into ~/.grip. A
//      developer (git clone) install is never overwritten.
//
// COMPATIBILITY comes first. The published plugin is updated through Figma, not
// by this updater, so a user's plugin can lag the bridge. An update is only
// signalled (updateSignal) or installed when EVERY connected plugin is new
// enough for it (compat.json minPlugin); a release without a verifiable
// compat.json is neither signalled nor installable (the CLI's --force excepted).
//
// SIGNATURE comes before everything else. SHA256SUMS.txt comes from the same
// release as the files it lists, so on its own it only catches corruption.
// Releases therefore carry SHA256SUMS.txt.sig, an Ed25519 signature over the
// exact bytes of SHA256SUMS.txt, made in CI with a key that lives only in a
// repository secret. The bridge trusts the sums (and so every file and
// compat.json they vouch for) only when that signature verifies against
// RELEASE_PUBLIC_KEYS, which the flavour file pins. A missing or invalid
// signature fails closed and NOTHING, not even --force, bypasses it.
//
// The Figma plugin's networkAccess is localhost-only, so the plugin never
// touches the internet: this module (in the bridge) is the only code that does.
//
// Dependency-free on purpose (node builtins only): the bridge ships as one
// bundled file and the installer bundle imports this module too.
//
// ALL logging goes to stderr — stdout is the MCP transport.

import { createHash, createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync,
} from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRIDGE_VERSION, PROTOCOL_VERSION } from './types.js';
import { FLAVOUR } from './flavour.gen.js';
import { liveIdentity } from './identity.js';
import { downloadPrefixFor, overridesAllowed } from './update-policy.js';
import type { PluginBridge } from './ws-server.js';

export const DEFAULT_RELEASES_API = FLAVOUR.releasesApi;

// Release asset names. scripts/package-release.mjs produces them and
// scripts/release-gate.mjs requires them; a test keeps all three in step.
export const ASSET_BRIDGE = 'grip-bridge.mjs';
export const ASSET_SUMS = 'SHA256SUMS.txt';
export const ASSET_SUMS_SIG = 'SHA256SUMS.txt.sig';   // base64 of the raw 64-byte Ed25519 signature over SHA256SUMS.txt
export const ASSET_COMPAT = 'compat.json';   // { version, minPlugin, flavour?, protocol?, minPluginProtocol? }
// release asset name -> file name inside ~/.grip/figma-plugin
export const PLUGIN_ASSETS: Record<string, string> = {
  'grip-plugin-code.js': 'code.js',
  'grip-plugin-ui.html': 'ui.html',
  'grip-plugin-manifest.json': 'manifest.json',
};
export const UPDATE_ASSET_NAMES = [ASSET_BRIDGE, ...Object.keys(PLUGIN_ASSETS), ASSET_SUMS, ASSET_SUMS_SIG, ASSET_COMPAT];
// release-page footer marker: everything from this line on is for GitHub
// readers (install pointer), never part of an update notice. Appended by
// scripts/release-gate.mjs (INSTALL_MARKER there).
export const INSTALL_MARKER = '<!-- grip-install -->';

const RELEASE_MAX_BYTES = 256 * 1024;
const SUMS_MAX_BYTES = 64 * 1024;
const COMPAT_MAX_BYTES = 4 * 1024;
const SIG_MAX_BYTES = 1024;   // a base64 Ed25519 signature is 88 bytes
const NOTICE_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000;   // agent notice: once per version per 3 days
const SELFTEST_TIMEOUT_MS = 10_000;
// GRIP_SELFTEST_TIMEOUT_MS can only LOWER the 10s ceiling (tests).
function selftestTimeoutMs(): number {
  const v = Number(process.env.GRIP_SELFTEST_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? Math.min(v, SELFTEST_TIMEOUT_MS) : SELFTEST_TIMEOUT_MS;
}
const FILE_MAX_BYTES = 5 * 1024 * 1024;
const MAX_ASSETS = 100;
const NOTES_MAX_CHARS = 1200;
const HEADLINE_MAX_CHARS = 160;
const MANIFEST_TIMEOUT_MS = 5_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 3;
const CHECK_DELAY_MS = 30_000;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

function logErr(msg: string) { process.stderr.write(`[grip] ${msg}\n`); }

// ---------- environment seams ----------

// ~/.grip — GRIP_HOME overrides it so tests never touch the real one.
export function gripHome(): string {
  return liveIdentity().home;
}
export function statusFilePath(): string {
  return liveIdentity().statusPath;
}
// GRIP_NO_UPDATE_CHECK=1 turns off the AUTOMATIC checks and every notice.
// Explicit user actions (install, the CLI) still work: the user asked.
export function updatesDisabled(): boolean {
  const v = process.env.GRIP_NO_UPDATE_CHECK;
  return v === '1' || v === 'true';
}

// Accept https anywhere, plain http only for loopback (tests / a local mirror).
export function normalizeUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && loopback))) return null;
  if (u.username || u.password) return null;
  u.hash = '';
  return u.toString();
}

let warnedApi = false;
// GRIP_RELEASES_API replaces the whole "latest release" URL (tests, forks).
// A flavour with lockOverrides ignores it.
export function releasesApi(): string {
  if (!overridesAllowed(FLAVOUR)) return DEFAULT_RELEASES_API;
  const raw = process.env.GRIP_RELEASES_API?.trim();
  if (!raw) return DEFAULT_RELEASES_API;
  const norm = normalizeUrl(raw);
  if (norm) return norm;
  if (!warnedApi) {
    warnedApi = true;
    logErr(`update: ignoring GRIP_RELEASES_API=${raw} (must be https, or http on 127.0.0.1/localhost); using the default`);
  }
  return DEFAULT_RELEASES_API;
}
function overrideOrigin(): string | null {
  if (!overridesAllowed(FLAVOUR)) return null;
  if (!process.env.GRIP_RELEASES_API?.trim()) return null;
  try { return new URL(releasesApi()).origin; } catch { return null; }
}

// Where downloads may come from (the first URL and every redirect hop).
// github.com release downloads redirect to release-assets.githubusercontent.com
// / objects.githubusercontent.com. https only; the one extra host is the
// GRIP_RELEASES_API override (so tests and forks can point elsewhere).
const ALLOWED_HOSTS = ['github.com', 'api.github.com'];
export function hostAllowed(u: URL): boolean {
  const extra = overrideOrigin();
  if (extra && u.origin === extra) return true;
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  if (u.port !== '' && u.port !== '443') return false;
  const h = u.hostname.toLowerCase();
  return ALLOWED_HOSTS.includes(h) || h.endsWith('.githubusercontent.com');
}

// ---------- release signature ----------

// The Ed25519 public keys (SPKI PEM) whose signature over SHA256SUMS.txt makes a
// release trustworthy. Pinned in the flavour file (flavour/flavour.json releaseKeys),
// so each flavour trusts only its own. An ARRAY so a key can be rotated: ship a bridge
// that trusts the old and the new key, then sign with the new one. The matching
// private key lives only in the GRIP_RELEASE_SIGNING_KEY repository secret
// (see .github/workflows/release.yml, scripts/sign-release.mjs). Public keys are
// not secrets, so scripts/bundle-hygiene.mjs lets this one through.
export const RELEASE_PUBLIC_KEYS: readonly string[] = FLAVOUR.releaseKeys;

// GRIP_RELEASE_PUBKEY (PEM text) REPLACES the pinned list, but ONLY in a test run
// (GRIP_TEST=1): tests sign fake releases with their own key. Without the flag it is
// ignored (with one notice), so that setting an environment variable on the daemon can
// never point it at someone else's key. It can only substitute a key, never switch
// verification off: a value that is not a usable Ed25519 public key leaves NO trusted
// key, so every release then fails closed.
let pubkeyNoticeShown = false;
export function trustedReleaseKeys(): KeyObject[] {
  const override = process.env.GRIP_RELEASE_PUBKEY;
  const overrideSet = override !== undefined && override.trim() !== '';
  const testRun = process.env.GRIP_TEST === '1';
  if (!overridesAllowed(FLAVOUR)) {
    if (overrideSet && !pubkeyNoticeShown) {
      pubkeyNoticeShown = true;
      process.stderr.write('[grip] GRIP_RELEASE_PUBKEY ignored (this build locks its update overrides)\n');
    }
    return pinnedKeys();
  }
  if (overrideSet && !testRun && !pubkeyNoticeShown) {
    pubkeyNoticeShown = true;
    process.stderr.write('[grip] GRIP_RELEASE_PUBKEY ignored (not a test run: it only works with GRIP_TEST=1)\n');
  }
  return overrideSet && testRun ? parseKeys([override!]) : pinnedKeys();
}
function pinnedKeys(): KeyObject[] { return parseKeys(RELEASE_PUBLIC_KEYS); }
function parseKeys(pems: readonly string[]): KeyObject[] {
  const keys: KeyObject[] = [];
  for (const pem of pems) {
    try {
      const k = createPublicKey(pem);
      if (k.asymmetricKeyType === 'ed25519') keys.push(k);
    } catch { /* an unusable key trusts nothing */ }
  }
  return keys;
}

// True only when `sigText` is the base64 of a 64-byte Ed25519 signature that
// verifies over exactly `sums` against one of `keys`.
export function verifySumsSignature(sums: Buffer, sigText: Buffer | string, keys: KeyObject[] = trustedReleaseKeys()): boolean {
  const text = (typeof sigText === 'string' ? sigText : sigText.toString('utf8')).trim();
  if (!/^[A-Za-z0-9+/]{86}==$/.test(text)) return false;   // exactly 64 bytes of base64
  const sig = Buffer.from(text, 'base64');
  if (sig.length !== 64) return false;
  for (const k of keys) {
    try { if (cryptoVerify(null, sums, k, sig)) return true; } catch { /* try the next key */ }
  }
  return false;
}

// A failure of trust in the release itself, not of compatibility: its signature is
// missing or wrong, or its signed compat.json is for another flavour. Every surface
// treats these alike (state.signatureError carries the message): never signalled,
// never installable, and no flag (not --force) overrides them.
export function isTrustFailure(code: string | undefined | null): boolean {
  return typeof code === 'string' && (code.startsWith('signature_') || code === 'flavour_mismatch');
}

// ---------- semver ----------

const SEMVER_RE = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z.-]{1,32}))?$/;

// Numeric x.y.z compare. A prerelease suffix sorts BELOW the same x.y.z
// release (0.8.0-beta < 0.8.0); two prereleases compare as strings. Returns
// <0, 0, >0. Unparseable input compares as equal (never claims an update).
export function compareSemver(a: string, b: string): number {
  const pa = SEMVER_RE.exec(a), pb = SEMVER_RE.exec(b);
  if (!pa || !pb) return 0;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  const ra = pa[4], rb = pb[4];
  if (ra === rb) return 0;
  if (!ra) return 1;
  if (!rb) return -1;
  return ra < rb ? -1 : 1;
}
export function isSemver(v: unknown): v is string {
  return typeof v === 'string' && SEMVER_RE.test(v);
}

// ---------- errors + HTTP ----------

// `code` lets callers (tool, WS, CLI) tell failure kinds apart:
//   compat_unverified  the release has no compat.json, or it does not verify
//   signature_missing  the release has no SHA256SUMS.txt.sig (never bypassed, not even by --force)
//   signature_invalid  SHA256SUMS.txt.sig does not verify against a pinned release key (same)
//   flavour_mismatch   the signed compat.json claims another flavour than this build's (same; see isTrustFailure)
export class UpdateError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}

// GET a URL into memory. Enforces a hard byte cap (header AND streamed), an
// overall deadline, and the HOST rule: the start URL and every redirect hop
// (max 3) must pass hostAllowed().
function httpGet(
  url: string,
  o: { maxBytes: number; timeoutMs: number; headers?: Record<string, string>; redirectsLeft?: number },
): Promise<Buffer> {
  return new Promise((resolveP, rejectP) => {
    let u: URL;
    try { u = new URL(url); } catch { rejectP(new UpdateError(`bad URL: ${url}`)); return; }
    if (!hostAllowed(u)) {
      rejectP(new UpdateError(`refused: ${u.host} is not an allowed update host`));
      return;
    }
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const done = (err: Error | null, buf?: Buffer) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) rejectP(err); else resolveP(buf!);
    };
    const doRequest = u.protocol === 'https:' ? httpsRequest : httpRequest;
    // A generic user agent and nothing else: no account, email or machine identifier.
    const req = doRequest(u, {
      method: 'GET',
      headers: { 'user-agent': `grip-bridge/${BRIDGE_VERSION}`, accept: '*/*', ...(o.headers ?? {}) },
    }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        const left = o.redirectsLeft ?? MAX_REDIRECTS;
        if (left <= 0) { done(new UpdateError('too many redirects')); return; }
        let next: string;
        try { next = new URL(res.headers.location, u).toString(); }
        catch { done(new UpdateError('bad redirect location')); return; }
        httpGet(next, { ...o, redirectsLeft: left - 1 }).then(
          (b) => done(null, b),
          (e) => done(e),
        );
        return;
      }
      if (status !== 200) {
        res.resume();
        const hint = status === 403 || status === 429 ? ' (GitHub rate limit? try again later)' : '';
        done(new UpdateError(`HTTP ${status} for ${u.pathname}${hint}`));
        return;
      }
      const declared = Number(res.headers['content-length'] ?? 0);
      if (declared > o.maxBytes) {
        req.destroy();
        done(new UpdateError(`${u.pathname}: too large (${declared} bytes, cap ${o.maxBytes})`));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      res.on('data', (c: Buffer) => {
        total += c.length;
        if (total > o.maxBytes) {
          req.destroy();
          done(new UpdateError(`${u.pathname}: too large (over ${o.maxBytes} bytes)`));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => done(null, Buffer.concat(chunks)));
      res.on('error', (e) => done(new UpdateError(`download failed: ${e.message}`)));
      res.on('aborted', () => done(new UpdateError('download aborted')));
    });
    req.on('error', (e) => done(new UpdateError(`network error: ${e.message}`)));
    req.end();
    timer = setTimeout(() => {
      req.destroy();
      done(new UpdateError(`timed out after ${Math.round(o.timeoutMs / 1000)}s`));
    }, o.timeoutMs);
  });
}

// ---------- release (GitHub Releases API) ----------

export interface ReleaseAsset { name: string; url: string; size?: number }
export interface Release {
  version: string;                         // tag_name without the leading "v"
  notes: string;                           // first ~1200 chars of the release body
  headline: string;                        // first non-empty body line, markdown stripped
  assets: Record<string, ReleaseAsset>;    // by asset name
}

// Drop the release-page install footer (see INSTALL_MARKER): it is for people
// reading the GitHub release, not for update notices.
export function stripInstallFooter(body: string): string {
  const i = body.indexOf(INSTALL_MARKER);
  return i === -1 ? body : body.slice(0, i);
}

// "**A smoother install.**" -> "A smoother install." One line, plain text.
export function releaseHeadline(body: unknown): string {
  if (typeof body !== 'string') return '';
  for (const raw of stripInstallFooter(body).split(/\r?\n/)) {
    const line = raw
      .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+)/, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__|\*|_|`|~~)/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (line) return line.length > HEADLINE_MAX_CHARS ? line.slice(0, HEADLINE_MAX_CHARS - 1).trimEnd() + '…' : line;
  }
  return '';
}

// First ~1200 chars of the release body, cut at a line break when possible.
export function releaseNotes(body: unknown, max: number = NOTES_MAX_CHARS): string {
  if (typeof body !== 'string') return '';
  const t = stripInstallFooter(body).replace(/\r\n/g, '\n').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const nl = cut.lastIndexOf('\n');
  return (nl > max * 0.6 ? cut.slice(0, nl) : cut).trimEnd() + '\n…';
}

// True when `raw` stays under `prefix` after URL normalisation. The URL parser collapses
// `..`, `%2e%2e` and backslashes, so a raw startsWith would let a path climb out of the
// pinned repo; such spellings are refused outright and the parsed form is what is compared.
// Case-insensitive: GitHub owner and repo names are, so a re-cased repo keeps its assets.
function underPrefix(raw: string, prefix: string): boolean {
  if (/%2e|\.\.|\\/i.test(raw)) return false;
  try { return new URL(raw).href.toLowerCase().startsWith(prefix.toLowerCase()); } catch { return false; }
}

// `downloadPrefix` (see downloadPrefixFor): when set, an asset whose download URL is not
// under it is treated as absent, so a release cannot point the updater at another repo.
// Dropped assets are logged once per parse, by NAME only (the URL text comes from the
// release and is not ours to echo), so a later "missing asset" error is diagnosable.
export function parseRelease(buf: Buffer, downloadPrefix: string | null = null): Release {
  let j: any;
  try { j = JSON.parse(buf.toString('utf8')); } catch { throw new UpdateError('the releases API did not return valid JSON'); }
  if (!j || typeof j !== 'object') throw new UpdateError('the releases API returned an unexpected shape');
  if (j.draft === true || j.prerelease === true) throw new UpdateError('the latest release is a draft or prerelease; ignoring it');
  const tag = typeof j.tag_name === 'string' ? j.tag_name.replace(/^v/, '') : '';
  if (!isSemver(tag)) throw new UpdateError('the latest release has no valid version tag');
  const assets: Record<string, ReleaseAsset> = {};
  const dropped: string[] = [];
  const list = Array.isArray(j.assets) ? j.assets : [];
  if (list.length > MAX_ASSETS) throw new UpdateError('the latest release lists too many assets');
  for (const a of list) {
    if (!a || typeof a.name !== 'string' || typeof a.browser_download_url !== 'string') continue;
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(a.name)) continue;
    if (downloadPrefix && !underPrefix(a.browser_download_url, downloadPrefix)) { dropped.push(a.name); continue; }
    assets[a.name] = { name: a.name, url: a.browser_download_url, size: typeof a.size === 'number' ? a.size : undefined };
  }
  if (dropped.length) logErr(`update: ignored release asset(s) whose download URL is outside this build's release repo: ${dropped.join(', ')}`);
  return { version: tag, notes: releaseNotes(j.body), headline: releaseHeadline(j.body), assets };
}

// `get` is a test seam (a fake transport); production always uses httpGet.
export async function fetchRelease(api: string = releasesApi(), get: typeof httpGet = httpGet): Promise<Release> {
  const buf = await get(api, {
    maxBytes: RELEASE_MAX_BYTES,
    timeoutMs: MANIFEST_TIMEOUT_MS,
    headers: { accept: 'application/vnd.github+json' },
  });
  return parseRelease(buf, downloadPrefixFor(api));
}

// SHA256SUMS.txt: standard `<64 hex>  <name>` lines (`sha256sum` / `shasum -a 256`
// output; a `*` before the name marks binary mode). Conflicting duplicates abort.
export function parseSums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64}) [ *]?(\S+)$/.exec(line.trim());
    if (!m) continue;
    const name = m[2], hash = m[1].toLowerCase();
    if (out.has(name) && out.get(name) !== hash) throw new UpdateError(`SHA256SUMS.txt lists ${name} twice with different hashes`);
    out.set(name, hash);
  }
  return out;
}

// ---------- install source (release vs git clone) ----------

export type InstallSource = 'release' | 'clone';
export interface InstallRecord { source: InstallSource; version: string }

function installRecordPath() { return join(gripHome(), 'install.json'); }

// 'clone' when `dir` sits inside a git work tree (a `.git` dir or file, as in
// worktrees, anywhere above it). Otherwise 'release' (an extracted grip-install.zip).
export function detectInstallSource(dir: string): InstallSource {
  let d = resolve(dir);
  for (;;) {
    if (existsSync(join(d, '.git'))) return 'clone';
    const up = dirname(d);
    if (up === d) return 'release';
    d = up;
  }
}

export function writeInstallRecord(source: InstallSource, version: string): void {
  mkdirSync(gripHome(), { recursive: true });
  atomicWrite(installRecordPath(), Buffer.from(JSON.stringify({ source, version }, null, 2) + '\n'));
}

// A missing or unreadable record (an install from before 0.8) counts as 'release'.
export function readInstallRecord(): InstallRecord {
  try {
    const j = JSON.parse(readFileSync(installRecordPath(), 'utf8'));
    return { source: j?.source === 'clone' ? 'clone' : 'release', version: typeof j?.version === 'string' ? j.version : '' };
  } catch { return { source: 'release', version: '' }; }
}

// Bundles are not committed: after the pull the clone must rebuild before installing.
export const CLONE_NEXT_STEPS = ['git pull', 'npm run build', 'node bridge/install.mjs'];

// ---------- compatibility (bridge <-> plugin) ----------

// What we know about one connected plugin window (a PluginBridge snapshot row).
export interface PluginInfo {
  sessionId?: string;
  pluginVersion?: string | null;
  fileName?: string;
  fileKey?: string | null;
  wsReady?: boolean;
  hello?: boolean;               // false until the plugin's hello arrived (version not known yet)
  minBridge?: string | null;     // the plugin says: I need a bridge >= this
  protocol?: number | null;      // the plugin's protocol integer (absent: a plugin that predates it)
  minBridgeProtocol?: number | null;   // the plugin says: I need a bridge protocol >= this
}

export function pluginInfos(bridge: { snapshot(): { plugins: any[] } }): PluginInfo[] {
  return bridge.snapshot().plugins.map((p) => ({
    sessionId: p.sessionId, pluginVersion: p.pluginVersion, fileName: p.fileName, fileKey: p.fileKey, wsReady: p.wsReady, hello: p.hello, minBridge: p.minBridge,
    protocol: p.protocol ?? null, minBridgeProtocol: p.minBridgeProtocol ?? null,
  }));
}

// A window that is open and has said hello. (A socket that has not helloed yet
// is a moment away from being known; it must not flip the signal back and forth.)
function connectedPlugins(plugins: PluginInfo[] | null | undefined): PluginInfo[] {
  return (plugins ?? []).filter((p) => p.wsReady !== false && p.hello !== false);
}

export type PluginVerdict =
  | { kind: 'ok'; stale?: string[] }             // >=1 compatible plugin; `stale` = other windows that are too old
  | { kind: 'incompatible'; reason: string }     // connected plugins exist but none is new enough for this release
  | { kind: 'unverifiable'; reason: string };    // no connected plugin to check against

// Why ONE plugin window cannot work with this release (null = it can). When the
// release names a minimum plugin protocol (compat.json minPluginProtocol) and the
// plugin reports its protocol integer, that integer decides. Otherwise (a plugin
// that predates the integer, or a release that does not name one) the version
// rule: unknown version = incompatible.
export function pluginIncompatibility(minPlugin: string, latest: string, p: PluginInfo, minProtocol?: number | null): string | null {
  const where = p.fileName ? ` in "${p.fileName}"` : '';
  if (minProtocol != null && typeof p.protocol === 'number') {
    if (p.protocol >= minProtocol) return null;
    return `plugin ${p.pluginVersion ?? '?'}${where} speaks protocol ${p.protocol} but ${latest} needs protocol >= ${minProtocol}; update the Grip plugin in Figma first`;
  }
  const v = p.pluginVersion;
  if (!isSemver(v)) {
    return `a Grip plugin${where} did not report a version, so it cannot be verified against ${latest} (needs >=${minPlugin}); update the Grip plugin in Figma first`;
  }
  if (compareSemver(v, minPlugin) < 0) {
    return `plugin ${v}${where} is older than ${latest} requires (>=${minPlugin}); update the Grip plugin in Figma first`;
  }
  return null;
}

// The rule (per plugin window): the update is offered to, and can be installed
// from, a window whose plugin has a KNOWN version >= minPlugin. A window whose
// plugin is too old is never signalled and never blocks the others; it is
// reported in `stale` (after an update such a window needs its plugin updated
// in Figma before it works again). Nothing compatible connected = no signal.
export function checkPluginCompat(minPlugin: string, latest: string, plugins: PluginInfo[] | null | undefined, minProtocol?: number | null): PluginVerdict {
  const live = connectedPlugins(plugins);
  if (live.length === 0) {
    return { kind: 'unverifiable', reason: 'no Grip plugin is connected, so compatibility cannot be verified; open the Grip plugin in Figma first' };
  }
  const stale: string[] = [];
  let ok = 0;
  for (const p of live) {
    const why = pluginIncompatibility(minPlugin, latest, p, minProtocol);
    if (why) stale.push(why); else ok++;
  }
  if (ok === 0) return { kind: 'incompatible', reason: stale[0] };
  return stale.length ? { kind: 'ok', stale } : { kind: 'ok' };
}

export interface UpdateSignal { signal: boolean; blockedReason?: string; staleWindows?: string[] }

// THE single decision for every signalling surface (the purple strip, the agent
// notices, grip_health.update): signal only when an update is available AND at
// least one plugin is connected AND every connected plugin is compatible. A
// release whose signature is missing/invalid, or whose compat.json is
// missing/unverifiable, is never signalled (fail closed). `blockedReason` explains a withheld signal (only set when an update
// is available).
export function updateSignal(state: UpdateState | null | undefined, plugins: PluginInfo[] | null | undefined): UpdateSignal {
  if (!state || !state.available || !state.latest) return { signal: false };
  if (state.signatureError) {
    return { signal: false, blockedReason: `Grip ${state.latest} is not offered: ${state.signatureError}` };
  }
  if (!state.minPlugin) {
    return { signal: false, blockedReason: `Grip ${state.latest} has no verified compatibility info (compat.json)${state.compatError ? ': ' + state.compatError : ''}, so it is not offered` };
  }
  const v = checkPluginCompat(state.minPlugin, state.latest, plugins, state.minPluginProtocol);
  return v.kind === 'ok' ? { signal: true, ...(v.stale ? { staleWindows: v.stale } : {}) } : { signal: false, blockedReason: v.reason };
}

// Why ONE plugin window needs a NEWER bridge than this one (null = it does not).
// The mirror of pluginIncompatibility: when the plugin names a minimum bridge
// protocol (hello.minBridgeProtocol), that integer alone decides (this bridge
// always has PROTOCOL_VERSION), so a flavour bridge numbered below the shared
// MIN_BRIDGE_VERSION is not flagged. A plugin that predates the integer keeps the
// version rule (hello.minBridge). The single rule behind needsNewerBridge,
// bridgeStaleReason and the hello warning in ws-server.ts.
export function bridgeStaleFor(p: Pick<PluginInfo, 'pluginVersion' | 'fileName' | 'minBridge' | 'minBridgeProtocol'>): string | null {
  const where = p.fileName ? ` in "${p.fileName}"` : '';
  if (typeof p.minBridgeProtocol === 'number') {
    if (p.minBridgeProtocol <= PROTOCOL_VERSION) return null;
    return `plugin ${p.pluginVersion ?? '?'}${where} needs a Grip bridge with protocol >= ${p.minBridgeProtocol} but this bridge speaks protocol ${PROTOCOL_VERSION}: update the bridge`;
  }
  if (p.minBridge && isSemver(p.minBridge) && compareSemver(p.minBridge, BRIDGE_VERSION) > 0) {
    return `plugin ${p.pluginVersion ?? '?'}${where} needs Grip bridge >= ${p.minBridge} but this bridge is ${BRIDGE_VERSION}: update the bridge`;
  }
  return null;
}

function needsNewerBridge(p: PluginInfo): boolean {
  return bridgeStaleFor(p) !== null;
}

// The reverse direction (informational): a connected plugin that needs a NEWER
// bridge than this one. Then the bridge is the stale side, an update is recommended.
export function bridgeStaleReason(plugins: PluginInfo[] | null | undefined): string | undefined {
  for (const p of connectedPlugins(plugins)) {
    const why = bridgeStaleFor(p);
    if (why) return why;
  }
  return undefined;
}

// ---------- plugin copies the bridge can refresh itself ----------
//
// The release updater writes the plugin into ~/.grip/figma-plugin. A user who
// imported the plugin into Figma from some OTHER folder has a copy the updater
// never touched. Figma records every imported dev plugin (settings.json,
// `localFileExtensions`), so the bridge can find those copies and refresh them
// with the files it already installed and verified. A dev plugin reloads itself
// when its files change, so nothing else is needed afterwards. Only a user click
// triggers a refresh (the update click, or the strip's own "plugin copy" click).
// Safeguards: only folders whose manifest.json has Grip's plugin id; never a git
// checkout (a developer's own build output / tracked ui.html); only the three
// plugin files; never a downgrade; atomic writes; only the plugin list is read
// from Figma's settings.

const PLUGIN_VERSION_RE = /PLUGIN_VERSION\s*=\s*['"](\d+\.\d+\.\d+)['"]/;
const COPY_FILES = ['code.js', 'ui.html', 'manifest.json'] as const;
let installedPluginMemo: { path: string; mtime: number; version: string | null } | null = null;

function pluginVersionOf(codeJs: string): string | null {
  try { return PLUGIN_VERSION_RE.exec(readFileSync(codeJs, 'utf8'))?.[1] ?? null; } catch { return null; }
}

// The plugin version of the copy installed next to this bridge
// (~/.grip/figma-plugin/code.js), or null when there is none.
export function installedPluginVersion(): string | null {
  const path = join(gripHome(), 'figma-plugin', 'code.js');
  try {
    const mtime = statSync(path).mtimeMs;
    if (installedPluginMemo && installedPluginMemo.path === path && installedPluginMemo.mtime === mtime) return installedPluginMemo.version;
    const version = pluginVersionOf(path);
    installedPluginMemo = { path, mtime, version };
    return version;
  } catch { return null; }
}

export type CopySkip = 'git_checkout' | 'not_a_plain_copy' | 'unreadable' | 'write_failed';
export interface PluginCopy { dir: string; version: string | null; behind: boolean; skip?: CopySkip }

// Where Figma keeps its settings (null: unknown platform). GRIP_FIGMA_SETTINGS overrides (tests).
function figmaSettingsPath(): string | null {
  return liveIdentity().figmaSettingsPath ?? null;
}

export interface PluginCopies { known: boolean; copies: PluginCopy[] }
let copiesMemo: { at: number; key: string; value: PluginCopies } | null = null;
const COPIES_TTL_MS = 5000;

// Every imported dev copy of THIS plugin that Figma knows about. `known:false` =
// Figma's list could not be read (so "no copies" proves nothing).
export function findPluginCopies(fresh = false): PluginCopies {
  const settings = figmaSettingsPath();
  const home = join(gripHome(), 'figma-plugin');
  const key = `${settings}|${home}`;
  if (!fresh && copiesMemo && copiesMemo.key === key && Date.now() - copiesMemo.at < COPIES_TTL_MS) return copiesMemo.value;
  const value = scanPluginCopies(settings, home);
  copiesMemo = { at: Date.now(), key, value };
  return value;
}

function readJson(path: string): any { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } }

function scanPluginCopies(settingsPath: string | null, home: string): PluginCopies {
  const none: PluginCopies = { known: false, copies: [] };
  const installed = installedPluginVersion();
  // The id is the flavour's own, never read from disk: an edited ~/.grip manifest must not
  // be able to aim the updater at another plugin's folder.
  const myId = FLAVOUR.pluginId;
  if (!settingsPath || !installed || typeof myId !== 'string' || !myId) return none;
  const settings = readJson(settingsPath);
  if (!settings || !Array.isArray(settings.localFileExtensions)) return none;   // only this one list is ever read
  let homeReal = home;
  try { homeReal = realpathSync(home); } catch { /* keep as is */ }
  const seen = new Set<string>();
  const copies: PluginCopy[] = [];
  for (const e of settings.localFileExtensions) {
    const mp = e?.fileMetadata?.type === 'manifest' && typeof e.manifestPath === 'string' ? e.manifestPath : null;
    if (!mp || basename(mp) !== 'manifest.json' || !isAbsolute(mp)) continue;
    const dir = dirname(mp);
    if (seen.has(dir)) continue;
    seen.add(dir);
    const manifest = readJson(mp);
    if (!manifest) { if (e.lastKnownPluginId === myId) copies.push({ dir, version: null, behind: false, skip: 'unreadable' }); continue; }
    if (manifest.id !== myId) continue;                              // some other plugin
    let real = dir;
    try { real = realpathSync(dir); } catch { /* keep as is */ }
    if (real === homeReal) continue;                                  // the copy the updater already owns
    const version = pluginVersionOf(join(dir, 'code.js'));
    const behind = version !== null && compareSemver(version, installed) < 0;
    let skip: CopySkip | undefined;
    if (detectInstallSource(dir) === 'clone') skip = 'git_checkout';
    else if (manifest.main !== 'code.js' || manifest.ui !== 'ui.html' || version === null || !existsSync(join(dir, 'ui.html'))) skip = 'not_a_plain_copy';
    copies.push({ dir, version, behind, ...(skip ? { skip } : {}) });
  }
  return { known: true, copies };
}

// Right after a refresh, a dev window that still runs the old code is about to hot-swap: no notice meanwhile.
let lastSyncAt = 0;
const SYNC_GRACE_MS = 60_000;
function recentlySynced(): boolean { return lastSyncAt > 0 && Date.now() - lastSyncAt < SYNC_GRACE_MS; }

export interface CopySyncResult { updated: string[]; skipped: Array<{ dir: string; reason: CopySkip }> }

// Refresh every imported copy that is behind, from the verified files in
// ~/.grip/figma-plugin. Never throws; never touches a skipped folder.
export function syncPluginCopies(): CopySyncResult {
  const out: CopySyncResult = { updated: [], skipped: [] };
  const installed = installedPluginVersion();
  const src = join(gripHome(), 'figma-plugin');
  const { copies } = findPluginCopies(true);
  copiesMemo = null;
  let bufs: Array<[string, Buffer]> | null = null;
  try { bufs = installed ? COPY_FILES.map((f) => [f, readFileSync(join(src, f))] as [string, Buffer]) : null; } catch { bufs = null; }
  for (const c of copies) {
    if (c.skip) { out.skipped.push({ dir: c.dir, reason: c.skip }); continue; }
    if (!c.behind) continue;
    if (!bufs) { out.skipped.push({ dir: c.dir, reason: 'unreadable' }); continue; }
    try {
      // manifest last: a half-written folder keeps its old, matching manifest
      for (const [name, buf] of [...bufs].sort((a, b) => (a[0] === 'manifest.json' ? 1 : 0) - (b[0] === 'manifest.json' ? 1 : 0))) atomicWrite(join(c.dir, name), buf);
      out.updated.push(c.dir);
      lastSyncAt = Date.now();
      logErr(`update: refreshed the Grip plugin copy in ${c.dir} (${c.version} -> ${installed})`);
    } catch (err) {
      out.skipped.push({ dir: c.dir, reason: 'write_failed' });
      logErr(`update: could not refresh the plugin copy in ${c.dir}: ${(err as Error).message}`);
    }
  }
  return out;
}

// ---------- "Grip updated" confirmation ----------
//
// installUpdate leaves a small marker; the restarted bridge reads it and shows each
// open Grip window one toast (the plugin's own `notify`, so any plugin version
// gets it). The marker only counts for the version it announces and for ten minutes.

const UPDATE_MARKER_TTL_MS = 10 * 60 * 1000;
export interface UpdateMarker { version: string; from: string; at: string; refreshed: number }
function markerPath() { return join(gripHome(), 'update-done.json'); }

export function writeUpdateMarker(m: UpdateMarker): void {
  try { mkdirSync(gripHome(), { recursive: true }); atomicWrite(markerPath(), Buffer.from(JSON.stringify(m) + '\n')); } catch { /* advisory */ }
}

// The marker for THIS running bridge, or null (none, other version, too old). A stale one is removed.
export function readUpdateMarker(now: number = Date.now()): UpdateMarker | null {
  const j = readJson(markerPath());
  if (!j) return null;
  const at = typeof j.at === 'string' ? Date.parse(j.at) : NaN;
  const fresh = Number.isFinite(at) && now - at < UPDATE_MARKER_TTL_MS && now >= at - 60_000;
  if (!fresh || j.version !== BRIDGE_VERSION || typeof j.from !== 'string') {
    if (!fresh) { try { rmSync(markerPath(), { force: true }); } catch { /* ignore */ } }
    return null;
  }
  return { version: j.version, from: j.from, at: j.at, refreshed: Number.isFinite(j.refreshed) ? Number(j.refreshed) : 0 };
}

// ---------- the agent helps only when nothing else can ----------
//
// The bridge owns what it can (the update, the ~/.grip plugin, imported copies,
// via the strip). An agent notice exists only for what is left: a copy it will
// not write (git checkout, not a plain copy), a plugin whose origin it cannot
// tell, and a bridge that cannot update itself (developer install, or no update
// offered). Nothing here installs or changes anything.

export interface PluginBehind { window: string; running: string; installed: string }

// Open windows whose plugin is older than the copy installed next to this bridge.
export function pluginsBehind(plugins: PluginInfo[] | null | undefined): PluginBehind[] {
  const installed = installedPluginVersion();
  if (!installed) return [];
  const out: PluginBehind[] = [];
  for (const p of connectedPlugins(plugins)) {
    if (isSemver(p.pluginVersion) && compareSemver(p.pluginVersion, installed) < 0) {
      out.push({ window: p.fileName || 'an open file', running: p.pluginVersion, installed });
    }
  }
  return out;
}

// An imported copy that is still behind (or whose version cannot be read): somebody has to update it.
// A copy that is already current needs nothing, whatever it is.
export function copyNeedsWork(c: PluginCopy): boolean { return c.behind || (c.skip !== undefined && c.version === null); }

export interface HelpNotice { kind: 'plugin' | 'bridge'; key: string; text: string }

const SKIP_WHY: Record<CopySkip, string> = {
  git_checkout: 'a git checkout (the bridge never writes into one): there run git pull and npm run build',
  not_a_plain_copy: 'not a plain copy of the plugin files',
  unreadable: 'unreadable',
  write_failed: 'not writable',
};

function pluginFolder(): string { return join(gripHome(), 'figma-plugin'); }

// A plugin window is behind and the bridge cannot refresh it: tell the agent what is left.
export function pluginHelpText(behind: PluginBehind[], blocked: PluginCopy[], known = false): string {
  const manifest = join(pluginFolder(), 'manifest.json');
  const list = behind.map((b) => `"${b.window}" runs ${b.running}`).join('; ');
  const head = `The Grip plugin in Figma is behind the copy installed next to this bridge (${behind[0].installed}): ${list}. It works, but it is missing fixes. ` +
    `Mention it to the user once and offer to help; do not change anything on your own. `;
  if (known && !blocked.length) {
    return head + `No imported copy of Grip that Figma lists is behind, so this window most likely runs the Figma Community plugin (or has not been reloaded): ` +
      `Figma loads the newest published version the next time the plugin is opened, and a running plugin can never swap its own code. Grip also shows a notice inside Figma. ` +
      `If the user asks: close the Grip plugin and open it again; if Figma has not published the newer version yet (it reviews updates), there is nothing to do.`;
  }
  if (blocked.length) {
    return head + `The bridge refreshes imported plugin copies by itself, but not these: ` +
      blocked.map((c) => `${c.dir} (${SKIP_WHY[c.skip!]})`).join('; ') +
      `. Alternatively they can import ${manifest} in Figma (Plugins > Development > Import plugin from manifest...) and use that copy, which the bridge keeps current.`;
  }
  return head + `The bridge could not tell where this plugin was imported from. If they imported it from a folder, in Figma use Plugins > Development > Import plugin from manifest... ` +
    `and choose ${manifest}, a copy the bridge keeps current. If it came from Figma Community, Figma updates it by itself and there is nothing to do.`;
}

// A plugin needs a newer bridge and the bridge cannot update itself right now.
export function bridgeHelpText(reason: string): string {
  const clone = readInstallRecord().source === 'clone';
  return `${reason}. Mention it to the user once and offer to help. ` +
    (clone
      ? `This bridge is a developer install, so it does not update itself: in their Grip checkout run git pull, npm run build and node bridge/install.mjs (with their OK).`
      : `No update is being offered. Call grip_update {action:'check'} to see why; if that does not help, ask them to tell their agent: Install Grip from ${FLAVOUR.installUrl}.`);
}

// The notices an agent should be told about now (the caller throttles each with
// claimNotice(key), like the update notice).
export function helpNotices(plugins: PluginInfo[] | null | undefined): HelpNotice[] {
  const out: HelpNotice[] = [];
  const behind = pluginsBehind(plugins);
  if (behind.length) {
    const c = findPluginCopies();
    const refreshable = c.copies.some((x) => !x.skip && x.behind);   // the strip offers it: the user clicks, no agent
    const blocked = c.copies.filter((x) => !!x.skip && copyNeedsWork(x));   // a copy the bridge will not write AND that is still behind
    // Nothing to refresh and nothing blocked: reopening is what is left (a Community plugin, or a window not yet reloaded).
    // Right after a refresh a dev window is about to hot-swap, so say nothing for a minute.
    if (!refreshable && !recentlySynced()) {
      out.push({ kind: 'plugin', key: `plugin-behind:${behind[0].installed}`, text: pluginHelpText(behind, blocked, c.known) });
    }
  }
  const stale = bridgeStaleReason(plugins);
  if (stale) {
    const s = updatesDisabled() ? null : getUpdateState();
    const offered = !!s && updateSignal(s, plugins).signal && readInstallRecord().source !== 'clone';
    if (!offered) {
      const need = (plugins ?? []).map((p) => p.minBridge).filter((v): v is string => !!v && isSemver(v)).sort(compareSemver).pop()
        ?? `protocol-${Math.max(0, ...(plugins ?? []).map((p) => (typeof p.minBridgeProtocol === 'number' ? p.minBridgeProtocol : 0)))}`;
      out.push({ kind: 'bridge', key: `bridge-behind:${need}`, text: bridgeHelpText(stale) });
    }
  }
  return out;
}

// The flavour of every release made before compat.json carried a claim: the public one.
export const UNCLAIMED_FLAVOUR = 'grip';

// compat.json: { "version", "minPlugin", "flavour", "protocol", "minPluginProtocol" },
// generated by scripts/package-release.mjs from types.ts and flavour/flavour.json.
// Verified against SHA256SUMS.txt (itself signature-verified) before it is believed,
// so `flavour` is a signed claim: a release for another flavour throws
// flavour_mismatch (a trust failure, see isTrustFailure), and a compat.json without
// the field claims the public flavour, never this build's. A missing
// minPluginProtocol gives null (the plugin version rule decides).
export async function fetchCompat(rel: Release, sums: Map<string, string>): Promise<{ minPlugin: string; minPluginProtocol: number | null }> {
  const fail = (why: string): never => {
    throw new UpdateError(`release ${rel.version} has no verifiable compatibility info (${ASSET_COMPAT}): ${why}`, 'compat_unverified');
  };
  const want = sums.get(ASSET_COMPAT);
  if (!want) return fail(`${ASSET_SUMS} does not list it`);
  if (!rel.assets[ASSET_COMPAT]) return fail('the release has no such asset');
  let buf: Buffer;
  try { buf = await httpGet(rel.assets[ASSET_COMPAT].url, { maxBytes: COMPAT_MAX_BYTES, timeoutMs: MANIFEST_TIMEOUT_MS }); }
  catch (err) { return fail((err as Error).message); }
  if (sha256(buf) !== want) return fail(`it does not match ${ASSET_SUMS}`);
  let j: any;
  try { j = JSON.parse(buf.toString('utf8')); } catch { return fail('it is not valid JSON'); }
  if (!j || typeof j !== 'object') return fail('it is not a JSON object');
  // The claim first: a release for another flavour is refused as such, before any
  // other check could turn it into a compat failure that --force overrides.
  const claimed = j.flavour ?? UNCLAIMED_FLAVOUR;
  if (claimed !== FLAVOUR.slug) {
    const shown = typeof claimed === 'string' ? claimed.replace(/[^\x20-\x7e]/g, '').slice(0, 40) : '?';
    throw new UpdateError(
      `release ${rel.version} is for the "${shown}" flavour${j.flavour === undefined ? ' (its compat.json makes no flavour claim)' : ''}, not this ${FLAVOUR.displayName} build ("${FLAVOUR.slug}"). Do not install it. Nothing was changed.`,
      'flavour_mismatch',
    );
  }
  if (j.version !== rel.version) return fail(`it describes version ${j?.version ?? '?'}, not ${rel.version}`);
  if (!isSemver(j.minPlugin)) return fail('minPlugin is not a version');
  if (compareSemver(j.minPlugin, rel.version) > 0) return fail('minPlugin is newer than the release itself');
  let minPluginProtocol: number | null = null;
  if (j.minPluginProtocol !== undefined) {
    if (!Number.isSafeInteger(j.minPluginProtocol) || j.minPluginProtocol < 0) return fail('minPluginProtocol is not a whole number');
    minPluginProtocol = j.minPluginProtocol;
  }
  return { minPlugin: j.minPlugin, minPluginProtocol };
}

// SHA256SUMS.txt, trusted only after its signature verified: not one line of it
// is parsed before that. Throws UpdateError code signature_missing /
// signature_invalid; callers turn those into state.signatureError (no CLI flag
// overrides them).
async function fetchSums(rel: Release): Promise<Map<string, string>> {
  const sums = await downloadAsset(rel, ASSET_SUMS, SUMS_MAX_BYTES);
  if (!rel.assets[ASSET_SUMS_SIG]) {
    throw new UpdateError(
      `release ${rel.version} is unsigned: it has no ${ASSET_SUMS_SIG} asset (it may still be uploading, or it was not made by the Grip release process). Nothing was changed.`,
      'signature_missing',
    );
  }
  const sig = await downloadAsset(rel, ASSET_SUMS_SIG, SIG_MAX_BYTES);
  if (!verifySumsSignature(sums, sig)) {
    throw new UpdateError(
      `the signature of release ${rel.version} (${ASSET_SUMS_SIG}) does not verify against the Grip release key built into this bridge. The release was not made by the Grip release process, or it was altered. Do not install it. Nothing was changed.`,
      'signature_invalid',
    );
  }
  return parseSums(sums.toString('utf8'));
}

// ---------- check + state ----------

export interface UpdateState {
  current: string;
  latest: string | null;
  available: boolean;
  checkedAt: string | null;   // ISO timestamp of the last SUCCESSFUL check
  headline?: string | null;   // one-line summary of the latest release (from its notes)
  notes?: string | null;      // first ~1200 chars of the latest release's notes
  // The oldest Figma plugin the latest release works with (its compat.json,
  // verified against SHA256SUMS.txt). null/absent = unknown: the release has no
  // verifiable compat.json, so it is neither signalled nor installable.
  minPlugin?: string | null;
  // The oldest plugin protocol it works with (compat.json minPluginProtocol); null =
  // not named, the minPlugin version rule decides.
  minPluginProtocol?: number | null;
  compatError?: string | null;
  // Set when the latest release fails a trust check (isTrustFailure): its
  // SHA256SUMS.txt.sig is missing or does not verify against the pinned release key,
  // or its signed compat.json is for another flavour. The release is then neither
  // signalled nor installable, and no flag overrides that. Implies minPlugin null.
  signatureError?: string | null;
  trustCode?: string | null;  // the UpdateError code behind signatureError (signature_* | flavour_mismatch)
  error?: string;             // set when the latest attempt failed (state is carried over)
}

let state: UpdateState | null = null;
const listeners = new Set<(s: UpdateState) => void>();
const noticeMemo = new Map<string, number>();   // version -> ms when an agent notice was last claimed

export function getUpdateState(): UpdateState | null { return state; }
export function onUpdateState(fn: (s: UpdateState) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
export function resetUpdateState(): void { state = null; noticeMemo.clear(); lastSyncAt = 0; }

function setState(next: UpdateState) {
  const changed = !state || state.available !== next.available || state.latest !== next.latest
    || (state.minPlugin ?? null) !== (next.minPlugin ?? null)
    || (state.minPluginProtocol ?? null) !== (next.minPluginProtocol ?? null)
    || (state.signatureError ?? null) !== (next.signatureError ?? null);
  state = next;
  if (changed) {
    for (const fn of listeners) {
      try { fn(next); } catch (err) { logErr(`update: listener failed: ${(err as Error).message}`); }
    }
  }
}

function cachePath() { return join(gripHome(), 'update-check.json'); }
function readCacheFile(): any {
  try { return JSON.parse(readFileSync(cachePath(), 'utf8')); } catch { return null; }
}

function writeCache(s: UpdateState) {
  // Best effort, and never create ~/.grip just for a cache file (a daemon run
  // from a git clone, without the installer, shouldn't sprout the directory).
  try {
    if (!existsSync(gripHome())) return;
    writeFileSync(cachePath(), JSON.stringify({
      current: s.current, latest: s.latest, available: s.available, checkedAt: s.checkedAt,
      headline: s.headline ?? null, notes: s.notes ?? null, minPlugin: s.minPlugin ?? null,
      minPluginProtocol: s.minPlugin ? (s.minPluginProtocol ?? null) : null,
      // minPlugin is only ever set after a verified signature; an older bridge's cache lacks this flag and is not believed
      signed: !!s.minPlugin,
      // the notice throttle lives in the same file: carry it over
      notifiedAt: readCacheFile()?.notifiedAt ?? {},
    }, null, 2));
  } catch { /* cache is best-effort */ }
}

// A cached answer, re-evaluated against the CURRENT version (the cache may
// have been written by an older bridge that has since been updated).
export function readCache(): UpdateState | null {
  const j = readCacheFile();
  if (!isSemver(j?.latest)) return null;
  return {
    current: BRIDGE_VERSION,
    latest: j.latest,
    available: compareSemver(j.latest, BRIDGE_VERSION) > 0,
    checkedAt: typeof j.checkedAt === 'string' ? j.checkedAt : null,
    headline: typeof j.headline === 'string' ? j.headline : null,
    notes: typeof j.notes === 'string' ? j.notes : null,
    minPlugin: isSemver(j.minPlugin) && j.signed === true ? j.minPlugin : null,
    minPluginProtocol: isSemver(j.minPlugin) && j.signed === true && Number.isSafeInteger(j.minPluginProtocol) && j.minPluginProtocol >= 0 ? j.minPluginProtocol : null,
  };
}

// Agent notices (session instructions + first tool result) for a given `latest`
// are shown at most once per 3 days ACROSS sessions: claim the slot. Returns
// true when the caller may show the notice now (and records it, in memory and in
// ~/.grip/update-check.json `notifiedAt`). The purple strip is not throttled;
// grip_update {check} and grip_health always report the truth.
export function claimNotice(version: string, now: number = Date.now()): boolean {
  let last = noticeMemo.get(version) ?? 0;
  const disk = readCacheFile()?.notifiedAt?.[version];
  if (typeof disk === 'string' && !Number.isNaN(Date.parse(disk))) last = Math.max(last, Date.parse(disk));
  if (last && now - last < NOTICE_INTERVAL_MS) return false;
  noticeMemo.set(version, now);
  try {
    if (existsSync(gripHome())) {
      const j = readCacheFile() ?? {};
      const notifiedAt: Record<string, string> = { ...(j.notifiedAt ?? {}), [version]: new Date(now).toISOString() };
      const keep = Object.entries(notifiedAt).sort((a, b) => (a[1] < b[1] ? 1 : -1)).slice(0, 10);
      writeFileSync(cachePath(), JSON.stringify({ ...j, notifiedAt: Object.fromEntries(keep) }, null, 2));
    }
  } catch { /* best-effort */ }
  return true;
}

// Release -> state, including the compat.json gate (only fetched when the
// release is newer than this bridge). A missing/invalid signature or a
// missing/unverifiable compat.json does not throw: the state says available:true,
// minPlugin:null and signatureError / compatError, which updateSignal() turns
// into "not offered".
async function stateFromRelease(r: Release): Promise<UpdateState> {
  const available = compareSemver(r.version, BRIDGE_VERSION) > 0;
  let minPlugin: string | null = null;
  let minPluginProtocol: number | null = null;
  let compatError: string | null = null;
  let signatureError: string | null = null;
  let trustCode: string | null = null;
  if (available) {
    try { ({ minPlugin, minPluginProtocol } = await fetchCompat(r, await fetchSums(r))); }
    catch (err) {
      const msg = (err as Error).message;
      if (err instanceof UpdateError && isTrustFailure(err.code)) { signatureError = msg; trustCode = err.code!; } else compatError = msg;
      logErr(`update: ${r.version} will not be offered: ${msg}`);
    }
  }
  return {
    current: BRIDGE_VERSION,
    latest: r.version,
    available,
    checkedAt: new Date().toISOString(),
    headline: r.headline || null,
    notes: r.notes || null,
    minPlugin,
    minPluginProtocol,
    compatError,
    signatureError,
    trustCode,
  };
}

// One network check. Never throws: on any failure it logs one stderr line and
// returns the previous state (plus `error`). Does NOT consult
// GRIP_NO_UPDATE_CHECK — callers decide whether a check is allowed.
export async function checkForUpdate(api: string = releasesApi()): Promise<UpdateState> {
  try {
    const r = await fetchRelease(api);
    const next = await stateFromRelease(r);
    setState(next);
    writeCache(next);
    if (next.available) logErr(`update: Grip ${next.latest} is available (running ${BRIDGE_VERSION})`);
    return next;
  } catch (err) {
    const msg = (err as Error).message;
    logErr(`update: check failed (${msg})`);
    return {
      current: BRIDGE_VERSION,
      latest: state?.latest ?? null,
      available: state?.available ?? false,
      checkedAt: state?.checkedAt ?? null,
      headline: state?.headline ?? null,
      notes: state?.notes ?? null,
      minPlugin: state?.minPlugin ?? null,
      minPluginProtocol: state?.minPluginProtocol ?? null,
      compatError: state?.compatError ?? null,
      signatureError: state?.signatureError ?? null,
      trustCode: state?.trustCode ?? null,
      error: msg,
    };
  }
}

// Daemon-side scheduler: load the cache straight away (so notices work before
// the first network check), then check after a delay (a cold start is never
// slowed) and again every 24h. Timers are unref'd. Returns a stop function.
export function startUpdateChecks(o: { delayMs?: number; intervalMs?: number } = {}): () => void {
  if (updatesDisabled()) {
    logErr('update: automatic checks disabled (GRIP_NO_UPDATE_CHECK)');
    return () => {};
  }
  const cached = readCache();
  if (cached) setState(cached);
  const run = () => { void checkForUpdate(); };
  const t = setTimeout(run, o.delayMs ?? CHECK_DELAY_MS);
  const i = setInterval(run, o.intervalMs ?? CHECK_INTERVAL_MS);
  t.unref();
  i.unref();
  return () => { clearTimeout(t); clearInterval(i); };
}

// ---------- notices ----------

// The headline is remote text: quoted, one line, length-capped (see releaseHeadline).
function headlineClause(s: UpdateState): string {
  return s.headline ? ` What's new, per the release notes: "${s.headline}".` : '';
}
export function updateNoticeText(s: UpdateState): string {
  return `Grip update available: ${s.current} → ${s.latest}.${headlineClause(s)} Tell the user and ask whether they want to update. ` +
    `Do NOT install it on your own: only after the user explicitly says yes, call grip_update {action:'install', version:'${s.latest}'}.`;
}
export function updateInstructionsParagraph(s: UpdateState): string {
  return `\n\nA Grip update is available (${s.current} → ${s.latest}).${headlineClause(s)} Mention it to the user once, at a natural moment, ` +
    `and ask if they want it. Never install without their explicit yes; if they agree, call grip_update {action:'install', version:'${s.latest}'}.`;
}

// ---------- install ----------

export interface InstallOptions {
  api?: string;
  // The version the user was shown. The update installs ONLY if the latest
  // release still equals it (else status 'version_changed').
  version: string;
  // CLI only (--force): also overwrite a clone install, and install when
  // compat.json is missing/unverifiable or no plugin can be checked.
  force?: boolean;
  // Plugin windows connected NOW (pluginInfos(bridge), or the status file's list
  // for the CLI). null/[] = nothing to verify against.
  plugins?: PluginInfo[] | null;
  // CLI --yes: the user accepted that no plugin could be checked.
  acceptUnverified?: boolean;
  // Called once every check passed and BEFORE anything is downloaded: ask the
  // person for the final yes. false -> status 'declined', nothing happens.
  confirm?: (info: { from: string; to: string; headline: string | null }) => Promise<boolean>;
}

export interface InstallResult {
  status: 'updated' | 'up_to_date' | 'already_installing' | 'clone_install'
    | 'version_changed' | 'incompatible_plugin' | 'plugins_unverifiable' | 'declined';
  from?: string;
  to?: string;
  home?: string;
  pluginFilesWritten?: string[];
  restart?: 'scheduled' | 'not_managed' | 'none';
  next?: string[];            // clone_install: the commands to run instead
  reason?: string;            // incompatible_plugin / plugins_unverifiable: why
  staleWindows?: string[];    // installed anyway: other open windows whose plugin is too old for the new bridge
  headline?: string | null;   // version_changed: what the new release is
  notes?: string | null;
  compatWarning?: string;     // --force installed without a verified compat.json
  pluginCopies?: CopySyncResult;   // imported plugin copies outside ~/.grip: refreshed / left alone (and why)
}

let installing = false;

function atomicWrite(dest: string, data: Buffer, mode?: number) {
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, data, mode !== undefined ? { mode } : undefined);
    renameSync(tmp, dest);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

async function downloadAsset(rel: Release, name: string, cap: number): Promise<Buffer> {
  const a = rel.assets[name];
  if (!a) {
    throw new UpdateError(`release ${rel.version} has no ${name} asset yet. It may still be uploading; nothing was changed, retry in a few minutes.`);
  }
  try {
    return await httpGet(a.url, { maxBytes: cap, timeoutMs: DOWNLOAD_TIMEOUT_MS });
  } catch (err) {
    throw new UpdateError(`could not download ${name}: ${(err as Error).message}. Nothing was changed; try again in a few minutes.`);
  }
}

async function downloadVerified(rel: Release, name: string, sums: Map<string, string>): Promise<Buffer> {
  const want = sums.get(name);
  if (!want) throw new UpdateError(`${ASSET_SUMS} does not list ${name}; refusing to install. Nothing was changed.`);
  const buf = await downloadAsset(rel, name, FILE_MAX_BYTES);
  const size = rel.assets[name].size;
  if (size !== undefined && size !== buf.length) {
    throw new UpdateError(`${name} size mismatch (release says ${size}, got ${buf.length}); nothing was changed, retry in a few minutes.`);
  }
  if (sha256(buf) !== want) {
    throw new UpdateError(`${name} failed its sha256 check against ${ASSET_SUMS}. Nothing was changed; retry in a few minutes, and if it keeps failing do not install and report it.`);
  }
  return buf;
}

// Run the downloaded bridge ONCE with --selftest before it replaces anything:
// it must print exactly `grip-bridge <version> ok` and exit 0 within 10s
// (it binds no ports and touches no ~/.grip state). Written next to the target
// so it is the same kind of file in the same kind of place, and removed again.
async function selfTestBridge(buf: Buffer, home: string, version: string): Promise<void> {
  const tmp = join(home, `grip-bridge.selftest-${process.pid}-${Date.now()}.mjs`);
  writeFileSync(tmp, buf, { mode: 0o755 });
  try {
    const out = await new Promise<string>((res, rej) => {
      execFile(process.execPath, [tmp, '--selftest'], {
        timeout: selftestTimeoutMs(), encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024,
      }, (err, stdout, stderr) => {
        if (err) {
          // Node prints the uncaught error's own line before its stack and "Node.js vNN": prefer that one.
          const lines = String(stderr || err.message).split('\n').map((l) => l.trim()).filter(Boolean);
          const why = (err as any).killed
            ? `no answer within ${selftestTimeoutMs() < 1000 ? selftestTimeoutMs() + 'ms' : Math.round(selftestTimeoutMs() / 1000) + 's'}`
            : (lines.find((l) => /error/i.test(l)) ?? lines[0] ?? 'it exited with an error').slice(0, 160);
          rej(new UpdateError(`the downloaded bridge failed its self-test (${why}); nothing was changed.`, 'selftest_failed'));
        } else res(String(stdout));
      });
    });
    if (out.trim() !== `grip-bridge ${version} ok`) {
      throw new UpdateError(`the downloaded bridge failed its self-test (it reported "${out.trim().slice(0, 80)}", expected "grip-bridge ${version} ok"); nothing was changed.`, 'selftest_failed');
    }
  } finally {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
}

// The install routine shared by the plugin's update_request, the MCP tool and
// the CLI. Order: pin (the user must have seen THIS version) -> clone guard ->
// compat.json verified -> connected plugins compatible (re-verified NOW) ->
// everything downloaded + verified in memory -> new bridge self-tested -> only
// then writes (atomic per file). A failure at any point leaves ~/.grip untouched.
// Does not restart anything — see installAndScheduleRestart().
export async function installUpdate(o: InstallOptions): Promise<InstallResult> {
  if (installing) return { status: 'already_installing' };
  installing = true;
  try {
    const api = o.api ?? releasesApi();
    const rel = await fetchRelease(api).catch((err: Error) => {
      throw new UpdateError(`could not read the latest release: ${err.message}`);
    });
    const available = compareSemver(rel.version, BRIDGE_VERSION) > 0;
    if (!available) {
      // Keep the shared state honest even though this wasn't a scheduled check.
      setState({
        current: BRIDGE_VERSION, latest: rel.version, available, checkedAt: new Date().toISOString(),
        headline: rel.headline || null, notes: rel.notes || null, minPlugin: null, compatError: null, signatureError: null,
      });
      return { status: 'up_to_date', from: BRIDGE_VERSION, to: rel.version };
    }

    // Never update a developer install over the top of its clone: git pull does that.
    if (!o.force && readInstallRecord().source === 'clone') {
      return { status: 'clone_install', from: BRIDGE_VERSION, to: rel.version, next: CLONE_NEXT_STEPS };
    }

    // The signature first: an unsigned or wrongly signed release is refused before
    // anything else about it is believed, and --force does not change that.
    const refuseTrust = (err: unknown): never => {
      if (err instanceof UpdateError && isTrustFailure(err.code)) {
        setState({
          current: BRIDGE_VERSION, latest: rel.version, available, checkedAt: new Date().toISOString(),
          headline: rel.headline || null, notes: rel.notes || null, minPlugin: null, compatError: null, signatureError: err.message, trustCode: err.code,
        });
      }
      throw err;
    };
    let sums: Map<string, string>;
    try { sums = await fetchSums(rel); }
    catch (err) { return refuseTrust(err); }

    // compat.json: verified, or the release is not installable (CLI --force excepted).
    // Its flavour claim is a trust check like the signature: never overridden.
    let minPlugin: string | null = null;
    let minPluginProtocol: number | null = null;
    let compatError: string | null = null;
    try { ({ minPlugin, minPluginProtocol } = await fetchCompat(rel, sums)); }
    catch (err) {
      if (err instanceof UpdateError && isTrustFailure(err.code)) return refuseTrust(err);
      compatError = (err as Error).message;
    }
    // Keep the shared state (and with it the strip / notices) honest.
    setState({
      current: BRIDGE_VERSION, latest: rel.version, available, checkedAt: new Date().toISOString(),
      headline: rel.headline || null, notes: rel.notes || null, minPlugin, minPluginProtocol, compatError, signatureError: null,
    });

    if (o.version !== rel.version) {
      return { status: 'version_changed', from: BRIDGE_VERSION, to: rel.version, headline: rel.headline || null, notes: rel.notes || null };
    }

    let compatWarning: string | undefined;
    let staleWindows: string[] | undefined;
    if (!minPlugin) {
      if (!o.force) throw new UpdateError(compatError ?? `release ${rel.version} has no verifiable compatibility info`, 'compat_unverified');
      // Without a verified compat.json there is no flavour claim, and an absent claim is the
      // public flavour's: --force may skip the plugin check, never install another flavour's release.
      if (FLAVOUR.slug !== UNCLAIMED_FLAVOUR) {
        throw new UpdateError(`${compatError}. This ${FLAVOUR.displayName} build installs only releases whose signed compat.json names it, and --force does not override that.`, 'flavour_mismatch');
      }
      compatWarning = `WARNING: ${compatError}. Installing anyway because of --force: nothing checked that your Figma plugin works with ${rel.version}.`;
      logErr(`update: ${compatWarning}`);
    } else {
      const verdict = checkPluginCompat(minPlugin, rel.version, o.plugins, minPluginProtocol);
      if (verdict.kind === 'incompatible') return { status: 'incompatible_plugin', from: BRIDGE_VERSION, to: rel.version, reason: verdict.reason };
      if (verdict.kind === 'ok' && verdict.stale) staleWindows = verdict.stale;
      if (verdict.kind === 'unverifiable' && !(o.acceptUnverified || o.force)) {
        return { status: 'plugins_unverifiable', from: BRIDGE_VERSION, to: rel.version, reason: verdict.reason };
      }
    }

    if (o.confirm && !(await o.confirm({ from: BRIDGE_VERSION, to: rel.version, headline: rel.headline || null }))) {
      return { status: 'declined', from: BRIDGE_VERSION, to: rel.version };
    }

    // 1. download + verify everything first
    const bridgeBuf = await downloadVerified(rel, ASSET_BRIDGE, sums);
    const pluginBufs: Array<[string, Buffer]> = [];
    for (const [assetName, localName] of Object.entries(PLUGIN_ASSETS)) {
      const buf = await downloadVerified(rel, assetName, sums);
      if (localName === 'manifest.json') {
        let id: unknown; try { id = JSON.parse(buf.toString('utf8'))?.id; } catch { id = undefined; }
        if (id !== FLAVOUR.pluginId) throw new UpdateError(`release ${rel.version} has a plugin manifest with a different plugin id; not installing it`, 'install_failed');
      }
      pluginBufs.push([localName, buf]);
    }

    // 2. the new bridge must run (and say its own version) before anything is replaced
    const home = resolve(gripHome());
    const within = (p: string) => resolve(p).startsWith(home + sep);
    const homeExisted = existsSync(home);
    mkdirSync(home, { recursive: true });
    try { await selfTestBridge(bridgeBuf, home, rel.version); }
    catch (err) {
      if (!homeExisted) { try { rmdirSync(home); } catch { /* not empty / ignore */ } }
      throw err;
    }

    // 3. write (atomic per file), only inside ~/.grip
    const pluginDir = join(home, 'figma-plugin');
    mkdirSync(pluginDir, { recursive: true });
    const written: string[] = [];
    for (const [name, buf] of pluginBufs) {
      const dest = join(pluginDir, name);
      if (!within(dest)) throw new UpdateError(`refusing to write outside ${home}`);
      atomicWrite(dest, buf);
      written.push(name);
    }
    const entry = join(home, 'grip-bridge.mjs');
    const prev = join(home, 'grip-bridge.prev.mjs');
    if (!within(entry) || !within(prev)) throw new UpdateError(`refusing to write outside ${home}`);
    if (existsSync(entry)) {
      const tmp = `${prev}.tmp-${process.pid}-${Date.now()}`;
      try { copyFileSync(entry, tmp); renameSync(tmp, prev); }
      catch (err) { try { rmSync(tmp, { force: true }); } catch { /* ignore */ } throw err; }
    }
    // The bridge goes last: replacing it is the commit point of the update.
    atomicWrite(entry, bridgeBuf, 0o755);
    try { chmodSync(entry, 0o755); } catch { /* non-fatal on Windows */ }
    try { writeInstallRecord('release', rel.version); } catch { /* the record is advisory */ }
    // The verified plugin files are in place: refresh the user's own imported copies too (best effort, never fatal).
    let pluginCopies: CopySyncResult | undefined;
    try { const r = syncPluginCopies(); if (r.updated.length || r.skipped.length) pluginCopies = r; } catch { /* advisory */ }
    writeUpdateMarker({ version: rel.version, from: BRIDGE_VERSION, at: new Date().toISOString(), refreshed: pluginCopies?.updated.length ?? 0 });

    logErr(`update: installed ${BRIDGE_VERSION} -> ${rel.version} into ${home}`);
    return { status: 'updated', from: BRIDGE_VERSION, to: rel.version, home, pluginFilesWritten: written, ...(pluginCopies ? { pluginCopies } : {}), ...(compatWarning ? { compatWarning } : {}), ...(staleWindows ? { staleWindows } : {}) };
  } finally {
    installing = false;
  }
}

// Put the previous bridge back (written by the last install). Bridge only: the
// plugin files in ~/.grip/figma-plugin stay at the NEW version.
export function rollbackBridge(): { restored: string } {
  const home = gripHome();
  const prev = join(home, 'grip-bridge.prev.mjs');
  const entry = join(home, 'grip-bridge.mjs');
  if (!existsSync(prev)) throw new UpdateError(`no previous version to restore (${prev} does not exist)`);
  atomicWrite(entry, readFileSync(prev), 0o755);
  try { chmodSync(entry, 0o755); } catch { /* non-fatal on Windows */ }
  return { restored: prev };
}

// ---------- restart after install ----------

let restartHook: (() => void) | null = null;
let restartManaged = false;

// The daemon registers how to restart itself. `managed` = this process was
// started from ~/.grip/grip-bridge.mjs, i.e. the file the update just replaced.
export function setRestartHook(fn: (() => void) | null, managed: boolean): void {
  restartHook = fn;
  restartManaged = managed;
}

// True when the running bridge file IS ~/.grip/grip-bridge.mjs.
export function isManagedInstall(): boolean {
  try {
    const self = realpathSync(fileURLToPath(import.meta.url));
    return self === realpathSync(join(gripHome(), 'grip-bridge.mjs'));
  } catch { return false; }
}

// install, then (daemon only) schedule the restart ~1s out so the tool/WS
// response has flushed. The new process comes from ~/.grip/grip-bridge.mjs.
export async function installAndScheduleRestart(o: InstallOptions): Promise<InstallResult> {
  const r = await installUpdate(o);
  if (r.status !== 'updated') return r;
  if (!restartHook) return { ...r, restart: 'none' };
  if (!restartManaged) {
    logErr(`update: this bridge is not running from ${liveIdentity().homeLabel}/grip-bridge.mjs, so it is not restarting; start the installed copy to use the new version`);
    return { ...r, restart: 'not_managed' };
  }
  const delay = Number(process.env.GRIP_UPDATE_RESTART_DELAY_MS ?? 1000);
  const hook = restartHook;
  setTimeout(() => { try { hook(); } catch (err) { logErr(`update: restart failed: ${(err as Error).message}`); } }, delay);
  return { ...r, restart: 'scheduled' };
}

// ---------- stopping a running daemon (installer + CLI) ----------

// True when a process command line is a bridge DAEMON of the build whose entry file stem is
// `entryName` (e.g. `<stem>.mjs --daemon`). The one check every "is this really that daemon?"
// decision uses, for this build's own daemon and (phase 2B) for a foreign one.
export function isDaemonCommand(cmd: string, entryName: string): boolean {
  // `--daemon` as a whole argument (not `--daemonize`)
  return cmd.includes(entryName) && /(^|\s)--daemon(\s|$)/.test(cmd);
}

export function processCommandLine(pid: number): string | null {
  try {
    if (process.platform === 'win32') {
      return execFileSync('powershell', ['-NoProfile', '-Command',
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`],
        { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    }
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch { return null; }
}

// The plugin windows a RUNNING daemon reports in its status file (the CLI has no
// WebSocket of its own). null = cannot tell: no daemon, a stale file, or a
// daemon older than 0.8.0 that does not list its plugins.
export function readDaemonPlugins(): PluginInfo[] | null {
  try {
    const j = JSON.parse(readFileSync(statusFilePath(), 'utf8'));
    const pid = Number(j?.pid);
    if (!Number.isInteger(pid) || pid <= 1) return null;
    try { process.kill(pid, 0); } catch { return null; }
    if (!Array.isArray(j.plugins)) return null;
    return j.plugins.map((p: any) => ({
      pluginVersion: typeof p?.pluginVersion === 'string' ? p.pluginVersion : null,
      fileName: typeof p?.fileName === 'string' ? p.fileName : undefined,
      wsReady: p?.wsReady !== false,
      hello: p?.hello !== false,
      minBridge: typeof p?.minBridge === 'string' ? p.minBridge : null,
      // only from a daemon whose plugins report them (absent = the version rule)
      ...(Number.isSafeInteger(p?.protocol) ? { protocol: p.protocol } : {}),
      ...(Number.isSafeInteger(p?.minBridgeProtocol) ? { minBridgeProtocol: p.minBridgeProtocol } : {}),
    }));
  } catch { return null; }
}

// SIGTERM the running grip daemon so the freshly installed bridge takes over.
// Deliberately conservative: only the pid in the daemon's own status file, only
// if it is alive AND its command line is `...grip-bridge... --daemon`. Any doubt
// -> skip and say why. Supervised daemons (Login Item / systemd) come back on
// their own; stdio ones are re-spawned by the next shim reconnect.
export function stopRunningDaemon(): { stopped: boolean; note: string } {
  let pid: number;
  try {
    const j = JSON.parse(readFileSync(statusFilePath(), 'utf8'));
    pid = Number(j?.pid);
  } catch { return { stopped: false, note: 'no running Grip daemon found (no status file)' }; }
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) {
    return { stopped: false, note: 'status file has no usable daemon pid; left it alone' };
  }
  try { process.kill(pid, 0); }
  catch { return { stopped: false, note: 'status file is stale (that process is gone)' }; }
  const cmd = processCommandLine(pid);
  if (!cmd) return { stopped: false, note: `could not verify pid ${pid} is a Grip daemon; left it running (restart your agent / Figma plugin to pick up the new bridge)` };
  if (!isDaemonCommand(cmd, 'grip-bridge')) {
    return { stopped: false, note: `pid ${pid} does not look like a Grip daemon; left it alone` };
  }
  try { process.kill(pid, 'SIGTERM'); }
  catch (err) { return { stopped: false, note: `could not stop pid ${pid}: ${(err as Error).message}` }; }
  return { stopped: true, note: `stopped the running Grip daemon (pid ${pid}); the new version starts on the next agent call` };
}

// ---------- plugin strip wiring ----------

// Connect the update SIGNAL to the Figma plugin strip. The bridge pushes
//   {type:'update', available, latest, current, headline}
// to every plugin (on hello and whenever the signal changes), where `available`
// is updateSignal().signal: an update exists AND every connected plugin is
// compatible with it. It is recomputed whenever the update state changes or a
// plugin connects/disconnects. The strip turns purple on `available:true`; one
// click sends {type:'update_request', version:'<the version shown>'} and the
// outcome comes back as
//   {type:'update_result', status, from?, to?, restart?, next?, code?, message?, latest?}
// (status 'updated' | 'up_to_date' | 'already_installing' | 'clone_install' |
// 'error'; on 'error' `code` is version_changed | incompatible_plugin |
// plugins_unverifiable | compat_unverified | signature_missing | signature_invalid | flavour_mismatch | selftest_failed | version_required |
// origin | install_failed). Older plugins ignore all of this.
// The click is for the plugin-copy refresh when its version is the installed plugin's, no bridge
// update has that version, and an imported copy really is behind.
function copyRefreshRequested(version: string): boolean {
  const iv = installedPluginVersion();
  if (!iv || version !== iv || updatesDisabled()) return false;
  const s = getUpdateState();
  if (s?.available && s.latest === version) return false;
  return findPluginCopies(true).copies.some((c) => !c.skip && c.behind);
}

const LATEST_REQUEST = 'latest';

export function wireUpdateToBridge(bridge: PluginBridge): () => void {
  let lastBlocked = '';
  const recompute = () => {
    const s = updatesDisabled() ? null : getUpdateState();
    const plugins = pluginInfos(bridge);
    const sig = updateSignal(s, plugins);
    const blocked = s?.available && !sig.signal ? (sig.blockedReason ?? '') : '';
    if (blocked && blocked !== lastBlocked) logErr(`update: Grip ${s!.latest} is available but not offered: ${blocked}`);
    lastBlocked = blocked;
    // Per window: only a window whose plugin can work with the release is told (purple).
    const eligible = (sessionId: string) => {
      if (!s?.minPlugin || !s.latest) return false;
      const p = plugins.find((x) => x.sessionId === sessionId);
      return !!p && connectedPlugins([p]).length === 1 && pluginIncompatibility(s.minPlugin, s.latest, p, s.minPluginProtocol) === null;
    };
    // No bridge update to offer, but an imported plugin copy is behind the installed one: the same
    // purple strip offers to refresh it (one click). Only windows older than the installed plugin are told.
    const behindCopies = !updatesDisabled() && !(s && sig.signal) ? findPluginCopies().copies.filter((c) => !c.skip && c.behind) : [];
    const installedV = installedPluginVersion();
    if (behindCopies.length && installedV) {
      const oldest = behindCopies.map((c) => c.version!).sort(compareSemver)[0];
      const eligibleCopy = (sessionId: string) => {
        const p = plugins.find((x) => x.sessionId === sessionId);
        return !!p && connectedPlugins([p]).length === 1 && isSemver(p.pluginVersion) && compareSemver(p.pluginVersion, installedV) < 0;
      };
      const n = behindCopies.length;
      bridge.setUpdateState({ available: true, latest: installedV, current: oldest, headline: `Refresh the Grip plugin you imported (${n} folder${n === 1 ? '' : 's'})`, eligible: eligibleCopy });
      return;
    }
    bridge.setUpdateState(s ? { available: sig.signal, latest: s.latest, current: BRIDGE_VERSION, headline: s.headline ?? null, eligible } : null);
  };
  // Toasts inside Figma (the plugin's own `notify`, so every plugin version gets them):
  //  1. right after an update, once per open file: "Grip updated to x";
  //  2. a Community plugin window older than the plugin this bridge ships: nothing on disk can fix it
  //     (Figma loads the newest published version only when the plugin is opened, and a plugin cannot
  //     reload itself), so ask to reopen it, once per window and version (and once per 3 days across
  //     restarts). When both apply it is one message.
  const toasted = new Set<string>();
  const confirmed = new Set<string>();
  const nudge = () => {
    const t = (bridge as unknown as { toast?: (sid: string, msg: string) => boolean }).toast;
    if (typeof t !== 'function') return;
    const live = connectedPlugins(pluginInfos(bridge)).filter((p) => p.sessionId);
    if (!live.length) return;
    const marker = readUpdateMarker();
    const installed = updatesDisabled() ? null : installedPluginVersion();
    // No reopen nudge while an imported copy still needs updating (refresh / git pull come first) or was just refreshed (its window hot-swaps).
    const hold = installed ? findPluginCopies().copies.some(copyNeedsWork) || recentlySynced() : true;
    for (const p of live) {
      const parts: string[] = [];
      const fileKey = `${p.fileKey ?? ''}|${p.fileName ?? ''}`;
      if (marker && !confirmed.has(fileKey)) {
        confirmed.add(fileKey);
        parts.push(`Grip updated to ${marker.version}.`);
      }
      if (installed && !hold && isSemver(p.pluginVersion) && compareSemver(p.pluginVersion, installed) < 0) {
        const id = `${p.fileName ?? ''}|${p.pluginVersion}|${installed}`;
        if (!toasted.has(id)) {
          toasted.add(id);
          if (claimNotice(`reopen:${id}`)) parts.push(`${parts.length ? '' : 'Grip was updated. '}Reopen the plugin to load its new version.`);
        }
      }
      if (parts.length) t.call(bridge, p.sessionId!, parts.join(' '));
    }
  };
  recompute();
  nudge();
  const offState = onUpdateState(recompute);
  const onChange = () => { recompute(); nudge(); };
  bridge.on('session-change', onChange);

  const onRequest = async (e: { sessionId: string; version?: string }) => {
    let msg: Record<string, unknown>;
    try {
      // `version:'latest'`: a plugin that needs a NEWER bridge than this one asks for the current
      // release without having been shown a version (its strip said "Bridge update needed. Click to update").
      // Only that window may ask; the release is looked up fresh and then goes through exactly the same
      // pin, compatibility and verification steps as any other install.
      let ver = e.version;
      let early: Record<string, unknown> | null = null;
      if (ver === LATEST_REQUEST) {
        const me = pluginInfos(bridge).find((x) => x.sessionId === e.sessionId);
        if (!me || !needsNewerBridge(me)) {
          early = { type: 'update_result', status: 'error', code: 'version_required', message: 'only a plugin that needs a newer bridge can ask for the latest release; reload the plugin in Figma and try again' };
        } else if (updatesDisabled()) {
          early = { type: 'update_result', status: 'error', code: 'install_failed', message: 'automatic update checks are off (GRIP_NO_UPDATE_CHECK); update the bridge yourself' };
        } else {
          const st = await checkForUpdate();
          if (!st.available || !st.latest) early = { type: 'update_result', status: 'error', code: 'no_update_available', message: st.error ? `could not check for a newer bridge: ${st.error}` : 'no newer bridge is published yet' };
          else ver = st.latest;
        }
      }
      if (early) {
        msg = early;
      } else if (!ver) {
        msg = { type: 'update_result', status: 'error', code: 'version_required', message: 'this Grip plugin did not say which version you were shown; reload the plugin in Figma and try again' };
      } else if (copyRefreshRequested(ver)) {
        // The strip offered "refresh the plugin copy" (no bridge update with that version): write the
        // installed plugin files into the imported folders. No restart: a dev plugin reloads when its files change.
        const r = syncPluginCopies();
        msg = r.updated.length
          ? { type: 'update_result', status: 'updated', to: ver, restart: 'none', copies: r.updated.length }
          : { type: 'update_result', status: 'up_to_date', to: ver };
        bridge.sendTo(e.sessionId, msg);
        recompute();   // pushes the cleared (or remaining) offer to every strip
        return;
      } else {
        const plugins = pluginInfos(bridge);
        // The click comes from ONE window: that window's plugin must be compatible.
        const me = plugins.find((x) => x.sessionId === e.sessionId);
        const s0 = getUpdateState();
        const why = me && s0?.minPlugin && s0.latest ? pluginIncompatibility(s0.minPlugin, s0.latest, me, s0.minPluginProtocol) : null;
        if (why) {
          bridge.sendTo(e.sessionId, { type: 'update_result', status: 'error', code: 'incompatible_plugin', message: why });
          bridge.pushUpdate(e.sessionId, true);
          return;
        }
        const r = await installAndScheduleRestart({ version: ver, plugins });
        if (r.status === 'version_changed') {
          msg = { type: 'update_result', status: 'error', code: 'version_changed', latest: r.to, message: `Grip ${r.to} is now the latest release (you were shown ${ver}); the strip refreshes so you can review it` };
        } else if (r.status === 'incompatible_plugin' || r.status === 'plugins_unverifiable') {
          msg = { type: 'update_result', status: 'error', code: r.status, message: r.reason };
        } else {
          msg = { type: 'update_result', status: r.status, from: r.from, to: r.to, restart: r.restart, next: r.next };
        }
      }
    } catch (err) {
      const code = err instanceof UpdateError && err.code ? err.code : 'install_failed';
      msg = { type: 'update_result', status: 'error', code, message: (err as Error).message };
    }
    bridge.sendTo(e.sessionId, msg);
    // A failed update is also said in Figma (the strip only flashes red). 'version_changed' is not a failure.
    if (msg.status === 'error' && msg.code !== 'version_changed') {
      const tf = (bridge as unknown as { toast?: (sid: string, m: string) => boolean }).toast;
      if (typeof tf === 'function') tf.call(bridge, e.sessionId, `Grip could not update: ${String(msg.message ?? 'unknown error').replace(/\s+/g, ' ').slice(0, 140)}`);
    }
    // The state may have changed under the user (a newer release, a refused
    // install): after the result, make sure this strip shows the truth again.
    if (msg.status === 'error') { recompute(); bridge.pushUpdate(e.sessionId, true); }
  };
  bridge.on('update-request', onRequest);
  return () => { offState(); bridge.off('session-change', onChange); bridge.off('update-request', onRequest); };
}
