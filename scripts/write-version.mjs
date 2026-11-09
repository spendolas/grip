#!/usr/bin/env node
// Writes bridge/version.json (the release manifest). Run as the LAST step of
// `npm run build`.
//
// ORDERING PITFALL: version.json hashes bridge/grip-bridge.mjs, bridge/install.mjs
// and everything in figma-plugin/. If it runs before the bridge or plugin build
// finishes it records hashes of the OLD files, and every updater would then
// reject the release (sha256 mismatch). So: never reorder it ahead of the builds
// in the root package.json, and re-run `npm run build` (not this script alone)
// after any source change. The freshness test (src/bridge/test/version-fresh.mjs)
// fails when the committed manifest does not match the committed artifacts.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeManifest } from './version-manifest.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = computeManifest(root);
writeFileSync(join(root, 'bridge', 'version.json'), JSON.stringify(manifest, null, 2) + '\n');
process.stdout.write(`  wrote bridge/version.json (v${manifest.version}, ${Object.keys(manifest.plugin.files).length} plugin files)\n`);
