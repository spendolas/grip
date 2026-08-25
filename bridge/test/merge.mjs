import assert from 'node:assert';
import { TOOLS, MERGED_TOOLS, mergedToolNames, resolveMerged, TOOL_CATEGORIES, CORE_TOOL_NAMES } from '../dist/tools.js';

// Every merged tool has a TOOLS entry whose schema enum equals its map keys.
for (const [name, spec] of Object.entries(MERGED_TOOLS)) {
  const t = TOOLS.find((x) => x.name === name);
  assert.ok(t, `merged tool ${name} missing from TOOLS`);
  assert.ok(TOOL_CATEGORIES[spec.category].includes(name), `${name} not in TOOL_CATEGORIES.${spec.category}`);
}
// None of the underlying (former) method names remain as their own TOOLS entry.
const toolNames = new Set(TOOLS.map((t) => t.name));
for (const spec of Object.values(MERGED_TOOLS)) {
  for (const method of Object.values(spec.map)) {
    assert.ok(!toolNames.has(method), `former tool ${method} should be merged away`);
  }
}
// resolveMerged translates correctly.
const r = resolveMerged('bind_to_variable', { target: 'paint', nodeId: '1:2', variableId: 'V:3' });
assert.deepStrictEqual(r, { method: 'bind_paint_to_variable', rest: { nodeId: '1:2', variableId: 'V:3' } });
assert.ok('error' in resolveMerged('bind_to_variable', { nodeId: '1:2' }), 'missing target → error');
assert.ok('error' in resolveMerged('bind_to_variable', { target: 'bogus' }), 'unknown target → error');
assert.strictEqual(resolveMerged('get_node', {}), null, 'non-merged → null');
const g = resolveMerged('group', { op: 'ungroup', nodeId: '4:5' });
assert.deepStrictEqual(g, { method: 'ungroup_node', rest: { nodeId: '4:5' } });
// 3a core membership
assert.ok(CORE_TOOL_NAMES.has('bind_to_variable') && CORE_TOOL_NAMES.has('group'), '3a merged tools in core');
assert.ok(!CORE_TOOL_NAMES.has('bind_property_to_variable') && !CORE_TOOL_NAMES.has('group_nodes'), 'old core names removed');

// 3b: variables-domain clusters
assert.deepStrictEqual(resolveMerged('variable_mode', { op: 'rename', modeId: 'm1', name: 'Dark' }), { method: 'rename_variable_mode', rest: { modeId: 'm1', name: 'Dark' } });
assert.deepStrictEqual(resolveMerged('variable', { op: 'create', collectionId: 'c1', name: 'x', resolvedType: 'COLOR' }), { method: 'create_variable', rest: { collectionId: 'c1', name: 'x', resolvedType: 'COLOR' } });
assert.deepStrictEqual(resolveMerged('variable_collection', { op: 'delete', collectionId: 'c1' }), { method: 'delete_variable_collection', rest: { collectionId: 'c1' } });
assert.deepStrictEqual(resolveMerged('explicit_variable_mode', { op: 'clear', nodeId: '1:1', collectionId: 'c1' }), { method: 'clear_explicit_variable_mode', rest: { nodeId: '1:1', collectionId: 'c1' } });

// 3b: devmode clusters
assert.deepStrictEqual(resolveMerged('measurement', { op: 'for_node', nodeId: '1:1' }), { method: 'get_measurements_for_node', rest: { nodeId: '1:1' } });
assert.deepStrictEqual(resolveMerged('annotation_category', { op: 'list' }), { method: 'get_annotation_categories', rest: {} });
assert.deepStrictEqual(resolveMerged('dev_resource', { op: 'get', nodeId: '1:1' }), { method: 'get_dev_resources', rest: { nodeId: '1:1' } });

// 3b: figjam clusters
assert.deepStrictEqual(resolveMerged('table_op', { op: 'insert_row', nodeId: 't1', index: 2 }), { method: 'table_insert_row', rest: { nodeId: 't1', index: 2 } });
assert.deepStrictEqual(resolveMerged('table_op', { op: 'cell_at', nodeId: 't1', row: 0, column: 1 }), { method: 'table_cell_at', rest: { nodeId: 't1', row: 0, column: 1 } });
assert.deepStrictEqual(resolveMerged('timer', { op: 'start', seconds: 60 }), { method: 'timer_start', rest: { seconds: 60 } });

// 3b: motion/text/components clusters
assert.deepStrictEqual(resolveMerged('animation_style', { op: 'apply', nodeId: '1:1', styleId: 's', props: {} }), { method: 'apply_animation_style', rest: { nodeId: '1:1', styleId: 's', props: {} } });
assert.deepStrictEqual(resolveMerged('manual_keyframe_track', { op: 'remove', nodeId: '1:1', trackId: 'k' }), { method: 'remove_manual_keyframe_track', rest: { nodeId: '1:1', trackId: 'k' } });
assert.deepStrictEqual(resolveMerged('edit_characters', { op: 'insert', nodeId: '1:1', index: 0, characters: 'hi' }), { method: 'insert_characters', rest: { nodeId: '1:1', index: 0, characters: 'hi' } });
assert.deepStrictEqual(resolveMerged('component_property', { op: 'delete', nodeId: '1:1', propertyName: 'p' }), { method: 'delete_component_property', rest: { nodeId: '1:1', propertyName: 'p' } });

// 3b: storage/ui/slides/subscribe clusters
assert.deepStrictEqual(resolveMerged('client_storage', { op: 'set', key: 'k', value: 1 }), { method: 'client_storage_set', rest: { key: 'k', value: 1 } });
assert.deepStrictEqual(resolveMerged('ui', { op: 'resize', width: 400, height: 300 }), { method: 'ui_resize', rest: { width: 400, height: 300 } });
assert.deepStrictEqual(resolveMerged('slides_canvas', { op: 'get_grid' }), { method: 'slides_get_canvas_grid', rest: {} });
assert.deepStrictEqual(resolveMerged('subscribe', { target: 'selection' }), { method: 'subscribe_selection', rest: {} });
console.log('merge.mjs OK');
