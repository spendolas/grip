#!/usr/bin/env node
// Signs the release checksum list: writes SHA256SUMS.txt.sig next to SHA256SUMS.txt.
//
//   GRIP_RELEASE_SIGNING_KEY="$(cat key.pem)" node scripts/sign-release.mjs [--dir dist] [--root <repo>]
//
// The signature is a raw 64-byte Ed25519 signature over the exact bytes of
// SHA256SUMS.txt, base64 encoded (one line). The bridge (src/bridge/src/update.ts)
// trusts a release's SHA256SUMS.txt, and through it every file and compat.json,
// only when this signature verifies against a public key pinned in the bridge
// (RELEASE_PUBLIC_KEYS), so a compromised repository or release alone cannot make
// anyone install different code.
//
// The private key is a PKCS8 PEM Ed25519 key. In CI it is the repository secret
// GRIP_RELEASE_SIGNING_KEY (see .github/workflows/release.yml); it is never
// written to disk by this script and never logged. Fails loudly when the key is
// missing or not an Ed25519 private key. Before writing anything it checks the
// fresh signature against the pinned public key(s), read from
// src/bridge/src/update.ts, so a wrong secret (a different key than the one the
// shipped bridges trust) fails here instead of producing a release no bridge
// would accept. No dependencies; node:crypto only.
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export class SignError extends Error {}

export const SUMS_NAME = 'SHA256SUMS.txt';
export const SIG_NAME = 'SHA256SUMS.txt.sig';
export const KEY_ENV = 'GRIP_RELEASE_SIGNING_KEY';

// The pinned public key(s): every SPKI PEM block inside the RELEASE_PUBLIC_KEYS
// array in src/bridge/src/update.ts (the single source of truth, no second copy).
export function readPinnedKeys(root) {
  const file = join(root, 'src', 'bridge', 'src', 'update.ts');
  let text;
  try { text = readFileSync(file, 'utf8'); }
  catch { throw new SignError(`cannot read ${file} to find the pinned release public key(s)`); }
  const m = /export const RELEASE_PUBLIC_KEYS\b[^=]*=\s*\[([\s\S]*?)\n\];/.exec(text);
  if (!m) throw new SignError('could not find RELEASE_PUBLIC_KEYS in src/bridge/src/update.ts');
  const pems = m[1].match(/-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/g) ?? [];
  if (pems.length === 0) throw new SignError('RELEASE_PUBLIC_KEYS in src/bridge/src/update.ts holds no public key');
  return pems.map((pem) => {
    let k;
    try { k = createPublicKey(pem); } catch { throw new SignError('a pinned release public key in src/bridge/src/update.ts is not a valid public key'); }
    if (k.asymmetricKeyType !== 'ed25519') throw new SignError('a pinned release public key is not an Ed25519 key');
    return k;
  });
}

// keyPem: PKCS8 PEM text. Returns the signature text that was written.
export function signSums({ root, dir, keyPem }) {
  if (typeof keyPem !== 'string' || keyPem.trim() === '') {
    throw new SignError(`${KEY_ENV} is not set: a release must be signed (set the repository secret to the PKCS8 PEM Ed25519 private key)`);
  }
  let priv;
  try { priv = createPrivateKey(keyPem); }
  catch { throw new SignError(`${KEY_ENV} is not a usable private key (expected a PKCS8 PEM Ed25519 key)`); }
  if (priv.asymmetricKeyType !== 'ed25519') {
    throw new SignError(`${KEY_ENV} is a ${priv.asymmetricKeyType} key, not Ed25519`);
  }
  const sumsPath = join(dir, SUMS_NAME);
  let sums;
  try { sums = readFileSync(sumsPath); }
  catch { throw new SignError(`cannot read ${sumsPath}; package the release first`); }
  if (sums.length === 0) throw new SignError(`${sumsPath} is empty`);

  const signature = sign(null, sums, priv);
  if (signature.length !== 64) throw new SignError(`unexpected signature length ${signature.length}`);

  // Self-verify against what shipped bridges trust. A mismatch means the secret is
  // not the key whose public half is pinned in the bridge.
  const pinned = readPinnedKeys(root);
  if (!pinned.some((k) => verify(null, sums, k, signature))) {
    throw new SignError(`the signature made with ${KEY_ENV} does not verify against the public key(s) pinned in src/bridge/src/update.ts: the secret is the wrong key`);
  }
  const text = signature.toString('base64') + '\n';
  writeFileSync(join(dir, SIG_NAME), text);
  return text;
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir' || a === '--root') {
      if (argv[i + 1] === undefined) throw new SignError(`${a} needs a value`);
      o[a.slice(2)] = argv[++i];
    } else throw new SignError(`unknown argument ${a}`);
  }
  return o;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const o = parseArgs(process.argv.slice(2));
    const root = resolve(o.root ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
    const dir = resolve(o.dir ?? join(root, 'dist'));
    signSums({ root, dir, keyPem: process.env[KEY_ENV] });
    console.log(`sign-release: signed ${join(dir, SUMS_NAME)} -> ${SIG_NAME} (verified against the pinned release key)`);
  } catch (e) {
    console.error('sign-release: ' + e.message);
    process.exit(1);
  }
}
