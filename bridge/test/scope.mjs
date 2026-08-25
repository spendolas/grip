import assert from 'node:assert';
import { TOOLS } from '../dist/tools.js';
import { resolveToolScope, toolInScope, CORE_TOOL_NAMES, META_TOOL_NAMES, TOOL_CATEGORIES, toolCategorySummary, toolDetail } from '../dist/tools.js';

// Phase 3 task 5 (3b): motion/text/components cluster merge landed 162 -> 157.
assert.strictEqual(TOOLS.length, 157, `TOOLS.length should be 157, got ${TOOLS.length}`);

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
assert.ok(toolInScope('grip_health', resolveToolScope('read')), 'meta always present');
assert.ok(toolInScope('run_script', resolveToolScope('core')));
assert.ok(!toolInScope('animation_style', resolveToolScope('core')), 'motion not in core');
assert.ok(toolInScope('animation_style', resolveToolScope('core,motion')));
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
assert.ok(core.includes('grip_health') && core.includes('run_script'));
assert.ok(!core.includes('animation_style'));
assert.strictEqual(listFor('all').length, TOOLS.length, 'all must list every tool');
assert.ok(listFor('read').includes('grip_health') && !listFor('read').includes('run_script'));

// grip_capabilities now exists as a meta tool, present in every scope
assert.ok(TOOLS.some((t) => t.name === 'grip_capabilities'), 'grip_capabilities TOOLS entry missing');
assert.ok(toolInScope('grip_capabilities', resolveToolScope('read')), 'grip_capabilities must be meta/always-present');
// directory: meta excluded, motion visible-but-unloaded under core, loaded under core,motion
const dirCore = toolCategorySummary(resolveToolScope(null));
assert.ok(!dirCore.some((c) => c.name === 'meta'), 'directory must exclude meta');
const motion = dirCore.find((c) => c.name === 'motion');
assert.ok(motion && motion.loaded === false && motion.toolCount === TOOL_CATEGORIES.motion.length, 'motion should be present, unloaded, count matching TOOL_CATEGORIES.motion');
const dirMotion = toolCategorySummary(resolveToolScope('core,motion'));
assert.ok(dirMotion.find((c) => c.name === 'motion').loaded === true, 'motion loaded under core,motion');

// Phase 2: per-tool detail pull
assert.strictEqual(toolDetail('does_not_exist'), null, 'unknown tool → null');
const rs = toolDetail('run_script');
assert.ok(rs && rs.tool === 'run_script', 'toolDetail returns the tool');
assert.ok(typeof rs.description === 'string' && rs.description.length > 0, 'has description');
assert.ok('detail' in rs && 'category' in rs, 'shape has detail + category');

// Phase 2: the diet — trimmed descriptions + relocated detail, no information loss
const DIET = {
  run_script: 'run_script_rejected',
  set_node_property: 'GLASS',
  set_active_file: 'plugin_reconnected',
  export_node: 'GRIP_RESPONSE_CAP_BYTES',
  map_nodes: 'findAllWithCriteria',
  get_page_context: 'wrong page',
};
for (const [name, kw] of Object.entries(DIET)) {
  const d = toolDetail(name);
  assert.ok(d, `${name} exists`);
  assert.ok(d.description.length <= 620, `${name} description trimmed (was fat), got ${d.description.length}`);
  assert.ok(d.detail && d.detail.length > 0, `${name} detail populated`);
  assert.ok(d.detail.includes(kw), `${name} detail retains relocated keyword "${kw}"`);
  assert.ok(d.description.includes('grip_capabilities'), `${name} description points to grip_capabilities`);
}
// aggregate: core description bytes dropped well below the pre-diet 10154
import { resolveToolScope as _rs, toolInScope as _tis } from '../dist/tools.js';
const coreDescBytes = TOOLS.filter((t) => _tis(t.name, _rs('core'))).reduce((a, t) => a + (t.description || '').length, 0);
assert.ok(coreDescBytes < 7000, `core description bytes should drop below 7000, got ${coreDescBytes}`);

console.log('scope.mjs OK');
