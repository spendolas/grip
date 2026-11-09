// Computes the release manifest (bridge/version.json) from the committed build
// artifacts. Pure: no writes. Shared by write-version.mjs (which writes it) and
// src/bridge/test/version-fresh.mjs (which fails when the committed file is stale).
//
// The manifest is what `grip_update` / the plugin indicator / `update` CLI fetch
// from GitHub raw to learn "is there a newer Grip, and what are the exact bytes?".
// version.json itself is never hashed.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export function readBridgeVersion(root) {
  const src = readFileSync(join(root, 'src', 'bridge', 'src', 'types.ts'), 'utf8');
  const m = /export const BRIDGE_VERSION = '([^']+)'/.exec(src);
  if (!m) throw new Error('BRIDGE_VERSION not found in src/bridge/src/types.ts');
  return m[1];
}

export function computeManifest(root) {
  const bridgeRel = 'bridge/grip-bridge.mjs';
  const installerRel = 'bridge/install.mjs';
  const bridge = readFileSync(join(root, bridgeRel));
  const installer = readFileSync(join(root, installerRel));

  // Every file in figma-plugin/ (flat: the updater writes plugin files by bare
  // name into ~/.grip/figma-plugin, so subdirectories are not supported).
  const pluginDir = join(root, 'figma-plugin');
  const files = {};
  for (const name of readdirSync(pluginDir).sort()) {
    if (name.startsWith('.')) continue;
    const full = join(pluginDir, name);
    if (!statSync(full).isFile()) throw new Error(`figma-plugin/${name} is not a file; the updater only supports a flat folder`);
    files[name] = { path: `figma-plugin/${name}`, sha256: sha256(readFileSync(full)) };
  }

  return {
    version: readBridgeVersion(root),
    bridge: { file: bridgeRel, sha256: sha256(bridge), bytes: bridge.length },
    installer: { file: installerRel, sha256: sha256(installer) },
    plugin: { files },
  };
}
