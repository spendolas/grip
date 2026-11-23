// Is a raw 32-byte Ed25519 public key usable as a trust anchor? A key that is non-canonical, not a
// curve point, or of small order (the identity, the order-2/4/8 points) lets a forged signature
// (R = identity, S = 0) verify for any message under lenient verifiers, so no flavour may pin one.
// Pure BigInt, no dependencies (gen-flavour.mjs has none). Returns null when the key is fine, else a reason.
const P = (1n << 255n) - 19n;
const D = (((P - 121665n) % P) * inv(121666n)) % P;
const SQRT_M1 = pow(2n, (P - 1n) / 4n);

function pow(b, e) { let r = 1n; b %= P; while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; } return r; }
function inv(a) { return pow(((a % P) + P) % P, P - 2n); }
function add([x1, y1], [x2, y2]) {      // twisted Edwards a = -1, affine (complete formulas)
  const t = (D * x1 * x2 * y1 * y2) % P;
  const x3 = ((x1 * y2 + x2 * y1) * inv(1n + t)) % P;
  const y3 = ((y1 * y2 + x1 * x2) * inv(1n - t)) % P;       // a = -1: y1y2 - a x1x2
  return [((x3 % P) + P) % P, ((y3 % P) + P) % P];
}

export function ed25519KeyProblem(raw) {
  if (!(raw instanceof Uint8Array) || raw.length !== 32) return 'not 32 bytes';
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? raw[i] & 0x7f : raw[i]);
  const sign = (raw[31] & 0x80) !== 0;
  if (y >= P) return 'non-canonical encoding';
  const y2 = (y * y) % P;
  const x2 = (((y2 - 1n + P) % P) * inv(D * y2 + 1n)) % P;
  let x = pow(x2, (P + 3n) / 8n);
  if ((x * x) % P !== x2) x = (x * SQRT_M1) % P;
  if ((x * x) % P !== x2) return 'not a curve point';
  if (x === 0n && sign) return 'non-canonical encoding';
  if ((x & 1n) === 1n !== sign) x = (P - x) % P;
  let pt = [x, y];
  for (let i = 0; i < 3; i++) pt = add(pt, pt);                // times 8: clears the cofactor
  if (pt[0] === 0n && pt[1] === 1n) return 'small-order point';
  return null;
}
