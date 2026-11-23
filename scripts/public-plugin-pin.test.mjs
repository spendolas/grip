// Pins the public flavour's built plugin files. The payload loader must never change them.
// Needs `npm run build` first (the root `npm test` builds before it runs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const golden = JSON.parse(readFileSync(join(here, 'public-plugin-golden.json'), 'utf8'));

for (const name of Object.keys(golden)) {
  test(`public plugin output is byte-identical: ${name}`, () => {
    const got = createHash('sha256').update(readFileSync(join(root, 'figma-plugin', name))).digest('hex');
    assert.equal(got, golden[name], `the public plugin output changed (${name}); if this is intentional and NOT from the payload loader, re-record the golden hashes`);
  });
}
