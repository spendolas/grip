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
  // TODO(task 4): 'create_tree',
  // TODO(task 5): 'replace_text',
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

console.log('serverside.mjs OK');
