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

// pageIds batch param (scales allPages to bounded per-call page batches)
const pp = t.schema.safeParse({ type: 'FRAME', pageIds: ['0:1', '2:3'] });
assert.ok(pp.success, 'schema accepts pageIds');
assert.deepStrictEqual(pp.data.pageIds, ['0:1', '2:3'], 'pageIds preserved as string[]');
assert.ok(!t.schema.safeParse({ pageIds: 'not-an-array' }).success, 'pageIds must be an array');

// allPages cursor: bounded auto-iteration
const pc = t.schema.safeParse({ allPages: true, maxPages: 10, pageCursor: 20 });
assert.ok(pc.success, 'schema accepts maxPages + pageCursor');
assert.strictEqual(pc.data.maxPages, 10);
assert.strictEqual(pc.data.pageCursor, 20);
assert.ok(!t.schema.safeParse({ maxPages: 0 }).success, 'maxPages must be positive');
assert.ok(!t.schema.safeParse({ pageCursor: -1 }).success, 'pageCursor must be >= 0');

// allPages time budget + resume cursor
const tb = t.schema.safeParse({ allPages: true, timeBudgetMs: 5000, nodeCursor: 100 });
assert.ok(tb.success, 'schema accepts timeBudgetMs + nodeCursor');
assert.strictEqual(tb.data.timeBudgetMs, 5000, 'timeBudgetMs preserved');
assert.strictEqual(tb.data.nodeCursor, 100, 'nodeCursor preserved');
assert.ok(!t.schema.safeParse({ timeBudgetMs: 0 }).success, 'timeBudgetMs must be positive');
assert.ok(!t.schema.safeParse({ nodeCursor: -1 }).success, 'nodeCursor must be >= 0');

// advertised JSON schema surfaces the new params
const js = toolInputSchema('search_nodes');
assert.ok(js.properties.maxPages && js.properties.pageCursor, 'toolInputSchema advertises maxPages + pageCursor');
assert.ok(js.properties.fillType && js.properties.hasStyle && js.properties.hasBoundVariable, 'toolInputSchema advertises new params');
assert.ok(Array.isArray(js.properties.fillType.enum) && js.properties.fillType.enum.includes('GRADIENT'), 'fillType enum advertised incl GRADIENT');
assert.ok(js.properties.pageIds && js.properties.pageIds.type === 'array', 'toolInputSchema advertises pageIds array');
assert.ok(js.properties.timeBudgetMs && js.properties.nodeCursor, 'toolInputSchema advertises timeBudgetMs + nodeCursor');

// properties projection (server-side opt: fields per match in one call)
const pr = t.schema.safeParse({ type: 'TEXT', properties: ['fills', 'characters'] });
assert.ok(pr.success && Array.isArray(pr.data.properties), 'schema accepts properties[]');
assert.deepStrictEqual(pr.data.properties, ['fills', 'characters'], 'properties preserved');
assert.ok(toolInputSchema('search_nodes').properties.properties, 'toolInputSchema advertises properties');

console.log('search-nodes.mjs OK');
