#!/usr/bin/env node
// The signed plugin payload of a `payloadLoader` flavour (phase 3).
//
//   node scripts/payload.mjs [--root <repo>] [--out <file>]
//
// A payload is one JSON file, signed on its own with the flavour's release key:
//   { "layout":1, "header":{"shellProtocol":1,"flavour":"<slug>","version":"<x.y.z>"},
//     "code":"<plugin main thread>", "ui":"<optional ui patch script>", "sig":"<base64, 64 bytes>" }
// The signature covers `signingMessage(header, code, ui)`. The shell (src/plugin/shell/
// loader-ui.js) rebuilds the same bytes in plain JS and verifies them against the public
// key(s) pinned at its build time; keep the two in step (src/bridge/test/fixtures/
// payload-vector.json pins them to one vector). The file is also a release asset listed in
// SHA256SUMS.txt, so the updater checks its download through the signed sums as well.
//
// The CLI (release.yml, between Tests and Package) is a no-op for a flavour without
// `payloadLoader`. It signs when GRIP_RELEASE_SIGNING_KEY (PKCS8 PEM) is set, after checking
// the signature against the pinned keys (a wrong secret fails here); with no key it writes
// an UNSIGNED payload (sig "") so a dry run can still package.
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLockstep } from './package-release.mjs';
import { isSinglePublicPem } from './gen-flavour.mjs';

export class PayloadError extends Error {}

export const PAYLOAD_LAYOUT = 1;
export const PAYLOAD_NAME = 'grip-plugin-payload.json';
export const KEY_ENV = 'GRIP_RELEASE_SIGNING_KEY';

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const SLUG_RE = /^[a-z][a-z0-9-]{0,23}$/;

function checkHeader(h) {
  return !!h && typeof h === 'object' && !Array.isArray(h)
    && Number.isInteger(h.shellProtocol) && h.shellProtocol >= 1
    && typeof h.flavour === 'string' && SLUG_RE.test(h.flavour)
    && typeof h.version === 'string' && VERSION_RE.test(h.version);
}

// The exact bytes that are signed. Lengths are UTF-8 BYTE lengths of code and ui.
export function signingMessage(header, code, ui) {
  const c = Buffer.from(code, 'utf8');
  const u = Buffer.from(ui, 'utf8');
  const head = `grip-payload|${PAYLOAD_LAYOUT}|${header.shellProtocol}|${header.flavour}|${header.version}|${c.length}|${u.length}\n`;
  return Buffer.concat([Buffer.from(head, 'utf8'), c, u]);
}

export function buildEnvelope(header, code, ui) {
  if (!checkHeader(header)) throw new PayloadError('payload header needs shellProtocol (integer >= 1), flavour (slug) and version (x.y.z)');
  if (typeof code !== 'string' || code === '' || typeof ui !== 'string') throw new PayloadError('payload code must be a non-empty string and ui a string');
  return { layout: PAYLOAD_LAYOUT, header: { shellProtocol: header.shellProtocol, flavour: header.flavour, version: header.version }, code, ui, sig: '' };
}

function wellFormed(env) {
  return !!env && typeof env === 'object' && !Array.isArray(env) && env.layout === PAYLOAD_LAYOUT
    && checkHeader(env.header) && typeof env.code === 'string' && typeof env.ui === 'string' && typeof env.sig === 'string';
}

function sigBytes(b64) {
  if (!/^[A-Za-z0-9+/]{86}==$/.test(b64)) return null;      // 64 bytes, canonical base64
  return Buffer.from(b64, 'base64');
}

export function verifyEnvelope(env, keys, expect = {}) {
  if (!wellFormed(env)) return { ok: false, code: 'bad_format' };
  if (expect.flavour !== undefined && env.header.flavour !== expect.flavour) return { ok: false, code: 'bad_flavour' };
  const sig = sigBytes(env.sig);
  if (!sig) return { ok: false, code: 'bad_signature' };
  const msg = signingMessage(env.header, env.code, env.ui);
  return keys.some((k) => verify(null, msg, k, sig)) ? { ok: true } : { ok: false, code: 'bad_signature' };
}

export function signEnvelope(env, keyPem, pinnedKeys) {
  if (!wellFormed(env)) throw new PayloadError('envelope is not well formed');
  if (typeof keyPem !== 'string' || keyPem.trim() === '') throw new PayloadError(`${KEY_ENV} is not set`);
  let priv;
  try { priv = createPrivateKey(keyPem); } catch { throw new PayloadError(`${KEY_ENV} is not a usable private key (expected a PKCS8 PEM Ed25519 key)`); }
  if (priv.asymmetricKeyType !== 'ed25519') throw new PayloadError(`${KEY_ENV} is a ${priv.asymmetricKeyType} key, not Ed25519`);
  const signature = sign(null, signingMessage(env.header, env.code, env.ui), priv);
  const out = { ...env, sig: signature.toString('base64') };
  if (verifyEnvelope(out, pinnedKeys).ok !== true) {
    throw new PayloadError(`the payload signature made with ${KEY_ENV} does not verify against the releaseKeys pinned in flavour/flavour.json: the secret is the wrong key`);
  }
  return out;
}

function pinnedKeys(flavour) {
  return flavour.releaseKeys.map((pem) => {
    if (!isSinglePublicPem(pem)) throw new PayloadError('a pinned release key is not exactly one public key PEM block');
    return createPublicKey(pem);
  });
}

function readJson(path, what) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (e) { throw new PayloadError(`cannot read ${what} (${path}): ${e.message}`); }
}

// Builds (and signs when the key is available) the payload of the repo at `root`.
// Returns null when the flavour is not a loader.
export function buildPayloadFile({ root, out, keyPem }) {
  const f = readJson(join(root, 'flavour', 'flavour.json'), 'flavour/flavour.json');
  if (f.payloadLoader !== true) return null;
  const codePath = join(root, 'build', 'payload', 'code.js');
  if (!existsSync(codePath)) throw new PayloadError(`missing ${codePath}; run \`npm run build\` with the loader flavour first`);
  const code = readFileSync(codePath, 'utf8');
  const uiPath = join(root, 'src', 'plugin', 'shell', 'payload-ui.js');
  const ui = existsSync(uiPath) ? readFileSync(uiPath, 'utf8') : '';
  const meta = readJson(join(root, 'src', 'plugin', 'shell', 'payload-meta.json'), 'payload-meta.json');
  const version = checkLockstep(root);
  let env = buildEnvelope({ shellProtocol: meta.requiresShell, flavour: f.slug, version }, code, ui);
  if (typeof keyPem === 'string' && keyPem.trim() !== '') env = signEnvelope(env, keyPem, pinnedKeys(f));
  const dest = out ?? join(root, 'build', 'payload', 'payload.json');
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, JSON.stringify(env));
  return { dest, signed: env.sig !== '', version };
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root' || a === '--out') {
      if (argv[i + 1] === undefined) throw new PayloadError(`${a} needs a value`);
      o[a.slice(2)] = argv[++i];
    } else throw new PayloadError(`unknown argument ${a}`);
  }
  return o;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const o = parseArgs(process.argv.slice(2));
    const root = resolve(o.root ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
    const r = buildPayloadFile({ root, out: o.out ? resolve(o.out) : undefined, keyPem: process.env[KEY_ENV] });
    if (!r) console.log('payload: flavour is not a loader, skipped');
    else console.log(`payload: ${r.signed ? 'signed' : 'UNSIGNED (no key; dry run only)'} v${r.version} -> ${r.dest}`);
  } catch (e) {
    console.error('payload: ' + e.message);
    process.exit(1);
  }
}
