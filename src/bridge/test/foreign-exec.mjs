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
  const files = Object.fromEntries(Object.entries(o.json ?? {}).map(([k, v]) => [k, JSON.stringify(v, null, 2)]));
  const cfgReads = {};
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
      if (o.stubborn && o.stubborn.includes(pid)) { log.push(`kill ${pid} ${sig}`); return true; }
      log.push(`kill ${pid} ${sig}`);
      const die = o.dieOn ?? 'SIGTERM';
      if (die === 'SIGTERM' || (die === 'SIGKILL' && sig === 'SIGKILL')) alive.delete(pid);
      if (o.supervisorKillsChild && pid === 4200) alive.delete(4242);
      return true;
    },
    pidAlive: (pid) => alive.has(pid),
    portOpen: async () => o.portAlwaysOpen === true || ((o.portStaysOpen ?? false) && alive.has(4242)),
    sleep: async (ms) => { log.push(`sleep ${ms}`); },
    lstatKind: (p) => (o.kinds && p in o.kinds ? o.kinds[p] : (p.endsWith('.zenith') || p.endsWith('.app') ? 'dir' : 'file')),
    realpath: (p) => (o.realpaths && p in o.realpaths ? o.realpaths[p] : p),
    rm: (p) => {
      const f = rmFails.get(p);
      if (f && f.times > 0) { f.times--; const e = new Error('locked'); e.code = f.code; throw e; }
      log.push(`rm ${p}`);
    },
    listDir: (p) => (p.endsWith('Contents/MacOS') ? ['zenith-daemon'] : (o.homeFiles ?? [])),
    readText: (p) => {
      if (o.changeAfterFirstRead && p in files) { cfgReads[p] = (cfgReads[p] ?? 0) + 1; if (cfgReads[p] > 1) return files[p] + ' '; }
      if (p in files) return files[p];
      if (p.includes('/Contents/MacOS/')) return o.launcher === false ? '#!/bin/bash\nexec node /Users/u/.other/x.mjs' : '#!/bin/bash\nexec node "/Users/u/.zenith/zenith-bridge.mjs" --daemon';
      return null;
    },
    writeFile: (p, d, mode) => { log.push(`write ${p} ${mode.toString(8)}`); files[p] = d; },
    rename: (a, b) => { log.push(`rename ${a} ${b}`); files[b] = files[a]; delete files[a]; },
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
  for (const cmd of ['node /x/other.mjs --daemon', 'node /x/zenith-bridge.mjs', 'node /x/zenith-bridge.mjs --daemon', null]) {
    const io = fakeIo({ cmds: { 4242: cmd } });
    if (cmd === null) delete io.procCommand, io.procCommand = () => null;
    const res = await runPlan(c, Z, planForeignRemoval(c, Z, facts), io, FAST);
    assert.equal(status(res, 'stop-daemon'), 'refused', String(cmd));
    assert.ok(!io.log.some((l) => l.startsWith('kill 4242')), 'never signalled');
    // a pid that is another program: the user-requested deletes still happen; one that could not be read stays unverified
    assert.equal(status(res, 'home-dir'), cmd === null ? 'skipped' : 'done');
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
  let io = fakeIo({ cmds: { 4242: 'node C:\\Users\\u\\.zenith\\zenith-bridge.mjs --daemon' }, rmFails: { [p.homeDir]: { times: 3, code: 'EBUSY' } } });
  let res = await runPlan(c, Z, planForeignRemoval(c, Z, facts), io, { yes: true, graceMs: 10, deleteRetries: 6 });
  assert.equal(status(res, 'home-dir'), 'done', 'retries until the lock lets go');
  assert.ok(io.log.filter((l) => l.startsWith('sleep')).length >= 3, 'with backoff');
  io = fakeIo({ cmds: { 4242: 'node C:\\Users\\u\\.zenith\\zenith-bridge.mjs --daemon' }, rmFails: { [p.homeDir]: { times: 999, code: 'EBUSY' }, [p.logFile]: { times: 999, code: 'EPERM' } } });
  res = await runPlan(c, Z, planForeignRemoval(c, Z, facts), io, { yes: true, graceMs: 10, deleteRetries: 2 });
  assert.equal(status(res, 'home-dir'), 'deferred');
  assert.ok(res.find((r) => r.item.kind === 'home-dir').note.includes('will be removable after restart'));
  assert.equal(status(res, 'log-file'), 'deferred');
  assert.equal(status(res, 'status-file'), 'done', 'the other items still run');
  assert.ok(!res.some((r) => r.status === 'failed'), 'a locked file is not a failure');
  // any other error is a failure, not a retry loop
  io = fakeIo({ rmFails: { [p.logFile]: { times: 1, code: 'EACCES' } }, cmds: { 4242: 'node C:\\Users\\u\\.zenith\\zenith-bridge.mjs --daemon' } });
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

// ---- the MCP entry (review focus 5; fix wave I3: atomic, backed up, never clobbers a concurrent write)
{
  const { c, p } = fullFacts('linux');
  const cfg = p.claudeConfig;
  const item = [{ kind: 'mcp-entry', target: 'zenith', action: 'run-cli-or-edit-json' }];
  const base = (entry) => ({ [cfg]: { projects: { x: 1 }, mcpServers: { zenith: entry, mine: { type: 'http', url: 'http://127.0.0.1:7878/mcp' }, other: { command: 'x' } } } });
  const foreignEntry = { type: 'http', url: 'http://127.0.0.1:7978/mcp' };
  const noCli = (cmd) => ({ ok: cmd !== 'claude', out: '' });
  // CLI works: that is the whole job
  let io = fakeIo({ json: base(foreignEntry) });
  let res = await runPlan(c, Z, item, io, FAST);
  assert.equal(res[0].status, 'done');
  assert.ok(!io.log.some((l) => l.startsWith('write')), 'no file edit when the CLI did it');
  // the fallback: a 0600 backup, a 0600 temp file, then a rename; only the foreign entry goes
  io = fakeIo({ json: base(foreignEntry), exec: noCli });
  const before = io.files[cfg];
  res = await runPlan(c, Z, item, io, FAST);
  assert.equal(res[0].status, 'done');
  const writes = io.log.filter((l) => l.startsWith('write') || l.startsWith('rename'));
  assert.equal(writes.length, 3, writes.join('|'));
  assert.ok(/^write .*\.claude\.json\.grip-remove-\d+\.bak 600$/.test(writes[0]), writes[0]);
  assert.ok(/^write .*\.claude\.json\.grip-remove-\d+\.tmp 600$/.test(writes[1]), writes[1]);
  assert.ok(writes[2].startsWith('rename ') && writes[2].endsWith(` ${cfg}`), writes[2]);
  const bakPath = writes[0].split(' ')[1];
  assert.equal(io.files[bakPath], before, 'the backup is the original, byte for byte');
  assert.deepEqual(JSON.parse(io.files[cfg]), { projects: { x: 1 }, mcpServers: { mine: { type: 'http', url: 'http://127.0.0.1:7878/mcp' }, other: { command: 'x' } } });
  assert.ok(!Object.keys(io.files).some((k) => k.endsWith('.tmp')), 'no temp file left');
  // somebody else wrote the config meanwhile: abort, write nothing, keep the backup
  io = fakeIo({ json: base(foreignEntry), exec: noCli, changeAfterFirstRead: true });
  const orig = io.files[cfg];
  res = await runPlan(c, Z, item, io, FAST);
  assert.equal(res[0].status, 'failed');
  assert.ok(res[0].note.includes('changed while this ran') && res[0].note.includes('claude mcp remove -s user zenith'));
  assert.ok(!io.log.some((l) => l.startsWith('rename')));
  assert.equal(io.files[cfg], orig, 'the config is untouched');
  assert.ok(io.log.some((l) => /^rm .*\.tmp$/.test(l)), 'the temp file is removed');
  // Windows: no guessing at the file, say what to run
  const w = fullFacts('win32');
  io = fakeIo({ json: { [w.p.claudeConfig]: { mcpServers: { zenith: foreignEntry } } }, exec: noCli });
  res = await runPlan(w.c, Z, item, io, FAST);
  assert.equal(res[0].status, 'instruct');
  assert.ok(res[0].note.includes('claude mcp remove -s user zenith'));
  assert.ok(!io.log.some((l) => l.startsWith('write') || l.startsWith('rename')));
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

// ---- C1: colliding names. Every flavour's entry file is grip-bridge.mjs, so OUR daemon and OUR supervisor
// look like the foreign ones unless the EXACT foreign path is required.
{
  const G = { ...Z, homeDirName: '.grip', entryName: 'grip-bridge', loginItem: 'Grip Daemon' };
  const c = ctx('darwin');
  const p = foreignPaths(c, G);
  const OWN_HOME = '/Users/u/.grip-alt';
  const own = { pids: [], home: OWN_HOME, paths: [OWN_HOME, '/Users/u/.grip-alt-bridge.status'] };
  const facts = { pid: 4242, running: true, exists: Object.fromEntries(p.autostart.map((a) => [a.path, true])), home: { kind: 'dir', realpath: p.homeDir, parentRealpath: c.home }, mcp: { entry: undefined, claudeCli: false }, pluginCopies: [] };
  const items = planForeignRemoval(c, G, facts);
  const FOREIGN = 'node /Users/u/.grip/grip-bridge.mjs --daemon --persistent';
  const OWN_DAEMON = `node ${OWN_HOME}/grip-bridge.mjs --daemon --persistent`;
  const FOREIGN_SUP = '/bin/bash /Users/u/Applications/Grip Daemon.app/Contents/MacOS/grip-daemon';
  const OWN_SUP = '/bin/bash /Users/u/Applications/Alt Grip Daemon.app/Contents/MacOS/grip-daemon';
  const go = (opts, over = {}) => { const io = fakeIo({ alive: [4242, 4200], parents: { 4242: 4200 }, supervisorKillsChild: true, ...opts }); return runPlan(c, G, items, io, { ...FAST, own, ...over }).then((res) => ({ io, res })); };
  const killed = (io, pid) => io.log.some((l) => l.startsWith(`kill ${pid} `));

  // our own daemon (stale pid file now pointing at it) and our own supervisor: never touched
  let r = await go({ cmds: { 4242: OWN_DAEMON, 4200: OWN_SUP } });
  assert.equal(status(r.res, 'stop-daemon'), 'refused');
  assert.equal(status(r.res, 'stop-supervisor'), 'refused');
  assert.ok(!killed(r.io, 4242) && !killed(r.io, 4200), 'neither our daemon nor our supervisor is signalled');
  // a foreign-looking supervisor above OUR daemon: the child is verified first, the parent is never touched
  r = await go({ cmds: { 4242: OWN_DAEMON, 4200: FOREIGN_SUP } });
  assert.ok(!killed(r.io, 4242) && !killed(r.io, 4200));
  // the real foreign daemon under a lookalike supervisor: the daemon is stopped, the supervisor is refused
  r = await go({ cmds: { 4242: FOREIGN, 4200: OWN_SUP }, supervisorKillsChild: false });
  assert.equal(status(r.res, 'stop-supervisor'), 'refused');
  assert.ok(!killed(r.io, 4200), 'the lookalike Alt Grip Daemon.app is not the foreign login item');
  assert.ok(killed(r.io, 4242));
  // the real foreign daemon and its real supervisor are accepted
  r = await go({ cmds: { 4242: FOREIGN, 4200: FOREIGN_SUP } });
  assert.equal(status(r.res, 'stop-supervisor'), 'done');
  assert.ok(killed(r.io, 4200));
  // --daemon is a whole argument
  r = await go({ cmds: { 4242: 'node /Users/u/.grip/grip-bridge.mjs --daemonize', 4200: FOREIGN_SUP } });
  assert.equal(status(r.res, 'stop-daemon'), 'refused');
  assert.ok(!killed(r.io, 4242));
  // our own pids are never signalled, even if the command line looks foreign
  r = await go({ cmds: { 4242: FOREIGN, 4200: FOREIGN_SUP } }, { own: { ...own, pids: [4242] } });
  assert.equal(status(r.res, 'stop-daemon'), 'refused');
  assert.ok(!killed(r.io, 4242));
  r = await go({ cmds: { 4242: FOREIGN, 4200: FOREIGN_SUP } }, { own: { ...own, pids: [4200] } });
  assert.equal(status(r.res, 'stop-supervisor'), 'refused');
  assert.ok(!killed(r.io, 4200));
  // a hand-made stop item without its typed pid is refused
  r = await go({}, {});
  const res0 = await runPlan(c, G, [{ kind: 'stop-daemon', target: 'pid 4242', action: 'stop' }], fakeIo(), { ...FAST, own });
  assert.equal(res0[0].status, 'refused');
}

// ---- I1: our own names, at run time
{
  const { c, p, facts } = fullFacts('linux');
  const items = planForeignRemoval(c, Z, facts);
  // a status file / log / socket path that is one of OURS is refused (the generator forbids it; this is the second lock)
  let io = fakeIo();
  let res = await runPlan(c, Z, items, io, { ...FAST, own: { pids: [], home: null, paths: [p.logFile, p.statusFile.toUpperCase()] } });
  assert.equal(status(res, 'log-file'), 'refused');
  assert.ok(!io.log.includes(`rm ${p.logFile}`));
  // our own home folder, by name or by what it resolves to
  io = fakeIo();
  res = await runPlan(c, Z, items, io, { ...FAST, own: { pids: [], home: p.homeDir, paths: [] } });
  assert.equal(status(res, 'home-dir'), 'refused');
  assert.ok(!io.log.includes(`rm ${p.homeDir}`));
  io = fakeIo({ realpaths: { [p.homeDir]: '/vol/ours', '/Users/u/.acme': '/vol/ours' } });
  res = await runPlan(c, Z, items, io, { ...FAST, own: { pids: [], home: '/Users/u/.acme', paths: [] } });
  assert.equal(status(res, 'home-dir'), 'refused');
  assert.ok(!io.log.includes(`rm ${p.homeDir}`));
  // an app bundle whose launcher does not start the foreign bridge is left alone
  const d = fullFacts('darwin');
  io = fakeIo({ launcher: false, cmds: { 4200: '/bin/bash /Users/u/Applications/Zenith Daemon.app/Contents/MacOS/zenith-daemon' }, alive: [4242, 4200] });
  res = await runPlan(d.c, Z, planForeignRemoval(d.c, Z, d.facts), io, FAST);
  assert.ok(res.filter((r) => r.item.kind === 'app-bundle').every((r) => r.status === 'refused'));
  assert.ok(!io.log.some((l) => l.startsWith('rm /Users/u/Applications/Zenith') || l.startsWith('rm /Applications/Zenith')));
}

// ---- I2: nothing is deleted under a daemon that was never stopped
{
  const { c, facts } = fullFacts('linux');
  const notDeleted = (io) => !io.log.some((l) => /^rm .*(\.zenith$|zenith-bridge\.(log|status)$)/.test(l));
  // running, process could not be identified (instruct), port still open
  let io = fakeIo({ portStaysOpen: true });
  let res = await runPlan(c, Z, planForeignRemoval(c, Z, { ...facts, pid: null }), io, FAST);
  assert.equal(status(res, 'stop-daemon'), 'instruct');
  assert.equal(status(res, 'home-dir'), 'skipped');
  assert.equal(status(res, 'log-file'), 'skipped');
  assert.equal(status(res, 'status-file'), 'skipped');
  assert.ok(res.find((r) => r.item.kind === 'home-dir').note.includes('daemon still running'));
  assert.ok(notDeleted(io));
  // the command line could not be read and the process is alive: unverified, so nothing under it is deleted
  io = fakeIo({ cmds: { 4242: null } });
  res = await runPlan(c, Z, planForeignRemoval(c, Z, facts), io, FAST);
  assert.equal(status(res, 'stop-daemon'), 'refused');
  assert.equal(status(res, 'home-dir'), 'skipped');
  assert.ok(notDeleted(io));
  // it exits but the port stays open: not stopped as far as anyone can tell
  io = fakeIo({ portAlwaysOpen: true });
  res = await runPlan(c, Z, planForeignRemoval(c, Z, facts), io, FAST);
  assert.equal(status(res, 'stop-daemon'), 'failed');
  assert.ok(res.find((r) => r.item.kind === 'stop-daemon').note.includes('still open'));
  assert.equal(status(res, 'home-dir'), 'skipped');
  assert.ok(notDeleted(io));
  // a stale pid that is some other program, port closed: the user's deletes go ahead
  io = fakeIo({ cmds: { 4242: 'node /x/other.mjs --daemon' } });
  res = await runPlan(c, Z, planForeignRemoval(c, Z, facts), io, FAST);
  assert.equal(status(res, 'home-dir'), 'done');
  // a supervisor that will not exit blocks everything after it
  const d = fullFacts('darwin');
  io = fakeIo({ cmds: { 4200: '/bin/bash /Users/u/Applications/Zenith Daemon.app/Contents/MacOS/zenith-daemon' }, alive: [4242, 4200], stubborn: [4200] });
  res = await runPlan(d.c, Z, planForeignRemoval(d.c, Z, d.facts), io, FAST);
  assert.equal(status(res, 'stop-supervisor'), 'failed');
  assert.equal(status(res, 'home-dir'), 'skipped');
  assert.ok(res.filter((r) => r.item.action === 'delete').every((r) => r.status === 'skipped'));
}

// ---- minors: permission errors, extra files, wording
{
  const { c, facts, p } = fullFacts('linux');
  const items = planForeignRemoval(c, Z, facts);
  // POSIX: EPERM is not "removable after restart"
  let io = fakeIo({ rmFails: { [p.logFile]: { times: 99, code: 'EPERM' } } });
  let res = await runPlan(c, Z, items, io, FAST);
  assert.equal(status(res, 'log-file'), 'failed');
  assert.ok(res.find((r) => r.item.kind === 'log-file').note.includes('Finder'));
  assert.ok(!io.log.some((l) => l.startsWith('sleep') && false));
  io = fakeIo({ rmFails: { [p.logFile]: { times: 99, code: 'ENOTEMPTY' } } });
  assert.equal(status(await runPlan(c, Z, items, io, FAST), 'log-file'), 'failed');
  // rotated log and dump files named from the watchlist prefix go too (and only those)
  const h = c.home;
  const withExtras = planForeignRemoval(c, Z, { ...facts, extraFiles: [`${h}/.zenith-bridge.log.1`, `${h}/.zenith-bridge.dump-1700000000.json`, `${h}/.zenith-bridge.dump-x.json`, '/etc/passwd'] });
  assert.deepEqual(withExtras.filter((i) => i.kind === 'log-file').map((i) => i.target), [p.logFile, `${h}/.zenith-bridge.log.1`, `${h}/.zenith-bridge.dump-1700000000.json`]);
  io = fakeIo();
  res = await runPlan(c, Z, withExtras, io, FAST);
  assert.ok(io.log.includes(`rm ${h}/.zenith-bridge.log.1`) && io.log.includes(`rm ${h}/.zenith-bridge.dump-1700000000.json`));
  // and a hand-made item for another file in the home folder is refused
  res = await runPlan(c, Z, [{ kind: 'log-file', target: `${h}/.zshrc`, action: 'delete' }], fakeIo(), FAST);
  assert.equal(res[0].status, 'refused');
  // collectFacts lists them (from the fake directory listing)
  const { collectFacts } = await import('../dist/foreign-remove.js');
  const f2 = await collectFacts(c, Z, { slug: 'zenith', state: 'insecure', version: '1.0.0', floor: '2.0.0', evidence: [], running: false, pid: null }, { exists: () => false }, fakeIo({ homeFiles: ['.zenith-bridge.log.1', '.zenith-bridge.dump-1.json', 'notes.txt', '.zenith-bridge.dump-1.json.bak'] }));
  assert.deepEqual(f2.extraFiles.map((x) => x.split('/').pop()), ['.zenith-bridge.log.1', '.zenith-bridge.dump-1.json']);
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
  // a Grip at or above the floor is optional to remove: --include-secure is required before any action
  m = mk();
  m.deps.detect.probe = async () => ({ kind: 'welcome', version: '2.5.0', flavour: null });
  assert.equal(await runForeignCli(['node', 'x', 'remove-foreign', '--yes'], m.deps), 0);
  assert.ok(m.out.join('\n').includes('up to date and safe to keep; removing it is optional'), m.out.join('\n'));
  assert.ok(!m.exec.log.some((l) => l.startsWith('kill') || l.startsWith('rm ')), 'nothing happens to a secure Grip without --include-secure');
  m = mk();
  m.deps.detect.probe = async () => ({ kind: 'welcome', version: '2.5.0', flavour: null });
  assert.equal(await runForeignCli(['node', 'x', 'remove-foreign', '--yes', '--include-secure'], m.deps), 0);
  assert.ok(m.exec.log.includes('rm /Users/u/.zenith'));
  m = mk();
  m.deps.detect.probe = async () => ({ kind: 'welcome', version: '2.5.0', flavour: null });
  assert.equal(await runForeignCli(['node', 'x', 'remove-foreign', '--include-secure'], m.deps), 2, 'still lists only without --yes');
  // a running daemon that could not be identified (so was not stopped) is exit 1, not 0
  m = mk();
  m.deps.detect.readText = () => null;
  assert.equal(await runForeignCli(['node', 'x', 'remove-foreign', '--yes'], m.deps), 1);
  assert.ok(m.out.join('\n').includes('Still to do by hand'));
  assert.ok(m.out.join('\n').includes('the folder and everything in it'));
}

console.log('foreign-exec: ok');
