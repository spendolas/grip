#!/usr/bin/env node
// Reads flavour/flavour.json (the identity, ports, paths and MCP name of this
// build) and emits (all gitignored):
//   src/bridge/src/flavour.gen.ts  an ES module (export const FLAVOUR)
//   src/plugin/flavour.gen.ts      the same values as a GLOBAL script (no import/
//                                  export): tsc concatenates it with code.ts into one
//                                  code.js (outFile), which Figma runs as a plain script
//   figma-plugin/ui.html, figma-plugin/manifest.json
//                                  rendered from src/plugin/templates/ (placeholders
//                                  __WS_PORT__ __FLAVOUR__ __PLUGIN_ID__ __PLUGIN_NAME__ __HOME_LABEL__;
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
// The same pattern as src/bridge/src/mcp-name.ts MCP_NAME_RE (the generator cannot import
// TypeScript; test/flavour.mjs checks the two agree).
const MCP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// True when `url` is the GitHub "latest release" API shape that the bridge's
// downloadPrefixFor (src/bridge/src/update-policy.ts) turns into a download pin; the
// two must agree (test/flavour.mjs checks). A locked flavour needs this shape, or its
// assets would download from anywhere without a word.
export function isGithubReleasesApi(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' || u.hostname !== 'api.github.com' || u.port !== '' || u.username || u.password || u.search || u.hash) return false;
  return /^\/repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/releases\/latest\/?$/.test(u.pathname);
}

// Exactly one public-key PEM block: nothing before or after it, no second block, no private key.
export function isSinglePublicPem(pem) {
  if (typeof pem !== 'string') return false;
  const t = pem.trim();
  return t.startsWith('-----BEGIN PUBLIC KEY-----') && t.endsWith('-----END PUBLIC KEY-----')
    && t.split('-----BEGIN ').length === 2 && t.split('-----END ').length === 2 && !t.includes('PRIVATE');
}
const SAFE_NAMES = ['filePrefix', 'homeDirName', 'ipcName', 'launchLabel', 'daemonBundleId'];
const FIELDS = ['slug', 'displayName', 'wsPort', 'httpPort', 'homeDirName', 'filePrefix', 'ipcName', 'mcpName', 'daemonAppName', 'daemonBundleId', 'launchLabel', 'pluginId', 'pluginName', 'releasesApi', 'installUrl', 'pagesUrl', 'releaseKeys', 'lockOverrides',
  // phase 2B: insecure-Grip guard (bridge only)
  'watchlist', 'enforcement'];

// ---- guard watchlist (phase 2B) ----
const WATCH_FIELDS = ['slug', 'wsPort', 'httpPort', 'homeDirName', 'statusFile', 'logFile', 'loginItem', 'launchLabel', 'mcpName', 'entryName', 'ipcName', 'serviceName', 'startupLauncher', 'minSecureVersion'];
const WATCH_NUMBERS = ['wsPort', 'httpPort'];
const WATCH_SAFE = ['homeDirName', 'statusFile', 'logFile', 'launchLabel', 'mcpName', 'entryName', 'ipcName', 'serviceName'];
const WATCH_SPACED = ['loginItem', 'startupLauncher'];

function validateWatchlist(raw) {
  if (raw.enforcement !== 'alert' && raw.enforcement !== 'off') throw new Error('flavour: field "enforcement" must be "alert" or "off"');
  if (!Array.isArray(raw.watchlist)) throw new Error('flavour: field "watchlist" must be an array');
  if (raw.enforcement === 'alert' && raw.watchlist.length < 1) throw new Error('flavour: field "watchlist" must not be empty when "enforcement" is "alert"');
  const seen = new Set();
  for (const e of raw.watchlist) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) throw new Error('flavour: field "watchlist" holds an entry that is not an object');
    for (const k of Object.keys(e)) if (!WATCH_FIELDS.includes(k)) throw new Error(`flavour: watchlist entry has unknown field "${k}"`);
    for (const k of WATCH_FIELDS) if (!(k in e)) throw new Error(`flavour: watchlist entry is missing field "${k}"`);
    if (typeof e.slug !== 'string' || !/^[a-z][a-z0-9-]{0,23}$/.test(e.slug)) throw new Error('flavour: watchlist field "slug" must match ^[a-z][a-z0-9-]{0,23}$');
    if (e.slug === raw.slug) throw new Error("flavour: watchlist field \"slug\" must differ from this flavour's own slug");
    if (seen.has(e.slug)) throw new Error(`flavour: watchlist field "slug" is listed twice (${e.slug})`);
    seen.add(e.slug);
    for (const k of WATCH_NUMBERS) {
      if (!Number.isInteger(e[k]) || e[k] < 1 || e[k] > 65535) throw new Error(`flavour: watchlist field "${k}" must be an integer port 1-65535`);
      if (e[k] === raw.wsPort || e[k] === raw.httpPort) throw new Error(`flavour: watchlist field "${k}" must differ from this flavour's own ports`);
    }
    if (e.wsPort === e.httpPort) throw new Error('flavour: watchlist field "httpPort" must differ from "wsPort"');
    for (const k of WATCH_SAFE) {
      if (typeof e[k] !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(e[k]) || /^\.+$/.test(e[k])) throw new Error(`flavour: watchlist field "${k}" may only contain letters, digits, ".", "-" and "_" (not only dots)`);
    }
    for (const k of WATCH_SPACED) {
      if (typeof e[k] !== 'string' || !/^[A-Za-z0-9._-](?:[A-Za-z0-9 ._-]{0,62}[A-Za-z0-9._-])?$/.test(e[k]) || /^\.+$/.test(e[k])) throw new Error(`flavour: watchlist field "${k}" may only contain letters, digits, spaces, ".", "-" and "_"`);
    }
    // every name a removal deletes must differ from THIS build's, ignoring case (macOS and Windows
    // file systems do): a foreign removal must never be able to name our own files
    const ownNames = {
      homeDirName: raw.homeDirName, loginItem: raw.daemonAppName, statusFile: `${raw.filePrefix}.status`, logFile: `${raw.filePrefix}.log`,
      ipcName: raw.ipcName, launchLabel: raw.launchLabel, serviceName: `${raw.slug}-bridge`, startupLauncher: `${raw.daemonAppName.replace(/\s+/g, '')}.vbs`,
    };
    for (const [k, mine] of Object.entries(ownNames)) {
      if (e[k].toLowerCase() === mine.toLowerCase()) throw new Error(`flavour: watchlist field "${k}" must differ from this flavour's own (${mine}), ignoring case`);
    }
    if (!MCP_NAME_RE.test(e.mcpName)) throw new Error('flavour: watchlist field "mcpName" is not a valid MCP name');
    if (typeof e.minSecureVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(e.minSecureVersion)) throw new Error('flavour: watchlist field "minSecureVersion" must look like 1.2.3');
  }
}

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
    // createPublicKey also accepts a private-key PEM (it derives the public half) and
    // objects (JWK, {key,format}), and reads past a second block, so insist on a string that
    // is exactly one public-key block.
    if (!isSinglePublicPem(pem)) throw new Error('flavour: field "releaseKeys" holds an entry that is not a public key PEM string (a private key must never go here)');
    let k;
    try { k = createPublicKey(pem); } catch { throw new Error('flavour: field "releaseKeys" holds an entry that is not a public key PEM'); }
    if (k.asymmetricKeyType !== 'ed25519') throw new Error('flavour: field "releaseKeys" holds a key that is not Ed25519');
  }
  if (!MCP_NAME_RE.test(raw.mcpName)) throw new Error('flavour: field "mcpName" may only contain letters, digits, ".", "-" and "_", starting with a letter or digit (max 64)');
  if (!/^\d{10,25}$/.test(raw.pluginId)) throw new Error('flavour: field "pluginId" must be 10 to 25 digits');
  if (raw.wsPort === raw.httpPort) throw new Error('flavour: field "httpPort" must differ from "wsPort"');
  if (!/^[a-z][a-z0-9-]{0,23}$/.test(raw.slug)) throw new Error('flavour: field "slug" must match ^[a-z][a-z0-9-]{0,23}$');
  if (raw.lockOverrides && !isGithubReleasesApi(raw.releasesApi)) {
    throw new Error('flavour: field "releasesApi" must be https://api.github.com/repos/<owner>/<repo>/releases/latest when "lockOverrides" is true (otherwise release downloads would not be pinned to that repo)');
  }
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
  validateWatchlist(raw);
  const out = {};
  for (const k of FIELDS) out[k] = raw[k];
  return out;
}

function q(s) {
  return "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

export function renderFlavour(f, fields = FIELDS) {
  const types = { string: 'string', number: 'number', boolean: 'boolean' };
  const typeOf = (v, k) => (k === 'watchlist' ? 'readonly WatchEntry[]' : k === 'enforcement' ? "'alert' | 'off'" : Array.isArray(v) ? 'readonly string[]' : types[typeof v]);
  // arrays go in as JSON (a PEM holds newlines, which a '...' literal cannot)
  const valOf = (v) => (Array.isArray(v) ? `Object.freeze(${JSON.stringify(v)})` : typeof v === 'string' ? q(v) : v);
  const iface = fields.map((k) => `  ${k}: ${typeOf(f[k], k)};`).join('\n');
  const watchIface = fields.includes('watchlist')
    ? `export interface WatchEntry {\n${WATCH_FIELDS.map((k) => `  ${k}: ${WATCH_NUMBERS.includes(k) ? 'number' : 'string'};`).join('\n')}\n}\n\n`
    : '';
  const vals = fields.map((k) => `  ${k}: ${valOf(f[k])},`).join('\n');
  return `// GENERATED by scripts/gen-flavour.mjs from flavour/flavour.json. DO NOT EDIT.
${watchIface}export interface Flavour {
${iface}
}

export const FLAVOUR: Flavour = Object.freeze({
${vals}
}) as Flavour;
`;
}

// Same values, but a global script: `const FLAVOUR` with no import/export, so a
// tsc outFile build (module: none) keeps code.js one plain script. The plugin never
// verifies a release, so its copy leaves the release keys out.
const PLUGIN_FIELDS = FIELDS.filter((k) => k !== 'releaseKeys' && k !== 'watchlist' && k !== 'enforcement');
export function renderFlavourGlobal(f) {
  return renderFlavour(f, PLUGIN_FIELDS)
    .replace('export interface Flavour', 'interface Flavour')
    .replace('export const FLAVOUR', 'const FLAVOUR');
}

const TEMPLATES = ['ui.html', 'manifest.json'];

// Fills the plugin templates. Values go in JSON-string-escaped (safe inside a JS
// '...' literal for the slug/port, and inside a JSON "..." string); the slug is
// already restricted to [a-z0-9-].
export function renderTemplate(name, text, f) {
  const esc = (v) => JSON.stringify(String(v)).slice(1, -1);
  const values = { WS_PORT: f.wsPort, FLAVOUR: f.slug, PLUGIN_ID: f.pluginId, PLUGIN_NAME: f.pluginName, HOME_LABEL: '~/' + f.homeDirName };
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
