// The installer's registration is the agent's decision: --no-register installs the
// files but writes NO agent config, and --print-config prints details and installs nothing.
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const INSTALLER = join(HERE, '..', '..', '..', 'bridge', 'install.mjs');
if (!existsSync(INSTALLER)) { console.log('install-register.mjs: bridge not built, skipped'); process.exit(0); }

const run = (flags, home, gripHome) => spawnSync(process.execPath, [INSTALLER, ...flags], {
  env: { ...process.env, HOME: home, USERPROFILE: home, GRIP_HOME: gripHome, GRIP_STATUS_PATH: join(gripHome, 'nostatus.json') },
  encoding: 'utf8',
});
const fresh = () => ({ home: mkdtempSync(join(tmpdir(), 'grip-reg-home-')), gh: mkdtempSync(join(tmpdir(), 'grip-reg-gh-')) });

{ // --print-config: details only, nothing installed, nothing written
  const { home, gh } = fresh();
  const r = run(['--print-config'], home, gh);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /http:\/\/127\.0\.0\.1:7778\/mcp/);
  assert.match(r.stdout, /Cursor \(~\/\.cursor\/mcp\.json\)/);
  assert.match(r.stdout, /\[mcp_servers\.grip\]/);
  assert.ok(!existsSync(join(gh, 'grip-bridge.mjs')), 'installed nothing');
  assert.ok(!existsSync(join(home, '.claude.json')), 'wrote no agent config');
}
{ // --no-register: files installed, no agent config, details printed
  const { home, gh } = fresh();
  const r = run(['--no-register'], home, gh);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.ok(existsSync(join(gh, 'grip-bridge.mjs')), 'bridge installed');
  assert.ok(!existsSync(join(home, '.claude.json')), 'no ~/.claude.json written');
  assert.match(r.stdout, /Not registering \(--no-register\)/);
  assert.match(r.stdout, /Register Grip in your MCP client/);
  // a fresh install makes pairing required and opens the installer window
  assert.match(r.stdout, /pairing: required, window open for 5 minutes/);
  const pj = JSON.parse(readFileSync(join(gh, 'pairing.json'), 'utf8'));
  assert.strictEqual(pj.required, true); assert.deepStrictEqual(pj.tokens, []);
  assert.ok(JSON.parse(readFileSync(join(gh, 'pairing-window.json'), 'utf8')).until > Date.now() + 250_000, 'window is open for ~5 minutes');
  // running the installer again leaves an existing pairing setup alone
  const again = run(['--no-register'], home, gh);
  assert.match(again.stdout, /pairing: already set up/);
}

{ // chooseMcpName: pure decision
  const { chooseMcpName } = await import('../dist/mcp-name.js');
  const { FLAVOUR } = await import('../dist/flavour.gen.js');
  const ours = { command: '/n', args: ['/a'] };
  assert.deepStrictEqual(chooseMcpName('grip', undefined, undefined, ours), { name: 'grip' }, 'no existing entry');
  assert.deepStrictEqual(chooseMcpName('grip', undefined, { command: '/n', args: ['/a'] }, ours), { name: 'grip' }, 'same target');
  const foreign = chooseMcpName('grip', undefined, { url: 'http://127.0.0.1:9/mcp' }, ours);
  assert.match(foreign.refuse, /"grip".*already registered.*--mcp-name/);
  assert.match(foreign.refuse, /127\.0\.0\.1:9/);
  assert.deepStrictEqual(chooseMcpName('grip', 'other', undefined, ours), { name: 'other' }, 'flag overrides');
  assert.ok(chooseMcpName('grip', 'other', { command: '/x' }, ours).refuse, 'a flag name that is taken by something else is refused too');
  assert.strictEqual(FLAVOUR.mcpName, 'grip');
}
{ // the installer registers under FLAVOUR.mcpName, refuses a foreign entry, honours --mcp-name (JSON fallback: no claude on PATH)
  const noClaude = (flags, home, gh) => spawnSync(process.execPath, [INSTALLER, ...flags], {
    env: { ...process.env, HOME: home, USERPROFILE: home, GRIP_HOME: gh, GRIP_STATUS_PATH: join(gh, 'nostatus.json'), PATH: '/nonexistent' },
    encoding: 'utf8',
  });
  let { home, gh } = fresh();
  let r = noClaude([], home, gh);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.ok(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).mcpServers.grip, 'registered as grip');
  r = noClaude([], home, gh);
  assert.strictEqual(r.status, 0, 're-running over our own entry is fine');
  ({ home, gh } = fresh());
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { grip: { type: 'http', url: 'http://127.0.0.1:1/mcp' } } }));
  r = noClaude([], home, gh);
  assert.notStrictEqual(r.status, 0, 'refuses a foreign entry');
  assert.match(r.stdout + r.stderr, /--mcp-name/);
  assert.strictEqual(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).mcpServers.grip.url, 'http://127.0.0.1:1/mcp', 'foreign entry untouched');
  r = noClaude(['--mcp-name', 'grip-alt'], home, gh);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const cfg = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).mcpServers;
  assert.ok(cfg['grip-alt'] && cfg.grip.url === 'http://127.0.0.1:1/mcp');
}
{ // the CLI path uses the chosen name
  const { home, gh } = fresh();
  const bin = mkdtempSync(join(tmpdir(), 'grip-reg-bin-'));
  const logf = join(bin, 'calls.log');
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\necho "$@" >> "${logf}"\n`);
  chmodSync(join(bin, 'claude'), 0o755);
  const r = spawnSync(process.execPath, [INSTALLER, '--mcp-name', 'grip-x'], {
    env: { ...process.env, HOME: home, USERPROFILE: home, GRIP_HOME: gh, GRIP_STATUS_PATH: join(gh, 'nostatus.json'), PATH: bin + ':' + process.env.PATH },
    encoding: 'utf8',
  });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const calls = readFileSync(logf, 'utf8');
  assert.match(calls, /mcp remove -s user grip-x/);
  assert.match(calls, /mcp add -s user grip-x /);
  assert.ok(!/ grip\n|user grip /.test(calls), 'never touched the default name');
}
console.log('install-register.mjs OK');
