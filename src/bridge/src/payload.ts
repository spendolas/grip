// The signed plugin payload a `payloadLoader` flavour's shell plugin runs (phase 3).
//
// scripts/payload.mjs builds payload.json in CI and signs it with the flavour's release key;
// the release carries it as the asset grip-plugin-payload.json and the updater/installer put
// it at <home>/figma-plugin/payload.json. After the pairing handshake the shell says which
// version it has (`payload_have`) and the bridge answers with the envelope when it is newer.
//
// This module only READS and SHAPE-CHECKS the file. It never verifies the signature: the shell
// does that against the public key pinned in its own build (a bridge that served an unverified
// payload would still be refused), and the updater already checked the download against the
// signed SHA256SUMS.txt. stdout is never used.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { FLAVOUR } from './flavour.gen.js';
import { compareSemver, gripHome } from './update.js';

export interface PayloadEnvelope {
  layout: 1;
  header: { shellProtocol: number; flavour: string; version: string };
  code: string;
  ui: string;
  sig: string;
}

export const PAYLOAD_FILE = 'payload.json';
const MAX_BYTES = 8 * 1024 * 1024;
const PLAIN_VERSION = /^\d+\.\d+\.\d+$/;

let memo: { path: string; mtimeMs: number; size: number; value: { envelope: PayloadEnvelope; version: string } | null } | null = null;
const said = new Set<string>();
function complain(problem: string): void {
  if (said.has(problem)) return;
  said.add(problem);
  process.stderr.write(`[grip] payload: not serving ${PAYLOAD_FILE}: ${problem}\n`);
}

function shapeProblem(e: any): string | null {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return 'not a JSON object';
  if (e.layout !== 1) return 'unknown layout';
  const h = e.header;
  if (!h || typeof h !== 'object' || !Number.isInteger(h.shellProtocol) || h.shellProtocol < 1 || typeof h.flavour !== 'string' || typeof h.version !== 'string') return 'bad header';
  if (typeof e.code !== 'string' || e.code === '' || typeof e.ui !== 'string' || typeof e.sig !== 'string') return 'bad fields';
  if (h.flavour !== FLAVOUR.slug) return 'it is for another flavour';
  if (!PLAIN_VERSION.test(h.version)) return 'version is not x.y.z';
  if (e.sig === '') return 'it is not signed';
  return null;
}

// The envelope on disk, or null (no file or not usable; the reason is logged once).
export function readPayload(dir: string = join(gripHome(), 'figma-plugin')): { envelope: PayloadEnvelope; version: string } | null {
  const path = join(dir, PAYLOAD_FILE);
  let st;
  try { st = statSync(path); } catch { memo = null; return null; }
  if (memo && memo.path === path && memo.mtimeMs === st.mtimeMs && memo.size === st.size) return memo.value;
  let value: { envelope: PayloadEnvelope; version: string } | null = null;
  if (!st.isFile() || st.size > MAX_BYTES) complain('not a regular file under 8MB');
  else {
    try {
      const e = JSON.parse(readFileSync(path, 'utf8'));
      const bad = shapeProblem(e);
      if (bad) complain(bad); else value = { envelope: e as PayloadEnvelope, version: e.header.version };
    } catch { complain('unreadable or not JSON'); }
  }
  memo = { path, mtimeMs: st.mtimeMs, size: st.size, value };
  return value;
}

// The answer to a shell's `payload_have`: the envelope when it is newer than `have.version`,
// `payload_current` when the shell is up to date, `payload_unavailable` when there is nothing to serve.
export function payloadReply(have: { version: string | null }, dir?: string): Record<string, unknown> {
  const p = readPayload(dir);
  if (!p) return { type: 'payload_unavailable' };
  const v = have.version;
  if (typeof v === 'string' && PLAIN_VERSION.test(v) && compareSemver(p.version, v) <= 0) return { type: 'payload_current' };
  return { type: 'payload', envelope: p.envelope };
}
