// `node <home>/grip-bridge.mjs remove-foreign [--yes]`
//
// Lists what it would remove of a foreign Grip build (the guard's watchlist), and removes it
// only with --yes. Runs INSTEAD of the shim/daemon (index.ts parses argv first), like `update`
// and `pair`, so plain console output is fine and no daemon is started.
// Exit codes: 0 nothing to do or done, 1 something was refused or failed, 2 listed only.
import { FLAVOUR, type WatchEntry } from './flavour.gen.js';
import { detectForeign, realDetectIo, type DetectIo } from './foreign-detect.js';
import { collectFacts, formatPlan, planForeignRemoval, realExecIo, runPlan, type ExecIo } from './foreign-remove.js';

export interface ForeignCliDeps {
  entries: readonly WatchEntry[];
  enforcement: 'alert' | 'off';
  detect: DetectIo;
  exec: ExecIo;
  out?: (line: string) => void;
}

export function isForeignCli(argv: string[]): boolean {
  if (argv.includes('--daemon')) return false;
  return argv.slice(2)[0] === 'remove-foreign';
}

export async function runForeignCli(argv: string[], deps?: Partial<ForeignCliDeps>): Promise<number> {
  const out = deps?.out ?? ((s: string) => { process.stdout.write(s + '\n'); });
  const enforcement = deps?.enforcement ?? FLAVOUR.enforcement;
  const entries = deps?.entries ?? FLAVOUR.watchlist;
  if (enforcement === 'off' || entries.length === 0) {
    out('This build does not watch for another Grip, so there is nothing to remove.');
    return 0;
  }
  const yes = argv.slice(3).includes('--yes');
  const detect = deps?.detect ?? realDetectIo();
  const exec = deps?.exec ?? realExecIo();

  const report = await detectForeign(entries, detect);
  const found = report.findings.filter((f) => f.state === 'ok' || f.state === 'insecure');
  if (found.length === 0) {
    out('No other Grip was found. Nothing to remove.');
    return 0;
  }

  let code = 0;
  let listedOnly = false;
  for (const f of found) {
    const e = entries.find((x) => x.slug === f.slug)!;
    const facts = await collectFacts(detect, e, f, detect, exec);
    const items = planForeignRemoval(detect, e, facts);
    out(`Found another Grip build "${f.slug}" (version ${f.version ?? 'unknown'}${f.state === 'insecure' ? `, older than the secure floor ${f.floor}` : ''}).`);
    if (items.length === 0) { out('  There is nothing of it to remove.'); continue; }
    out(yes ? 'Removing:' : 'This would:');
    formatPlan(items).forEach((l) => out(`  - ${l}`));
    if (!yes) { listedOnly = true; continue; }
    const results = await runPlan(detect, e, items, exec, { yes: true });
    const lines = formatPlan(items);
    results.forEach((r, i) => out(`  [${r.status}] ${lines[i]}${r.note ? ` (${r.note})` : ''}`));
    const byHand = results.filter((r) => ['instruct', 'deferred', 'failed', 'refused'].includes(r.status));
    if (byHand.length) {
      out('Still to do by hand:');
      byHand.forEach((r) => out(`  - ${r.item.target}: ${r.note ?? r.status}`));
    }
    if (results.some((r) => r.status === 'refused' || r.status === 'failed')) code = 1;
  }
  if (listedOnly) {
    out('Nothing was changed. Run again with --yes to do this.');
    return 2;
  }
  return code;
}
