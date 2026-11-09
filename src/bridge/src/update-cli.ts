// `node ~/.grip/grip-bridge.mjs update [--check] [--yes] [--rollback]`
//
// The manual route for people who'd rather type than click. Runs INSTEAD of
// the shim/daemon (index.ts parses argv before anything starts), so it never
// spawns a daemon and never touches the MCP stdout stream — plain console
// output is fine here.

import { createInterface } from 'node:readline';
import { BRIDGE_VERSION } from './types.js';
import {
  checkForUpdate, gripHome, installUpdate, rollbackBridge, stopRunningDaemon, updateBase,
} from './update.js';

// `update` or `--update` as the first real argument selects the CLI.
export function isUpdateCli(argv: string[]): boolean {
  if (argv.includes('--daemon')) return false;
  const a = argv.slice(2);
  return a[0] === 'update' || a[0] === '--update';
}

function out(msg = '') { process.stdout.write(msg + '\n'); }

function confirm(question: string): Promise<boolean> {
  return new Promise((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (ans) => { rl.close(); res(/^y(es)?$/i.test(ans.trim())); });
    rl.on('close', () => res(false));
  });
}

export async function runUpdateCli(argv: string[]): Promise<number> {
  const flags = new Set(argv.slice(3));
  const yes = flags.has('--yes') || flags.has('-y');
  const entry = `${gripHome()}/grip-bridge.mjs`;

  if (flags.has('--rollback')) {
    try {
      const r = rollbackBridge();
      out(`Restored the previous bridge from ${r.restored}.`);
      out('(Plugin files in ~/.grip/figma-plugin are left as they are.)');
      out(stopRunningDaemon().note);
      return 0;
    } catch (err) {
      process.stderr.write(`rollback failed: ${(err as Error).message}\n`);
      return 1;
    }
  }

  out(`Grip ${BRIDGE_VERSION} installed. Checking ${updateBase()} ...`);
  const s = await checkForUpdate();
  if (s.error) {
    out(`Could not check for updates: ${s.error}`);
    // `update --check` only reports; exit 0 either way. A real update attempt failed to even start: exit 1.
    return flags.has('--check') ? 0 : 1;
  }
  if (!s.available) {
    out(`You are up to date (latest is ${s.latest}).`);
    return 0;
  }
  out(`Update available: ${s.current} -> ${s.latest}`);
  if (flags.has('--check')) {
    out(`Install it with: node ${entry} update`);
    return 0;
  }
  if (!yes) {
    if (!process.stdin.isTTY) {
      out('Not installing: no terminal to confirm on. Re-run with --yes to install.');
      return 1;
    }
    if (!(await confirm(`Download and install ${s.latest} into ${gripHome()}? [y/N] `))) {
      out('Cancelled. Nothing was changed.');
      return 0;
    }
  }
  try {
    const r = await installUpdate();
    if (r.status === 'up_to_date') { out('Already up to date.'); return 0; }
    if (r.status === 'already_installing') { out('Another update is already running.'); return 1; }
    out(`Updated ${r.from} -> ${r.to}.`);
    out(`  bridge  -> ${entry}  (previous kept as grip-bridge.prev.mjs; undo with: node ${entry} update --rollback)`);
    if (r.pluginFilesWritten?.length) out(`  plugin  -> ${gripHome()}/figma-plugin (${r.pluginFilesWritten.join(', ')})`);
    out(stopRunningDaemon().note);
    out('If you imported the plugin from a git clone instead of ~/.grip/figma-plugin, run `git pull` there (or import ~/.grip/figma-plugin/manifest.json in Figma).');
    return 0;
  } catch (err) {
    process.stderr.write(`Update failed: ${(err as Error).message}\n`);
    return 1;
  }
}
