# Grip MCP Tools

178 tools. Names below are the MCP tool names — Claude Code surfaces them as `mcp__grip__<name>`. All take a JSON params object; all return a JSON result.

Conventions:
- `nodeId` — Figma node id (e.g. `"167:290"`).
- Boolean defaults given inline. Optional unless marked **req**.
- "Active file" = the plugin instance the calling MCP session is pinned to. See `set_active_file`.
- Throws return `{ isError: true, content: [{ type: 'text', text: <message> }] }` per MCP convention.

---

## Session routing (bridge-side)

### `list_files`
List all Figma plugins currently connected to this Grip bridge.
- Params: none.
- Returns: `{ files: Array<{ sessionId, fileKey, fileName, currentPageId, currentPageName, active }> }` — `active` is true for the plugin this MCP session targets by default.

### `set_active_file`
Pin this MCP session to a specific connected plugin.
- Params: `target` (req) — sessionId or fileKey.
- Returns: the matched session info.

---

## Read

### `get_document`
File metadata + page list.
- Params: none.
- Returns: `{ name, id, currentPageId, pages: [{ id, name, nodeCount }] }`. `nodeCount` is top-level children only.

### `get_page`
Serialized node tree of a page.
- Params: `pageId` (default current), `nodeTypes` (filter), `nameFilter` (regex post-walk), `depth` (1..N or -1 for full, default 3), plus all rich-read params.
- Returns: a `SerializedNode` for the page, with `children` recursively to depth.

### `get_node`
Single node, fully serialized.
- Params: `nodeId` (req), all rich-read params (`depth`, `includeChildren`, `includeParent`, `includePluginData`, `pluginDataKeys`, `includeBoundVariables`, `properties`).
- `properties` is a whitelist — when set, only emits those top-level fields. Useful to cap payload.
- Returns: `SerializedNode`.

### `get_nodes`
Bulk read.
- Params: `nodeIds[]` (req), all rich-read params.
- Returns: array. Failed lookups become `{ id, error }`.

### `get_selection`
Currently selected nodes on the active page.
- Params: rich-read params.
- Returns: `SerializedNode[]`.

### `get_styles`
All local paint / text / effect / grid styles.
- Params: none.
- Returns: `{ paint: [...], text: [...], effect: [...], grid: [...] }`. Each entry has `id`, `name`, `description`, `type`, `value`.

### `get_variables`
All local variable collections + variables.
- Params: none.
- Returns: array of collections; variables include `description`, `scopes`, `codeSyntax`, `hiddenFromPublishing`, `key`, `remote`, `valuesByMode`. Color values emit `{ hex, opacity }`. Aliases emit `{ aliasOf: id }`.

### `get_components`
All local components + component sets.
- Params: `includePropertyDefinitions` (default true).
- Returns: `{ components: [...], sets: [...] }` with `id`, `name`, `description`, `key`, `remote`, `documentationLinks`, `componentPropertyDefinitions`.

### `search_nodes`
Find nodes by combination of filters. Paginated.
- Params (any combination):
  - `pageId` — limit to one page (default current).
  - `scope` — limit to subtree under a nodeId.
  - `allPages` — search every page (loads all).
  - `name` — case-insensitive substring on node names.
  - `nameRegex` + `nameFlags` — regex on node names (default flags `i`).
  - `type` — single string or array of node types.
  - `textContains` — TEXT-only character match.
  - `fillHex` — `#RRGGBB`; matches first SOLID fill.
  - `maxResults` (default 50), `offset` (default 0).
- Returns: `{ total, offset, results: [{ id, name, type, parentId }] }`.

### `get_plugin_data`
Read pluginData stored on a node.
- Params: `nodeId` (req), `key` (optional — omit to dump all).
- Returns: `{ key, value }` or `{ keys, data }`.

---

## Export

### `export_node`
Export one node as bytes/string.
- Params: `nodeId` (req), `format` (req: `SVG | PNG | JPG | PDF | CSS | JSON`).
- `path` (optional, absolute file path): the **bridge writes the bytes to disk** and returns `{ path, format, bytes }` instead of inline data. **Required for PNG/JPG/PDF beyond a tiny image** — an inline raster result is base64 that overflows the MCP tool-result token limit and fails before reaching the agent. PNG/JPG/PDF are decoded from base64; SVG/CSS/JSON are written as text. Mirrors `upload_image_from_path` in reverse.
- For raster (PNG/JPG/PDF): `constraint: { type: 'SCALE'|'WIDTH'|'HEIGHT', value }` (default SCALE @ 2). Or legacy `scale: number`.
- Common: `contentsOnly`, `useAbsoluteBounds`, `suffix`, `colorProfile` (`DOCUMENT | SRGB | DISPLAY_P3_V4`).
- SVG-only: `svgOutlineText`, `svgIdAttribute`, `svgSimplifyStroke`.
- JSON-only: rich-read params (depth, properties, etc.) — same as `get_node`.
- Returns (no `path`): `{ format, data }` — raster formats return base64; SVG/CSS return raw text; JSON returns stringified `SerializedNode`. With `path`: `{ path, format, bytes }`.
- Timeout: `export_node` gets a 60s ceiling (vs the 10s default) — raster export of a large frame is legitimately slow. Override with `GRIP_EXPORT_TIMEOUT_MS`.

---

## Write — node level

### `set_node_property`
Set any one property on a node.
- Params: `nodeId`, `property`, `value`.
- Property buckets:
  - **Numeric:** `opacity`, `x`, `y`, `rotation`, `strokeWeight`, `strokeMiterLimit`, `strokeTopWeight`/`Right`/`Bottom`/`Left`, `cornerRadius`, `cornerSmoothing`, `topLeftRadius`/`TopRight`/`BottomLeft`/`BottomRight`, `paddingTop`/`Right`/`Bottom`/`Left`, `itemSpacing`, `counterAxisSpacing`, `layoutGrow`, `minWidth`/`maxWidth`/`minHeight`/`maxHeight`, `paragraphSpacing`, `paragraphIndent`, `arcStartingAngle`/`EndingAngle`/`InnerRadius`.
  - **Boolean:** `visible`, `locked`, `isMask`, `clipsContent`, `expanded`, `itemReverseZIndex`, `strokesIncludedInLayout`, `constrainProportions`.
  - **Passthrough (string/enum/object):** `name`, `blendMode`, `strokeAlign`, `strokeJoin`, `strokeCap`, `dashPattern`, `layoutMode`, `layoutWrap`, `layoutAlign`, `layoutPositioning`, `layoutSizingHorizontal`, `layoutSizingVertical`, `primaryAxisSizingMode`, `counterAxisSizingMode`, `primaryAxisAlignItems`, `counterAxisAlignItems`, `constraints`, `exportSettings`, `overflowDirection`, `textAlignHorizontal`, `textAlignVertical`, `textCase`, `textDecoration`, `textAutoResize`, `lineHeight`, `letterSpacing`, `hyperlink`, `listOptions`, `fillStyleId`, `strokeStyleId`, `effectStyleId`, `gridStyleId`, `textStyleId`, `componentProperties`, `overrides`.
  - **Special:**
    - `width`, `height` — call `node.resize()` (preserves the other axis).
    - `characters` — TEXT only; loads the current font first.
    - `fontName`, `fontFamily`, `fontWeight`, `fontSize` — TEXT only; loads font.
    - `fills`, `strokes` — array of `{ type, hex, opacity }` or bare hex strings; gradients accept `{ type, stops: [{ position, hex, opacity }], transform }`.
    - `effects` — `Effect[]` (Figma shape).
    - `layoutGrids` — `LayoutGrid[]`.
    - `componentProperties` — INSTANCE only; `Record<string, string|boolean>`.
- Returns: `{ success: true }`.

### `create_node`
Create a new node + optionally apply a batch of props.
- Params: `type` (req: `FRAME | TEXT | RECTANGLE | ELLIPSE | LINE | POLYGON | STAR | VECTOR | COMPONENT | INSTANCE`), `parentId` (default current page), `name`, `x`, `y`, `width`, `height`, `componentId` (req for INSTANCE), `props` (any `set_node_property` values, applied in order at creation), `selectAfter`.
- Returns: `{ id, name }`.

### `delete_node`
Remove a node.
- Params: `nodeId`.
- Returns: `{ success: true }`.

### `clone_node`
Duplicate a node.
- Params: `nodeId` (req), `parentId` (default the source's parent), `index` (z-order), `x`, `y`, `name`.
- Returns: `{ id, name }`.

### `move_node`
Reparent + reorder.
- Params: `nodeId`, `parentId` (req), `index`.
- Returns: `{ id, parentId }`.

### `group_nodes`
Group multiple nodes.
- Params: `nodeIds[]` (req), `parentId` (default first node's parent), `asFrame` (default false → GROUP; true → FRAME wrapping their bbox), `name`.
- Returns: `{ id, name, type }`.

### `ungroup_node`
Release a GROUP or FRAME's children to its parent.
- Params: `nodeId`.
- Returns: `{ released: [id] }`.

---

## Write — viewport / selection

### `set_selection`
Replace current page selection.
- Params: `nodeIds[]` (req), `scrollTo` (default false).
- Auto-switches to the page containing the first target node.
- Returns: `{ selected: [id] }`.

### `scroll_to`
Scroll + zoom to fit.
- Params: `nodeId` or `nodeIds[]`.
- Auto-switches pages.
- Returns: `{ focused: [id] }`.

---

## Write — pages

### `create_page` — `{ name?, makeCurrent? }` → `{ id, name }`.
### `set_current_page` — `{ pageId }` → `{ id, name }`.
### `delete_page` — `{ pageId }` → `{ success }`.

---

## Write — components / instances

### `detach_instance`
Detach an INSTANCE into a regular frame tree.
- Params: `nodeId`.
- Returns: `{ id, type }`.

### `swap_instance`
Swap an INSTANCE to a different component.
- Params: `nodeId`, `componentId`.
- Returns: `{ success: true }`.

### `create_component_from_node`
Promote a node to a Component.
- Params: `nodeId` (req), `name`, `description`.
- Returns: `{ id, name, key }`.

### `combine_as_variants`
Merge ≥2 COMPONENT nodes into one COMPONENT_SET (variant set). Same as Cmd+Opt+K.
- Params: `nodeIds[]` (≥2, all COMPONENT), `parentId` (default first node's parent), `index`, `name`.
- Returns: `{ id, name, type: 'COMPONENT_SET' }`.

---

## Write — styles & variables

### `set_style`
Create or update a local style. Omit `styleId` to create.
- Params: `styleId`, `name` (req), `type` (req: `PAINT | TEXT | EFFECT | GRID`), `value` (req — shape varies by type), `description`.
- PAINT `value` = `Paint[]`. EFFECT `value` = `Effect[]`. GRID `value` = `LayoutGrid[]`. TEXT `value` = `{ fontName, fontSize, lineHeight, letterSpacing, textCase, textDecoration, paragraphSpacing, paragraphIndent }`.
- Returns: `{ id, name }`.

### `apply_style`
Bind a node property to a local style.
- Params: `nodeId`, `styleId`, `kind` (`fill | stroke | effect | grid | text`).
- Returns: `{ success: true }`.

### `set_variable_value`
Set a variable's value for a mode.
- Params: `variableId`, `modeId`, `value`. COLOR accepts `'#hex'` or `{ hex, opacity }`. FLOAT/BOOLEAN/STRING coerced.
- Returns: `{ success: true }`.

### `bind_property_to_variable`
Bind a node-level field to a variable (whole-property binding).
- Params: `nodeId`, `field` (e.g. `'cornerRadius'`, `'paddingTop'`, `'characters'`, `'height'`), `variableId`.
- Returns: `{ success: true }`.
- For per-paint color binding (the common "fill = my-color-variable" case), use `bind_paint_to_variable` instead.

### `bind_paint_to_variable`
Bind a single paint's color (or other bindable paint field) to a COLOR variable. The node's `fills`/`strokes` array gets a new paint at the same index with the binding applied.
- Params: `nodeId`, `variableId`, `paintField` (`'fills' | 'strokes'`, default `fills`), `paintIndex` (default 0), `field` (default `'color'`).
- Returns: `{ success: true, paintIndex, field }`.

### `create_variable_collection`
Create a new local variable collection. Comes with one default mode.
- Params: `name`.
- Returns: `{ id, name, defaultModeId, modes: [{ modeId, name }] }`.

### `delete_variable_collection`
Delete a collection (and all its variables).
- Params: `collectionId` → `{ success: true }`.

### `create_variable`
Create a variable inside a collection.
- Params: `name`, `collectionId`, `resolvedType` (`COLOR | FLOAT | STRING | BOOLEAN`), optional `value` (sets default mode) or `valuesByMode: { [modeId]: value }`, plus optional `description`, `scopes`, `codeSyntax: { web, iOS, androidstudio }`, `hiddenFromPublishing`.
- Returns: `{ id, name, resolvedType }`.

### `delete_variable`
- Params: `variableId` → `{ success: true }`.

### `add_variable_mode`
- Params: `collectionId`, `name` → `{ modeId, name }`.

### `remove_variable_mode`
- Params: `collectionId`, `modeId` → `{ success: true }`.

### `rename_variable_mode`
- Params: `collectionId`, `modeId`, `name` → `{ success: true }`.

### `set_variable_meta`
Update a variable's metadata. Values not touched — use `set_variable_value` for those.
- Params: `variableId`, optional `name`, `description`, `scopes`, `codeSyntax`, `hiddenFromPublishing`.
- Returns: `{ success: true }`.

---

## Write — text range

### `set_text_range_property`
Apply a per-range property to part of a TEXT node.
- Params: `nodeId`, `start`, `end`, `property`, `value`.
- `property` matches Figma's `setRange<Property>` suffix (`fills`, `fontName`, `fontSize`, `lineHeight`, `letterSpacing`, `textCase`, `textDecoration`, `hyperlink`, `listOptions`, `paragraphSpacing`, `paragraphIndent`).
- Auto-loads the fonts present in the range first.
- Returns: `{ success: true }`.

---

## Write — assets / metadata

### `upload_image`
Upload an image so it can be used in IMAGE paints.
- Params: `base64` (raw or `data:` URI).
- Returns: `{ imageHash, bytesLength }`.
- **Caveat:** subject to MCP stdio frame limits in some clients (~8KB inconsistent). For larger images, use `upload_image_from_path` or the chunked variant.

### `upload_image_from_path`
Bridge reads bytes from a local filesystem path and registers the image. No base64 in MCP args — bypasses stdio truncation entirely.
- Params: `path` (absolute or cwd-relative).
- Returns: `{ imageHash, bytesLength }`.

### `upload_image_begin` / `upload_image_chunk` / `upload_image_finish`
Chunked upload when only bytes are available (no path). Bridge accumulates chunks; the WS round-trip to the plugin happens once at finish.
- `upload_image_begin({ name? }) → { uploadId }`.
- `upload_image_chunk({ uploadId, data, seq? }) → { received, total }`. Keep `data` ≤ 4KB to be safely under any stdio frame cap. Order is the call order; `seq` is just an ordering hint.
- `upload_image_finish({ uploadId }) → { imageHash, bytesLength }`. Concatenates chunks, decodes, registers.
- Idle uploads expire after 5 min. Total cap 50MB.

### `set_plugin_data`
Write `pluginData` on a node. Use empty/null to clear.
- Params: `nodeId`, `key`, `value`.
- Returns: `{ success: true }`.

---

## Subscribe (push notifications)

These don't round-trip the plugin per call — they flip a flag on the calling MCP session. The bridge fans `selectionchange` / `documentchange` / `currentpagechange` events from the active plugin out to subscribed sessions as MCP `notifications/message` with `data: { event, payload }`.

### `subscribe_selection`
Stream `selectionchange` events. Payload: `[{ id, name, type }]`.

### `subscribe_document`
Stream `documentchange` events (debounced 500ms). Payload: `{ changes: <count> }`.

### `subscribe_currentpage`
Stream `currentpagechange` events. Payload: `{ pageId, pageName }`.

---

## SerializedNode — what reads return

Always present: `id`, `name`, `type`. Other fields appear when the node has them.

| Field | Notes |
|---|---|
| `parent` | Only when `includeParent: true`. `{ id, name, type }`. |
| `visible`, `locked`, `x`, `y`, `width`, `height`, `rotation`, `opacity`, `blendMode`, `isMask`, `clipsContent`, `constraints` | Mixin-dependent. |
| `relativeTransform`, `absoluteBoundingBox` | Useful for camera math. |
| `fills`, `strokes`, `effects`, `layoutGrids` | Arrays. Fills/strokes use rich Paint shape (`type`, `hex`, `stops`, `imageHash`, `opacity`, `visible`, `blendMode`, `boundVariable`). |
| `strokeWeight`, `strokeAlign`, `strokeJoin`, `strokeCap`, `strokeMiterLimit`, `dashPattern`, `strokeTopWeight`/`Right`/`Bottom`/`Left` | When present. |
| `cornerRadius`, `topLeftRadius`/`TopRight`/`BottomLeft`/`BottomRight`, `cornerSmoothing` | `cornerRadius` omitted when mixed (per-corner). |
| Auto-layout: `layoutMode`, `paddingTop`/`Right`/`Bottom`/`Left`, `itemSpacing`, `counterAxisSpacing`, `primaryAxisSizingMode`, `counterAxisSizingMode`, `primaryAxisAlignItems`, `counterAxisAlignItems`, `layoutWrap`, `itemReverseZIndex`, `strokesIncludedInLayout` | FRAME/COMPONENT/etc. |
| Layout-as-child: `layoutAlign`, `layoutGrow`, `layoutPositioning`, `layoutSizingHorizontal`, `layoutSizingVertical`, `minWidth`, `maxWidth`, `minHeight`, `maxHeight` | Children of auto-layout containers. |
| Style binding ids: `fillStyleId`, `strokeStyleId`, `effectStyleId`, `gridStyleId`, `textStyleId` | Empty string when unbound. |
| TEXT-only: `characters`, `fontSize`, `fontFamily`, `fontWeight`, `fontName`, `textAlignHorizontal`/`Vertical`, `textAutoResize`, `textCase`, `textDecoration`, `lineHeight`, `letterSpacing`, `paragraphSpacing`, `paragraphIndent`, `hyperlink`, `listOptions` | Mixed values omitted. |
| INSTANCE: `componentId`, `componentName`, `componentProperties`, `overrides`, `exposedInstances`, `isExposedInstance` | `componentId`/`Name` resolved via `getMainComponentAsync`. |
| COMPONENT/COMPONENT_SET: `key`, `description`, `documentationLinks`, `componentPropertyDefinitions` | Definitions optional. |
| `boundVariables` | Only when `includeBoundVariables: true`. Map of field → `{ variableId, type }`. |
| `pluginData` | Only when `includePluginData: true`. `{ key: value }`. Filter with `pluginDataKeys`. |
| `exportSettings` | Array of Figma export presets. |
| `children` | Recursive serialized children, OR at max depth, stubs `{ id, name, type, childCount }`. |

---

## Vector / boolean / SVG

### `flatten_nodes`
Collapse nodes into a single VECTOR (outline strokes, merge geometry).
- Params: `nodeIds[]` (req), `parentId`, `index`.
- Returns: `{ id, name, type: 'VECTOR' }`.

### `boolean_operation`
Apply a Figma boolean op.
- Params: `nodeIds[]` (≥2), `operation: 'UNION'|'SUBTRACT'|'INTERSECT'|'EXCLUDE'`, `parentId`, `name`.
- Returns: `{ id, name, type: 'BOOLEAN_OPERATION' }`.

### `create_node_from_svg`
Paste raw SVG markup; returns the resulting frame/vector tree.
- Params: `svg` (req), `parentId`, `name`, `x`, `y`.
- Returns: `{ id, name, type }`.

### `set_vector_network`
Replace a VECTOR's vector network (raw point/segment editing).
- Params: `nodeId`, `network` (Figma `VectorNetwork`).
- Returns: `{ success: true }`.

---

## Hand-off / Dev Mode

### `add_dev_resource`
Attach a Dev Mode resource to a node.
- Params: `nodeId`, `url`, `name` (defaults to url).
- Returns: `{ success: true }`.

### `delete_dev_resource`
- Params: `nodeId`, `url`. → `{ success: true }`.

### `get_dev_resources`
- Params: `nodeId`. → `{ resources: [...] }`.

### `set_annotation`
Set annotations on a node. Pass `{ label, properties? }` or `annotations: [...]`.
- Params: `nodeId`, plus `label` + `properties` for one, or `annotations` for many.
- Returns: `{ success: true, count }`.

### `get_annotations`
- Params: `nodeId`. → `{ annotations: [...] }`.

### `set_file_thumbnail`
Set the file thumbnail node (must be FRAME/COMPONENT/COMPONENT_SET/SECTION). `nodeId: null` clears.
- Returns: `{ success: true }`.

---

## Library imports (remote)

### `import_component_by_key`
- Params: `key`. → `{ id, name, key }`.

### `import_style_by_key`
- Params: `key`. → `{ id, name, type, key }`.

### `import_variable_by_key`
- Params: `key`. → `{ id, name, resolvedType, key }`.

---

## Layout / viewport / history

### `create_section`
Create a SECTION (gray-ish container).
- Params: `name`, `parentId`, `x`, `y`, `width`, `height`.
- Returns: `{ id, name, type: 'SECTION' }`.

### `set_viewport`
Move/zoom canvas viewport.
- Params: `center: { x, y }`, `zoom`.
- Returns: `{ center, zoom, bounds }`.

### `commit_undo`
Commit a single undo step. Group prior writes under one Cmd-Z.
- Returns: `{ success: true }`.

### `save_version`
Create a version-history snapshot.
- Params: `title` (req), `description`.
- Returns: `{ id }`.

---

## Fonts / text introspection

### `list_fonts`
- Params: `family` (substring filter, optional). → `[{ family, style }]`.

### `load_font`
Pre-load a font for upcoming text writes.
- Params: `family` (req), `style` (default `Regular`). → `{ success, family, style }`.

### `get_styled_text_segments`
Read per-range styled segments from a TEXT node.
- Params: `nodeId`, `fields[]` (default sensible set), `start`, `end`.
- Returns: array of `{ characters, start, end, ...style }` matching Figma's segment shape (fills hex-encoded).

---

## Prototype

### `set_reactions`
Replace a node's prototype reactions.
- Params: `nodeId`, `reactions: Reaction[]` (Figma shape).
- Returns: `{ success, count }`.

---

## FigJam-only

### `create_sticky` / `create_connector` / `create_shape_with_text` / `create_table`
FigJam node creation. Params follow each Figma `createX` shape; check Plugin API docs for legal values. All return `{ id, type }`.

---

## Cross-plugin metadata

### `set_shared_plugin_data`
- Params: `nodeId`, `namespace`, `key`, `value` (string or null to clear). → `{ success: true }`.

### `get_shared_plugin_data`
- Params: `nodeId`, `namespace`, `key` (optional). → `{ key, value }` or `{ keys, data }`.

---

## Misc

### `notify`
Show a Figma toast.
- Params: `message` (req), `timeout` ms, `error` (red toast).
- Returns: `{ success: true }`.

### `create_image_from_url`
Bridge fetches an http(s) URL and registers an image. Returns `{ imageHash }`. Subject to Figma's CORS rules.

### `get_selection_colors`
- Returns `{ paints, styles }` aggregating colors across the current selection. Null if too many.

### `get_deep_link`
Build a shareable `figma.com` URL to a node.
- Params: `nodeId?` (defaults to first selected node → else current page), `kind?` = `'design'` (default) | `'dev'` (opens Dev Mode, appends `&m=dev`) | `'proto'` (prototype player, `/proto/` path).
- URL form: `https://www.figma.com/{design|board|slides|proto}/{fileKey}/{slug}?node-id={id-with-dashes}`. Segment follows `figma.editorType` (figjam→board, slides→slides); node id `:`→`-`.
- Returns when possible: `{ available: true, url, fileKey, nodeId, kind, editorType, scope: 'node'|'page', selectionCount? }`.
- Returns when not: `{ available: false, url: null, reason: 'deep_link_unavailable', detail }` — happens when `figma.fileKey` is null/`0:0`. **Requires a real fileKey**, which Figma only exposes to private-org plugins; grip's manifest sets `enablePrivatePluginApi` and this works for the dev-imported plugin inside an org (verified — real keys returned, no publish needed).

---

## Component property definitions

### `add_component_property`
- Params: `componentId`, `name`, `type` (`VARIANT | TEXT | BOOLEAN | INSTANCE_SWAP`), `defaultValue`, `preferredValues?`.
- Returns: `{ propertyName }` — Figma appends `#<hash>` to the name.

### `edit_component_property`
- Params: `componentId`, `propertyName`, optional `newName`, `defaultValue`, `preferredValues`.
- Returns: `{ propertyName }`.

### `delete_component_property`
- Params: `componentId`, `propertyName`. → `{ success: true }`.

### `reset_instance_overrides`
Reset all overrides on an INSTANCE.
- Params: `nodeId`. → `{ success: true }`.

---

## Search variants / refactor helpers

### `find_with_criteria`
Optimized subtree walker (typed). Faster than `search_nodes` for plain type filters.
- Params: `scope` (default current page), `types[]`, `pluginData`, `sharedPluginData`, `maxResults` (default 200).
- Returns: array of `{ id, name, type, parentId }`.

### `get_style_consumers`
List nodes consuming a given style (refactor helper).
- Params: `styleId`.
- Returns: array of `{ nodeId, nodeName, nodeType, fields }`.

---

## Undo / external

### `trigger_undo`
Programmatic undo. Reverts the last committed step. Pair with `commit_undo` to control granularity.
- Returns: `{ success: true }`.

### `open_external_url`
Open URL in a new browser tab.
- Params: `url`. → `{ success: true }`.

---

## Per-user persistent storage

`figma.clientStorage` is per-user, per-plugin, per-machine; survives reloads. Useful for agent memory tied to the human user.

### `client_storage_get` — `{ key }` → `{ key, value }`.
### `client_storage_set` — `{ key, value }` → `{ success: true }`.
### `client_storage_delete` — `{ key }` → `{ success: true }`.
### `client_storage_keys` — none → `{ keys }`.

---

## Niche node creation

### `create_slice` — slice/export region.
### `create_text_path` — text along a path.
### `create_gif` — GIF node referencing existing image hash.
### `create_video` — video node from base64 bytes.
### `create_link_preview` — link preview from URL (FigJam).
### `create_page_divider` — divider in pages list.
### `create_slide` / `create_slide_row` — Slides editor.
### `create_code_block` — FigJam code block. Params: `code`, `language`, `parentId`.

All return `{ id, type, ... }` with editor-specific extras.

---

## FigJam timer

### `timer_start` — `{ seconds }`.
### `timer_stop` / `timer_pause` / `timer_resume` — none.

---

## Multiplayer / identity

Both require manifest `permissions: ["activeusers", "currentuser"]`.

### `get_active_users`
Returns array of `{ id, name, color, sessionId, position }`.

### `get_current_user`
Returns `{ id, name, color, sessionId }` or null.
