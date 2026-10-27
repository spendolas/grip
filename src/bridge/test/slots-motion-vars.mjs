import assert from 'node:assert';
import { TOOLS, MERGED_TOOLS, resolveMerged, toolDetail } from '../dist/tools.js';

// table_op: reorder ops resolve to the plugin methods and keep their params.
assert.deepStrictEqual(
  resolveMerged('table_op', { op: 'reorder_rows', nodeId: '1:2', fromIndices: [0, 2], insertionIndex: 4 }),
  { method: 'table_reorder_rows', rest: { nodeId: '1:2', fromIndices: [0, 2], insertionIndex: 4 } },
);
assert.deepStrictEqual(
  resolveMerged('table_op', { op: 'reorder_columns', nodeId: '1:2', fromIndices: [1], insertionIndex: 0 }),
  { method: 'table_reorder_columns', rest: { nodeId: '1:2', fromIndices: [1], insertionIndex: 0 } },
);
const tableTool = TOOLS.find((t) => t.name === 'table_op');
for (const op of Object.keys(MERGED_TOOLS.table_op.map)) {
  assert.ok(tableTool.schema.safeParse({ op, nodeId: 'x' }).success, `table_op schema accepts op=${op}`);
}
assert.ok(tableTool.schema.safeParse({ op: 'reorder_rows' }).success);

// create_slot: slotSettings survive zod parsing (a plain z.object would strip them).
const slot = TOOLS.find((t) => t.name === 'create_slot');
const parsed = slot.schema.parse({
  componentId: '1:1',
  slotSettings: { minChildren: 1, maxChildren: null, stretchChildOnInsert: true, displayEmptyByDefault: false, allowPreferredValuesOnly: true },
  preferredValues: [{ type: 'COMPONENT', key: 'abc' }],
  description: 'd',
});
assert.deepStrictEqual(parsed.slotSettings, { minChildren: 1, maxChildren: null, stretchChildOnInsert: true, displayEmptyByDefault: false, allowPreferredValuesOnly: true });
assert.strictEqual(parsed.preferredValues.length, 1);
assert.ok(!slot.schema.safeParse({ componentId: '1:1', slotSettings: { minChildren: 'x' } }).success, 'bad slotSettings rejected');

// component_property passes slotSettings through untouched (passthrough schema, merged to the plugin methods).
assert.deepStrictEqual(
  resolveMerged('component_property', { op: 'add', componentId: '1:1', name: 'Content', type: 'SLOT', slotSettings: { maxChildren: 3 } }),
  { method: 'add_component_property', rest: { componentId: '1:1', name: 'Content', type: 'SLOT', slotSettings: { maxChildren: 3 } } },
);
const cpDetail = toolDetail('component_property').detail;
assert.ok(cpDetail.includes('slotSettings') && cpDetail.includes('limitViolations'), 'component_property detail documents slotSettings/limitViolations');

// Enum / type documentation is discoverable.
assert.ok(toolDetail('variable').detail.includes('EASING|TIMING'), 'variable detail lists EASING/TIMING');
assert.ok(toolDetail('set_variable_value').detail.includes('TIMING'), 'set_variable_value detail documents TIMING');
assert.ok(toolDetail('set_variable_value').detail.includes('CUSTOM_CUBIC_BEZIER'), 'set_variable_value detail documents easing shapes');
assert.ok(toolDetail('set_variable_meta').detail.includes('COLOR_OPACITY'), 'set_variable_meta detail lists COLOR_OPACITY');
const snp = toolDetail('set_node_property').detail;
for (const kw of ['SPACE_EVENLY', 'SPACE_AROUND', 'layoutWrap', 'VERTICAL']) assert.ok(snp.includes(kw), `set_node_property detail mentions ${kw}`);
assert.ok(snp.includes('GLASS'), 'original set_node_property detail retained');

console.log('slots-motion-vars: ok');
