import assert from 'node:assert';
import { TOOLS, TOOL_CATEGORIES } from '../dist/tools.js';

// Shared registration test for the four new tools in the server-side-
// optimization sprint (get_audit, list_pages, create_tree, replace_text).
// Each task lands its own tool + un-skips its assertion here; get_audit
// and list_pages exist as of Task 3.
const names = new Set(TOOLS.map((t) => t.name));
const catNames = new Set(Object.values(TOOL_CATEGORIES).flat());

for (const n of [
  'get_audit',
  'list_pages',
  'create_tree',
  'replace_text',
]) {
  assert.ok(names.has(n), `${n} registered in TOOLS`);
  assert.ok(catNames.has(n), `${n} categorised`);
}

const audit = TOOLS.find((t) => t.name === 'get_audit');
assert.ok(audit, 'get_audit tool def exists');
assert.ok(audit.schema.safeParse({ allPages: true, maxNodes: 1000 }).success, 'get_audit schema');

const listPages = TOOLS.find((t) => t.name === 'list_pages');
assert.ok(listPages, 'list_pages tool def exists');
assert.ok(listPages.schema.safeParse({}).success, 'list_pages schema');

const createTree = TOOLS.find((t) => t.name === 'create_tree');
assert.ok(createTree, 'create_tree tool def exists');
assert.ok(createTree.schema.safeParse({ spec: { type: 'FRAME' } }).success, 'create_tree schema');

// Task 5: map_nodes extended with rename/swap/applyStyle ops (no new tool —
// TOOLS.length stays 149).
const mn = TOOLS.find((t) => t.name === 'map_nodes');
assert.ok(mn, 'map_nodes tool def exists');
assert.ok(
  mn.schema.safeParse({ query: { types: ['TEXT'] }, rename: { find: 'a', replace: 'b' } }).success,
  'map_nodes rename accepted',
);
assert.deepStrictEqual(
  mn.schema.safeParse({ query: { types: ['TEXT'] }, rename: { find: 'a', replace: 'b' } }).data.rename,
  { find: 'a', replace: 'b' },
  'map_nodes rename preserved',
);
assert.ok(
  mn.schema.safeParse({ query: { types: ['INSTANCE'] }, swap: { componentKey: 'k' } }).success,
  'map_nodes swap accepted',
);
assert.deepStrictEqual(
  mn.schema.safeParse({ query: { types: ['INSTANCE'] }, swap: { componentKey: 'k' } }).data.swap,
  { componentKey: 'k' },
  'map_nodes swap preserved',
);
assert.ok(
  mn.schema.safeParse({ query: { types: ['FRAME'] }, applyStyle: { styleId: 's1', type: 'fill' } }).success,
  'map_nodes applyStyle accepted',
);
assert.deepStrictEqual(
  mn.schema.safeParse({ query: { types: ['FRAME'] }, applyStyle: { styleId: 's1', type: 'fill' } }).data.applyStyle,
  { styleId: 's1', type: 'fill' },
  'map_nodes applyStyle preserved',
);

// Task 6: replace_text bulk find/replace.
const replaceText = TOOLS.find((t) => t.name === 'replace_text');
assert.ok(replaceText, 'replace_text tool def exists');
assert.ok(
  replaceText.schema.safeParse({ find: 'foo', replace: 'bar' }).success,
  'replace_text minimal schema',
);
assert.ok(
  replaceText.schema.safeParse({
    find: 'foo', replace: 'bar', regex: true, scope: 'n1', pageId: 'p1', allPages: false, budget: 500, chunk: 50,
  }).success,
  'replace_text full schema',
);
assert.strictEqual(
  replaceText.schema.safeParse({ find: 'foo' }).success,
  false,
  'replace_text requires replace',
);

console.log('serverside.mjs OK');
