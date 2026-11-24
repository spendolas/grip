// The insecure-Grip guard: keeps the latest detection result of the watchlist, re-checks it
// (at start and every 60 s) and turns it into the words every alert surface shows. Alert
// only: nothing here ever blocks this build. A flavour with `enforcement:'off'` (the public
// one) or an empty watchlist never gets a guard at all.
import { join } from 'node:path';
import { FLAVOUR, type WatchEntry } from './flavour.gen.js';
import { liveIdentity } from './identity.js';
import { fileIdentity, type PluginBridge } from './ws-server.js';
import { isSemver } from './update.js';
import { detectForeign, realDetectIo, type DetectIo, type ForeignReport, type ForeignState } from './foreign-detect.js';

export interface OwnInfo { displayName: string; entryPath: string }

export interface ForeignSummary {
  state: ForeignState;
  version: string | null;
  floor: string;
  evidence: string[];
  action: string;
  slug: string;
}

export interface ForeignAlertTexts {
  tooltip: string;
  toast: string;
  instructions: string;
  notice: string;
  cliLines: string[];
}

const removeCommand = (own: OwnInfo) => `node "${own.entryPath}" remove-foreign`;

export function foreignGripSummary(r: ForeignReport | null, own: OwnInfo): ForeignSummary | null {
  const w = r?.worst;
  if (!w) return null;
  let action: string;
  if (w.state === 'insecure') {
    action = `Update is not offered for the open-source build here. Install the ${own.displayName} build instead and remove this one: ` +
      `${removeCommand(own)} (it lists what it removes; add --yes after the user agrees).`;
  } else if (w.state === 'unknown_service') {
    const port = w.evidence.map((e) => /^unknown service on port (\d+)$/.exec(e)?.[1]).find(Boolean);
    action = `something that is not a Grip bridge listens on ${port ? `port ${port}` : 'the watched port'}; nothing to do unless you expect Grip there`;
  } else {
    action = 'none needed';
  }
  // Everything below reaches agents, toasts and terminals: only a plain version, printable evidence.
  const V = '[0-9A-Za-z.+-]{1,40}';
  const KNOWN = [new RegExp(`^listening on port \\d{1,5} \\(version (${V}|unknown)\\)$`), /^status file: pid \d{1,10} alive$/, new RegExp(`^status file: version (${V}|unknown)$`),
    new RegExp(`^install\\.json: version (${V}|unknown)$`), /^entry file present$/, /^autostart: [\x20-\x7e]{1,300}$/, /^mcp entry: ([A-Za-z0-9._-]{1,64}|<unusual name>)$/, /^unknown service on port \d{1,5}$/];
  // only the evidence lines this module's detection writes are passed on; anything else is replaced
  const clean = (t: string) => (KNOWN.some((r) => r.test(t)) ? t : '(unrecognised evidence)');
  const version = isSemver(w.version) ? w.version : null;
  return { state: w.state, version, floor: w.floor, evidence: w.evidence.map(clean), action, slug: w.slug };
}

// Only an insecure finding is an alert. A healthy foreign Grip, an unknown listener and
// nothing at all raise nothing anywhere.
export function foreignAlertTexts(s: ForeignSummary | null, own: OwnInfo): ForeignAlertTexts | null {
  if (!s || s.state !== 'insecure') return null;
  const cmd = removeCommand(own);
  const v = s.version ?? 'unknown version';
  const what = `an insecure ${s.slug} Grip bridge (${s.version ? `version ${s.version}` : 'unknown version'}, older than the secure floor ${s.floor})`;
  const toast = `Insecure Grip ${v} found on this computer. Update or uninstall it; your agent can run remove-foreign.`;
  const instructions =
    `SECURITY NOTICE: ${what} is installed on this computer. It exposes a local server that can run code in Figma. ` +
    `Tell the user about it in plain words now, and offer to remove it with: ${cmd} (it only lists what it would remove; it needs --yes to act). ` +
    `Never add --yes unless the user says yes. This ${own.displayName} bridge keeps working either way.`;
  const notice =
    `Security notice for the user: ${what} is on this computer. Tell them now, in plain words, and offer ${cmd}. ` +
    `Run it only after they agree, and add --yes only after they say yes. ${own.displayName} keeps working meanwhile.`;
  const cliLines = [
    'URGENT: insecure Grip found on this computer',
    `  version: ${s.version ?? 'unknown'} (secure from ${s.floor})`,
    ...s.evidence.map((e) => `  - ${e}`),
    `  ${s.action}`,
  ];
  return { tooltip: 'Insecure Grip found: update or uninstall', toast, instructions, notice, cliLines };
}

const keyOf = (r: ForeignReport | null) => (r?.worst ? `${r.worst.slug}|${r.worst.state}|${r.worst.version ?? ''}` : '');

export class ForeignGuard {
  private cur: ForeignReport | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<ForeignReport> | null = null;
  private listeners = new Set<(r: ForeignReport | null) => void>();
  private lastLog = 0;
  private readonly intervalMs: number;

  constructor(private readonly entries: readonly WatchEntry[], private readonly io: DetectIo, opts?: { intervalMs?: number }) {
    this.intervalMs = opts?.intervalMs ?? 60_000;
  }

  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  current(): ForeignReport | null { return this.cur; }

  onChange(fn: (r: ForeignReport | null) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  refresh(): Promise<ForeignReport> {
    if (this.inflight) return this.inflight;
    const run = (async () => {
      const before = keyOf(this.cur);
      const report = await detectForeign(this.entries, this.io);
      // a check that ran out of time says nothing: keep the last complete answer (and its alert)
      if (report.incomplete && this.cur) return this.cur;
      if (report.incomplete) return report;
      this.cur = report;
      if (keyOf(report) !== before) {
        for (const fn of [...this.listeners]) {
          try { fn(report.worst ? report : null); } catch (err) { this.log(`foreign guard: a listener failed: ${(err as Error).message}`); }
        }
      }
      return report;
    })().finally(() => { this.inflight = null; });
    this.inflight = run;
    return run;
  }

  // stderr only (stdout is the MCP transport), at most one line a minute
  private log(msg: string) {
    const now = Date.now();
    if (now - this.lastLog < 60_000) return;
    this.lastLog = now;
    process.stderr.write(`[grip] ${msg}\n`);
  }
}

// Lines for the installer and updater output. Empty unless there is something to say.
export function foreignCliLines(r: ForeignReport | null, own: OwnInfo): string[] {
  const s = foreignGripSummary(r, own);
  if (!s) return [];
  if (s.state === 'insecure') return foreignAlertTexts(s, own)!.cliLines;
  if (s.state === 'unknown_service') return [`warning: ${s.action}`];
  return [];
}

export type PreflightVerdict = { proceed: true; lines: string[] } | { proceed: false; lines: string[]; exitCode: 1 };

// Whether an install may go ahead. Alert only: it never blocks this build, it stops an AGENT's
// install (stdin is not a terminal, interactiveYes null) until the user chose, and the user can
// always choose to continue (--continue-with-foreign, or "y" at the prompt).
export function preflightForeign(r: ForeignReport | null, o: { interactiveYes: boolean | null; continueFlag: boolean }, own: OwnInfo): PreflightVerdict {
  if (r?.worst?.state !== 'insecure') return { proceed: true, lines: [] };
  if (o.continueFlag) return { proceed: true, lines: ['The insecure Grip alert was overridden with --continue-with-foreign.'] };
  if (o.interactiveYes === true) return { proceed: true, lines: [] };
  return {
    proceed: false,
    exitCode: 1,
    lines: [
      'Not installing yet. Tell the user about the insecure Grip above.',
      `To remove it: ${removeCommand(own)} (it lists what it removes; add --yes after the user agrees).`,
      'Re-run this installer with --continue-with-foreign only after the user chose to keep going.',
    ],
  };
}

// Connect the guard to the plugin strips: the tooltip frame (replayed on hello by the bridge) and
// ONE toast per window and alert. Alert only: nothing here changes a window's connection.
export function wireForeignToBridge(bridge: PluginBridge, g: ForeignGuard): () => void {
  const toasted = new Set<string>();
  const apply = () => {
    const own = ownInfo();
    const report = g.current();
    const texts = foreignAlertTexts(foreignGripSummary(report, own), own);
    bridge.setForeignAlert(texts ? { active: true, tooltip: texts.tooltip } : null);
    if (!texts) { toasted.clear(); return; }   // resolved: if it comes back it is announced again
    const w = report!.worst!;
    for (const p of bridge.snapshot().plugins as Array<{ sessionId?: string; hello?: boolean; wsReady?: boolean; fileKey?: string; fileUid?: string; fileName?: string }>) {
      if (!p.sessionId || p.hello === false || p.wsReady === false) continue;
      // one toast per FILE and alert: Figma respawns the plugin iframe every minute or two (a new session each time)
      const id = `${fileIdentity(p) ?? `window:${p.sessionId}`}|${w.slug}|${w.version ?? ''}`;
      if (toasted.has(id)) continue;
      if (bridge.toast(p.sessionId, texts.toast)) toasted.add(id);   // a failed send retries on the next change
    }
  };
  apply();
  const off = g.onChange(apply);
  bridge.on('session-change', apply);
  return () => { off(); bridge.off('session-change', apply); };
}

let guard: ForeignGuard | null = null;
export function getForeignGuard(): ForeignGuard | null { return guard; }
export function setForeignGuard(g: ForeignGuard | null): void { guard = g; }

export function ownInfo(): OwnInfo {
  return { displayName: FLAVOUR.displayName, entryPath: join(liveIdentity().home, 'grip-bridge.mjs') };
}

// null for a flavour that does not watch anything (the public one)
export function createForeignGuardFromFlavour(): ForeignGuard | null {
  if (FLAVOUR.enforcement === 'off' || FLAVOUR.watchlist.length === 0) return null;
  return new ForeignGuard(FLAVOUR.watchlist, realDetectIo());
}
