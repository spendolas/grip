import assert from 'node:assert';
import { TOOLS, toolInputSchema, toolDetail } from '../dist/tools.js';

// move_node: row/column (GridLayoutMixin.appendChildAt) reach the plugin — zod must not strip them.
const mv = TOOLS.find((t) => t.name === 'move_node');
const ok = mv.schema.parse({ nodeId: '1:2', parentId: '3:4', row: 1, column: 2 });
assert.strictEqual(ok.row, 1);
assert.strictEqual(ok.column, 2);
assert.doesNotThrow(() => mv.schema.parse({ nodeId: '1:2', parentId: '3:4', index: 0 }), 'plain reparent still valid');
assert.throws(() => mv.schema.parse({ nodeId: '1:2', parentId: '3:4', row: -1, column: 0 }), 'negative row rejected');
const mvJson = toolInputSchema('move_node');
assert.ok(mvJson.properties.row && mvJson.properties.column, 'JSON schema advertises row/column');
assert.deepStrictEqual(mvJson.required, ['nodeId', 'parentId'], 'row/column stay optional');
assert.ok(/appendChildAt/.test(toolDetail('move_node').detail), 'move_node detail documents grid placement');
// core descriptions must not grow for this: move_node description unchanged.
assert.strictEqual(mv.description, 'Reparent and/or reorder a node. `index` controls z-order within the new parent.');

// set_node_property: new props documented in `detail` (description budget is enforced in scope.mjs).
const snp = toolDetail('set_node_property');
for (const k of ['counterAxisAlignContent', 'maskType', 'handleMirroring', 'numberOfFixedChildren', 'overlayPositionType', 'absoluteTransform', 'absoluteRenderBounds', 'fillGeometry', 'strokeGeometry', 'PATTERN']) {
  assert.ok(snp.detail.includes(k), `set_node_property detail should mention ${k}`);
}
console.log('layout-shape OK');
