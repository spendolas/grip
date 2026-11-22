#!/usr/bin/env node
// Reads flavour/flavour.json (the identity, ports, paths and MCP name of this
// build) and emits (all gitignored):
//   src/bridge/src/flavour.gen.ts  an ES module (export const FLAVOUR)
//   src/plugin/flavour.gen.ts      the same values as a GLOBAL script (no import/
//                                  export): tsc concatenates it with code.ts into one
//                                  code.js (outFile), which Figma runs as a plain script
//   figma-plugin/ui.html, figma-plugin/manifest.json
//                                  rendered from src/plugin/templates/ (placeholders
//                                  __WS_PORT__ __FLAVOUR__ __PLUGIN_ID__ __PLUGIN_NAME__;
//                                  any __X__ left after rendering is an error)
//
//   node scripts/gen-flavour.mjs [--dir <path>] [--out-bridge <file>] [--out-plugin <file>]
//                                [--out-plugin-dir <dir>]
//
// Default dir: env GRIP_FLAVOUR_DIR, else <repo>/flavour. No dependencies.
import { createPublicKey } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const STRINGS = [
  'slug', 'displayName', 'homeDirName', 'filePrefix', 'ipcName', 'mcpName',
  'daemonAppName', 'daemonBundleId', 'launchLabel', 'pluginId', 'pluginName',
  'releasesApi', 'installUrl', 'pagesUrl',
];
const PORTS = ['wsPort', 'httpPort'];
const BOOLS = ['lockOverrides'];
const SAFE_NAMES = ['filePrefix', 'homeDirName', 'ipcName', 'launchLabel', 'daemonBundleId'];
const FIELDS = ['slug', 'displayName', 'wsPort', 'httpPort', 'homeDirName', 'filePrefix', 'ipcName', 'mcpName', 'daemonAppName', 'daemonBundleId', 'launchLabel', 'pluginId', 'pluginName', 'releasesApi', 'installUrl', 'pagesUrl', 'releaseKeys', 'lockOverrides'];

export function loadFlavour(dir) {
  const file = join(dir, 'flavour.json');
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`flavour: cannot read ${file}: ${e.message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`flavour: ${file} must be a JSON object`);
  for (const k of Object.keys(raw)) {
    if (!FIELDS.includes(k)) throw new Error(`flavour: unknown field "${k}"`);
  }
  for (const k of FIELDS) {
    if (!(k in raw)) throw new Error(`flavour: missing field "${k}"`);
  }
  for (const k of STRINGS) {
    if (typeof raw[k] !== 'string' || raw[k] === '') throw new Error(`flavour: field "${k}" must be a non-empty string`);
  }
  for (const k of PORTS) {
    const v = raw[k];
    if (!Number.isInteger(v) || v < 1 || v > 65535) throw new Error(`flavour: field "${k}" must be an integer port 1-65535`);
  }
  for (const k of BOOLS) {
    if (typeof raw[k] !== 'boolean') throw new Error(`flavour: field "${k}" must be a boolean`);
  }
  // The Ed25519 public keys (SPKI PEM) that sign this flavour's releases. A list so a key
  // can be rotated (trust old and new for one release). Public keys only: never a private key.
  if (!Array.isArray(raw.releaseKeys) || raw.releaseKeys.length < 1) throw new Error('flavour: field "releaseKeys" must be a non-empty array of Ed25519 public key PEM strings');
  for (const pem of raw.releaseKeys) {
    let k;
    try { k = createPublicKey(pem); } catch { throw new Error('flavour: field "releaseKeys" holds an entry that is not a public key PEM'); }
    if (k.asymmetricKeyType !== 'ed25519') throw new Error('flavour: field "releaseKeys" holds a key that is not Ed25519');
  }
  if (raw.wsPort === raw.httpPort) throw new Error('flavour: field "httpPort" must differ from "wsPort"');
  if (!/^[a-z][a-z0-9-]{0,23}$/.test(raw.slug)) throw new Error('flavour: field "slug" must match ^[a-z][a-z0-9-]{0,23}$');
  // These reach AppleScript, plist XML, shell scripts and file paths unescaped, so they
  // are held to characters that are inert in all of them.
  for (const k of SAFE_NAMES) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(raw[k]) || /^\.+$/.test(raw[k])) {
      throw new Error(`flavour: field "${k}" may only contain letters, digits, ".", "-" and "_" (not only dots)`);
    }
  }
  if (!/^[A-Za-z0-9._-](?:[A-Za-z0-9 ._-]{0,62}[A-Za-z0-9._-])?$/.test(raw.daemonAppName) || /^\.+$/.test(raw.daemonAppName)) {
    throw new Error('flavour: field "daemonAppName" may only contain letters, digits, spaces, ".", "-" and "_" (no leading or trailing space, not only dots)');
  }
  const out = {};
  for (const k of FIELDS) out[k] = raw[k];
  return out;
}

function q(s) {
  return "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

export function renderFlavour(f) {
  const types = { string: 'string', number: 'number', boolean: 'boolean' };
  const typeOf = (v) => (Array.isArray(v) ? 'readonly string[]' : types[typeof v]);
  // string arrays go in as JSON (a PEM holds newlines, which a '...' literal cannot)
  const valOf = (v) => (Array.isArray(v) ? `Object.freeze(${JSON.stringify(v)})` : typeof v === 'string' ? q(v) : v);
  const iface = FIELDS.map((k) => `  ${k}: ${typeOf(f[k])};`).join('\n');
  const vals = FIELDS.map((k) => `  ${k}: ${valOf(f[k])},`).join('\n');
  return `// GENERATED by scripts/gen-flavour.mjs from flavour/flavour.json. DO NOT EDIT.
export interface Flavour {
${iface}
}

export const FLAVOUR: Flavour = Object.freeze({
${vals}
}) as Flavour;
`;
}

// Same values, but a global script: `const FLAVOUR` with no import/export, so a
// tsc outFile build (module: none) keeps code.js one plain script.
export function renderFlavourGlobal(f) {
  return renderFlavour(f)
    .replace('export interface Flavour', 'interface Flavour')
    .replace('export const FLAVOUR', 'const FLAVOUR');
}

const TEMPLATES = ['ui.html', 'manifest.json'];

// Fills the plugin templates. Values go in JSON-string-escaped (safe inside a JS
// '...' literal for the slug/port, and inside a JSON "..." string); the slug is
// already restricted to [a-z0-9-].
export function renderTemplate(name, text, f) {
  const esc = (v) => JSON.stringify(String(v)).slice(1, -1);
  const values = { WS_PORT: f.wsPort, FLAVOUR: f.slug, PLUGIN_ID: f.pluginId, PLUGIN_NAME: f.pluginName };
  const out = text.replace(/__([A-Z][A-Z0-9_]*)__/g, (m, k) => (k in values ? esc(values[k]) : m));
  const left = out.match(/__[A-Z][A-Z0-9_]*__/g);
  if (left) throw new Error(`gen-flavour: placeholder ${[...new Set(left)].join(', ')} left in ${name}`);
  return out;
}

function main(argv) {
  const opt = { dir: process.env.GRIP_FLAVOUR_DIR ? resolve(process.env.GRIP_FLAVOUR_DIR) : join(root, 'flavour'),
    outBridge: join(root, 'src', 'bridge', 'src', 'flavour.gen.ts'),
    outPlugin: join(root, 'src', 'plugin', 'flavour.gen.ts'),
    outPluginDir: join(root, 'figma-plugin') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--dir') { opt.dir = resolve(v); i++; }
    else if (a === '--out-bridge') { opt.outBridge = resolve(v); i++; }
    else if (a === '--out-plugin') { opt.outPlugin = resolve(v); i++; }
    else if (a === '--out-plugin-dir') { opt.outPluginDir = resolve(v); i++; }
    else throw new Error(`gen-flavour: unknown argument ${a}`);
  }
  const f = loadFlavour(opt.dir);
  const outputs = [[opt.outBridge, renderFlavour(f)], [opt.outPlugin, renderFlavourGlobal(f)]];
  for (const name of TEMPLATES) {
    const tpl = readFileSync(join(root, 'src', 'plugin', 'templates', name), 'utf8');
    outputs.push([join(opt.outPluginDir, name), renderTemplate(name, tpl, f)]);
  }
  // Render everything first, write after: a bad template never leaves half an output.
  for (const [o, text] of outputs) {
    mkdirSync(dirname(o), { recursive: true });
    writeFileSync(o, text);
  }
  for (const [o] of outputs) {
    if (!existsSync(o)) throw new Error(`gen-flavour: expected output missing after generation: ${o}`);
  }
}

const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
}
