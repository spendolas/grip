// Self-update for the Grip bridge. USER-TRIGGERED ONLY.
//
// Two halves:
//   1. CHECK  — read the release manifest (bridge/version.json on the repo's
//      main branch), compare to BRIDGE_VERSION, remember the answer. The daemon
//      does this ~30s after startup and every 24h. Pure information: it never
//      downloads or installs anything, and every failure is silent.
//   2. INSTALL — only when a human said yes (agent tool after the user agrees,
//      the plugin's "click to confirm", or the CLI). Downloads the bridge and
//      plugin files, verifies each against the manifest's sha256 and a size
//      cap, and only THEN writes (tmp file + rename) into ~/.grip.
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
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRIDGE_VERSION } from './types.js';
import type { PluginBridge } from './ws-server.js';

export const DEFAULT_UPDATE_BASE = 'https://raw.githubusercontent.com/spendolas/grip/main/';
// version.json lives next to the bridge in the repo; every path INSIDE it is
// relative to the base URL (e.g. "bridge/grip-bridge.mjs").
export const MANIFEST_PATH = 'bridge/version.json';

const MANIFEST_MAX_BYTES = 64 * 1024;
const FILE_MAX_BYTES = 5 * 1024 * 1024;
const MAX_PLUGIN_FILES = 20;
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
export function normalizeBase(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && loopback))) return null;
  if (u.username || u.password) return null;
  u.search = '';
  u.hash = '';
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  return u.toString();
}

let warnedBase = false;
export function updateBase(): string {
  const raw = process.env.GRIP_UPDATE_BASE?.trim();
  if (!raw) return DEFAULT_UPDATE_BASE;
  const norm = normalizeBase(raw);
  if (norm) return norm;
  if (!warnedBase) {
    warnedBase = true;
    logErr(`update: ignoring GRIP_UPDATE_BASE=${raw} (must be https, or http on 127.0.0.1/localhost); using the default`);
  }
  return DEFAULT_UPDATE_BASE;
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
// overall deadline, and the ORIGIN rule: redirects are followed (max 3) only
// when they stay on exactly the same protocol+host+port as the start URL.
function httpGet(
  url: string,
  o: { maxBytes: number; timeoutMs: number; origin?: string; redirectsLeft?: number },
): Promise<Buffer> {
  return new Promise((resolveP, rejectP) => {
    let u: URL;
    try { u = new URL(url); } catch { rejectP(new UpdateError(`bad URL: ${url}`)); return; }
    const origin = o.origin ?? u.origin;
    if (u.origin !== origin) {
      rejectP(new UpdateError(`refused redirect off-origin (${u.origin} is not ${origin})`));
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
    const req = doRequest(u, {
      method: 'GET',
      headers: { 'user-agent': `grip-bridge/${BRIDGE_VERSION}`, accept: '*/*' },
    }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        const left = o.redirectsLeft ?? MAX_REDIRECTS;
        if (left <= 0) { done(new UpdateError('too many redirects')); return; }
        let next: string;
        try { next = new URL(res.headers.location, u).toString(); }
        catch { done(new UpdateError('bad redirect location')); return; }
        httpGet(next, { ...o, origin, redirectsLeft: left - 1 }).then(
          (b) => done(null, b),
          (e) => done(e),
        );
        return;
      }
      if (status !== 200) {
        res.resume();
        done(new UpdateError(`HTTP ${status} for ${u.pathname}`));
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

// ---------- manifest ----------

export interface ManifestFile { path: string; sha256: string; bytes?: number }
export interface Manifest {
  version: string;
  bridge: ManifestFile;
  plugin: { files: Record<string, ManifestFile> };
}

// Remote-supplied paths are untrusted: they become URL paths (under the base)
// and, for plugin files, local file NAMES. Restrict both hard.
function safeRelPath(p: unknown): p is string {
  if (typeof p !== 'string' || p.length === 0 || p.length > 200) return false;
  if (!/^[A-Za-z0-9._\-/]+$/.test(p) || p.startsWith('/')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}
function safeFileName(n: string): boolean {
  return /^[A-Za-z0-9._-]{1,100}$/.test(n) && n !== '.' && n !== '..';
}
const isSha = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{64}$/i.test(s);

export function parseManifest(buf: Buffer): Manifest {
  let j: any;
  try { j = JSON.parse(buf.toString('utf8')); } catch { throw new UpdateError('version.json is not valid JSON'); }
  if (!j || typeof j !== 'object') throw new UpdateError('version.json has an unexpected shape');
  if (!isSemver(j.version)) throw new UpdateError('version.json has no valid "version"');
  const b = j.bridge;
  const bPath = b?.file ?? b?.path;
  if (!b || !safeRelPath(bPath) || !isSha(b.sha256)) throw new UpdateError('version.json "bridge" entry is invalid');
  const files: Record<string, ManifestFile> = {};
  const pf = j.plugin?.files ?? {};
  if (typeof pf !== 'object' || Array.isArray(pf)) throw new UpdateError('version.json "plugin.files" is invalid');
  const names = Object.keys(pf);
  if (names.length > MAX_PLUGIN_FILES) throw new UpdateError('version.json lists too many plugin files');
  for (const name of names) {
    const f = pf[name];
    if (!safeFileName(name) || !f || !safeRelPath(f.path) || !isSha(f.sha256)) {
      throw new UpdateError(`version.json plugin file entry "${name}" is invalid`);
    }
    files[name] = { path: f.path, sha256: f.sha256.toLowerCase(), bytes: typeof f.bytes === 'number' ? f.bytes : undefined };
  }
  return {
    version: j.version,
    bridge: { path: bPath, sha256: b.sha256.toLowerCase(), bytes: typeof b.bytes === 'number' ? b.bytes : undefined },
    plugin: { files },
  };
}

export async function fetchManifest(base: string = updateBase()): Promise<Manifest> {
  const buf = await httpGet(new URL(MANIFEST_PATH, base).toString(), {
    maxBytes: MANIFEST_MAX_BYTES,
    timeoutMs: MANIFEST_TIMEOUT_MS,
  });
  return parseManifest(buf);
}

// ---------- check + state ----------

export interface UpdateState {
  current: string;
  latest: string | null;
  available: boolean;
  checkedAt: string | null;   // ISO timestamp of the last SUCCESSFUL check
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
    writeFileSync(cachePath(), JSON.stringify({ current: s.current, latest: s.latest, available: s.available, checkedAt: s.checkedAt }, null, 2));
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
    };
  } catch { return null; }
}

// One network check. Never throws: on any failure it logs one stderr line and
// returns the previous state (plus `error`). Does NOT consult
// GRIP_NO_UPDATE_CHECK — callers decide whether a check is allowed.
export async function checkForUpdate(base: string = updateBase()): Promise<UpdateState> {
  try {
    const m = await fetchManifest(base);
    const next: UpdateState = {
      current: BRIDGE_VERSION,
      latest: m.version,
      available: compareSemver(m.version, BRIDGE_VERSION) > 0,
      checkedAt: new Date().toISOString(),
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

export function updateNoticeText(s: UpdateState): string {
  return `Grip update available: ${s.current} → ${s.latest}. Tell the user and ask whether they want to update. ` +
    `Do NOT install it on your own: only if the user explicitly says yes, call grip_update {action:'install'}.`;
}
export function updateInstructionsParagraph(s: UpdateState): string {
  return `\n\nA Grip update is available (${s.current} → ${s.latest}). Mention it to the user once, at a natural moment, ` +
    `and ask if they want it. Never install without their explicit yes; if they agree, call grip_update {action:'install'}.`;
}

// ---------- install ----------

export interface InstallResult {
  status: 'updated' | 'up_to_date' | 'already_installing';
  from?: string;
  to?: string;
  home?: string;
  pluginFilesWritten?: string[];
  restart?: 'scheduled' | 'not_managed' | 'none';
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

async function downloadVerified(base: string, label: string, f: ManifestFile): Promise<Buffer> {
  const cap = FILE_MAX_BYTES;
  let buf: Buffer;
  try {
    buf = await httpGet(new URL(f.path, base).toString(), { maxBytes: cap, timeoutMs: DOWNLOAD_TIMEOUT_MS });
  } catch (err) {
    throw new UpdateError(`could not download ${label}: ${(err as Error).message}. Nothing was changed; try again in a few minutes.`);
  }
  if (f.bytes !== undefined && f.bytes !== buf.length) {
    throw new UpdateError(`${label} size mismatch (manifest ${f.bytes}, got ${buf.length}). The CDN may be serving an older copy; nothing was changed, retry in a few minutes.`);
  }
  if (sha256(buf) !== f.sha256) {
    throw new UpdateError(`${label} failed its sha256 check against version.json. The CDN may be lagging behind the release; nothing was changed, retry in a few minutes.`);
  }
  return buf;
}

// The install routine shared by the MCP tool, the plugin's update_request and
// the CLI. Everything is downloaded AND verified in memory before the first
// byte is written, so a failure at any point leaves ~/.grip untouched.
// Does not restart anything — see installAndScheduleRestart().
export async function installUpdate(o: { base?: string } = {}): Promise<InstallResult> {
  if (installing) return { status: 'already_installing' };
  installing = true;
  try {
    const base = o.base ?? updateBase();
    const manifest = await fetchManifest(base).catch((err: Error) => {
      throw new UpdateError(`could not read the release manifest: ${err.message}`);
    });
    // Keep the shared state honest even though this wasn't a scheduled check.
    const available = compareSemver(manifest.version, BRIDGE_VERSION) > 0;
    setState({ current: BRIDGE_VERSION, latest: manifest.version, available, checkedAt: new Date().toISOString() });
    if (!available) return { status: 'up_to_date', from: BRIDGE_VERSION, to: manifest.version };

    // 1. download + verify everything first
    const bridgeBuf = await downloadVerified(base, 'the bridge', manifest.bridge);
    const pluginBufs: Array<[string, Buffer]> = [];
    for (const [name, f] of Object.entries(manifest.plugin.files)) {
      pluginBufs.push([name, await downloadVerified(base, `plugin file ${name}`, f)]);
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

    logErr(`update: installed ${BRIDGE_VERSION} -> ${manifest.version} into ${home}`);
    return { status: 'updated', from: BRIDGE_VERSION, to: manifest.version, home, pluginFilesWritten: written };
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
export async function installAndScheduleRestart(): Promise<InstallResult> {
  const r = await installUpdate();
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
// {type:'update', available, latest} to every plugin (on hello and on change),
// and a plugin's {type:'update_request'} (the user's second click on the
// indicator) runs the same install routine as the grip_update tool. The
// outcome goes back as {type:'update_result', status, from?, to?, message?}.
export function wireUpdateToBridge(bridge: PluginBridge): () => void {
  const push = (s: UpdateState | null) => bridge.setUpdateState(s ? { available: s.available, latest: s.latest } : null);
  push(getUpdateState());
  const off = onUpdateState(push);
  const onRequest = async (e: { sessionId: string }) => {
    let msg: Record<string, unknown>;
    try {
      const r = await installAndScheduleRestart();
      msg = { type: 'update_result', status: r.status, from: r.from, to: r.to, restart: r.restart };
    } catch (err) {
      msg = { type: 'update_result', status: 'error', message: (err as Error).message };
    }
    bridge.sendTo(e.sessionId, msg);
  };
  bridge.on('update-request', onRequest);
  return () => { off(); bridge.off('update-request', onRequest); };
}
