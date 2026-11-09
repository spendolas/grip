// FAILS when the committed bridge/version.json is stale. The release manifest
// hashes the committed build artifacts (bridge/grip-bridge.mjs, bridge/install.mjs
// and every file in figma-plugin/); if any of them changed without regenerating
// it, or BRIDGE_VERSION was bumped without regenerating it, every updater would
// reject the release. Fix: `npm run build` at the repo root, commit the results.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRIDGE_VERSION } from '../dist/types.js';
import { computeManifest } from '../../../scripts/version-manifest.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const committed = JSON.parse(readFileSync(join(root, 'bridge', 'version.json'), 'utf8'));
const fresh = computeManifest(root);
const HINT = 'bridge/version.json is stale: run `npm run build` at the repo root and commit bridge/version.json with the other generated files.';

assert.strictEqual(committed.version, BRIDGE_VERSION, `version.json says ${committed.version} but BRIDGE_VERSION is ${BRIDGE_VERSION}. ${HINT}`);
assert.strictEqual(committed.bridge.sha256, fresh.bridge.sha256, `bridge/grip-bridge.mjs hash differs. ${HINT}`);
assert.strictEqual(committed.bridge.bytes, fresh.bridge.bytes, `bridge/grip-bridge.mjs size differs. ${HINT}`);
assert.strictEqual(committed.installer.sha256, fresh.installer.sha256, `bridge/install.mjs hash differs. ${HINT}`);
assert.deepStrictEqual(Object.keys(committed.plugin.files), Object.keys(fresh.plugin.files), `figma-plugin/ file list differs. ${HINT}`);
for (const [name, f] of Object.entries(fresh.plugin.files)) {
  assert.strictEqual(committed.plugin.files[name].sha256, f.sha256, `figma-plugin/${name} hash differs. ${HINT}`);
}
assert.deepStrictEqual(committed, fresh, HINT);
assert.ok(!('version.json' in committed.plugin.files), 'version.json must not hash itself');

console.log('version-fresh.mjs OK');
