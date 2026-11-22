// The release-signing public key(s) are pinned by the flavour file: the public build
// pins exactly the public key, and a build of another flavour carries its own keys and
// none of the public one.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicKey } from 'node:crypto';
import { flavourBundler } from './_bundle.mjs';
import { RELEASE_PUBLIC_KEYS } from '../dist/update.js';
import { FLAVOUR } from '../dist/flavour.gen.js';

const here = dirname(fileURLToPath(import.meta.url));
const altDir = join(here, 'fixtures', 'flavour-alt');
const alt = JSON.parse(readFileSync(join(altDir, 'flavour.json'), 'utf8'));
const PUBLIC_BODY = 'MCowBQYDK2VwAyEASF7Su4ZqXdmFbDJvwm56w5wBAqqhQ8BcLDwJlGjTneo=';
const body = (pem) => pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');

// public build: exactly one pinned key, the public one, and update.ts uses the flavour's list
assert.equal(RELEASE_PUBLIC_KEYS.length, 1, 'one pinned key');
assert.equal(body(RELEASE_PUBLIC_KEYS[0]), PUBLIC_BODY);
assert.deepEqual([...RELEASE_PUBLIC_KEYS], [...FLAVOUR.releaseKeys], 'update.ts pins FLAVOUR.releaseKeys');
assert.equal(createPublicKey(RELEASE_PUBLIC_KEYS[0]).asymmetricKeyType, 'ed25519');

// acme build: its own key, never the public one
const tmp = mkdtempSync(join(tmpdir(), 'release-keys-'));
const { bundle } = flavourBundler(altDir, tmp);
const text = await bundle('src/update.ts');
assert.ok(!text.includes(PUBLIC_BODY), 'an acme build does not carry the public release key');
assert.equal(alt.releaseKeys.length, 1);
assert.ok(text.includes(body(alt.releaseKeys[0])), 'an acme build pins its own release key');
rmSync(tmp, { recursive: true, force: true });
console.log('release-keys.mjs OK');
