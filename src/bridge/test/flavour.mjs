// Flavour file validation + generator CLI.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..', '..');
const script = join(repo, 'scripts', 'gen-flavour.mjs');
const { loadFlavour } = await import(script);

const realDir = join(repo, 'flavour');
const altDir = join(here, 'fixtures', 'flavour-alt');
const tmp = mkdtempSync(join(tmpdir(), 'flavour-test-'));

assert.equal(loadFlavour(realDir).slug, 'grip');
assert.equal(loadFlavour(altDir).slug, 'acme');

function variant(name, mutate) {
  const d = join(tmp, name);
  mkdirSync(d, { recursive: true });
  const f = JSON.parse(readFileSync(join(realDir, 'flavour.json'), 'utf8'));
  mutate(f);
  writeFileSync(join(d, 'flavour.json'), JSON.stringify(f));
  return d;
}
function rejects(name, mutate, field) {
  const d = variant(name, mutate);
  assert.throws(() => loadFlavour(d), (e) => e instanceof Error && e.message.includes(field), name);
}
rejects('missing-ws', (f) => { delete f.wsPort; }, 'wsPort');
rejects('str-ws', (f) => { f.wsPort = '7777'; }, 'wsPort');
rejects('same-port', (f) => { f.httpPort = f.wsPort; }, 'httpPort');
rejects('bad-slug', (f) => { f.slug = 'Bad Slug'; }, 'slug');
rejects('extra', (f) => { f.bogusKey = 1; }, 'bogusKey');

const outB = join(tmp, 'out', 'bridge.gen.ts');
const outP = join(tmp, 'out', 'plugin.gen.ts');
execFileSync('node', [script, '--dir', altDir, '--out-bridge', outB, '--out-plugin', outP], { stdio: 'pipe' });
for (const o of [outB, outP]) {
  assert.ok(existsSync(o), o);
  const t = readFileSync(o, 'utf8');
  assert.match(t, /slug: 'acme'/);
  assert.match(t, /export interface Flavour/);
  assert.match(t, /export const FLAVOUR/);
}
assert.equal(readFileSync(outB, 'utf8'), readFileSync(outP, 'utf8'));
console.log('flavour: ok');
