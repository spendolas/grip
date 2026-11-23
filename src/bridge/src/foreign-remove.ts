// `remove-foreign`: removal of a FOREIGN Grip build (a watchlist entry) that the guard found.
// Two halves: a PURE planner (planForeignRemoval: facts in, an ordered list of items out, no
// I/O, any OS from any host) and a thin executor (runPlan, below) that is the only code that
// touches the system, through the small ExecIo adapter.
import { execFile as nodeExecFile, execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import type { WatchEntry } from './flavour.gen.js';
import { foreignPaths, homeSafeToDelete, isForeignDaemonCommand, isForeignExtraFile, mcpEntryIsForeign, pathFor, type ForeignCtx, type HomeFacts, type McpEntry, type OwnIdentity } from './foreign-paths.js';
import { liveIdentity } from './identity.js';
import type { DetectIo, ForeignFinding } from './foreign-detect.js';
import { processCommandLine } from './update.js';

export type PlanKind =
  | 'macos-login-item' | 'launch-agent' | 'systemd-unit' | 'xdg-autostart' | 'startup-launcher'
  | 'stop-supervisor' | 'stop-daemon' | 'app-bundle' | 'mcp-entry' | 'ipc-socket'
  | 'log-file' | 'status-file' | 'home-dir' | 'systemd-reload' | 'plugin-note';

export type PlanAction = 'disable' | 'unload' | 'stop' | 'delete' | 'run' | 'run-cli-or-edit-json' | 'instruct' | 'refuse';

// `pid` is typed (never re-parsed from the display text) on stop items
export interface PlanItem { kind: PlanKind; target: string; action: PlanAction; note?: string; pid?: number }

export interface ForeignFacts {
  pid: number | null;
  running: boolean;
  // keyed by the absolute paths foreignPaths() returns
  exists: Record<string, boolean>;
  home: HomeFacts;
  mcp: { entry: McpEntry | undefined; claudeCli: boolean };
  pluginCopies: string[];
  // the rotated log and watchdog dump files that exist (collectFacts lists them)
  extraFiles?: string[];
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
    items.push({ kind: 'stop-supervisor', target: `parent of pid ${f.pid}`, action: 'stop', pid: f.pid });
  }
  if (f.running) {
    if (f.pid !== null) items.push({ kind: 'stop-daemon', target: `pid ${f.pid}`, action: 'stop', pid: f.pid });
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
  for (const x of f.extraFiles ?? []) if (isForeignExtraFile(ctx, e, x)) items.push({ kind: 'log-file', target: x, action: 'delete' });
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
  return items.map((i) => `${i.kind === 'home-dir' && i.action === 'delete' ? 'delete the folder and everything in it' : VERB[i.action]}: ${i.target}${i.note ? ` (${i.note})` : ''}`);
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
  listDir(path: string): string[];
  readText(path: string, maxBytes: number): string | null;
  writeFile(path: string, data: string, mode: number): void;
  rename(from: string, to: string): void;
}

export type ItemStatus = 'done' | 'skipped' | 'refused' | 'failed' | 'deferred' | 'instruct';
export interface ItemResult { item: PlanItem; status: ItemStatus; note?: string }
export interface RunOptions { yes: boolean; graceMs?: number; deleteRetries?: number; own?: OwnIdentity }

const NOT_LOADED = /not (loaded|found)|no such|could not find|does not exist|not-found/i;
const CONFIG_MAX = 8 * 1024 * 1024;

type Outcome = Pick<ItemResult, 'status' | 'note'>;

// What is OURS (this process, its parent, our daemon, our paths): never signalled, never deleted.
export function ownIdentity(): OwnIdentity {
  const id = liveIdentity();
  const pids = [process.pid, process.ppid];
  try {
    const n = Number(JSON.parse(readFileSync(id.statusPath, 'utf8'))?.pid);
    if (Number.isSafeInteger(n) && n > 1) pids.push(n);
  } catch { /* no status file */ }
  return { pids, home: id.home, paths: [id.home, id.statusPath, id.logPath, `${id.logPath}.1`, id.ipcPath, id.exportsDir] };
}

export async function runPlan(ctx: ForeignCtx, e: WatchEntry, items: PlanItem[], io: ExecIo, o: RunOptions): Promise<ItemResult[]> {
  // The gate: without an explicit yes nothing is touched and no adapter is called.
  if (o.yes !== true) return items.map((item) => ({ item, status: 'skipped' as const, note: 'not run: --yes was not given' }));
  const grace = o.graceMs ?? 5000;
  const retries = o.deleteRetries ?? 6;
  const own: OwnIdentity = o.own ?? { pids: [process.pid, process.ppid], home: null, paths: [] };
  const paths = foreignPaths(ctx, e);
  const p = pathFor(ctx.platform);
  const fold = (s: string) => (ctx.platform === 'win32' || ctx.platform === 'darwin' ? s.toLowerCase() : s);
  const ownSet = new Set([...own.paths, ...(own.home ? [own.home] : [])].map((x) => fold(p.normalize(x))));
  const isOwn = (t: string) => ownSet.has(fold(p.normalize(t)));
  const isWin = ctx.platform === 'win32';
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
  const waitPortClosed = async (ms: number): Promise<boolean> => {
    const t0 = Date.now();
    while (await io.portOpen(e.wsPort)) {
      if (Date.now() - t0 >= ms) return false;
      await io.sleep(Math.max(1, Math.min(50, ms)));
    }
    return true;
  };
  // Windows holds the files of a running process: those errors are retried, then "removable after restart".
  // Elsewhere only EBUSY is retried; a permission error is a plain failure with its remedy.
  const retryable = (code: string | undefined) => code === 'EBUSY' || (isWin && (code === 'EPERM' || code === 'ENOTEMPTY'));
  const rmRetry = async (target: string): Promise<Outcome> => {
    for (let i = 0; ; i++) {
      try { io.rm(target); return { status: 'done' }; }
      catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return { status: 'done', note: 'already gone' };
        if (!retryable(code)) {
          if (!isWin && (code === 'EPERM' || code === 'EACCES')) return { status: 'failed', note: 'permission denied: grant permission, or delete it yourself (in Finder on macOS)' };
          return { status: 'failed', note: (err as Error).message };
        }
        if (i >= retries) return { status: 'deferred', note: 'in use by another program: will be removable after restart' };
        await io.sleep(Math.min(200 * 2 ** i, 3000));
      }
    }
  };
  const classify = (r: { ok: boolean; out: string }): Outcome =>
    r.ok ? { status: 'done' } : NOT_LOADED.test(r.out) ? { status: 'skipped', note: 'was not loaded' } : { status: 'failed', note: r.out.slice(0, 200) || 'the command failed' };

  // Is this pid the foreign daemon? Never ours, and its command line names the EXACT foreign entry file.
  const verifyDaemon = (pid: number): { ok: true } | { ok: false; note: string; unreadable: boolean } => {
    if (own.pids.includes(pid) || pid === process.pid || pid === process.ppid) return { ok: false, note: `pid ${pid} is this program, its parent or this build's own daemon; left alone`, unreadable: false };
    const cmd = io.procCommand(pid);
    if (!cmd) return { ok: false, note: `could not verify what pid ${pid} is; left running`, unreadable: true };
    if (!isForeignDaemonCommand(ctx, e, cmd, { home: own.home })) return { ok: false, note: `pid ${pid} is not the ${e.slug} daemon; left alone`, unreadable: false };
    return { ok: true };
  };
  let unverifiedPid: number | null = null;

  // Before the folder, the status file or a log goes: the foreign port must be closed and no verified daemon alive.
  const daemonStillThere = async (): Promise<boolean> => {
    if (daemonBlocked) return true;
    if (unverifiedPid !== null && io.pidAlive(unverifiedPid)) return true;
    return io.portOpen(e.wsPort);
  };

  // a plain delete of one exact, known path
  const del = async (item: PlanItem): Promise<Outcome> => {
    const extra = isForeignExtraFile(ctx, e, item.target);
    if (!allowed.has(item.target) && !extra) return { status: 'refused', note: 'not a path this tool removes' };
    if (isOwn(item.target)) return { status: 'refused', note: "that is one of this build's own paths" };
    if (item.kind === 'log-file' || item.kind === 'status-file' || extra) {
      if (await daemonStillThere()) return { status: 'skipped', note: 'daemon still running' };
    } else if (daemonBlocked) return { status: 'skipped', note: 'daemon still running' };
    const kind = io.lstatKind(item.target);
    if (kind === 'missing') return { status: 'skipped', note: 'already gone' };
    if (item.kind !== 'app-bundle' && kind === 'dir') return { status: 'refused', note: 'is a directory, not a file' };
    if (item.kind === 'app-bundle') {
      // a recursive delete: only a bundle whose launcher really starts the foreign bridge
      const macos = p.join(item.target, 'Contents', 'MacOS');
      const entry = fold(paths.entryFile);
      const proves = io.listDir(macos).some((n) => { const t = io.readText(p.join(macos, n), 65536); return t !== null && fold(t).includes(entry); });
      if (!proves) return { status: 'refused', note: `its launcher does not start ${paths.entryFile}; left alone` };
    }
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
        // the CHILD daemon is verified first; the parent is only touched when the child is the foreign daemon
        const child = item.pid ?? null;
        if (child === null) return { status: 'refused', note: 'no process id' };
        if (!io.pidAlive(child)) return { status: 'skipped', note: 'already stopped' };
        const v = verifyDaemon(child);
        if (!v.ok) { if (v.unreadable) unverifiedPid = child; return { status: 'refused', note: v.note }; }
        const parent = io.parentPid(child);
        if (parent === null || parent <= 1) return { status: 'skipped', note: 'no supervisor found' };
        if (own.pids.includes(parent) || parent === process.pid || parent === process.ppid) return { status: 'refused', note: `pid ${parent} is this program, its parent or this build's own process; left alone` };
        if (!io.pidAlive(parent)) return { status: 'skipped', note: 'already stopped' };
        const cmd = fold(io.procCommand(parent) ?? '');
        const launcher = paths.autostart.filter((a) => a.kind === 'app-bundle').map((a) => fold(p.join(a.path, 'Contents', 'MacOS') + p.sep));
        if (!launcher.some((l) => cmd.includes(l))) return { status: 'refused', note: `pid ${parent} is not the ${e.loginItem} login item; left alone` };
        io.kill(parent, 'SIGTERM');
        if (await waitGone(parent, grace)) return { status: 'done' };
        daemonBlocked = true;
        return { status: 'failed', note: `pid ${parent} did not exit` };
      }
      case 'stop-daemon': {
        const pid = item.pid ?? null;
        if (pid === null) return { status: 'refused', note: 'no process id' };
        if (!io.pidAlive(pid)) return { status: 'skipped', note: 'already stopped' };
        // never trust a pid file alone: the command line must be that build's daemon, by its exact entry path
        const v = verifyDaemon(pid);
        if (!v.ok) { if (v.unreadable) unverifiedPid = pid; return { status: 'refused', note: v.note }; }
        io.kill(pid, 'SIGTERM');
        let gone = await waitGone(pid, grace);
        if (!gone) {
          io.kill(pid, 'SIGKILL');
          gone = await waitGone(pid, Math.min(grace, 2000));
        }
        if (!gone) { daemonBlocked = true; return { status: 'failed', note: `pid ${pid} would not exit` }; }
        if (!(await waitPortClosed(grace))) { daemonBlocked = true; return { status: 'failed', note: `port ${e.wsPort} is still open` }; }
        return { status: 'done' };
      }
      case 'mcp-entry': {
        // verify the entry first: `claude mcp remove` deletes by NAME, whatever the entry points at
        const cfgPath = paths.claudeConfig;
        const raw = io.readText(cfgPath, CONFIG_MAX);
        if (raw === null) return { status: 'skipped', note: 'could not read the MCP config; left alone' };
        let cfg: any;
        try { cfg = JSON.parse(raw); } catch { return { status: 'skipped', note: 'the MCP config is not valid JSON; left alone' }; }
        const entry = cfg?.mcpServers?.[e.mcpName];
        if (!entry) return { status: 'skipped', note: 'no such MCP entry' };
        if (!mcpEntryIsForeign(ctx, e, entry)) return { status: 'refused', note: `the "${e.mcpName}" MCP entry does not point at the ${e.slug} bridge; left alone` };
        if ((await io.execFile('claude', ['mcp', 'remove', '-s', 'user', e.mcpName])).ok) return { status: 'done', note: 'via claude mcp remove' };
        // Windows: no guessing at the config file; say what to run
        if (isWin) return { status: 'instruct', note: `the claude command could not be run; run: claude mcp remove -s user ${e.mcpName}` };
        // Elsewhere: back up, write a temp file, and replace the config only if nobody changed it meanwhile
        const ts = Date.now();
        const bak = `${cfgPath}.grip-remove-${ts}.bak`;
        const tmp = `${cfgPath}.grip-remove-${ts}.tmp`;
        try {
          io.writeFile(bak, raw, 0o600);
          delete cfg.mcpServers[e.mcpName];
          const indent = /^\{\r?\n([ \t]+)"/.exec(raw)?.[1] ?? 2;
          io.writeFile(tmp, JSON.stringify(cfg, null, indent) + (raw.endsWith('\n') ? '\n' : ''), 0o600);
          if (io.readText(cfgPath, CONFIG_MAX) !== raw) {
            io.rm(tmp);
            return { status: 'failed', note: `${cfgPath} changed while this ran; nothing was written (backup: ${bak}). Run: claude mcp remove -s user ${e.mcpName}` };
          }
          io.rename(tmp, cfgPath);
          return { status: 'done', note: `edited ${cfgPath} (backup: ${bak})` };
        } catch (err) {
          try { io.rm(tmp); } catch { /* none written */ }
          return { status: 'failed', note: (err as Error).message };
        }
      }
      case 'home-dir': {
        if (item.target !== paths.homeDir) return { status: 'refused', note: 'not the folder this tool removes' };
        if (isOwn(item.target)) return { status: 'refused', note: "that is this build's own home folder" };
        const real = io.realpath(item.target);
        const ownReal = own.home ? io.realpath(own.home) : null;
        if (real && ownReal && fold(real) === fold(ownReal)) return { status: 'refused', note: "it resolves to this build's own home folder" };
        // fresh facts, right before the delete: whatever the plan saw, a swapped folder is refused
        const verdict = homeSafeToDelete(ctx, e, { kind: io.lstatKind(item.target), realpath: real, parentRealpath: io.realpath(ctx.home) });
        if (!verdict.ok) return { status: 'refused', note: verdict.reason };
        if (await daemonStillThere()) return { status: 'skipped', note: 'daemon still running' };
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
  const p = pathFor(ctx.platform);
  const exists: Record<string, boolean> = {};
  for (const a of paths.autostart) exists[a.path] = detect.exists(a.path);
  for (const k of [paths.statusFile, paths.logFile, paths.ipcSocket, paths.figmaSettings]) if (k) exists[k] = detect.exists(k);
  let entry: McpEntry | undefined;
  try { entry = JSON.parse(exec.readText(paths.claudeConfig, CONFIG_MAX) ?? 'null')?.mcpServers?.[e.mcpName]; } catch { /* no config */ }
  const extraFiles = exec.listDir(ctx.home).map((n) => p.join(ctx.home, n)).filter((x) => isForeignExtraFile(ctx, e, x));
  return {
    pid: finding.pid,
    running: finding.running,
    exists,
    home: { kind: exec.lstatKind(paths.homeDir), realpath: exec.realpath(paths.homeDir), parentRealpath: exec.realpath(ctx.home) },
    mcp: { entry, claudeCli: false },
    pluginCopies: [],
    extraFiles,
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
    listDir: (path) => { try { return readdirSync(path); } catch { return []; } },
    readText: (path, maxBytes) => {
      try {
        if (lstatSync(path).size > maxBytes) return null;
        return readFileSync(path, 'utf8');
      } catch { return null; }
    },
    // exclusive create: never overwrites or follows an existing file
    writeFile: (path, data, mode) => writeFileSync(path, data, { mode, flag: 'wx' }),
    rename: (from, to) => renameSync(from, to),
  };
}
