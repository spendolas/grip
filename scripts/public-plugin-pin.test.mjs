// Pins the public flavour's built plugin files: the payload loader must never change them.
// Needs `npm run build` first (the root `npm test` builds before it runs).
//
// code.js is hashed with the `const PLUGIN_VERSION = '...'` literal normalised, so a routine
// version bump does not move the pin while any other change to the output still does.
//
// RE-RECORD (one command) after a deliberate change that is NOT the payload loader: editing the
// plugin sources or templates, or merging a branch that does (e.g. one that edits templates/ui.html):
//   npm run build && node scripts/public-plugin-pin.test.mjs --record
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const goldenPath = join(here, 'public-plugin-golden.json');
const NAMES = ['code.js', 'ui.html', 'manifest.json'];

function hashOf(name) {
  let text = readFileSync(join(root, 'figma-plugin', name), 'utf8');
  if (name === 'code.js') {
    const re = /(const PLUGIN_VERSION = ')[^']*(')/g;
    assert.equal((text.match(re) || []).length, 1, 'code.js has exactly one PLUGIN_VERSION literal');
    text = text.replace(re, '$1<version>$2');
  }
  return createHash('sha256').update(text).digest('hex');
}

if (process.argv.includes('--record')) {
  let old = {};
  try { old = JSON.parse(readFileSync(goldenPath, 'utf8')); } catch { /* first recording */ }
  const next = Object.fromEntries(NAMES.map((n) => [n, hashOf(n)]));
  for (const n of NAMES) console.log(`${n}: ${old[n] === next[n] ? 'unchanged' : `${(old[n] || 'none').slice(0, 12)} -> ${next[n].slice(0, 12)}`}`);
  writeFileSync(goldenPath, JSON.stringify(next, null, 2) + '\n');
  console.log(`recorded ${goldenPath}`);
} else {
  const golden = JSON.parse(readFileSync(goldenPath, 'utf8'));
  for (const name of NAMES) {
    test(`public plugin output is byte-identical: ${name}`, () => {
      assert.equal(hashOf(name), golden[name], `the public plugin output changed (${name}). If this is intentional and NOT from the payload loader, run: npm run build && node scripts/public-plugin-pin.test.mjs --record`);
    });
  }
}
