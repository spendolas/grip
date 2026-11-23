// The removal executor and the `remove-foreign` command (phase 2B), against fake adapters and
// temp directories only. Nothing here signals a real process or touches a real install.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, existsSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { foreignPaths } from '../dist/foreign-paths.js';
import { planForeignRemoval, runPlan, realExecIo } from '../dist/foreign-remove.js';
import { isForeignCli, runForeignCli } from '../dist/foreign-cli.js';

const here = dirname(fileURLToPath(import.meta.url));
const alt = JSON.parse(readFileSync(join(here, 'fixtures', 'flavour-alt', 'flavour.json'), 'utf8'));
const Z = alt.watchlist[0];
const ctx = (platform) => ({ platform, home: platform === 'win32' ? 'C:\\Users\\u' : '/Users/u', tmp: platform === 'win32' ? 'C:\\tmp' : '/tmp', env: platform === 'win32' ? { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' } : {}, uid: 501 });
const DAEMON_CMD = 'node /Users/u/.zenith/zenith-bridge.mjs --daemon --persistent';

// A recording fake of every adapter.
function fakeIo(o = {}) {
  const log = [];
  const alive = new Set(o.alive ?? [4242]);
  const cmds = { 4242: DAEMON_CMD, ...(o.cmds ?? {}) };
  const parents = { 4242: 4200, ...(o.parents ?? {}) };
  const rmFails = new Map(Object.entries(o.rmFails ?? {}).map(([k, v]) => [k, { ...v }]));
  const files = { ...(o.json ?? {}) };
  const io = {
    log, alive, files,
    execFile: async (cmd, args) => {
      assert.ok(Array.isArray(args), 'arguments are an array');
      assert.ok(['osascript', 'launchctl', 'systemctl', 'claude'].includes(cmd), `unexpected command ${cmd}`);
      log.push(`exec ${cmd} ${JSON.stringify(args)}`);
      return (o.exec ? o.exec(cmd, args) : { ok: true, out: '' });
    },
    procCommand: (pid) => { log.push(`cmd ${pid}`); return cmds[pid] ?? null; },
    parentPid: (pid) => parents[pid] ?? null,
    kill: (pid, sig) => {
      log.push(`kill ${pid} ${sig}`);
      const die = o.dieOn ?? 'SIGTERM';
      if (die === 'SIGTERM' || (die === 'SIGKILL' && sig === 'SIGKILL')) alive.delete(pid);
      if (o.supervisorKillsChild && pid === 4200) alive.delete(4242);
      return true;
    },
    pidAlive: (pid) => alive.has(pid),
    portOpen: async () => (o.portStaysOpen ?? false) && alive.has(4242),
    sleep: async (ms) => { log.push(`sleep ${ms}`); },
    lstatKind: (p) => (o.kinds && p in o.kinds ? o.kinds[p] : (p.endsWith('.zenith') || p.endsWith('.app') ? 'dir' : 'file')),
    realpath: (p) => (o.realpaths && p in o.realpaths ? o.realpaths[p] : p),
    rm: (p) => {
      const f = rmFails.get(p);
      if (f && f.times > 0) { f.times--; const e = new Error('locked'); e.code = f.code; throw e; }
      log.push(`rm ${p}`);
    },
    readJson: (p) => { if (!(p in files)) throw new Error('ENOENT'); return JSON.parse(JSON.stringify(files[p])); },
    writeJson: (p, v) => { log.push(`write ${p}`); files[p] = v; },
  };
  return io;
}

function fullFacts(platform, over = {}) {
  const c = ctx(platform);
  const p = foreignPaths(c, Z);
  const exists = {};
  for (const a of p.autostart) exists[a.path] = true;
  for (const k of [p.statusFile, p.logFile, p.ipcSocket]) if (k) exists[k] = true;
  return { c, p, facts: { pid: 4242, running: true, exists, home: { kind: 'dir', realpath: p.homeDir, parentRealpath: c.home }, mcp: { entry: { type: 'http', url: 'http://127.0.0.1:7978/mcp' }, claudeCli: true }, pluginCopies: [], ...over } };
}
const FAST = { yes: true, graceMs: 10, deleteRetries: 3 };
// a user MCP config holding the foreign entry (what the executor verifies before removing it)
const cfgJson = (c) => ({ [foreignPaths(c, Z).claudeConfig]: { mcpServers: { zenith: { type: 'http', url: 'http://127.0.0.1:7978/mcp' } } } });
const status = (results, kind, action) => results.find((r) => r.item.kind === kind && (!action || r.item.action === action))?.status;

// ---- the --yes gate: no yes, no adapter call at all
{
  const { c, facts } = fullFacts('darwin');
  const items = planForeignRemoval(c, Z, facts);
  const touched = [];
  const spy = new Proxy({}, { get: (_, k) => (...a) => { touched.push(String(k)); throw new Error('adapter used without --yes'); } });
  for (const yes of [false, undefined, 'yes', 1]) {
    const res = await runPlan(c, Z, items, spy, { yes });
    assert.equal(res.length, items.length);
    assert.ok(res.every((r) => r.status === 'skipped'), 'everything skipped');
  }
  assert.deepEqual(touched, []);
}

// ---- darwin: order and exact commands
{
  const { c, facts } = fullFacts('darwin');
  const io = fakeIo({ cmds: { 4200: '/bin/bash /Users/u/Applications/Zenith Daemon.app/Contents/MacOS/zenith-daemon' }, supervisorKillsChild: true, alive: [4242, 4200], json: cfgJson(c) });
  const res = await runPlan(c, Z, planForeignRemoval(c, Z, facts), io, FAST);
  const execs = io.log.filter((l) => l.startsWith('exec '));
  assert.deepEqual(execs, [
    'exec osascript ["-e","tell application \\"System Events\\" to delete (every login item whose name is \\"Zenith Daemon\\")"]',
    'exec launchctl ["bootout","gui/501/com.zenith.bridge"]',
    'exec claude ["mcp","remove","-s","user","zenith"]',
  ]);
  const order = (x) => io.log.findIndex((l) => l.startsWith(x));
  assert.ok(order('exec osascript') < order('kill 4200') && order('exec launchctl') < order('kill 4200'), 'autostart off before any stop');
  assert.ok(order('kill 4200') >= 0, 'the supervisor (parent) is stopped');
  assert.ok(order('rm /Users/u/.zenith-bridge.log') > order('kill 4200'), 'deletes after the stop');
  assert.equal(io.log.at(-1), 'rm /Users/u/.zenith', 'the home folder is the last thing removed');
  assert.ok(res.every((r) => ['done', 'skipped', 'instruct'].includes(r.status)), JSON.stringify(res.filter((r) => !['done', 'skipped', 'instruct'].includes(r.status))));
  assert.equal(status(res, 'home-dir'), 'done');
}
// ---- linux commands
{
  const { c, facts } = fullFacts('linux');
  const io = fakeIo({ json: cfgJson(c) });
  await runPlan(c, Z, planForeignRemoval(c, Z, facts), io, FAST);
  assert.deepEqual(io.log.filter((l) => l.startsWith('exec ')), [
    'exec systemctl ["--user","disable","--now","zenith-bridge"]',
    'exec systemctl ["--user","daemon-reload"]',
    'exec claude ["mcp","remove","-s","user","zenith"]',
  ]);
  assert.ok(io.log.includes('rm /Users/u/.config/systemd/user/zenith-bridge.service'));
  assert.ok(io.log.includes('rm /Users/u/.config/autostart/zenith-bridge.desktop'));
  assert.ok(io.log.includes('rm /tmp/zenith-bridge.sock'));
}
// ---- windows: the startup launcher goes, the pid is terminated, no command line is a shell string
{
  const { c, facts } = fullFacts('win32');
  const io = fakeIo({ cmds: { 4242: 'node C:\\Users\\u\\.zenith\\zenith-bridge.mjs --daemon' } });
  await runPlan(c, Z, planForeignRemoval(c, Z, facts), io, FAST);
  assert.ok(io.log.some((l) => l.startsWith('rm C:\\Users\\u\\AppData\\Roaming\\Microsoft') && l.endsWith('ZenithDaemon.vbs')));
  assert.ok(io.log.includes('kill 4242 SIGTERM'));
}

// ---- verify before kill
{
  const { c, facts } = fullFacts('linux');
  for (const cmd of ['node /x/other.mjs --daemon', 'node /x/zenith-bridge.mjs', null]) {
    const io = fakeIo({ cmds: { 4242: cmd } });
    if (cmd === null) delete io.procCommand, io.procCommand = () => null;
    const res = await runPlan(c, Z, planForeignRemoval(c, Z, facts), io, FAST);
    assert.equal(status(res, 'stop-daemon'), 'refused', String(cmd));
    assert.ok(!io.log.some((l) => l.startsWith('kill 4242')), 'never signalled');
    // the pid was not the foreign daemon, so the user-requested deletes still happen
    assert.equal(status(res, 'home-dir'), 'done');
  }
  // a pid that is already gone is not an error and is not signalled
  const io = fakeIo({ alive: [] });
  const res = await runPlan(c, Z, planForeignRemoval(c, Z, facts), io, FAST);
  assert.ok(['done', 'skipped'].includes(status(res, 'stop-daemon')));
  assert.ok(!io.log.some((l) => l.startsWith('kill')));
}
// ---- SIGTERM then, only after the grace, SIGKILL; a daemon that survives blocks the deletes
{
  const { c, facts } = fullFacts('linux');
  let io = fakeIo();
  await runPlan(c, Z, planForeignRemoval(c, Z, facts), io, FAST);
  assert.ok(io.log.includes('kill 4242 SIGTERM') && !io.log.includes('kill 4242 SIGKILL'), 'a daemon that exits on SIGTERM is not killed');
  io = fakeIo({ dieOn: 'SIGKILL' });
  let res = await runPlan(c, Z, planForeignRemoval(c, Z, facts), io, FAST);
  assert.ok(io.log.indexOf('kill 4242 SIGTERM') < io.log.indexOf('kill 4242 SIGKILL'));
  assert.equal(status(res, 'stop-daemon'), 'done');
  io = fakeIo({ dieOn: 'never' });
  res = await runPlan(c, Z, planForeignRemoval(c, Z, facts), io, FAST);
  assert.equal(status(res, 'stop-daemon'), 'failed');
  const sigkill = io.log.indexOf('kill 4242 SIGKILL');
  assert.ok(!io.log.slice(sigkill).some((l) => l.startsWith('rm ')), 'nothing is deleted under a daemon that will not stop (only the autostart entry, removed before the stop)');
  assert.equal(status(res, 'home-dir'), 'skipped');
  assert.ok(res.find((r) => r.item.kind === 'home-dir').note.includes('daemon still running'));
}
// ---- the macOS supervisor: only a login-item process is stopped
{
  const { c, facts } = fullFacts('darwin');
  const io = fakeIo({ cmds: { 4200: '/bin/bash -l' }, alive: [4242, 4200] });
  const res = await runPlan(c, Z, planForeignRemoval(c, Z, facts), io, FAST);
  assert.equal(status(res, 'stop-supervisor'), 'refused');
  assert.ok(!io.log.includes('kill 4200 SIGTERM'));
}

// ---- locked files (review focus 4)
{
  const { c, facts, p } = fullFacts('win32');
  let io = fakeIo({ cmds: { 4242: 'node C:\\x\\zenith-bridge.mjs --daemon' }, rmFails: { [p.homeDir]: { times: 3, code: 'EBUSY' } } });
  let res = await runPlan(c, Z, planForeignRemoval(c, Z, facts), io, { yes: true, graceMs: 10, deleteRetries: 6 });
  assert.equal(status(res, 'home-dir'), 'done', 'retries until the lock lets go');
  assert.ok(io.log.filter((l) => l.startsWith('sleep')).length >= 3, 'with backoff');
  io = fakeIo({ cmds: { 4242: 'node C:\\x\\zenith-bridge.mjs --daemon' }, rmFails: { [p.homeDir]: { times: 999, code: 'EBUSY' }, [p.logFile]: { times: 999, code: 'EPERM' } } });
  res = await runPlan(c, Z, planForeignRemoval(c, Z, facts), io, { yes: true, graceMs: 10, deleteRetries: 2 });
  assert.equal(status(res, 'home-dir'), 'deferred');
  assert.ok(res.find((r) => r.item.kind === 'home-dir').note.includes('will be removable after restart'));
  assert.equal(status(res, 'log-file'), 'deferred');
  assert.equal(status(res, 'status-file'), 'done', 'the other items still run');
  assert.ok(!res.some((r) => r.status === 'failed'), 'a locked file is not a failure');
  // any other error is a failure, not a retry loop
  io = fakeIo({ rmFails: { [p.logFile]: { times: 1, code: 'EACCES' } }, cmds: { 4242: 'node C:\\x\\zenith-bridge.mjs --daemon' } });
  res = await runPlan(c, Z, planForeignRemoval(c, Z, facts), io, FAST);
  assert.equal(status(res, 'log-file'), 'failed');
}

// ---- the folder is re-checked immediately before the delete (review focus 3)
{
  const { c, facts, p } = fullFacts('linux');
  const items = planForeignRemoval(c, Z, facts);   // planned while it was a real directory
  let io = fakeIo({ kinds: { [p.homeDir]: 'symlink' } });   // swapped for a link afterwards
  let res = await runPlan(c, Z, items, io, FAST);
  assert.equal(status(res, 'home-dir'), 'refused');
  assert.ok(!io.log.includes(`rm ${p.homeDir}`));
  io = fakeIo({ realpaths: { [p.homeDir]: '/elsewhere/.zenith' } });
  res = await runPlan(c, Z, items, io, FAST);
  assert.equal(status(res, 'home-dir'), 'refused');
  assert.ok(!io.log.includes(`rm ${p.homeDir}`));
  io = fakeIo({ kinds: { [p.homeDir]: 'file' } });
  assert.equal(status(await runPlan(c, Z, items, io, FAST), 'home-dir'), 'refused');
  // a plan item that refuses stays refused and touches nothing
  const refuse = [{ kind: 'home-dir', target: p.homeDir, action: 'refuse', note: 'x' }];
  io = fakeIo();
  assert.equal((await runPlan(c, Z, refuse, io, FAST))[0].status, 'refused');
  assert.deepEqual(io.log, []);
}
// ---- only the exact paths the guard knows can be deleted
{
  const c = ctx('linux');
  const io = fakeIo();
  const evil = [
    { kind: 'home-dir', target: '/Users/u', action: 'delete' },
    { kind: 'home-dir', target: '/Users/u/.zenith/..', action: 'delete' },
    { kind: 'log-file', target: '/etc/passwd', action: 'delete' },
    { kind: 'status-file', target: '/Users/u/.zenith-bridge.status/../.ssh', action: 'delete' },
    { kind: 'app-bundle', target: '/Applications/Other.app', action: 'delete' },
  ];
  const res = await runPlan(c, Z, evil, io, FAST);
  assert.ok(res.every((r) => r.status === 'refused'), JSON.stringify(res.map((r) => r.status)));
  assert.ok(!io.log.some((l) => l.startsWith('rm ')));
}

// ---- the MCP entry (review focus 5)
{
  const { c, p } = fullFacts('linux');
  const cfg = p.claudeConfig;
  const item = [{ kind: 'mcp-entry', target: 'zenith', action: 'run-cli-or-edit-json' }];
  const base = (entry) => ({ [cfg]: { projects: { x: 1 }, mcpServers: { zenith: entry, mine: { type: 'http', url: 'http://127.0.0.1:7878/mcp' }, other: { command: 'x' } } } });
  // JSON fallback when the CLI fails: only the foreign entry goes, everything else stays
  let io = fakeIo({ json: base({ type: 'http', url: 'http://127.0.0.1:7978/mcp' }), exec: (cmd) => ({ ok: cmd !== 'claude', out: '' }) });
  let res = await runPlan(c, Z, item, io, FAST);
  assert.equal(res[0].status, 'done');
  assert.deepEqual(io.files[cfg], { projects: { x: 1 }, mcpServers: { mine: { type: 'http', url: 'http://127.0.0.1:7878/mcp' }, other: { command: 'x' } } });
  // the same name pointing at THIS build is never touched: no CLI call, no write
  io = fakeIo({ json: base({ type: 'http', url: `http://127.0.0.1:${alt.httpPort}/mcp` }) });
  res = await runPlan(c, Z, item, io, FAST);
  assert.equal(res[0].status, 'refused');
  assert.ok(!io.log.some((l) => l.startsWith('exec claude') || l.startsWith('write')));
  // an unreadable config: nothing is guessed
  io = fakeIo({});
  res = await runPlan(c, Z, item, io, FAST);
  assert.ok(['skipped', 'refused'].includes(res[0].status));
  assert.ok(!io.log.some((l) => l.startsWith('exec claude') || l.startsWith('write')));
}

// ---- real fs in a temp dir: a real directory goes, a link is refused and its target survives
{
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'foreign-exec-')));
  const real = realExecIo();
  const c = { platform: process.platform, home: root, tmp: root, env: {}, uid: null };
  const p = foreignPaths(c, Z);
  mkdirSync(join(p.homeDir, 'figma-plugin'), { recursive: true });
  writeFileSync(join(p.homeDir, 'zenith-bridge.mjs'), 'x');
  writeFileSync(join(p.homeDir, 'figma-plugin', 'code.js'), 'x');
  const factsFor = () => ({ pid: null, running: false, exists: {}, home: { kind: real.lstatKind(p.homeDir), realpath: real.realpath(p.homeDir), parentRealpath: real.realpath(root) }, mcp: { entry: undefined, claudeCli: false }, pluginCopies: [] });
  const items = planForeignRemoval(c, Z, factsFor());
  assert.deepEqual(items.map((i) => i.action), ['delete']);
  const res = await runPlan(c, Z, items, real, { yes: true });
  assert.equal(res[0].status, 'done');
  assert.ok(!existsSync(p.homeDir), 'the real directory is gone');
  assert.ok(existsSync(root), 'and nothing around it');

  // a symlink in its place, pointing at a directory that must survive
  const precious = join(root, 'precious');
  mkdirSync(precious);
  writeFileSync(join(precious, 'keep.txt'), 'keep');
  let linked = true;
  try { symlinkSync(precious, p.homeDir, 'dir'); } catch { linked = false; }   // Windows may need a privilege
  if (linked) {
    assert.equal(real.lstatKind(p.homeDir), 'symlink');
    const items2 = planForeignRemoval(c, Z, factsFor());
    assert.equal(items2[0].action, 'refuse');
    const res2 = await runPlan(c, Z, items2, real, { yes: true });
    assert.equal(res2[0].status, 'refused');
    // even a hand-made delete item is refused at run time, because the fresh check sees the link
    const res3 = await runPlan(c, Z, [{ kind: 'home-dir', target: p.homeDir, action: 'delete' }], real, { yes: true });
    assert.equal(res3[0].status, 'refused');
    assert.ok(existsSync(join(precious, 'keep.txt')), 'the link target was never followed');
  }
}

// ---- links inside what is deleted are removed as links, never followed (real fs)
{
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'foreign-exec-links-')));
  const real = realExecIo();
  const c = { platform: process.platform, home: root, tmp: root, env: {}, uid: null };
  const p = foreignPaths(c, Z);
  const precious = join(root, 'precious');
  mkdirSync(precious);
  writeFileSync(join(precious, 'keep.txt'), 'keep');
  writeFileSync(join(root, 'keep-file.txt'), 'keep');
  mkdirSync(p.homeDir);
  let linked = true;
  try {
    symlinkSync(precious, join(p.homeDir, 'inner-link'), 'dir');
    symlinkSync(join(root, 'keep-file.txt'), p.statusFile);   // the status file is a link to a file that must survive
  } catch { linked = false; }   // Windows may need a privilege
  if (linked) {
    const facts = { pid: null, running: false, exists: { [p.statusFile]: true }, home: { kind: real.lstatKind(p.homeDir), realpath: real.realpath(p.homeDir), parentRealpath: real.realpath(root) }, mcp: { entry: undefined, claudeCli: false }, pluginCopies: [] };
    const res = await runPlan(c, Z, planForeignRemoval(c, Z, facts), real, { yes: true });
    assert.ok(res.every((r) => r.status === 'done'), JSON.stringify(res));
    assert.ok(!existsSync(p.homeDir) && !existsSync(p.statusFile), 'the folder and the link are gone');
    assert.ok(existsSync(join(precious, 'keep.txt')), 'a link inside the folder was not followed');
    assert.ok(existsSync(join(root, 'keep-file.txt')), 'a linked status file removed only the link');
  }
}

// ---- no shell anywhere in the executor: every external command is execFile with an argument array
{
  const src = readFileSync(join(here, '..', 'src', 'foreign-remove.ts'), 'utf8') + readFileSync(join(here, '..', 'src', 'foreign-cli.ts'), 'utf8') + readFileSync(join(here, '..', 'src', 'foreign-detect.ts'), 'utf8');
  assert.ok(!/(?<![.\w])exec(Sync)?\(|(?<![.\w])spawn(Sync)?\(|shell:\s*true/.test(src), 'no exec/spawn/shell use');
  assert.ok(!/import\s*\{[^}]*\b(exec|execSync|spawn|spawnSync)\b[^}]*\}\s*from 'node:child_process'/.test(src), 'only execFile is imported');
  assert.ok(!/\bsh -c\b|cmd \/c|bash -c/.test(src));
}

// ---- the command
{
  assert.equal(isForeignCli(['node', 'x', 'remove-foreign']), true);
  assert.equal(isForeignCli(['node', 'x', 'remove-foreign', '--yes']), true);
  assert.equal(isForeignCli(['node', 'x', 'remove-foreign', '--daemon']), false);
  assert.equal(isForeignCli(['node', 'x', 'update']), false);
  assert.equal(isForeignCli(['node', 'x']), false);

  // the shipped (public) flavour watches nothing
  const lines = [];
  assert.equal(await runForeignCli(['node', 'x', 'remove-foreign', '--yes'], { out: (s) => lines.push(s) }), 0);
  assert.ok(lines.join('\n').includes('nothing to remove'), lines.join('\n'));

  // a flavour with a watchlist: listing without --yes changes nothing
  const mk = () => {
    const out = [];
    const detect = { ...ctx('linux'), probe: async () => ({ kind: 'welcome', version: '1.0.0', flavour: null }), readText: (pth) => (pth.endsWith('.zenith-bridge.status') ? JSON.stringify({ pid: 4242, version: '1.0.0' }) : null), exists: () => true, pidAlive: (pid) => pid === 4242 };
    const exec = fakeIo({ kinds: { '/Users/u/.zenith': 'dir' } });
    return { out, deps: { entries: [Z], enforcement: 'alert', detect, exec, out: (s) => out.push(s) }, exec };
  };
  let m = mk();
  assert.equal(await runForeignCli(['node', 'x', 'remove-foreign'], m.deps), 2);
  assert.ok(m.out.join('\n').includes('Nothing was changed. Run again with --yes'));
  assert.ok(m.out.join('\n').includes('/Users/u/.zenith'));
  assert.ok(!m.exec.log.some((l) => l.startsWith('kill') || l.startsWith('rm ') || l.startsWith('write') || (l.startsWith('exec') && !l.startsWith('exec claude ["--version"'))), `no change without --yes: ${m.exec.log.join('|')}`);
  m = mk();
  assert.equal(await runForeignCli(['node', 'x', 'remove-foreign', '--yes'], m.deps), 0);
  assert.ok(m.exec.log.includes('kill 4242 SIGTERM'));
  assert.ok(m.exec.log.includes('rm /Users/u/.zenith'));
  // nothing found: say so, exit 0
  m = mk();
  m.deps.detect.probe = async () => ({ kind: 'closed' });
  m.deps.detect.exists = () => false;
  m.deps.detect.readText = () => null;
  m.deps.detect.pidAlive = () => false;
  assert.equal(await runForeignCli(['node', 'x', 'remove-foreign', '--yes'], m.deps), 0);
  assert.ok(m.out.join('\n').includes('No other Grip was found'));
  // a refusal makes the exit code 1 and ends with the by-hand list
  m = mk();
  m.deps.exec = fakeIo({ kinds: { '/Users/u/.zenith': 'symlink' } });
  assert.equal(await runForeignCli(['node', 'x', 'remove-foreign', '--yes'], m.deps), 1);
  assert.ok(m.out.join('\n').includes('Still to do by hand'));
}

console.log('foreign-exec: ok');
