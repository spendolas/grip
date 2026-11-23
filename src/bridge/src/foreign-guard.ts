// The insecure-Grip guard: keeps the latest detection result of the watchlist, re-checks it
// (at start and every 60 s) and turns it into the words every alert surface shows. Alert
// only: nothing here ever blocks this build. A flavour with `enforcement:'off'` (the public
// one) or an empty watchlist never gets a guard at all.
import { join } from 'node:path';
import { FLAVOUR, type WatchEntry } from './flavour.gen.js';
import { liveIdentity } from './identity.js';
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
  return { state: w.state, version: w.version, floor: w.floor, evidence: [...w.evidence], action, slug: w.slug };
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
