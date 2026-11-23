// Entry of the verifier bundle (scripts: src/plugin/shell/assemble.mjs bundleVerifier()).
// The iframe is not a secure context (no crypto.subtle), so Ed25519 is pure JS:
// @noble/ed25519 2.1.0 with the SHA-512 of @noble/hashes 1.5.0 (both MIT).
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

// (signature: Uint8Array(64), message: Uint8Array, publicKey: Uint8Array(32)) -> boolean
// zip215:false = RFC 8032 strict verification: it also refuses a small-order public key.
globalThis.gripEdVerify = (sig, msg, pub) => {
  try { return ed.verify(sig, msg, pub, { zip215: false }) === true; } catch (e) { return false; }
};
