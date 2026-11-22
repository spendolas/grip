// `node ~/.grip/grip-bridge.mjs update [--check] [--yes] [--rollback] [--force]`
//
// The manual route for people who'd rather type than click. Runs INSTEAD of
// the shim/daemon (index.ts parses argv before anything starts), so it never
// spawns a daemon and never touches the MCP stdout stream — plain console
// output is fine here.
//
// Compatibility with the Figma plugin comes first (see update.ts): the CLI asks
// a running daemon (through its status file) which plugin versions are
// connected. A KNOWN-incompatible plugin always refuses. When no plugin can be
// checked it says so and needs an explicit --yes (or --force, or a typed "y").
// A release without a verifiable compat.json is not installed unless --force.
// A release whose signature (SHA256SUMS.txt.sig) is missing or invalid is never
// installed: --force does not override that.

import { createInterface } from 'node:readline';
import { BRIDGE_VERSION } from './types.js';
import { IDENTITY } from './identity.js';
import {
  CLONE_NEXT_STEPS, checkForUpdate, checkPluginCompat, gripHome, installUpdate, readDaemonPlugins, readInstallRecord, releasesApi,
  rollbackBridge, stopRunningDaemon,
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
  const force = flags.has('--force');
  const checkOnly = flags.has('--check');
  const entry = `${gripHome()}/grip-bridge.mjs`;

  if (flags.has('--rollback')) {
    try {
      const r = rollbackBridge();
      out(`Restored the previous bridge from ${r.restored}.`);
      out(`(Only the bridge goes back: the plugin files in ${IDENTITY.homeLabel}/figma-plugin stay at the new version.)`);
      out(stopRunningDaemon().note);
      return 0;
    } catch (err) {
      process.stderr.write(`rollback failed: ${(err as Error).message}\n`);
      return 1;
    }
  }

  out(`Grip ${BRIDGE_VERSION} installed. Checking ${releasesApi()} ...`);
  const s = await checkForUpdate();
  if (s.error) {
    out(`Could not check for updates: ${s.error}`);
    // `update --check` only reports; exit 0 either way. A real update attempt failed to even start: exit 1.
    return checkOnly ? 0 : 1;
  }
  if (!s.available) {
    out(`You are up to date (latest is ${s.latest}).`);
    return 0;
  }
  out(`Update available: ${s.current} -> ${s.latest}`);
  if (s.notes) { out(); out(s.notes); out(); }
  else if (s.headline) out(s.headline);
  const clone = readInstallRecord().source === 'clone';

  // 1. compatibility with the Figma plugin(s)
  const plugins = readDaemonPlugins();
  let unverifiable = false;
  if (s.signatureError) {
    out(`Not installing: ${s.signatureError}`);
    out(force ? '--force does not override a signature failure.' : 'Nothing overrides a signature failure: do not install this release, and report it.');
    return checkOnly ? 0 : 1;
  }
  if (s.minPlugin) {
    out(`Grip ${s.latest} needs a Figma plugin >= ${s.minPlugin}.`);
    const v = checkPluginCompat(s.minPlugin, s.latest!, plugins);
    if (v.kind === 'incompatible') {
      out(`Not installing: ${v.reason}.`);
      return checkOnly ? 0 : 1;
    }
    if (v.kind === 'ok' && v.stale) {
      out(`WARNING: ${v.stale.length} open Figma window(s) have a Grip plugin that is too old for ${s.latest} and will stop working until it is updated in Figma:`);
      for (const w of v.stale) out(`  - ${w}`);
    }
    if (v.kind === 'unverifiable') {
      unverifiable = true;
      out(`Could not verify your plugin: ${plugins === null ? 'no running Grip bridge to ask (or one older than 0.8.0)' : v.reason}.`);
      out('To have it checked, open the Grip plugin in Figma (with the bridge running) and re-run. Otherwise confirm with --yes that your plugin is current.');
    }
  } else {
    out(`WARNING: Grip ${s.latest} has no verified compatibility info (${s.compatError ?? 'compat.json missing'}).`);
    out(`It is not offered to agents or the plugin, and it is not installed${force ? ' ... except that --force was given: nothing will check that your plugin works with it.' : ' (--force overrides, at your own risk).'}`);
    if (!force) return checkOnly ? 0 : 1;
  }

  // 2. developer (git clone) installs are updated from the clone
  if (clone && !force && !checkOnly) {
    out('This is a developer install (Grip was installed from a git clone), so it is not overwritten.');
    out(`Update it from your clone instead: ${CLONE_NEXT_STEPS.join(' && ')}`);
    out('(To replace it with the released build anyway, re-run with --force.)');
    return 0;
  }
  if (checkOnly) {
    if (clone) out(`This is a developer install: update it from your clone with ${CLONE_NEXT_STEPS.join(' && ')}`);
    else out(`Install it with: node ${entry} update`);
    return 0;
  }

  // 3. the user's explicit yes
  if (!yes) {
    if (!process.stdin.isTTY) {
      out('Not installing: no terminal to confirm on. Re-run with --yes to install.');
      return 1;
    }
    const q = unverifiable
      ? `Plugin compatibility could NOT be verified. Download and install ${s.latest} into ${gripHome()} anyway? [y/N] `
      : `Download and install ${s.latest} into ${gripHome()}? [y/N] `;
    if (!(await confirm(q))) {
      out('Cancelled. Nothing was changed.');
      return 0;
    }
  }

  try {
    // Pinned to the version shown above. By here the user said yes (--yes, --force or a typed y),
    // which also accepts "no plugin could be checked".
    const r = await installUpdate({ version: s.latest!, force, plugins, acceptUnverified: true });
    if (r.status === 'up_to_date') { out('Already up to date.'); return 0; }
    if (r.status === 'already_installing') { out('Another update is already running.'); return 1; }
    if (r.status === 'clone_install') { out(`Developer install: run ${CLONE_NEXT_STEPS.join(' && ')} in your clone.`); return 0; }
    if (r.status === 'version_changed') { out(`The latest release changed to ${r.to} while installing. Nothing was installed; re-run to review it.`); return 1; }
    if (r.status === 'incompatible_plugin' || r.status === 'plugins_unverifiable') { out(`Not installing: ${r.reason}.`); return 1; }
    if (r.status === 'declined') { out('Cancelled. Nothing was changed.'); return 0; }
    if (r.compatWarning) out(r.compatWarning);
    out(`Updated ${r.from} -> ${r.to}.`);
    out(`  bridge  -> ${entry}  (previous kept as grip-bridge.prev.mjs; undo with: node ${entry} update --rollback)`);
    if (r.pluginFilesWritten?.length) out(`  plugin  -> ${gripHome()}/figma-plugin (${r.pluginFilesWritten.join(', ')})`);
    for (const d of r.pluginCopies?.updated ?? []) out(`  plugin  -> ${d} (the plugin you imported from there, refreshed)`);
    for (const k of r.pluginCopies?.skipped ?? []) out(`  plugin  -> ${k.dir} left alone (${k.reason}${k.reason === 'git_checkout' ? ': run git pull && npm run build there' : ''})`);
    out('Rolling back restores the bridge only; the plugin files stay at the new version.');
    out(stopRunningDaemon().note);
    if (!r.pluginCopies) out(`If you imported the plugin from a folder other than ${IDENTITY.homeLabel}/figma-plugin, import ${IDENTITY.homeLabel}/figma-plugin/manifest.json in Figma instead (a git clone: git pull && npm run build there).`);
    return 0;
  } catch (err) {
    process.stderr.write(`Update failed: ${(err as Error).message}\n`);
    return 1;
  }
}
