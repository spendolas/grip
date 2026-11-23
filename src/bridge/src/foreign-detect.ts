// Read-only detection of a FOREIGN Grip bridge (a watchlist entry). It never executes foreign
// code: it reads a few small files, checks that a pid is alive, and (probe) opens a WebSocket,
// reads the welcome frame the bridge sends on its own and hangs up without sending anything.
// All I/O goes through DetectIo, so the verdict logic is tested with fakes on any OS.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import type { WatchEntry } from './flavour.gen.js';
import { foreignPaths, mcpEntryIsForeign, type ForeignCtx } from './foreign-paths.js';
import { compareSemver, isSemver } from './update.js';

export type ForeignState = 'none' | 'ok' | 'insecure' | 'unknown_service';

export type ProbeResult =
  | { kind: 'welcome'; version: string | null; flavour: string | null }
  | { kind: 'other' }
  | { kind: 'closed' };

export interface DetectIo extends ForeignCtx {
  probe(port: number, timeoutMs: number): Promise<ProbeResult>;
  readText(path: string, maxBytes: number): string | null;
  exists(path: string): boolean;
  pidAlive(pid: number): boolean;
}

export interface ForeignFinding {
  slug: string;
  state: ForeignState;
  version: string | null;
  floor: string;
  evidence: string[];
  running: boolean;
  pid: number | null;
}

export interface ForeignReport {
  findings: ForeignFinding[];
  worst: ForeignFinding | null;
  checkedAt: string;
  // the overall time limit hit before every entry answered: do not trust this report over the last complete one
  incomplete?: boolean;
}

const PROBE_TIMEOUT_MS = 2000;
const TOTAL_TIMEOUT_MS = 3000;
const SMALL_FILE = 64 * 1024;
const CONFIG_FILE = 8 * 1024 * 1024;
const SEVERITY: Record<ForeignState, number> = { none: 0, ok: 1, unknown_service: 2, insecure: 3 };

function parseJson(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const j = JSON.parse(text);
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
  } catch { return null; }
}
const str = (v: unknown): string | null => (typeof v === 'string' ? v.slice(0, 64) : null);
// Everything the foreign side says is data, never text: only a plain x.y.z version is ever carried on.
const semverOrNull = (v: string | null): string | null => (v !== null && isSemver(v) ? v : null);
// the higher of two parseable versions; a parseable one beats an unparseable one
function higher(a: string | null, b: string | null): string | null {
  const sa = semverOrNull(a), sb = semverOrNull(b);
  if (sa && sb) return compareSemver(sa, sb) >= 0 ? sa : sb;
  return sa ?? sb ?? a ?? b;
}
const plainName = (n: string) => (/^[A-Za-z0-9._-]{1,64}$/.test(n) ? n : '<unusual name>');

async function detectOne(e: WatchEntry, io: DetectIo): Promise<ForeignFinding> {
  const paths = foreignPaths(io, e);
  const evidence: string[] = [];

  let probe: ProbeResult = { kind: 'closed' };
  try { probe = await io.probe(e.wsPort, PROBE_TIMEOUT_MS); } catch { /* treated as nothing listening */ }
  // A welcome that names another flavour is some other build on that port, not the watched one.
  const welcomeIsForeign = probe.kind === 'welcome' && (probe.flavour === null || probe.flavour === e.slug);
  const foreignWelcome = welcomeIsForeign && probe.kind === 'welcome' ? probe : null;
  const unknownListener = probe.kind === 'other' || (probe.kind === 'welcome' && !welcomeIsForeign);

  const status = parseJson(io.readText(paths.statusFile, SMALL_FILE));
  const statusPid = status && Number.isSafeInteger(status.pid) && (status.pid as number) > 1 ? (status.pid as number) : null;
  const statusAlive = statusPid !== null && io.pidAlive(statusPid);
  const statusVersion = status ? str(status.version) : null;
  const install = parseJson(io.readText(paths.installJson, SMALL_FILE));
  const installVersion = install ? str(install.version) : null;
  const entryFile = io.exists(paths.entryFile);

  const present = !!foreignWelcome || statusAlive || !!install || entryFile;

  const shown = (v: string | null) => semverOrNull(v) ?? 'unknown';
  if (foreignWelcome) evidence.push(`listening on port ${e.wsPort} (version ${shown(foreignWelcome.version)})`);
  if (statusAlive) evidence.push(`status file: pid ${statusPid} alive`);
  if (status && statusVersion !== null) evidence.push(`status file: version ${shown(statusVersion)}`);
  if (installVersion !== null) evidence.push(`install.json: version ${shown(installVersion)}`);
  if (entryFile) evidence.push('entry file present');
  if (unknownListener) evidence.push(`unknown service on port ${e.wsPort}`);
  for (const a of paths.autostart) if (io.exists(a.path)) evidence.push(`autostart: ${a.path}`);
  const cfg = parseJson(io.readText(paths.claudeConfig, CONFIG_FILE));
  const servers = cfg && cfg.mcpServers && typeof cfg.mcpServers === 'object' ? (cfg.mcpServers as Record<string, unknown>) : null;
  if (servers) {
    for (const [name, v] of Object.entries(servers)) {
      if (v && typeof v === 'object' && mcpEntryIsForeign(io, e, v as never)) evidence.push(`mcp entry: ${plainName(name)}`);
    }
  }

  // a stale status file (its process is gone) must not outvote the installed version
  const fileVersion = statusAlive ? higher(statusVersion, installVersion) : (installVersion ?? statusVersion);
  const version = foreignWelcome ? foreignWelcome.version : present ? fileVersion : null;
  const running = !!foreignWelcome || statusAlive;
  let state: ForeignState;
  if (present) {
    state = version !== null && isSemver(version) && compareSemver(version, e.minSecureVersion) >= 0 ? 'ok' : 'insecure';
  } else if (unknownListener) {
    state = 'unknown_service';
  } else {
    state = 'none';
  }
  return { slug: e.slug, state, version: present ? semverOrNull(version) : null, floor: e.minSecureVersion, evidence, running, pid: statusAlive ? statusPid : null };
}

export async function detectForeign(entries: readonly WatchEntry[], io: DetectIo): Promise<ForeignReport> {
  const checkedAt = new Date().toISOString();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((res) => { timer = setTimeout(() => res(null), TOTAL_TIMEOUT_MS); });
  try {
    const all = Promise.all(entries.map((e) => detectOne(e, io).catch((): ForeignFinding => ({ slug: e.slug, state: 'none', version: null, floor: e.minSecureVersion, evidence: [], running: false, pid: null }))));
    const raced = await Promise.race([all, timeout]);
    if (raced === null) return { findings: [], worst: null, checkedAt, incomplete: true };
    const findings = raced;
    let worst: ForeignFinding | null = null;
    for (const f of findings) {
      if (f.state === 'none') continue;
      if (!worst || SEVERITY[f.state] > SEVERITY[worst.state]) worst = f;
    }
    return { findings, worst, checkedAt };
  } catch {
    return { findings: [], worst: null, checkedAt, incomplete: true };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------- the real thing ----------

// Connect, read ONE welcome frame, hang up. Sends nothing. Always resolves by `timeoutMs`.
function realProbe(port: number, timeoutMs: number): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let done = false;
    let ws: WebSocket | null = null;
    const finish = (r: ProbeResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws?.terminate(); } catch { /* already gone */ }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ kind: 'other' }), timeoutMs);
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}`, { handshakeTimeout: timeoutMs + 1000, maxPayload: 4096, perMessageDeflate: false });
    } catch { finish({ kind: 'closed' }); return; }
    ws.on('error', (err: NodeJS.ErrnoException) => finish(err && err.code === 'ECONNREFUSED' ? { kind: 'closed' } : { kind: 'other' }));
    ws.on('unexpected-response', () => finish({ kind: 'other' }));
    ws.on('close', () => finish({ kind: 'other' }));
    ws.on('message', (data, isBinary) => {
      if (isBinary) return finish({ kind: 'other' });
      const text = String(data);
      if (text.length > 4096) return finish({ kind: 'other' });
      try {
        const j = JSON.parse(text);
        if (j && typeof j === 'object' && j.kind === 'welcome') {
          return finish({ kind: 'welcome', version: str(j.bridgeVersion), flavour: str(j.flavour) });
        }
      } catch { /* not JSON */ }
      finish({ kind: 'other' });
    });
  });
}

export function realDetectIo(): DetectIo {
  return {
    platform: process.platform,
    home: homedir(),
    tmp: tmpdir(),
    env: process.env,
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    probe: realProbe,
    readText: (path, maxBytes) => {
      try {
        if (statSync(path).size > maxBytes) return null;
        return readFileSync(path, 'utf8');
      } catch { return null; }
    },
    exists: (path) => { try { return existsSync(path); } catch { return false; } },
    pidAlive: (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } },
  };
}
