import assert from 'node:assert';
import { TOOLS, toolInputSchema, toolDetail } from '../dist/tools.js';

const by = (n) => TOOLS.find((t) => t.name === n);

// list_fonts: axesFor accepted by zod + JSON schema, documented in detail.
const lf = by('list_fonts');
assert.ok(lf.schema.safeParse({ axesFor: 'Inter' }).success, 'list_fonts accepts axesFor');
assert.ok(lf.schema.safeParse({ family: 'Inter' }).success, 'list_fonts keeps family');
assert.ok(toolInputSchema('list_fonts').properties.axesFor, 'list_fonts JSON schema has axesFor');
assert.ok(toolDetail('list_fonts').detail.includes('axesFor'), 'list_fonts detail documents axesFor');

// load_font: style optional, variationSettings accepted.
const lo = by('load_font');
assert.ok(lo.schema.safeParse({ family: 'Inter' }).success, 'load_font style optional');
assert.ok(lo.schema.safeParse({ family: 'Inter', variationSettings: { wght: 550 } }).success, 'load_font accepts variationSettings');
assert.ok(!lo.schema.safeParse({ family: 'Inter', variationSettings: { wght: 'x' } }).success, 'variationSettings must be numeric');
assert.ok(toolInputSchema('load_font').properties.variationSettings, 'load_font JSON schema has variationSettings');
assert.ok(toolDetail('load_font').detail.includes('variationSettings'), 'load_font detail documents shape');

// textWrapStyle / variable-font guidance lives in detail (core descriptions stay frozen).
for (const n of ['set_node_property', 'set_style', 'set_text_range_property']) {
  const d = toolDetail(n).detail;
  assert.ok(d && d.includes('textWrapStyle'), `${n} detail mentions textWrapStyle`);
}
for (const n of ['set_node_property', 'set_style']) {
  assert.ok(toolDetail(n).detail.includes('variationSettings'), `${n} detail mentions variationSettings`);
}

console.log('text-fonts.mjs OK');
