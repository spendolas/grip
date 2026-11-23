// Pure helpers that assemble the shell page (src/plugin/templates/ui.html + verifier + loader).
// Used by scripts/build-shell.mjs and by the tests.
import { createPublicKey } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderTemplate } from '../../../scripts/gen-flavour.mjs';
import { ed25519KeyProblem } from '../../../scripts/ed25519-check.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// Inserted just before this (unique) line of the template: everything the loader hooks
// (render, tooltip, sayHello, window.onmessage, WebSocket) exists by then, and the first
// render()/connect() has not run yet.
export const ANCHOR = '      // Starting state: disconnected, grey, with the setup tooltip.';

export function bundleVerifier() {
  // loaded here, not at import: the public plugin build never needs esbuild
  const { buildSync } = createRequire(import.meta.url)('esbuild');
  const r = buildSync({
    entryPoints: [join(here, 'verify.src.js')],
    bundle: true, write: false, format: 'iife', minify: true, target: 'es2020', platform: 'browser', legalComments: 'none', logLevel: 'silent',
  });
  return r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
}

// The 32-byte raw Ed25519 public keys of the flavour's releaseKeys, as lowercase hex.
export function ed25519RawKeys(f) {
  return f.releaseKeys.map((pem) => {
    const der = createPublicKey(pem).export({ format: 'der', type: 'spki' });
    const raw = Uint8Array.from(Buffer.from(der).subarray(-32));
    const bad = ed25519KeyProblem(raw);
    if (bad) throw new Error(`shell: an unusable release key (${bad}) cannot be pinned`);
    return Buffer.from(raw).toString('hex');
  });
}

export function renderShellUi(template, f, parts) {
  const page = renderTemplate('ui.html', template, f);
  const at = page.indexOf(ANCHOR);
  if (at < 0 || page.indexOf(ANCHOR, at + 1) >= 0) throw new Error('shell: the insertion anchor must occur exactly once in templates/ui.html');
  const keys = ed25519RawKeys(f);
  if (!keys.every((k) => /^[0-9a-f]{64}$/.test(k))) throw new Error('shell: a release key is not a raw Ed25519 key');
  if (!parts.loaderJs.includes('__RELEASE_KEYS__')) throw new Error('shell: the loader has no __RELEASE_KEYS__ placeholder');
  const loader = parts.loaderJs.replace('__RELEASE_KEYS__', JSON.stringify(keys));
  const block = '      // ---- grip loader shell (generated: verifier + loader) ----\n' + parts.verifierJs.trim() + '\n' + loader.trim() + '\n      // ---- end loader shell ----\n\n';
  return page.slice(0, at) + block + page.slice(at);
}
