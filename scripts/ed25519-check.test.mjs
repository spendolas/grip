import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { ed25519KeyProblem } from './ed25519-check.mjs';

const hex = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const le = (v) => { const b = Buffer.alloc(32); let x = v; for (let i = 0; i < 32; i++) { b[i] = Number(x & 0xffn); x >>= 8n; } return Uint8Array.from(b); };
const P = (1n << 255n) - 19n;

test('small-order and non-canonical keys are refused', () => {
  assert.match(ed25519KeyProblem(hex('01' + '00'.repeat(31))), /small-order/, 'the identity point');
  assert.match(ed25519KeyProblem(le(P - 1n)), /small-order/, 'order 2');
  assert.match(ed25519KeyProblem(le(0n)), /small-order/, 'order 4 (y = 0)');
  assert.match(ed25519KeyProblem(le(P + 1n)), /non-canonical/, 'identity encoded with y = p + 1');
  assert.match(ed25519KeyProblem(Uint8Array.from(Buffer.concat([Buffer.from('01', 'hex'), Buffer.alloc(30), Buffer.from('80', 'hex')]))), /non-canonical|small-order/, 'identity with the sign bit');
  assert.ok(ed25519KeyProblem(new Uint8Array(31)));
  assert.ok(ed25519KeyProblem(le(2n)), 'y = 2 is not on the curve');
});

test('real keys pass', () => {
  for (let i = 0; i < 40; i++) {
    const der = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' });
    assert.equal(ed25519KeyProblem(Uint8Array.from(der.subarray(-32))), null);
  }
});
