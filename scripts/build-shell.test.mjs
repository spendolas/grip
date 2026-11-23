import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rewritePayloadCode, buildShell, BuildError } from './build-shell.mjs';
import { renderTemplate, loadFlavour } from './gen-flavour.mjs';
import { ed25519RawKeys } from '../src/plugin/shell/assemble.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');

test('rewritePayloadCode rewrites exactly the three Figma touchpoints', () => {
  const src = [
    "figma.showUI(__html__, { width: 120, height: 32 });",
    "figma.ui.onmessage = async (m) => { if (m.kind == 'x') {} };",
    "figma.on('selectionchange', () => {});",
    "figma.once('close', () => {});",
    "figma.off('close', cb);",
    "figma.ui.postMessage({});",
    "figma.currentPage.on('x', y);",
    "if (figma.ui.onmessage == null) {}",
  ].join('\n');
  const out = rewritePayloadCode(src);
  assert.equal(out, [
    "__shell.showUI(__html__, { width: 120, height: 32 });",
    "__shell.ui.onmessage = async (m) => { if (m.kind == 'x') {} };",
    "__shell.on('selectionchange', () => {});",
    "__shell.once('close', () => {});",
    "__shell.off('close', cb);",
    "figma.ui.postMessage({});",
    "figma.currentPage.on('x', y);",
    "if (figma.ui.onmessage == null) {}",
  ].join('\n'));
  assert.throws(() => rewritePayloadCode("figma.showUI(__html__);"), BuildError);
});

function fakeRoot(loader) {
  const root = mkdtempSync(join(tmpdir(), 'build-shell-'));
  for (const d of [['src', 'plugin', 'templates'], ['src', 'plugin', 'shell'], ['scripts']]) cpSync(join(repo, ...d), join(root, ...d), { recursive: true });
  const kp = generateKeyPairSync('ed25519');
  const f = JSON.parse(readFileSync(join(repo, 'src', 'bridge', 'test', 'fixtures', 'flavour-alt', 'flavour.json'), 'utf8'));
  f.payloadLoader = loader;
  f.releaseKeys = [kp.publicKey.export({ type: 'spki', format: 'pem' })];
  const fdir = join(root, 'flavour');
  mkdirSync(fdir); writeFileSync(join(fdir, 'flavour.json'), JSON.stringify(f));
  mkdirSync(join(root, 'figma-plugin'));
  writeFileSync(join(root, 'figma-plugin', 'code.js'), "figma.showUI(__html__);\nfigma.ui.onmessage = async () => {};\nfigma.on('selectionchange', () => {});\nconst FAKE_FULL_PLUGIN = 1;\n");
  writeFileSync(join(root, 'figma-plugin', 'ui.html'), 'FULL UI');
  writeFileSync(join(root, 'figma-plugin', 'manifest.json'), 'FULL MANIFEST');
  return { root, fdir, f };
}

test('buildShell: shell into figma-plugin/, rewritten full plugin into build/payload/', () => {
  const { root, fdir, f } = fakeRoot(true);
  assert.deepEqual(buildShell({ root, flavourDir: fdir }), { skipped: false });
  const man = readFileSync(join(root, 'figma-plugin', 'manifest.json'), 'utf8');
  assert.equal(man, renderTemplate('manifest.json', readFileSync(join(root, 'src', 'plugin', 'templates', 'manifest.json'), 'utf8'), loadFlavour(fdir)), 'the shell manifest is the real manifest, byte for byte');
  const ui = readFileSync(join(root, 'figma-plugin', 'ui.html'), 'utf8');
  assert.ok(ui.includes(ed25519RawKeys(f)[0]), 'the pinned key is in the page');
  assert.ok(!/__[A-Z][A-Z0-9_]*__/.test(ui));
  assert.ok(ui.includes('gripEdVerify'));
  const shell = readFileSync(join(root, 'figma-plugin', 'code.js'), 'utf8');
  assert.ok(shell.includes('SHELL_PROTOCOL') && !shell.includes('FAKE_FULL_PLUGIN'));
  assert.ok(shell.includes(f.pagesUrl) && !/__PAGES_URL__/.test(shell));
  const payload = readFileSync(join(root, 'build', 'payload', 'code.js'), 'utf8');
  assert.ok(payload.includes('FAKE_FULL_PLUGIN') && payload.includes('__shell.on(') && !payload.includes('figma.on('));
});

test('buildShell: the public flavour is a no-op', () => {
  const { root, fdir } = fakeRoot(false);
  const before = ['code.js', 'ui.html', 'manifest.json'].map((n) => readFileSync(join(root, 'figma-plugin', n), 'utf8'));
  assert.deepEqual(buildShell({ root, flavourDir: fdir }), { skipped: true });
  assert.deepEqual(['code.js', 'ui.html', 'manifest.json'].map((n) => readFileSync(join(root, 'figma-plugin', n), 'utf8')), before);
  assert.ok(!existsSync(join(root, 'build')));
});

test('the real compiled plugin evaluates against the shell host', { skip: !existsSync(join(repo, 'figma-plugin', 'code.js')) }, () => {
  const real = readFileSync(join(repo, 'figma-plugin', 'code.js'), 'utf8');
  if (real.includes('SHELL_PROTOCOL')) return;        // the loader flavour was built here: the full plugin is in build/payload
  const out = rewritePayloadCode(real);
  const calls = [];
  const noop = () => {};
  const figma = new Proxy({}, { get: (_, k) => (k === 'ui' ? { postMessage: noop } : k === 'loadAllPagesAsync' ? () => new Promise(noop) : noop) });
  let handler = null;
  const host = { showUI: noop, ui: { set onmessage(f) { handler = f; } }, on: (e) => calls.push(e), once: noop, off: noop };
  new Function('figma', '__shell', '__html__', out)(figma, host, '');
  assert.equal(typeof handler, 'function');
  assert.deepEqual(calls.sort(), ['currentpagechange', 'selectionchange']);
});
