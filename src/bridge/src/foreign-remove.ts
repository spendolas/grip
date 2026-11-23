// `remove-foreign`: removal of a FOREIGN Grip build (a watchlist entry) that the guard found.
// Two halves: a PURE planner (planForeignRemoval: facts in, an ordered list of items out, no
// I/O, any OS from any host) and a thin executor (runPlan, below) that is the only code that
// touches the system, through the small ExecIo adapter.
import type { WatchEntry } from './flavour.gen.js';
import { foreignPaths, homeSafeToDelete, mcpEntryIsForeign, type ForeignCtx, type HomeFacts, type McpEntry } from './foreign-paths.js';

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
