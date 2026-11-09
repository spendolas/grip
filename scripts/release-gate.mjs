#!/usr/bin/env node
// Release gate for .github/workflows/release.yml. Decides whether the version in
// src/bridge/src/types.ts (BRIDGE_VERSION) should be released (create), finished
// (recover) or left alone (skip), and extracts the CHANGELOG.md section that
// becomes the release notes. Pure logic is exported for
// scripts/release-gate.test.mjs; the CLI at the bottom is what the workflow runs.
//
// Modelled on Gaffer's gate (spendolas/gaffer-ae). Differences: Grip's changelog
// headings are `## 0.8.0` (exact version, no "v"), a release has 9 assets, and the
// notes written for the release get an install footer (withInstallFooter).
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Every file a release must carry. The in-place updater downloads six of them
// by exact name (see src/bridge/src/update.ts: ASSET_BRIDGE, PLUGIN_ASSETS,
// ASSET_SUMS, ASSET_COMPAT); grip-install.zip and install.mjs are for fresh installs;
// THIRD-PARTY-NOTICES.txt is for people (and legal), the updater never fetches it.
export const REQUIRED_ASSETS = [
  'grip-bridge.mjs',
  'install.mjs',
  'grip-plugin-code.js',
  'grip-plugin-ui.html',
  'grip-plugin-manifest.json',
  'grip-install.zip',
  'compat.json',
  'THIRD-PARTY-NOTICES.txt',
  'SHA256SUMS.txt',
];

// Everything from this line on in a release body is for people reading the
// GitHub release page. The updater cuts it (src/bridge/src/update.ts:
// INSTALL_MARKER) so update notices never carry it.
export const INSTALL_MARKER = '<!-- grip-install -->';

export function installFooter(version) {
  return '**Install:** [open the install page](https://spendolas.github.io/grip/) to start it in Claude with one click, '
    + 'or tell your agent `Install Grip from https://github.com/spendolas/grip/releases/latest`. '
    + `The steps are in the [README for this release](https://github.com/spendolas/grip/blob/v${version}/README.md#install-instructions-for-agents), `
    + 'so the instructions always match the files attached to this release.';
}

// The release body: the CHANGELOG notes, then the marker line, then the footer.
export function withInstallFooter(notes, version) {
  return notes.replace(/\s+$/, '') + '\n\n' + INSTALL_MARKER + '\n' + installFooter(version) + '\n';
}

export class GateError extends Error {}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?$/;

// "0.11.0-beta.1" -> { nums: [0, 11, 0], pre: "beta.1" }; anything else -> null.
export function parseVersion(v) {
  const m = VERSION_RE.exec(String(v));
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || null };
}

// `sort -V` style: digit runs compare as numbers, everything else as text.
function comparePre(a, b) {
  const ca = a.match(/\d+|\D+/g);
  const cb = b.match(/\d+|\D+/g);
  for (let i = 0; i < Math.min(ca.length, cb.length); i++) {
    const x = ca[i];
    const y = cb[i];
    const bothNum = /^\d/.test(x) && /^\d/.test(y);
    if (bothNum) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return ca.length === cb.length ? 0 : (ca.length < cb.length ? -1 : 1);
}

// -1, 0 or 1. Numeric major.minor.patch first; on a tie a final release is
// greater than any prerelease of it.
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new GateError(`cannot compare "${a}" and "${b}"`);
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return comparePre(pa.pre, pb.pre);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Body of the "## <version>" section: the lines after the heading up to, not
// including, the next line starting with "## ". Leading and trailing blank
// lines are dropped. null when the heading is missing. The heading is the exact
// version, optionally followed by a space and anything (e.g. a date); "## v0.8.0"
// does not match.
export function extractNotes(changelog, version) {
  const lines = String(changelog).split(/\r?\n/);
  const heading = new RegExp('^## ' + escapeRegExp(version) + '( |$)');
  const start = lines.findIndex((l) => heading.test(l));
  if (start === -1) return null;
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) break;
    body.push(lines[i]);
  }
  while (body.length && body[0].trim() === '') body.shift();
  while (body.length && body[body.length - 1].trim() === '') body.pop();
  return body.join('\n') + '\n';
}

// A release is complete when it is published (not a draft) and carries every asset.
export function isCompleteRelease(release) {
  if (!release || release.isDraft) return false;
  const names = (release.assets || []).map((a) => a.name);
  return REQUIRED_ASSETS.every((n) => names.includes(n));
}

// version: string from BRIDGE_VERSION. tags: array of tag names.
// release: { isDraft, assets: [{ name }] } from `gh release view`, or null.
// changelog: CHANGELOG.md text. Returns { action, notes }; throws GateError.
//   skip    already released with every asset: do nothing
//   recover the release exists (draft, or published but missing assets): finish it
//   create  no release yet: tag + publish
// Notes are required for create/recover: a release without notes must not publish.
export function decide({ version, tags, release, changelog }) {
  if (!parseVersion(version)) {
    throw new GateError(`BRIDGE_VERSION "${version}" is not major.minor.patch[-prerelease]`);
  }
  if (isCompleteRelease(release)) return { action: 'skip', notes: null };
  let action = 'recover';
  if (!release) {
    for (const tag of tags) {
      if (!tag.startsWith('v')) continue;
      const tagVersion = tag.slice(1);
      if (tagVersion === version || !parseVersion(tagVersion)) continue;
      if (compareVersions(version, tagVersion) <= 0) {
        throw new GateError(`version ${version} is not greater than existing tag ${tag}`);
      }
    }
    action = 'create';
  }
  const notes = extractNotes(changelog, version);
  if (notes === null) throw new GateError(`CHANGELOG.md has no "## ${version}" heading`);
  // An empty section would publish a release with blank notes.
  if (notes.trim() === '') throw new GateError(`CHANGELOG.md has a heading for ${version} but no notes under it`);
  return { action, notes };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) {
      throw new GateError(`bad argument "${argv[i]}"`);
    }
    out[argv[i].slice(2)] = argv[i + 1];
  }
  for (const k of ['version', 'tags-file', 'release-file', 'changelog', 'notes-out']) {
    if (!out[k]) throw new GateError(`missing --${k}`);
  }
  return out;
}

export function main(argv, env) {
  const args = parseArgs(argv);
  const tags = readFileSync(args['tags-file'], 'utf8').split(/\r?\n/).map((t) => t.trim()).filter(Boolean);
  const releaseText = readFileSync(args['release-file'], 'utf8').trim();
  const release = releaseText === '' ? null : JSON.parse(releaseText);
  const changelog = readFileSync(args.changelog, 'utf8');
  const { action, notes } = decide({ version: args.version, tags, release, changelog });
  if (notes !== null) writeFileSync(args['notes-out'], withInstallFooter(notes, args.version));
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `action=${action}\n`);
  console.log(`release-gate: v${args.version} -> ${action}`);
  return action;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2), process.env);
  } catch (e) {
    console.error('release-gate: ' + e.message);
    process.exit(1);
  }
}
