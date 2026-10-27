import assert from 'node:assert';
import { TOOLS } from '../dist/tools.js';
import { mergeToolScope, resolveToolScope, toolInScope, CORE_TOOL_NAMES, META_TOOL_NAMES, TOOL_CATEGORIES, toolCategorySummary, toolDetail } from '../dist/tools.js';

// Phase 3 task 6 (3b): storage/ui/slides/subscribe cluster merge landed 157 -> 146.
// Server-side-optimization sprint task 3 added list_pages: 147 -> 148.
// Server-side-optimization sprint task 6 added replace_text: 149 -> 150.
// grip_load_tools (runtime scope widening): 150 -> 151. reorder_grid_tracks: 151 -> 152.
assert.strictEqual(TOOLS.length, 152, `TOOLS.length should be 152, got ${TOOLS.length}`);

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

// grip_load_tools / mergeToolScope
assert.ok(toolInScope('grip_load_tools', resolveToolScope('read')), 'grip_load_tools is meta (always listed)');
const m1 = mergeToolScope(null, ['motion']);
assert.ok(m1.ok && m1.spec === 'core,motion', `default+motion => core,motion, got ${m1.spec}`);
assert.ok(m1.added.includes('animation_style') && !m1.added.includes('set_node_property'), 'adds motion only');
const m2 = mergeToolScope('core,motion', ['motion', 'variables', 'bogus']);
assert.ok(m2.ok && m2.spec === 'core,motion,variables' && m2.unknown[0] === 'bogus', 'idempotent + unknown reported');
assert.ok(!m2.added.includes('animation_style'), 'already-loaded tools are not re-reported');
const m3 = mergeToolScope('core', ['all']);
assert.ok(m3.ok && m3.spec === 'all' && m3.added.length > 0, "'all' collapses spec");
assert.strictEqual(mergeToolScope('read', ['write']).ok, false, 'read-only scope (no run_script) cannot self-escalate');
assert.ok(mergeToolScope('core', ['bogus']).added.length === 0, 'unknown-only adds nothing');

// unload
const u1 = mergeToolScope('core,motion,variables', [], ['motion']);
assert.ok(u1.ok && u1.spec === 'core,variables', `unload motion => core,variables, got ${u1.spec}`);
assert.ok(u1.removed.includes('animation_style') && !u1.removed.includes('set_variable_value'), 'removes motion only');
const u2 = mergeToolScope('core,write', [], ['write']);
assert.ok(u2.ok && !u2.removed.includes('set_node_property'), 'tools also in core survive unloading their category');
assert.ok(u2.removed.includes('rescale'), 'non-core write tools are removed');
const u3 = mergeToolScope('all', [], ['motion']);
assert.ok(u3.ok && u3.spec.startsWith('core') && !u3.spec.includes('motion') && u3.spec.includes('figjam'), "unload from 'all' expands then subtracts");
assert.ok(toolInScope('create_sticky', resolveToolScope(u3.spec)) && !toolInScope('animation_style', resolveToolScope(u3.spec)));
const u4 = mergeToolScope('core,motion,figjam', [], ['all']);
assert.ok(u4.ok && u4.spec === 'core', "unload 'all' resets to core");
const u5 = mergeToolScope('core,motion', [], ['core', 'meta', 'bogus']);
assert.ok(u5.ok && u5.spec === 'core,motion' && u5.ignored.join() === 'core,meta' && u5.unknown[0] === 'bogus', 'core/meta cannot be unloaded');
assert.ok(toolInScope('run_script', resolveToolScope(u5.spec)), 'run_script survives any unload');
const u6 = mergeToolScope('core', ['motion'], ['motion']);
assert.ok(u6.ok && u6.spec === 'core', 'unload wins when a category is in both');
assert.strictEqual(mergeToolScope('read', [], ['read']).ok, false, 'restricted scope cannot change itself');

console.log('scope.mjs OK');
