import { z } from 'zod';

// Tool definitions. The handler in mcp-server.ts forwards `name` and the
// validated `params` over WS to the plugin, where the actual Plugin API
// work happens. Param schemas here are the contract the agent sees.

export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  // True when the tool returns a notification subscription rather than
  // a one-shot response. The MCP server short-circuits these.
  subscription?: boolean;
}

const NodeTypeEnum = z.enum([
  'FRAME', 'TEXT', 'RECTANGLE', 'ELLIPSE', 'COMPONENT', 'INSTANCE',
  'GROUP', 'POLYGON', 'STAR', 'LINE', 'VECTOR', 'BOOLEAN_OPERATION',
  'COMPONENT_SET', 'PAGE', 'DOCUMENT', 'SLICE', 'STICKY', 'CONNECTOR',
]);

// Reusable shape: rich read params shared across get_node/get_page/get_selection/get_nodes.
const RichRead = {
  depth: z.number().int().optional(),
  maxNodes: z.number().int().optional(),
  includeChildren: z.boolean().optional(),
  includeParent: z.boolean().optional(),
  includePluginData: z.boolean().optional(),
  pluginDataKeys: z.array(z.string()).optional(),
  includeBoundVariables: z.boolean().optional(),
  properties: z.array(z.string()).optional(),
};

export const TOOLS: ToolDef[] = [
  {
    name: 'grip_health',
    description: 'Probe bridge + plugin state. Returns { role, leaderPid, pluginCount, pluginsReady, pendingCount, plugins[], session: { id, activeFileId, subscriptions } }. Safe to call without a plugin connected — use it before writes to confirm path is alive.',
    schema: z.object({}),
  },
  {
    name: 'grip_diagnose',
    description: 'Full forensic dump when grip feels stuck or stalls. Returns process metrics (pid, uptime, cpu, memMb), eventLoopLagMs at this instant, plugin states with lastPongMsAgo, pending request count, your MCP session state, and a tail of the bridge log. No plugin round-trip — always safe.',
    schema: z.object({}),
  },
  {
    name: 'list_files',
    description: 'List all Figma files currently connected to Grip. The "active" file is where read/write tools execute. With >1 file open and no binding, tools error with `ambiguous_active_file` until you set_active_file — grip never guesses.',
    schema: z.object({}),
  },
  {
    name: 'set_active_file',
    description:
      "Bind this agent to a Figma file — all subsequent tool calls route there, regardless of how many other files are open, and the binding survives Figma's plugin reconnects. `target` accepts a fileKey, an exact file name, a sessionId, or a figma.com URL. If the file isn't open yet the binding is held (deferred) and resolves when it connects; the result reports `{ bound, resolved }` and, when unresolved, the list of currently-open files (so a typo is obvious). A file name matching >1 open file errors `ambiguous_file_name` — use the fileKey. (Launchers can skip this by starting the agent with env GRIP_FILE=<key|name|url>.)",
    schema: z.object({ target: z.string() }),
  },
  {
    name: 'get_document',
    description: 'Returns file metadata and all pages.',
    schema: z.object({}),
  },
  {
    name: 'get_page',
    description: 'Returns the node tree of a page (default current). Supports depth, type/name filters, plugin data and variable bindings.',
    schema: z.object({
      pageId: z.string().optional(),
      nodeTypes: z.array(NodeTypeEnum).optional(),
      nameFilter: z.string().optional(),
      ...RichRead,
    }),
  },
  {
    name: 'get_node',
    description: 'Returns a single node with rich serialization. Defaults: depth 12, maxNodes 3000 (children beyond collapse to stubs with truncated:true). Pass depth:-1 + maxNodes:0 for the full tree. Also supports properties subset, parent stub, plugin data, variable bindings.',
    schema: z.object({
      nodeId: z.string(),
      ...RichRead,
    }),
  },
  {
    name: 'get_nodes',
    description: 'Bulk read: returns a serialized node for each id. Same depth/maxNodes defaults as get_node. Failed lookups become {id, error}.',
    schema: z.object({
      nodeIds: z.array(z.string()).min(1),
      ...RichRead,
    }),
  },
  {
    name: 'get_selection',
    description: 'Returns the currently selected nodes with rich serialization. Bounded by default (depth 12, maxNodes 3000 shared across the selection) so a large selection returns fast instead of stalling. Pass depth:-1 + maxNodes:0 for full fidelity.',
    schema: z.object({ ...RichRead }),
  },
  {
    name: 'get_page_context',
    description: "Cheap 'where am I' probe. Returns { file: {key, name}, page: {id, name}, selectionCount, bind } for the currently-routed plugin session — no node tree, no round-trip cost. `bind` is this agent's file binding ({ target, resolved } or null). Call before page-scoped reads (get_selection, search_nodes) when unsure which file/page is active: an empty result from those means 'nothing here', not 'wrong page', only if this confirms you're on the file/page you intended.",
    schema: z.object({}),
  },
  {
    name: 'get_deep_link',
    description: "Build a shareable figma.com deep link to a node. nodeId optional (defaults to first selected node, else current page). kind: 'design' (default) | 'dev' (opens Dev Mode) | 'proto' (prototype player). Returns { available, url, ... }. NOTE: requires a real fileKey — only works when grip runs as a private org plugin (enablePrivatePluginApi). If unavailable, returns { available: false, reason: 'deep_link_unavailable' } instead of a broken URL.",
    schema: z.object({
      nodeId: z.string().optional(),
      kind: z.enum(['design', 'dev', 'proto']).optional(),
    }),
  },
  {
    name: 'get_styles',
    description: 'Returns all local paint, text, effect, and grid styles.',
    schema: z.object({}),
  },
  {
    name: 'get_variables',
    description: 'Returns all local variable collections with descriptions, scopes, codeSyntax, hidden flag, and values per mode.',
    schema: z.object({}),
  },
  {
    name: 'get_components',
    description: 'Returns all local components and component sets, with property definitions, documentation links, and remote flag.',
    schema: z.object({
      includePropertyDefinitions: z.boolean().optional(),
    }),
  },
  {
    name: 'search_nodes',
    description:
      'Find nodes by combination of: type(s), name (substring or regex via nameRegex), text content, fill hex. Scope: page, subtree (scope nodeId), or all pages. Paginated.',
    schema: z.object({
      pageId: z.string().optional(),
      scope: z.string().optional(),
      allPages: z.boolean().optional(),
      name: z.string().optional(),
      nameRegex: z.string().optional(),
      nameFlags: z.string().optional(),
      type: z.union([NodeTypeEnum, z.array(NodeTypeEnum)]).optional(),
      textContains: z.string().optional(),
      fillHex: z.string().optional(),
      maxResults: z.number().int().positive().optional(),
      offset: z.number().int().nonnegative().optional(),
    }),
  },
  {
    name: 'export_node',
    description:
      'Export a node. Formats: SVG, PNG, JPG, PDF (base64), CSS, JSON, and video MP4/GIF/WEBM. Constraint can be SCALE/WIDTH/HEIGHT. ' +
      'For PNG/JPG/PDF, pass `path` (absolute file path) — the bridge writes the bytes to disk and returns ' +
      '{path, format, bytes} instead of base64. REQUIRED for anything beyond a tiny image: a raster result inline ' +
      'is base64 that overflows the MCP result token limit and fails. Without `path`, only small SVG/CSS/JSON are safe inline. ' +
      'Video (MP4/GIF/WEBM) works only on an ANIMATED top-level frame (uses Figma Motion), ALWAYS requires `path`, and takes fps / ' +
      'quality (MP4/WEBM) / loopCount (GIF). A large video may exceed the 8MB WS response cap — raise GRIP_RESPONSE_CAP_BYTES if so.',
    schema: z.object({
      nodeId: z.string(),
      format: z.enum(['SVG', 'PNG', 'JPG', 'PDF', 'CSS', 'JSON', 'MP4', 'GIF', 'WEBM']),
      path: z.string().optional(),
      scale: z.number().positive().optional(),
      constraint: z.object({
        type: z.enum(['SCALE', 'WIDTH', 'HEIGHT']),
        value: z.number().positive(),
      }).optional(),
      fps: z.number().positive().optional(),
      quality: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
      loopCount: z.number().int().nonnegative().optional(),
      contentsOnly: z.boolean().optional(),
      useAbsoluteBounds: z.boolean().optional(),
      suffix: z.string().optional(),
      colorProfile: z.enum(['DOCUMENT', 'SRGB', 'DISPLAY_P3_V4']).optional(),
      svgOutlineText: z.boolean().optional(),
      svgIdAttribute: z.boolean().optional(),
      svgSimplifyStroke: z.boolean().optional(),
      // JSON format only:
      ...RichRead,
    }),
  },
  {
    name: 'set_node_property',
    description:
      'Set any property on a node. Numeric (x, y, width, height, opacity, rotation, paddingTop, itemSpacing, cornerRadius, individual corner radii, strokeWeight, layoutGrow, min/max width/height, fontSize, paragraphSpacing, paragraphIndent, etc.), boolean (visible, locked, isMask, clipsContent, expanded), and passthrough (name, blendMode, layoutMode, layoutAlign, layoutSizingHorizontal/Vertical, primary/counterAxis*, strokeAlign/Join/Cap, dashPattern, textAlignHorizontal/Vertical, textCase, textDecoration, textAutoResize, lineHeight, letterSpacing, hyperlink, fillStyleId etc., fills, strokes, effects, layoutGrids, componentProperties). CSS-grid auto-layout: set layoutMode="GRID" then gridRowCount/gridColumnCount, gridRowGap/gridColumnGap, gridColumnSizes/gridRowSizes (arrays of {type:"FLEX"|"FIXED"|"HUG", value}), gridAutoTracks, gridItemsPositioning; per grid-child gridRowSpan/gridColumnSpan/gridRowAnchorIndex/gridColumnAnchorIndex/gridChildHorizontal|VerticalAlign (or use set_grid_child_position). New paint types on fills/strokes: {type:"GRADIENT_DIAMOND",...}, {type:"SHADER", shaderId,...} (import via import_shader first), {type:"VIDEO",...}. New effect types on effects: {type:"NOISE", noiseType:"MONOTONE"|"DUOTONE"|"MULTITONE", density, noiseSize, color}, {type:"TEXTURE", noiseSize, radius, clipToShape}, {type:"GLASS", refraction, depth, lightIntensity, lightAngle, dispersion, radius}, and progressive blur {type:"LAYER_BLUR"|"BACKGROUND_BLUR", blurType:"PROGRESSIVE", radius, startRadius, startOffset, endOffset}.',
    schema: z.object({
      nodeId: z.string(),
      property: z.string(),
      value: z.any(),
    }),
  },
  {
    name: 'create_node',
    description:
      'Create a new node. Types: FRAME, TEXT, RECTANGLE, ELLIPSE, LINE, POLYGON, STAR, VECTOR, COMPONENT, INSTANCE (requires componentId). `props` applies any set_node_property values at creation time.',
    schema: z.object({
      type: z.enum([
        'FRAME', 'TEXT', 'RECTANGLE', 'ELLIPSE',
        'LINE', 'POLYGON', 'STAR', 'VECTOR',
        'COMPONENT', 'INSTANCE',
      ]),
      parentId: z.string().optional(),
      name: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().positive().optional(),
      height: z.number().positive().optional(),
      componentId: z.string().optional(),
      props: z.record(z.any()).optional(),
      selectAfter: z.boolean().optional(),
    }),
  },
  {
    name: 'delete_node',
    description: 'Delete a node by id.',
    schema: z.object({ nodeId: z.string() }),
  },
  {
    name: 'set_variable_value',
    description:
      "Set a variable's value for a specific mode. Color values use '#hex' or {hex, opacity}.",
    schema: z.object({
      variableId: z.string(),
      modeId: z.string(),
      value: z.any(),
    }),
  },
  {
    name: 'set_style',
    description:
      'Create or update a local style. Omit styleId to create a new one.',
    schema: z.object({
      styleId: z.string().optional(),
      name: z.string(),
      type: z.enum(['PAINT', 'TEXT', 'EFFECT', 'GRID']),
      value: z.any(),
    }),
  },
  // ---------- selection / viewport ----------
  {
    name: 'set_selection',
    description: 'Replace the current selection with the given nodes. Switches to the page they live on. Optional scrollTo.',
    schema: z.object({
      nodeIds: z.array(z.string()).min(1),
      scrollTo: z.boolean().optional(),
    }),
  },
  {
    name: 'scroll_to',
    description: 'Scroll and zoom the viewport to fit the given node(s). Switches pages if needed.',
    schema: z.object({
      nodeId: z.string().optional(),
      nodeIds: z.array(z.string()).optional(),
    }),
  },

  // ---------- tree ops ----------
  {
    name: 'clone_node',
    description: 'Duplicate a node. Defaults parent to the original parent. Optional position + name.',
    schema: z.object({
      nodeId: z.string(),
      parentId: z.string().optional(),
      index: z.number().int().nonnegative().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      name: z.string().optional(),
    }),
  },
  {
    name: 'move_node',
    description: 'Reparent and/or reorder a node. `index` controls z-order within the new parent.',
    schema: z.object({
      nodeId: z.string(),
      parentId: z.string(),
      index: z.number().int().nonnegative().optional(),
    }),
  },
  {
    name: 'group_nodes',
    description: 'Group nodes. Default creates a GROUP. asFrame:true creates a FRAME wrapping their bounding box.',
    schema: z.object({
      nodeIds: z.array(z.string()).min(1),
      parentId: z.string().optional(),
      asFrame: z.boolean().optional(),
      name: z.string().optional(),
    }),
  },
  {
    name: 'ungroup_node',
    description: 'Ungroup a GROUP or FRAME, releasing children to its parent.',
    schema: z.object({ nodeId: z.string() }),
  },

  // ---------- pages ----------
  {
    name: 'create_page',
    description: 'Create a new page. Optional name, optional makeCurrent.',
    schema: z.object({
      name: z.string().optional(),
      makeCurrent: z.boolean().optional(),
    }),
  },
  {
    name: 'set_current_page',
    description: 'Switch the active page.',
    schema: z.object({ pageId: z.string() }),
  },
  {
    name: 'delete_page',
    description: 'Delete a page.',
    schema: z.object({ pageId: z.string() }),
  },

  // ---------- plugin data ----------
  {
    name: 'get_plugin_data',
    description: 'Read pluginData from a node. With key, returns that one; without, returns all keys.',
    schema: z.object({
      nodeId: z.string(),
      key: z.string().optional(),
    }),
  },
  {
    name: 'set_plugin_data',
    description: 'Write pluginData on a node. Empty value or null clears the key.',
    schema: z.object({
      nodeId: z.string(),
      key: z.string(),
      value: z.union([z.string(), z.null()]),
    }),
  },

  // ---------- components ----------
  {
    name: 'detach_instance',
    description: 'Detach an instance, returning the resulting frame node.',
    schema: z.object({ nodeId: z.string() }),
  },
  {
    name: 'swap_instance',
    description: 'Swap an instance to a different component.',
    schema: z.object({
      nodeId: z.string(),
      componentId: z.string(),
    }),
  },
  {
    name: 'create_component_from_node',
    description: 'Promote a node to a Component. Original node is replaced; component takes its place.',
    schema: z.object({
      nodeId: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
    }),
  },

  // ---------- style + variable bindings ----------
  {
    name: 'apply_style',
    description: 'Bind a node property to a local style. kind: fill | stroke | effect | grid | text.',
    schema: z.object({
      nodeId: z.string(),
      styleId: z.string(),
      kind: z.enum(['fill', 'stroke', 'effect', 'grid', 'text']),
    }),
  },
  {
    name: 'bind_property_to_variable',
    description: 'Bind a node field (e.g. fills, strokes, opacity, cornerRadius, paddingTop, characters, height, width) to a variable.',
    schema: z.object({
      nodeId: z.string(),
      field: z.string(),
      variableId: z.string(),
    }),
  },

  // ---------- assets ----------
  {
    name: 'upload_image',
    description: 'Upload a base64 image (raw or data: URI). Subject to MCP stdio frame limits — for >~6KB use upload_image_from_path or the chunked variant. Returns imageHash usable in IMAGE paints.',
    schema: z.object({ base64: z.string() }),
  },
  {
    name: 'upload_image_from_path',
    description: 'Bridge reads an image from a local filesystem path and registers it. Bypasses MCP stdio truncation entirely. Returns imageHash.',
    schema: z.object({ path: z.string() }),
  },
  {
    name: 'upload_image_begin',
    description: 'Start a chunked upload. Returns { uploadId } to use with upload_image_chunk + upload_image_finish.',
    schema: z.object({ name: z.string().optional() }),
  },
  {
    name: 'upload_image_chunk',
    description: 'Append a base64 chunk to an upload. Keep chunks ≤4KB to stay within stdio frame limits. seq is optional ordering hint.',
    schema: z.object({
      uploadId: z.string(),
      data: z.string(),
      seq: z.number().int().nonnegative().optional(),
    }),
  },
  {
    name: 'upload_image_finish',
    description: 'Concatenate all chunks for uploadId and register the image. Returns imageHash.',
    schema: z.object({ uploadId: z.string() }),
  },

  // ---------- variables: lifecycle ----------
  {
    name: 'create_variable_collection',
    description: 'Create a new local variable collection with one default mode. Returns { id, defaultModeId }.',
    schema: z.object({ name: z.string() }),
  },
  {
    name: 'delete_variable_collection',
    description: 'Delete a variable collection (and all its variables).',
    schema: z.object({ collectionId: z.string() }),
  },
  {
    name: 'create_variable',
    description: 'Create a new variable in a collection. resolvedType: COLOR | FLOAT | STRING | BOOLEAN. Optional initial value(s).',
    schema: z.object({
      name: z.string(),
      collectionId: z.string(),
      resolvedType: z.enum(['COLOR', 'FLOAT', 'STRING', 'BOOLEAN']),
      value: z.any().optional(),
      valuesByMode: z.record(z.any()).optional(),
      description: z.string().optional(),
      scopes: z.array(z.string()).optional(),
      codeSyntax: z.record(z.string()).optional(),
      hiddenFromPublishing: z.boolean().optional(),
    }),
  },
  {
    name: 'delete_variable',
    description: 'Delete a variable.',
    schema: z.object({ variableId: z.string() }),
  },
  {
    name: 'add_variable_mode',
    description: 'Add a mode to a collection. Returns the new modeId.',
    schema: z.object({ collectionId: z.string(), name: z.string() }),
  },
  {
    name: 'remove_variable_mode',
    description: 'Remove a mode from a collection.',
    schema: z.object({ collectionId: z.string(), modeId: z.string() }),
  },
  {
    name: 'rename_variable_mode',
    description: "Rename a collection's mode.",
    schema: z.object({ collectionId: z.string(), modeId: z.string(), name: z.string() }),
  },
  {
    name: 'set_variable_meta',
    description: "Update a variable's metadata (name, description, scopes, codeSyntax, hiddenFromPublishing). Values are unchanged — use set_variable_value for those.",
    schema: z.object({
      variableId: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      scopes: z.array(z.string()).optional(),
      codeSyntax: z.record(z.string()).optional(),
      hiddenFromPublishing: z.boolean().optional(),
    }),
  },

  // ---------- tier 1 ----------
  {
    name: 'flatten_nodes',
    description: 'Flatten one or more nodes into a single VECTOR. Outline strokes, collapse groups.',
    schema: z.object({
      nodeIds: z.array(z.string()).min(1),
      parentId: z.string().optional(),
      index: z.number().int().nonnegative().optional(),
    }),
  },
  {
    name: 'boolean_operation',
    description: 'Apply a Figma boolean operation to nodes. operation: UNION | SUBTRACT | INTERSECT | EXCLUDE.',
    schema: z.object({
      nodeIds: z.array(z.string()).min(2),
      operation: z.enum(['UNION', 'SUBTRACT', 'INTERSECT', 'EXCLUDE']),
      parentId: z.string().optional(),
      name: z.string().optional(),
    }),
  },
  {
    name: 'create_node_from_svg',
    description: 'Paste raw SVG markup; returns the resulting frame/vector tree.',
    schema: z.object({
      svg: z.string(),
      parentId: z.string().optional(),
      name: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
    }),
  },
  {
    name: 'notify',
    description: 'Show a Figma toast notification. Agent → user channel.',
    schema: z.object({
      message: z.string(),
      timeout: z.number().int().nonnegative().optional(),
      error: z.boolean().optional(),
    }),
  },
  {
    name: 'list_fonts',
    description: 'List fonts available in this editor. Optional case-insensitive family filter.',
    schema: z.object({ family: z.string().optional() }),
  },
  {
    name: 'load_font',
    description: 'Pre-load a font so subsequent text writes do not throw. Style defaults to Regular.',
    schema: z.object({ family: z.string(), style: z.string().optional() }),
  },
  {
    name: 'set_reactions',
    description: "Replace a node's prototype reactions. Each reaction = { trigger, action(s) } per Figma's Reaction shape.",
    schema: z.object({
      nodeId: z.string(),
      reactions: z.array(z.any()),
    }),
  },
  {
    name: 'get_styled_text_segments',
    description: 'Read per-range styled segments from a TEXT node. fields defaults to a sensible style set.',
    schema: z.object({
      nodeId: z.string(),
      fields: z.array(z.string()).optional(),
      start: z.number().int().nonnegative().optional(),
      end: z.number().int().nonnegative().optional(),
    }),
  },

  // ---------- tier 2 ----------
  {
    name: 'create_section',
    description: 'Create a SECTION (gray-ish container for organizing canvas regions).',
    schema: z.object({
      name: z.string().optional(),
      parentId: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().positive().optional(),
      height: z.number().positive().optional(),
    }),
  },
  {
    name: 'add_dev_resource',
    description: 'Attach a Dev Mode resource (URL + label) to a node.',
    schema: z.object({
      nodeId: z.string(),
      url: z.string(),
      name: z.string().optional(),
    }),
  },
  {
    name: 'delete_dev_resource',
    description: 'Remove a Dev Mode resource by URL.',
    schema: z.object({ nodeId: z.string(), url: z.string() }),
  },
  {
    name: 'get_dev_resources',
    description: 'Read all Dev Mode resources on a node.',
    schema: z.object({ nodeId: z.string() }),
  },
  {
    name: 'import_component_by_key',
    description: 'Import a component from a team library by its key. Returns the local-handle component.',
    schema: z.object({ key: z.string() }),
  },
  {
    name: 'import_style_by_key',
    description: 'Import a style from a team library by its key.',
    schema: z.object({ key: z.string() }),
  },
  {
    name: 'import_variable_by_key',
    description: 'Import a variable from a team library by its key.',
    schema: z.object({ key: z.string() }),
  },
  {
    name: 'create_image_from_url',
    description: 'Bridge fetches an http(s) URL and registers an Image. Returns imageHash for IMAGE paints.',
    schema: z.object({ url: z.string() }),
  },
  {
    name: 'set_viewport',
    description: 'Move/zoom the canvas viewport. Returns the resulting center/zoom/bounds.',
    schema: z.object({
      center: z.object({ x: z.number(), y: z.number() }).optional(),
      zoom: z.number().positive().optional(),
    }),
  },
  {
    name: 'commit_undo',
    description: 'Commit a single undo step encompassing all preceding writes since the last commit.',
    schema: z.object({}),
  },
  {
    name: 'save_version',
    description: 'Create a version-history snapshot. Returns its id.',
    schema: z.object({
      title: z.string(),
      description: z.string().optional(),
    }),
  },
  {
    name: 'set_annotation',
    description: 'Set annotations on a node. Pass either a single { label, properties? } or an array via `annotations`.',
    schema: z.object({
      nodeId: z.string(),
      label: z.string().optional(),
      properties: z.array(z.any()).optional(),
      annotations: z.array(z.any()).optional(),
    }),
  },
  {
    name: 'get_annotations',
    description: "Read a node's annotations.",
    schema: z.object({ nodeId: z.string() }),
  },

  // ---------- tier 3 ----------
  {
    name: 'create_sticky',
    description: 'FigJam: create a sticky note.',
    schema: z.object({
      text: z.string().optional(),
      author: z.string().optional(),
      parentId: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
    }),
  },
  {
    name: 'create_connector',
    description: 'FigJam: create a connector between two nodes (or detached).',
    schema: z.object({
      startNodeId: z.string().optional(),
      endNodeId: z.string().optional(),
      startMagnet: z.enum(['AUTO', 'TOP', 'BOTTOM', 'LEFT', 'RIGHT', 'CENTER']).optional(),
      endMagnet: z.enum(['AUTO', 'TOP', 'BOTTOM', 'LEFT', 'RIGHT', 'CENTER']).optional(),
      lineType: z.enum(['STRAIGHT', 'ELBOWED']).optional(),
      text: z.string().optional(),
      parentId: z.string().optional(),
    }),
  },
  {
    name: 'create_shape_with_text',
    description: 'FigJam: create a shape-with-text (oval, rectangle, rounded-rectangle, etc.).',
    schema: z.object({
      shapeType: z.string().optional(),
      text: z.string().optional(),
      parentId: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
    }),
  },
  {
    name: 'create_table',
    description: 'FigJam: create a table.',
    schema: z.object({
      numRows: z.number().int().positive().optional(),
      numColumns: z.number().int().positive().optional(),
      parentId: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
    }),
  },
  {
    name: 'set_vector_network',
    description: 'Replace the vector network of a VECTOR node. network: { regions: [], vertices: [{x,y}], segments: [{start,end,tangentStart:{x,y},tangentEnd:{x,y}}] }. Strings auto-parsed for permissive clients.',
    schema: z.object({
      nodeId: z.string(),
      network: z.union([
        z.string(),
        z.object({
          regions: z.array(z.any()).optional(),
          vertices: z.array(z.object({ x: z.number(), y: z.number() })),
          segments: z.array(z.object({
            start: z.number().int().nonnegative(),
            end: z.number().int().nonnegative(),
            tangentStart: z.object({ x: z.number(), y: z.number() }).optional(),
            tangentEnd: z.object({ x: z.number(), y: z.number() }).optional(),
          })),
        }),
      ]),
    }),
  },
  {
    name: 'set_shared_plugin_data',
    description: 'Write namespaced shared plugin data on a node (visible to other plugins in the same namespace).',
    schema: z.object({
      nodeId: z.string(),
      namespace: z.string(),
      key: z.string(),
      value: z.union([z.string(), z.null()]),
    }),
  },
  {
    name: 'get_shared_plugin_data',
    description: 'Read namespaced shared plugin data. Without `key`, returns all keys in the namespace.',
    schema: z.object({
      nodeId: z.string(),
      namespace: z.string(),
      key: z.string().optional(),
    }),
  },
  {
    name: 'get_selection_colors',
    description: 'Aggregate colors used by the current selection. Returns null if too many.',
    schema: z.object({}),
  },
  {
    name: 'set_file_thumbnail',
    description: 'Set the file thumbnail to a node (FRAME/COMPONENT/COMPONENT_SET/SECTION). nodeId=null clears.',
    schema: z.object({ nodeId: z.union([z.string(), z.null()]) }),
  },

  // ---------- tier 4 ----------
  {
    name: 'add_component_property',
    description: 'Add a property to a COMPONENT or COMPONENT_SET. type: VARIANT | TEXT | BOOLEAN | INSTANCE_SWAP. preferredValues optional.',
    schema: z.object({
      componentId: z.string(),
      name: z.string(),
      type: z.enum(['VARIANT', 'TEXT', 'BOOLEAN', 'INSTANCE_SWAP']),
      defaultValue: z.any(),
      preferredValues: z.array(z.any()).optional(),
    }),
  },
  {
    name: 'edit_component_property',
    description: "Rename or change defaults on a component's property. propertyName matches Figma's `name#hash`.",
    schema: z.object({
      componentId: z.string(),
      propertyName: z.string(),
      newName: z.string().optional(),
      defaultValue: z.any().optional(),
      preferredValues: z.array(z.any()).optional(),
    }),
  },
  {
    name: 'delete_component_property',
    description: 'Remove a property from a component / component set.',
    schema: z.object({
      componentId: z.string(),
      propertyName: z.string(),
    }),
  },
  {
    name: 'reset_instance_overrides',
    description: 'Reset all overrides on an INSTANCE.',
    schema: z.object({ nodeId: z.string() }),
  },
  {
    name: 'find_with_criteria',
    description: 'Optimized subtree search by node types and/or pluginData. Faster than search_nodes for plain type filtering.',
    schema: z.object({
      scope: z.string().optional(),
      types: z.array(NodeTypeEnum).optional(),
      pluginData: z.record(z.any()).optional(),
      sharedPluginData: z.record(z.any()).optional(),
      maxResults: z.number().int().positive().optional(),
    }),
  },
  {
    name: 'get_style_consumers',
    description: 'List nodes that consume a given style. Useful for refactor / cleanup.',
    schema: z.object({ styleId: z.string() }),
  },
  {
    name: 'trigger_undo',
    description: 'Programmatic undo (companion to commit_undo). Reverts the most recent committed step.',
    schema: z.object({}),
  },
  {
    name: 'open_external_url',
    description: 'Open a URL in a new browser tab via figma.openExternal.',
    schema: z.object({ url: z.string() }),
  },
  {
    name: 'client_storage_get',
    description: 'Read a value from per-user persistent storage (figma.clientStorage). Survives reloads.',
    schema: z.object({ key: z.string() }),
  },
  {
    name: 'client_storage_set',
    description: 'Write a value to per-user persistent storage.',
    schema: z.object({ key: z.string(), value: z.any() }),
  },
  {
    name: 'client_storage_delete',
    description: 'Delete a key from per-user persistent storage.',
    schema: z.object({ key: z.string() }),
  },
  {
    name: 'client_storage_keys',
    description: 'List all keys in per-user persistent storage.',
    schema: z.object({}),
  },

  // ---------- tier 5 (niche) ----------
  {
    name: 'create_slice',
    description: 'Create a SLICE node (export region marker).',
    schema: z.object({
      name: z.string().optional(),
      parentId: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().positive().optional(),
      height: z.number().positive().optional(),
    }),
  },
  {
    name: 'create_text_path',
    description: 'Create a TEXT_PATH node running text along an existing path node (Figma Draw). Requires pathNodeId (a vector/shape); startSegment (default 0) and startPosition (default 0) set where the text begins. Returns {id, type, textPathStartData}.',
    schema: z.object({
      pathNodeId: z.string(),
      startSegment: z.number().int().nonnegative().optional(),
      startPosition: z.number().optional(),
      text: z.string().optional(),
      parentId: z.string().optional(),
    }),
  },
  { name: 'transform_group', description: 'Wrap nodes in a Figma Draw TRANSFORM_GROUP (non-destructive transform container). transformModifiers is an array (default [] = plain group).', schema: z.object({ nodeIds: z.array(z.string()), parentId: z.string().optional(), index: z.number().int().nonnegative().optional(), transformModifiers: z.array(z.any()).optional() }) },
  { name: 'get_library_usage', description: 'Report team-library items used in the file — PAGINATED so the result is COMPLETE, never a silent partial. First call (no cursor): pass scope ("page" default | "document"); returns variableLibraries (enabled variable libraries WITH source filename) + the first page of remoteComponents/remoteStyles + nextCursor. Keep calling with cursor:nextCursor and UNION results by key until nextCursor is null (done). IMPORTANT LIMIT — the plugin API exposes source FILENAMES only for variables; components/styles come back as key+name only (use the Figma REST API for their library file). Every response carries a `limitations` array. maxResolve bounds per-call work (default 1500); a cursor is invalidated if the plugin reloads mid-scan (explicit error to restart).', schema: z.object({ scope: z.enum(['page', 'document']).optional(), cursor: z.string().optional(), maxResolve: z.number().int().positive().optional() }) },
  {
    name: 'create_gif',
    description: 'Create a GIF node referencing an existing image hash.',
    schema: z.object({
      imageHash: z.string(),
      parentId: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
    }),
  },
  {
    name: 'create_video',
    description: 'Create a video node from base64-encoded bytes.',
    schema: z.object({
      base64: z.string(),
      parentId: z.string().optional(),
    }),
  },
  {
    name: 'create_link_preview',
    description: 'Create a link preview node from a URL (FigJam).',
    schema: z.object({
      url: z.string(),
      parentId: z.string().optional(),
    }),
  },
  {
    name: 'create_page_divider',
    description: 'Create a page divider in the pages list (visual separator).',
    schema: z.object({ name: z.string().optional() }),
  },
  {
    name: 'create_slide',
    description: 'Slides editor only. Create a new slide.',
    schema: z.object({ name: z.string().optional() }),
  },
  {
    name: 'create_slide_row',
    description: 'Slides editor only. Create a slide row.',
    schema: z.object({}),
  },
  {
    name: 'create_code_block',
    description: 'FigJam: create a code block. languages per Figma list.',
    schema: z.object({
      code: z.string().optional(),
      language: z.string().optional(),
      parentId: z.string().optional(),
    }),
  },
  {
    name: 'timer_start',
    description: 'FigJam: start the file timer for N seconds.',
    schema: z.object({ seconds: z.number().int().positive() }),
  },
  {
    name: 'timer_stop',
    description: 'FigJam: stop the timer.',
    schema: z.object({}),
  },
  {
    name: 'timer_pause',
    description: 'FigJam: pause the timer.',
    schema: z.object({}),
  },
  {
    name: 'timer_resume',
    description: 'FigJam: resume the timer.',
    schema: z.object({}),
  },
  {
    name: 'get_active_users',
    description: 'Multiplayer awareness: list users currently in the file (FigJam mainly).',
    schema: z.object({}),
  },
  {
    name: 'get_current_user',
    description: "Read the running plugin's current user info.",
    schema: z.object({}),
  },

  // ---------- tier 6 ----------
  { name: 'bind_effect_to_variable', description: 'Bind an Effect property to a variable. Default effectIndex 0.', schema: z.object({ nodeId: z.string(), variableId: z.string(), field: z.string(), effectIndex: z.number().int().nonnegative().optional() }) },
  { name: 'bind_layout_grid_to_variable', description: 'Bind a LayoutGrid property to a variable. Default gridIndex 0.', schema: z.object({ nodeId: z.string(), variableId: z.string(), field: z.string(), gridIndex: z.number().int().nonnegative().optional() }) },
  { name: 'set_explicit_variable_mode', description: 'Override the active mode for a variable collection on a specific node.', schema: z.object({ nodeId: z.string(), collectionId: z.string(), modeId: z.string() }) },
  { name: 'clear_explicit_variable_mode', description: 'Clear a per-node mode override.', schema: z.object({ nodeId: z.string(), collectionId: z.string() }) },
  { name: 'get_instances', description: 'Find every instance of a COMPONENT or COMPONENT_SET.', schema: z.object({ componentId: z.string() }) },
  { name: 'import_component_set_by_key', description: 'Import a component set from team library.', schema: z.object({ key: z.string() }) },
  { name: 'outline_stroke', description: 'Outline a single node\'s stroke into a vector. Returns the new node.', schema: z.object({ nodeId: z.string() }) },
  { name: 'rescale', description: 'Proportional resize by a factor.', schema: z.object({ nodeId: z.string(), factor: z.number().positive() }) },
  { name: 'lock_aspect_ratio', description: 'Lock node aspect ratio.', schema: z.object({ nodeId: z.string() }) },
  { name: 'unlock_aspect_ratio', description: 'Unlock node aspect ratio.', schema: z.object({ nodeId: z.string() }) },
  { name: 'edit_dev_resource', description: 'Edit a Dev Mode resource (rename or change URL).', schema: z.object({ nodeId: z.string(), currentUrl: z.string(), name: z.string().optional(), url: z.string().optional() }) },
  { name: 'add_measurement', description: 'Add a Dev Mode measurement between two node sides.', schema: z.object({ startNodeId: z.string(), endNodeId: z.string(), startSide: z.string().optional(), endSide: z.string().optional(), offset: z.any().optional(), freeText: z.string().optional() }) },
  { name: 'edit_measurement', description: 'Edit an existing measurement (offset / freeText).', schema: z.object({ measurementId: z.string(), offset: z.any().optional(), freeText: z.string().optional() }) },
  { name: 'delete_measurement', description: 'Delete a measurement by id.', schema: z.object({ measurementId: z.string() }) },
  { name: 'get_measurements', description: 'List all measurements in the file.', schema: z.object({}) },
  { name: 'get_measurements_for_node', description: 'List measurements anchored on a node.', schema: z.object({ nodeId: z.string() }) },
  { name: 'add_annotation_category', description: 'Create a Dev Mode annotation category (label + color).', schema: z.object({ label: z.string(), color: z.any().optional() }) },
  { name: 'get_annotation_categories', description: 'List all annotation categories in the file.', schema: z.object({}) },
  { name: 'get_annotation_category', description: 'Get one annotation category by id.', schema: z.object({ categoryId: z.string() }) },
  { name: 'edit_annotation_category', description: 'Rename or recolor an annotation category. Pass label and/or color.', schema: z.object({ categoryId: z.string(), label: z.string().optional(), color: z.any().optional() }) },
  { name: 'delete_annotation_category', description: 'Delete an annotation category.', schema: z.object({ categoryId: z.string() }) },
  { name: 'table_insert_row', description: 'Insert a row into a TABLE. index defaults to end.', schema: z.object({ nodeId: z.string(), index: z.number().int().nonnegative().optional() }) },
  { name: 'table_insert_column', description: 'Insert a column into a TABLE.', schema: z.object({ nodeId: z.string(), index: z.number().int().nonnegative().optional() }) },
  { name: 'table_remove_row', description: 'Remove a row.', schema: z.object({ nodeId: z.string(), index: z.number().int().nonnegative() }) },
  { name: 'table_remove_column', description: 'Remove a column.', schema: z.object({ nodeId: z.string(), index: z.number().int().nonnegative() }) },
  { name: 'table_move_row', description: 'Move a row.', schema: z.object({ nodeId: z.string(), fromIndex: z.number().int().nonnegative(), toIndex: z.number().int().nonnegative() }) },
  { name: 'table_move_column', description: 'Move a column.', schema: z.object({ nodeId: z.string(), fromIndex: z.number().int().nonnegative(), toIndex: z.number().int().nonnegative() }) },
  { name: 'table_cell_at', description: 'Read the table cell at (row, column).', schema: z.object({ nodeId: z.string(), row: z.number().int().nonnegative(), column: z.number().int().nonnegative() }) },
  { name: 'slides_get_canvas_grid', description: 'Slides editor: get current canvas grid.', schema: z.object({}) },
  { name: 'slides_set_canvas_grid', description: 'Slides editor: set the canvas grid.', schema: z.object({ grid: z.any() }) },
  { name: 'slides_create_canvas_row', description: 'Slides editor: create a new canvas row.', schema: z.object({}) },
  { name: 'slides_move_nodes_to_coord', description: 'Slides editor: move nodes to a (row, column) coordinate.', schema: z.object({ nodeIds: z.array(z.string()).min(1), row: z.number().int().nonnegative(), column: z.number().int().nonnegative() }) },
  { name: 'set_slide_transition', description: 'Slides editor: set transition on a SLIDE node.', schema: z.object({ nodeId: z.string(), transition: z.any() }) },
  { name: 'get_slide_transition', description: 'Slides editor: read a SLIDE node\'s transition.', schema: z.object({ nodeId: z.string() }) },
  { name: 'ui_show', description: 'Show the plugin window.', schema: z.object({}) },
  { name: 'ui_hide', description: 'Hide the plugin window.', schema: z.object({}) },
  { name: 'ui_resize', description: 'Resize the plugin window.', schema: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }) },
  { name: 'ui_reposition', description: 'Reposition the plugin window.', schema: z.object({ x: z.number(), y: z.number() }) },
  { name: 'set_relaunch_data', description: "Attach plugin re-entry buttons to a node. data: { command: tooltip }.", schema: z.object({ nodeId: z.string(), data: z.record(z.string()) }) },
  { name: 'get_relaunch_data', description: 'Read relaunch data on a node.', schema: z.object({ nodeId: z.string() }) },
  { name: 'get_top_level_frame', description: 'Find the top-level FRAME ancestor of a node.', schema: z.object({ nodeId: z.string() }) },
  { name: 'get_text_content', description: 'Walk a subtree and return every TEXT node\'s characters.', schema: z.object({ nodeId: z.string() }) },
  { name: 'get_image_by_hash', description: 'Fetch a registered image by its hash. Returns { hash, bytesLength, size, base64 } or null. base64 is the raw image bytes.', schema: z.object({ imageHash: z.string() }) },
  { name: 'get_stamp_author', description: 'FigJam: read author of a STAMP node. Requires fileusers permission.', schema: z.object({ nodeId: z.string() }) },
  { name: 'get_overrides', description: "Read an INSTANCE's overrides (delta vs main component).", schema: z.object({ nodeId: z.string() }) },
  { name: 'get_publish_status', description: 'Read publish status for a style, variable, or variable collection.', schema: z.object({ id: z.string() }) },
  { name: 'set_text_range_bound_variable', description: 'Bind a variable to a text range field. variableId=null clears.', schema: z.object({ nodeId: z.string(), start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), field: z.string(), variableId: z.union([z.string(), z.null()]).optional() }) },
  { name: 'get_text_range_bound_variable', description: 'Read variable bound to a text range field.', schema: z.object({ nodeId: z.string(), start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), field: z.string() }) },
  { name: 'insert_characters', description: 'Insert characters into a TEXT at offset.', schema: z.object({ nodeId: z.string(), start: z.number().int().nonnegative(), characters: z.string(), behavior: z.string().optional() }) },
  { name: 'delete_characters', description: 'Delete characters from a TEXT [start, end).', schema: z.object({ nodeId: z.string(), start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }) },
  { name: 'get_attached_connectors', description: 'List FigJam connectors attached to a node.', schema: z.object({ nodeId: z.string() }) },
  { name: 'set_skip_invisible_instance_children', description: "Toggle figma.skipInvisibleInstanceChildren perf flag.", schema: z.object({ value: z.boolean() }) },
  { name: 'get_file_thumbnail_node', description: 'Read which node is the file thumbnail.', schema: z.object({}) },
  { name: 'load_brushes', description: 'Buzz only: list available brushes.', schema: z.object({}) },

  // ---------- tier 7 ----------
  { name: 'extend_library_collection_by_key', description: 'Extend a remote variable collection (from team library) into this file by its key.', schema: z.object({ key: z.string() }) },
  { name: 'request_variable_to_be_enabled', description: 'Request that a library variable be enabled in this file.', schema: z.object({ variableId: z.string() }) },
  { name: 'request_variable_to_be_disabled', description: 'Request that a library variable be disabled in this file.', schema: z.object({ variableId: z.string() }) },
  { name: 'table_resize_row', description: 'Set a TABLE row\'s height.', schema: z.object({ nodeId: z.string(), index: z.number().int().nonnegative(), height: z.number().positive() }) },
  { name: 'table_resize_column', description: 'Set a TABLE column\'s width.', schema: z.object({ nodeId: z.string(), index: z.number().int().nonnegative(), width: z.number().positive() }) },
  { name: 'create_slot', description: 'Create a SLOT inside a COMPONENT (used for slot-based variant authoring).', schema: z.object({ componentId: z.string(), name: z.string().optional() }) },
  { name: 'set_grid_child_position', description: 'Place a direct child of a GRID auto-layout frame at a 0-based (row, column) cell. Configure the grid container first via set_node_property (layoutMode="GRID", gridRowCount/gridColumnCount, gridRowGap/gridColumnGap, gridColumnSizes/gridRowSizes).', schema: z.object({ nodeId: z.string(), row: z.number().int().nonnegative(), column: z.number().int().nonnegative() }) },
  { name: 'list_shaders', description: 'List shaders available to this file (Figma shader subsystem). Returns an array of shader descriptors (empty if the file has none). Use a returned id with import_shader, then apply via set_node_property fills/effects with {type:"SHADER", shaderId}.', schema: z.object({}) },
  { name: 'import_shader', description: 'Materialize a shader into this file by id (get the id from list_shaders). Returns the imported shader descriptor. Required before a SHADER paint/effect referencing it can be applied.', schema: z.object({ shaderId: z.string() }) },

  // ---------- Motion (native keyframe/timeline animation, distinct from prototype reactions) ----------
  { name: 'list_animation_styles', description: 'List Figma Motion built-in animation presets (Position, Scale, Rotation, Size, Opacity, Path). Each returns {styleId, name, description, props}. NOTE: `props` is a human/type DESCRIPTOR of the preset, not the exact applyAnimationStyle input schema (which is stricter and validated by Figma) — start minimal (e.g. {duration}) and read Figma\'s error to refine.', schema: z.object({}) },
  { name: 'get_animations', description: 'Read a node\'s Motion data: {animationStyles, animations, manualKeyframeTracks, timelines}. Dedicated read tool (not part of get_node) to avoid bloating every node read.', schema: z.object({ nodeId: z.string() }) },
  { name: 'apply_animation_style', description: 'Apply a Figma Motion preset to a node. styleId from list_animation_styles; props is the preset data (forwarded verbatim to node.applyAnimationStyle — Figma validates per-preset). Mutating.', schema: z.object({ nodeId: z.string(), styleId: z.string(), props: z.record(z.any()).optional() }) },
  { name: 'remove_animation_style', description: 'Remove an applied Motion preset from a node. `id` is the applied-instance id (animationStyles[].id from get_animations), NOT the preset styleId.', schema: z.object({ nodeId: z.string(), id: z.string() }) },
  { name: 'apply_manual_keyframe_track', description: 'Add/replace a manual keyframe track on a node (Figma Motion). `field` identifies what to animate: {type:"PROPERTY", name} for a node property, or {type:"INDEXED_ITEM", collection:"effects", index, field:"RADIUS"|"COLOR"|"SPREAD"|...} for an item in a collection. `track` is {keyframes:[{timelinePosition:<sec>, value:{type:"FLOAT", value:<n>}, easing?}]}. Node must have a timeline (apply a preset first) and the referenced item must exist.', schema: z.object({ nodeId: z.string(), field: z.any(), track: z.any() }) },
  { name: 'remove_manual_keyframe_track', description: 'Remove a manual keyframe track from a node by the same `field` descriptor passed to apply_manual_keyframe_track.', schema: z.object({ nodeId: z.string(), field: z.any() }) },
  { name: 'set_timeline_duration', description: 'Set a Motion timeline\'s duration (seconds). timelineId from get_animations timelines[].id.', schema: z.object({ nodeId: z.string(), timelineId: z.string(), duration: z.number().nonnegative() }) },
  { name: 'spring_to_normalized', description: 'Figma Motion helper: convert physical spring params to a normalized easing curve. `spring` forwarded to figma.motion.physicalSpringToNormalized.', schema: z.object({ spring: z.any() }) },
  {
    name: 'run_script',
    description:
      'Execute JS inside the Figma plugin sandbox. Use for bulk ops where N tool calls would be slow (walk thousands of nodes, batch mutations, custom predicates). Scope: `args`, `figma`, `serializeNode(n,opts)`, `coerce(v)`, `asIds(v)`, `log(...)`, `getNode(id)`. Body is wrapped in an async IIFE so `await` works. Return value must be JSON-serializable. Returns `{ result, logs[], ms }`. Same write-trust as any other mutating tool — no sandbox-within-sandbox. ' +
      'CRITICAL — your code runs on Figma\'s single main thread and CANNOT be interrupted by the bridge: a long synchronous loop FREEZES the whole Figma window and only a tab reload recovers it (the bridge will reject your other calls with plugin_busy meanwhile). Guardrails: (1) NEVER write an unbounded synchronous loop over a large set; chunk it and `await` between chunks (e.g. process 500 nodes, then `await new Promise(r => setTimeout(r, 0))`) so the thread can breathe. (2) Prefer `figma.root.findAllWithCriteria({types:[...]})` or a bounded `serializeNode(n,{depth,maxNodes})` over a raw `findAll(() => true)` on a big page. (3) Keep the returned payload small — return ids/counts, not deep serializations of thousands of nodes. (4) Avoid `while(true)` / recursion without a hard depth cap.',
    schema: z.object({
      code: z.string(),
      args: z.any().optional(),
    }),
  },
  { name: 'set_buzz_asset_type', description: 'Buzz only: tag a node\'s buzz asset type.', schema: z.object({ nodeId: z.string(), assetType: z.string() }) },
  { name: 'get_buzz_asset_type', description: 'Buzz only: read a node\'s buzz asset type.', schema: z.object({ nodeId: z.string() }) },
  { name: 'move_local_style', description: 'Reorder a local style (paint/text/effect/grid). afterStyleId omitted moves to first.', schema: z.object({ styleId: z.string(), afterStyleId: z.string().optional() }) },
  { name: 'delete_style', description: 'Delete a local style by id. Counterpart to set_style (which creates/updates).', schema: z.object({ styleId: z.string() }) },

  // ---------- variants + paint variable binding ----------
  {
    name: 'combine_as_variants',
    description: 'Merge ≥2 COMPONENT nodes into a single COMPONENT_SET (Figma variant set). Same as Cmd+Opt+K in the editor.',
    schema: z.object({
      nodeIds: z.array(z.string()).min(2),
      parentId: z.string().optional(),
      index: z.number().int().nonnegative().optional(),
      name: z.string().optional(),
    }),
  },
  {
    name: 'bind_paint_to_variable',
    description: "Bind a single paint's color to a COLOR variable (per-paint, unlike bind_property_to_variable which binds whole-property). Defaults to fills[0].color.",
    schema: z.object({
      nodeId: z.string(),
      variableId: z.string(),
      paintField: z.enum(['fills', 'strokes']).optional(),
      paintIndex: z.number().int().nonnegative().optional(),
      field: z.string().optional(),
    }),
  },

  // ---------- text range ----------
  {
    name: 'set_text_range_property',
    description: 'Apply a per-range property to part of a TEXT node. property: fills, fontName, fontSize, fontWeight, lineHeight, letterSpacing, textCase, textDecoration, hyperlink, listOptions, paragraphSpacing, paragraphIndent.',
    schema: z.object({
      nodeId: z.string(),
      start: z.number().int().nonnegative(),
      end: z.number().int().nonnegative(),
      property: z.string(),
      value: z.any(),
    }),
  },

  {
    name: 'subscribe_selection',
    description: 'Start receiving selectionchange notifications.',
    schema: z.object({}),
    subscription: true,
  },
  {
    name: 'subscribe_document',
    description: 'Start receiving documentchange notifications (debounced 500ms).',
    schema: z.object({}),
    subscription: true,
  },
  {
    name: 'subscribe_currentpage',
    description: 'Start receiving currentpagechange notifications when the user switches pages.',
    schema: z.object({}),
    subscription: true,
  },
];

// JSON-Schema friendly enough for MCP listTools.
const richReadProps = {
  depth: { type: 'integer', description: '1..N, -1 for full tree. Default 12 for node reads.' },
  maxNodes: { type: 'integer', description: 'Max nodes to walk before children collapse to stubs + truncated:true. Default 3000; pass 0 for unbounded (can be slow on big selections).' },
  includeChildren: { type: 'boolean' },
  includeParent: { type: 'boolean' },
  includePluginData: { type: 'boolean' },
  pluginDataKeys: { type: 'array', items: { type: 'string' } },
  includeBoundVariables: { type: 'boolean' },
  properties: {
    type: 'array',
    items: { type: 'string' },
    description: 'Whitelist of top-level fields to include. Omit to return all.',
  },
};

export function toolInputSchema(name: string): Record<string, unknown> {
  switch (name) {
    case 'grip_health':
    case 'grip_diagnose':
    case 'list_files':
    case 'get_document':
    case 'get_styles':
    case 'get_variables':
    case 'subscribe_selection':
    case 'subscribe_document':
    case 'subscribe_currentpage':
      return { type: 'object', properties: {}, additionalProperties: false };
    case 'set_active_file':
      return {
        type: 'object',
        properties: { target: { type: 'string', description: 'sessionId or fileKey' } },
        required: ['target'],
        additionalProperties: false,
      };
    case 'get_page':
      return {
        type: 'object',
        properties: {
          pageId: { type: 'string' },
          nodeTypes: { type: 'array', items: { type: 'string' } },
          nameFilter: { type: 'string', description: 'Regex (case-insensitive) post-walk filter' },
          ...richReadProps,
        },
        additionalProperties: false,
      };
    case 'get_node':
      return {
        type: 'object',
        properties: { nodeId: { type: 'string' }, ...richReadProps },
        required: ['nodeId'],
        additionalProperties: false,
      };
    case 'get_nodes':
      return {
        type: 'object',
        properties: {
          nodeIds: { type: 'array', items: { type: 'string' }, minItems: 1 },
          ...richReadProps,
        },
        required: ['nodeIds'],
        additionalProperties: false,
      };
    case 'get_selection':
      return {
        type: 'object',
        properties: { ...richReadProps },
        additionalProperties: false,
      };
    case 'get_deep_link':
      return {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: 'Target node; defaults to first selected node, else current page' },
          kind: { type: 'string', enum: ['design', 'dev', 'proto'], description: "design (default) | dev (Dev Mode) | proto (prototype player)" },
        },
        additionalProperties: false,
      };
    case 'get_components':
      return {
        type: 'object',
        properties: { includePropertyDefinitions: { type: 'boolean' } },
        additionalProperties: false,
      };
    case 'search_nodes':
      return {
        type: 'object',
        properties: {
          pageId: { type: 'string' },
          scope: { type: 'string', description: 'Subtree root nodeId' },
          allPages: { type: 'boolean' },
          name: { type: 'string', description: 'Substring (case-insensitive)' },
          nameRegex: { type: 'string' },
          nameFlags: { type: 'string', description: 'Regex flags, default i' },
          type: {
            anyOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } },
            ],
          },
          textContains: { type: 'string', description: 'TEXT-only character match' },
          fillHex: { type: 'string', description: '#RRGGBB; matches first SOLID fill' },
          maxResults: { type: 'integer' },
          offset: { type: 'integer' },
        },
        additionalProperties: false,
      };
    case 'export_node':
      return {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          format: { type: 'string', enum: ['SVG', 'PNG', 'JPG', 'PDF', 'CSS', 'JSON', 'MP4', 'GIF', 'WEBM'] },
          path: { type: 'string', description: 'Absolute file path; bridge writes bytes to disk, returns {path,format,bytes}. Required for PNG/JPG/PDF and all video formats.' },
          scale: { type: 'number' },
          fps: { type: 'number', description: 'Video only (MP4/GIF/WEBM).' },
          quality: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'], description: 'Video only: MP4/WEBM encode quality.' },
          loopCount: { type: 'integer', description: 'Video only: GIF loop count (0 = infinite).' },
          constraint: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['SCALE', 'WIDTH', 'HEIGHT'] },
              value: { type: 'number' },
            },
            required: ['type', 'value'],
          },
          contentsOnly: { type: 'boolean' },
          useAbsoluteBounds: { type: 'boolean' },
          suffix: { type: 'string' },
          colorProfile: { type: 'string', enum: ['DOCUMENT', 'SRGB', 'DISPLAY_P3_V4'] },
          svgOutlineText: { type: 'boolean' },
          svgIdAttribute: { type: 'boolean' },
          svgSimplifyStroke: { type: 'boolean' },
          ...richReadProps,
        },
        required: ['nodeId', 'format'],
        additionalProperties: false,
      };
    case 'set_grid_child_position':
      return {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          row: { type: 'integer', description: '0-based grid row' },
          column: { type: 'integer', description: '0-based grid column' },
        },
        required: ['nodeId', 'row', 'column'],
        additionalProperties: false,
      };
    case 'import_shader':
      return {
        type: 'object',
        properties: { shaderId: { type: 'string', description: 'Shader id from list_shaders' } },
        required: ['shaderId'],
        additionalProperties: false,
      };
    case 'get_animations':
      return { type: 'object', properties: { nodeId: { type: 'string' } }, required: ['nodeId'], additionalProperties: false };
    case 'apply_animation_style':
      return {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          styleId: { type: 'string', description: 'Preset id from list_animation_styles (Position/Scale/Rotation/Size/Opacity/Path)' },
          props: { type: 'object', description: 'Preset data, forwarded verbatim to Figma (validated per-preset). Start minimal, e.g. {duration:0.5}.' },
        },
        required: ['nodeId', 'styleId'],
        additionalProperties: false,
      };
    case 'remove_animation_style':
      return { type: 'object', properties: { nodeId: { type: 'string' }, id: { type: 'string', description: 'Applied-instance id (animationStyles[].id)' } }, required: ['nodeId', 'id'], additionalProperties: false };
    case 'apply_manual_keyframe_track':
      return {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          field: { type: 'object', description: 'What to animate: {type:"PROPERTY",name} or {type:"INDEXED_ITEM",collection:"effects",index,field:"RADIUS"|"COLOR"|...}' },
          track: { type: 'object', description: '{keyframes:[{timelinePosition, value:{type:"FLOAT",value}, easing?}]}' },
        },
        required: ['nodeId', 'field', 'track'],
        additionalProperties: false,
      };
    case 'remove_manual_keyframe_track':
      return { type: 'object', properties: { nodeId: { type: 'string' }, field: { type: 'object', description: 'Same field descriptor passed to apply' } }, required: ['nodeId', 'field'], additionalProperties: false };
    case 'set_timeline_duration':
      return { type: 'object', properties: { nodeId: { type: 'string' }, timelineId: { type: 'string', description: 'timelines[].id from get_animations' }, duration: { type: 'number', description: 'Seconds' } }, required: ['nodeId', 'timelineId', 'duration'], additionalProperties: false };
    case 'spring_to_normalized':
      return { type: 'object', properties: { spring: { type: 'object', description: 'Physical spring params (mass, stiffness, damping, …).' } }, required: ['spring'], additionalProperties: false };
    case 'set_node_property':
      return {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          property: { type: 'string' },
          value: {},
        },
        required: ['nodeId', 'property', 'value'],
        additionalProperties: false,
      };
    case 'create_node':
      return {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['FRAME', 'TEXT', 'RECTANGLE', 'ELLIPSE', 'LINE', 'POLYGON', 'STAR', 'VECTOR', 'COMPONENT', 'INSTANCE'],
          },
          parentId: { type: 'string' },
          name: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
          componentId: { type: 'string' },
          props: { type: 'object', description: 'Any set_node_property values applied at creation' },
          selectAfter: { type: 'boolean' },
        },
        required: ['type'],
        additionalProperties: false,
      };
    case 'delete_node':
      return {
        type: 'object',
        properties: { nodeId: { type: 'string' } },
        required: ['nodeId'],
        additionalProperties: false,
      };
    case 'set_variable_value':
      return {
        type: 'object',
        properties: {
          variableId: { type: 'string' },
          modeId: { type: 'string' },
          value: {},
        },
        required: ['variableId', 'modeId', 'value'],
        additionalProperties: false,
      };
    case 'set_style':
      return {
        type: 'object',
        properties: {
          styleId: { type: 'string' },
          name: { type: 'string' },
          type: { type: 'string', enum: ['PAINT', 'TEXT', 'EFFECT', 'GRID'] },
          value: {},
        },
        required: ['name', 'type', 'value'],
        additionalProperties: false,
      };
    case 'set_selection':
      return {
        type: 'object',
        properties: {
          nodeIds: { type: 'array', items: { type: 'string' }, minItems: 1 },
          scrollTo: { type: 'boolean' },
        },
        required: ['nodeIds'],
        additionalProperties: false,
      };
    case 'scroll_to':
      return {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          nodeIds: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      };
    case 'clone_node':
      return {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          parentId: { type: 'string' },
          index: { type: 'integer' },
          x: { type: 'number' },
          y: { type: 'number' },
          name: { type: 'string' },
        },
        required: ['nodeId'],
        additionalProperties: false,
      };
    case 'move_node':
      return {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          parentId: { type: 'string' },
          index: { type: 'integer' },
        },
        required: ['nodeId', 'parentId'],
        additionalProperties: false,
      };
    case 'group_nodes':
      return {
        type: 'object',
        properties: {
          nodeIds: { type: 'array', items: { type: 'string' }, minItems: 1 },
          parentId: { type: 'string' },
          asFrame: { type: 'boolean' },
          name: { type: 'string' },
        },
        required: ['nodeIds'],
        additionalProperties: false,
      };
    case 'ungroup_node':
      return {
        type: 'object',
        properties: { nodeId: { type: 'string' } },
        required: ['nodeId'],
        additionalProperties: false,
      };
    case 'create_page':
      return {
        type: 'object',
        properties: {
          name: { type: 'string' },
          makeCurrent: { type: 'boolean' },
        },
        additionalProperties: false,
      };
    case 'set_current_page':
    case 'delete_page':
      return {
        type: 'object',
        properties: { pageId: { type: 'string' } },
        required: ['pageId'],
        additionalProperties: false,
      };
    case 'get_plugin_data':
      return {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          key: { type: 'string' },
        },
        required: ['nodeId'],
        additionalProperties: false,
      };
    case 'set_plugin_data':
      return {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          key: { type: 'string' },
          value: { type: ['string', 'null'] },
        },
        required: ['nodeId', 'key', 'value'],
        additionalProperties: false,
      };
    case 'detach_instance':
      return {
        type: 'object',
        properties: { nodeId: { type: 'string' } },
        required: ['nodeId'],
        additionalProperties: false,
      };
    case 'swap_instance':
      return {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          componentId: { type: 'string' },
        },
        required: ['nodeId', 'componentId'],
        additionalProperties: false,
      };
    case 'create_component_from_node':
      return {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['nodeId'],
        additionalProperties: false,
      };
    case 'apply_style':
      return {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          styleId: { type: 'string' },
          kind: { type: 'string', enum: ['fill', 'stroke', 'effect', 'grid', 'text'] },
        },
        required: ['nodeId', 'styleId', 'kind'],
        additionalProperties: false,
      };
    case 'bind_property_to_variable':
      return {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          field: { type: 'string' },
          variableId: { type: 'string' },
        },
        required: ['nodeId', 'field', 'variableId'],
        additionalProperties: false,
      };
    case 'upload_image':
      return {
        type: 'object',
        properties: { base64: { type: 'string' } },
        required: ['base64'],
        additionalProperties: false,
      };
    case 'upload_image_from_path':
      return {
        type: 'object',
        properties: { path: { type: 'string', description: 'Absolute or cwd-relative path' } },
        required: ['path'],
        additionalProperties: false,
      };
    case 'upload_image_begin':
      return {
        type: 'object',
        properties: { name: { type: 'string' } },
        additionalProperties: false,
      };
    case 'upload_image_chunk':
      return {
        type: 'object',
        properties: {
          uploadId: { type: 'string' },
          data: { type: 'string', description: 'Base64 chunk; keep ≤4KB' },
          seq: { type: 'integer' },
        },
        required: ['uploadId', 'data'],
        additionalProperties: false,
      };
    case 'upload_image_finish':
      return {
        type: 'object',
        properties: { uploadId: { type: 'string' } },
        required: ['uploadId'],
        additionalProperties: false,
      };
    case 'create_variable_collection':
      return {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false,
      };
    case 'delete_variable_collection':
      return {
        type: 'object',
        properties: { collectionId: { type: 'string' } },
        required: ['collectionId'],
        additionalProperties: false,
      };
    case 'create_variable':
      return {
        type: 'object',
        properties: {
          name: { type: 'string' },
          collectionId: { type: 'string' },
          resolvedType: { type: 'string', enum: ['COLOR', 'FLOAT', 'STRING', 'BOOLEAN'] },
          value: {},
          valuesByMode: { type: 'object' },
          description: { type: 'string' },
          scopes: { type: 'array', items: { type: 'string' } },
          codeSyntax: { type: 'object' },
          hiddenFromPublishing: { type: 'boolean' },
        },
        required: ['name', 'collectionId', 'resolvedType'],
        additionalProperties: false,
      };
    case 'delete_variable':
      return {
        type: 'object',
        properties: { variableId: { type: 'string' } },
        required: ['variableId'],
        additionalProperties: false,
      };
    case 'add_variable_mode':
      return {
        type: 'object',
        properties: {
          collectionId: { type: 'string' },
          name: { type: 'string' },
        },
        required: ['collectionId', 'name'],
        additionalProperties: false,
      };
    case 'remove_variable_mode':
      return {
        type: 'object',
        properties: {
          collectionId: { type: 'string' },
          modeId: { type: 'string' },
        },
        required: ['collectionId', 'modeId'],
        additionalProperties: false,
      };
    case 'rename_variable_mode':
      return {
        type: 'object',
        properties: {
          collectionId: { type: 'string' },
          modeId: { type: 'string' },
          name: { type: 'string' },
        },
        required: ['collectionId', 'modeId', 'name'],
        additionalProperties: false,
      };
    case 'set_variable_meta':
      return {
        type: 'object',
        properties: {
          variableId: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
          scopes: { type: 'array', items: { type: 'string' } },
          codeSyntax: { type: 'object' },
          hiddenFromPublishing: { type: 'boolean' },
        },
        required: ['variableId'],
        additionalProperties: false,
      };
    case 'flatten_nodes':
      return {
        type: 'object',
        properties: {
          nodeIds: { type: 'array', items: { type: 'string' }, minItems: 1 },
          parentId: { type: 'string' },
          index: { type: 'integer' },
        },
        required: ['nodeIds'],
        additionalProperties: false,
      };
    case 'boolean_operation':
      return {
        type: 'object',
        properties: {
          nodeIds: { type: 'array', items: { type: 'string' }, minItems: 2 },
          operation: { type: 'string', enum: ['UNION', 'SUBTRACT', 'INTERSECT', 'EXCLUDE'] },
          parentId: { type: 'string' },
          name: { type: 'string' },
        },
        required: ['nodeIds', 'operation'],
        additionalProperties: false,
      };
    case 'create_node_from_svg':
      return {
        type: 'object',
        properties: {
          svg: { type: 'string' },
          parentId: { type: 'string' },
          name: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' },
        },
        required: ['svg'],
        additionalProperties: false,
      };
    case 'notify':
      return {
        type: 'object',
        properties: {
          message: { type: 'string' },
          timeout: { type: 'integer' },
          error: { type: 'boolean' },
        },
        required: ['message'],
        additionalProperties: false,
      };
    case 'list_fonts':
      return {
        type: 'object',
        properties: { family: { type: 'string' } },
        additionalProperties: false,
      };
    case 'load_font':
      return {
        type: 'object',
        properties: {
          family: { type: 'string' },
          style: { type: 'string' },
        },
        required: ['family'],
        additionalProperties: false,
      };
    case 'set_reactions':
      return {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          reactions: { type: 'array' },
        },
        required: ['nodeId', 'reactions'],
        additionalProperties: false,
      };
    case 'get_styled_text_segments':
      return {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          fields: { type: 'array', items: { type: 'string' } },
          start: { type: 'integer' },
          end: { type: 'integer' },
        },
        required: ['nodeId'],
        additionalProperties: false,
      };
    case 'create_section':
      return {
        type: 'object',
        properties: {
          name: { type: 'string' },
          parentId: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
        },
        additionalProperties: false,
      };
    case 'add_dev_resource':
      return {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          url: { type: 'string' },
          name: { type: 'string' },
        },
        required: ['nodeId', 'url'],
        additionalProperties: false,
      };
    case 'delete_dev_resource':
      return {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          url: { type: 'string' },
        },
        required: ['nodeId', 'url'],
        additionalProperties: false,
      };
    case 'get_dev_resources':
      return {
        type: 'object',
        properties: { nodeId: { type: 'string' } },
        required: ['nodeId'],
        additionalProperties: false,
      };
    case 'import_component_by_key':
    case 'import_style_by_key':
    case 'import_variable_by_key':
      return {
        type: 'object',
        properties: { key: { type: 'string' } },
        required: ['key'],
        additionalProperties: false,
      };
    case 'create_image_from_url':
      return {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
        additionalProperties: false,
      };
    case 'set_viewport':
      return {
        type: 'object',
        properties: {
          center: {
            type: 'object',
            properties: { x: { type: 'number' }, y: { type: 'number' } },
            required: ['x', 'y'],
          },
          zoom: { type: 'number' },
        },
        additionalProperties: false,
      };
    case 'commit_undo':
      return { type: 'object', properties: {}, additionalProperties: false };
    case 'save_version':
      return {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['title'],
        additionalProperties: false,
      };
    case 'set_annotation':
      return {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          label: { type: 'string' },
          properties: { type: 'array' },
          annotations: { type: 'array' },
        },
        required: ['nodeId'],
        additionalProperties: false,
      };
    case 'get_annotations':
      return {
        type: 'object',
        properties: { nodeId: { type: 'string' } },
        required: ['nodeId'],
        additionalProperties: false,
      };
    case 'create_sticky':
      return {
        type: 'object',
        properties: {
          text: { type: 'string' },
          author: { type: 'string' },
          parentId: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' },
        },
        additionalProperties: false,
      };
    case 'create_connector':
      return {
        type: 'object',
        properties: {
          startNodeId: { type: 'string' },
          endNodeId: { type: 'string' },
          startMagnet: { type: 'string', enum: ['AUTO', 'TOP', 'BOTTOM', 'LEFT', 'RIGHT', 'CENTER'] },
          endMagnet: { type: 'string', enum: ['AUTO', 'TOP', 'BOTTOM', 'LEFT', 'RIGHT', 'CENTER'] },
          lineType: { type: 'string', enum: ['STRAIGHT', 'ELBOWED'] },
          text: { type: 'string' },
          parentId: { type: 'string' },
        },
        additionalProperties: false,
      };
    case 'create_shape_with_text':
      return {
        type: 'object',
        properties: {
          shapeType: { type: 'string' },
          text: { type: 'string' },
          parentId: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' },
        },
        additionalProperties: false,
      };
    case 'create_table':
      return {
        type: 'object',
        properties: {
          numRows: { type: 'integer' },
          numColumns: { type: 'integer' },
          parentId: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' },
        },
        additionalProperties: false,
      };
    case 'set_vector_network':
      return {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          network: {
            description: 'VectorNetwork object. String values are JSON-parsed server-side.',
            oneOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: {
                  regions: { type: 'array', items: {} },
                  vertices: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: { x: { type: 'number' }, y: { type: 'number' } },
                      required: ['x', 'y'],
                    },
                  },
                  segments: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        start: { type: 'integer' },
                        end: { type: 'integer' },
                        tangentStart: {
                          type: 'object',
                          properties: { x: { type: 'number' }, y: { type: 'number' } },
                          required: ['x', 'y'],
                        },
                        tangentEnd: {
                          type: 'object',
                          properties: { x: { type: 'number' }, y: { type: 'number' } },
                          required: ['x', 'y'],
                        },
                      },
                      required: ['start', 'end'],
                    },
                  },
                },
                required: ['vertices', 'segments'],
              },
            ],
          },
        },
        required: ['nodeId', 'network'],
        additionalProperties: false,
      };
    case 'set_shared_plugin_data':
      return {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          namespace: { type: 'string' },
          key: { type: 'string' },
          value: { type: ['string', 'null'] },
        },
        required: ['nodeId', 'namespace', 'key', 'value'],
        additionalProperties: false,
      };
    case 'get_shared_plugin_data':
      return {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          namespace: { type: 'string' },
          key: { type: 'string' },
        },
        required: ['nodeId', 'namespace'],
        additionalProperties: false,
      };
    case 'get_selection_colors':
      return { type: 'object', properties: {}, additionalProperties: false };
    case 'set_file_thumbnail':
      return {
        type: 'object',
        properties: { nodeId: { type: ['string', 'null'] } },
        required: ['nodeId'],
        additionalProperties: false,
      };
    case 'add_component_property':
      return {
        type: 'object',
        properties: {
          componentId: { type: 'string' },
          name: { type: 'string' },
          type: { type: 'string', enum: ['VARIANT', 'TEXT', 'BOOLEAN', 'INSTANCE_SWAP'] },
          defaultValue: {},
          preferredValues: { type: 'array' },
        },
        required: ['componentId', 'name', 'type', 'defaultValue'],
        additionalProperties: false,
      };
    case 'edit_component_property':
      return {
        type: 'object',
        properties: {
          componentId: { type: 'string' },
          propertyName: { type: 'string' },
          newName: { type: 'string' },
          defaultValue: {},
          preferredValues: { type: 'array' },
        },
        required: ['componentId', 'propertyName'],
        additionalProperties: false,
      };
    case 'delete_component_property':
      return {
        type: 'object',
        properties: {
          componentId: { type: 'string' },
          propertyName: { type: 'string' },
        },
        required: ['componentId', 'propertyName'],
        additionalProperties: false,
      };
    case 'reset_instance_overrides':
      return {
        type: 'object',
        properties: { nodeId: { type: 'string' } },
        required: ['nodeId'],
        additionalProperties: false,
      };
    case 'find_with_criteria':
      return {
        type: 'object',
        properties: {
          scope: { type: 'string' },
          types: { type: 'array', items: { type: 'string' } },
          pluginData: { type: 'object' },
          sharedPluginData: { type: 'object' },
          maxResults: { type: 'integer' },
        },
        additionalProperties: false,
      };
    case 'get_style_consumers':
      return {
        type: 'object',
        properties: { styleId: { type: 'string' } },
        required: ['styleId'],
        additionalProperties: false,
      };
    case 'trigger_undo':
      return { type: 'object', properties: {}, additionalProperties: false };
    case 'open_external_url':
      return {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
        additionalProperties: false,
      };
    case 'client_storage_get':
      return {
        type: 'object',
        properties: { key: { type: 'string' } },
        required: ['key'],
        additionalProperties: false,
      };
    case 'client_storage_set':
      return {
        type: 'object',
        properties: { key: { type: 'string' }, value: {} },
        required: ['key', 'value'],
        additionalProperties: false,
      };
    case 'client_storage_delete':
      return {
        type: 'object',
        properties: { key: { type: 'string' } },
        required: ['key'],
        additionalProperties: false,
      };
    case 'client_storage_keys':
      return { type: 'object', properties: {}, additionalProperties: false };
    case 'create_slice':
      return {
        type: 'object',
        properties: {
          name: { type: 'string' },
          parentId: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
        },
        additionalProperties: false,
      };
    case 'create_text_path':
      return {
        type: 'object',
        properties: {
          pathNodeId: { type: 'string', description: 'Existing vector/shape node the text follows' },
          startSegment: { type: 'integer', description: 'Path segment index to start on (default 0)' },
          startPosition: { type: 'number', description: 'Position along the start segment (default 0)' },
          text: { type: 'string' },
          parentId: { type: 'string' },
        },
        required: ['pathNodeId'],
        additionalProperties: false,
      };
    case 'transform_group':
      return {
        type: 'object',
        properties: {
          nodeIds: { type: 'array', items: { type: 'string' } },
          parentId: { type: 'string' },
          index: { type: 'integer' },
          transformModifiers: { type: 'array', description: 'Transform modifiers; [] = plain group' },
        },
        required: ['nodeIds'],
        additionalProperties: false,
      };
    case 'get_library_usage':
      return {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['page', 'document'], description: 'First call only. Default page (current page); document walks all pages.' },
          cursor: { type: 'string', description: 'nextCursor from the previous page. Omit on the first call. Loop until nextCursor is null.' },
          maxResolve: { type: 'integer', description: 'Per-call instance→component resolve budget (default 1500).' },
        },
        additionalProperties: false,
      };
    case 'create_gif':
      return {
        type: 'object',
        properties: {
          imageHash: { type: 'string' },
          parentId: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' },
        },
        required: ['imageHash'],
        additionalProperties: false,
      };
    case 'create_video':
      return {
        type: 'object',
        properties: { base64: { type: 'string' }, parentId: { type: 'string' } },
        required: ['base64'],
        additionalProperties: false,
      };
    case 'create_link_preview':
      return {
        type: 'object',
        properties: { url: { type: 'string' }, parentId: { type: 'string' } },
        required: ['url'],
        additionalProperties: false,
      };
    case 'create_page_divider':
      return {
        type: 'object',
        properties: { name: { type: 'string' } },
        additionalProperties: false,
      };
    case 'create_slide':
      return {
        type: 'object',
        properties: { name: { type: 'string' } },
        additionalProperties: false,
      };
    case 'create_slide_row':
      return { type: 'object', properties: {}, additionalProperties: false };
    case 'create_code_block':
      return {
        type: 'object',
        properties: {
          code: { type: 'string' },
          language: { type: 'string' },
          parentId: { type: 'string' },
        },
        additionalProperties: false,
      };
    case 'timer_start':
      return {
        type: 'object',
        properties: { seconds: { type: 'integer' } },
        required: ['seconds'],
        additionalProperties: false,
      };
    case 'timer_stop':
    case 'timer_pause':
    case 'timer_resume':
    case 'get_active_users':
    case 'get_current_user':
      return { type: 'object', properties: {}, additionalProperties: false };
    case 'combine_as_variants':
      return {
        type: 'object',
        properties: {
          nodeIds: { type: 'array', items: { type: 'string' }, minItems: 2 },
          parentId: { type: 'string' },
          index: { type: 'integer' },
          name: { type: 'string' },
        },
        required: ['nodeIds'],
        additionalProperties: false,
      };
    case 'bind_paint_to_variable':
      return {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          variableId: { type: 'string' },
          paintField: { type: 'string', enum: ['fills', 'strokes'] },
          paintIndex: { type: 'integer' },
          field: { type: 'string', description: 'Bindable paint field; default "color"' },
        },
        required: ['nodeId', 'variableId'],
        additionalProperties: false,
      };
    case 'set_text_range_property':
      return {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          start: { type: 'integer' },
          end: { type: 'integer' },
          property: { type: 'string' },
          value: {},
        },
        required: ['nodeId', 'start', 'end', 'property', 'value'],
        additionalProperties: false,
      };
    default:
      return { type: 'object' };
  }
}
