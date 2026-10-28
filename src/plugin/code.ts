// Grip plugin main thread.
//
// All Figma Plugin API access happens here. The UI iframe owns the
// WebSocket; we communicate with it via figma.ui.postMessage and
// figma.ui.onmessage. Inbound messages from the UI are either tool
// requests (with id+method+params) which we answer, or control
// messages (e.g. status updates the UI wants us to ack).

figma.showUI(__html__, { width: 120, height: 32 });

type ToolMethod =
  | 'get_document'
  | 'get_page_context'
  | 'get_page'
  | 'get_node'
  | 'get_nodes'
  | 'get_selection'
  | 'get_styles'
  | 'get_variables'
  | 'get_components'
  | 'search_nodes'
  | 'export_node'
  | 'set_node_property'
  | 'create_node'
  | 'delete_node'
  | 'set_variable_value'
  | 'set_style'
  | 'set_selection'
  | 'scroll_to'
  | 'clone_node'
  | 'move_node'
  | 'group_nodes'
  | 'ungroup_node'
  | 'create_page'
  | 'set_current_page'
  | 'delete_page'
  | 'get_plugin_data'
  | 'set_plugin_data'
  | 'detach_instance'
  | 'swap_instance'
  | 'create_component_from_node'
  | 'apply_style'
  | 'bind_property_to_variable'
  | 'upload_image'
  | 'set_text_range_property'
  | 'create_variable_collection'
  | 'delete_variable_collection'
  | 'create_variable'
  | 'delete_variable'
  | 'add_variable_mode'
  | 'remove_variable_mode'
  | 'rename_variable_mode'
  | 'set_variable_meta'
  | 'combine_as_variants'
  | 'bind_paint_to_variable'
  // tier 1
  | 'flatten_nodes'
  | 'boolean_operation'
  | 'create_node_from_svg'
  | 'notify'
  | 'list_fonts'
  | 'load_font'
  | 'set_reactions'
  | 'get_styled_text_segments'
  // tier 2
  | 'create_section'
  | 'add_dev_resource'
  | 'delete_dev_resource'
  | 'get_dev_resources'
  | 'import_component_by_key'
  | 'import_style_by_key'
  | 'import_variable_by_key'
  | 'create_image_from_url'
  | 'set_viewport'
  | 'commit_undo'
  | 'save_version'
  | 'set_annotation'
  | 'get_annotations'
  // tier 3
  | 'create_sticky'
  | 'create_connector'
  | 'create_shape_with_text'
  | 'create_table'
  | 'set_vector_network'
  | 'set_shared_plugin_data'
  | 'get_shared_plugin_data'
  | 'get_selection_colors'
  | 'set_file_thumbnail'
  | 'get_deep_link'
  // tier 4 (proposed)
  | 'add_component_property'
  | 'edit_component_property'
  | 'delete_component_property'
  | 'reset_instance_overrides'
  | 'find_with_criteria'
  | 'get_style_consumers'
  | 'trigger_undo'
  | 'open_external_url'
  | 'client_storage_get'
  | 'client_storage_set'
  | 'client_storage_delete'
  | 'client_storage_keys'
  // tier 5 (previously skipped)
  | 'create_slice'
  | 'create_text_path'
  | 'create_gif'
  | 'create_video'
  | 'create_link_preview'
  | 'create_page_divider'
  | 'create_slide'
  | 'create_slide_row'
  | 'create_code_block'
  | 'timer_start'
  | 'timer_stop'
  | 'timer_pause'
  | 'timer_resume'
  | 'get_active_users'
  | 'get_current_user'
  // tier 6
  | 'bind_effect_to_variable'
  | 'bind_layout_grid_to_variable'
  | 'set_explicit_variable_mode'
  | 'clear_explicit_variable_mode'
  | 'get_instances'
  | 'import_component_set_by_key'
  | 'outline_stroke'
  | 'rescale'
  | 'lock_aspect_ratio'
  | 'unlock_aspect_ratio'
  | 'edit_dev_resource'
  | 'add_measurement'
  | 'edit_measurement'
  | 'delete_measurement'
  | 'get_measurements'
  | 'get_measurements_for_node'
  | 'add_annotation_category'
  | 'get_annotation_categories'
  | 'get_annotation_category'
  | 'table_insert_row'
  | 'table_insert_column'
  | 'table_remove_row'
  | 'table_remove_column'
  | 'table_move_row'
  | 'table_move_column'
  | 'table_cell_at'
  | 'slides_get_canvas_grid'
  | 'slides_set_canvas_grid'
  | 'slides_create_canvas_row'
  | 'slides_move_nodes_to_coord'
  | 'set_slide_transition'
  | 'get_slide_transition'
  | 'ui_show'
  | 'ui_hide'
  | 'ui_resize'
  | 'ui_reposition'
  | 'set_relaunch_data'
  | 'get_relaunch_data'
  | 'get_top_level_frame'
  | 'get_text_content'
  | 'get_image_by_hash'
  | 'get_stamp_author'
  | 'get_overrides'
  | 'get_publish_status'
  | 'set_text_range_bound_variable'
  | 'get_text_range_bound_variable'
  | 'insert_characters'
  | 'delete_characters'
  | 'get_attached_connectors'
  | 'set_skip_invisible_instance_children'
  | 'get_file_thumbnail_node'
  | 'load_brushes'
  // tier 7
  | 'extend_library_collection_by_key'
  | 'extend_variable_collection'
  | 'remove_variable_overrides'
  | 'list_library_variables'
  | 'request_variable_to_be_enabled'
  | 'request_variable_to_be_disabled'
  | 'table_resize_row'
  | 'table_resize_column'
  | 'create_slot'
  | 'set_grid_child_position'
  | 'reorder_grid_tracks'
  | 'list_shaders'
  | 'import_shader'
  | 'list_animation_styles'
  | 'get_animations'
  | 'apply_animation_style'
  | 'remove_animation_style'
  | 'create_custom_animation_style'
  | 'list_custom_animation_styles'
  | 'update_custom_animation_style'
  | 'move_custom_animation_style'
  | 'move_custom_animation_folder'
  | 'add_animation_entry'
  | 'remove_animation_entry'
  | 'apply_manual_keyframe_track'
  | 'remove_manual_keyframe_track'
  | 'set_timeline_duration'
  | 'spring_to_normalized'
  | 'transform_group'
  | 'get_library_usage'
  | 'map_nodes'
  | 'run_script'
  | 'set_buzz_asset_type'
  | 'get_buzz_asset_type'
  | 'move_local_style'
  | 'delete_style'
  | 'edit_annotation_category'
  | 'delete_annotation_category'
  | 'get_audit'
  | 'list_pages'
  | 'create_tree'
  | 'replace_text';

interface ToolRequest {
  kind: 'request';
  id: string;
  method: ToolMethod;
  params: any;
}

// ---------- color + paint helpers ----------

function rgbToHex(r: number, g: number, b: number): string {
  const to = (v: number) =>
    Math.round(Math.max(0, Math.min(1, v)) * 255)
      .toString(16)
      .padStart(2, '0')
      .toUpperCase();
  return `#${to(r)}${to(g)}${to(b)}`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = hex.replace('#', '');
  const full =
    m.length === 3
      ? m
          .split('')
          .map((c) => c + c)
          .join('')
      : m;
  if (full.length !== 6) throw new Error(`Invalid hex color: ${hex}`);
  const n = parseInt(full, 16);
  return {
    r: ((n >> 16) & 0xff) / 255,
    g: ((n >> 8) & 0xff) / 255,
    b: (n & 0xff) / 255,
  };
}

// ---- shared color input/output helpers (color spaces, Figma update 141) ----
// ONE entry point for "a color the agent gave us": hex (unchanged fast path),
// any CSS color string (via figma.util.rgba), {hex, opacity}, {r,g,b,a?},
// a ColorWithColorSpace ({space:'OKLCH',l,c,h} …), each optionally carrying a
// `sourceColor` (the authoring color space) that reads emit and writes accept.
interface ParsedColor { r: number; g: number; b: number; a: number; sourceColor?: any }

const PLAIN_HEX_RE = /^#?(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function utilRgba(input: any): any {
  const u: any = (figma as any).util;
  if (!u || typeof u.rgba !== 'function') {
    throw new Error('color spaces / CSS color strings need figma.util.rgba (Figma update 141+) — use a #hex or {r,g,b} instead');
  }
  try {
    return u.rgba(input);
  } catch (e: any) {
    throw new Error(`Invalid color ${typeof input === 'string' ? JSON.stringify(input) : JSON.stringify(input)}: ${e && e.message ? e.message : e}`);
  }
}

// A JSON-plain copy of a sourceColor (ColorWithColorSpace), or undefined.
function plainSource(sc: any): any {
  if (!sc || typeof sc !== 'object' || typeof sc.space !== 'string') return undefined;
  const o: any = {};
  for (const k of Object.keys(sc)) if (typeof sc[k] === 'string' || typeof sc[k] === 'number') o[k] = sc[k];
  return o;
}

function fromUtilRgba(d: any): ParsedColor {
  const out: ParsedColor = { r: d.r, g: d.g, b: d.b, a: typeof d.a === 'number' ? d.a : 1 };
  const sc = plainSource(d.sourceColor);
  if (sc) out.sourceColor = sc;
  return out;
}

function cssToParsed(s: string): ParsedColor {
  const str = s.trim();
  // Plain #hex / hex stays on the exact legacy path (byte-for-byte unchanged).
  if (PLAIN_HEX_RE.test(str)) return { ...hexToRgb(str), a: 1 };
  return fromUtilRgba(utilRgba(str));
}

// Attach an explicit sourceColor to a base color. The sourceColor wins (full
// precision) only if it still matches the base color to 8 bits; if the agent
// edited hex/rgb on a read-back color the stale sourceColor is dropped.
function reconcileSource(base: ParsedColor, src: any): ParsedColor {
  const sc = plainSource(src);
  if (!sc) return base;
  let d: any;
  try {
    d = utilRgba(sc);
  } catch {
    return base;
  }
  if (rgbToHex(d.r, d.g, d.b) !== rgbToHex(base.r, base.g, base.b)) return base;
  return { r: d.r, g: d.g, b: d.b, a: base.a, sourceColor: sc };
}

function resolveColor(v: any): ParsedColor {
  if (typeof v === 'string') return cssToParsed(v);
  if (v && typeof v === 'object') {
    if (typeof v.hex === 'string') {
      const base = cssToParsed(v.hex);
      if (typeof v.opacity === 'number') base.a = v.opacity;
      return v.sourceColor !== undefined ? reconcileSource(base, v.sourceColor) : base;
    }
    if (typeof v.space === 'string' && !('sourceColor' in v)) return fromUtilRgba(utilRgba(v));
    if (typeof v.r === 'number' && typeof v.g === 'number' && typeof v.b === 'number') {
      const base: ParsedColor = { r: v.r, g: v.g, b: v.b, a: v.a ?? v.opacity ?? 1 };
      return v.sourceColor !== undefined ? reconcileSource(base, v.sourceColor) : base;
    }
    if (v.sourceColor !== undefined) {
      const d = fromUtilRgba(utilRgba(plainSource(v.sourceColor) ?? v.sourceColor));
      if (typeof v.opacity === 'number') d.a = v.opacity;
      else if (typeof v.a === 'number') d.a = v.a;
      return d;
    }
  }
  throw new Error('color expects a #hex or CSS color string, {hex, opacity}, {r,g,b,a?}, {space,...} or {sourceColor}');
}

// Merge a separate sourceColor field into a color input (string | object).
function withSource(colorIn: any, sourceColor: any): any {
  if (sourceColor === undefined) return colorIn;
  if (typeof colorIn === 'string') return { hex: colorIn, sourceColor };
  if (colorIn && typeof colorIn === 'object' && colorIn.sourceColor === undefined) return { ...colorIn, sourceColor };
  return colorIn;
}

// RGB(A) color object (what Figma wants for paint/stop/effect colors).
function colorObj(c: ParsedColor, withAlpha: boolean): any {
  const o: any = withAlpha ? { r: c.r, g: c.g, b: c.b, a: c.a } : { r: c.r, g: c.g, b: c.b };
  if (c.sourceColor) o.sourceColor = c.sourceColor;
  return o;
}

function serializePaint(paint: Paint): any {
  const base: any = {
    type: paint.type,
    visible: paint.visible !== false,
    opacity: paint.opacity ?? 1,
    blendMode: (paint as any).blendMode,
  };
  if (paint.type === 'SOLID') {
    base.hex = rgbToHex(paint.color.r, paint.color.g, paint.color.b);
    const psc = plainSource((paint.color as any).sourceColor);
    if (psc) base.sourceColor = psc;
    if ((paint as SolidPaint).boundVariables?.color) {
      base.boundVariable = (paint as any).boundVariables.color;
    }
  } else if (paint.type.startsWith('GRADIENT_')) {
    const g = paint as GradientPaint;
    base.stops = g.gradientStops.map((s) => {
      const stop: any = {
        position: s.position,
        hex: rgbToHex(s.color.r, s.color.g, s.color.b),
        opacity: s.color.a ?? 1,
      };
      const ssc = plainSource((s.color as any).sourceColor);
      if (ssc) stop.sourceColor = ssc;
      return stop;
    });
    base.transform = g.gradientTransform;
  } else if (paint.type === 'IMAGE') {
    const ip = paint as ImagePaint;
    base.imageHash = ip.imageHash;
    base.scaleMode = ip.scaleMode;
    if (ip.imageTransform) base.imageTransform = ip.imageTransform;
    if (ip.scalingFactor !== undefined) base.scalingFactor = ip.scalingFactor;
    if (ip.rotation !== undefined) base.rotation = ip.rotation;
    if (ip.filters) base.filters = ip.filters;
  } else {
    // Newer paint variants (SHADER, VIDEO, …) — copy remaining keys generically
    // so reads aren't lossy, reusing the effect value-walker (handles color →
    // {hex,opacity}, vectors, variable aliases, nested arrays/objects).
    for (const key of Object.keys(paint)) {
      if (key in base) continue;
      base[key] = serializeEffectValue((paint as any)[key]);
    }
  }
  return base;
}

function serializeEffect(effect: Effect): any {
  // Generic walker — covers every Effect variant Figma has today and
  // future ones without code churn:
  //   DropShadowEffect, InnerShadowEffect,
  //   BlurEffect (NORMAL | PROGRESSIVE — startRadius/startOffset/endOffset),
  //   NoiseEffect (Monotone/Duotone/Multitone),
  //   TextureEffect, GlassEffect, ShaderEffect.
  // Color objects → {hex, opacity}; Vector → {x, y}; nested arrays/objects
  // serialized recursively. boundVariables kept as ids.
  const out: any = {};
  for (const key of Object.keys(effect)) {
    const v = (effect as any)[key];
    out[key] = serializeEffectValue(v);
  }
  // Always carry these even if effect omitted (older variants without
  // explicit visible/blurType still get sane defaults out).
  if (!('visible' in out)) out.visible = true;
  return out;
}

function serializeEffectValue(v: any): any {
  if (v == null) return v;
  if (typeof v !== 'object') return v;
  // RGBA color → hex + opacity
  if (typeof v.r === 'number' && typeof v.g === 'number' && typeof v.b === 'number') {
    const col: any = { hex: rgbToHex(v.r, v.g, v.b), opacity: typeof v.a === 'number' ? v.a : 1 };
    const csc = plainSource(v.sourceColor);
    if (csc) col.sourceColor = csc;
    return col;
  }
  // Vector
  if (typeof v.x === 'number' && typeof v.y === 'number' && Object.keys(v).length === 2) {
    return { x: v.x, y: v.y };
  }
  // Variable alias
  if (v.type === 'VARIABLE_ALIAS' && typeof v.id === 'string') {
    return { variableId: v.id, type: 'VARIABLE_ALIAS' };
  }
  // Array
  if (Array.isArray(v)) return v.map(serializeEffectValue);
  // Generic object (boundVariables, gradient stops, shader uniforms, etc.)
  const out: any = {};
  for (const k of Object.keys(v)) out[k] = serializeEffectValue(v[k]);
  return out;
}

// Project an arbitrary host object (e.g. a Shader) to plain JSON-safe data,
// dropping functions so the postMessage structured-clone can't throw.
function plainData(v: any): any {
  if (v == null || typeof v === 'function') return undefined;
  if (typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(plainData).filter((x) => x !== undefined);
  const o: any = {};
  for (const k of Object.keys(v)) {
    const pv = plainData(v[k]);
    if (pv !== undefined) o[k] = pv;
  }
  return o;
}

// Custom animation styles (Motion): BaseStyleMixin fields + animationEntries.
function serializeCustomAnimationStyle(s: any): any {
  return {
    id: s.id,
    key: s.key,
    name: s.name,
    description: s.description,
    type: s.type,
    remote: !!s.remote,
    animationEntries: plainData(s.animationEntries) ?? [],
  };
}
async function getCustomAnimationStyle(id: any): Promise<any> {
  if (typeof id !== 'string' || !id) throw new Error("'styleId' (a custom animation style id) is required");
  const s: any = await figma.getStyleByIdAsync(id);
  if (!s) throw new Error(`Style not found: ${id}`);
  if (s.type !== 'CUSTOM_ANIMATION') throw new Error(`Style ${id} is ${s.type}, not a CUSTOM_ANIMATION style`);
  return s;
}

// Paginated library-usage scans. A scan walks the tree ONCE (cached here as
// node refs), then each get_library_usage call resolves the next batch of
// instances → components, advancing a cursor until every node is covered — so
// the union across pages is COMPLETE (never a silently-capped partial). Keyed
// by an opaque cursor id; pruned when finished or when too many pile up.
interface LibScan { nodes: BaseNode[]; i: number; scope: string; styleSeen: Set<string>; startedAt: number; }
const _libScans = new Map<string, LibScan>();
let _libScanSeq = 0;

// Inverse of serializeEffectValue — accept the shapes our reads emit so a
// read → edit → write round-trip works. Converts {hex,opacity} back to an
// RGBA color and {variableId,type:'VARIABLE_ALIAS'} back to Figma's alias
// shape; passes everything else (incl. {x,y} vectors) through, recursing
// arrays/objects. Assigned shapes like set_node_property effects flow through
// this so agents can write back exactly what get_node returned.
function rehydrateValue(v: any): any {
  if (v == null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(rehydrateValue);
  // {hex, opacity} → RGBA (only when it isn't already an {r,g,b} color).
  // hex may also be any CSS color string; an optional sourceColor rides along.
  if (typeof v.hex === 'string' && !('r' in v)) {
    return colorObj(resolveColor(v), true);
  }
  // {sourceColor, opacity?} with no hex → derive RGBA from the color space.
  if (v.sourceColor !== undefined && typeof v.hex !== 'string' && !('r' in v)) {
    return colorObj(resolveColor(v), true);
  }
  // Our serialized alias shape → Figma's alias shape.
  if (v.type === 'VARIABLE_ALIAS' && typeof v.variableId === 'string' && !('id' in v)) {
    return { type: 'VARIABLE_ALIAS', id: v.variableId };
  }
  const out: any = {};
  for (const k of Object.keys(v)) {
    const x = v[k];
    // A color given as a CSS string / {space,...} under a color key (effect
    // color, duotone secondaryColor, …) → RGBA (+ sourceColor).
    if (
      (k === 'color' || k === 'secondaryColor') &&
      x &&
      (typeof x === 'string' || (typeof x === 'object' && typeof x.space === 'string'))
    ) {
      try {
        out[k] = colorObj(resolveColor(x), true);
        continue;
      } catch (e) {
        if (typeof x === 'object') throw e;
      }
    }
    out[k] = rehydrateValue(x);
  }
  return out;
}

function hasFills(node: BaseNode): node is BaseNode & MinimalFillsMixin {
  return 'fills' in node;
}
function hasStrokes(node: BaseNode): node is BaseNode & MinimalStrokesMixin {
  return 'strokes' in node;
}
function hasChildren(node: BaseNode): node is BaseNode & ChildrenMixin {
  return 'children' in node;
}

interface SerializeOpts {
  depth: number;
  maxDepth: number;
  includeChildren?: boolean;
  includePluginData?: boolean;
  pluginDataKeys?: string[];   // when set, only emit these keys
  includeBoundVariables?: boolean;
  properties?: Set<string>;    // when set, only emit these top-level fields
  includeParent?: boolean;     // emit parent stub
  // At the depth limit, omit the next layer so depth N is exactly N levels;
  // the cut node carries childCount + truncated instead. true → list that
  // layer as {id,name,type,childCount} stubs. (A spent node budget always
  // collapses to stubs.)
  stubs?: boolean;
  // Shared mutable node budget. Bounds total nodes walked so a huge
  // selection can't produce a multi-minute / multi-MB serialize that
  // blows the caller's stall watchdog. When exhausted, deeper children
  // collapse to stubs and the node carries `truncated: true`.
  budget?: { remaining: number };
}

// Default ceilings for node-level reads when the caller doesn't override.
// Generous enough for real components, bounded enough to return fast.
const DEFAULT_READ_DEPTH = 12;
const DEFAULT_READ_NODE_BUDGET = 3000;

function maybe(out: any, opts: SerializeOpts, key: string, val: () => any) {
  if (opts.properties && !opts.properties.has(key)) return;
  const v = val();
  if (v !== undefined) out[key] = v;
}

function serializeBoundVariables(node: any): Record<string, unknown> | undefined {
  const bv = node.boundVariables;
  if (!bv || typeof bv !== 'object') return undefined;
  const out: Record<string, unknown> = {};
  for (const [prop, alias] of Object.entries(bv)) {
    if (!alias) continue;
    if (Array.isArray(alias)) {
      out[prop] = alias.map((a: any) => ({ variableId: a?.id, type: a?.type }));
    } else {
      out[prop] = { variableId: (alias as any).id, type: (alias as any).type };
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function serializePluginData(node: BaseNode, keys?: string[]): Record<string, string> | undefined {
  const pluginKeys = keys && keys.length ? keys : node.getPluginDataKeys?.() ?? [];
  if (!pluginKeys.length) return undefined;
  const out: Record<string, string> = {};
  for (const k of pluginKeys) {
    const v = node.getPluginData(k);
    if (v) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

async function serializeNode(
  node: BaseNode,
  optsOrDepth: SerializeOpts | number,
  maxDepth?: number,
  includeChildren?: boolean,
): Promise<any> {
  // Back-compat with the old positional signature.
  const opts: SerializeOpts =
    typeof optsOrDepth === 'number'
      ? { depth: optsOrDepth, maxDepth: maxDepth ?? Number.POSITIVE_INFINITY, includeChildren: includeChildren !== false }
      : optsOrDepth;
  const wantAll = !opts.properties;
  const want = (k: string) => wantAll || opts.properties!.has(k);

  const out: any = {
    id: node.id,
    name: node.name,
    type: node.type,
  };
  const sn = node as any;

  // Identity / parent
  if (opts.includeParent && node.parent) {
    out.parent = { id: node.parent.id, name: node.parent.name, type: node.parent.type };
  }

  // Geometry
  if (want('visible') && 'visible' in node) out.visible = sn.visible;
  if (want('locked') && 'locked' in node) out.locked = sn.locked;
  if (want('x') && 'x' in node) out.x = sn.x;
  if (want('y') && 'y' in node) out.y = sn.y;
  if (want('width') && 'width' in node) out.width = sn.width;
  if (want('height') && 'height' in node) out.height = sn.height;
  if (want('rotation') && 'rotation' in node) out.rotation = sn.rotation;
  if (want('opacity') && 'opacity' in node) out.opacity = sn.opacity;
  if (want('blendMode') && 'blendMode' in node) out.blendMode = sn.blendMode;
  if (want('isMask') && 'isMask' in node) out.isMask = sn.isMask;
  if (want('clipsContent') && 'clipsContent' in node) out.clipsContent = sn.clipsContent;
  if (want('constraints') && 'constraints' in node) out.constraints = sn.constraints;
  if (want('relativeTransform') && 'relativeTransform' in node) out.relativeTransform = sn.relativeTransform;
  if (want('absoluteBoundingBox') && 'absoluteBoundingBox' in node) out.absoluteBoundingBox = sn.absoluteBoundingBox;
  if (want('targetAspectRatio') && 'targetAspectRatio' in node && sn.targetAspectRatio) out.targetAspectRatio = sn.targetAspectRatio;

  // Fills / strokes / effects
  if (want('fills')) {
    if (hasFills(node)) {
      const fills = node.fills;
      out.fills = fills === figma.mixed ? 'mixed' : fills.map(serializePaint);
    } else {
      out.fills = [];
    }
  }
  if (want('strokes') && hasStrokes(node)) {
    out.strokes = node.strokes.map(serializePaint);
  } else if (want('strokes')) {
    out.strokes = [];
  }
  if (want('strokeWeight') && 'strokeWeight' in node && sn.strokeWeight !== figma.mixed) {
    out.strokeWeight = sn.strokeWeight;
  }
  for (const k of ['strokeAlign', 'strokeJoin', 'strokeCap', 'strokeMiterLimit', 'dashPattern', 'strokeTopWeight', 'strokeRightWeight', 'strokeBottomWeight', 'strokeLeftWeight', 'complexStrokeProperties', 'variableWidthStrokeProperties']) {
    if (want(k) && k in node) {
      const v = sn[k];
      if (v !== undefined && v !== figma.mixed) out[k] = v;
    }
  }
  if (want('effects') && 'effects' in node) {
    out.effects = sn.effects.map(serializeEffect);
  }

  // Corner radii
  if (want('cornerRadius') && 'cornerRadius' in node) {
    const cr = sn.cornerRadius;
    if (cr !== figma.mixed) out.cornerRadius = cr;
  }
  for (const k of ['topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius', 'cornerSmoothing']) {
    if (want(k) && k in node) out[k] = sn[k];
  }

  // Auto-layout / sizing
  if ('layoutMode' in node) {
    const f = sn as FrameNode;
    if (want('layoutMode')) out.layoutMode = f.layoutMode;
    for (const k of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'itemSpacing', 'counterAxisSpacing', 'primaryAxisSizingMode', 'counterAxisSizingMode', 'primaryAxisAlignItems', 'counterAxisAlignItems', 'layoutWrap', 'itemReverseZIndex', 'strokesIncludedInLayout']) {
      if (want(k) && k in f) out[k] = (f as any)[k];
    }
    // CSS-grid auto-layout container props (layoutMode 'GRID').
    for (const k of ['gridRowCount', 'gridColumnCount', 'gridRowGap', 'gridColumnGap', 'gridColumnSizes', 'gridRowSizes', 'gridAutoTracks', 'gridItemsPositioning']) {
      if (want(k) && k in f) out[k] = (f as any)[k];
    }
  }
  for (const k of ['layoutAlign', 'layoutGrow', 'layoutPositioning', 'layoutSizingHorizontal', 'layoutSizingVertical', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight']) {
    if (want(k) && k in node) out[k] = sn[k];
  }
  // Grid-child placement props (present on children of a GRID frame).
  for (const k of ['gridRowSpan', 'gridColumnSpan', 'gridRowAnchorIndex', 'gridColumnAnchorIndex', 'gridChildHorizontalAlign', 'gridChildVerticalAlign']) {
    if (want(k) && k in node) out[k] = sn[k];
  }
  if (want('layoutGrids') && 'layoutGrids' in node) out.layoutGrids = sn.layoutGrids;

  // TEXT
  if (node.type === 'TEXT') {
    const t = node as TextNode;
    if (want('characters')) out.characters = t.characters;
    if (want('fontSize') && t.fontSize !== figma.mixed) out.fontSize = t.fontSize;
    if (want('fontName') && t.fontName !== figma.mixed) {
      out.fontFamily = (t.fontName as FontName).family;
      out.fontWeight = (t.fontName as FontName).style;
      out.fontName = t.fontName;
    }
    if (want('textAlignHorizontal') && t.textAlignHorizontal) out.textAlignHorizontal = t.textAlignHorizontal;
    if (want('textAlignVertical') && t.textAlignVertical) out.textAlignVertical = t.textAlignVertical;
    if (want('textAutoResize')) out.textAutoResize = t.textAutoResize;
    if (want('textCase') && t.textCase !== figma.mixed) out.textCase = t.textCase;
    // Figma update 134. Omitted when mixed across ranges (read per-range with
    // get_styled_text_segments fields:['textWrapStyle']) or on older clients.
    if (want('textWrapStyle') && (t as any).textWrapStyle !== undefined && (t as any).textWrapStyle !== figma.mixed) out.textWrapStyle = (t as any).textWrapStyle;
    if (want('textDecoration') && t.textDecoration !== figma.mixed) out.textDecoration = t.textDecoration;
    if (want('lineHeight') && t.lineHeight !== figma.mixed) out.lineHeight = t.lineHeight;
    if (want('letterSpacing') && t.letterSpacing !== figma.mixed) out.letterSpacing = t.letterSpacing;
    if (want('paragraphSpacing')) out.paragraphSpacing = t.paragraphSpacing;
    if (want('paragraphIndent')) out.paragraphIndent = t.paragraphIndent;
    if (want('hyperlink') && t.hyperlink !== figma.mixed) out.hyperlink = t.hyperlink;
    if (want('listOptions') && (t as any).listOptions !== figma.mixed) out.listOptions = (t as any).listOptions;
  }

  // INSTANCE / COMPONENT / COMPONENT_SET
  if (node.type === 'INSTANCE') {
    const inst = node as InstanceNode;
    // getMainComponentAsync is expensive per node — only resolve it when the
    // caller actually wants componentId/componentName (so a lean `properties`
    // whitelist skips the cost entirely across a big instance tree).
    if (want('componentId') || want('componentName')) {
      const main = await inst.getMainComponentAsync();
      if (want('componentId')) out.componentId = main?.id;
      if (want('componentName')) out.componentName = main?.name;
    }
    // The resolved variant selection (e.g. {Type:'Multi select', Selected:'Off'}).
    // Previously not serialized at all — agents had to hand-roll it in run_script.
    if (want('variantProperties')) out.variantProperties = inst.variantProperties ?? null;
    if (want('componentProperties')) out.componentProperties = inst.componentProperties;
    if (want('overrides')) out.overrides = inst.overrides;
    if (want('exposedInstances')) out.exposedInstances = inst.exposedInstances?.map((x) => ({ id: x.id, name: x.name }));
    if (want('isExposedInstance')) out.isExposedInstance = inst.isExposedInstance;
  }
  // A SLOT's current contents vs the limits set on its SLOT property's slotSettings.
  if (node.type === 'SLOT') {
    maybe(out, opts, 'limitViolations', () => {
      try { return Array.from((node as any).limitViolations ?? []); } catch { return undefined; }
    });
  }
  // Page dividers are PAGE nodes whose name is all '*' / '–' / '—' / spaces.
  if (node.type === 'PAGE') {
    maybe(out, opts, 'isPageDivider', () => (node as PageNode).isPageDivider === true);
  }
  if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
    const c = node as ComponentNode | ComponentSetNode;
    if (want('key')) out.key = c.key;
    if (want('description')) out.description = c.description;
    if (want('documentationLinks')) out.documentationLinks = c.documentationLinks;
    if (want('componentPropertyDefinitions')) {
      try { out.componentPropertyDefinitions = (c as any).componentPropertyDefinitions; } catch {}
    }
  }

  // Style binding ids
  for (const k of ['fillStyleId', 'strokeStyleId', 'effectStyleId', 'gridStyleId']) {
    if (want(k) && k in node) {
      const v = sn[k];
      if (v && v !== figma.mixed) out[k] = v;
    }
  }
  if (want('textStyleId') && node.type === 'TEXT') {
    const tsid = (node as TextNode).textStyleId;
    if (tsid && tsid !== figma.mixed) out.textStyleId = tsid;
  }

  // Bound variables
  if (opts.includeBoundVariables) {
    const bv = serializeBoundVariables(node);
    if (bv) out.boundVariables = bv;
  }

  // Export settings
  if (want('exportSettings') && 'exportSettings' in node) {
    out.exportSettings = sn.exportSettings;
  }

  // Plugin data
  if (opts.includePluginData) {
    const pd = serializePluginData(node, opts.pluginDataKeys);
    if (pd) out.pluginData = pd;
  }

  // Children
  if (hasChildren(node) && (opts.includeChildren !== false)) {
    const kids = node.children;
    const stub = (c: BaseNode) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      childCount: hasChildren(c) ? c.children.length : 0,
    });
    // Collapse to stubs at max depth OR when the node budget is spent.
    const budgetSpent = !!opts.budget && opts.budget.remaining <= 0;
    if (opts.depth >= opts.maxDepth || budgetSpent) {
      if (opts.stubs !== true && !budgetSpent) out.childCount = kids.length;
      else out.children = kids.map(stub);
      if (kids.length) out.truncated = true;
    } else {
      const childOpts: SerializeOpts = { ...opts, depth: opts.depth + 1, includeParent: false };
      const out2: any[] = [];
      for (const c of kids) {
        if (opts.budget) {
          if (opts.budget.remaining <= 0) { out2.push(stub(c)); out.truncated = true; continue; }
          opts.budget.remaining -= 1;
        }
        out2.push(await serializeNode(c, childOpts));
      }
      out.children = out2;
    }
  }

  return out;
}

// ---------- tool handlers ----------

// Figma's getNodeByIdAsync HANGS (never resolves) on a removed/invalid id
// instead of returning null — a single bad id would otherwise eat the whole
// request budget. Race a bounded timeout so it fast-fails with a typed,
// actionable node_not_found. Every handler resolves ids through here, so all
// of them (get_node, get_nodes, delete_node, set_node_property, …) get it.
const GETNODE_TIMEOUT_MS = 8000;
async function getNode(id: string): Promise<BaseNode> {
  let timer: ReturnType<typeof setTimeout>;
  const raced = await Promise.race([
    figma.getNodeByIdAsync(id).then((n) => ({ n }) as { n: BaseNode | null }),
    new Promise<{ timedOut: true }>((r) => { timer = setTimeout(() => r({ timedOut: true }), GETNODE_TIMEOUT_MS); }),
  ]);
  clearTimeout(timer!);
  if ('timedOut' in raced) {
    throw new Error(
      `node_not_found: '${id}' did not resolve in ${GETNODE_TIMEOUT_MS / 1000}s — almost certainly removed or invalid ` +
        `(Figma's getNodeByIdAsync hangs on removed ids instead of returning null). If the node IS valid, its page may be ` +
        `unloaded/heavy — make that page current with set_current_page first, then retry.`,
    );
  }
  if (!raced.n) throw new Error(`Node not found: ${id}`);
  return raced.n;
}

// ---------- gentle bulk-iteration helpers ----------
// The plugin is single-threaded; a synchronous loop over a big node set freezes
// Figma until the tab reloads. These helpers own the loop so the caller (a
// run_script body, or the map_nodes tool) can't write the freezer: they resolve
// a node set via the FAST typed findAllWithCriteria and iterate in chunks that
// yield the thread between batches. Injected into run_script and reused server-
// side.

// Let the single thread breathe (process the event loop) between chunks.
//
// SELF-PACING: a real macrotask yield (setTimeout) is the only way to return to
// Figma's event loop, but in a BACKGROUNDED plugin (the agent case — Figma not
// focused) the browser throttles setTimeout to ~1s. So a per-iteration
// `await yieldNow()` — the pattern the docs recommend — turned a 200ms walk into
// a >10s timeout (one ~1s yield per iteration). Fix: only pay the real yield
// when enough REAL work has elapsed since the last one (default ~500ms); every
// other call is a near-free microtask. Bounded work finishes with zero real
// yields; long work breathes ~twice a second. `resetYieldClock()` is called at
// the start of each run_script so the first stretch of work isn't charged a yield.
let _lastRealYieldAt = 0;
const YIELD_MIN_INTERVAL_MS = 500;
function resetYieldClock(): void { _lastRealYieldAt = Date.now(); }
function yieldNow(): Promise<void> {
  const now = Date.now();
  if (now - _lastRealYieldAt < YIELD_MIN_INTERVAL_MS) return Promise.resolve();
  _lastRealYieldAt = now;
  return new Promise((r) => setTimeout(() => { _lastRealYieldAt = Date.now(); r(); }, 0));
}

interface NodeQuery {
  types?: string | string[];
  name?: string;
  nameFlags?: string;
  scope?: string;   // nodeId to search within (bounded subtree)
  page?: string;    // pageId to search (defaults to current page)
}

// Resolve a query to a node array WITHOUT an unbounded page walk. Requires
// `types` (→ findAllWithCriteria, fast + typed) or a `scope` node (bounded
// subtree); refuses a bare page-wide findAll — that's the freeze we're avoiding.
async function findNodes(q: NodeQuery): Promise<SceneNode[]> {
  let root: BaseNode;
  if (q.scope) root = await getNode(q.scope);
  else if (q.page) root = await getNode(q.page);
  else root = figma.currentPage;
  const types = q.types ? (Array.isArray(q.types) ? q.types : [q.types]) : undefined;
  let nodes: SceneNode[];
  if (types) {
    nodes = (root as any).findAllWithCriteria({ types }) as SceneNode[];
  } else if (q.scope) {
    nodes = (root as any).findAll(() => true) as SceneNode[];  // bounded to the given subtree
  } else {
    throw new Error(
      "findNodes needs `types` (uses fast findAllWithCriteria) or a `scope` nodeId — a bare page-wide walk would block Figma's single thread. Add types:['FRAME',...] or scope:<nodeId>.",
    );
  }
  if (q.name) {
    const re = new RegExp(q.name, q.nameFlags ?? 'i');
    nodes = nodes.filter((n) => re.test(n.name));
  }
  return nodes;
}

// Iterate a node array (or query) in yielding chunks. fn may be async. Bounded
// by opts.budget; yields every opts.chunk items so the thread never freezes.
async function forEachNode(
  itemsOrQuery: SceneNode[] | NodeQuery,
  fn: (n: SceneNode, i: number) => unknown | Promise<unknown>,
  opts: { chunk?: number; budget?: number } = {},
): Promise<number> {
  const arr = Array.isArray(itemsOrQuery) ? itemsOrQuery : await findNodes(itemsOrQuery);
  const chunk = opts.chunk && opts.chunk > 0 ? opts.chunk : 200;
  const budget = opts.budget && opts.budget > 0 ? opts.budget : Infinity;
  let count = 0;
  for (let i = 0; i < arr.length && count < budget; i++) {
    await fn(arr[i], i);
    count++;
    if (count % chunk === 0) await yieldNow();
  }
  return count;
}

// forEachNode that collects (bounded) results.
async function mapNodes<T>(
  itemsOrQuery: SceneNode[] | NodeQuery,
  fn: (n: SceneNode, i: number) => T | Promise<T>,
  opts: { chunk?: number; budget?: number } = {},
): Promise<T[]> {
  const out: T[] = [];
  await forEachNode(itemsOrQuery, async (n, i) => { out.push(await fn(n, i)); }, opts);
  return out;
}

// Inspect a run_script body BEFORE eval and push back on patterns that freeze
// Figma's single main thread (which the bridge cannot preempt once running).
// Returns a teaching rejection message, or null to allow. The message names the
// problem AND the better tool — the point is the agent learns, not just blocks.
function inspectScript(code: string): string | null {
  if (/\bwhile\s*\(\s*(?:true|1)\s*\)/.test(code) || /\bfor\s*\(\s*;\s*;\s*\)/.test(code)) {
    return (
      "an unbounded loop (while(true)/for(;;)) runs synchronously on Figma's single main thread and freezes the whole window until the tab is reloaded — the bridge cannot interrupt it. " +
      'Give the loop a hard bound and `await yieldNow()` each iteration, or (better) do bulk node work with the injected `await forEachNode(findNodes({types:[...]}), n => {...})`, which walks in yielding chunks.'
    );
  }
  if (/figma\.(?:currentPage|root)\.findAll\s*\(/.test(code)) {
    return (
      'figma.currentPage/root.findAll(...) walks EVERY node in one synchronous, unbounded pass — on a large file that blocks the main thread and wedges Figma. ' +
      "Use the injected `findNodes({types:[...], scope, name})` (backed by findAllWithCriteria — typed and far faster), or `await forEachNode({types:[...]}, fn)` to iterate in yielding chunks. Pass a `scope` nodeId to bound the search to a subtree."
    );
  }
  return null;
}

async function handle(method: ToolMethod, params: any, reqId?: string): Promise<any> {
  switch (method) {
    case 'get_document': {
      await figma.loadAllPagesAsync();
      return {
        name: figma.root.name,
        id: figma.root.id,
        currentPageId: figma.currentPage.id,
        pages: figma.root.children.map((p) => ({
          id: p.id,
          name: p.name,
          isPageDivider: p.isPageDivider === true,
          nodeCount: countNodes(p),
        })),
      };
    }
    case 'get_page_context': {
      // Cheap ground-truth probe: which file/page is this plugin session on,
      // and how much is selected. Lets an agent distinguish "empty here" from
      // "wrong page" before trusting an empty get_selection/search result.
      return {
        file: { key: figma.fileKey ?? figma.root.id, name: figma.root.name },
        page: { id: figma.currentPage.id, name: figma.currentPage.name },
        selectionCount: figma.currentPage.selection.length,
      };
    }
    case 'get_page': {
      const depth = clampDepth(params.depth);
      let page: PageNode = figma.currentPage;
      if (params.pageId) {
        const n = await getNode(params.pageId);
        if (n.type !== 'PAGE') throw new Error(`Not a page: ${params.pageId}`);
        page = n as PageNode;
      }
      await page.loadAsync();
      const opts = serializeOptsFrom(params, depth);
      const tree = await serializeNode(page, opts);
      return applyTreeFilters(tree, params);
    }
    case 'get_node': {
      const n = await getNode(params.nodeId);
      const include = params.includeChildren !== false;
      const depth = params.depth !== undefined
        ? clampDepth(params.depth)
        : (include ? DEFAULT_READ_DEPTH : 0);
      const opts = serializeOptsFrom(params, depth, { includeChildren: include, includeParent: true });
      return await serializeNode(n, opts);
    }
    case 'get_nodes': {
      const ids: string[] = asIds(params.nodeIds);
      if (!ids.length) throw new Error('get_nodes: nodeIds required');
      const include = params.includeChildren !== false;
      const depth = params.depth !== undefined
        ? clampDepth(params.depth)
        : (include ? DEFAULT_READ_DEPTH : 0);
      const opts = serializeOptsFrom(params, depth, { includeChildren: include });
      const out: any[] = [];
      for (const id of ids) {
        try {
          const n = await getNode(id);
          out.push(await serializeNode(n, opts));
        } catch (err) {
          out.push({ id, error: (err as Error).message });
        }
      }
      return out;
    }
    case 'get_selection': {
      const include = params.includeChildren !== false;
      const depth = params.depth !== undefined
        ? clampDepth(params.depth)
        : (include ? DEFAULT_READ_DEPTH : 0);
      // One shared opts (and one shared node budget) across the whole
      // selection, walked sequentially. Bounds total work so a single
      // huge selected frame can't run for minutes and trip the caller's
      // stall watchdog. Caller can pass depth:-1 / maxNodes:0 to opt out.
      const opts = serializeOptsFrom(params, depth, { includeChildren: include });
      const out: any[] = [];
      for (const n of figma.currentPage.selection) {
        out.push(await serializeNode(n, opts));
      }
      return out;
    }
    case 'get_styles': {
      const [paints, texts, effects, grids] = await Promise.all([
        figma.getLocalPaintStylesAsync(),
        figma.getLocalTextStylesAsync(),
        figma.getLocalEffectStylesAsync(),
        figma.getLocalGridStylesAsync(),
      ]);
      return {
        paint: paints.map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          type: 'PAINT',
          value: s.paints.map(serializePaint),
        })),
        text: texts.map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          type: 'TEXT',
          value: {
            fontName: s.fontName,
            fontSize: s.fontSize,
            lineHeight: s.lineHeight,
            letterSpacing: s.letterSpacing,
            textCase: s.textCase,
            textDecoration: s.textDecoration,
            textWrapStyle: (s as any).textWrapStyle,
          },
        })),
        effect: effects.map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          type: 'EFFECT',
          value: s.effects.map(serializeEffect),
        })),
        grid: grids.map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          type: 'GRID',
          value: s.layoutGrids,
        })),
      };
    }
    case 'get_variables': {
      const collections = await figma.variables.getLocalVariableCollectionsAsync();
      const allVars = await figma.variables.getLocalVariablesAsync();
      return collections.map((c) => ({
        id: c.id,
        name: c.name,
        key: c.key,
        hiddenFromPublishing: c.hiddenFromPublishing,
        defaultModeId: c.defaultModeId,
        remote: c.remote,
        modes: c.modes.map((m: any) => ({ modeId: m.modeId, name: m.name, ...(m.parentModeId ? { parentModeId: m.parentModeId } : {}) })),
        ...serializeCollectionExtension(c),
        variables: allVars
          .filter((v) => v.variableCollectionId === c.id)
          .map((v) => ({
            id: v.id,
            name: v.name,
            key: v.key,
            description: v.description,
            scopes: v.scopes,
            resolvedType: v.resolvedType,
            hiddenFromPublishing: v.hiddenFromPublishing,
            codeSyntax: v.codeSyntax,
            remote: v.remote,
            valuesByMode: serializeVarValues(v),
          })),
      }));
    }
    case 'get_components': {
      const components: ComponentNode[] = [];
      const sets: ComponentSetNode[] = [];
      await figma.loadAllPagesAsync();
      walk(figma.root, (n) => {
        if (n.type === 'COMPONENT') components.push(n as ComponentNode);
        if (n.type === 'COMPONENT_SET') sets.push(n as ComponentSetNode);
      });
      const wantDefs = params.includePropertyDefinitions !== false;
      const summarize = (c: ComponentNode | ComponentSetNode) => {
        const out: any = {
          id: c.id,
          name: c.name,
          description: c.description,
          key: c.key,
          remote: c.remote,
          documentationLinks: c.documentationLinks,
        };
        if (wantDefs) {
          try { out.componentPropertyDefinitions = (c as any).componentPropertyDefinitions; } catch {}
        }
        return out;
      };
      return {
        components: components.map(summarize),
        sets: sets.map(summarize),
      };
    }
    case 'search_nodes': {
      const max = params.maxResults ?? 50;
      const offset = Math.max(0, params.offset ?? 0);
      const types: string[] | null = params.type
        ? Array.isArray(params.type) ? params.type : [params.type]
        : null;
      const nameRx: RegExp | null = params.nameRegex
        ? new RegExp(params.nameRegex, params.nameFlags ?? 'i')
        : null;
      const needle = !nameRx && params.name ? String(params.name).toLowerCase() : null;
      const fillHex = params.fillHex ? String(params.fillHex).toUpperCase() : null;
      const fillType = params.fillType ? String(params.fillType).toUpperCase() : null;
      const wantStyle = params.hasStyle === true;
      const wantBoundVar = params.hasBoundVariable === true;
      const textContains = params.textContains ? String(params.textContains).toLowerCase() : null;

      const scopes: BaseNode[] = [];
      let nextPageCursor: number | undefined; // set by bounded allPages (maxPages) or budget trip
      let nextNodeCursor: number | undefined; // set when budget trips mid-page
      let partial = false;
      if (params.scope) {
        scopes.push(await getNode(params.scope));
      } else if (Array.isArray(params.pageIds) && params.pageIds.length) {
        // Search ONLY the named pages — load just these, not the whole file.
        // Lets a caller batch a big multi-page file (e.g. 5-10 pages/call)
        // instead of allPages' loadAllPagesAsync timing out on 97 pages.
        for (const pid of params.pageIds) {
          const n = await getNode(String(pid));
          if (n.type !== 'PAGE') throw new Error(`Not a page: ${pid}`);
          await (n as PageNode).loadAsync();
          scopes.push(n);
        }
      } else if (params.pageId) {
        const n = await getNode(params.pageId);
        if (n.type !== 'PAGE') throw new Error(`Not a page: ${params.pageId}`);
        await (n as PageNode).loadAsync();
        scopes.push(n);
      } else if (!params.allPages) {
        await figma.currentPage.loadAsync();
        scopes.push(figma.currentPage);
      }

      const matches: SceneNode[] = [];
      const tryMatch = (n: BaseNode): boolean => {
        if (types && !types.includes(n.type)) return false;
        if (nameRx && !nameRx.test(n.name)) return false;
        if (needle && !n.name.toLowerCase().includes(needle)) return false;
        if (textContains && n.type === 'TEXT') {
          if (!(n as TextNode).characters.toLowerCase().includes(textContains)) return false;
        } else if (textContains) {
          return false;
        }
        if (fillHex && hasFills(n)) {
          const f = (n as any).fills;
          if (f === figma.mixed) return false;
          const has = (f as Paint[]).some(
            (p) => p.type === 'SOLID' && rgbToHex(p.color.r, p.color.g, p.color.b) === fillHex,
          );
          if (!has) return false;
        } else if (fillHex) {
          return false;
        }
        if (fillType) {
          if (!hasFills(n)) return false;
          const f = (n as any).fills;
          if (f === figma.mixed) return false;
          const match = (f as Paint[]).some((p) =>
            fillType === 'GRADIENT' ? p.type.indexOf('GRADIENT_') === 0 : p.type === fillType,
          );
          if (!match) return false;
        }
        if (wantStyle) {
          const styleKeys = ['fillStyleId', 'strokeStyleId', 'textStyleId', 'effectStyleId', 'gridStyleId'];
          const anyStyle = styleKeys.some((k) => {
            const v = (n as any)[k];
            return typeof v === 'string' && v.length > 0;
          });
          if (!anyStyle) return false;
        }
        if (wantBoundVar) {
          const bv = (n as any).boundVariables;
          if (!bv || Object.keys(bv).length === 0) return false;
        }
        return true;
      };
      if (params.allPages) {
        const kids = figma.root.children;                    // cheap page stubs, no content load
        const mp = (typeof params.maxPages === 'number' && params.maxPages > 0) ? params.maxPages : Infinity;
        const budget = Math.min(55000, Math.max(1000, typeof params.timeBudgetMs === 'number' ? params.timeBudgetMs : 45000));
        const t0 = Date.now();
        const startPage = Math.max(0, params.pageCursor ?? 0);
        let startNode = Math.max(0, params.nodeCursor ?? 0);
        let processed = 0;
        let pi = startPage;
        for (; pi < kids.length && processed < mp; pi++, processed++, startNode = 0) {
          const pg = kids[pi] as PageNode;
          await pg.loadAsync();
          let candidates: SceneNode[] | null = null;
          if (types && 'findAllWithCriteria' in pg) {
            try { candidates = (pg as any).findAllWithCriteria({ types }) as SceneNode[]; } catch { candidates = null; }
          }
          if (candidates) {
            let ni = startNode;
            for (; ni < candidates.length; ni++) {
              if ((ni & 511) === 0 && Date.now() - t0 > budget) { partial = true; nextPageCursor = pi; nextNodeCursor = ni; break; }
              if (tryMatch(candidates[ni])) matches.push(candidates[ni]);
            }
            if (partial) break;
          } else {
            // untyped page = atomic (no cheap mid-page resume); root excluded via n !== pg
            walk(pg, (n) => { if (n !== pg && tryMatch(n)) matches.push(n as SceneNode); });
          }
          // boundary budget check (covers untyped pages + between typed pages)
          if (pi + 1 < kids.length && processed + 1 < mp && Date.now() - t0 > budget) { partial = true; nextPageCursor = pi + 1; nextNodeCursor = 0; break; }
        }
        if (!partial && processed >= mp && pi < kids.length) { nextPageCursor = pi; nextNodeCursor = 0; }  // stopped on maxPages, more remain
      }
      for (const root of scopes) {
        // Fast path: when types are given, use the NATIVE typed index
        // (findAllWithCriteria) as the candidate set instead of walking every
        // node in JS — orders of magnitude faster on big pages. Remaining
        // filters (name / text / fill) apply to that smaller set. Fall back to
        // the full walk only when no types (name/text/fill across all types) or
        // if the criteria call rejects a type value.
        let candidates: SceneNode[] | null = null;
        if (types && 'findAllWithCriteria' in root) {
          try { candidates = (root as any).findAllWithCriteria({ types }) as SceneNode[]; }
          catch { candidates = null; }
        }
        if (candidates) {
          for (const n of candidates) { if (tryMatch(n)) matches.push(n); }
        } else {
          walk(root, (n) => { if (n !== root && tryMatch(n)) matches.push(n as SceneNode); });
        }
      }

      const slice = matches.slice(offset, offset + max);
      const wantProps = Array.isArray(params.properties) && params.properties.length;
      const propsSet = wantProps ? new Set<string>(params.properties) : undefined;
      const results: any[] = [];
      for (const n of slice) {
        if (propsSet) {
          const proj = await serializeNode(n, { depth: 0, maxDepth: 0, includeChildren: false, properties: propsSet });
          results.push({ ...proj, parentId: n.parent?.id ?? '' });
        } else {
          results.push({ id: n.id, name: n.name, type: n.type, parentId: n.parent?.id ?? '' });
        }
      }
      return {
        total: matches.length,
        offset,
        ...(partial ? { partial: true } : {}),
        ...(nextPageCursor !== undefined ? { nextPageCursor } : {}),
        ...(nextNodeCursor !== undefined && nextNodeCursor > 0 ? { nextNodeCursor } : {}),
        results,
      };
    }
    case 'get_audit': {
      const cap = typeof params.maxNodes === 'number' && params.maxNodes > 0 ? params.maxNodes : 50000;
      const roots: BaseNode[] = [];
      if (params.scope) roots.push(await getNode(params.scope));
      else if (params.pageId) {
        const p = await getNode(params.pageId);
        if (p.type !== 'PAGE') throw new Error(`Not a page: ${params.pageId}`);
        await (p as PageNode).loadAsync();
        roots.push(p);
      } else if (params.allPages) {
        for (const pg of figma.root.children) {
          await (pg as PageNode).loadAsync();
          roots.push(pg);
        }
      } else {
        await figma.currentPage.loadAsync();
        roots.push(figma.currentPage);
      }
      const s: any = {
        scanned: 0,
        truncated: false,
        byType: {},
        fills: { solid: 0, gradient: 0, image: 0, video: 0, other: 0, none: 0 },
        hardcodedColor: 0,
        styledNodes: 0,
        boundVarNodes: 0,
        instances: 0,
        components: 0,
        textNodes: 0,
      };
      const fonts: Record<string, number> = {};
      const styleKeys = ['fillStyleId', 'strokeStyleId', 'textStyleId', 'effectStyleId', 'gridStyleId'];
      const visit = (n: BaseNode): boolean => {
        if (s.scanned >= cap) { s.truncated = true; return false; }
        if (roots.includes(n)) { /* skip page/scope root itself */ } else {
          s.scanned++;
          s.byType[n.type] = (s.byType[n.type] || 0) + 1;
          if (n.type === 'INSTANCE') s.instances++;
          if (n.type === 'COMPONENT' || n.type === 'COMPONENT_SET') s.components++;
          const a = n as any;
          if ('fills' in a) {
            const f = a.fills;
            if (f === figma.mixed) s.fills.other++;
            else if (!f || f.length === 0) s.fills.none++;
            else {
              const kinds = (f as Paint[]).map((p) => p.type);
              if (kinds.some((k) => k === 'IMAGE')) s.fills.image++;
              else if (kinds.some((k) => k === 'VIDEO')) s.fills.video++;
              else if (kinds.some((k) => k.indexOf('GRADIENT_') === 0)) s.fills.gradient++;
              else if (kinds.some((k) => k === 'SOLID')) s.fills.solid++;
              else s.fills.other++;
              const boundFills = a.boundVariables && a.boundVariables.fills;
              if (kinds.some((k) => k === 'SOLID') && !(typeof a.fillStyleId === 'string' && a.fillStyleId) && !boundFills) s.hardcodedColor++;
            }
          }
          if (styleKeys.some((k) => typeof a[k] === 'string' && a[k].length > 0)) s.styledNodes++;
          if (a.boundVariables && Object.keys(a.boundVariables).length > 0) s.boundVarNodes++;
          if (n.type === 'TEXT') {
            s.textNodes++;
            const fn = (n as TextNode).fontName;
            if (fn !== figma.mixed) {
              const fam = (fn as FontName).family;
              fonts[fam] = (fonts[fam] || 0) + 1;
            }
          }
        }
        if (hasChildren(n)) for (const c of n.children) { if (!visit(c)) return false; }
        return true;
      };
      for (const r of roots) { if (!visit(r)) break; }
      const [ps, ts, es, gs] = await Promise.all([
        figma.getLocalPaintStylesAsync(),
        figma.getLocalTextStylesAsync(),
        figma.getLocalEffectStylesAsync(),
        figma.getLocalGridStylesAsync(),
      ]);
      const cols = await figma.variables.getLocalVariableCollectionsAsync();
      const vars = await figma.variables.getLocalVariablesAsync();
      s.fonts = Object.entries(fonts).map(([family, count]) => ({ family, count })).sort((x, y) => y.count - x.count);
      s.defined = {
        paintStyles: ps.length,
        textStyles: ts.length,
        effectStyles: es.length,
        gridStyles: gs.length,
        variables: vars.length,
        variableCollections: cols.length,
      };
      return s;
    }
    case 'list_pages': {
      return { pages: figma.root.children.map((p) => ({ id: p.id, name: p.name, current: p.id === figma.currentPage.id, isPageDivider: p.isPageDivider === true })) };
    }
    case 'export_node': {
      const node = await getNode(params.nodeId);
      if (!('exportAsync' in node)) {
        throw new Error(`Node ${params.nodeId} does not support export`);
      }
      const fmt = params.format;
      if (fmt === 'JSON') {
        const tree = await serializeNode(node, serializeOptsFrom(params, Number.POSITIVE_INFINITY));
        return { format: 'JSON', data: JSON.stringify(tree) };
      }
      if (fmt === 'CSS') {
        if (!('getCSSAsync' in node)) {
          throw new Error(`Node ${params.nodeId} does not support CSS export`);
        }
        const css = await (node as any).getCSSAsync();
        const text = Object.entries(css)
          .map(([k, v]) => `${k}: ${v};`)
          .join('\n');
        return { format: 'CSS', data: text };
      }

      // Build a Figma ExportSettings from params.
      const constraintType: 'SCALE' | 'WIDTH' | 'HEIGHT' = params.constraint?.type ?? 'SCALE';
      const constraintValue = params.constraint?.value ?? params.scale ?? 2;
      const settingsBase: any = {
        contentsOnly: params.contentsOnly,
        useAbsoluteBounds: params.useAbsoluteBounds,
        suffix: params.suffix,
        colorProfile: params.colorProfile,
      };

      if (fmt === 'SVG' || fmt === 'SVG_STRING') {
        const bytes = await (node as ExportMixin).exportAsync({
          ...settingsBase,
          format: 'SVG',
          svgOutlineText: params.svgOutlineText,
          svgIdAttribute: params.svgIdAttribute,
          svgSimplifyStroke: params.svgSimplifyStroke,
        });
        return { format: 'SVG', data: bytesToString(bytes) };
      }
      if (fmt === 'PNG' || fmt === 'JPG' || fmt === 'PDF') {
        const settings: any = {
          ...settingsBase,
          format: fmt,
          constraint: { type: constraintType, value: constraintValue },
        };
        const bytes = await (node as ExportMixin).exportAsync(settings);
        return { format: fmt, data: bytesToBase64(bytes) };
      }
      if (fmt === 'MP4' || fmt === 'GIF' || fmt === 'WEBM') {
        // Video export (U131) — only valid on an animated top-level frame.
        // Keep the settings minimal (video schemas reject the raster/svg
        // extras in settingsBase).
        const settings: any = {
          format: fmt,
          constraint: { type: constraintType, value: constraintValue },
        };
        if (typeof params.fps === 'number') settings.fps = params.fps;
        if (typeof params.quality === 'number') settings.quality = params.quality; // MP4/WEBM
        if (typeof params.loopCount === 'number') settings.loopCount = params.loopCount; // GIF
        const bytes = await (node as ExportMixin).exportAsync(settings);
        return { format: fmt, data: bytesToBase64(bytes) };
      }
      throw new Error(`Unsupported export format: ${fmt}`);
    }
    case 'set_node_property': {
      const node = await getNode(params.nodeId);
      await applyProperty(node as SceneNode, params.property, params.value);
      return { success: true };
    }
    case 'create_node': {
      const node = await createByType(params);
      return { id: node.id, name: node.name };
    }
    case 'create_tree': {
      let created = 0;
      const CAP = 2000;
      const build = async (spec: any, parent: BaseNode & ChildrenMixin, index?: number): Promise<any> => {
        if (++created > CAP) throw new Error(`create_tree exceeded ${CAP} nodes`);
        // createByType defaults its own parent to figma.currentPage (no
        // parentId passed here); the insertChild/appendChild below then
        // reparents the freshly-created node onto the real target parent —
        // Figma's appendChild moves rather than duplicates a node, so this
        // is a plain (cheap) reparent, not a double-parent.
        const node = await createByType({ ...spec, children: undefined });
        if (typeof index === 'number') parent.insertChild(index, node);
        else parent.appendChild(node);
        const out: any = { id: node.id, name: node.name };
        if (Array.isArray(spec.children) && spec.children.length) {
          if (!hasChildren(node)) throw new Error(`${spec.type} cannot contain children`);
          out.children = [];
          for (const c of spec.children) out.children.push(await build(c, node as any));
        }
        return out;
      };
      let parent: BaseNode & ChildrenMixin = figma.currentPage;
      if (params.parentId) {
        const p = await getNode(params.parentId);
        if (!hasChildren(p)) throw new Error(`Parent ${params.parentId} cannot contain children`);
        parent = p as any;
      }
      return await build(params.spec, parent, params.index);
    }
    case 'replace_text': {
      const find = String(params.find);
      const repl = String(params.replace);
      const useRegex = Boolean(params.regex);
      const budget = typeof params.budget === 'number' && params.budget > 0 ? params.budget : 10000;
      const chunk = typeof params.chunk === 'number' && params.chunk > 0 ? params.chunk : 100;
      // findNodes doesn't know `allPages` — walk pages ourselves (typed
      // findAllWithCriteria per page, same cheap-stub approach search_nodes
      // uses) rather than paying loadAllPagesAsync up front on a big file.
      let nodes: SceneNode[];
      if (params.allPages) {
        nodes = [];
        for (const pg of figma.root.children as PageNode[]) {
          await pg.loadAsync();
          nodes.push(...(pg.findAllWithCriteria({ types: ['TEXT'] }) as SceneNode[]));
        }
      } else {
        if (params.pageId && !params.scope) {
          const p = await getNode(params.pageId);
          if (p.type !== 'PAGE') throw new Error(`Not a page: ${params.pageId}`);
        }
        nodes = await findNodes({ types: ['TEXT'], scope: params.scope, page: params.pageId });
      }
      const matched = nodes.length;
      const truncated = matched > budget;
      let changed = 0;
      await forEachNode(nodes, async (n) => {
        const t = n as TextNode;
        const next = useRegex
          ? t.characters.replace(new RegExp(find, 'g'), repl)
          : t.characters.split(find).join(repl);
        if (next === t.characters) return;
        const fonts = t.getRangeAllFontNames(0, t.characters.length);
        await Promise.all(fonts.map((f) => figma.loadFontAsync(f)));
        t.characters = next;
        changed++;
      }, { budget, chunk });
      return { matched, changed, truncated };
    }
    case 'delete_node': {
      const n = await getNode(params.nodeId);
      n.remove();
      return { success: true };
    }
    case 'set_variable_value': {
      const v = await figma.variables.getVariableByIdAsync(params.variableId);
      if (!v) throw new Error(`Variable not found: ${params.variableId}`);
      const value = coerceVarValue(v.resolvedType, params.value);
      v.setValueForMode(params.modeId, value);
      return { success: true };
    }
    case 'set_style': {
      return await upsertStyle(params);
    }

    // ---------- selection / viewport ----------
    case 'set_selection': {
      const ids: string[] = asIds(params.nodeIds);
      const nodes: SceneNode[] = [];
      for (const id of ids) {
        const n = await getNode(id);
        if ('parent' in n) nodes.push(n as SceneNode);
      }
      // Switch the current page if all targets live on a different one.
      if (nodes.length) {
        const page = pageOf(nodes[0]);
        if (page && page !== figma.currentPage) await figma.setCurrentPageAsync(page);
      }
      figma.currentPage.selection = nodes;
      if (params.scrollTo) figma.viewport.scrollAndZoomIntoView(nodes);
      return { selected: nodes.map((n) => n.id) };
    }
    case 'scroll_to': {
      const ids: string[] = asIds(params.nodeIds).length ? asIds(params.nodeIds) : params.nodeId ? [params.nodeId] : [];
      const nodes: SceneNode[] = [];
      for (const id of ids) {
        const n = await getNode(id);
        if ('parent' in n) nodes.push(n as SceneNode);
      }
      if (nodes.length) {
        const page = pageOf(nodes[0]);
        if (page && page !== figma.currentPage) await figma.setCurrentPageAsync(page);
        figma.viewport.scrollAndZoomIntoView(nodes);
      }
      return { focused: nodes.map((n) => n.id) };
    }

    // ---------- tree ops ----------
    case 'clone_node': {
      const src = await getNode(params.nodeId);
      if (!('clone' in src)) throw new Error(`Node ${params.nodeId} cannot be cloned`);
      const copy = (src as any).clone() as SceneNode;
      let parent: BaseNode & ChildrenMixin = (src.parent as any) ?? figma.currentPage;
      if (params.parentId) {
        const p = await getNode(params.parentId);
        if (!hasChildren(p)) throw new Error(`Parent ${params.parentId} cannot contain children`);
        parent = p;
      }
      if (typeof params.index === 'number') parent.insertChild(params.index, copy);
      else parent.appendChild(copy);
      if (typeof params.x === 'number') copy.x = params.x;
      if (typeof params.y === 'number') copy.y = params.y;
      if (params.name) copy.name = params.name;
      return { id: copy.id, name: copy.name };
    }
    case 'move_node': {
      const src = await getNode(params.nodeId);
      if (!('parent' in src)) throw new Error(`Node ${params.nodeId} cannot move`);
      const target = await getNode(params.parentId);
      if (!hasChildren(target)) throw new Error(`Parent ${params.parentId} cannot contain children`);
      if (typeof params.index === 'number') target.insertChild(params.index, src as SceneNode);
      else target.appendChild(src as SceneNode);
      return { id: src.id, parentId: target.id };
    }
    case 'group_nodes': {
      const ids: string[] = asIds(params.nodeIds);
      if (!ids.length) throw new Error('group_nodes: nodeIds required');
      const nodes: SceneNode[] = [];
      for (const id of ids) {
        const n = await getNode(id);
        if ('parent' in n) nodes.push(n as SceneNode);
      }
      const parent = params.parentId
        ? (await getNode(params.parentId)) as BaseNode & ChildrenMixin
        : (nodes[0].parent as BaseNode & ChildrenMixin) ?? figma.currentPage;
      if (params.asFrame) {
        const frame = figma.createFrame();
        parent.appendChild(frame);
        const xs = nodes.map((n) => n.x);
        const ys = nodes.map((n) => n.y);
        const minX = Math.min(...xs), minY = Math.min(...ys);
        const maxX = Math.max(...nodes.map((n, i) => xs[i] + n.width));
        const maxY = Math.max(...nodes.map((n, i) => ys[i] + n.height));
        frame.x = minX; frame.y = minY;
        frame.resize(Math.max(1, maxX - minX), Math.max(1, maxY - minY));
        for (const n of nodes) {
          const px = n.x - minX, py = n.y - minY;
          frame.appendChild(n);
          n.x = px; n.y = py;
        }
        if (params.name) frame.name = params.name;
        return { id: frame.id, name: frame.name, type: 'FRAME' };
      }
      const group = figma.group(nodes, parent);
      if (params.name) group.name = params.name;
      return { id: group.id, name: group.name, type: 'GROUP' };
    }
    case 'ungroup_node': {
      const n = await getNode(params.nodeId);
      if (n.type !== 'GROUP' && n.type !== 'FRAME') {
        throw new Error(`ungroup_node: only GROUP or FRAME, got ${n.type}`);
      }
      const released = figma.ungroup(n as GroupNode | FrameNode);
      return { released: released.map((c) => c.id) };
    }

    // ---------- pages ----------
    case 'create_page': {
      const page = figma.createPage();
      if (params.name) page.name = params.name;
      if (params.makeCurrent) await figma.setCurrentPageAsync(page);
      return { id: page.id, name: page.name };
    }
    case 'set_current_page': {
      const n = await getNode(params.pageId);
      if (n.type !== 'PAGE') throw new Error(`Not a page: ${params.pageId}`);
      await figma.setCurrentPageAsync(n as PageNode);
      return { id: n.id, name: n.name };
    }
    case 'delete_page': {
      const n = await getNode(params.pageId);
      if (n.type !== 'PAGE') throw new Error(`Not a page: ${params.pageId}`);
      n.remove();
      return { success: true };
    }

    // ---------- plugin data ----------
    case 'get_plugin_data': {
      const n = await getNode(params.nodeId);
      if (params.key) return { key: params.key, value: n.getPluginData(params.key) };
      const keys = n.getPluginDataKeys();
      const data: Record<string, string> = {};
      for (const k of keys) data[k] = n.getPluginData(k);
      return { keys, data };
    }
    case 'set_plugin_data': {
      const n = await getNode(params.nodeId);
      n.setPluginData(params.key, params.value === null ? '' : String(params.value));
      return { success: true };
    }

    // ---------- components ----------
    case 'detach_instance': {
      const n = await getNode(params.nodeId);
      if (n.type !== 'INSTANCE') throw new Error(`Not an INSTANCE: ${params.nodeId}`);
      const detached = (n as InstanceNode).detachInstance();
      return { id: detached.id, type: detached.type };
    }
    case 'swap_instance': {
      const n = await getNode(params.nodeId);
      if (n.type !== 'INSTANCE') throw new Error(`Not an INSTANCE: ${params.nodeId}`);
      const target = await getNode(params.componentId);
      if (target.type !== 'COMPONENT') throw new Error(`Swap target not a COMPONENT: ${params.componentId}`);
      (n as InstanceNode).swapComponent(target as ComponentNode);
      return { success: true };
    }
    case 'create_component_from_node': {
      const n = await getNode(params.nodeId);
      if (!('parent' in n)) throw new Error(`Node ${params.nodeId} cannot become a component`);
      const c = figma.createComponentFromNode(n as SceneNode);
      if (params.name) c.name = params.name;
      if (typeof params.description === 'string') c.description = params.description;
      return { id: c.id, name: c.name, key: c.key };
    }

    // ---------- style + variable bindings ----------
    case 'apply_style': {
      const node = await getNode(params.nodeId);
      const sn = node as any;
      const kind = String(params.kind ?? 'fill').toLowerCase();
      const sid = params.styleId ?? '';
      switch (kind) {
        case 'fill':
          if (!('fillStyleId' in sn)) throw new Error(`No fillStyleId on ${node.type}`);
          if ('setFillStyleIdAsync' in sn) await sn.setFillStyleIdAsync(sid);
          else sn.fillStyleId = sid;
          return { success: true };
        case 'stroke':
          if (!('strokeStyleId' in sn)) throw new Error(`No strokeStyleId on ${node.type}`);
          if ('setStrokeStyleIdAsync' in sn) await sn.setStrokeStyleIdAsync(sid);
          else sn.strokeStyleId = sid;
          return { success: true };
        case 'effect':
          if (!('effectStyleId' in sn)) throw new Error(`No effectStyleId on ${node.type}`);
          if ('setEffectStyleIdAsync' in sn) await sn.setEffectStyleIdAsync(sid);
          else sn.effectStyleId = sid;
          return { success: true };
        case 'grid':
          if (!('gridStyleId' in sn)) throw new Error(`No gridStyleId on ${node.type}`);
          if ('setGridStyleIdAsync' in sn) await sn.setGridStyleIdAsync(sid);
          else sn.gridStyleId = sid;
          return { success: true };
        case 'text':
          if (node.type !== 'TEXT') throw new Error(`Text style requires TEXT node`);
          if ('setTextStyleIdAsync' in sn) await sn.setTextStyleIdAsync(sid);
          else (node as TextNode).textStyleId = sid;
          return { success: true };
        default:
          throw new Error(`Unknown style kind: ${kind}`);
      }
    }
    case 'bind_property_to_variable': {
      const node = await getNode(params.nodeId);
      const v = await figma.variables.getVariableByIdAsync(params.variableId);
      if (!v) throw new Error(`Variable not found: ${params.variableId}`);
      const field = String(params.field);
      const sn = node as any;
      if (typeof sn.setBoundVariable === 'function') {
        sn.setBoundVariable(field, v);
        return { success: true };
      }
      throw new Error(`Node ${node.type} does not support setBoundVariable`);
    }

    // ---------- assets ----------
    case 'upload_image': {
      const b64 = String(params.base64 ?? '');
      const bytes = base64ToBytes(b64);
      const image = figma.createImage(bytes);
      return { imageHash: image.hash, bytesLength: bytes.length };
    }

    // ---------- variables: create / delete / modes / meta ----------
    case 'create_variable_collection': {
      const c = figma.variables.createVariableCollection(String(params.name));
      return {
        id: c.id,
        name: c.name,
        defaultModeId: c.defaultModeId,
        modes: c.modes.map((m) => ({ modeId: m.modeId, name: m.name })),
      };
    }
    case 'delete_variable_collection': {
      const c = await figma.variables.getVariableCollectionByIdAsync(params.collectionId);
      if (!c) throw new Error(`Collection not found: ${params.collectionId}`);
      c.remove();
      return { success: true };
    }
    case 'create_variable': {
      const c = await figma.variables.getVariableCollectionByIdAsync(params.collectionId);
      if (!c) throw new Error(`Collection not found: ${params.collectionId}`);
      const type = params.resolvedType as VariableResolvedDataType;
      const v = figma.variables.createVariable(String(params.name), c, type);
      // Any failure after creation (bad value, invalid scope, …) removes the
      // half-built variable so a rejected call leaves nothing behind.
      try {
        // Optional initial values per mode. Caller-controlled mode → value map.
        const valsByMode = coerce<Record<string, unknown> | undefined>(params.valuesByMode);
        if (valsByMode && typeof valsByMode === 'object') {
          for (const [modeId, raw] of Object.entries(valsByMode)) {
            v.setValueForMode(modeId, coerceVarValue(type, raw));
          }
        } else if (params.value !== undefined) {
          v.setValueForMode(c.defaultModeId, coerceVarValue(type, params.value));
        }
        if (typeof params.description === 'string') v.description = params.description;
        const scopes = coerce<unknown>(params.scopes);
        if (Array.isArray(scopes)) v.scopes = scopes as VariableScope[];
        const codeSyntax = coerce<Record<string, unknown> | undefined>(params.codeSyntax);
        if (codeSyntax && typeof codeSyntax === 'object') {
          for (const [platform, code] of Object.entries(codeSyntax)) {
            v.setVariableCodeSyntax(platform as CodeSyntaxPlatform, String(code));
          }
        }
        if (typeof params.hiddenFromPublishing === 'boolean') v.hiddenFromPublishing = params.hiddenFromPublishing;
        return { id: v.id, name: v.name, resolvedType: v.resolvedType };
      } catch (err) {
        try { v.remove(); } catch { /* already gone */ }
        throw err;
      }
    }
    case 'delete_variable': {
      const v = await figma.variables.getVariableByIdAsync(params.variableId);
      if (!v) throw new Error(`Variable not found: ${params.variableId}`);
      v.remove();
      return { success: true };
    }
    case 'add_variable_mode': {
      const c = await figma.variables.getVariableCollectionByIdAsync(params.collectionId);
      if (!c) throw new Error(`Collection not found: ${params.collectionId}`);
      const modeId = c.addMode(String(params.name));
      return { modeId, name: params.name };
    }
    case 'remove_variable_mode': {
      const c = await figma.variables.getVariableCollectionByIdAsync(params.collectionId);
      if (!c) throw new Error(`Collection not found: ${params.collectionId}`);
      c.removeMode(String(params.modeId));
      return { success: true };
    }
    case 'rename_variable_mode': {
      const c = await figma.variables.getVariableCollectionByIdAsync(params.collectionId);
      if (!c) throw new Error(`Collection not found: ${params.collectionId}`);
      c.renameMode(String(params.modeId), String(params.name));
      return { success: true };
    }
    case 'set_variable_meta': {
      const v = await figma.variables.getVariableByIdAsync(params.variableId);
      if (!v) throw new Error(`Variable not found: ${params.variableId}`);
      if (typeof params.name === 'string') v.name = params.name;
      if (typeof params.description === 'string') v.description = params.description;
      const scopes = coerce<unknown>(params.scopes);
      if (Array.isArray(scopes)) v.scopes = scopes as VariableScope[];
      const codeSyntax = coerce<Record<string, unknown> | undefined>(params.codeSyntax);
      if (codeSyntax && typeof codeSyntax === 'object') {
        for (const [platform, code] of Object.entries(codeSyntax)) {
          v.setVariableCodeSyntax(platform as CodeSyntaxPlatform, String(code));
        }
      }
      if (typeof params.hiddenFromPublishing === 'boolean') v.hiddenFromPublishing = params.hiddenFromPublishing;
      return { success: true };
    }

    // ---------- tier 1: flatten/boolean/svg/notify/fonts/reactions/text ----------
    case 'flatten_nodes': {
      const ids: string[] = asIds(params.nodeIds);
      if (!ids.length) throw new Error('flatten_nodes: nodeIds required');
      const nodes: SceneNode[] = [];
      for (const id of ids) {
        const n = await getNode(id);
        if ('parent' in n) nodes.push(n as SceneNode);
      }
      const parent = params.parentId
        ? (await getNode(params.parentId)) as BaseNode & ChildrenMixin
        : (nodes[0].parent as BaseNode & ChildrenMixin) ?? figma.currentPage;
      const flat = typeof params.index === 'number'
        ? figma.flatten(nodes, parent, params.index)
        : figma.flatten(nodes, parent);
      return { id: flat.id, name: flat.name, type: flat.type };
    }
    case 'boolean_operation': {
      const ids: string[] = asIds(params.nodeIds);
      if (ids.length < 2) throw new Error('boolean_operation: need ≥2 nodes');
      const op = String(params.operation ?? params.type ?? '').toUpperCase();
      const nodes: SceneNode[] = [];
      for (const id of ids) {
        const n = await getNode(id);
        if ('parent' in n) nodes.push(n as SceneNode);
      }
      const parent = params.parentId
        ? (await getNode(params.parentId)) as BaseNode & ChildrenMixin
        : (nodes[0].parent as BaseNode & ChildrenMixin) ?? figma.currentPage;
      let out: BooleanOperationNode;
      if (op === 'UNION') out = figma.union(nodes, parent);
      else if (op === 'SUBTRACT') out = figma.subtract(nodes, parent);
      else if (op === 'INTERSECT') out = figma.intersect(nodes, parent);
      else if (op === 'EXCLUDE') out = figma.exclude(nodes, parent);
      else throw new Error(`Unknown boolean operation: ${op}`);
      if (params.name) out.name = params.name;
      return { id: out.id, name: out.name, type: out.type };
    }
    case 'create_node_from_svg': {
      const svg = String(params.svg ?? '');
      if (!svg) throw new Error('create_node_from_svg: svg required');
      const node = figma.createNodeFromSvg(svg);
      let parent: BaseNode & ChildrenMixin = figma.currentPage;
      if (params.parentId) {
        const p = await getNode(params.parentId);
        if (!hasChildren(p)) throw new Error(`Parent ${params.parentId} cannot contain children`);
        parent = p;
      }
      parent.appendChild(node);
      if (params.name) node.name = params.name;
      if (typeof params.x === 'number') node.x = params.x;
      if (typeof params.y === 'number') node.y = params.y;
      return { id: node.id, name: node.name, type: node.type };
    }
    case 'notify': {
      const message = String(params.message ?? '');
      const opts: NotificationOptions = {};
      if (typeof params.timeout === 'number') opts.timeout = params.timeout;
      if (params.error) opts.error = true;
      figma.notify(message, opts);
      return { success: true };
    }
    case 'list_fonts': {
      const fonts = await figma.listAvailableFontsAsync();
      // axesFor: variable-font axis discovery for ONE family (exact match,
      // case-insensitive against the available fonts). Returns an object, not
      // the usual [{family,style}] list.
      if (params.axesFor !== undefined && params.axesFor !== null && params.axesFor !== '') {
        const want = String(params.axesFor);
        const match = fonts.find((f) => f.fontName.family.toLowerCase() === want.toLowerCase());
        const family = match ? match.fontName.family : want;
        const styles = fonts.filter((f) => f.fontName.family === family).map((f) => f.fontName.style);
        if (typeof (figma as any).getFontFamilyVariationAxes !== 'function') {
          return { family, available: false, axes: null, variable: null, styles, error: 'getFontFamilyVariationAxes is not available in this Figma version (variable-font API, update 138)' };
        }
        if (!match) {
          return { family, available: false, axes: null, variable: null, styles, error: `Family not available in this editor: ${want} (use list_fonts {family} to search)` };
        }
        let axes: string[] | null;
        try {
          axes = (figma as any).getFontFamilyVariationAxes(family) as string[] | null;
        } catch (e: any) {
          return { family, available: false, axes: null, variable: null, styles, error: String(e?.message ?? e) };
        }
        return { family, available: true, variable: axes !== null, axes, styles };
      }
      const filterFamily = params.family ? String(params.family).toLowerCase() : null;
      const filtered = filterFamily
        ? fonts.filter((f) => f.fontName.family.toLowerCase().includes(filterFamily))
        : fonts;
      return filtered.map((f) => ({ family: f.fontName.family, style: f.fontName.style }));
    }
    case 'load_font': {
      const family = String(params.family);
      const vs = coerce<any>(params.variationSettings);
      const hasStyle = params.style !== undefined && params.style !== null && params.style !== '';
      if (hasStyle) {
        // variationSettings is ignored by loadFontAsync (affects rendering, not loading).
        const fn: FontName = { family, style: String(params.style) };
        await figma.loadFontAsync(fn);
        return { success: true, family: fn.family, style: fn.style };
      }
      // No style: load EVERY style of the family (FontNameInput, update 138).
      // Older clients reject a style-less input -> fall back to the legacy
      // "Regular" default so existing callers keep working.
      try {
        await figma.loadFontAsync({ family } as any);
        return { success: true, family, style: null, allStyles: true, ...(vs ? { variationSettings: vs } : {}) };
      } catch (e) {
        const fn: FontName = { family, style: 'Regular' };
        await figma.loadFontAsync(fn);
        return { success: true, family: fn.family, style: fn.style, allStyles: false };
      }
    }
    case 'set_reactions': {
      const node = await getNode(params.nodeId);
      if (!('reactions' in node)) throw new Error(`Node ${node.type} has no reactions`);
      const reactions = coerce<Reaction[]>(params.reactions ?? []);
      const sn = node as any;
      if (typeof sn.setReactionsAsync === 'function') {
        await sn.setReactionsAsync(reactions);
      } else {
        sn.reactions = reactions;
      }
      return { success: true, count: reactions.length };
    }
    case 'get_styled_text_segments': {
      const n = await getNode(params.nodeId);
      if (n.type !== 'TEXT') throw new Error(`Not a TEXT node: ${params.nodeId}`);
      const fields = (params.fields ?? [
        'fontName', 'fontStyle', 'fontSize', 'textCase', 'textDecoration',
        'fills', 'lineHeight', 'letterSpacing', 'hyperlink', 'listOptions',
        'paragraphSpacing', 'paragraphIndent', 'openTypeFeatures',
      ]) as Parameters<TextNode['getStyledTextSegments']>[0];
      const start = typeof params.start === 'number' ? params.start : undefined;
      const end = typeof params.end === 'number' ? params.end : undefined;
      const segs = (start !== undefined && end !== undefined)
        ? (n as TextNode).getStyledTextSegments(fields, start, end)
        : (n as TextNode).getStyledTextSegments(fields);
      // Hex-encode fills inside segments for symmetry with serializeNode.
      return segs.map((s: any) => {
        const out: any = { ...s };
        if (Array.isArray(s.fills)) out.fills = s.fills.map(serializePaint);
        return out;
      });
    }

    // ---------- tier 2: section / dev resources / library / viewport / version / annotations ----------
    case 'create_section': {
      const sec = figma.createSection();
      let parent: BaseNode & ChildrenMixin = figma.currentPage;
      if (params.parentId) {
        const p = await getNode(params.parentId);
        if (!hasChildren(p)) throw new Error(`Parent ${params.parentId} cannot contain children`);
        parent = p;
      }
      parent.appendChild(sec);
      if (params.name) sec.name = params.name;
      if (typeof params.x === 'number') sec.x = params.x;
      if (typeof params.y === 'number') sec.y = params.y;
      if (typeof params.width === 'number' && typeof params.height === 'number') {
        sec.resizeWithoutConstraints(params.width, params.height);
      }
      return { id: sec.id, name: sec.name, type: sec.type };
    }
    case 'add_dev_resource': {
      const node = await getNode(params.nodeId);
      const sn = node as any;
      if (typeof sn.addDevResourceAsync !== 'function') {
        throw new Error(`Node ${node.type} does not support dev resources`);
      }
      await sn.addDevResourceAsync(String(params.url), String(params.name ?? params.url));
      return { success: true };
    }
    case 'delete_dev_resource': {
      const node = await getNode(params.nodeId);
      const sn = node as any;
      if (typeof sn.deleteDevResourceAsync !== 'function') {
        throw new Error(`Node ${node.type} does not support dev resources`);
      }
      await sn.deleteDevResourceAsync(String(params.url));
      return { success: true };
    }
    case 'get_dev_resources': {
      const node = await getNode(params.nodeId);
      const sn = node as any;
      const list = sn.devResources ?? [];
      return { resources: list };
    }
    case 'import_component_by_key': {
      const c = await figma.importComponentByKeyAsync(String(params.key));
      return { id: c.id, name: c.name, key: c.key };
    }
    case 'import_style_by_key': {
      const s = await figma.importStyleByKeyAsync(String(params.key));
      return { id: s.id, name: s.name, type: s.type, key: s.key };
    }
    case 'import_variable_by_key': {
      const v = await figma.variables.importVariableByKeyAsync(String(params.key));
      return { id: v.id, name: v.name, resolvedType: v.resolvedType, key: v.key };
    }
    case 'create_image_from_url': {
      const img = await figma.createImageAsync(String(params.url));
      return { imageHash: img.hash };
    }
    case 'set_viewport': {
      if (params.center) {
        figma.viewport.center = { x: Number(params.center.x), y: Number(params.center.y) };
      }
      if (typeof params.zoom === 'number') figma.viewport.zoom = params.zoom;
      return {
        center: figma.viewport.center,
        zoom: figma.viewport.zoom,
        bounds: figma.viewport.bounds,
      };
    }
    case 'commit_undo': {
      figma.commitUndo();
      return { success: true };
    }
    case 'save_version': {
      const id = await figma.saveVersionHistoryAsync(
        String(params.title ?? ''),
        params.description ? String(params.description) : undefined,
      );
      return { id };
    }
    case 'set_annotation': {
      const node = await getNode(params.nodeId);
      const sn = node as any;
      if (!('annotations' in sn)) throw new Error(`Node ${node.type} cannot be annotated`);
      const list = coerce<unknown>(params.annotations);
      const props = coerce<unknown>(params.properties);
      const ann: Annotation[] = Array.isArray(list)
        ? (list as Annotation[])
        : [{ label: String(params.label ?? ''), properties: props as any }];
      sn.annotations = ann;
      return { success: true, count: ann.length };
    }
    case 'get_annotations': {
      const node = await getNode(params.nodeId);
      const sn = node as any;
      return { annotations: sn.annotations ?? [] };
    }

    // ---------- tier 3: figjam / vector / shared data / palette / thumbnail ----------
    case 'create_sticky': {
      const s = figma.createSticky();
      let parent: BaseNode & ChildrenMixin = figma.currentPage;
      if (params.parentId) {
        const p = await getNode(params.parentId);
        if (!hasChildren(p)) throw new Error(`Parent ${params.parentId} cannot contain children`);
        parent = p;
      }
      parent.appendChild(s);
      if (params.text) {
        await figma.loadFontAsync(s.text.fontName as FontName);
        s.text.characters = String(params.text);
      }
      if (params.author) s.authorName = String(params.author);
      if (typeof params.x === 'number') s.x = params.x;
      if (typeof params.y === 'number') s.y = params.y;
      return { id: s.id, type: s.type };
    }
    case 'create_connector': {
      const c = figma.createConnector();
      if (params.parentId) {
        const p = await getNode(params.parentId);
        if (hasChildren(p)) p.appendChild(c);
      }
      if (params.startNodeId) {
        const s = await getNode(params.startNodeId);
        c.connectorStart = { endpointNodeId: s.id, magnet: params.startMagnet ?? 'AUTO' };
      }
      if (params.endNodeId) {
        const e = await getNode(params.endNodeId);
        c.connectorEnd = { endpointNodeId: e.id, magnet: params.endMagnet ?? 'AUTO' };
      }
      if (params.lineType) (c as any).connectorLineType = params.lineType;
      if (params.text) {
        await figma.loadFontAsync(c.text.fontName as FontName);
        c.text.characters = String(params.text);
      }
      return { id: c.id, type: c.type };
    }
    case 'create_shape_with_text': {
      const s = figma.createShapeWithText();
      let parent: BaseNode & ChildrenMixin = figma.currentPage;
      if (params.parentId) {
        const p = await getNode(params.parentId);
        if (!hasChildren(p)) throw new Error(`Parent ${params.parentId} cannot contain children`);
        parent = p;
      }
      parent.appendChild(s);
      if (params.shapeType) s.shapeType = params.shapeType as ShapeWithTextNode['shapeType'];
      if (params.text) {
        await figma.loadFontAsync(s.text.fontName as FontName);
        s.text.characters = String(params.text);
      }
      if (typeof params.x === 'number') s.x = params.x;
      if (typeof params.y === 'number') s.y = params.y;
      return { id: s.id, type: s.type };
    }
    case 'create_table': {
      const t = figma.createTable(
        params.numRows ?? 2,
        params.numColumns ?? 2,
      );
      let parent: BaseNode & ChildrenMixin = figma.currentPage;
      if (params.parentId) {
        const p = await getNode(params.parentId);
        if (!hasChildren(p)) throw new Error(`Parent ${params.parentId} cannot contain children`);
        parent = p;
      }
      parent.appendChild(t);
      if (typeof params.x === 'number') t.x = params.x;
      if (typeof params.y === 'number') t.y = params.y;
      return { id: t.id, type: t.type, numRows: t.numRows, numColumns: t.numColumns };
    }
    case 'set_vector_network': {
      const node = await getNode(params.nodeId);
      if (node.type !== 'VECTOR') throw new Error(`Not a VECTOR: ${params.nodeId}`);
      const v = node as VectorNode;
      // Some MCP clients JSON-stringify args when the JSON Schema is
      // permissive (e.g. {}). Accept both shapes and parse the string
      // form so Figma always gets a real object.
      let network: unknown = params.network;
      if (typeof network === 'string') {
        try { network = JSON.parse(network); } catch (err) {
          throw new Error(`network is a string but not valid JSON: ${(err as Error).message}`);
        }
      }
      if (typeof v.setVectorNetworkAsync === 'function') {
        await v.setVectorNetworkAsync(network as VectorNetwork);
      } else {
        v.vectorNetwork = network as VectorNetwork;
      }
      return { success: true };
    }
    case 'set_shared_plugin_data': {
      const n = await getNode(params.nodeId);
      n.setSharedPluginData(String(params.namespace), String(params.key), params.value === null ? '' : String(params.value));
      return { success: true };
    }
    case 'get_shared_plugin_data': {
      const n = await getNode(params.nodeId);
      const ns = String(params.namespace);
      if (params.key) return { key: params.key, value: n.getSharedPluginData(ns, String(params.key)) };
      const keys = n.getSharedPluginDataKeys(ns);
      const data: Record<string, string> = {};
      for (const k of keys) data[k] = n.getSharedPluginData(ns, k);
      return { keys, data };
    }
    case 'get_selection_colors': {
      const colors = figma.getSelectionColors();
      if (!colors) return null;
      return {
        paints: colors.paints.map(serializePaint),
        styles: colors.styles.map((s) => ({ id: s.id, name: s.name, type: s.type })),
      };
    }
    case 'get_deep_link': {
      // figma.fileKey is only populated for private org plugins with
      // enablePrivatePluginApi (or Figma-owned). For everyone else it's
      // null and we fall back to root.id "0:0" elsewhere — but a "0:0"
      // key makes a broken URL, so treat null/"0:0" as an explicit
      // not-possible state rather than emitting garbage.
      const realKey = figma.fileKey;
      if (!realKey || realKey === figma.root.id) {
        return {
          available: false,
          url: null,
          reason: 'deep_link_unavailable',
          detail: 'This file has no public fileKey — figma.fileKey is null. Grip must run as a private org plugin with enablePrivatePluginApi for deep links to work. Not possible for this file.',
        };
      }
      const kind = (params.kind ?? 'design') as 'design' | 'dev' | 'proto';
      // Resolve target: explicit nodeId → first selected → current page.
      let targetId: string;
      let scope: 'node' | 'page';
      let selectionCount: number | undefined;
      if (params.nodeId) {
        const n = await getNode(params.nodeId);  // throws "Node not found" if bad
        targetId = n.id;
        scope = 'node';
      } else if (figma.currentPage.selection.length) {
        targetId = figma.currentPage.selection[0].id;
        scope = 'node';
        selectionCount = figma.currentPage.selection.length;
      } else {
        targetId = figma.currentPage.id;
        scope = 'page';
      }
      const editorType = figma.editorType; // 'figma' | 'figjam' | 'slides' | 'dev' | ...
      let seg: string;
      if (kind === 'proto') seg = 'proto';
      else if (editorType === 'figjam') seg = 'board';
      else if (editorType === 'slides') seg = 'slides';
      else seg = 'design';
      const slug = encodeURIComponent(figma.root.name) || 'file';
      const dashId = targetId.replace(/:/g, '-');
      let url = `https://www.figma.com/${seg}/${realKey}/${slug}?node-id=${dashId}`;
      if (kind === 'dev') url += '&m=dev';
      return { available: true, url, fileKey: realKey, nodeId: targetId, kind, editorType, scope, selectionCount };
    }
    case 'set_file_thumbnail': {
      if (params.nodeId === null) {
        await figma.setFileThumbnailNodeAsync(null);
        return { success: true, cleared: true };
      }
      const n = await getNode(params.nodeId);
      const ok: BaseNode['type'][] = ['FRAME', 'COMPONENT', 'COMPONENT_SET', 'SECTION'];
      if (!ok.includes(n.type)) {
        throw new Error(`File thumbnail must be FRAME, COMPONENT, COMPONENT_SET, or SECTION (got ${n.type})`);
      }
      await figma.setFileThumbnailNodeAsync(n as FrameNode | ComponentNode | ComponentSetNode | SectionNode);
      return { success: true };
    }

    // ---------- tier 4 ----------
    case 'add_component_property': {
      const n = await getNode(params.componentId);
      if (n.type !== 'COMPONENT' && n.type !== 'COMPONENT_SET') {
        throw new Error(`add_component_property: ${n.type} not allowed`);
      }
      const c = n as ComponentNode | ComponentSetNode;
      const isSlot = params.type === 'SLOT';
      const opts: Record<string, unknown> = {};
      if (params.preferredValues) opts.preferredValues = coerce(params.preferredValues);
      if (typeof params.description === 'string') opts.description = params.description;
      if (params.slotSettings !== undefined) {
        if (!isSlot) throw new Error("slotSettings is only supported for type 'SLOT' properties");
        opts.slotSettings = toSlotSettings(params.slotSettings);
      }
      const propName = c.addComponentProperty(
        String(params.name),
        params.type as ComponentPropertyType,
        // A SLOT has no default value; accept it omitted.
        (params.defaultValue ?? (isSlot ? '' : undefined)) as never,
        Object.keys(opts).length ? opts as any : undefined,
      );
      return { propertyName: propName };
    }
    case 'edit_component_property': {
      const n = await getNode(params.componentId);
      if (n.type !== 'COMPONENT' && n.type !== 'COMPONENT_SET') {
        throw new Error(`edit_component_property: ${n.type} not allowed`);
      }
      const c = n as ComponentNode | ComponentSetNode;
      const patch: Record<string, unknown> = {
        name: params.newName,
        defaultValue: params.defaultValue,
        preferredValues: params.preferredValues,
      };
      // SLOT-only fields (Figma rejects them on other property types).
      if (typeof params.description === 'string') patch.description = params.description;
      if (params.slotSettings !== undefined) patch.slotSettings = toSlotSettings(params.slotSettings);
      const newName = c.editComponentProperty(String(params.propertyName), patch as any);
      return { propertyName: newName };
    }
    case 'delete_component_property': {
      const n = await getNode(params.componentId);
      if (n.type !== 'COMPONENT' && n.type !== 'COMPONENT_SET') {
        throw new Error(`delete_component_property: ${n.type} not allowed`);
      }
      const c = n as ComponentNode | ComponentSetNode;
      c.deleteComponentProperty(String(params.propertyName));
      return { success: true };
    }
    case 'reset_instance_overrides': {
      const n = await getNode(params.nodeId);
      if (n.type !== 'INSTANCE') throw new Error(`Not an INSTANCE: ${params.nodeId}`);
      (n as InstanceNode).resetOverrides();
      return { success: true };
    }
    case 'find_with_criteria': {
      const scope = params.scope ? await getNode(params.scope) : figma.currentPage;
      if (!('findAllWithCriteria' in scope)) throw new Error(`Scope ${scope.type} cannot search`);
      const criteria: any = {};
      if (Array.isArray(params.types) && params.types.length) criteria.types = params.types;
      if (params.pluginData) criteria.pluginData = params.pluginData;
      if (params.sharedPluginData) criteria.sharedPluginData = params.sharedPluginData;
      const out = (scope as any).findAllWithCriteria(criteria) as SceneNode[];
      const max = params.maxResults ?? 200;
      return out.slice(0, max).map((n) => ({
        id: n.id, name: n.name, type: n.type, parentId: n.parent?.id ?? '',
      }));
    }
    case 'get_style_consumers': {
      const s = await figma.getStyleByIdAsync(params.styleId);
      if (!s) throw new Error(`Style not found: ${params.styleId}`);
      const consumers = await (s as any).getStyleConsumersAsync();
      return consumers.map((c: any) => ({
        nodeId: c.node.id,
        nodeName: c.node.name,
        nodeType: c.node.type,
        fields: c.fields,
      }));
    }
    case 'trigger_undo': {
      figma.triggerUndo();
      return { success: true };
    }
    case 'open_external_url': {
      figma.openExternal(String(params.url));
      return { success: true };
    }
    case 'client_storage_get': {
      const v = await figma.clientStorage.getAsync(String(params.key));
      return { key: params.key, value: v ?? null };
    }
    case 'client_storage_set': {
      await figma.clientStorage.setAsync(String(params.key), params.value);
      return { success: true };
    }
    case 'client_storage_delete': {
      await figma.clientStorage.deleteAsync(String(params.key));
      return { success: true };
    }
    case 'client_storage_keys': {
      const keys = await figma.clientStorage.keysAsync();
      return { keys };
    }

    // ---------- tier 5 ----------
    case 'create_slice': {
      const s = figma.createSlice();
      let parent: BaseNode & ChildrenMixin = figma.currentPage;
      if (params.parentId) {
        const p = await getNode(params.parentId);
        if (!hasChildren(p)) throw new Error(`Parent cannot contain children: ${params.parentId}`);
        parent = p;
      }
      parent.appendChild(s);
      if (params.name) s.name = params.name;
      if (typeof params.x === 'number') s.x = params.x;
      if (typeof params.y === 'number') s.y = params.y;
      if (typeof params.width === 'number' && typeof params.height === 'number') {
        s.resize(params.width, params.height);
      }
      return { id: s.id, name: s.name, type: s.type };
    }
    case 'create_text_path': {
      // New Draw signature: createTextPath(pathNode, startSegment, startPosition).
      // The old no-arg form now throws "Expected node".
      const src = await getNode(params.pathNodeId);
      const startSegment = typeof params.startSegment === 'number' ? params.startSegment : 0;
      const startPosition = typeof params.startPosition === 'number' ? params.startPosition : 0;
      const t = (figma as any).createTextPath(src, startSegment, startPosition);
      if (params.parentId) {
        const p = await getNode(params.parentId);
        if (hasChildren(p)) (p as any).appendChild(t);
      }
      if (params.text) {
        await figma.loadFontAsync(t.fontName);
        t.characters = String(params.text);
      }
      return { id: t.id, type: t.type, textPathStartData: t.textPathStartData };
    }
    case 'create_gif': {
      const g = (figma as any).createGif(String(params.imageHash));
      let parent: BaseNode & ChildrenMixin = figma.currentPage;
      if (params.parentId) {
        const p = await getNode(params.parentId);
        if (hasChildren(p)) parent = p;
      }
      parent.appendChild(g);
      if (typeof params.x === 'number') g.x = params.x;
      if (typeof params.y === 'number') g.y = params.y;
      return { id: g.id, type: g.type };
    }
    case 'create_video': {
      const v = await (figma as any).createVideoAsync(base64ToBytes(String(params.base64)));
      let parent: BaseNode & ChildrenMixin = figma.currentPage;
      if (params.parentId) {
        const p = await getNode(params.parentId);
        if (hasChildren(p)) parent = p;
      }
      parent.appendChild(v);
      return { id: v.id, type: v.type };
    }
    case 'create_link_preview': {
      const lp = await (figma as any).createLinkPreviewAsync(String(params.url));
      let parent: BaseNode & ChildrenMixin = figma.currentPage;
      if (params.parentId) {
        const p = await getNode(params.parentId);
        if (hasChildren(p)) parent = p;
      }
      parent.appendChild(lp);
      return { id: lp.id, type: lp.type };
    }
    case 'create_page_divider': {
      const d = (figma as any).createPageDivider(params.name ?? '---');
      return { id: d.id, name: d.name, type: d.type };
    }
    case 'create_slide': {
      const s = (figma as any).createSlide();
      if (params.name) s.name = params.name;
      return { id: s.id, name: s.name, type: s.type };
    }
    case 'create_slide_row': {
      const r = (figma as any).createSlideRow();
      return { id: r.id, type: r.type };
    }
    case 'create_code_block': {
      const cb = (figma as any).createCodeBlock();
      let parent: BaseNode & ChildrenMixin = figma.currentPage;
      if (params.parentId) {
        const p = await getNode(params.parentId);
        if (hasChildren(p)) parent = p;
      }
      parent.appendChild(cb);
      if (params.code) cb.code = String(params.code);
      if (params.language) cb.codeLanguage = params.language;
      return { id: cb.id, type: cb.type };
    }
    case 'timer_start': {
      const t = (figma as any).timer;
      if (!t) throw new Error('Timer only available in FigJam');
      t.start(Number(params.seconds ?? 60));
      return { state: t.state, remaining: t.remaining };
    }
    case 'timer_stop': {
      const t = (figma as any).timer;
      if (!t) throw new Error('Timer only available in FigJam');
      t.stop();
      return { state: t.state };
    }
    case 'timer_pause': {
      const t = (figma as any).timer;
      if (!t) throw new Error('Timer only available in FigJam');
      t.pause();
      return { state: t.state, remaining: t.remaining };
    }
    case 'timer_resume': {
      const t = (figma as any).timer;
      if (!t) throw new Error('Timer only available in FigJam');
      t.resume();
      return { state: t.state, remaining: t.remaining };
    }
    case 'get_active_users': {
      const users = (figma as any).activeUsers ?? [];
      return users.map((u: any) => ({
        id: u.id,
        name: u.name,
        color: u.color,
        sessionId: u.sessionId,
        position: u.position,
      }));
    }
    case 'get_current_user': {
      const u = (figma as any).currentUser;
      if (!u) return null;
      return { id: u.id, name: u.name, color: u.color, sessionId: u.sessionId };
    }

    // ---------- tier 6 ----------
    case 'bind_effect_to_variable': {
      const node = await getNode(params.nodeId);
      const sn = node as any;
      if (!('effects' in node)) throw new Error(`Node ${node.type} has no effects`);
      const v = await figma.variables.getVariableByIdAsync(params.variableId);
      if (!v) throw new Error(`Variable not found: ${params.variableId}`);
      const arr = sn.effects as Effect[];
      const idx = typeof params.effectIndex === 'number' ? params.effectIndex : 0;
      if (idx < 0 || idx >= arr.length) throw new Error(`effectIndex ${idx} out of range (${arr.length})`);
      const updated = (figma.variables as any).setBoundVariableForEffect(arr[idx], params.field, v);
      const next = arr.slice();
      next[idx] = updated;
      sn.effects = next;
      return { success: true };
    }
    case 'bind_layout_grid_to_variable': {
      const node = await getNode(params.nodeId);
      const sn = node as any;
      if (!('layoutGrids' in node)) throw new Error(`Node ${node.type} has no layoutGrids`);
      const v = await figma.variables.getVariableByIdAsync(params.variableId);
      if (!v) throw new Error(`Variable not found: ${params.variableId}`);
      const arr = sn.layoutGrids as LayoutGrid[];
      const idx = typeof params.gridIndex === 'number' ? params.gridIndex : 0;
      if (idx < 0 || idx >= arr.length) throw new Error(`gridIndex ${idx} out of range (${arr.length})`);
      const updated = (figma.variables as any).setBoundVariableForLayoutGrid(arr[idx], params.field, v);
      const next = arr.slice();
      next[idx] = updated;
      sn.layoutGrids = next;
      return { success: true };
    }
    case 'set_explicit_variable_mode': {
      const node = await getNode(params.nodeId);
      const c = await figma.variables.getVariableCollectionByIdAsync(params.collectionId);
      if (!c) throw new Error(`Collection not found: ${params.collectionId}`);
      (node as any).setExplicitVariableModeForCollection(c, String(params.modeId));
      return { success: true };
    }
    case 'clear_explicit_variable_mode': {
      const node = await getNode(params.nodeId);
      const c = await figma.variables.getVariableCollectionByIdAsync(params.collectionId);
      if (!c) throw new Error(`Collection not found: ${params.collectionId}`);
      (node as any).clearExplicitVariableModeForCollection(c);
      return { success: true };
    }
    case 'get_instances': {
      const c = await getNode(params.componentId);
      if (c.type !== 'COMPONENT' && c.type !== 'COMPONENT_SET') {
        throw new Error(`Not a COMPONENT or COMPONENT_SET: ${params.componentId}`);
      }
      const list = await (c as any).getInstancesAsync();
      return list.map((i: InstanceNode) => ({ id: i.id, name: i.name, parentId: i.parent?.id ?? '' }));
    }
    case 'import_component_set_by_key': {
      const cs = await figma.importComponentSetByKeyAsync(String(params.key));
      return { id: cs.id, name: cs.name, key: cs.key };
    }
    case 'outline_stroke': {
      const n = await getNode(params.nodeId);
      const sn = n as any;
      if (typeof sn.outlineStroke !== 'function') throw new Error(`Node ${n.type} cannot outline stroke`);
      const out = sn.outlineStroke();
      if (!out) throw new Error('outlineStroke returned null (likely no stroke to outline)');
      return { id: out.id, name: out.name, type: out.type };
    }
    case 'rescale': {
      const n = await getNode(params.nodeId);
      const sn = n as any;
      if (typeof sn.rescale !== 'function') throw new Error(`Node ${n.type} cannot rescale`);
      sn.rescale(Number(params.factor));
      return { success: true, width: sn.width, height: sn.height };
    }
    case 'lock_aspect_ratio': {
      const n = await getNode(params.nodeId);
      const sn = n as any;
      if (typeof sn.lockAspectRatio !== 'function') throw new Error(`Node ${n.type} cannot lock aspect ratio`);
      sn.lockAspectRatio();
      return { success: true };
    }
    case 'unlock_aspect_ratio': {
      const n = await getNode(params.nodeId);
      const sn = n as any;
      if (typeof sn.unlockAspectRatio !== 'function') throw new Error(`Node ${n.type} cannot unlock aspect ratio`);
      sn.unlockAspectRatio();
      return { success: true };
    }
    case 'edit_dev_resource': {
      const node = await getNode(params.nodeId);
      const sn = node as any;
      if (typeof sn.editDevResourceAsync !== 'function') throw new Error(`Node ${node.type} does not support dev resources`);
      await sn.editDevResourceAsync(String(params.currentUrl), { name: params.name, url: params.url });
      return { success: true };
    }
    case 'add_measurement': {
      const start = await getNode(params.startNodeId);
      const end = await getNode(params.endNodeId);
      const m = await (figma as any).annotations.addMeasurementAsync({
        start: { node: start, side: params.startSide ?? 'TOP' },
        end: { node: end, side: params.endSide ?? 'TOP' },
        offset: coerce(params.offset),
        freeText: params.freeText,
      });
      return { id: m.id };
    }
    case 'edit_measurement': {
      await (figma as any).annotations.editMeasurementAsync(String(params.measurementId), {
        offset: coerce(params.offset),
        freeText: params.freeText,
      });
      return { success: true };
    }
    case 'delete_measurement': {
      await (figma as any).annotations.deleteMeasurementAsync(String(params.measurementId));
      return { success: true };
    }
    case 'get_measurements': {
      const list = await (figma as any).annotations.getMeasurementsAsync();
      return list;
    }
    case 'get_measurements_for_node': {
      const n = await getNode(params.nodeId);
      const list = await (figma as any).annotations.getMeasurementsForNodeAsync(n);
      return list;
    }
    case 'add_annotation_category': {
      const c = await (figma as any).annotations.addAnnotationCategoryAsync({
        label: String(params.label),
        color: coerce(params.color),
      });
      return { id: c.id, label: c.label, color: c.color };
    }
    case 'get_annotation_categories': {
      const cats = await (figma as any).annotations.getAnnotationCategoriesAsync();
      return cats;
    }
    case 'get_annotation_category': {
      const c = await (figma as any).annotations.getAnnotationCategoryByIdAsync(String(params.categoryId));
      return c;
    }
    case 'edit_annotation_category': {
      const patch: { label?: string; color?: unknown } = {};
      if (typeof params.label === 'string') patch.label = params.label;
      if (params.color !== undefined) patch.color = coerce(params.color);
      await (figma as any).annotations.editAnnotationCategoryAsync(String(params.categoryId), patch);
      return { success: true };
    }
    case 'delete_annotation_category': {
      await (figma as any).annotations.deleteAnnotationCategoryAsync(String(params.categoryId));
      return { success: true };
    }
    case 'table_insert_row': {
      const n = await getNode(params.nodeId);
      if (n.type !== 'TABLE') throw new Error(`Not a TABLE: ${params.nodeId}`);
      const t = n as TableNode;
      const idx = typeof params.index === 'number' ? params.index : t.numRows;
      t.insertRow(idx);
      return { success: true, numRows: t.numRows };
    }
    case 'table_insert_column': {
      const n = await getNode(params.nodeId);
      if (n.type !== 'TABLE') throw new Error(`Not a TABLE: ${params.nodeId}`);
      const t = n as TableNode;
      const idx = typeof params.index === 'number' ? params.index : t.numColumns;
      t.insertColumn(idx);
      return { success: true, numColumns: t.numColumns };
    }
    case 'table_remove_row': {
      const n = await getNode(params.nodeId);
      if (n.type !== 'TABLE') throw new Error(`Not a TABLE: ${params.nodeId}`);
      (n as TableNode).removeRow(Number(params.index));
      return { success: true };
    }
    case 'table_remove_column': {
      const n = await getNode(params.nodeId);
      if (n.type !== 'TABLE') throw new Error(`Not a TABLE: ${params.nodeId}`);
      (n as TableNode).removeColumn(Number(params.index));
      return { success: true };
    }
    case 'table_move_row': {
      const n = await getNode(params.nodeId);
      if (n.type !== 'TABLE') throw new Error(`Not a TABLE: ${params.nodeId}`);
      (n as TableNode).moveRow(Number(params.fromIndex), Number(params.toIndex));
      return { success: true };
    }
    case 'table_move_column': {
      const n = await getNode(params.nodeId);
      if (n.type !== 'TABLE') throw new Error(`Not a TABLE: ${params.nodeId}`);
      (n as TableNode).moveColumn(Number(params.fromIndex), Number(params.toIndex));
      return { success: true };
    }
    case 'reorder_grid_tracks': {
      // Multi-track reorder on a GRID auto-layout frame (GridLayoutMixin).
      // insertionIndex is evaluated against the ORIGINAL order (0..count inclusive).
      const axis = params.axis === 'columns' ? 'columns' : params.axis === 'rows' ? 'rows' : null;
      if (!axis) throw new Error("axis must be 'rows' or 'columns'");
      const fn = axis === 'rows' ? 'reorderRows' : 'reorderColumns';
      const n = await getNode(params.nodeId);
      const from = asIndexList(params.fromIndices, 'fromIndices');
      const ins = Number(params.insertionIndex);
      if (!Number.isInteger(ins) || ins < 0) throw new Error('insertionIndex must be a non-negative integer');
      if (typeof (n as any)[fn] !== 'function') {
        throw new Error(n.type === 'TABLE'
          ? `${fn} is for GRID auto-layout frames — use table_op move_${axis === 'rows' ? 'row' : 'column'} for FigJam tables`
          : `${fn} requires a frame with layoutMode 'GRID', got ${n.type}`);
      }
      const moves = (n as any)[fn]({ fromIndices: from, insertionIndex: ins });
      return { success: true, moves: Array.from(moves ?? []).map((m: any) => ({ from: m.from, to: m.to })) };
    }
    case 'table_cell_at': {
      const n = await getNode(params.nodeId);
      if (n.type !== 'TABLE') throw new Error(`Not a TABLE: ${params.nodeId}`);
      const cell = (n as TableNode).cellAt(Number(params.row), Number(params.column)) as any;
      return { id: cell.id ?? null, type: cell.type ?? 'TABLE_CELL', text: cell.text?.characters };
    }
    case 'slides_get_canvas_grid': {
      const grid = (figma as any).getCanvasGrid?.();
      return grid ?? null;
    }
    case 'slides_set_canvas_grid': {
      (figma as any).setCanvasGrid?.(coerce(params.grid));
      return { success: true };
    }
    case 'slides_create_canvas_row': {
      const r = (figma as any).createCanvasRow?.();
      return r ? { id: r.id, type: r.type } : null;
    }
    case 'slides_move_nodes_to_coord': {
      const ids: string[] = asIds(params.nodeIds);
      const nodes: SceneNode[] = [];
      for (const id of ids) {
        const node = await getNode(id);
        if ('parent' in node) nodes.push(node as SceneNode);
      }
      (figma as any).moveNodesToCoord?.(nodes, { row: params.row, column: params.column });
      return { success: true };
    }
    case 'set_slide_transition': {
      const n = await getNode(params.nodeId);
      const sn = n as any;
      if (typeof sn.setSlideTransition !== 'function') throw new Error(`Node ${n.type} has no slide transition`);
      sn.setSlideTransition(coerce(params.transition));
      return { success: true };
    }
    case 'get_slide_transition': {
      const n = await getNode(params.nodeId);
      const sn = n as any;
      if (typeof sn.getSlideTransition !== 'function') throw new Error(`Node ${n.type} has no slide transition`);
      return sn.getSlideTransition();
    }
    case 'ui_show': {
      figma.ui.show();
      return { success: true };
    }
    case 'ui_hide': {
      figma.ui.hide();
      return { success: true };
    }
    case 'ui_resize': {
      figma.ui.resize(Number(params.width), Number(params.height));
      return { success: true };
    }
    case 'ui_reposition': {
      figma.ui.reposition(Number(params.x), Number(params.y));
      return { success: true };
    }
    case 'set_relaunch_data': {
      const n = await getNode(params.nodeId);
      n.setRelaunchData(coerce<Record<string, string>>(params.data));
      return { success: true };
    }
    case 'get_relaunch_data': {
      const n = await getNode(params.nodeId);
      return (n as any).getRelaunchData?.() ?? {};
    }
    case 'get_top_level_frame': {
      const n = await getNode(params.nodeId);
      const top = (n as any).getTopLevelFrame?.();
      return top ? { id: top.id, name: top.name, type: top.type } : null;
    }
    case 'get_text_content': {
      const n = await getNode(params.nodeId);
      const out: Array<{ id: string; characters: string }> = [];
      walk(n, (x) => {
        if (x.type === 'TEXT') out.push({ id: x.id, characters: (x as TextNode).characters });
      });
      return out;
    }
    case 'get_image_by_hash': {
      const img = figma.getImageByHash(String(params.imageHash));
      if (!img) return null;
      const [bytes, size] = await Promise.all([
        img.getBytesAsync(),
        img.getSizeAsync().catch(() => null),
      ]);
      return {
        hash: img.hash,
        bytesLength: bytes.length,
        size,
        base64: bytesToBase64(bytes),
      };
    }
    case 'get_stamp_author': {
      const n = await getNode(params.nodeId);
      if (n.type !== 'STAMP') throw new Error(`Not a STAMP: ${params.nodeId}`);
      const u = await (n as any).getAuthorAsync();
      return u;
    }
    case 'get_overrides': {
      const n = await getNode(params.nodeId);
      if (n.type !== 'INSTANCE') throw new Error(`Not an INSTANCE: ${params.nodeId}`);
      return (n as InstanceNode).overrides;
    }
    case 'get_publish_status': {
      const id = String(params.id);
      let target: any = null;
      try { target = await figma.getStyleByIdAsync(id); } catch {}
      if (!target) {
        try { target = await figma.variables.getVariableByIdAsync(id); } catch {}
      }
      if (!target) {
        try { target = await figma.variables.getVariableCollectionByIdAsync(id); } catch {}
      }
      // Components / component sets: plain node ids ("12:34"). Other id shapes were handled above,
      // and getNode on an unknown id burns its 8s hang-guard, so only try real node-id shapes.
      if (!target && /^[0-9:;-]+$/.test(id)) {
        try { target = await getNode(id); } catch {}
      }
      if (!target) throw new Error(`No style, variable, variable collection, component or component set found for id: ${id}`);
      if (typeof target.getPublishStatusAsync !== 'function') {
        throw new Error(`${target.type ?? 'This node'} has no publish status (components and component sets only)`);
      }
      const status = await target.getPublishStatusAsync();
      return { id, status };
    }
    case 'set_text_range_bound_variable': {
      const n = await getNode(params.nodeId);
      if (n.type !== 'TEXT') throw new Error(`Not a TEXT: ${params.nodeId}`);
      const t = n as TextNode;
      const start = Number(params.start);
      const end = Number(params.end);
      const fonts = t.getRangeAllFontNames(start, end);
      await Promise.all(fonts.map((f) => figma.loadFontAsync(f)));
      const v = params.variableId
        ? await figma.variables.getVariableByIdAsync(String(params.variableId))
        : null;
      (t as any).setRangeBoundVariable(start, end, params.field, v);
      return { success: true };
    }
    case 'get_text_range_bound_variable': {
      const n = await getNode(params.nodeId);
      if (n.type !== 'TEXT') throw new Error(`Not a TEXT: ${params.nodeId}`);
      const v = (n as any).getRangeBoundVariable(Number(params.start), Number(params.end), params.field);
      return v ? { variableId: v.id, name: v.name } : null;
    }
    case 'insert_characters': {
      const n = await getNode(params.nodeId);
      if (n.type !== 'TEXT') throw new Error(`Not a TEXT: ${params.nodeId}`);
      const t = n as TextNode;
      const fn = t.fontName === figma.mixed ? { family: 'Inter', style: 'Regular' } : (t.fontName as FontName);
      await figma.loadFontAsync(fn);
      t.insertCharacters(Number(params.start), String(params.characters), params.behavior);
      return { success: true, length: t.characters.length };
    }
    case 'delete_characters': {
      const n = await getNode(params.nodeId);
      if (n.type !== 'TEXT') throw new Error(`Not a TEXT: ${params.nodeId}`);
      const t = n as TextNode;
      const fn = t.fontName === figma.mixed ? { family: 'Inter', style: 'Regular' } : (t.fontName as FontName);
      await figma.loadFontAsync(fn);
      t.deleteCharacters(Number(params.start), Number(params.end));
      return { success: true, length: t.characters.length };
    }
    case 'get_attached_connectors': {
      const n = await getNode(params.nodeId);
      const list = (n as any).attachedConnectors ?? [];
      return list.map((c: ConnectorNode) => ({ id: c.id, name: c.name }));
    }
    case 'set_skip_invisible_instance_children': {
      figma.skipInvisibleInstanceChildren = Boolean(params.value);
      return { success: true, value: figma.skipInvisibleInstanceChildren };
    }
    case 'get_file_thumbnail_node': {
      const n = await figma.getFileThumbnailNodeAsync();
      return n ? { id: n.id, name: n.name, type: n.type } : null;
    }
    case 'load_brushes': {
      const list = await (figma as any).loadBrushesAsync?.();
      return list ?? [];
    }

    // ---------- tier 7 ----------
    case 'extend_library_collection_by_key': {
      // The API needs (collectionKey, name); Enterprise plan only.
      const name = typeof params.name === 'string' && params.name ? params.name : 'Extended collection';
      const c = await (figma.variables as any).extendLibraryCollectionByKeyAsync(String(params.key), name);
      return { id: c?.id, name: c?.name, ...serializeCollectionExtension(c) };
    }
    case 'extend_variable_collection': {
      // Extend a LOCAL collection (Enterprise plan only).
      const base = await figma.variables.getVariableCollectionByIdAsync(String(params.collectionId));
      if (!base) throw new Error(`Collection not found: ${params.collectionId}`);
      if (!params.name || typeof params.name !== 'string') throw new Error('name is required');
      const c = (base as any).extend(params.name);
      return { id: c.id, name: c.name, ...serializeCollectionExtension(c) };
    }
    case 'remove_variable_overrides': {
      const c = await figma.variables.getVariableCollectionByIdAsync(String(params.collectionId));
      if (!c) throw new Error(`Collection not found: ${params.collectionId}`);
      if (!(c as any).isExtension) throw new Error(`Not an extended collection: ${params.collectionId} (only extended collections have overrides)`);
      const v = await figma.variables.getVariableByIdAsync(String(params.variableId));
      if (!v) throw new Error(`Variable not found: ${params.variableId}`);
      (c as any).removeOverridesForVariable(v);
      return { success: true };
    }
    case 'list_library_variables': {
      // Browse connected libraries: no key -> the variable collections available to this
      // file; with `collectionKey` -> the variables inside that collection (use their
      // `key` with import_variable_by_key).
      const tl = (figma as any).teamLibrary;
      if (!tl) throw new Error('figma.teamLibrary is not available in this Figma version');
      if (typeof params.collectionKey === 'string' && params.collectionKey) {
        const vars = await tl.getVariablesInLibraryCollectionAsync(params.collectionKey);
        return { collectionKey: params.collectionKey, variables: vars.map((v: any) => ({ name: v.name, key: v.key, resolvedType: v.resolvedType })) };
      }
      const cols = await tl.getAvailableLibraryVariableCollectionsAsync();
      return { collections: cols.map((c: any) => ({ name: c.name, key: c.key, libraryName: c.libraryName })) };
    }
    case 'request_variable_to_be_enabled': {
      const v = await figma.variables.getVariableByIdAsync(String(params.variableId));
      if (!v) throw new Error(`Variable not found: ${params.variableId}`);
      await (v as any).requestToBeEnabledAsync();
      return { success: true };
    }
    case 'request_variable_to_be_disabled': {
      const v = await figma.variables.getVariableByIdAsync(String(params.variableId));
      if (!v) throw new Error(`Variable not found: ${params.variableId}`);
      await (v as any).requestToBeDisabledAsync();
      return { success: true };
    }
    case 'table_resize_row': {
      const n = await getNode(params.nodeId);
      if (n.type !== 'TABLE') throw new Error(`Not a TABLE: ${params.nodeId}`);
      (n as TableNode).resizeRow(Number(params.index), Number(params.height));
      return { success: true };
    }
    case 'table_resize_column': {
      const n = await getNode(params.nodeId);
      if (n.type !== 'TABLE') throw new Error(`Not a TABLE: ${params.nodeId}`);
      (n as TableNode).resizeColumn(Number(params.index), Number(params.width));
      return { success: true };
    }
    case 'create_slot': {
      const c = await getNode(params.componentId);
      if (c.type !== 'COMPONENT') throw new Error(`createSlot requires COMPONENT, got ${c.type}`);
      const comp = c as ComponentNode;
      const slotKeys = (): string[] => {
        try {
          return Object.entries((comp as any).componentPropertyDefinitions ?? {})
            .filter(([, d]: [string, any]) => d?.type === 'SLOT').map(([k]) => k);
        } catch { return []; }
      };
      const before = new Set(slotKeys());
      const slot = comp.createSlot() as any;
      if (params.name) slot.name = params.name;
      const out: any = { id: slot.id, name: slot.name, type: slot.type };
      // Optional SLOT-property config, applied to the property createSlot() just made.
      const wantEdit = params.slotSettings !== undefined || params.preferredValues !== undefined || typeof params.description === 'string';
      if (wantEdit) {
        const fresh = slotKeys().filter((k) => !before.has(k));
        const propName = typeof params.propertyName === 'string' ? params.propertyName
          : (fresh.length === 1 ? fresh[0] : (slot.componentPropertyReferences?.slot as string | undefined));
        if (!propName) {
          out.slotSettingsApplied = false;
          out.warning = 'slot created, but its SLOT property could not be identified — call component_property op=edit with the propertyName from get_node componentPropertyDefinitions';
        } else {
          const patch: Record<string, unknown> = {};
          if (params.slotSettings !== undefined) patch.slotSettings = toSlotSettings(params.slotSettings);
          if (params.preferredValues !== undefined) patch.preferredValues = coerce(params.preferredValues);
          if (typeof params.description === 'string') patch.description = params.description;
          out.propertyName = comp.editComponentProperty(propName, patch as any);
          out.slotSettingsApplied = true;
        }
      }
      return out;
    }
    case 'set_grid_child_position': {
      const n = await getNode(params.nodeId);
      if (!('setGridChildPosition' in n)) {
        throw new Error(`Node ${params.nodeId} (${n.type}) is not a grid child`);
      }
      (n as any).setGridChildPosition(Number(params.row), Number(params.column));
      return { success: true };
    }
    case 'map_nodes': {
      // Grip-owned bulk loop: resolve a bounded node set (findNodes → typed
      // findAllWithCriteria or a scoped subtree — never a page-wide freeze) and
      // apply `set`/`delete`/`rename`/`swap`/`applyStyle` in yielding chunks.
      // No agent JS, so it can't wedge.
      const q = coerce(params.query) as NodeQuery;
      const setProps = params.set ? (coerce(params.set) as Record<string, any>) : null;
      const doDelete = params.delete === true;
      const rn = params.rename ? (coerce(params.rename) as { find: string; replace: string; regex?: boolean }) : null;
      const sw = params.swap ? (coerce(params.swap) as { componentKey?: string; componentId?: string }) : null;
      const st = params.applyStyle ? (coerce(params.applyStyle) as { styleId: string; type?: string }) : null;
      if (!setProps && !doDelete && !rn && !sw && !st) {
        throw new Error("map_nodes needs `set` (a property→value map), `delete:true`, `rename`, `swap`, or `applyStyle`.");
      }
      const budget = typeof params.budget === 'number' && params.budget > 0 ? params.budget : 10000;
      const chunk = typeof params.chunk === 'number' && params.chunk > 0 ? params.chunk : 200;
      const nodes = await findNodes(q);
      const matched = nodes.length;
      // Resolve the swap target once up front (not per-node) — avoids
      // re-importing/re-fetching the same component for every matched instance.
      let swapTarget: ComponentNode | null = null;
      if (sw) {
        if (!sw.componentKey && !sw.componentId) throw new Error('map_nodes swap needs `componentKey` or `componentId`.');
        const resolved = sw.componentKey ? await figma.importComponentByKeyAsync(sw.componentKey) : await getNode(sw.componentId!);
        if (resolved.type !== 'COMPONENT') throw new Error(`Swap target not a COMPONENT: ${sw.componentKey ?? sw.componentId}`);
        swapTarget = resolved as ComponentNode;
      }
      let applied = 0;
      await forEachNode(nodes, async (n) => {
        let acted = false;
        if (doDelete) { n.remove(); applied++; return; }
        if (setProps) {
          for (const prop of Object.keys(setProps)) await applyProperty(n as SceneNode, prop, setProps[prop]);
          acted = true;
        }
        if (rn) {
          n.name = rn.regex ? n.name.replace(new RegExp(rn.find, 'g'), rn.replace) : n.name.split(rn.find).join(rn.replace);
          acted = true;
        }
        if (swapTarget && n.type === 'INSTANCE') {
          (n as InstanceNode).swapComponent(swapTarget);
          acted = true;
        }
        if (st) {
          // dynamic-page access makes fillStyleId/strokeStyleId/effectStyleId/
          // gridStyleId/textStyleId READ-ONLY — must go through the async
          // setter. Mirrors apply_style's exact branching (code.ts:1495-1529),
          // not applyProperty's sync PASSTHROUGH assignment.
          const sn = n as any;
          const slotProp = st.type === 'text' ? 'textStyleId'
            : st.type === 'effect' ? 'effectStyleId'
            : st.type === 'grid' ? 'gridStyleId'
            : st.type === 'stroke' ? 'strokeStyleId'
            : 'fillStyleId';
          // Node lacks this style slot (e.g. a LINE has no fillStyleId) —
          // skip without setting `acted`, so it isn't miscounted as applied.
          if (slotProp in sn) {
            if (st.type === 'text') {
              if ('setTextStyleIdAsync' in sn) await sn.setTextStyleIdAsync(st.styleId);
              else sn.textStyleId = st.styleId;
            } else if (st.type === 'effect') {
              if ('setEffectStyleIdAsync' in sn) await sn.setEffectStyleIdAsync(st.styleId);
              else sn.effectStyleId = st.styleId;
            } else if (st.type === 'grid') {
              if ('setGridStyleIdAsync' in sn) await sn.setGridStyleIdAsync(st.styleId);
              else sn.gridStyleId = st.styleId;
            } else if (st.type === 'stroke') {
              if ('setStrokeStyleIdAsync' in sn) await sn.setStrokeStyleIdAsync(st.styleId);
              else sn.strokeStyleId = st.styleId;
            } else {
              if ('setFillStyleIdAsync' in sn) await sn.setFillStyleIdAsync(st.styleId);
              else sn.fillStyleId = st.styleId;
            }
            acted = true;
          }
        }
        if (acted) applied++;
      }, { budget, chunk });
      return {
        matched,
        applied,
        truncated: matched > applied,   // more matched than the budget allowed — re-run or raise budget
        limitations: matched > applied
          ? [`Applied to ${applied} of ${matched} matched nodes (budget ${budget}); PARTIAL. Raise budget or narrow query, then re-run.`]
          : [],
      };
    }
    case 'list_shaders': {
      const list = await (figma as any).listAvailableShaders();
      return (list ?? []).map((s: any) => plainData(s));
    }
    case 'import_shader': {
      const s = await (figma as any).importShaderById(params.shaderId);
      return plainData(s);
    }
    // ---------- Motion (native keyframe/timeline animation) ----------
    case 'list_animation_styles': {
      const styles = (figma as any).motion.figmaAnimationStyles();
      // Each preset self-describes its `props`; note the props DESCRIPTOR is
      // not the applyAnimationStyle input schema (which is stricter).
      return (styles ?? []).map((s: any) => plainData(s));
    }
    case 'get_animations': {
      const n = (await getNode(params.nodeId)) as any;
      return {
        animationStyles: plainData(n.animationStyles),
        animations: plainData(n.animations),
        manualKeyframeTracks: plainData(n.manualKeyframeTracks),
        timelines: plainData(n.timelines),
      };
    }
    case 'apply_animation_style': {
      const n = (await getNode(params.nodeId)) as any;
      if (typeof n.applyAnimationStyle !== 'function') throw new Error(`Node ${params.nodeId} (${n.type}) is not animatable`);
      // Forward presetData verbatim — Figma validates it per-preset and its
      // error is surfaced to the caller.
      const cfg: any = coerce(params.props) ?? {};
      // A CUSTOM animation style (create op) is applied with {type:'CUSTOM'}.
      // Inject it when the caller passed a custom style id and no explicit type.
      if (cfg && typeof cfg === 'object' && cfg.type === undefined && typeof params.styleId === 'string' && params.styleId.startsWith('S:')) {
        try {
          const st = await figma.getStyleByIdAsync(params.styleId);
          if (st && (st as any).type === 'CUSTOM_ANIMATION') cfg.type = 'CUSTOM';
        } catch {}
      }
      const appliedId = n.applyAnimationStyle(params.styleId, cfg);
      return { success: true, id: appliedId };
    }
    case 'remove_animation_style': {
      const n = (await getNode(params.nodeId)) as any;
      // Takes the APPLIED-INSTANCE id (animationStyles[].id from get_animations),
      // not the preset styleId passed to apply_animation_style.
      n.removeAnimationStyle(params.id);
      return { success: true };
    }
    // ---------- Motion: custom animation styles (Figma update 140) ----------
    case 'create_custom_animation_style': {
      const style = (figma as any).createCustomAnimationStyle();
      // Roll the half-built style back if any step fails, so errors don't leave orphans.
      try {
        if (typeof params.name === 'string') style.name = params.name;
        if (typeof params.description === 'string') style.description = params.description;
        const entries = Array.isArray(params.entries) ? params.entries : [];
        for (const e of entries) {
          const entryStyleId = typeof e === 'string' ? e : e?.styleId;
          if (typeof entryStyleId !== 'string') throw new Error('create: each entries[] item needs a styleId (from list_animation_styles)');
          await style.addAnimationEntryAsync(entryStyleId, typeof e === 'string' ? undefined : coerce(e.props));
        }
      } catch (err) {
        try { style.remove(); } catch {}
        throw err;
      }
      return serializeCustomAnimationStyle(style);
    }
    case 'list_custom_animation_styles': {
      const styles = await (figma as any).getLocalCustomAnimationStylesAsync();
      return (styles ?? []).map(serializeCustomAnimationStyle);
    }
    case 'update_custom_animation_style': {
      const style = await getCustomAnimationStyle(params.styleId);
      if (typeof params.name === 'string') style.name = params.name;
      if (typeof params.description === 'string') style.description = params.description;
      return serializeCustomAnimationStyle(style);
    }
    case 'move_custom_animation_style': {
      const style = await getCustomAnimationStyle(params.styleId);
      const after = params.afterStyleId ? await getCustomAnimationStyle(params.afterStyleId) : null;
      // Target and reference must live in the same folder; null → first in folder.
      (figma as any).moveLocalCustomAnimationStyleAfter(style, after);
      return { success: true };
    }
    case 'move_custom_animation_folder': {
      if (typeof params.folder !== 'string' || !params.folder) throw new Error("move_folder: 'folder' (full '/'-delimited folder name) is required");
      (figma as any).moveLocalCustomAnimationFolderAfter(params.folder, params.afterFolder ? String(params.afterFolder) : null);
      return { success: true };
    }
    case 'add_animation_entry': {
      const style = await getCustomAnimationStyle(params.styleId);
      if (typeof params.entryStyleId !== 'string' || !params.entryStyleId) throw new Error("add_entry: 'entryStyleId' (a styleId from list_animation_styles) is required");
      const entry = await style.addAnimationEntryAsync(params.entryStyleId, coerce(params.props));
      return { entry: plainData(entry), style: serializeCustomAnimationStyle(style) };
    }
    case 'remove_animation_entry': {
      const style = await getCustomAnimationStyle(params.styleId);
      style.removeAnimationEntry(String(params.entryId));
      return serializeCustomAnimationStyle(style);
    }
    case 'apply_manual_keyframe_track': {
      const n = (await getNode(params.nodeId)) as any;
      if (typeof n.applyManualKeyframeTrack !== 'function') throw new Error(`Node ${params.nodeId} (${n.type}) is not animatable`);
      // Two args: field descriptor + the keyframe track. `field` is
      // {type:'PROPERTY',name} or {type:'INDEXED_ITEM',collection,index,field};
      // `track` is {keyframes:[{timelinePosition, value:{type,value}, easing?}]}.
      n.applyManualKeyframeTrack(coerce(params.field), coerce(params.track));
      return { success: true };
    }
    case 'remove_manual_keyframe_track': {
      const n = (await getNode(params.nodeId)) as any;
      // Removes by the same field descriptor apply took.
      n.removeManualKeyframeTrack(coerce(params.field));
      return { success: true };
    }
    case 'set_timeline_duration': {
      const n = (await getNode(params.nodeId)) as any;
      if (typeof n.setTimelineDuration !== 'function') throw new Error(`Node ${params.nodeId} (${n.type}) has no timeline`);
      // (timelineId, durationSeconds) — timelineId from get_animations timelines[].id.
      n.setTimelineDuration(params.timelineId, Number(params.duration));
      return { success: true };
    }
    case 'spring_to_normalized': {
      return plainData((figma as any).motion.physicalSpringToNormalized(coerce(params.spring)));
    }
    case 'get_library_usage': {
      const breathe = () => new Promise((r) => setTimeout(r, 0));
      const styleIdProps = ['fillStyleId', 'strokeStyleId', 'effectStyleId', 'gridStyleId', 'textStyleId'];
      const batchResolveCap = typeof params.maxResolve === 'number' && params.maxResolve > 0 ? params.maxResolve : 1500;
      const TIME_BUDGET_MS = 45000;  // stop well before the 60s WS timeout

      // Resume an in-progress scan, or start a new one (walk the tree ONCE and
      // cache node refs so later pages don't re-walk).
      let scanId: string;
      let scan: LibScan;
      const firstCall = !(typeof params.cursor === 'string' && params.cursor);
      if (!firstCall) {
        scanId = params.cursor;
        const existing = _libScans.get(scanId);
        if (!existing) {
          throw new Error(`get_library_usage: cursor '${scanId}' expired or unknown (the Figma plugin likely reloaded mid-scan). Restart the scan by calling again WITHOUT a cursor.`);
        }
        scan = existing;
      } else {
        const scope = params.scope === 'document' ? 'document' : 'page';
        let root: BaseNode;
        if (scope === 'document') { await figma.loadAllPagesAsync(); root = figma.root; }
        else root = figma.currentPage;
        const nodes = (root as any).findAll(() => true) as BaseNode[];
        scanId = `libscan-${++_libScanSeq}`;
        scan = { nodes, i: 0, scope, styleSeen: new Set<string>(), startedAt: Date.now() };
        _libScans.set(scanId, scan);
        // Prune: keep at most a few concurrent scans.
        if (_libScans.size > 4) { const oldest = _libScans.keys().next().value as string; if (oldest !== scanId) _libScans.delete(oldest); }
      }

      // variableLibraries — the ONLY item type whose source library FILENAME the
      // plugin API exposes. Cheap + complete; return on the first page only.
      let variableLibraries: Record<string, string[]> | undefined;
      if (firstCall) {
        variableLibraries = {};
        try {
          const cols = await (figma as any).teamLibrary.getAvailableLibraryVariableCollectionsAsync();
          for (const c of cols) (variableLibraries[c.libraryName] = variableLibraries[c.libraryName] || []).push(c.name);
        } catch (e) { /* teamLibrary unavailable */ }
      }

      // Process a batch window of the cached node list, bounded by resolve count
      // and wall-clock so one call never trips the timeout.
      const comps = new Map<string, string>();
      const styles: Array<{ name: string; key: string; type: string }> = [];
      const t0 = Date.now();
      let resolves = 0, processed = 0;
      const nodes = scan.nodes;
      while (scan.i < nodes.length) {
        if (resolves >= batchResolveCap) break;
        if (Date.now() - t0 > TIME_BUDGET_MS) break;
        const n = nodes[scan.i] as any;
        scan.i++; processed++;
        for (const p of styleIdProps) {
          const id = n[p];
          if (id && typeof id === 'string' && !scan.styleSeen.has(id)) {
            scan.styleSeen.add(id);
            try { const st = await figma.getStyleByIdAsync(id); if (st && (st as any).remote) styles.push({ name: st.name, key: st.key, type: st.type }); } catch (e) {}
          }
        }
        if (n.type === 'INSTANCE') {
          try { const mc = await n.getMainComponentAsync(); resolves++; if (mc && (mc as any).remote) comps.set(mc.key, mc.name); } catch (e) {}
        }
        if (processed % 300 === 0) await breathe();
      }
      const done = scan.i >= nodes.length;
      if (done) _libScans.delete(scanId);

      const out: any = {
        scope: scan.scope,
        complete: done,
        nextCursor: done ? null : scanId,   // loop until null → union is COMPLETE
        remoteComponents: Array.from(comps, ([key, name]) => ({ name, key })),  // key+name only — no source filename
        remoteStyles: styles,                                                    // key+name+type — no source filename
        progress: { scanned: scan.i, total: nodes.length },
        limitations: [
          "Not done until nextCursor is null — keep calling with cursor:nextCursor and UNION remoteComponents/remoteStyles by key across pages (items may repeat across pages).",
          "Source library FILENAMES are available ONLY for variables (variableLibraries, returned on the first page). For components/styles the plugin API exposes only key + name — NOT the source library file. Use the Figma REST API GET /v1/files/:key for that attribution.",
          "An item name may look path-like (e.g. 'header/status_bar') but that is the item's own name, not a library filename.",
          "variableLibraries lists ENABLED libraries only; a variable whose source library is disabled is not attributed.",
          "A cursor is invalidated if the Figma plugin reloads mid-scan — you'll get an explicit error to restart (never a silent partial).",
        ],
      };
      if (firstCall) out.variableLibraries = variableLibraries;
      return out;
    }
    case 'transform_group': {
      const ids = asIds(params.nodeIds);
      const nodes: SceneNode[] = [];
      for (const id of ids) nodes.push((await getNode(id)) as SceneNode);
      let parent: BaseNode & ChildrenMixin = figma.currentPage;
      if (params.parentId) {
        const p = await getNode(params.parentId);
        if (hasChildren(p)) parent = p;
      }
      const idx = typeof params.index === 'number' ? params.index : (parent as any).children.length;
      // modifiers is a required array (empty = plain transform group).
      const modifiers = params.transformModifiers ? coerce(params.transformModifiers) : [];
      const tg = (figma as any).transformGroup(nodes, parent, idx, modifiers);
      return { id: tg.id, name: tg.name, type: tg.type };
    }
    case 'run_script': {
      // Compile + run arbitrary JS inside the plugin sandbox. Trades
      // safety for throughput: scripts that loop over thousands of nodes
      // beat N MCP round-trips. Same trust level as any other write tool.
      //
      // Scope provided:
      //   args                — caller-supplied object/value
      //   figma               — Figma Plugin API
      //   serializeNode(n,o)  — same helper get_node uses
      //   coerce(v) / asIds(v)— sanitize string-ish inputs
      //   log(...args)        — collected, returned alongside result
      //   getNode(id)         — async lookup helper
      const code = String(params.code ?? '');
      // Inspect the submitted code and push back on patterns that would freeze
      // Figma's single main thread — with a message that teaches the better way.
      const rejection = inspectScript(code);
      if (rejection) {
        throw new Error(`run_script_rejected: ${rejection}`);
      }
      const scriptArgs = coerce(params.args);
      const logs: string[] = [];
      const log = (...a: unknown[]) => {
        const line = a.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(' ');
        logs.push(line);
        // Stream each line so the bridge holds it even if this script later
        // times out — a timed-out run_script otherwise loses all its logs (the
        // completing-late response is discarded), leaving the agent blind to
        // how far a partial mutation got.
        if (reqId) { try { figma.ui.postMessage({ kind: 'scriptLog', id: reqId, line }); } catch {} }
      };
      const t0 = Date.now();
      resetYieldClock();  // don't charge a real (throttled) yield to this script's first work window
      let result: unknown;
      try {
        // Injected scope carries the gentle bulk-iteration helpers so the safe
        // path is a one-liner (findNodes / forEachNode / mapNodes / yieldNow),
        // plus a fast getNode that won't hang on a removed id.
        const fn = new Function(
          'args', 'figma', 'serializeNode', 'coerce', 'asIds', 'log', 'getNode',
          'findNodes', 'forEachNode', 'mapNodes', 'yieldNow',
          `return (async () => { ${code} })()`,
        );
        result = await fn(
          scriptArgs, figma, serializeNode, coerce, asIds, log, getNode,
          findNodes, forEachNode, mapNodes, yieldNow,
        );
      } catch (err) {
        throw new Error(`run_script failed: ${(err as Error).message}`);
      }
      // Force serialization through JSON to surface non-JSON values early.
      let serialized: unknown;
      try {
        serialized = JSON.parse(JSON.stringify(result ?? null));
      } catch (err) {
        throw new Error(`run_script result not JSON-serializable: ${(err as Error).message}`);
      }
      return { result: serialized, logs, ms: Date.now() - t0 };
    }
    case 'set_buzz_asset_type': {
      const n = await getNode(params.nodeId);
      (figma as any).setBuzzAssetTypeForNode?.(n, params.assetType);
      return { success: true };
    }
    case 'get_buzz_asset_type': {
      const n = await getNode(params.nodeId);
      const t = (figma as any).getBuzzAssetTypeForNode?.(n);
      return { assetType: t ?? null };
    }
    case 'move_local_style': {
      const s = await figma.getStyleByIdAsync(String(params.styleId));
      if (!s) throw new Error(`Style not found: ${params.styleId}`);
      const after = params.afterStyleId
        ? await figma.getStyleByIdAsync(String(params.afterStyleId))
        : null;
      const map: Record<string, string> = {
        PAINT: 'moveLocalPaintStyleAfter',
        TEXT: 'moveLocalTextStyleAfter',
        EFFECT: 'moveLocalEffectStyleAfter',
        GRID: 'moveLocalGridStyleAfter',
      };
      const fn = (figma as any)[map[s.type]];
      if (!fn) throw new Error(`No move function for style type ${s.type}`);
      fn(s, after);
      return { success: true };
    }
    case 'delete_style': {
      const s = await figma.getStyleByIdAsync(String(params.styleId));
      if (!s) throw new Error(`Style not found: ${params.styleId}`);
      s.remove();
      return { success: true };
    }

    // ---------- variants + paint variable binding ----------
    case 'combine_as_variants': {
      const ids: string[] = asIds(params.nodeIds);
      if (ids.length < 2) throw new Error('combine_as_variants: need ≥2 components');
      const comps: ComponentNode[] = [];
      for (const id of ids) {
        const n = await getNode(id);
        if (n.type !== 'COMPONENT') throw new Error(`Not a COMPONENT: ${id} (${n.type})`);
        comps.push(n as ComponentNode);
      }
      const parent = params.parentId
        ? (await getNode(params.parentId)) as BaseNode & ChildrenMixin
        : (comps[0].parent as BaseNode & ChildrenMixin) ?? figma.currentPage;
      const set = typeof params.index === 'number'
        ? figma.combineAsVariants(comps, parent, params.index)
        : figma.combineAsVariants(comps, parent);
      if (params.name) set.name = params.name;
      return { id: set.id, name: set.name, type: set.type };
    }
    case 'bind_paint_to_variable': {
      const node = await getNode(params.nodeId);
      const sn = node as any;
      const paintField: 'fills' | 'strokes' = params.paintField === 'strokes' ? 'strokes' : 'fills';
      if (!(paintField in node)) throw new Error(`Node ${node.type} has no ${paintField}`);
      const v = await figma.variables.getVariableByIdAsync(params.variableId);
      if (!v) throw new Error(`Variable not found: ${params.variableId}`);
      const arr = sn[paintField];
      if (arr === figma.mixed) throw new Error(`${paintField} is mixed; specify a single paint by re-setting`);
      const paints = arr as Paint[];
      const idx = typeof params.paintIndex === 'number' ? params.paintIndex : 0;
      if (idx < 0 || idx >= paints.length) throw new Error(`paintIndex ${idx} out of range (have ${paints.length})`);
      const field = (params.field ?? 'color') as VariableBindablePaintField;
      const updated = figma.variables.setBoundVariableForPaint(paints[idx] as SolidPaint, field, v);
      const next = paints.slice();
      next[idx] = updated;
      sn[paintField] = next;
      return { success: true, paintIndex: idx, field };
    }

    // ---------- text range ----------
    case 'set_text_range_property': {
      const n = await getNode(params.nodeId);
      if (n.type !== 'TEXT') throw new Error(`Not a TEXT node: ${params.nodeId}`);
      const t = n as TextNode;
      const start = Math.max(0, Math.min(t.characters.length, Number(params.start)));
      const end = Math.max(start, Math.min(t.characters.length, Number(params.end)));
      const prop = String(params.property);
      const value = coerce(params.value);
      // Range setters require the relevant fonts loaded.
      const fonts = t.getRangeAllFontNames(start, end);
      await Promise.all(fonts.map((f) => figma.loadFontAsync(f)));
      // Setting fontName on a range: the TARGET font must be loaded too
      // (style may be omitted / variationSettings given — variable fonts).
      if (prop === 'fontName' && value && typeof value === 'object') {
        const target: any = { family: String((value as any).family) };
        if ((value as any).style !== undefined && (value as any).style !== null) target.style = String((value as any).style);
        await figma.loadFontAsync(target);
      }
      if (prop === 'textWrapStyle') assertTextWrapStyle(value);
      const setter = `setRange${prop[0].toUpperCase()}${prop.slice(1)}` as keyof TextNode;
      const fn = (t as any)[setter];
      if (typeof fn !== 'function') throw new Error(`Unsupported text range property: ${prop}`);
      if (prop === 'fills') (fn as Function).call(t, start, end, paintsFromInput(value));
      else (fn as Function).call(t, start, end, value);
      return { success: true };
    }
  }
}

function clampDepth(d: number | undefined): number {
  if (d === undefined) return 3;
  if (d === -1) return Number.POSITIVE_INFINITY;
  if (d < 1) return 1;
  return Math.floor(d);
}

function serializeOptsFrom(params: any, maxDepth: number, override: Partial<SerializeOpts> = {}): SerializeOpts {
  const properties = Array.isArray(params.properties) && params.properties.length
    ? new Set<string>(params.properties)
    : undefined;
  // Node budget: caller may pass maxNodes; 0 / negative means unbounded
  // (explicit opt-out). Omitted → DEFAULT_READ_NODE_BUDGET so a fat
  // selection can't run for minutes and trip the caller's watchdog.
  const maxNodes = params.maxNodes;
  const budget = maxNodes === 0 || (typeof maxNodes === 'number' && maxNodes < 0)
    ? undefined
    : { remaining: typeof maxNodes === 'number' ? maxNodes : DEFAULT_READ_NODE_BUDGET };
  return {
    depth: 0,
    maxDepth,
    includeChildren: params.includeChildren !== false,
    includePluginData: !!params.includePluginData,
    pluginDataKeys: params.pluginDataKeys,
    includeBoundVariables: !!params.includeBoundVariables,
    properties,
    includeParent: !!params.includeParent,
    stubs: params.stubs === true,
    budget,
    ...override,
  };
}

// Trim a serialized tree by node type / name regex post-walk. Cheaper to
// keep these out of serializeNode (which doesn't know about scope-wide
// filters). Only used by get_page / get_document for now.
function applyTreeFilters(tree: any, params: any): any {
  const types: string[] | null = Array.isArray(params.nodeTypes) && params.nodeTypes.length ? params.nodeTypes : null;
  const nameRx: RegExp | null = params.nameFilter ? new RegExp(params.nameFilter, 'i') : null;
  if (!types && !nameRx) return tree;
  const matches = (n: any) =>
    (!types || types.includes(n.type)) && (!nameRx || nameRx.test(n.name));
  function prune(n: any): any | null {
    const kids: any[] = Array.isArray(n.children)
      ? n.children.map(prune).filter((x: any) => x !== null)
      : [];
    if (matches(n) || kids.length) {
      return { ...n, children: kids };
    }
    return null;
  }
  return prune(tree) ?? { ...tree, children: [] };
}

function countNodes(p: PageNode): number {
  // Top-level children only. Deep-walking every page on a large file is
  // both slow and pointless for a summary call like get_document.
  return 'children' in p ? p.children.length : 0;
}

function walk(root: BaseNode, fn: (n: BaseNode) => void) {
  fn(root);
  if (hasChildren(root)) {
    for (const c of root.children) walk(c, fn);
  }
}

// One part of a variable value (a color, an opacity, or the whole value):
// alias → {aliasOf}, RGB(A) → {hex, opacity}, anything else as-is.
function serializeVarPart(raw: any): any {
  if (raw && typeof raw === 'object') {
    if (raw.type === 'VARIABLE_ALIAS') return { aliasOf: raw.id };
    if ('r' in raw) return { hex: rgbToHex(raw.r, raw.g, raw.b), opacity: raw.a ?? 1 };
  }
  return raw;
}

function serializeVarValues(v: Variable): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [modeId, raw] of Object.entries(v.valuesByMode)) {
    if (v.resolvedType === 'COLOR' && raw && typeof raw === 'object' && 'color' in (raw as any) && 'opacity' in (raw as any)) {
      const c = raw as VariableComposedColor;
      out[modeId] = { color: serializeVarPart(c.color), opacity: serializeVarPart(c.opacity) };
    } else if (v.resolvedType === 'EASING' && raw && typeof raw === 'object' && (raw as any).type !== 'VARIABLE_ALIAS') {
      // MotionEasing → plain JSON ({type, easingFunctionCubicBezier?, easingFunctionSpring?}).
      out[modeId] = plainData(raw);
    } else {
      out[modeId] = serializeVarPart(raw);
    }
  }
  return out;
}

// A variable value by shape (no resolvedType needed): composed color, MotionEasing, alias or RGB(A).
function serializeOneVarValue(raw: any): any {
  if (raw && typeof raw === 'object') {
    if ('color' in raw && 'opacity' in raw) return { color: serializeVarPart(raw.color), opacity: serializeVarPart(raw.opacity) };
    if (raw.type !== 'VARIABLE_ALIAS' && MOTION_EASING_TYPES.has(raw.type)) return plainData(raw);
  }
  return serializeVarPart(raw);
}

// Extension info for a variable collection (ExtendedVariableCollection): isExtension is always
// present; extended collections add parent/root ids and variableOverrides
// ({variableId: {extendedModeId: value}}) in the same value shapes get_variables emits.
function serializeCollectionExtension(c: any): Record<string, any> {
  if (!c?.isExtension) return { isExtension: false };
  const overrides: Record<string, Record<string, any>> = {};
  for (const [variableId, byMode] of Object.entries(c.variableOverrides ?? {})) {
    const m: Record<string, any> = {};
    for (const [modeId, val] of Object.entries(byMode as Record<string, unknown>)) m[modeId] = serializeOneVarValue(val);
    overrides[variableId] = m;
  }
  return {
    isExtension: true,
    parentVariableCollectionId: c.parentVariableCollectionId,
    rootVariableCollectionId: c.rootVariableCollectionId,
    variableOverrides: overrides,
  };
}

const MOTION_EASING_TYPES = new Set([
  'EASE_IN', 'EASE_OUT', 'EASE_IN_AND_OUT', 'LINEAR', 'EASE_IN_BACK', 'EASE_OUT_BACK',
  'EASE_IN_AND_OUT_BACK', 'CUSTOM_CUBIC_BEZIER', 'GENTLE', 'QUICK', 'BOUNCY', 'SLOW',
  'CUSTOM_SPRING', 'HOLD',
]);

// EASING variable value -> MotionEasing. Accepts a bare type name ('EASE_IN'), the
// full Figma shape, or flat shorthands for the custom curves:
//   {type:'CUSTOM_CUBIC_BEZIER', x1,y1,x2,y2}   (or easingFunctionCubicBezier:{x1,y1,x2,y2})
//   {type:'CUSTOM_SPRING', bounce}              (or easingFunctionSpring:{bounce})
function toMotionEasing(raw: any): MotionEasing {
  const v = coerce<any>(raw);
  const obj = typeof v === 'string' ? { type: v } : v;
  if (!obj || typeof obj !== 'object' || typeof obj.type !== 'string') {
    throw new Error('EASING value expects a type name or {type, easingFunctionCubicBezier?, easingFunctionSpring?} — type one of ' + Array.from(MOTION_EASING_TYPES).join('|'));
  }
  if (!MOTION_EASING_TYPES.has(obj.type)) throw new Error(`Unknown easing type '${obj.type}' — one of ${Array.from(MOTION_EASING_TYPES).join('|')}`);
  const out: any = { type: obj.type };
  if (obj.type === 'CUSTOM_CUBIC_BEZIER') {
    const b = obj.easingFunctionCubicBezier ?? obj;
    const nums = [b.x1, b.y1, b.x2, b.y2].map(Number);
    if (nums.some((n) => !Number.isFinite(n))) throw new Error('CUSTOM_CUBIC_BEZIER needs numeric x1, y1, x2, y2 (or easingFunctionCubicBezier:{x1,y1,x2,y2})');
    out.easingFunctionCubicBezier = { x1: nums[0], y1: nums[1], x2: nums[2], y2: nums[3] };
  } else if (obj.type === 'CUSTOM_SPRING') {
    const sp = obj.easingFunctionSpring ?? obj;
    const bounce = Number(sp.bounce);
    if (!Number.isFinite(bounce)) throw new Error('CUSTOM_SPRING needs a numeric bounce 0..1 (or easingFunctionSpring:{bounce})');
    out.easingFunctionSpring = { bounce };
  }
  return out as MotionEasing;
}

// TIMING variable value -> number of SECONDS (Motion durations are in seconds
// everywhere in the Plugin API; the typings don't state a unit for TIMING variables).
function toTimingSeconds(raw: any): number {
  const n = Number(coerce<any>(raw));
  if (!Number.isFinite(n) || n < 0) throw new Error('TIMING value expects a finite, non-negative number of seconds');
  return n;
}

// SLOT property settings -> SlotSettings. Validates known keys only; min/maxChildren
// accept null to clear a limit. Unknown keys are rejected so typos don't no-op silently.
function toSlotSettings(raw: unknown): SlotSettings {
  const v = coerce<any>(raw);
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('slotSettings expects an object: {minChildren?, maxChildren?, stretchChildOnInsert?, displayEmptyByDefault?, allowPreferredValuesOnly?}');
  const out: SlotSettings = {};
  for (const [k, val] of Object.entries(v)) {
    if (k === 'stretchChildOnInsert' || k === 'displayEmptyByDefault' || k === 'allowPreferredValuesOnly') {
      if (typeof val !== 'boolean') throw new Error(`slotSettings.${k} must be a boolean`);
      out[k] = val;
    } else if (k === 'minChildren' || k === 'maxChildren') {
      if (val !== null && (typeof val !== 'number' || !Number.isInteger(val) || val < 0)) throw new Error(`slotSettings.${k} must be a non-negative integer or null`);
      out[k] = val as number | null;
    } else {
      throw new Error(`Unknown slotSettings key '${k}' — allowed: minChildren, maxChildren, stretchChildOnInsert, displayEmptyByDefault, allowPreferredValuesOnly`);
    }
  }
  return out;
}

// Index list for table/grid reorder (accepts a JSON-stringified array).
function asIndexList(v: unknown, label: string): number[] {
  const a = coerce<unknown>(v);
  const list = Array.isArray(a) ? a : (typeof a === 'number' ? [a] : null);
  if (!list || !list.length || list.some((x) => typeof x !== 'number' || !Number.isInteger(x) || x < 0)) {
    throw new Error(`${label} must be a non-empty array of non-negative integers`);
  }
  return list as number[];
}

function bytesToString(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function bytesToBase64(bytes: Uint8Array): string {
  return figma.base64Encode(bytes);
}

function base64ToBytes(b64: string): Uint8Array {
  // Strip data: URI prefix if present.
  const clean = b64.includes(',') ? b64.slice(b64.indexOf(',') + 1) : b64;
  return figma.base64Decode(clean);
}

function pageOf(n: BaseNode | null): PageNode | null {
  let cur: BaseNode | null = n;
  while (cur && cur.type !== 'PAGE') cur = cur.parent ?? null;
  return cur as PageNode | null;
}

// Some MCP clients JSON-stringify object/array args when the JSON Schema
// is permissive (e.g. `z.any()` → `{}`). Tolerate that universally by
// auto-parsing strings that look like JSON containers. Pass-through for
// values that are already objects/arrays, and for strings that aren't
// JSON (so legit string values aren't corrupted).
function coerce<T = unknown>(v: unknown): T {
  if (typeof v !== 'string') return v as T;
  const s = v.trim();
  if (!s) return v as T;
  const first = s.charCodeAt(0);
  // 0x7B = '{', 0x5B = '['
  if (first !== 0x7b && first !== 0x5b) return v as T;
  try { return JSON.parse(v) as T; } catch { return v as T; }
}

// Coerce + validate an array-of-strings input (e.g. `nodeIds`). Tolerates
// JSON-stringified arrays from permissive clients.
function asIds(v: unknown): string[] {
  const coerced = coerce<unknown>(v);
  if (!Array.isArray(coerced)) return [];
  return coerced.filter((x): x is string => typeof x === 'string');
}

// ---------- property setter ----------

// Properties grouped by validation rule. A "passthrough" prop means we
// trust the agent's value shape and just assign — Figma will throw on
// invalid input and we surface that error verbatim. The point of grouping
// is just to give precise "not supported" errors per node type.
const NUMERIC_PROPS = new Set([
  'opacity', 'x', 'y', 'rotation', 'strokeWeight', 'strokeMiterLimit',
  'strokeTopWeight', 'strokeRightWeight', 'strokeBottomWeight', 'strokeLeftWeight',
  'cornerRadius', 'cornerSmoothing',
  'topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'itemSpacing', 'counterAxisSpacing',
  'layoutGrow', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight',
  'paragraphSpacing', 'paragraphIndent',
  'arcStartingAngle', 'arcEndingAngle', 'arcInnerRadius',
  // CSS-grid auto-layout (container + child).
  'gridRowCount', 'gridColumnCount', 'gridRowGap', 'gridColumnGap',
  'gridRowSpan', 'gridColumnSpan', 'gridRowAnchorIndex', 'gridColumnAnchorIndex',
]);
const BOOL_PROPS = new Set([
  'visible', 'locked', 'isMask', 'clipsContent', 'expanded',
  'itemReverseZIndex', 'strokesIncludedInLayout',
  'svgOutlineText', 'svgIdAttribute', 'svgSimplifyStroke',
  'constrainProportions',
]);
// Strings/enums/objects we just assign as-is.
const PASSTHROUGH_PROPS = new Set([
  'name', 'blendMode',
  'strokeAlign', 'strokeJoin', 'strokeCap', 'dashPattern',
  'layoutMode', 'layoutWrap', 'layoutAlign', 'layoutPositioning',
  'layoutSizingHorizontal', 'layoutSizingVertical',
  'primaryAxisSizingMode', 'counterAxisSizingMode',
  'primaryAxisAlignItems', 'counterAxisAlignItems',
  'constraints', 'exportSettings', 'overflowDirection',
  'textAlignHorizontal', 'textAlignVertical', 'textCase', 'textDecoration',
  'textAutoResize', 'lineHeight', 'letterSpacing', 'hyperlink', 'listOptions',
  'fillStyleId', 'strokeStyleId', 'effectStyleId', 'gridStyleId', 'textStyleId',
  'componentProperties', 'overrides',
  // CSS-grid auto-layout: track-size arrays + enums (assigned as-is).
  'gridColumnSizes', 'gridRowSizes', 'gridAutoTracks', 'gridItemsPositioning',
  'gridChildHorizontalAlign', 'gridChildVerticalAlign',
  // Figma Draw dynamic strokes (brush/variable-width profiles, assigned as-is).
  'complexStrokeProperties', 'variableWidthStrokeProperties',
]);

async function applyProperty(node: SceneNode, property: string, value: any) {
  const sn = node as any;
  const requireText = () => {
    if (node.type !== 'TEXT') throw new Error(`Property '${property}' requires TEXT node`);
  };
  const not = (msg: string): never => {
    throw new Error(`Property '${property}' not supported on node type ${node.type}: ${msg}`);
  };
  const must = (cond: boolean, msg: string) => { if (!cond) not(msg); };

  switch (property) {
    case 'width': {
      must('resize' in node, 'cannot resize');
      const h = 'height' in node ? sn.height : 1;
      sn.resize(Number(value), h);
      return;
    }
    case 'height': {
      must('resize' in node, 'cannot resize');
      const w = 'width' in node ? sn.width : 1;
      sn.resize(w, Number(value));
      return;
    }
    case 'characters': {
      requireText();
      const t = node as TextNode;
      const fn = t.fontName === figma.mixed ? { family: 'Inter', style: 'Regular' } : t.fontName;
      await figma.loadFontAsync(fn as FontName);
      t.characters = String(value);
      return;
    }
    // Style-id props are READ-ONLY under documentAccess:dynamic-page — a plain
    // `node.fillStyleId = x` throws ("Use setFillStyleIdAsync instead"). Route
    // through the async setter (with sync fallback for non-dynamic-page), matching
    // apply_style. Covers set_node_property / map_nodes {set} / create_tree props.
    case 'fillStyleId':
    case 'strokeStyleId':
    case 'effectStyleId':
    case 'gridStyleId':
    case 'textStyleId': {
      must(property in sn, `no ${property} on this node`);
      const sid = value == null ? '' : String(value);
      const setter = `set${property.charAt(0).toUpperCase()}${property.slice(1)}Async`;
      if (setter in sn) await sn[setter](sid);
      else sn[property] = sid;
      return;
    }
    case 'fontName':
    case 'fontFamily':
    case 'fontWeight': {
      requireText();
      const t = node as TextNode;
      let fn: FontName;
      if (property === 'fontName' && value && typeof value === 'object') {
        // FontNameInput: style optional (Figma resolves the closest named
        // instance), variationSettings optional (variable-font axes).
        const v = coerce<any>(value);
        const input: any = { family: String(v.family) };
        if (v.style !== undefined && v.style !== null) input.style = String(v.style);
        if (v.variationSettings && typeof v.variationSettings === 'object') input.variationSettings = v.variationSettings;
        await figma.loadFontAsync(input);
        (t as any).fontName = input;
        return;
      } else {
        const cur = t.fontName === figma.mixed ? { family: 'Inter', style: 'Regular' } : (t.fontName as FontName);
        fn = property === 'fontFamily'
          ? { family: String(value), style: cur.style }
          : { family: cur.family, style: String(value) };
      }
      await figma.loadFontAsync(fn);
      t.fontName = fn;
      return;
    }
    case 'textWrapStyle': {
      requireText();
      const t = node as TextNode;
      assertTextWrapStyle(value);
      // The setter needs every font in the node loaded.
      if (t.characters.length > 0) {
        const fonts = t.getRangeAllFontNames(0, t.characters.length);
        await Promise.all(fonts.map((f) => figma.loadFontAsync(f)));
      } else if (t.fontName !== figma.mixed) {
        await figma.loadFontAsync(t.fontName as FontName);
      }
      (t as any).textWrapStyle = value;
      return;
    }
    case 'fontSize': {
      requireText();
      const t = node as TextNode;
      const fn = t.fontName === figma.mixed ? { family: 'Inter', style: 'Regular' } : (t.fontName as FontName);
      await figma.loadFontAsync(fn);
      t.fontSize = Number(value);
      return;
    }
    case 'fills':
      must(hasFills(node), 'no fills');
      sn.fills = paintsFromInput(value);
      return;
    case 'strokes':
      must(hasStrokes(node), 'no strokes');
      sn.strokes = paintsFromInput(value);
      return;
    case 'effects':
      must('effects' in node, 'no effects');
      // rehydrate so a read-back effect ({hex,opacity} colors, alias shapes)
      // can be written straight back — full round-trip editability.
      sn.effects = rehydrateValue(coerce<Effect[]>(value)) as Effect[];
      return;
    case 'layoutGrids':
      must('layoutGrids' in node, 'no layoutGrids');
      sn.layoutGrids = coerce<LayoutGrid[]>(value);
      return;
    case 'componentProperties': {
      if (node.type !== 'INSTANCE') return not('only INSTANCE supports componentProperties');
      (node as InstanceNode).setProperties(coerce<Record<string, string | boolean>>(value));
      return;
    }
    case 'vectorNetwork':
    case 'vectorPaths': {
      if (node.type !== 'VECTOR') return not('only VECTOR supports vectorNetwork/vectorPaths');
      // Same defensive parse as set_vector_network — clients sometimes
      // stringify object args when the JSON Schema is permissive.
      let val: unknown = value;
      if (typeof val === 'string') {
        try { val = JSON.parse(val); } catch (err) {
          throw new Error(`${property} is a string but not valid JSON: ${(err as Error).message}`);
        }
      }
      const v = node as VectorNode;
      if (property === 'vectorNetwork' && typeof v.setVectorNetworkAsync === 'function') {
        await v.setVectorNetworkAsync(val as VectorNetwork);
      } else {
        (v as any)[property] = val;
      }
      return;
    }
  }

  // For wide-net buckets, validate the property exists on the node before
  // assigning so we can surface a clean "not supported" error.
  if (NUMERIC_PROPS.has(property)) {
    must(property in node, 'no such property');
    sn[property] = Number(value);
    return;
  }
  if (BOOL_PROPS.has(property)) {
    must(property in node, 'no such property');
    sn[property] = Boolean(value);
    return;
  }
  if (PASSTHROUGH_PROPS.has(property)) {
    if (property !== 'name' && !(property in node)) return not('no such property');
    // Object/array-valued props (constraints, exportSettings, dashPattern,
    // listOptions, hyperlink, overrides, componentProperties) may arrive
    // JSON-stringified from permissive clients. coerce() unwraps that.
    sn[property] = coerce(value);
    return;
  }

  throw new Error(`Property '${property}' not supported on node type ${node.type}`);
}

function assertTextWrapStyle(v: any): void {
  if (v !== 'AUTO' && v !== 'BALANCE' && v !== 'PRETTY') {
    throw new Error(`textWrapStyle must be 'AUTO' | 'BALANCE' | 'PRETTY', got ${JSON.stringify(v)}`);
  }
}

function paintsFromInput(rawInput: any): Paint[] {
  const input = coerce(rawInput);
  if (!Array.isArray(input)) throw new Error('fills/strokes value must be an array');
  return input.map((p): Paint => {
    // Shorthand: bare hex string in the array → solid paint.
    if (typeof p === 'string') {
      const pc = resolveColor(p);
      return { type: 'SOLID', color: colorObj(pc, false), opacity: pc.a < 1 ? pc.a : 1, visible: true } as SolidPaint;
    }
    const type = p.type ?? 'SOLID';
    if (type === 'SOLID') {
      // hex | color: any CSS color string / {r,g,b,sourceColor} / {space,...};
      // sourceColor (what reads emit) may also sit beside hex.
      let colorIn: any = p.hex ?? p.color;
      if (colorIn === undefined) colorIn = p.sourceColor !== undefined ? { sourceColor: p.sourceColor } : '#000000';
      else colorIn = withSource(colorIn, p.sourceColor);
      const pc = resolveColor(colorIn);
      const out: SolidPaint = {
        type: 'SOLID',
        color: colorObj(pc, false),
        opacity: p.opacity ?? (pc.a < 1 ? pc.a : 1),
        visible: p.visible !== false,
        blendMode: p.blendMode,
      };
      return out;
    }
    // GRADIENT_*, IMAGE — accept either a fully-shaped Paint, or an
    // expanded shape with hex stops which we collapse to RGBA.
    if (
      type.startsWith('GRADIENT_') &&
      Array.isArray(p.stops) &&
      (p.stops[0]?.hex || p.stops[0]?.sourceColor !== undefined)
    ) {
      const stops = p.stops.map((s: any) => {
        const base = s.hex ?? s.color;
        const sc = resolveColor(base !== undefined ? withSource(base, s.sourceColor) : { sourceColor: s.sourceColor });
        return { position: s.position, color: colorObj({ ...sc, a: s.opacity ?? sc.a }, true) };
      });
      return {
        type,
        gradientStops: stops,
        gradientTransform: p.transform ?? p.gradientTransform ?? [[1, 0, 0], [0, 1, 0]],
        opacity: p.opacity ?? 1,
        visible: p.visible !== false,
        blendMode: p.blendMode,
      } as GradientPaint;
    }
    // Fully-shaped paint of any other type (SHADER, VIDEO, …). Rehydrate so a
    // read-back paint (nested {hex,opacity} colors / alias shapes) writes back.
    return rehydrateValue(p) as Paint;
  });
}

// ---------- create / style helpers ----------

async function createByType(params: any): Promise<SceneNode> {
  let parent: BaseNode & ChildrenMixin = figma.currentPage;
  if (params.parentId) {
    const p = await getNode(params.parentId);
    if (!hasChildren(p)) throw new Error(`Parent ${params.parentId} cannot contain children`);
    parent = p;
  }

  let node: SceneNode;
  switch (params.type) {
    case 'FRAME':
      node = figma.createFrame();
      break;
    case 'RECTANGLE':
      node = figma.createRectangle();
      break;
    case 'ELLIPSE':
      node = figma.createEllipse();
      break;
    case 'LINE':
      node = figma.createLine();
      break;
    case 'POLYGON':
      node = figma.createPolygon();
      break;
    case 'STAR':
      node = figma.createStar();
      break;
    case 'VECTOR':
      node = figma.createVector();
      break;
    case 'COMPONENT':
      node = figma.createComponent();
      break;
    case 'TEXT': {
      await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
      node = figma.createText();
      break;
    }
    case 'INSTANCE': {
      if (!params.componentId) throw new Error('INSTANCE requires componentId');
      const c = await getNode(params.componentId);
      if (c.type !== 'COMPONENT') throw new Error(`Not a component: ${params.componentId}`);
      node = (c as ComponentNode).createInstance();
      break;
    }
    default:
      throw new Error(`Unsupported create type: ${params.type}`);
  }

  // Position + size + name first so subsequent property writes see a
  // sensible base (e.g. text characters need the font loaded already).
  if (params.name) node.name = params.name;
  if (typeof params.x === 'number') node.x = params.x;
  if (typeof params.y === 'number') node.y = params.y;
  if ('resize' in node && (params.width || params.height)) {
    const w = params.width ?? (node as any).width ?? 100;
    const h = params.height ?? (node as any).height ?? 100;
    (node as any).resize(w, h);
  }
  parent.appendChild(node);

  // Apply arbitrary props in one shot, in declaration order. Caller-
  // controlled — same shape as set_node_property values. coerce() handles
  // the stringified-object case from permissive clients.
  const propsBag = coerce<Record<string, unknown> | undefined>(params.props);
  if (propsBag && typeof propsBag === 'object') {
    for (const [prop, val] of Object.entries(propsBag)) {
      await applyProperty(node, prop, val);
    }
  }

  if (params.selectAfter) {
    figma.currentPage.selection = [node];
  }

  return node;
}

// {aliasOf: id} (what reads emit) | {variableId} | Figma's {type:'VARIABLE_ALIAS', id}.
function toVarAlias(v: any): VariableAlias | null {
  if (!v || typeof v !== 'object') return null;
  const id = v.aliasOf ?? v.variableId ?? (v.type === 'VARIABLE_ALIAS' ? v.id : undefined);
  return typeof id === 'string' ? { type: 'VARIABLE_ALIAS', id } : null;
}

function toRgba(v: any): RGBA {
  // Hex, CSS color strings, {hex,opacity}, {r,g,b,a?}, {space,...}, {sourceColor}
  // all go through resolveColor. Variable values carry no sourceColor, so only
  // the RGBA is returned.
  if (typeof v === 'string' || (v && typeof v === 'object' && ('hex' in v || 'r' in v || 'space' in v || 'sourceColor' in v))) {
    const c = resolveColor(v);
    return { r: c.r, g: c.g, b: c.b, a: c.a };
  }
  throw new Error('color expects a #hex or CSS color string (oklch()/hsl()/lab()/rgb()), {hex, opacity}, {r,g,b,a?}, {space,...} or {aliasOf}');
}

function coerceVarValue(type: VariableResolvedDataType, value: any): VariableValue {
  const alias = toVarAlias(value);
  if (alias) return alias;
  if (type === 'COLOR') {
    // Composed color: a color and a separate opacity, at least one of them an alias.
    if (value && typeof value === 'object' && 'color' in value && 'opacity' in value) {
      const color = toVarAlias(value.color) ?? toRgba(value.color);
      const opacity = toVarAlias(value.opacity) ?? Number(value.opacity);
      if (typeof opacity === 'number' && !Number.isFinite(opacity)) throw new Error('composed color opacity must be a number or {aliasOf}');
      if (!('type' in color) && typeof opacity === 'number') {
        throw new Error('composed color needs the color or the opacity to be a variable alias — for a plain color use {hex, opacity}');
      }
      return { color, opacity } as VariableComposedColor;
    }
    return toRgba(value);
  }
  if (type === 'FLOAT') return Number(value);
  if (type === 'BOOLEAN') return Boolean(value);
  if (type === 'STRING') return String(value);
  if (type === 'EASING') return toMotionEasing(value);
  if (type === 'TIMING') return toTimingSeconds(value);
  return value;
}

async function upsertStyle(params: any): Promise<{ id: string; name: string }> {
  const isUpdate = !!params.styleId;
  if (params.type === 'PAINT') {
    let style: PaintStyle;
    if (isUpdate) {
      const found = await figma.getStyleByIdAsync(params.styleId);
      if (!found || found.type !== 'PAINT') throw new Error(`Paint style not found: ${params.styleId}`);
      style = found as PaintStyle;
    } else {
      style = figma.createPaintStyle();
    }
    style.name = params.name;
    style.paints = paintsFromInput(params.value);
    return { id: style.id, name: style.name };
  }
  if (params.type === 'EFFECT') {
    let style: EffectStyle;
    if (isUpdate) {
      const found = await figma.getStyleByIdAsync(params.styleId);
      if (!found || found.type !== 'EFFECT') throw new Error(`Effect style not found: ${params.styleId}`);
      style = found as EffectStyle;
    } else {
      style = figma.createEffectStyle();
    }
    style.name = params.name;
    // rehydrate: read-back {hex,opacity,sourceColor} / CSS-string colors write back.
    style.effects = rehydrateValue(coerce<Effect[]>(params.value)) as Effect[];
    return { id: style.id, name: style.name };
  }
  if (params.type === 'TEXT') {
    let style: TextStyle;
    if (isUpdate) {
      const found = await figma.getStyleByIdAsync(params.styleId);
      if (!found || found.type !== 'TEXT') throw new Error(`Text style not found: ${params.styleId}`);
      style = found as TextStyle;
    } else {
      style = figma.createTextStyle();
    }
    style.name = params.name;
    if (params.value.fontName) {
      // FontNameInput: style optional, variationSettings optional (variable fonts).
      const fnIn = coerce<any>(params.value.fontName);
      const input: any = { family: String(fnIn.family) };
      if (fnIn.style !== undefined && fnIn.style !== null) input.style = String(fnIn.style);
      if (fnIn.variationSettings && typeof fnIn.variationSettings === 'object') input.variationSettings = fnIn.variationSettings;
      await figma.loadFontAsync(input);
      (style as any).fontName = input;
    }
    if (typeof params.value.fontSize === 'number') style.fontSize = params.value.fontSize;
    if (params.value.lineHeight) style.lineHeight = params.value.lineHeight;
    if (params.value.letterSpacing) style.letterSpacing = params.value.letterSpacing;
    if (params.value.textCase) style.textCase = params.value.textCase;
    if (params.value.textDecoration) style.textDecoration = params.value.textDecoration;
    if (params.value.textWrapStyle !== undefined) {
      assertTextWrapStyle(params.value.textWrapStyle);
      (style as any).textWrapStyle = params.value.textWrapStyle;
    }
    if (typeof params.value.paragraphSpacing === 'number') style.paragraphSpacing = params.value.paragraphSpacing;
    if (typeof params.value.paragraphIndent === 'number') style.paragraphIndent = params.value.paragraphIndent;
    if (typeof params.description === 'string') style.description = params.description;
    return { id: style.id, name: style.name };
  }
  if (params.type === 'GRID') {
    let style: GridStyle;
    if (isUpdate) {
      const found = await figma.getStyleByIdAsync(params.styleId);
      if (!found || found.type !== 'GRID') throw new Error(`Grid style not found: ${params.styleId}`);
      style = found as GridStyle;
    } else {
      style = figma.createGridStyle();
    }
    style.name = params.name;
    style.layoutGrids = params.value as LayoutGrid[];
    if (typeof params.description === 'string') style.description = params.description;
    return { id: style.id, name: style.name };
  }
  throw new Error(`Unsupported style type: ${params.type}`);
}

// ---------- UI message bus ----------

// Bump in lockstep with bridge/package.json + plugin/package.json. Bridge
// logs a warning on mismatch so stale-cached plugin code (a known Figma
// Desktop caching behavior) surfaces immediately instead of returning
// "unknown method" or stalling on missing handlers.
const PLUGIN_VERSION = '0.5.1';

// Capability flags the loaded plugin advertises. Lets the bridge confirm
// a specific fix is actually in the running iframe (version alone can lie
// if two builds share a number). 'nodeBudget' = bounded serialize is live.
const PLUGIN_CAPABILITIES = ['nodeBudget', 'deepLink'];

function sendHello() {
  figma.ui.postMessage({
    kind: 'hello',
    version: PLUGIN_VERSION,
    capabilities: PLUGIN_CAPABILITIES,
    fileKey: figma.fileKey ?? figma.root.id,
    fileName: figma.root.name,
    currentPageId: figma.currentPage.id,
    currentPageName: figma.currentPage.name,
  });
}

// Methods that don't change document state. Everything else is bracketed
// with figma.commitUndo() at start + end so each tool call lands as one
// Cmd-Z step instead of bleeding into the user's prior or next action.
const READ_ONLY_METHODS = new Set<string>([
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

figma.ui.onmessage = async (msg: ToolRequest | any) => {
  if (msg && msg.kind === 'welcome') {
    sendHello();
    return;
  }
  // The strip is clickable while disconnected. The plugin alone cannot start
  // the bridge — Figma's sandbox can't launch a local process — so the only
  // useful thing it can offer is where to go and install it. Opening the
  // README rather than a separate hosted page keeps one copy of the install
  // instructions instead of two that drift apart.
  if (msg && msg.kind === 'openSetup') {
    figma.openExternal('https://github.com/spendolas/grip#install');
    return;
  }
  if (!msg || msg.kind !== 'request') return;
  figma.ui.postMessage({ kind: 'busy', busy: true });
  const mutates = !READ_ONLY_METHODS.has(msg.method);
  if (mutates) {
    // Close any prior open undo group so this call's mutations don't
    // merge with whatever the user (or a previous tool call) was doing.
    try { figma.commitUndo(); } catch {}
  }
  try {
    const result = await handle(msg.method, msg.params ?? {}, msg.id);
    figma.ui.postMessage({ kind: 'response', id: msg.id, result });
  } catch (err) {
    // Only touch err.message. Reading err.stack triggers V8's lazy
    // source-position walk which on hot error paths is precisely what
    // pegs CPU. The "eager drain" intel was upside-down — drain causes
    // the stall, not the other way around.
    const message = (err as Error)?.message ?? String(err);
    console.error('[grip] handler error in', msg.method, message);
    figma.ui.postMessage({ kind: 'response', id: msg.id, error: message });
    figma.ui.postMessage({ kind: 'error' });
  } finally {
    if (mutates) {
      // Close this call's own undo group — one tool call = one Cmd-Z step.
      try { figma.commitUndo(); } catch {}
    }
    figma.ui.postMessage({ kind: 'busy', busy: false });
  }
};

// ---------- events ----------

figma.on('selectionchange', () => {
  const sel = figma.currentPage.selection.map((n) => ({
    id: n.id,
    name: n.name,
    type: n.type,
  }));
  figma.ui.postMessage({ kind: 'event', event: 'selectionchange', data: sel });
});

figma.on('currentpagechange', () => {
  // File metadata for the bridge changes when the user switches pages.
  sendHello();
  figma.ui.postMessage({
    kind: 'event',
    event: 'currentpagechange',
    data: { pageId: figma.currentPage.id, pageName: figma.currentPage.name },
  });
});

let docTimer: number | undefined;
// documentchange is only registerable after loading all pages in
// dynamic-page mode. Defer to an async bootstrap.
async function registerDocumentChange() {
  await figma.loadAllPagesAsync();
  figma.on('documentchange', (e) => {
    if (docTimer !== undefined) clearTimeout(docTimer);
    docTimer = setTimeout(() => {
      figma.ui.postMessage({
        kind: 'event',
        event: 'documentchange',
        data: { changes: e.documentChanges.length },
      });
    }, 500) as unknown as number;
  });
}
registerDocumentChange().catch((err) => {
  figma.ui.postMessage({
    kind: 'status',
    status: { lastError: 'documentchange register failed: ' + (err as Error).message },
  });
});

