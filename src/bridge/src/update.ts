// Self-update for the Grip bridge. USER-TRIGGERED ONLY.
//
// Two halves:
//   1. CHECK  — ask GitHub for the latest published Release of this repo
//      (api.github.com/repos/spendolas/grip/releases/latest), compare its tag to
//      BRIDGE_VERSION, remember the answer plus the release notes and the
//      release's compat.json (the oldest Figma plugin it works with, verified
//      against SHA256SUMS.txt). The daemon does this ~30s after startup and
//      every 24h. Pure information: it never installs anything, and every
//      failure is silent.
//   2. INSTALL — only when a human said yes (the user's click on the purple
//      plugin strip, an agent after the user agrees, or the CLI). Downloads the
//      release's bridge + plugin assets and SHA256SUMS.txt, verifies every file
//      against SHA256SUMS.txt and a size cap, runs the new bridge once with
//      --selftest, and only THEN writes (tmp file + rename) into ~/.grip. A
//      developer (git clone) install is never overwritten.
//
// COMPATIBILITY comes first. The published plugin is updated through Figma, not
// by this updater, so a user's plugin can lag the bridge. An update is only
// signalled (updateSignal) or installed when EVERY connected plugin is new
// enough for it (compat.json minPlugin); a release without a verifiable
// compat.json is neither signalled nor installable (the CLI's --force excepted).
//
// The Figma plugin's networkAccess is localhost-only, so the plugin never
// touches the internet: this module (in the bridge) is the only code that does.
//
// Dependency-free on purpose (node builtins only): the bridge ships as one
// bundled file and the installer bundle imports this module too.
//
// ALL logging goes to stderr — stdout is the MCP transport.

import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, writeFileSync,
} from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRIDGE_VERSION } from './types.js';
import type { PluginBridge } from './ws-server.js';

export const DEFAULT_RELEASES_API = 'https://api.github.com/repos/spendolas/grip/releases/latest';

// Release asset names. scripts/package-release.mjs produces them and
// scripts/release-gate.mjs requires them; a test keeps all three in step.
export const ASSET_BRIDGE = 'grip-bridge.mjs';
export const ASSET_SUMS = 'SHA256SUMS.txt';
export const ASSET_COMPAT = 'compat.json';   // { version, minPlugin }
// release asset name -> file name inside ~/.grip/figma-plugin
export const PLUGIN_ASSETS: Record<string, string> = {
  'grip-plugin-code.js': 'code.js',
  'grip-plugin-ui.html': 'ui.html',
  'grip-plugin-manifest.json': 'manifest.json',
};
export const UPDATE_ASSET_NAMES = [ASSET_BRIDGE, ...Object.keys(PLUGIN_ASSETS), ASSET_SUMS, ASSET_COMPAT];
// release-page footer marker: everything from this line on is for GitHub
// readers (install pointer), never part of an update notice. Appended by
// scripts/release-gate.mjs (INSTALL_MARKER there).
export const INSTALL_MARKER = '<!-- grip-install -->';

const RELEASE_MAX_BYTES = 256 * 1024;
const SUMS_MAX_BYTES = 64 * 1024;
const COMPAT_MAX_BYTES = 4 * 1024;
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
  return process.env.GRIP_HOME || join(homedir(), '.grip');
}
export function statusFilePath(): string {
  return process.env.GRIP_STATUS_PATH ?? join(homedir(), '.grip-bridge.status');
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
export function releasesApi(): string {
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

export function parseRelease(buf: Buffer): Release {
  let j: any;
  try { j = JSON.parse(buf.toString('utf8')); } catch { throw new UpdateError('the releases API did not return valid JSON'); }
  if (!j || typeof j !== 'object') throw new UpdateError('the releases API returned an unexpected shape');
  if (j.draft === true || j.prerelease === true) throw new UpdateError('the latest release is a draft or prerelease; ignoring it');
  const tag = typeof j.tag_name === 'string' ? j.tag_name.replace(/^v/, '') : '';
  if (!isSemver(tag)) throw new UpdateError('the latest release has no valid version tag');
  const assets: Record<string, ReleaseAsset> = {};
  const list = Array.isArray(j.assets) ? j.assets : [];
  if (list.length > MAX_ASSETS) throw new UpdateError('the latest release lists too many assets');
  for (const a of list) {
    if (!a || typeof a.name !== 'string' || typeof a.browser_download_url !== 'string') continue;
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(a.name)) continue;
    assets[a.name] = { name: a.name, url: a.browser_download_url, size: typeof a.size === 'number' ? a.size : undefined };
  }
  return { version: tag, notes: releaseNotes(j.body), headline: releaseHeadline(j.body), assets };
}

export async function fetchRelease(api: string = releasesApi()): Promise<Release> {
  const buf = await httpGet(api, {
    maxBytes: RELEASE_MAX_BYTES,
    timeoutMs: MANIFEST_TIMEOUT_MS,
    headers: { accept: 'application/vnd.github+json' },
  });
  return parseRelease(buf);
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
  wsReady?: boolean;
  hello?: boolean;               // false until the plugin's hello arrived (version not known yet)
  minBridge?: string | null;     // the plugin says: I need a bridge >= this
}

export function pluginInfos(bridge: { snapshot(): { plugins: any[] } }): PluginInfo[] {
  return bridge.snapshot().plugins.map((p) => ({
    sessionId: p.sessionId, pluginVersion: p.pluginVersion, fileName: p.fileName, wsReady: p.wsReady, hello: p.hello, minBridge: p.minBridge,
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

// Why ONE plugin window cannot work with this release (null = it can). Unknown
// version = incompatible.
export function pluginIncompatibility(minPlugin: string, latest: string, p: PluginInfo): string | null {
  const where = p.fileName ? ` in "${p.fileName}"` : '';
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
export function checkPluginCompat(minPlugin: string, latest: string, plugins: PluginInfo[] | null | undefined): PluginVerdict {
  const live = connectedPlugins(plugins);
  if (live.length === 0) {
    return { kind: 'unverifiable', reason: 'no Grip plugin is connected, so compatibility cannot be verified; open the Grip plugin in Figma first' };
  }
  const stale: string[] = [];
  let ok = 0;
  for (const p of live) {
    const why = pluginIncompatibility(minPlugin, latest, p);
    if (why) stale.push(why); else ok++;
  }
  if (ok === 0) return { kind: 'incompatible', reason: stale[0] };
  return stale.length ? { kind: 'ok', stale } : { kind: 'ok' };
}

export interface UpdateSignal { signal: boolean; blockedReason?: string; staleWindows?: string[] }

// THE single decision for every signalling surface (the purple strip, the agent
// notices, grip_health.update): signal only when an update is available AND at
// least one plugin is connected AND every connected plugin is compatible. A
// release whose compat.json is missing/unverifiable is never signalled (fail
// closed). `blockedReason` explains a withheld signal (only set when an update
// is available).
export function updateSignal(state: UpdateState | null | undefined, plugins: PluginInfo[] | null | undefined): UpdateSignal {
  if (!state || !state.available || !state.latest) return { signal: false };
  if (!state.minPlugin) {
    return { signal: false, blockedReason: `Grip ${state.latest} has no verified compatibility info (compat.json)${state.compatError ? ': ' + state.compatError : ''}, so it is not offered` };
  }
  const v = checkPluginCompat(state.minPlugin, state.latest, plugins);
  return v.kind === 'ok' ? { signal: true, ...(v.stale ? { staleWindows: v.stale } : {}) } : { signal: false, blockedReason: v.reason };
}

// The reverse direction (informational): a connected plugin that needs a NEWER
// bridge than this one. Then the bridge is the stale side, an update is recommended.
export function bridgeStaleReason(plugins: PluginInfo[] | null | undefined): string | undefined {
  for (const p of connectedPlugins(plugins)) {
    if (p.minBridge && isSemver(p.minBridge) && compareSemver(p.minBridge, BRIDGE_VERSION) > 0) {
      return `plugin ${p.pluginVersion ?? '?'}${p.fileName ? ` in "${p.fileName}"` : ''} needs Grip bridge >= ${p.minBridge} but this bridge is ${BRIDGE_VERSION}: update the bridge`;
    }
  }
  return undefined;
}

// compat.json: { "version": "<release version>", "minPlugin": "<x.y.z>" },
// generated by scripts/package-release.mjs from types.ts. Verified against
// SHA256SUMS.txt before it is believed.
async function fetchCompat(rel: Release, sums: Map<string, string>): Promise<{ minPlugin: string }> {
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
  if (!j || j.version !== rel.version) return fail(`it describes version ${j?.version ?? '?'}, not ${rel.version}`);
  if (!isSemver(j.minPlugin)) return fail('minPlugin is not a version');
  if (compareSemver(j.minPlugin, rel.version) > 0) return fail('minPlugin is newer than the release itself');
  return { minPlugin: j.minPlugin };
}

async function fetchSums(rel: Release): Promise<Map<string, string>> {
  return parseSums((await downloadAsset(rel, ASSET_SUMS, SUMS_MAX_BYTES)).toString('utf8'));
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
  compatError?: string | null;
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
export function resetUpdateState(): void { state = null; noticeMemo.clear(); }

function setState(next: UpdateState) {
  const changed = !state || state.available !== next.available || state.latest !== next.latest
    || (state.minPlugin ?? null) !== (next.minPlugin ?? null);
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
    minPlugin: isSemver(j.minPlugin) ? j.minPlugin : null,
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
// release is newer than this bridge). A missing/unverifiable compat.json does
// not throw: the state says available:true, minPlugin:null, compatError — which
// updateSignal() turns into "not offered".
async function stateFromRelease(r: Release): Promise<UpdateState> {
  const available = compareSemver(r.version, BRIDGE_VERSION) > 0;
  let minPlugin: string | null = null;
  let compatError: string | null = null;
  if (available) {
    try { minPlugin = (await fetchCompat(r, await fetchSums(r))).minPlugin; }
    catch (err) { compatError = (err as Error).message; logErr(`update: ${r.version} will not be offered: ${compatError}`); }
  }
  return {
    current: BRIDGE_VERSION,
    latest: r.version,
    available,
    checkedAt: new Date().toISOString(),
    headline: r.headline || null,
    notes: r.notes || null,
    minPlugin,
    compatError,
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
      compatError: state?.compatError ?? null,
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
        headline: rel.headline || null, notes: rel.notes || null, minPlugin: null, compatError: null,
      });
      return { status: 'up_to_date', from: BRIDGE_VERSION, to: rel.version };
    }

    // Never update a developer install over the top of its clone: git pull does that.
    if (!o.force && readInstallRecord().source === 'clone') {
      return { status: 'clone_install', from: BRIDGE_VERSION, to: rel.version, next: CLONE_NEXT_STEPS };
    }

    const sums = await fetchSums(rel);

    // compat.json: verified, or the release is not installable (CLI --force excepted).
    let minPlugin: string | null = null;
    let compatError: string | null = null;
    try { minPlugin = (await fetchCompat(rel, sums)).minPlugin; }
    catch (err) { compatError = (err as Error).message; }
    // Keep the shared state (and with it the strip / notices) honest.
    setState({
      current: BRIDGE_VERSION, latest: rel.version, available, checkedAt: new Date().toISOString(),
      headline: rel.headline || null, notes: rel.notes || null, minPlugin, compatError,
    });

    if (o.version !== rel.version) {
      return { status: 'version_changed', from: BRIDGE_VERSION, to: rel.version, headline: rel.headline || null, notes: rel.notes || null };
    }

    let compatWarning: string | undefined;
    let staleWindows: string[] | undefined;
    if (!minPlugin) {
      if (!o.force) throw new UpdateError(compatError ?? `release ${rel.version} has no verifiable compatibility info`, 'compat_unverified');
      compatWarning = `WARNING: ${compatError}. Installing anyway because of --force: nothing checked that your Figma plugin works with ${rel.version}.`;
      logErr(`update: ${compatWarning}`);
    } else {
      const verdict = checkPluginCompat(minPlugin, rel.version, o.plugins);
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
      pluginBufs.push([localName, await downloadVerified(rel, assetName, sums)]);
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

    logErr(`update: installed ${BRIDGE_VERSION} -> ${rel.version} into ${home}`);
    return { status: 'updated', from: BRIDGE_VERSION, to: rel.version, home, pluginFilesWritten: written, ...(compatWarning ? { compatWarning } : {}), ...(staleWindows ? { staleWindows } : {}) };
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
    logErr('update: this bridge is not running from ~/.grip/grip-bridge.mjs, so it is not restarting; start the installed copy to use the new version');
    return { ...r, restart: 'not_managed' };
  }
  const delay = Number(process.env.GRIP_UPDATE_RESTART_DELAY_MS ?? 1000);
  const hook = restartHook;
  setTimeout(() => { try { hook(); } catch (err) { logErr(`update: restart failed: ${(err as Error).message}`); } }, delay);
  return { ...r, restart: 'scheduled' };
}

// ---------- stopping a running daemon (installer + CLI) ----------

function processCommandLine(pid: number): string | null {
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
  if (!/grip-bridge/.test(cmd) || !/--daemon/.test(cmd)) {
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
// plugins_unverifiable | compat_unverified | selftest_failed | version_required |
// origin | install_failed). Older plugins ignore all of this.
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
      return !!p && connectedPlugins([p]).length === 1 && pluginIncompatibility(s.minPlugin, s.latest, p) === null;
    };
    bridge.setUpdateState(s ? { available: sig.signal, latest: s.latest, current: BRIDGE_VERSION, headline: s.headline ?? null, eligible } : null);
  };
  recompute();
  const offState = onUpdateState(recompute);
  bridge.on('session-change', recompute);

  const onRequest = async (e: { sessionId: string; version?: string }) => {
    let msg: Record<string, unknown>;
    try {
      if (!e.version) {
        msg = { type: 'update_result', status: 'error', code: 'version_required', message: 'this Grip plugin did not say which version you were shown; reload the plugin in Figma and try again' };
      } else {
        const plugins = pluginInfos(bridge);
        // The click comes from ONE window: that window's plugin must be compatible.
        const me = plugins.find((x) => x.sessionId === e.sessionId);
        const s0 = getUpdateState();
        const why = me && s0?.minPlugin && s0.latest ? pluginIncompatibility(s0.minPlugin, s0.latest, me) : null;
        if (why) {
          bridge.sendTo(e.sessionId, { type: 'update_result', status: 'error', code: 'incompatible_plugin', message: why });
          bridge.pushUpdate(e.sessionId, true);
          return;
        }
        const r = await installAndScheduleRestart({ version: e.version, plugins });
        if (r.status === 'version_changed') {
          msg = { type: 'update_result', status: 'error', code: 'version_changed', latest: r.to, message: `Grip ${r.to} is now the latest release (you were shown ${e.version}); the strip refreshes so you can review it` };
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
    // The state may have changed under the user (a newer release, a refused
    // install): after the result, make sure this strip shows the truth again.
    if (msg.status === 'error') { recompute(); bridge.pushUpdate(e.sessionId, true); }
  };
  bridge.on('update-request', onRequest);
  return () => { offState(); bridge.off('session-change', recompute); bridge.off('update-request', onRequest); };
}
