// `remove-foreign`: removal of a FOREIGN Grip build (a watchlist entry) that the guard found.
// Two halves: a PURE planner (planForeignRemoval: facts in, an ordered list of items out, no
// I/O, any OS from any host) and a thin executor (runPlan, below) that is the only code that
// touches the system, through the small ExecIo adapter.
import { execFile as nodeExecFile, execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import type { WatchEntry } from './flavour.gen.js';
import { foreignPaths, homeSafeToDelete, mcpEntryIsForeign, type ForeignCtx, type HomeFacts, type McpEntry } from './foreign-paths.js';
import type { DetectIo, ForeignFinding } from './foreign-detect.js';
import { isDaemonCommand, processCommandLine } from './update.js';

export type PlanKind =
  | 'macos-login-item' | 'launch-agent' | 'systemd-unit' | 'xdg-autostart' | 'startup-launcher'
  | 'stop-supervisor' | 'stop-daemon' | 'app-bundle' | 'mcp-entry' | 'ipc-socket'
  | 'log-file' | 'status-file' | 'home-dir' | 'systemd-reload' | 'plugin-note';

export type PlanAction = 'disable' | 'unload' | 'stop' | 'delete' | 'run' | 'run-cli-or-edit-json' | 'instruct' | 'refuse';

export interface PlanItem { kind: PlanKind; target: string; action: PlanAction; note?: string }

export interface ForeignFacts {
  pid: number | null;
  running: boolean;
  // keyed by the absolute paths foreignPaths() returns
  exists: Record<string, boolean>;
  home: HomeFacts;
  mcp: { entry: McpEntry | undefined; claudeCli: boolean };
  pluginCopies: string[];
}

export function planForeignRemoval(ctx: ForeignCtx, e: WatchEntry, f: ForeignFacts): PlanItem[] {
  const paths = foreignPaths(ctx, e);
  const has = (p: string | null) => !!p && f.exists[p] === true;
  const items: PlanItem[] = [];
  const apps = paths.autostart.filter((a) => a.kind === 'app-bundle' && has(a.path));
  const plist = paths.autostart.find((a) => a.kind === 'launch-agent' && has(a.path));
  const unit = paths.autostart.find((a) => a.kind === 'systemd-unit' && has(a.path));
  const xdg = paths.autostart.find((a) => a.kind === 'xdg-autostart' && has(a.path));
  const startup = paths.autostart.find((a) => a.kind === 'startup-launcher' && has(a.path));

  // 1. autostart off first (a supervised daemon would otherwise come straight back)
  if (ctx.platform === 'darwin') {
    if (apps.length) items.push({ kind: 'macos-login-item', target: e.loginItem, action: 'disable' });
    if (plist) items.push({ kind: 'launch-agent', target: plist.path, action: 'unload' });
  }
  if (unit) items.push({ kind: 'systemd-unit', target: e.serviceName, action: 'disable' });
  if (xdg) items.push({ kind: 'xdg-autostart', target: xdg.path, action: 'delete' });
  if (startup) items.push({ kind: 'startup-launcher', target: startup.path, action: 'delete' });

  // 2. the supervisor (macOS login item loop), then the daemon
  if (ctx.platform === 'darwin' && f.running && f.pid !== null && (apps.length || plist)) {
    items.push({ kind: 'stop-supervisor', target: `parent of pid ${f.pid}`, action: 'stop' });
  }
  if (f.running) {
    if (f.pid !== null) items.push({ kind: 'stop-daemon', target: `pid ${f.pid}`, action: 'stop' });
    else items.push({ kind: 'stop-daemon', target: `port ${e.wsPort}`, action: 'instruct', note: `it is running on port ${e.wsPort} but the process could not be identified, so it is not stopped; quit it yourself (Activity Monitor, Task Manager or your service manager)` });
  }

  // 3. deletions, the home folder last
  for (const a of apps) items.push({ kind: 'app-bundle', target: a.path, action: 'delete' });
  if (plist) items.push({ kind: 'launch-agent', target: plist.path, action: 'delete' });
  if (unit) {
    items.push({ kind: 'systemd-unit', target: unit.path, action: 'delete' });
    items.push({ kind: 'systemd-reload', target: 'systemctl --user daemon-reload', action: 'run' });
  }
  if (f.mcp.entry && mcpEntryIsForeign(ctx, e, f.mcp.entry)) items.push({ kind: 'mcp-entry', target: e.mcpName, action: 'run-cli-or-edit-json' });
  if (ctx.platform !== 'win32' && has(paths.ipcSocket)) items.push({ kind: 'ipc-socket', target: paths.ipcSocket!, action: 'delete' });
  if (has(paths.logFile)) items.push({ kind: 'log-file', target: paths.logFile, action: 'delete' });
  if (has(paths.statusFile)) items.push({ kind: 'status-file', target: paths.statusFile, action: 'delete' });
  if (f.home.kind !== 'missing') {
    const v = homeSafeToDelete(ctx, e, f.home);
    items.push(v.ok
      ? { kind: 'home-dir', target: paths.homeDir, action: 'delete' }
      : { kind: 'home-dir', target: paths.homeDir, action: 'refuse', note: v.reason });
  }

  // 4. the imported Figma plugin is removed by hand, in Figma (no file is touched)
  if (f.pluginCopies.length > 0 || has(paths.figmaSettings)) {
    items.push({ kind: 'plugin-note', target: 'imported plugin in Figma', action: 'instruct', note: 'remove it in Figma: Plugins, Development, right-click the plugin, Remove' });
  }
  return items;
}

const VERB: Record<PlanAction, string> = {
  disable: 'turn off', unload: 'unload', stop: 'stop', delete: 'delete', run: 'run',
  'run-cli-or-edit-json': 'remove the MCP entry', instruct: 'by hand', refuse: 'will NOT touch',
};

export function formatPlan(items: PlanItem[]): string[] {
  return items.map((i) => `${VERB[i.action]}: ${i.target}${i.note ? ` (${i.note})` : ''}`);
}

// ====================== executor ======================
// Everything below acts on the system, and only through ExecIo, so tests use fakes and
// temp directories. Nothing runs unless `yes` is exactly true.

export interface ExecIo {
  execFile(cmd: string, args: string[]): Promise<{ ok: boolean; out: string }>;
  procCommand(pid: number): string | null;
  parentPid(pid: number): number | null;
  kill(pid: number, signal: 'SIGTERM' | 'SIGKILL'): boolean;
  pidAlive(pid: number): boolean;
  portOpen(port: number): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  lstatKind(path: string): HomeFacts['kind'];
  realpath(path: string): string | null;
  rm(path: string): void;
  readJson(path: string): unknown;
  writeJson(path: string, v: unknown): void;
}

export type ItemStatus = 'done' | 'skipped' | 'refused' | 'failed' | 'deferred' | 'instruct';
export interface ItemResult { item: PlanItem; status: ItemStatus; note?: string }
export interface RunOptions { yes: boolean; graceMs?: number; deleteRetries?: number }

const LOCK_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY']);
const NOT_LOADED = /not (loaded|found)|no such|could not find|does not exist|not-found/i;
const pidOf = (target: string): number | null => {
  const m = /(\d+)\s*$/.exec(target);
  const n = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(n) && n > 1 ? n : null;
};

type Outcome = Pick<ItemResult, 'status' | 'note'>;

export async function runPlan(ctx: ForeignCtx, e: WatchEntry, items: PlanItem[], io: ExecIo, o: RunOptions): Promise<ItemResult[]> {
  // The gate: without an explicit yes nothing is touched and no adapter is called.
  if (o.yes !== true) return items.map((item) => ({ item, status: 'skipped' as const, note: 'not run: --yes was not given' }));
  const grace = o.graceMs ?? 5000;
  const retries = o.deleteRetries ?? 6;
  const paths = foreignPaths(ctx, e);
  // the only paths this executor will ever delete (the home folder has its own, stricter check)
  const allowed = new Set<string>([...paths.autostart.map((a) => a.path), paths.logFile, paths.statusFile]);
  if (paths.ipcSocket) allowed.add(paths.ipcSocket);
  let daemonBlocked = false;

  const waitGone = async (pid: number, ms: number): Promise<boolean> => {
    const t0 = Date.now();
    const step = Math.max(1, Math.min(50, ms));
    while (io.pidAlive(pid)) {
      if (Date.now() - t0 >= ms) return false;
      await io.sleep(step);
    }
    return true;
  };
  const waitPortClosed = async (ms: number) => {
    const t0 = Date.now();
    while (await io.portOpen(e.wsPort)) {
      if (Date.now() - t0 >= ms) return;
      await io.sleep(Math.max(1, Math.min(50, ms)));
    }
  };
  // retry a locked file with backoff (Windows holds the files of a running process)
  const rmRetry = async (target: string): Promise<Outcome> => {
    for (let i = 0; ; i++) {
      try { io.rm(target); return { status: 'done' }; }
      catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return { status: 'done', note: 'already gone' };
        if (!code || !LOCK_CODES.has(code)) return { status: 'failed', note: (err as Error).message };
        if (i >= retries) return { status: 'deferred', note: 'in use by another program: will be removable after restart' };
        await io.sleep(Math.min(200 * 2 ** i, 3000));
      }
    }
  };
  const classify = (r: { ok: boolean; out: string }): Outcome =>
    r.ok ? { status: 'done' } : NOT_LOADED.test(r.out) ? { status: 'skipped', note: 'was not loaded' } : { status: 'failed', note: r.out.slice(0, 200) || 'the command failed' };

  // a plain delete of one exact, known path
  const del = async (item: PlanItem): Promise<Outcome> => {
    if (!allowed.has(item.target)) return { status: 'refused', note: 'not a path this tool removes' };
    if (daemonBlocked) return { status: 'skipped', note: 'daemon still running' };
    const kind = io.lstatKind(item.target);
    if (kind === 'missing') return { status: 'skipped', note: 'already gone' };
    if (item.kind !== 'app-bundle' && kind === 'dir') return { status: 'refused', note: 'is a directory, not a file' };
    return rmRetry(item.target);
  };

  const run = async (item: PlanItem): Promise<Outcome> => {
    if (item.action === 'refuse') return { status: 'refused', note: item.note };
    if (item.action === 'instruct') return { status: 'instruct', note: item.note };
    switch (item.kind) {
      case 'macos-login-item':
        return classify(await io.execFile('osascript', ['-e', `tell application "System Events" to delete (every login item whose name is "${e.loginItem}")`]));
      case 'launch-agent':
        if (item.action === 'unload') {
          if (ctx.uid === null) return { status: 'skipped', note: 'no user id' };
          return classify(await io.execFile('launchctl', ['bootout', `gui/${ctx.uid}/${e.launchLabel}`]));
        }
        return del(item);
      case 'systemd-unit':
        if (item.action === 'disable') return classify(await io.execFile('systemctl', ['--user', 'disable', '--now', e.serviceName]));
        return del(item);
      case 'systemd-reload': {
        const r = await io.execFile('systemctl', ['--user', 'daemon-reload']);
        return r.ok ? { status: 'done' } : { status: 'skipped', note: 'systemctl did not answer' };
      }
      case 'stop-supervisor': {
        const child = pidOf(item.target);
        const parent = child === null ? null : io.parentPid(child);
        if (parent === null || parent <= 1) return { status: 'skipped', note: 'no supervisor found' };
        if (!io.pidAlive(parent)) return { status: 'skipped', note: 'already stopped' };
        const cmd = io.procCommand(parent);
        if (!cmd || !cmd.includes(`${e.loginItem}.app`)) return { status: 'refused', note: `pid ${parent} is not the ${e.loginItem} login item; left alone` };
        io.kill(parent, 'SIGTERM');
        return (await waitGone(parent, grace)) ? { status: 'done' } : { status: 'failed', note: `pid ${parent} did not exit` };
      }
      case 'stop-daemon': {
        const pid = pidOf(item.target);
        if (pid === null) return { status: 'refused', note: 'no process id' };
        if (!io.pidAlive(pid)) return { status: 'skipped', note: 'already stopped' };
        // never trust a pid file alone: the command line must be that build's daemon
        const cmd = io.procCommand(pid);
        if (!cmd) return { status: 'refused', note: `could not verify what pid ${pid} is; left running` };
        if (!isDaemonCommand(cmd, e.entryName)) return { status: 'refused', note: `pid ${pid} does not look like the ${e.slug} daemon; left alone` };
        io.kill(pid, 'SIGTERM');
        let gone = await waitGone(pid, grace);
        if (!gone) {
          io.kill(pid, 'SIGKILL');
          gone = await waitGone(pid, Math.min(grace, 2000));
        }
        if (!gone) { daemonBlocked = true; return { status: 'failed', note: `pid ${pid} would not exit` }; }
        await waitPortClosed(grace);
        return { status: 'done' };
      }
      case 'mcp-entry': {
        // verify the entry first: `claude mcp remove` deletes by NAME, whatever the entry points at
        const cfgPath = paths.claudeConfig;
        let cfg: any;
        try { cfg = io.readJson(cfgPath); } catch { return { status: 'skipped', note: 'could not read the MCP config; left alone' }; }
        const entry = cfg?.mcpServers?.[e.mcpName];
        if (!entry) return { status: 'skipped', note: 'no such MCP entry' };
        if (!mcpEntryIsForeign(ctx, e, entry)) return { status: 'refused', note: `the "${e.mcpName}" MCP entry does not point at the ${e.slug} bridge; left alone` };
        if ((await io.execFile('claude', ['mcp', 'remove', '-s', 'user', e.mcpName])).ok) return { status: 'done', note: 'via claude mcp remove' };
        try {
          delete cfg.mcpServers[e.mcpName];
          io.writeJson(cfgPath, cfg);
          return { status: 'done', note: `edited ${cfgPath}` };
        } catch (err) { return { status: 'failed', note: (err as Error).message }; }
      }
      case 'home-dir': {
        if (item.target !== paths.homeDir) return { status: 'refused', note: 'not the folder this tool removes' };
        if (daemonBlocked) return { status: 'skipped', note: 'daemon still running' };
        // fresh facts, right before the delete: whatever the plan saw, a swapped folder is refused
        const verdict = homeSafeToDelete(ctx, e, { kind: io.lstatKind(item.target), realpath: io.realpath(item.target), parentRealpath: io.realpath(ctx.home) });
        if (!verdict.ok) return { status: 'refused', note: verdict.reason };
        return rmRetry(item.target);
      }
      case 'app-bundle': case 'xdg-autostart': case 'startup-launcher': case 'ipc-socket': case 'log-file': case 'status-file':
        return del(item);
      default:
        return { status: 'refused', note: 'unknown item' };
    }
  };

  const results: ItemResult[] = [];
  for (const item of items) {
    let r: Outcome;
    try { r = await run(item); } catch (err) { r = { status: 'failed', note: (err as Error).message }; }
    results.push({ item, ...r });
  }
  return results;
}

// Facts for the planner from the real (or fake) machine. Read-only. (A plugin copy imported into
// Figma is not looked for: the watchlist has no plugin id, so removal of it is a hand-off.)
export async function collectFacts(ctx: ForeignCtx, e: WatchEntry, finding: ForeignFinding, detect: DetectIo, exec: ExecIo): Promise<ForeignFacts> {
  const paths = foreignPaths(ctx, e);
  const exists: Record<string, boolean> = {};
  for (const a of paths.autostart) exists[a.path] = detect.exists(a.path);
  for (const k of [paths.statusFile, paths.logFile, paths.ipcSocket, paths.figmaSettings]) if (k) exists[k] = detect.exists(k);
  let entry: McpEntry | undefined;
  try { entry = (exec.readJson(paths.claudeConfig) as any)?.mcpServers?.[e.mcpName]; } catch { /* no config */ }
  return {
    pid: finding.pid,
    running: finding.running,
    exists,
    home: { kind: exec.lstatKind(paths.homeDir), realpath: exec.realpath(paths.homeDir), parentRealpath: exec.realpath(ctx.home) },
    mcp: { entry, claudeCli: false },
    pluginCopies: [],
  };
}

export function realExecIo(): ExecIo {
  return {
    execFile: (cmd, args) => new Promise((resolve) => {
      nodeExecFile(cmd, args, { timeout: 15_000, windowsHide: true }, (err, stdout, stderr) => {
        resolve({ ok: !err, out: `${stdout ?? ''}${stderr ?? ''}${err && !stderr ? err.message : ''}`.trim() });
      });
    }),
    procCommand: (pid) => processCommandLine(pid),
    parentPid: (pid) => {
      if (process.platform === 'win32') return null;
      try {
        const n = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim());
        return Number.isSafeInteger(n) && n > 0 ? n : null;
      } catch { return null; }
    },
    kill: (pid, signal) => { try { process.kill(pid, signal); return true; } catch { return false; } },
    pidAlive: (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; } },
    portOpen: (port) => new Promise((resolve) => {
      const s = netConnect({ host: '127.0.0.1', port });
      const done = (v: boolean) => { s.destroy(); resolve(v); };
      s.setTimeout(500, () => done(false));
      s.once('connect', () => done(true));
      s.once('error', () => done(false));
    }),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    lstatKind: (path) => {
      try {
        const st = lstatSync(path);
        return st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : 'file';
      } catch (err) { return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'file'; }
    },
    realpath: (path) => { try { return realpathSync(path); } catch { return null; } },
    // rmSync removes a symbolic link itself and never follows it
    rm: (path) => rmSync(path, { recursive: true, force: false }),
    readJson: (path) => JSON.parse(readFileSync(path, 'utf8')),
    writeJson: (path, v) => writeFileSync(path, JSON.stringify(v, null, 2)),
  };
}
