#!/usr/bin/env node
// Hygiene gate for the built bundles. No dependencies.
//
//   node scripts/bundle-hygiene.mjs [file ...]
//
// With no arguments it checks the generated files a release ships:
//   bridge/grip-bridge.mjs  bridge/install.mjs  figma-plugin/code.js  bridge/THIRD-PARTY-NOTICES.txt
// Exit 1 (naming file, line and pattern) when any of them contains
//   - a developer path: /Users/<name>, /Volumes/, /home/<name>/, C:\Users\ (also
//     the escaped C:\\Users\\ form as it appears inside a JS string), or
//   - a secret-looking value: GitHub tokens (ghp_/gho_/ghu_/ghs_/ghr_/github_pat_),
//     AWS access key ids (AKIA...), PEM blocks (-----BEGIN ...), Anthropic and
//     OpenAI style keys (sk-ant-..., sk-...), npm tokens (npm_...), Slack tokens (xox?-).
// CI runs this after `npm run build` (release.yml); scripts/bundle-hygiene.test.mjs
// covers every pattern with fixture strings. Modelled on Gaffer's bundle-daemon.sh.
//
// ALLOWLIST holds exactly one entry: the PUBLIC key the bridge pins to verify
// release signatures (flavour/flavour.json releaseKeys). A public key
// is not a secret, but its PEM header trips the pem-block pattern. Private keys
// and every other PEM block are still flagged. If a bundled library ever ships harmless example text that
// trips a pattern, add the exact offending substring below with a comment saying
// where it comes from. Anything on an allowlisted line is skipped, so keep entries
// as specific as possible. Never widen a pattern's regex to make a hit go away.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ALLOWLIST = [
  // flavour/flavour.json releaseKeys: the pinned release-signing PUBLIC key (an SPKI block, not a secret).
  '-----BEGIN PUBLIC KEY-----',
];

export const PATTERNS = [
  // developer paths
  { id: 'path-users', re: /\/Users\/[A-Za-z0-9._-]+/ },
  { id: 'path-volumes', re: /\/Volumes\// },
  { id: 'path-home', re: /\/home\/[A-Za-z0-9._-]+\// },
  { id: 'path-windows-users', re: /[A-Za-z]:\\{1,2}Users\\/ },
  // secrets
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { id: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'pem-block', re: /-----BEGIN [A-Z0-9 ]+-----/ },
  { id: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{10,}/ },
  { id: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{32,}/ },
  { id: 'npm-token', re: /\bnpm_[A-Za-z0-9]{30,}/ },
  { id: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
];

// -> [{ id, line, text }] for every offending line of `text`.
export function findProblems(text, allowlist = ALLOWLIST) {
  const problems = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (allowlist.some((s) => line.includes(s))) continue;
    for (const { id, re } of PATTERNS) {
      const m = re.exec(line);
      if (m) {
        const at = Math.max(0, m.index - 20);
        problems.push({ id, line: i + 1, text: line.slice(at, at + 120) });
      }
    }
  }
  return problems;
}

export const DEFAULT_FILES = ['bridge/grip-bridge.mjs', 'bridge/install.mjs', 'figma-plugin/code.js', 'bridge/THIRD-PARTY-NOTICES.txt'];

export function checkFiles(files) {
  const report = [];
  for (const f of files) {
    let text;
    try { text = readFileSync(f, 'utf8'); }
    catch { report.push({ file: f, error: 'missing; run `npm run build` first' }); continue; }
    for (const p of findProblems(text)) report.push({ file: f, ...p });
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const args = process.argv.slice(2);
  const files = args.length ? args : DEFAULT_FILES.map((f) => join(root, f));
  const report = checkFiles(files);
  if (report.length) {
    console.error('bundle hygiene check FAILED:');
    for (const r of report) {
      console.error(r.error ? `  ${r.file}: ${r.error}` : `  ${r.file}:${r.line} [${r.id}] ...${r.text}...`);
    }
    process.exit(1);
  }
  console.log(`bundle hygiene: ${files.length} file(s) clean`);
}
