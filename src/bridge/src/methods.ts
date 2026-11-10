import { resolveMerged } from './tools.js';

// Method classification the bridge needs for flow control (reconnect retry,
// `maybe_applied`, event `causedBy`).
//
// READ_ONLY_METHODS mirrors `READ_ONLY_METHODS` in src/plugin/code.ts EXACTLY
// (the plugin uses it to decide which calls get an undo bracket). The plugin is
// a separate bundle, so the list cannot be imported; test/flow-multi.mjs parses
// the plugin source and fails if the two drift. Edit both together.
export const READ_ONLY_METHODS = new Set<string>([
  // bridge-side (never reach this dispatcher, but listed for symmetry)
  'list_files', 'set_active_file', 'grip_health', 'grip_diagnose',
  // reads
  'get_document', 'get_page', 'get_node', 'get_nodes', 'get_selection',
  'get_styles', 'get_variables', 'get_components', 'search_nodes',
  'find_with_criteria', 'get_plugin_data', 'get_shared_plugin_data',
  'get_styled_text_segments', 'get_dev_resources', 'get_annotations',
  'get_annotation_categories', 'get_annotation_category',
  'get_measurements', 'get_measurements_for_node',
  'get_selection_colors', 'get_active_users', 'get_current_user', 'get_deep_link', 'get_page_context',
  'get_instances', 'get_style_consumers', 'get_text_range_bound_variable',
  'get_attached_connectors', 'get_file_thumbnail_node',
  'get_image_by_hash', 'get_stamp_author', 'get_overrides',
  'get_publish_status', 'get_text_content', 'get_top_level_frame',
  'get_relaunch_data', 'get_buzz_asset_type',
  'slides_get_canvas_grid', 'get_slide_transition', 'get_audit', 'list_pages',
  // listings + loaders that don't change the canvas
  'list_fonts', 'load_font', 'load_brushes', 'list_shaders',
  'list_animation_styles', 'get_animations', 'spring_to_normalized', 'get_library_usage', 'list_library_variables',
  'list_custom_animation_styles',
  // exports + transient UI
  'export_node', 'notify',
  // subscribe just flips a flag; no document mutation
  'subscribe_selection', 'subscribe_document', 'subscribe_currentpage',
  // viewport / selection state (transient, not undoable)
  'set_viewport', 'scroll_to', 'set_selection',
  'set_current_page',
  // client storage is per-user, not document
  'client_storage_get', 'client_storage_set',
  'client_storage_delete', 'client_storage_keys',
  // UI window control
  'ui_show', 'ui_hide', 'ui_resize', 'ui_reposition',
  // user-driven undo controls — don't double-commit
  'commit_undo', 'trigger_undo',
  // misc external
  'open_external_url',
]);

// "Read-only" in the plugin's sense (no undo step) is not the same as "safe to
// send twice". These have a visible, non-idempotent effect: a second undo
// undoes one more step, a toast or browser tab shows up twice.
const NOT_REPEATABLE = new Set<string>(['trigger_undo', 'notify', 'open_external_url']);

// Safe for the bridge to re-send on its own after a plugin reconnect: the call
// either reads, or sets state to the same value again (selection, viewport,
// current page, client storage).
export function isRetrySafe(method: string): boolean {
  return READ_ONLY_METHODS.has(method) && !NOT_REPEATABLE.has(method);
}

// Read-only methods that still make the plugin emit a subscription event
// (selectionchange / currentpagechange / documentchange).
const EVENTFUL_READ_ONLY = new Set<string>(['set_selection', 'set_current_page', 'trigger_undo']);

// Could this call be the cause of a selection/document/page event? Used for the
// `causedBy` field on event notifications.
export function causesEvents(method: string): boolean {
  return !READ_ONLY_METHODS.has(method) || EVENTFUL_READ_ONLY.has(method);
}

// Tools the bridge answers itself that never change the document (routing,
// health, tool scope, update checks/installs, event subscriptions).
const BRIDGE_SIDE_SAFE_TOOLS = new Set<string>([
  'list_files', 'set_active_file', 'grip_health', 'grip_diagnose',
  'grip_capabilities', 'grip_load_tools', 'grip_update', 'subscribe',
]);

// Could a tools/call of `tool` with `args` have changed the document? Used by
// the shim (proxy.ts) to decide whether a call lost with a dropped socket may
// already have been applied. Unknown or mutating tools say yes; merged tools
// are judged by the method their op/target resolves to.
export function toolMayChangeDocument(tool: string | undefined, args: unknown): boolean {
  if (!tool) return true;
  if (BRIDGE_SIDE_SAFE_TOOLS.has(tool)) return false;
  const merged = resolveMerged(tool, args);
  if (merged) return 'method' in merged ? !READ_ONLY_METHODS.has(merged.method) : false; // a bad op is refused before the plugin
  return !READ_ONLY_METHODS.has(tool);
}
