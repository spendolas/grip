import assert from 'node:assert';
import { TOOLS, toolInputSchema } from '../dist/tools.js';

const t = TOOLS.find((x) => x.name === 'search_nodes');
assert.ok(t, 'search_nodes exists');

// zod schema accepts + preserves the new predicates
const p = t.schema.safeParse({ fillType: 'IMAGE', hasStyle: true, hasBoundVariable: true });
assert.ok(p.success, 'schema accepts new predicates');
assert.strictEqual(p.data.fillType, 'IMAGE', 'fillType preserved (not stripped)');
assert.strictEqual(p.data.hasStyle, true, 'hasStyle preserved');
assert.strictEqual(p.data.hasBoundVariable, true, 'hasBoundVariable preserved');

// all fillType values incl. GRADIENT wildcard accepted; bad value rejected
for (const v of ['SOLID', 'IMAGE', 'VIDEO', 'SHADER', 'GRADIENT', 'GRADIENT_LINEAR', 'GRADIENT_RADIAL', 'GRADIENT_ANGULAR', 'GRADIENT_DIAMOND']) {
  assert.ok(t.schema.safeParse({ fillType: v }).success, `fillType ${v} accepted`);
}
assert.ok(!t.schema.safeParse({ fillType: 'BOGUS' }).success, 'bad fillType rejected');

// existing params still work (no regression)
assert.ok(t.schema.safeParse({ type: 'TEXT', fillHex: '#FF0000', maxResults: 10 }).success, 'existing params still valid');

// advertised JSON schema surfaces the new params
const js = toolInputSchema('search_nodes');
assert.ok(js.properties.fillType && js.properties.hasStyle && js.properties.hasBoundVariable, 'toolInputSchema advertises new params');
assert.ok(Array.isArray(js.properties.fillType.enum) && js.properties.fillType.enum.includes('GRADIENT'), 'fillType enum advertised incl GRADIENT');

console.log('search-nodes.mjs OK');
