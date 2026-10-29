import assert from 'node:assert';
import { TOOLS, MERGED_TOOLS, resolveMerged, toolDetail, toolInputSchema, categoryOf } from '../dist/tools.js';

// get_variables: additive resolution params validate; no params still valid.
const gv = TOOLS.find((t) => t.name === 'get_variables');
assert.ok(gv.schema.safeParse({}).success, 'get_variables accepts no params');
assert.ok(gv.schema.safeParse({ resolveFor: '1:2', variableIds: ['VariableID:1:3'], collectionId: 'c', forCollection: 'e' }).success);
assert.ok(!gv.schema.safeParse({ resolveFor: 5 }).success, 'resolveFor must be a string');
const js = toolInputSchema('get_variables');
for (const k of ['variableIds', 'collectionId', 'resolveFor', 'forCollection']) assert.ok(js.properties[k], `get_variables JSON schema lists ${k}`);
const d = toolDetail('get_variables');
assert.ok(d.detail.includes('resolveFor') && d.detail.includes('valuesByModeForCollection') && d.detail.includes('resolvedVariableModes') && d.detail.includes('inferredVariables'));

// variable_collection: remove_override_for_mode resolves to its plugin method and keeps params.
assert.deepStrictEqual(
  resolveMerged('variable_collection', { op: 'remove_override_for_mode', variableId: 'v', modeId: 'm', collectionId: 'c' }),
  { method: 'remove_variable_override_for_mode', rest: { variableId: 'v', modeId: 'm', collectionId: 'c' } },
);
const vc = TOOLS.find((t) => t.name === 'variable_collection');
for (const op of Object.keys(MERGED_TOOLS.variable_collection.map)) {
  assert.ok(vc.schema.safeParse({ op }).success, `variable_collection schema accepts op=${op}`);
}
assert.ok(vc.detail.includes('remove_override_for_mode'));
assert.strictEqual(categoryOf('variable_collection'), 'variables');

// set_variable_meta: codeSyntax null removes a platform.
const meta = TOOLS.find((t) => t.name === 'set_variable_meta');
assert.ok(meta.schema.safeParse({ variableId: 'v', codeSyntax: { WEB: '--x', ANDROID: null } }).success, 'codeSyntax null accepted');
assert.ok(!meta.schema.safeParse({ variableId: 'v', codeSyntax: { WEB: 5 } }).success, 'non-string codeSyntax still rejected');
assert.ok(meta.detail.includes('null'));

console.log('variable-resolution.mjs OK');
