// create_component_set (axes matrix) and create_sticky batch: schema, scope, derived JSON schema, docs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TOOLS, categoryOf, toolInputSchema, toolInScope, resolveToolScope } from '../dist/tools.js';

const tool = (n) => TOOLS.find((t) => t.name === n);

// ---- create_component_set
const ccs = tool('create_component_set');
assert.ok(ccs, 'create_component_set exists');
assert.strictEqual(categoryOf('create_component_set'), 'components');
assert.ok(toolInScope('create_component_set', resolveToolScope('core,components')));
assert.ok(!toolInScope('create_component_set', resolveToolScope('core')), 'not in core');
assert.ok(ccs.schema.safeParse({ axes: { Size: ['S', 'M'], State: ['default', 'hover'] } }).success);
assert.ok(ccs.schema.safeParse({ axes: { Size: ['S'] }, name: 'Button', template: '1:2', parentId: '1:1', x: 0, y: 0, gap: 8 }).success);
assert.ok(!ccs.schema.safeParse({}).success, 'axes required');
assert.ok(!ccs.schema.safeParse({ axes: { Size: [] } }).success, 'empty axis rejected');
assert.ok(!ccs.schema.safeParse({ axes: { Size: [1, 2] } }).success, 'values must be strings');
assert.ok(!ccs.schema.safeParse({ axes: { Size: ['S'] }, gap: -1 }).success, 'negative gap rejected');
const ccsJs = toolInputSchema('create_component_set');
assert.strictEqual(ccsJs.type, 'object');
assert.deepStrictEqual(ccsJs.required, ['axes']);
assert.ok(ccsJs.properties.axes, 'axes in JSON schema');
assert.ok(ccs.detail && /COMPONENT_SET/.test(ccs.detail), 'detail documents the result');

// ---- create_sticky batch
const cs = tool('create_sticky');
assert.ok(cs.schema.safeParse({ text: 'hi' }).success, 'single form still valid');
assert.ok(cs.schema.safeParse({ items: [{ text: 'a' }, { text: 'b', x: 1, y: 2, color: '#FFD966' }], columns: 3, gap: 12, author: 'N' }).success);
assert.ok(!cs.schema.safeParse({ items: [] }).success, 'empty items rejected');
assert.ok(!cs.schema.safeParse({ items: Array.from({ length: 201 }, () => ({ text: 'x' })) }).success, '201 items rejected');
assert.ok(cs.schema.safeParse({ items: Array.from({ length: 200 }, () => ({ text: 'x' })) }).success, '200 items ok');
assert.ok(!cs.schema.safeParse({ columns: 0 }).success, 'columns >= 1');
const csJs = toolInputSchema('create_sticky');
assert.ok(csJs.properties.items && csJs.properties.items.type === 'array', 'items derived from the zod schema');
assert.strictEqual(csJs.properties.items.maxItems, 200);
assert.ok(csJs.properties.color, 'color in JSON schema');

// ---- docs mention both
const toolsMd = fs.readFileSync(new URL('../../../TOOLS.md', import.meta.url), 'utf8');
assert.ok(/### `create_component_set`/.test(toolsMd), 'TOOLS.md documents create_component_set');
assert.ok(/`items`/.test(toolsMd) && /create_sticky/.test(toolsMd), 'TOOLS.md documents the sticky batch');

console.log('canvas-builders OK');
