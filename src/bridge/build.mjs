// Bundle the bridge into single self-contained files.
//
// Output goes to <repo>/bridge/ as grip-bridge.mjs (the daemon/shim) and
// install.mjs (the installer). Each is standalone: no node_modules, no npm.
// That is the whole point — a user drops the folder anywhere and runs it.
//
// Two details that are load-bearing:
//
// 1. `.mjs`, not `.js`. A bare .js file with no package.json beside it is
//    treated as CommonJS by Node, and an ESM bundle then fails to parse. The
//    .mjs extension makes it unambiguous wherever the file is copied.
//
// 2. The `require` shim. Some dependencies (ws) call CommonJS require()
//    internally. In ESM output esbuild replaces those with a stub that throws
//    "Dynamic require of X is not supported". Defining a real require via
//    createRequire satisfies esbuild's own __require check, which prefers an
//    existing `require` when one is in scope.
//
// The shebang must be the very first line, so it lives in the banner and is
// NOT present in the source files (two shebangs is a syntax error).

import { build } from 'esbuild';

const banner = [
  '#!/usr/bin/env node',
  'import { createRequire as __createRequire } from "module";',
  'const require = __createRequire(import.meta.url);',
].join('\n');

const targets = [
  { in: 'src/index.ts', out: '../../bridge/grip-bridge.mjs' },
  { in: 'src/install.ts', out: '../../bridge/install.mjs' },
];

for (const t of targets) {
  const result = await build({
    entryPoints: [t.in],
    outfile: t.out,
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'esm',
    banner: { js: banner },
    logLevel: 'warning',
  });
  if (result.errors?.length) process.exit(1);
  process.stdout.write(`  bundled ${t.in} -> ${t.out}\n`);
}
