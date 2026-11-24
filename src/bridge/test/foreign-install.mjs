// Installer preflight and updater output for the insecure-Grip guard (phase 2B).
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { foreignCliLines, preflightForeign } from '../dist/foreign-guard.js';
import { flavourBundler } from './_bundle.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..', '..');
const altDir = join(here, 'fixtures', 'flavour-alt');
const alt = JSON.parse(readFileSync(join(altDir, 'flavour.json'), 'utf8'));
const own = { displayName: 'Acme', entryPath: '/h/.acme/grip-bridge.mjs' };
const CMD = 'node "/h/.acme/grip-bridge.mjs" remove-foreign';
setTimeout(() => { console.error('foreign-install: timed out'); process.exit(1); }, 120_000).unref();

const report = (state, version = '1.0.0') => ({ findings: [], checkedAt: 'x', worst: { slug: 'zenith', state, version, floor: '2.0.0', evidence: ['listening on port 7977 (version 1.0.0)'], running: true, pid: null } });

// ---- foreignCliLines
{
  const bad = foreignCliLines(report('insecure'), own);
  assert.ok(bad[0].startsWith('URGENT: insecure Grip found'), bad[0]);
  assert.ok(bad.some((l) => l.includes('1.0.0')) && bad.some((l) => l.includes('2.0.0')));
  assert.ok(bad.some((l) => l.includes('listening on port 7977')));
  assert.ok(bad.some((l) => l.includes(CMD)));
  const unk = foreignCliLines(report('unknown_service', null), own);
  assert.equal(unk.length, 1);
  assert.ok(unk[0].startsWith('warning:'));
  assert.deepEqual(foreignCliLines(report('ok', '2.0.0'), own), []);
  assert.deepEqual(foreignCliLines(null, own), []);
  assert.deepEqual(foreignCliLines({ findings: [], worst: null, checkedAt: 'x' }, own), []);
}

// ---- preflightForeign
{
  const none = { interactiveYes: null, continueFlag: false };
  const refuse = preflightForeign(report('insecure'), none, own);
  assert.equal(refuse.proceed, false);
  assert.equal(refuse.exitCode, 1);
  assert.ok(refuse.lines.join('\n').includes(CMD));
  assert.ok(refuse.lines.join('\n').includes('--continue-with-foreign'));
  assert.equal(preflightForeign(report('insecure'), { interactiveYes: false, continueFlag: false }, own).proceed, false);
  assert.equal(preflightForeign(report('insecure'), { interactiveYes: true, continueFlag: false }, own).proceed, true);
  const forced = preflightForeign(report('insecure'), { interactiveYes: null, continueFlag: true }, own);
  assert.equal(forced.proceed, true);
  assert.ok(forced.lines.join('\n').includes('overridden'));
  for (const r of [report('ok', '2.0.0'), report('unknown_service', null), null, { findings: [], worst: null, checkedAt: 'x' }]) {
    assert.deepEqual(preflightForeign(r, none, own), { proceed: true, lines: [] });
  }
}

// ---- the real installer, built for the acme flavour, against a fake foreign bridge
{
  const tmp = mkdtempSync(join(tmpdir(), 'foreign-install-'));
  mkdirSync(join(tmp, 'gen'), { recursive: true });
  const { bundle } = flavourBundler(altDir, join(tmp, 'gen'));
  const dist = join(tmp, 'dist');
  mkdirSync(dist, { recursive: true });
  const text = await bundle('src/install.ts');
  writeFileSync(join(dist, 'install.mjs'), "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);\n" + text);
  for (const f of ['grip-bridge.mjs']) cpSync(join(repo, 'bridge', f), join(dist, f));
  cpSync(join(repo, 'figma-plugin'), join(dist, 'figma-plugin'), { recursive: true });

  const freeCheck = () => new Promise((res) => { const s = createServer().once('error', () => res(false)).listen(alt.watchlist[0].wsPort, '127.0.0.1', () => s.close(() => res(true))); });
  assert.ok(await freeCheck(), `port ${alt.watchlist[0].wsPort} must be free for this test`);

  async function serve(version) {
    if (version === null) return { close: async () => {} };
    const wss = new WebSocketServer({ host: '127.0.0.1', port: alt.watchlist[0].wsPort });
    await new Promise((r) => wss.once('listening', r));
    wss.on('connection', (ws) => ws.send(JSON.stringify({ kind: 'welcome', bridgeVersion: version })));
    return { close: () => new Promise((r) => { wss.clients.forEach((c) => c.terminate()); wss.close(() => r()); }) };
  }
  function install(args) {
    const home = mkdtempSync(join(tmpdir(), 'foreign-install-home-'));
    const env = { ...process.env, HOME: home, USERPROFILE: home, GRIP_TEST: '1' };
    delete env.GRIP_HOME;
    return new Promise((res) => {
      execFile(process.execPath, [join(dist, 'install.mjs'), ...args], { env, timeout: 60_000 }, (err, stdout, stderr) => {
        res({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: `${stdout}${stderr}`, home });
      });
    });
  }
  const acmeHome = (home) => join(home, alt.homeDirName);

  // a below-floor foreign bridge, an agent (stdin is not a terminal): refused, nothing written
  let srv = await serve('1.0.0');
  let r = await install(['--no-register']);
  assert.equal(r.code, 1, r.out);
  assert.ok(r.out.includes('URGENT: insecure Grip found'), r.out);
  assert.ok(r.out.includes('remove-foreign'));
  assert.ok(r.out.includes('--continue-with-foreign'));
  assert.ok(!existsSync(acmeHome(r.home)), 'the disk is untouched when the install is refused');
  // the user chose to go on
  r = await install(['--no-register', '--continue-with-foreign']);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.out.includes('URGENT: insecure Grip found'), 'the alert is still shown');
  assert.ok(r.out.includes('overridden'));
  assert.ok(existsSync(acmeHome(r.home)), 'and the install went ahead');
  await srv.close();

  // at the floor: nothing
  srv = await serve('2.0.0');
  r = await install(['--no-register']);
  assert.equal(r.code, 0, r.out);
  assert.ok(!r.out.includes('URGENT'));
  assert.ok(existsSync(acmeHome(r.home)));
  await srv.close();

  // nothing listening: nothing
  r = await install(['--no-register']);
  assert.equal(r.code, 0, r.out);
  assert.ok(!r.out.includes('URGENT') && !r.out.includes('warning:'));
}

console.log('foreign-install: ok');
process.exit(0);
