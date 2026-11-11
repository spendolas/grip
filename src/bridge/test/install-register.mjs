// The installer's registration is the agent's decision: --no-register installs the
// files but writes NO agent config, and --print-config prints details and installs nothing.
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
console.log('install-register.mjs OK');
