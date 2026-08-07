import assert from 'node:assert';
import { TOOLS } from '../dist/tools.js';
import { resolveToolScope, toolInScope, categoryOf, CORE_TOOL_NAMES, META_TOOL_NAMES, TOOL_CATEGORIES } from '../dist/tools.js';

// Every tool has exactly one category; every core/meta name is a real tool.
const allNames = new Set(TOOLS.map((t) => t.name));
const catNames = Object.values(TOOL_CATEGORIES).flat();
assert.strictEqual(catNames.length, new Set(catNames).size, 'a tool is categorised twice');
assert.strictEqual(catNames.length, allNames.size, 'category map count != TOOLS count');
for (const n of catNames) assert.ok(allNames.has(n), `category map lists unknown tool ${n}`);
for (const n of [...CORE_TOOL_NAMES, ...META_TOOL_NAMES]) assert.ok(allNames.has(n), `core/meta lists unknown tool ${n}`);
assert.ok(CORE_TOOL_NAMES.has('run_script'), 'run_script must be in core');
assert.ok(!META_TOOL_NAMES.has('run_script'), 'run_script must NOT be meta (read scope stays read-only)');

// resolve: default (unset) => core
const dflt = resolveToolScope(undefined);
assert.strictEqual(dflt.all, false);
assert.ok(dflt.coreNames.has('set_node_property'));
assert.ok(!dflt.categories.has('motion'));

// 'all' => everything
assert.strictEqual(resolveToolScope('all').all, true);

// 'core,motion' => core names + motion category
const cm = resolveToolScope('core,motion');
assert.ok(cm.coreNames.has('export_node'));
assert.ok(cm.categories.has('motion'));

// 'read' => read category only, NO run_script
const ro = resolveToolScope('read');
assert.ok(ro.categories.has('read'));
assert.ok(!ro.coreNames.has('run_script'), 'read scope must exclude run_script');

// toolInScope: meta always; core name under core; category under its token
// NOTE: the brief used 'grip_capabilities' here, but that tool does not exist
// yet in TOOLS (it's added in Task 3). Using 'grip_health' — an existing real
// meta tool — exercises the identical "meta always present" behavior without
// referencing a not-yet-real tool. See task-1-report.md for the full note.
assert.ok(toolInScope('grip_health', resolveToolScope('read')), 'meta always present');
assert.ok(toolInScope('run_script', resolveToolScope('core')));
assert.ok(!toolInScope('apply_animation_style', resolveToolScope('core')), 'motion not in core');
assert.ok(toolInScope('apply_animation_style', resolveToolScope('core,motion')));
assert.ok(toolInScope('set_node_property', resolveToolScope('all')));

// unknown token ignored, not fatal
assert.doesNotThrow(() => resolveToolScope('core,bogus'));

// Simulate ListTools filtering exactly as mcp-server will.
const listFor = (spec) => {
  const scope = resolveToolScope(spec);
  return TOOLS.map((t) => t.name).filter((n) => toolInScope(n, scope));
};
const core = listFor(null);
assert.ok(core.length >= 40 && core.length <= 46, `core list size unexpected: ${core.length}`);
// NOTE: the brief's version of this assertion checks for 'grip_capabilities'
// instead of 'grip_health'. That tool does not exist in TOOLS yet — it's
// added in Task 3 (see the NOTE above and task-1-report.md) — so asserting
// on it here would fail by construction, not because of a real regression.
// 'grip_health' is an existing real meta tool and exercises the identical
// "meta always present in core scope" behavior.
assert.ok(core.includes('grip_health') && core.includes('run_script'));
assert.ok(!core.includes('apply_animation_style'));
assert.strictEqual(listFor('all').length, TOOLS.length, 'all must list every tool');
assert.ok(listFor('read').includes('grip_health') && !listFor('read').includes('run_script'));

console.log('scope.mjs OK');
