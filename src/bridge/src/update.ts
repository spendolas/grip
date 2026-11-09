// Self-update for the Grip bridge. USER-TRIGGERED ONLY.
//
// Two halves:
//   1. CHECK  — ask GitHub for the latest published Release of this repo
//      (api.github.com/repos/spendolas/grip/releases/latest), compare its tag to
//      BRIDGE_VERSION, remember the answer plus the release notes. The daemon
//      does this ~30s after startup and every 24h. Pure information: it never
//      downloads or installs anything, and every failure is silent.
//   2. INSTALL — only when a human said yes (agent tool after the user agrees,
//      the plugin's "click to confirm", or the CLI). Downloads the release's
//      bridge + plugin assets and SHA256SUMS.txt, verifies every file against
//      SHA256SUMS.txt and a size cap, and only THEN writes (tmp file + rename)
//      into ~/.grip. A developer (git clone) install is never overwritten.
//
// The Figma plugin's networkAccess is localhost-only, so the plugin never
// touches the internet: this module (in the bridge) is the only code that does.
//
// Dependency-free on purpose (node builtins only): the bridge ships as one
// bundled file and the installer bundle imports this module too.
//
// ALL logging goes to stderr — stdout is the MCP transport.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync,
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
// release asset name -> file name inside ~/.grip/figma-plugin
export const PLUGIN_ASSETS: Record<string, string> = {
  'grip-plugin-code.js': 'code.js',
  'grip-plugin-ui.html': 'ui.html',
  'grip-plugin-manifest.json': 'manifest.json',
};
export const UPDATE_ASSET_NAMES = [ASSET_BRIDGE, ...Object.keys(PLUGIN_ASSETS), ASSET_SUMS];

const RELEASE_MAX_BYTES = 256 * 1024;
const SUMS_MAX_BYTES = 64 * 1024;
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

export class UpdateError extends Error {}

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

// "**A smoother install.**" -> "A smoother install." One line, plain text.
export function releaseHeadline(body: unknown): string {
  if (typeof body !== 'string') return '';
  for (const raw of body.split(/\r?\n/)) {
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
  const t = body.replace(/\r\n/g, '\n').trim();
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

export const CLONE_NEXT_STEPS = ['git pull', 'node bridge/install.mjs'];

// ---------- check + state ----------

export interface UpdateState {
  current: string;
  latest: string | null;
  available: boolean;
  checkedAt: string | null;   // ISO timestamp of the last SUCCESSFUL check
  headline?: string | null;   // one-line summary of the latest release (from its notes)
  notes?: string | null;      // first ~1200 chars of the latest release's notes
  error?: string;             // set when the latest attempt failed (state is carried over)
}

let state: UpdateState | null = null;
const listeners = new Set<(s: UpdateState) => void>();

export function getUpdateState(): UpdateState | null { return state; }
export function onUpdateState(fn: (s: UpdateState) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
export function resetUpdateState(): void { state = null; }

function setState(next: UpdateState) {
  const changed = !state || state.available !== next.available || state.latest !== next.latest;
  state = next;
  if (changed) {
    for (const fn of listeners) {
      try { fn(next); } catch (err) { logErr(`update: listener failed: ${(err as Error).message}`); }
    }
  }
}

function cachePath() { return join(gripHome(), 'update-check.json'); }

function writeCache(s: UpdateState) {
  // Best effort, and never create ~/.grip just for a cache file (a daemon run
  // from a git clone, without the installer, shouldn't sprout the directory).
  try {
    if (!existsSync(gripHome())) return;
    writeFileSync(cachePath(), JSON.stringify({
      current: s.current, latest: s.latest, available: s.available, checkedAt: s.checkedAt,
      headline: s.headline ?? null, notes: s.notes ?? null,
    }, null, 2));
  } catch { /* cache is best-effort */ }
}

// A cached answer, re-evaluated against the CURRENT version (the cache may
// have been written by an older bridge that has since been updated).
export function readCache(): UpdateState | null {
  try {
    const j = JSON.parse(readFileSync(cachePath(), 'utf8'));
    if (!isSemver(j?.latest)) return null;
    return {
      current: BRIDGE_VERSION,
      latest: j.latest,
      available: compareSemver(j.latest, BRIDGE_VERSION) > 0,
      checkedAt: typeof j.checkedAt === 'string' ? j.checkedAt : null,
      headline: typeof j.headline === 'string' ? j.headline : null,
      notes: typeof j.notes === 'string' ? j.notes : null,
    };
  } catch { return null; }
}

// One network check. Never throws: on any failure it logs one stderr line and
// returns the previous state (plus `error`). Does NOT consult
// GRIP_NO_UPDATE_CHECK — callers decide whether a check is allowed.
export async function checkForUpdate(api: string = releasesApi()): Promise<UpdateState> {
  try {
    const r = await fetchRelease(api);
    const next: UpdateState = {
      current: BRIDGE_VERSION,
      latest: r.version,
      available: compareSemver(r.version, BRIDGE_VERSION) > 0,
      checkedAt: new Date().toISOString(),
      headline: r.headline || null,
      notes: r.notes || null,
    };
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
    `Do NOT install it on your own: only if the user explicitly says yes, call grip_update {action:'install'}.`;
}
export function updateInstructionsParagraph(s: UpdateState): string {
  return `\n\nA Grip update is available (${s.current} → ${s.latest}).${headlineClause(s)} Mention it to the user once, at a natural moment, ` +
    `and ask if they want it. Never install without their explicit yes; if they agree, call grip_update {action:'install'}.`;
}

// ---------- install ----------

export interface InstallResult {
  status: 'updated' | 'up_to_date' | 'already_installing' | 'clone_install';
  from?: string;
  to?: string;
  home?: string;
  pluginFilesWritten?: string[];
  restart?: 'scheduled' | 'not_managed' | 'none';
  next?: string[];            // clone_install: the commands to run instead
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

// The install routine shared by the MCP tool, the plugin's update_request and
// the CLI. Everything is downloaded AND verified in memory before the first
// byte is written, so a failure at any point leaves ~/.grip untouched.
// Does not restart anything — see installAndScheduleRestart().
// `force` is for the CLI only: it overwrites a clone install's ~/.grip copy.
export async function installUpdate(o: { api?: string; force?: boolean } = {}): Promise<InstallResult> {
  if (installing) return { status: 'already_installing' };
  installing = true;
  try {
    const api = o.api ?? releasesApi();
    const rel = await fetchRelease(api).catch((err: Error) => {
      throw new UpdateError(`could not read the latest release: ${err.message}`);
    });
    // Keep the shared state honest even though this wasn't a scheduled check.
    const available = compareSemver(rel.version, BRIDGE_VERSION) > 0;
    setState({
      current: BRIDGE_VERSION, latest: rel.version, available, checkedAt: new Date().toISOString(),
      headline: rel.headline || null, notes: rel.notes || null,
    });
    if (!available) return { status: 'up_to_date', from: BRIDGE_VERSION, to: rel.version };

    // Never update a developer install over the top of its clone: git pull does that.
    if (!o.force && readInstallRecord().source === 'clone') {
      return { status: 'clone_install', from: BRIDGE_VERSION, to: rel.version, next: CLONE_NEXT_STEPS };
    }

    // 1. download + verify everything first
    const sums = parseSums((await downloadAsset(rel, ASSET_SUMS, SUMS_MAX_BYTES)).toString('utf8'));
    const bridgeBuf = await downloadVerified(rel, ASSET_BRIDGE, sums);
    const pluginBufs: Array<[string, Buffer]> = [];
    for (const [assetName, localName] of Object.entries(PLUGIN_ASSETS)) {
      pluginBufs.push([localName, await downloadVerified(rel, assetName, sums)]);
    }

    // 2. write (atomic per file), only inside ~/.grip
    const home = resolve(gripHome());
    const within = (p: string) => resolve(p).startsWith(home + sep);
    mkdirSync(home, { recursive: true });
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
    return { status: 'updated', from: BRIDGE_VERSION, to: rel.version, home, pluginFilesWritten: written };
  } finally {
    installing = false;
  }
}

// Put the previous bridge back (written by the last install). Bridge only: the
// plugin files in ~/.grip/figma-plugin are left as they are.
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
export async function installAndScheduleRestart(o: { force?: boolean } = {}): Promise<InstallResult> {
  const r = await installUpdate({ force: o.force });
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

// Connect update state to the Figma plugin strip: the bridge pushes
// {type:'update', available, latest, headline?} to every plugin (on hello and on change),
// and a plugin's {type:'update_request'} (the user's second click on the
// indicator) runs the same install routine as the grip_update tool. The
// outcome goes back as {type:'update_result', status, from?, to?, message?}.
export function wireUpdateToBridge(bridge: PluginBridge): () => void {
  const push = (s: UpdateState | null) => bridge.setUpdateState(s ? { available: s.available, latest: s.latest, headline: s.headline ?? null } : null);
  push(getUpdateState());
  const off = onUpdateState(push);
  const onRequest = async (e: { sessionId: string }) => {
    let msg: Record<string, unknown>;
    try {
      const r = await installAndScheduleRestart();
      msg = { type: 'update_result', status: r.status, from: r.from, to: r.to, restart: r.restart, next: r.next };
    } catch (err) {
      msg = { type: 'update_result', status: 'error', message: (err as Error).message };
    }
    bridge.sendTo(e.sessionId, msg);
  };
  bridge.on('update-request', onRequest);
  return () => { off(); bridge.off('update-request', onRequest); };
}
