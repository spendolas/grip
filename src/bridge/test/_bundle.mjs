// Shared helper: bundles a bridge entry (src/index.ts, src/install.ts, ...) with a
// FLAVOUR directory's generated flavour.gen.ts resolved in place of ./flavour.gen.js
// (the real generated file is never touched). Used by flavour-isolation.mjs and
// release-keys.mjs.
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const bridgeDir = resolve(here, '..');
const repo = resolve(bridgeDir, '..', '..');

// Generates the flavour of `flavourDir` into `tmp` and returns
// { genFile, bundle(entry) -> bundled ESM text }.
export function flavourBundler(flavourDir, tmp) {
  const genFile = join(tmp, 'flavour.gen.ts');
  execFileSync('node', [join(repo, 'scripts', 'gen-flavour.mjs'), '--dir', flavourDir,
    '--out-bridge', genFile, '--out-plugin', join(tmp, 'plugin.gen.ts'), '--out-plugin-dir', join(tmp, 'figma-plugin')], { stdio: 'pipe' });
  const swapFlavour = {
    name: 'swap-flavour',
    setup(b) {
      b.onResolve({ filter: /^\.\/flavour\.gen(\.js)?$/ }, () => ({ path: genFile }));
    },
  };
  async function bundle(entry) {
    const r = await build({
      entryPoints: [join(bridgeDir, entry)],
      bundle: true, platform: 'node', target: 'node18', format: 'esm',
      write: false, logLevel: 'silent',
      plugins: [swapFlavour],
    });
    return r.outputFiles[0].text;
  }
  return { genFile, bundle };
}
