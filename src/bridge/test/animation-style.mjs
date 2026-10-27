import assert from 'node:assert';
import { TOOLS, MERGED_TOOLS, resolveMerged } from '../dist/tools.js';

const ops = {
  apply: 'apply_animation_style', remove: 'remove_animation_style',
  create: 'create_custom_animation_style', list_local: 'list_custom_animation_styles',
  update: 'update_custom_animation_style', move_style: 'move_custom_animation_style',
  move_folder: 'move_custom_animation_folder', add_entry: 'add_animation_entry',
  remove_entry: 'remove_animation_entry',
};
assert.deepStrictEqual(MERGED_TOOLS.animation_style.map, ops);
const t = TOOLS.find((x) => x.name === 'animation_style');
for (const op of Object.keys(ops)) assert.ok(t.schema.safeParse({ op }).success, `schema accepts op=${op}`);
assert.ok(!t.schema.safeParse({ op: 'bogus' }).success);
assert.deepStrictEqual(
  resolveMerged('animation_style', { op: 'add_entry', styleId: 'S:1', entryStyleId: 'opacity', props: { duration: 1 } }),
  { method: 'add_animation_entry', rest: { styleId: 'S:1', entryStyleId: 'opacity', props: { duration: 1 } } });
assert.deepStrictEqual(resolveMerged('animation_style', { op: 'list_local' }), { method: 'list_custom_animation_styles', rest: {} });
assert.deepStrictEqual(
  resolveMerged('animation_style', { op: 'move_folder', folder: 'A/B', afterFolder: null }),
  { method: 'move_custom_animation_folder', rest: { folder: 'A/B', afterFolder: null } });
for (const op of Object.keys(ops)) assert.ok(t.detail.includes(`op=${op}`), `detail documents op=${op}`);
console.log('animation-style ok');
