import assert from 'node:assert';
import { TOOLS, MERGED_TOOLS, resolveMerged, categoryOf } from '../dist/tools.js';

// variable_collection: extend + remove_overrides resolve to plugin methods and keep params.
assert.deepStrictEqual(
  resolveMerged('variable_collection', { op: 'extend', collectionId: 'VariableCollectionId:1:2', name: 'Brand' }),
  { method: 'extend_variable_collection', rest: { collectionId: 'VariableCollectionId:1:2', name: 'Brand' } },
);
assert.deepStrictEqual(
  resolveMerged('variable_collection', { op: 'remove_overrides', collectionId: 'c', variableId: 'v' }),
  { method: 'remove_variable_overrides', rest: { collectionId: 'c', variableId: 'v' } },
);
const vc = TOOLS.find((t) => t.name === 'variable_collection');
for (const op of Object.keys(MERGED_TOOLS.variable_collection.map)) {
  assert.ok(vc.schema.safeParse({ op }).success, `variable_collection schema accepts op=${op}`);
}
assert.strictEqual(categoryOf('variable_collection'), 'variables');

// list_library_variables: library category, both call shapes validate.
const lib = TOOLS.find((t) => t.name === 'list_library_variables');
assert.ok(lib, 'list_library_variables exists');
assert.strictEqual(categoryOf('list_library_variables'), 'library');
assert.ok(lib.schema.safeParse({}).success && lib.schema.safeParse({ collectionKey: 'abc' }).success);
assert.ok(!lib.schema.safeParse({ collectionKey: 5 }).success);

// extend_library_collection_by_key now takes the name the Figma API requires.
const ext = TOOLS.find((t) => t.name === 'extend_library_collection_by_key');
assert.ok(ext.schema.safeParse({ key: 'k', name: 'Brand' }).success && ext.schema.safeParse({ key: 'k' }).success);
assert.strictEqual(categoryOf('extend_library_collection_by_key'), 'library');

console.log('library.mjs OK');
