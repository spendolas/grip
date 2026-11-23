#!/usr/bin/env node
// Second plugin build target (phase 3): for a flavour with `payloadLoader: true`, turns the
// freshly compiled FULL plugin (figma-plugin/code.js, from tsc) into
//   build/payload/code.js        the full plugin with its three Figma touchpoints rewritten to the
//                                `__shell` host (what payload.json carries, see scripts/payload.mjs)
//   figma-plugin/code.js         the shell main thread   (src/plugin/shell/shell-code.js)
//   figma-plugin/ui.html         the status strip page + verifier + loader (assemble.mjs)
//   figma-plugin/manifest.json   the real manifest, rendered exactly as for any flavour
// so figma-plugin/ is what the maintainer imports/publishes. A no-op for every other flavour.
//
//   node scripts/build-shell.mjs [--root <repo>]      (flavour dir: GRIP_FLAVOUR_DIR, default <root>/flavour)
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFlavour, renderTemplate } from './gen-flavour.mjs';
import { bundleVerifier, renderShellUi } from '../src/plugin/shell/assemble.mjs';

export class BuildError extends Error {}

const SHELL_MARKER = 'Grip loader shell, main thread';

// The plugin binds itself to the iframe and to Figma events in exactly three ways; the shell
// owns those so a replaced payload can be cut off. Nothing else about `figma` changes.
export function rewritePayloadCode(code) {
  const out = code
    .replace(/\bfigma\.showUI\(/g, '__shell.showUI(')
    .replace(/\bfigma\.ui\.onmessage\s*=(?!=)/g, '__shell.ui.onmessage =')
    .replace(/\bfigma\.(on|once|off)\(/g, '__shell.$1(');
  if (!out.includes('__shell.ui.onmessage =')) throw new BuildError('the plugin never assigns figma.ui.onmessage; the payload would have no message handler');
  if (/\bfigma\.(showUI|on|once|off)\(|\bfigma\.ui\.(on|once|off)\(|\bfigma\.ui\.onmessage\s*=(?!=)/.test(out)) throw new BuildError('a Figma touchpoint was not rewritten');
  return out;
}

function atomicWrite(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export function buildShell({ root, flavourDir }) {
  root = resolve(root);
  const f = loadFlavour(flavourDir ? resolve(flavourDir) : process.env.GRIP_FLAVOUR_DIR ? resolve(process.env.GRIP_FLAVOUR_DIR) : join(root, 'flavour'));
  if (!f.payloadLoader) return { skipped: true };
  const plugin = join(root, 'figma-plugin');
  const full = readFileSync(join(plugin, 'code.js'), 'utf8');
  if (full.includes(SHELL_MARKER)) throw new BuildError('figma-plugin/code.js is already the shell; compile the plugin (tsc) first');
  const src = join(root, 'src', 'plugin');
  // render everything first, write after: a failure never leaves half an output
  const payloadCode = rewritePayloadCode(full);
  const shellCode = renderTemplate('shell-code.js', readFileSync(join(src, 'shell', 'shell-code.js'), 'utf8'), f);
  const ui = renderShellUi(readFileSync(join(src, 'templates', 'ui.html'), 'utf8'), f, { verifierJs: bundleVerifier(), loaderJs: readFileSync(join(src, 'shell', 'loader-ui.js'), 'utf8') });
  const manifest = renderTemplate('manifest.json', readFileSync(join(src, 'templates', 'manifest.json'), 'utf8'), f);
  atomicWrite(join(root, 'build', 'payload', 'code.js'), payloadCode);
  atomicWrite(join(plugin, 'code.js'), shellCode);
  atomicWrite(join(plugin, 'ui.html'), ui);
  atomicWrite(join(plugin, 'manifest.json'), manifest);
  return { skipped: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const i = process.argv.indexOf('--root');
    const root = i >= 0 ? process.argv[i + 1] : join(dirname(fileURLToPath(import.meta.url)), '..');
    const r = buildShell({ root });
    process.stderr.write(r.skipped ? 'build-shell: flavour is not a loader, skipped\n' : 'build-shell: shell written to figma-plugin/, payload source to build/payload/code.js\n');
  } catch (e) {
    process.stderr.write(`build-shell: ${e.message}\n`);
    process.exit(1);
  }
}
