// install-launchd.sh renders its plist from the flavour file and only frees the port
// from this flavour's own daemon. Dry-run only: GRIP_DRYRUN=1 prints the plist and the
// planned actions and runs no launchctl and no kill; HOME is a temp dir, lsof is a stub.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') { console.log('launchd-render: skipped on win32'); process.exit(0); }

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, '../scripts/install-launchd.sh');
const publicFlavour = resolve(here, '../../../flavour/flavour.json');
const acmeFlavour = resolve(here, 'fixtures/flavour-alt/flavour.json');

const tmp = mkdtempSync(join(tmpdir(), 'launchd-render-'));
try {
  const bin = join(tmp, 'bin');
  mkdirSync(bin);
  // Stub lsof: prints the pid in STUB_LSOF_PID (nothing when unset).
  writeFileSync(join(bin, 'lsof'), '#!/bin/sh\n[ -n "$STUB_LSOF_PID" ] && echo "$STUB_LSOF_PID"\nexit 0\n');
  chmodSync(join(bin, 'lsof'), 0o755);

  const run = (flavourFile, prefix, stubPid, statusPid) => {
    const home = mkdtempSync(join(tmp, 'home-'));
    if (statusPid != null) writeFileSync(join(home, `${prefix}.status`), JSON.stringify({ pid: statusPid, persistent: true }, null, 2));
    return spawnSync('bash', [script], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH}`, HOME: home, TMPDIR: tmp,
        GRIP_DRYRUN: '1', GRIP_FLAVOUR_FILE: flavourFile, STUB_LSOF_PID: stubPid ?? '',
      },
    });
  };

  // acme: a pid on the port that is not in the status file is left alone.
  let r = run(acmeFlavour, '.acme-bridge', '4343', 4242);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr + r.stdout, /port 7877 is held by another program \(pid 4343\), not stopping it/);
  assert.ok(!/^kill /m.test(r.stdout), 'must not plan a kill of a foreign pid');

  // no status file at all: the holder cannot be ours either.
  r = run(acmeFlavour, '.acme-bridge', '4343', null);
  assert.equal(r.status, 1);
  assert.match(r.stderr + r.stdout, /held by another program \(pid 4343\)/);

  // acme: the pid in the status file is ours, the dry run plans to stop it.
  r = run(acmeFlavour, '.acme-bridge', '4242', 4242);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^kill 4242$/m);
  assert.match(r.stdout, /^launchctl bootstrap .*com\.acme\.bridge\.plist/m);
  for (const s of ['com.acme.bridge', '7877', '7878', '.acme-bridge.log']) assert.ok(r.stdout.includes(s), `acme output lacks ${s}`);
  for (const s of ['com.grip', '7777', '7778', '.grip-bridge', '__']) assert.ok(!r.stdout.includes(s), `acme output still has ${s}`);

  // nobody on the port: nothing to kill, still renders.
  r = run(acmeFlavour, '.acme-bridge', '', null);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!/^kill /m.test(r.stdout));

  // public flavour: names unchanged.
  r = run(publicFlavour, '.grip-bridge', '4242', 4242);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const s of ['com.grip.bridge', '7777', '7778', '.grip-bridge.log']) assert.ok(r.stdout.includes(s), `public output lacks ${s}`);
  assert.match(r.stdout, /^kill 4242$/m);
  console.log('launchd-render: ok');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
