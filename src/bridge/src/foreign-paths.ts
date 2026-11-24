// Pure facts about where a FOREIGN Grip build (a watchlist entry) keeps its files, and the
// safety predicates the guard and `remove-foreign` rely on. No I/O: every function takes the
// platform and environment as data, so all three operating systems are testable anywhere.
import { posix, win32 } from 'node:path';
import type { WatchEntry } from './flavour.gen.js';

export interface ForeignCtx {
  platform: NodeJS.Platform;
  home: string;
  tmp: string;
  env: Record<string, string | undefined>;
  uid: number | null;
}

export interface AutostartPath {
  kind: 'app-bundle' | 'launch-agent' | 'systemd-unit' | 'xdg-autostart' | 'startup-launcher';
  path: string;
}

export interface ForeignPaths {
  homeDir: string;
  statusFile: string;
  logFile: string;
  installJson: string;
  entryFile: string;
  ipcSocket: string | null;
  ipcPipe: string | null;
  autostart: AutostartPath[];
  claudeConfig: string;
  figmaSettings: string | null;
}

export interface HomeFacts {
  kind: 'dir' | 'symlink' | 'file' | 'missing';
  realpath: string | null;
  parentRealpath: string | null;
}

export interface McpEntry { type?: string; url?: string; command?: string; args?: string[] }

// The path flavour for a platform, never the host's.
export function pathFor(platform: NodeJS.Platform): typeof posix {
  return platform === 'win32' ? win32 : posix;
}

export function foreignPaths(ctx: ForeignCtx, e: WatchEntry): ForeignPaths {
  const p = pathFor(ctx.platform);
  const homeDir = p.join(ctx.home, e.homeDirName);
  const autostart: AutostartPath[] = [];
  if (ctx.platform === 'darwin') {
    autostart.push({ kind: 'app-bundle', path: p.join(ctx.home, 'Applications', `${e.loginItem}.app`) });
    autostart.push({ kind: 'app-bundle', path: p.join('/Applications', `${e.loginItem}.app`) });
    autostart.push({ kind: 'launch-agent', path: p.join(ctx.home, 'Library', 'LaunchAgents', `${e.launchLabel}.plist`) });
  } else if (ctx.platform === 'win32') {
    const appdata = ctx.env.APPDATA || p.join(ctx.home, 'AppData', 'Roaming');
    autostart.push({ kind: 'startup-launcher', path: p.join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', e.startupLauncher) });
  } else {
    autostart.push({ kind: 'systemd-unit', path: p.join(ctx.home, '.config', 'systemd', 'user', `${e.serviceName}.service`) });
    autostart.push({ kind: 'xdg-autostart', path: p.join(ctx.home, '.config', 'autostart', `${e.serviceName}.desktop`) });
  }
  const cfgDir = ctx.env.CLAUDE_CONFIG_DIR;
  let figmaSettings: string | null = null;
  if (ctx.platform === 'darwin') figmaSettings = p.join(ctx.home, 'Library', 'Application Support', 'Figma', 'settings.json');
  else if (ctx.platform === 'win32' && ctx.env.APPDATA) figmaSettings = p.join(ctx.env.APPDATA, 'Figma', 'settings.json');
  return {
    homeDir,
    statusFile: p.join(ctx.home, e.statusFile),
    logFile: p.join(ctx.home, e.logFile),
    installJson: p.join(homeDir, 'install.json'),
    entryFile: p.join(homeDir, `${e.entryName}.mjs`),
    ipcSocket: ctx.platform === 'win32' ? null : p.join(ctx.tmp, `${e.ipcName}.sock`),
    ipcPipe: ctx.platform === 'win32' ? `\\\\.\\pipe\\${e.ipcName}` : null,
    autostart,
    claudeConfig: cfgDir ? p.join(cfgDir, '.claude.json') : p.join(ctx.home, '.claude.json'),
    figmaSettings,
  };
}

const foldCase = (platform: NodeJS.Platform) => (s: string) => (platform === 'win32' || platform === 'darwin' ? s.toLowerCase() : s);

// The ONLY test a delete of a foreign home folder passes: a single plain segment, an
// existing real directory (not a link, not a file), and a realpath that is exactly
// <realpath of the user's home>/<homeDirName>.
export function homeSafeToDelete(ctx: ForeignCtx, e: WatchEntry, h: HomeFacts): { ok: true } | { ok: false; reason: string } {
  const name = e.homeDirName;
  if (!name || name === '.' || name === '..' || /[\\/]/.test(name) || name.includes('\0')) return { ok: false, reason: `unsafe folder name "${name}"` };
  if (h.kind === 'missing') return { ok: false, reason: 'the folder does not exist' };
  if (h.kind === 'symlink') return { ok: false, reason: 'the folder is a symbolic link; not following it' };
  if (h.kind !== 'dir') return { ok: false, reason: 'the folder is not a directory' };
  if (!h.realpath || !h.parentRealpath) return { ok: false, reason: 'could not resolve the real path' };
  const p = pathFor(ctx.platform);
  const fold = foldCase(ctx.platform);
  const want = p.join(h.parentRealpath, name);
  if (fold(p.normalize(h.realpath)) !== fold(want)) return { ok: false, reason: `it resolves to ${h.realpath}, not ${want}` };
  return { ok: true };
}

// What belongs to THIS build, so a foreign-removal can never touch it (phase 2B fix wave).
export interface OwnIdentity {
  // this process, its parent and the daemon in OUR status file
  pids: number[];
  // our home folder (null when unknown) and every identity path of ours
  home: string | null;
  paths: string[];
}

const hasToken = (cmd: string, token: string) => new RegExp(`(^|\\s)${token}(\\s|$)`).test(cmd);

// Is `cmd` the command line of THAT foreign build's daemon? It must name the EXACT foreign entry
// file (case-folded on darwin/win32) followed by the end, a space or a quote, carry `--daemon` as
// a whole argument, and not point into OUR home folder. (Every flavour's entry file is called
// the same, so the bare name proves nothing.)
export function isForeignDaemonCommand(ctx: ForeignCtx, e: WatchEntry, cmd: string, own?: { home?: string | null }): boolean {
  const p = pathFor(ctx.platform);
  const fold = foldCase(ctx.platform);
  const entry = fold(foreignPaths(ctx, e).entryFile);
  const c = fold(cmd);
  if (!hasToken(c, '--daemon')) return false;
  if (own?.home && c.includes(fold(own.home + p.sep))) return false;
  let at = c.indexOf(entry);
  while (at >= 0) {
    const before = at === 0 ? ' ' : c[at - 1];
    const after = at + entry.length >= c.length ? ' ' : c[at + entry.length];
    if (/[\s"']/.test(before) && /[\s"']/.test(after)) return true;
    at = c.indexOf(entry, at + 1);
  }
  return false;
}

// The rotated log and the watchdog dump files the foreign daemon leaves next to its status file
// (named from its file prefix), and nothing else.
export function isForeignExtraFile(ctx: ForeignCtx, e: WatchEntry, path: string): boolean {
  const p = pathFor(ctx.platform);
  const fold = foldCase(ctx.platform);
  if (fold(p.dirname(path)) !== fold(p.normalize(ctx.home))) return false;
  const base = fold(p.basename(path));
  if (base === fold(`${e.logFile}.1`)) return true;
  if (!e.logFile.endsWith('.log')) return false;
  const prefix = fold(e.logFile.slice(0, -4)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${prefix}\\.dump-\\d+\\.json$`).test(base);
}

// True only when an MCP config entry points at the foreign bridge (its HTTP endpoint, or a
// path inside its home folder). An entry that merely has the same NAME but points at this
// build is not foreign.
export function mcpEntryIsForeign(ctx: ForeignCtx, e: WatchEntry, m: McpEntry | undefined): boolean {
  if (!m || typeof m !== 'object') return false;
  const p = pathFor(ctx.platform);
  const fold = foldCase(ctx.platform);
  if (typeof m.url === 'string') {
    for (const host of ['127.0.0.1', 'localhost']) {
      if (m.url === `http://${host}:${e.httpPort}/mcp`) return true;
    }
  }
  const prefix = fold(p.join(ctx.home, e.homeDirName) + p.sep);
  const cands = [m.command, ...(Array.isArray(m.args) ? m.args : [])].filter((x): x is string => typeof x === 'string');
  return cands.some((c) => fold(c).startsWith(prefix));
}
