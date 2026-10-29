// Style-folder reorder params, slides_canvas focus op, FigJam create params.
import assert from 'node:assert/strict';
import { TOOLS, resolveMerged } from '../dist/tools.js';

const tool = (n) => TOOLS.find((t) => t.name === n);

// move_local_style: style reorder (legacy) and folder reorder both validate.
const mls = tool('move_local_style').schema;
assert.ok(mls.safeParse({ styleId: 'S:1', afterStyleId: 'S:2' }).success);
assert.ok(mls.safeParse({ folder: 'Brand/Primary', styleType: 'PAINT', afterFolder: 'Brand/Accent' }).success);
assert.ok(mls.safeParse({ folder: 'Brand', styleType: 'GRID' }).success);
assert.ok(!mls.safeParse({ folder: 'Brand', styleType: 'CUSTOM' }).success, 'bad styleType rejected');

// slides_canvas focus op routes to slides_focus_slide; null survives.
assert.deepStrictEqual(resolveMerged('slides_canvas', { op: 'focus' }), { method: 'slides_focus_slide', rest: {} });
assert.deepStrictEqual(resolveMerged('slides_canvas', { op: 'focus', nodeId: null }), { method: 'slides_focus_slide', rest: { nodeId: null } });
assert.deepStrictEqual(resolveMerged('slides_canvas', { op: 'focus', nodeId: '1:2' }), { method: 'slides_focus_slide', rest: { nodeId: '1:2' } });
assert.ok(tool('slides_canvas').schema.safeParse({ op: 'focus' }).success);

// FigJam creators accept the new params.
assert.ok(tool('create_sticky').schema.safeParse({ authorVisible: true, isWideWidth: false }).success);
assert.ok(tool('create_connector').schema.safeParse({ startStrokeCap: 'NONE', endStrokeCap: 'ARROW_LINES' }).success);

console.log('style-folders-misc OK');
