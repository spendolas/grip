// Remote access policy: what an MCP session marked `remote` (an agent that is NOT on this
// Mac, reaching the bridge through some future relay) may do. This module is pure policy
// plus the <GRIP_HOME>/remote.json store; it opens no port and talks to no network.
//
// The rules, all fail-closed:
//   - remote.json absent, unreadable or malformed => disabled, read mode, no files.
//   - Every tool is classified in REMOTE_TOOL_CLASS. A tool (or a merged tool's op) that is
//     not listed is `never`, so a tool added later is denied remotely until someone decides.
//   - `read` tier: allowed whenever remote access is enabled.
//   - `write` tier (node-level edits): only in `write` mode AND before `writeUntil` (an
//     armed, time-boxed window; an expired window is read mode).
//   - `extended` tier (file-wide definitions: styles, variables, component properties, pages,
//     library imports): only in armed write mode AND when named in `policy.tools`.
//   - `never`: never remotely, in any mode (scripts, disk, URLs, updates, routing, undo,
//     plugin data, client storage, events, cross-file work...).
//   - `policy.tools`, when present, narrows: a tool must be listed AND its tier must allow it.
//   - A remote session works on exactly one file, a real fileKey listed in `policy.files`.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { liveIdentity } from './identity.js';
import { MERGED_TOOLS } from './tools.js';

export type RemoteMode = 'read' | 'write';
export type RemoteTier = 'read' | 'write' | 'extended' | 'never';

export interface RemotePolicy {
  enabled: boolean;
  mode: RemoteMode;
  writeUntil?: number;      // ms epoch; write mode is armed only while now < writeUntil
  files: string[];          // real Figma fileKeys
  tools?: string[];         // optional narrowing allowlist
}

export const DEFAULT_REMOTE_POLICY: RemotePolicy = Object.freeze({ enabled: false, mode: 'read', files: [] }) as RemotePolicy;
export const MAX_WRITE_MINUTES = 8 * 60;
export const DEFAULT_WRITE_MINUTES = 30;

// A Figma fileKey as it appears in a figma.com URL. Never the "0:0" placeholder that
// every local/unsaved file reports.
export function isRemoteFileKey(k: unknown): k is string {
  return typeof k === 'string' && /^[A-Za-z0-9]{16,64}$/.test(k);
}

// Per-tool class. A string is the tier of the whole tool; an object is the tier of each
// op/target of a merged tool (an op that is not listed is `never`).
type ToolClass = RemoteTier | Record<string, RemoteTier>;

export const REMOTE_TOOL_CLASS: Readonly<Record<string, ToolClass>> = Object.freeze<Record<string, ToolClass>>({
  // ---- meta / bridge-side
  grip_health: 'never',            // names every open file, pairing state, other agents
  grip_diagnose: 'never',          // log tail
  list_files: 'never',             // names every open file
  set_active_file: 'never',        // a remote session never rebinds
  on_file: 'never',
  copy_between_files: 'never',
  grip_capabilities: 'read',
  grip_load_tools: 'never',
  grip_update: 'never',
  subscribe: 'never',              // no events for remote sessions
  get_page_context: 'read',
  // ---- reads
  get_document: 'read', get_page: 'read', get_node: 'read', get_nodes: 'read', get_selection: 'read',
  get_styles: 'read', get_variables: 'read', get_components: 'read', search_nodes: 'read',
  find_with_criteria: 'read', get_plugin_data: 'read', get_overrides: 'read', get_instances: 'read',
  get_selection_colors: 'read', get_top_level_frame: 'read', get_style_consumers: 'read',
  get_publish_status: 'read', get_relaunch_data: 'read', get_audit: 'read', list_pages: 'read',
  get_deep_link: 'read', get_styled_text_segments: 'read', get_text_content: 'read',
  get_text_range_bound_variable: 'read', get_annotations: 'read', get_attached_connectors: 'read',
  get_stamp_author: 'read', get_image_by_hash: 'read', get_slide_transition: 'read',
  get_file_thumbnail_node: 'read', get_library_usage: 'read', list_library_variables: 'read',
  list_fonts: 'read', load_font: 'read', load_brushes: 'read', list_shaders: 'read',
  list_animation_styles: 'read', get_animations: 'read', spring_to_normalized: 'read',
  get_buzz_asset_type: 'read', get_shared_plugin_data: 'read',
  export_node: 'read',             // never with `path`, never video (see remoteToolAllowed)
  // ---- node-level writes (armed write mode)
  set_node_property: 'write', create_node: 'write', create_tree: 'write', delete_node: 'write',
  clone_node: 'write', move_node: 'write', group: { group: 'write', ungroup: 'write' },
  set_selection: 'write', scroll_to: 'write',   // keepPage is forced for remote sessions
  set_viewport: 'write', rescale: 'write', lock_aspect_ratio: 'write', unlock_aspect_ratio: 'write',
  create_section: 'write', set_skip_invisible_instance_children: 'write',
  set_grid_child_position: 'write', reorder_grid_tracks: 'write', set_relaunch_data: 'write',
  apply_style: 'write', bind_to_variable: { property: 'write', paint: 'write', effect: 'write', layout_grid: 'write' },
  explicit_variable_mode: { set: 'write', clear: 'write' },
  swap_instance: 'write', detach_instance: 'write', reset_instance_overrides: 'write',
  create_component_from_node: 'write', combine_as_variants: 'write', create_component_set: 'write',
  create_slot: 'write',
  set_text_range_property: 'write', edit_characters: { insert: 'write', delete: 'write' },
  replace_text: 'write', create_text_path: 'write', set_text_range_bound_variable: 'write',
  flatten_nodes: 'write', boolean_operation: 'write', outline_stroke: 'write', set_vector_network: 'write',
  create_node_from_svg: 'write', transform_group: 'write',
  animation_style: {
    list_local: 'read', apply: 'write', remove: 'write',
    create: 'extended', update: 'extended', move_style: 'extended', move_folder: 'extended',
    add_entry: 'extended', remove_entry: 'extended',
  },
  manual_keyframe_track: { apply: 'write', remove: 'write' },
  set_timeline_duration: 'write',
  create_sticky: 'write', create_connector: 'write', create_shape_with_text: 'write', create_table: 'write',
  table_op: {
    cell_at: 'read', insert_row: 'write', insert_column: 'write', remove_row: 'write', remove_column: 'write',
    move_row: 'write', move_column: 'write', resize_row: 'write', resize_column: 'write',
  },
  create_slide: 'write', create_slide_row: 'write', set_slide_transition: 'write', create_page_divider: 'write',
  slides_canvas: { get_grid: 'read', create_row: 'write', focus: 'write', set_grid: 'write', move_nodes: 'write' },
  dev_resource: { get: 'read', add: 'write', edit: 'write', delete: 'write' },
  set_annotation: 'write',
  annotation_category: { get: 'read', list: 'read', add: 'extended', edit: 'extended', delete: 'extended' },
  measurement: { list: 'read', for_node: 'read', add: 'write', edit: 'write', delete: 'write' },
  set_reactions: 'write',
  upload_image: 'write', create_slice: 'write', create_code_block: 'write',
  set_buzz_asset_type: 'write',
  save_version: 'write',
  // ---- file-wide definitions (armed write mode + named in policy.tools)
  create_page: 'extended', delete_page: 'extended',
  set_style: 'extended', delete_style: 'extended', move_local_style: 'extended',
  set_variable_value: 'extended', set_variable_meta: 'extended',
  variable: { create: 'extended', delete: 'extended' },
  variable_collection: {
    create: 'extended', delete: 'extended', extend: 'extended', remove_overrides: 'extended', remove_override_for_mode: 'extended',
  },
  variable_mode: { add: 'extended', remove: 'extended', rename: 'extended' },
  request_variable_to_be_enabled: 'extended', request_variable_to_be_disabled: 'extended',
  component_property: { add: 'extended', edit: 'extended', delete: 'extended' },
  import_component_by_key: 'extended', import_component_set_by_key: 'extended', import_style_by_key: 'extended',
  import_variable_by_key: 'extended', import_shader: 'extended', extend_library_collection_by_key: 'extended',
  set_file_thumbnail: 'extended',
  timer: { start: 'extended', stop: 'extended', pause: 'extended', resume: 'extended' },
  // ---- never remotely
  run_script: 'never', map_nodes: 'never',
  upload_image_from_path: 'never', upload_image_begin: 'never', upload_image_chunk: 'never', upload_image_finish: 'never',
  open_external_url: 'never', create_image_from_url: 'never', create_link_preview: 'never',
  create_gif: 'never', create_video: 'never',
  client_storage: 'never', set_plugin_data: 'never', set_shared_plugin_data: 'never',
  trigger_undo: 'never', commit_undo: 'never', notify: 'never', ui: 'never',
  set_current_page: 'never',       // switches the user's page; reads take pageId instead
  get_active_users: 'never', get_current_user: 'never',   // people's names and photos
});


// ---- MCP tool annotations, derived from the classification above (one source of truth).
// `read` => readOnly. `write` / `extended` change the document => not readOnly. `never` tools
// are judged one by one: the few that only report state are in NEVER_READS, the rest are
// treated as changing something. destructiveHint marks deletes, removals, detaches, bulk
// overwrites and anything that can do all of those (run_script, map_nodes, undo, updates).
// A merged tool is readOnly only if every op is a read, and destructive if any op is.
const NEVER_READS: ReadonlySet<string> = new Set([
  'grip_health', 'grip_diagnose', 'list_files', 'get_active_users', 'get_current_user',
]);
const DESTRUCTIVE: ReadonlySet<string> = new Set([
  // whole tools
  'delete_node', 'delete_page', 'delete_style', 'detach_instance', 'reset_instance_overrides',
  'flatten_nodes', 'boolean_operation', 'replace_text', 'set_vector_network',
  'run_script', 'map_nodes', 'trigger_undo', 'grip_update', 'on_file', 'client_storage',
  // ops of merged tools, as tool:op
  'group:ungroup', 'variable:delete', 'variable_collection:delete', 'variable_collection:remove_overrides',
  'variable_collection:remove_override_for_mode', 'variable_mode:remove', 'annotation_category:delete',
  'measurement:delete', 'dev_resource:delete', 'table_op:remove_row', 'table_op:remove_column',
  'animation_style:remove', 'animation_style:remove_entry', 'manual_keyframe_track:remove',
  'edit_characters:delete', 'component_property:delete',
]);

export interface ToolAnnotations { readOnlyHint: boolean; destructiveHint: boolean }

function opIsRead(tool: string, tier: RemoteTier): boolean {
  return tier === 'read' || (tier === 'never' && NEVER_READS.has(tool));
}

// Annotations for one tool, or undefined for a tool the classification does not know (the
// remote-policy test fails on that, so it cannot ship).
export function toolAnnotations(tool: string): ToolAnnotations | undefined {
  const c = Object.prototype.hasOwnProperty.call(REMOTE_TOOL_CLASS, tool) ? REMOTE_TOOL_CLASS[tool] : undefined;
  if (!c) return undefined;
  if (typeof c === 'string') {
    const ro = opIsRead(tool, c);
    return { readOnlyHint: ro, destructiveHint: !ro && DESTRUCTIVE.has(tool) };
  }
  const ops = Object.entries(c);
  const ro = ops.every(([, t]) => opIsRead(tool, t));
  const destructive = DESTRUCTIVE.has(tool) || ops.some(([op, t]) => !opIsRead(tool, t) && DESTRUCTIVE.has(`${tool}:${op}`));
  return { readOnlyHint: ro, destructiveHint: !ro && destructive };
}

// For tests: the names in DESTRUCTIVE (so a typo there is caught).
export const DESTRUCTIVE_NAMES: readonly string[] = [...DESTRUCTIVE];
export const NEVER_READ_NAMES: readonly string[] = [...NEVER_READS];

const VIDEO_FORMATS = new Set(['MP4', 'GIF', 'WEBM']);

export function writeArmed(p: RemotePolicy, now = Date.now()): boolean {
  return p.mode === 'write' && typeof p.writeUntil === 'number' && p.writeUntil > now;
}

// The tier of one call (tool + its op), `never` when unknown.
export function remoteTierOf(toolName: string, args?: Record<string, unknown>): RemoteTier {
  const c = Object.prototype.hasOwnProperty.call(REMOTE_TOOL_CLASS, toolName) ? REMOTE_TOOL_CLASS[toolName] : undefined;
  if (!c) return 'never';
  if (typeof c === 'string') return c;
  const op = args?.[MERGED_TOOLS[toolName]?.discriminator ?? 'op'];
  if (typeof op !== 'string' || !Object.prototype.hasOwnProperty.call(c, op)) return 'never';
  return c[op];
}

// Tiers a policy allows right now (before the `tools` narrowing).
function tierAllowed(p: RemotePolicy, tier: RemoteTier, toolName: string, now: number): boolean {
  if (tier === 'read') return true;
  if (tier === 'write') return writeArmed(p, now);
  if (tier === 'extended') return writeArmed(p, now) && !!p.tools?.includes(toolName);
  return false;
}

export type RemoteDecision = { ok: true } | { ok: false; reason: string };

// May a remote session make this call? Pure.
export function remoteToolAllowed(
  p: RemotePolicy, toolName: string, args: Record<string, unknown> = {}, now = Date.now(),
): RemoteDecision {
  if (!p.enabled) return { ok: false, reason: 'remote access is switched off on this Mac' };
  if (p.tools && !p.tools.includes(toolName)) return { ok: false, reason: `${toolName} is not in this Mac's remote tool list` };
  // A per-call `file` would aim the call at another file.
  if (args.file !== undefined) return { ok: false, reason: 'remote sessions work on their one file; the `file` argument is not allowed' };
  const tier = remoteTierOf(toolName, args);
  if (tier === 'never') return { ok: false, reason: `${toolName}${args.op ?? args.target ? ` (${String(args.op ?? args.target)})` : ''} is never available remotely` };
  if (toolName === 'export_node') {
    if (args.path !== undefined) return { ok: false, reason: 'export_node cannot write to this Mac\'s disk remotely (drop `path`)' };
    if (VIDEO_FORMATS.has(String(args.format ?? ''))) return { ok: false, reason: 'video export needs a file on this Mac and is not available remotely' };
  }
  if (!tierAllowed(p, tier, toolName, now)) {
    if (tier === 'write') return { ok: false, reason: `${toolName} changes the file; remote write access is not armed on this Mac (the user can run \`remote mode write --minutes N\`)` };
    return { ok: false, reason: `${toolName} changes file-wide definitions; it needs armed write mode and an explicit entry in the remote tool list` };
  }
  return { ok: true };
}

// Could this tool be allowed for some op right now? For tools/list.
export function remoteToolListed(p: RemotePolicy, toolName: string, now = Date.now()): boolean {
  if (!p.enabled) return false;
  if (p.tools && !p.tools.includes(toolName)) return false;
  const c = Object.prototype.hasOwnProperty.call(REMOTE_TOOL_CLASS, toolName) ? REMOTE_TOOL_CLASS[toolName] : undefined;
  if (!c) return false;
  const tiers = typeof c === 'string' ? [c] : Object.values(c);
  return tiers.some((t) => tierAllowed(p, t, toolName, now));
}

export function remoteFileAllowed(p: RemotePolicy, fileKey: unknown): boolean {
  return p.enabled && isRemoteFileKey(fileKey) && p.files.includes(fileKey);
}

// Normalise whatever is on disk into a policy; anything odd falls back to the safe value.
export function parseRemotePolicy(raw: unknown): RemotePolicy {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_REMOTE_POLICY, files: [] };
  const r = raw as Record<string, unknown>;
  const files = Array.isArray(r.files) ? [...new Set(r.files.filter(isRemoteFileKey))] : [];
  const p: RemotePolicy = {
    enabled: r.enabled === true,
    mode: r.mode === 'write' ? 'write' : 'read',
    files,
  };
  if (p.mode === 'write' && typeof r.writeUntil === 'number' && Number.isFinite(r.writeUntil)) p.writeUntil = r.writeUntil;
  if (Array.isArray(r.tools)) p.tools = [...new Set(r.tools.filter((t): t is string => typeof t === 'string' && t.length > 0 && t.length < 64))];
  return p;
}

// <GRIP_HOME>/remote.json, 0600, re-read when its mtime/size changes (the CLI is another
// process). Written atomically.
export class RemotePolicyStore {
  readonly dir: string;
  private cache: RemotePolicy = { ...DEFAULT_REMOTE_POLICY, files: [] };
  private cacheKey = '';

  constructor(dir?: string) { this.dir = dir ?? liveIdentity().home; }

  get path(): string { return join(this.dir, 'remote.json'); }

  read(): RemotePolicy {
    try {
      const st = statSync(this.path);
      const key = `${st.mtimeMs}:${st.size}`;
      if (key !== this.cacheKey) {
        this.cache = parseRemotePolicy(JSON.parse(readFileSync(this.path, 'utf8')));
        this.cacheKey = key;
      }
    } catch {
      this.cache = { ...DEFAULT_REMOTE_POLICY, files: [] };
      this.cacheKey = '';
    }
    return { ...this.cache, files: [...this.cache.files], ...(this.cache.tools ? { tools: [...this.cache.tools] } : {}) };
  }

  write(p: RemotePolicy): void {
    const clean = parseRemotePolicy(p);
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(clean, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, this.path);
    try { chmodSync(this.path, 0o600); } catch { /* non-fatal (Windows) */ }
    this.cacheKey = '';
  }
}

let defaultStore: RemotePolicyStore | null = null;
// The daemon's store (GRIP_HOME read once, like the pairing store).
export function remotePolicyStore(): RemotePolicyStore {
  if (!defaultStore || defaultStore.dir !== liveIdentity().home) defaultStore = new RemotePolicyStore();
  return defaultStore;
}
