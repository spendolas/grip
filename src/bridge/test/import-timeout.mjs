import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Figma's import*ByKeyAsync never settles for an unresolvable key. Every call site must go
// through importByKey() so the agent gets a typed error instead of a 10s request_timeout.
const src = readFileSync(new URL('../../plugin/code.ts', import.meta.url), 'utf8');

const start = src.indexOf('const IMPORT_TIMEOUT_MS');
const end = src.indexOf('// ---------- gentle bulk-iteration helpers');
assert.ok(start > 0 && end > start, 'importByKey helper block found in plugin/code.ts');
const block = src.slice(start, end);

// Static: no by-key import call outside the helper's callback wrappers.
const calls = [...src.matchAll(/(import(?:Component|ComponentSet|Style|Variable)ByKeyAsync|extendLibraryCollectionByKeyAsync)\(/g)];
assert.ok(calls.length >= 6, `expected the by-key call sites, found ${calls.length}`);
for (const m of calls) {
  const lineStart = src.lastIndexOf('\n', m.index) + 1;
  const line = src.slice(lineStart, src.indexOf('\n', m.index));
  assert.ok(/importByKey(<[^>]*>)?\(/.test(line), `by-key call not wrapped in importByKey: ${line.trim()}`);
}

// Behavioral: run the real helper (timeout shortened) against a promise that never settles.
const js = ts.transpileModule(block.replace('= 6000', '= 40'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020 },
}).outputText;
const importByKey = new Function(`${js}; return importByKey;`)();

const t0 = Date.now();
await assert.rejects(
  importByKey('component', 'deadbeef', () => new Promise(() => {})),
  (e) => /^library_key_unresolved: component 'deadbeef'/.test(e.message) && /Assets → Libraries/.test(e.message),
);
assert.ok(Date.now() - t0 < 1000, 'hang surfaces as soon as the helper timeout fires');

assert.deepStrictEqual(await importByKey('component', 'k', async () => ({ id: '1' })), { id: '1' });
await assert.rejects(importByKey('style', 'k', async () => { throw new Error('boom'); }), /boom/);

console.log('import-timeout.mjs OK');
