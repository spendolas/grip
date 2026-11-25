# Grip MCP Tools

156 tools. Names below are the MCP tool names — Claude Code surfaces them as `mcp__grip__<name>`. All take a JSON params object; all return a JSON result.

**Figma Plugin API coverage:** through plugin update 141 (Oct 15, 2026) and `@figma/plugin-typings` 1.142.0. <!-- figma-api-coverage: update=141 typings=1.142.0 --> The weekly API-updates check reads the marker in this line as its baseline — bump both numbers in the same commit whenever support for newly shipped Plugin API features lands.

Phase 3 merged 19 clusters of "N verbs on one object" into single op-enum-dispatched tools — the former per-verb tools no longer exist as standalone entries below; call them via the merged tool's `op`/`target` discriminator (e.g. `group {op:'group'|'ungroup', nodeId(s)}`, `bind_to_variable {target:'property'|'paint'|'effect'|'layout_grid', ...}`, `timer {op:'start'|'stop'|'pause'|'resume'}`). Per-op params are in `grip_capabilities {tool:'<name>'}`.

Conventions:
- `nodeId` — Figma node id (e.g. `"167:290"`).
- Boolean defaults given inline. Optional unless marked **req**.
- "Active file" = the plugin instance the calling MCP session is pinned to. See `set_active_file`.
- Throws return `{ isError: true, content: [{ type: 'text', text: <message> }] }` per MCP convention.
- Errors start with a typed code. Transport codes any tool can return:
  - `plugin_working`: the plugin is busy with another call (named, with how long it has run). Nothing was sent; retry after `retryAfterMs`. A call that timed out waiting behind a slow call also gets it (for a change: re-read before retrying).
  - `plugin_busy`: a call ran past its own time budget with no reply; the plugin's thread is probably wedged. Retry after `retryAfterMs`; if it keeps happening, reload the Figma tab.
  - `plugin_overloaded`: too many calls queued (per agent or per plugin). Nothing was sent; retry after `retryAfterMs` or batch the work.
  - `maybe_applied`: the plugin disconnected or reconnected after a change was sent and before it replied. The change may already have been applied: re-read before retrying.
  - `plugin_disconnected` / `plugin_reconnected`: a read, or a call that was never sent, could not be completed even after the bridge re-sent it once on the file's next plugin session. Safe to retry.
  - `request_timeout`: no reply within the call's budget. For a change the message says `maybe_applied`: the plugin may have started it in time and cannot abort it, so it may still be applied. Re-read before retrying. When an earlier change that had already timed out was still running in the plugin, the message says this change was probably never started (the plugin skips it); re-read before retrying anyway.
  - `retryAfterMs` appears in the message (`retryAfterMs=<n>`) and in the result's `_meta['grip/retryAfterMs']`. Calls are queued fairly across agents (round-robin); a call that waited 2s or more in the queue reports `_meta['grip/queuedMs']`.
- **Write ordering (per open file).** The plugin runs mutating calls one at a time, in the order they arrive (FIFO), so each call is exactly one Cmd-Z step even when several agents write to the same file at once. Read-only calls never wait behind a write. `commit_undo`/`trigger_undo` wait for the write in progress. With plugin capability `serialMutations` the bridge sends one write per file at a time (also while Figma reconnects the plugin and two windows of the file are briefly open) and holds the rest in a per-agent round-robin queue, so a write's timeout starts when it can run; reads keep their own slots and never wait for writes. A write that waits more than 60s (`GRIP_MAX_WRITE_WAIT_MS`) behind a long write fails with `plugin_working` without being sent. Every request carries its budget (`timeoutMs`); a write whose budget ran out while it waited inside the plugin is not started and fails with `plugin_queue_timeout` (nothing changed; retry). A write that started inside its budget cannot be aborted: if the bridge times it out first, the agent gets `request_timeout` ... `maybe_applied`.

---

## Session routing (bridge-side)

### `list_files`
List the Figma files open in this Grip bridge, one entry per file.
- Params: none.
- Returns: `{ files[], myBinding, connecting }`.
  - Each `files[]` entry keeps the older fields `{ sessionId, fileKey, fileName, currentPageId, currentPageName, active }` (taken from the file's newest live window; `active` is true for the file this MCP session's calls go to) and adds `stableKey`, `fileUid?`, `windows[]` (`{ sessionId, currentPageId, currentPageName, pluginVersion, helloAgoMs }`, newest first), `boundAgents` (how many OTHER agents are bound or pinned to that file: a count, never who) and `note?`.
  - Grouping: windows are grouped by file identity, which is a real `fileKey` when the file has one, else the plugin-reported `fileUid` together with the file name (a duplicated file can keep its original's `fileUid`, so it never overrides a real key, and two local windows that share a `fileUid` under different names are listed separately). Reconnect duplicates of one file collapse into one entry. A file with no stable identity (local or unsaved files all report `fileKey: "0:0"`) has `stableKey: false` and is listed **once per window**, never merged with other `"0:0"` windows.
  - `myBinding`: `{ state: 'live'|'waiting'|'unbound', target?, sessionId?, fileName?, reason? }`. `live` = bound and routing to `sessionId`; `waiting` = bound but `reason: 'not_open'` (the file is not open) or `'ambiguous_name'` (the bound name matches several open files); `unbound` = no binding (`sessionId` is set when exactly one file is open, so calls auto-route there).
  - `connecting`: plugin sockets that are open but have not said hello yet (they are not listed).

### `set_active_file`
Bind this MCP session to one Figma file; every later call routes there.
- Params: `target` (req): a fileKey, an exact file name, a sessionId, or a figma.com URL (a plugin-reported fileUid also works; if several open files carry it, the call errors `ambiguous_file_name` and lists them).
- Returns: `{ bound: true, resolved, target, file?, reason?, open?, candidates?, warnings? }`. `resolved: true` + `file` (a `list_files` entry) when the file is open now; otherwise `reason: 'not_open'` (held, resolves when it connects) with `open` (the current `list_files` entries, so a typo is obvious). `warnings[]` appears when another agent is already bound to the same file (your edits can collide).
- `target` is stored as `{ key }` (a real fileKey), `{ uid }`, `{ name }` or `{ sessionId, name }`. A name or sessionId of a file with a real key is promoted to `{ key }`. A file with no stable key (`"0:0"`) stays bound by name, or by sessionId with the name as fallback when that window respawns; it is never bound by `"0:0"`, and `target: "0:0"` errors `not_a_file_key`.
- A name that matches more than one open file or window errors `ambiguous_file_name`, listing each candidate (name, fileKey, sessionId): bind by the fileKey or the sessionId instead. A held name bind that later becomes ambiguous fails each call with the same error (not `bound_file_not_open`).
- A bound agent always routes to the newest live window of its file (reconnect overlap never keeps it on a dying window).
- Launch-time alternatives: env `GRIP_FILE=<key|name|url>` (stdio shim) or `?file=<key|name|url>` on the HTTP initialize URL (`http://127.0.0.1:7778/mcp?file=...`, combinable with `?tools=`).
- Unbound calls with more than one file, or more than one `"0:0"` window, open error `ambiguous_active_file` naming each file/window.

### `on_file`
Run any plugin tool against a NAMED file for one call, without moving this session's binding.
- Params: `file` (req): fileKey, exact name, sessionId, figma.com URL or fileUid (same strict resolver as `set_active_file`); `tool` (req): a plugin-bound tool name; `args`: that tool's params (merged tools take their `op`/`target` here as usual).
- Returns the wrapped tool's result, plus `_meta['grip/file'] = { fileName, fileKey, sessionId }`: the window that actually served the call (a receipt: check it when you passed a name).
- Never moves the caller's bind or pin. Ambiguous names fail `ambiguous_file_name` with the candidates; `"0:0"` fails `not_a_file_key`; a file that is not open fails `bound_file_not_open` after the usual short wait and sends nothing to any other file. Bridge-side tools (`list_files`, `set_active_file`, `on_file`, `grip_*`, `subscribe`) are refused.
- `run_script`, `get_page`, `get_node`, `get_nodes`, `get_selection`, `search_nodes`, `find_with_criteria`, `get_styles`, `get_variables`, `get_components` and `export_node` also take an optional `file` argument with the same meaning (it is not forwarded to the plugin). Writes other than `run_script` go through `on_file`.

### `get_page_context`
Cheap "where am I" probe (one plugin round-trip, no node tree).
- Params: none.
- Returns: `{ file: { key, name }, page: { id, name }, selectionCount, focusedSlideId?, bind, binding }`. `bind` is `null` when unbound, else `{ target, resolved, state }`. `binding` is always present: `{ state: 'live'|'deferred'|'unbound', target?, sessionId?, reason? }`, read from the router after the call (not assumed).

### `grip_health`
Bridge + plugin state, no plugin round-trip.
- Params: none.
- Returns: `{ role, leaderPid, pluginCount, pluginsReady, pendingCount, plugins[], session, otherAgents, update }`. `session` is `{ id, activeFileId, subscriptions, bind, binding }` (`binding` has the same shape as `list_files` `myBinding`). `otherAgents` = how many other MCP sessions are connected to this bridge (a count only). Each `plugins[]` entry carries `stableKey` (false for a `"0:0"` window) and `fileUid` when the plugin sends one.

### `grip_update`
Check for, or install, a newer Grip. **User-triggered only: call `install` only after the user explicitly says yes** — never on your own.
- Params: `action` — `'check'` (default) | `'install'`; `version` — **required for `install`**: the exact `latest` you showed the user (x.y.z).
- `check` → `{ current, latest, available, checkedAt, minPlugin, signalled, blockedReason?, headline, notes, note }` (a fresh check of the latest published GitHub Release of `spendolas/grip`; `headline` is the release's one-line summary and `notes` the first ~1200 characters of its release notes: relay them so the user can decide; with `GRIP_NO_UPDATE_CHECK=1` it answers from state and contacts nothing, adding `disabled:true`). `minPlugin` is the oldest Figma plugin that release works with (from its verified `compat.json`; `null` = unverifiable). `signalled:false` with a `blockedReason` means the release is **not offered** (a connected plugin is too old, no plugin is connected, or no verified `compat.json`): do not install it. `grip_health.update` reports the same fields (+ `bridgeStale`/`updateRecommended` when a connected plugin needs a newer bridge).
- `install` → `{ status: 'updated', from, to, restart, pluginFilesWritten, consent, next[] }`, `{ status: 'declined' }` (the user said no when the bridge asked, see below), `{ status: 'up_to_date' }`, `{ status: 'already_installing' }`, or `{ status: 'clone_install', from, to, next: ['git pull', 'node bridge/install.mjs'], note }` (a developer install from a git clone, recorded in `~/.grip/install.json`: nothing is changed, tell the user to run `next` in their clone). Refusals are tool errors and nothing is installed: `version_required`; `version_changed` (a newer release exists than the one you pinned: JSON with the new `latest`, `headline`, `notes` — show them and ask again); `incompatible_plugin` (a connected plugin is older than the release needs: update the plugin in Figma first); `plugins_unverifiable` (no Grip plugin connected: ask the user to open it in Figma first); `compat_unverified` (release without a verifiable `compat.json`); `signature_missing` / `signature_invalid` (the release's `SHA256SUMS.txt.sig` is absent or does not verify against the release key built into the bridge: never install it, nothing overrides this; `check` and `grip_health.update` show `signatureError`); `flavour_mismatch` (the release's signed `compat.json` says it was built for another build of the bridge: never install it, nothing overrides this; shown the same way, with `trustCode`); `selftest_failed` (the downloaded bridge did not start); plus download/size/`SHA256SUMS.txt` failures (a release still uploading says to retry in a few minutes). On success the bridge restarts itself ~1s after replying (`restart: 'scheduled'`; `'not_managed'` when this bridge isn't the `~/.grip/grip-bridge.mjs` copy). `next[]` is the guidance to relay: possible one-off connection error on the next call, HTTP-transport agents may need to reconnect, the plugin refreshes in place only if imported from `~/.grip/figma-plugin` (else `git pull` / re-import), and `node ~/.grip/grip-bridge.mjs update --rollback` to undo (bridge only; the plugin files stay at the new version).
- **Consent.** If the MCP client supports elicitation, the bridge itself asks the user ("Install Grip x → y? <headline>", no fields) and installs only on accept (decline, cancel, error or 60s without an answer = `declined`); `consent:'user_confirmed'`. Clients that cannot ask: the version pin is the gate and `consent:'agent_attested'`, so you must have the user's explicit yes first.
- When an update is **signalled** (available and at least one connected plugin is compatible) the bridge also, at most once per version per 3 days across sessions: appends a paragraph to the session `instructions` and adds one extra text block ("Grip update available: x → y. What's new, per the release notes: "<headline>". Tell the user and ask… Do NOT install on your own…") to the first successful tool result of the session. See README → Updating.

---

## Read

### `get_document`
File metadata + page list.
- Params: none.
- Returns: `{ name, id, currentPageId, documentColorProfile, pages: [{ id, name, isPageDivider, nodeCount }] }`. `nodeCount` is top-level children only. `documentColorProfile` is `'LEGACY' | 'SRGB' | 'DISPLAY_P3'` (`'LEGACY'` for files predating color management). **Read-only** — the Plugin API has no setter, so there is no write op. It is what `export_node` `colorProfile: 'DOCUMENT'` resolves to; colors authored in other spaces (see Color spaces below) are still stored as sRGB `color` + `sourceColor`.

### `list_pages`
Enumerate pages (id, name, current) WITHOUT loading their contents — cheap even on a 97-page file, unlike `get_document`.
- Params: none.
- Returns: `{ pages: [{ id, name, current, isPageDivider }] }`. `isPageDivider` is true for page dividers (PAGE nodes named all `*`, `–`, `—` or spaces). Use to build pageIds for a batched `search_nodes`. `get_document` pages and PAGE serialization (`get_page`) carry `isPageDivider` too.

### `get_audit`
One-pass document audit: counts by type, fill-source breakdown (styled vs variable-bound vs hardcoded color), fonts used, and defined styles/variables. Numbers, not trees.
- Params: `scope` (subtree nodeId), `pageId`, `allPages`, `maxNodes` (bounds the walk).
- Scope defaults to the current page if none of `scope`/`pageId`/`allPages` is given.

### `get_page`
Serialized node tree of a page.
- Params: `pageId` (default current), `nodeTypes` (filter), `nameFilter` (regex post-walk), `depth` (1..N or -1 for full, default 3), plus all rich-read params.
- Returns: a `SerializedNode` for the page, with `children` recursively to depth.

### `get_node`
Single node, fully serialized.
- Params: `nodeId` (req), all rich-read params (`depth`, `includeChildren`, `includeParent`, `includePluginData`, `pluginDataKeys`, `includeBoundVariables`, `properties`).
- `properties` is a field whitelist that **recurses to every node in the tree** (not just the root) — pass e.g. `properties:['name','variantProperties']` for a lean recursive read that dodges the token-limit blowup on big subtrees. `id`/`name`/`type` always emit. Requesting `componentId`/`componentName` triggers a per-INSTANCE `getMainComponentAsync`; omit them to skip that cost. `variantProperties` (the resolved variant selection, e.g. `{Type:'Multi select'}`) is available via the whitelist.
- Returns: `SerializedNode`.

### `get_nodes`
Bulk read.
- Params: `nodeIds[]` (req), all rich-read params.
- Returns: array. Failed lookups become `{ id, error }`.

### `get_selection`
Currently selected nodes on the active page.
- Params: rich-read params, `pageId` (read that page's own selection without switching the file's current page; default current page).
- Returns: `SerializedNode[]`.

### `get_styles`
All local paint / text / effect / grid styles.
- Params: none.
- Returns: `{ paint: [...], text: [...], effect: [...], grid: [...] }`. Each entry has `id`, `name`, `description`, `type`, `value`.

### `get_variables`
All local variable collections + variables.
- Params: none for the full dump. Optional (additive, any combination; the result then lists only collections that still have a matching variable, each variable as `{ id, name, key, resolvedType, remote, valuesByMode, ... }`):
  - `variableIds` (array) / `collectionId` — narrow which variables return.
  - `resolveFor: <nodeId>` — adds `resolved: { value, resolvedType }` per variable: the value as seen by that node (`Variable.resolveForConsumer`; follows aliases and the node's explicit/inherited modes; `value` uses the same shapes as `valuesByMode`: `{hex,opacity}`, composed colors, EASING objects, plain numbers/strings/booleans). A variable that can't be resolved yields `resolved: { error }`.
  - `forCollection: <extendedCollectionId>` — adds `valuesByModeForCollection: { extendedModeId: value }` per variable: the overridden-or-inherited values in that extended collection (`Variable.valuesByModeForCollectionAsync`). Without `variableIds`/`collectionId`, also lists the extension's variables that live in non-local parent collections under a group with `id: null`.
  - Node-side variable state is read via `get_node`/`get_nodes`/`search_nodes` `properties` (opt-in, never in default output): `resolvedVariableModes` (`{ collectionId: modeId }`, explicit + inherited), `resolvedVariableModeNames` (`{ collectionId: { collection, mode } }`), `inferredVariables` (`{ field: [variableId] }`; `fills`/`strokes` are arrays of arrays indexed like `node.fills`/`node.strokes`). Fields with nothing to report are omitted.
- Returns: array of collections; variables include `description`, `scopes`, `codeSyntax`, `hiddenFromPublishing`, `key`, `remote`, `valuesByMode`. Color values emit `{ hex, opacity }`. Aliases emit `{ aliasOf: id }`. Composed colors emit `{ color: {hex,opacity}|{aliasOf}, opacity: number|{aliasOf} }`. Every collection carries `isExtension`; **extended** collections (a collection that extends another, e.g. from a library) also carry `parentVariableCollectionId`, `rootVariableCollectionId` and `variableOverrides` (`{ variableId: { extendedModeId: value } }`, values in the shapes above), and their `modes` include `parentModeId`. Extended collections list only their own variables here; the inherited ones appear under the parent.

### `get_components`
All local components + component sets.
- Params: `includePropertyDefinitions` (default true).
- Returns: `{ components: [...], sets: [...] }` with `id`, `name`, `description`, `key`, `remote`, `documentationLinks`, `componentPropertyDefinitions`.

### `search_nodes`
Find nodes by combination of filters. Paginated. When `type` is given it uses the native typed index (`findAllWithCriteria`) as the candidate set — fast even on huge pages (a name+type query that once timed out at 60s returns in <1s); prefer passing `type` (and `pageId`/`scope` to bound it) rather than a name-only search across all types.
- Params (any combination):
  - `pageId` — limit to one page (default current).
  - `scope` — limit to subtree under a nodeId.
  - `allPages` — search every page (loads all).
  - `name` — case-insensitive substring on node names.
  - `nameRegex` + `nameFlags` — regex on node names (default flags `i`).
  - `type` — single string or array of node types.
  - `textContains` — TEXT-only character match.
  - `fillHex` — `#RRGGBB`; matches first SOLID fill.
  - `properties` — array of field names; returns those serialized fields per match instead of just `{id,name,type,parentId}` (bounded to the returned slice, not the full match set) — "find X, show its Y" in one call.
  - `maxResults` (default 50), `offset` (default 0).
- Returns: `{ total, offset, results: [{ id, name, type, parentId, ...properties }] }`.

### `get_plugin_data`
Read pluginData stored on a node.
- Params: `nodeId` (req), `key` (optional — omit to dump all).
- Returns: `{ key, value }` or `{ keys, data }`.

### `get_library_usage`
Report team-library items used in the file. **Paginated so the result is COMPLETE — never a silently-capped partial.**
- Params: `scope` (`page` default | `document`, first call only), `cursor` (`nextCursor` from the previous page — omit on the first call), `maxResolve` (per-call resolve budget, default 1500).
- Flow: call with no cursor → get the first page + `nextCursor`. Keep calling with `cursor: nextCursor`, **unioning `remoteComponents`/`remoteStyles` by `key`**, until `nextCursor` is `null` (`complete: true`). Items may repeat across pages — dedupe by key.
- Returns per page: `{ scope, complete, nextCursor, remoteComponents, remoteStyles, progress:{scanned,total}, limitations }`; the **first page** also carries `variableLibraries`.
  - `variableLibraries` — `{ <libraryFilename>: [collection,…] }`. **The only place a source library FILENAME is available** (`getAvailableLibraryVariableCollectionsAsync`), and only for *enabled* libraries.
  - `remoteComponents` / `remoteStyles` — distinct remote items used, as `{ name, key }` (+ `type` for styles). **No source filename** — the plugin API doesn't expose which library file a component/style came from (use the Figma REST API for that).
  - `limitations` — array restating the above on every page, so callers can't mistake absence for "not from a library" or a name for a filename.
- The tree is walked ONCE per scan (cached as node refs, keyed by the cursor); each call resolves the next batch, yielding so it never wedges. 60s per-call timeout (`GRIP_SCAN_TIMEOUT_MS`). A cursor is invalidated if the plugin reloads mid-scan → explicit error to restart (never a silent partial).

---

## Export

### `export_node`
Export one node as bytes/string.
- Params: `nodeId` (req), `format` (req: `SVG | PNG | JPG | PDF | CSS | JSON | MP4 | GIF | WEBM`).
- Video (`MP4`/`GIF`/`WEBM`): only on an **animated top-level frame** (Figma Motion); **always requires `path`**; takes `fps`, `quality` (`LOW|MEDIUM|HIGH`, MP4/WEBM), `loopCount` (GIF). A large video may exceed the 8MB WS cap → raise `GRIP_RESPONSE_CAP_BYTES`.
- `path` (optional, absolute file path): the **bridge writes the bytes to disk** and returns `{ path, format, bytes }` instead of inline data. **Required for PNG/JPG/PDF beyond a tiny image** — an inline raster result is base64 that overflows the MCP tool-result token limit and fails before reaching the agent. PNG/JPG/PDF are decoded from base64; SVG/CSS/JSON are written as text. Mirrors `upload_image_from_path` in reverse.
- `overwrite` (optional boolean): replace a file that already exists at `path` (default: refuse). `path` must be inside the home or temp directory (more via `GRIP_ALLOWED_DIRS`), must not go through a hidden entry or `~/Library`, and must end in the format's own extension (`.png` for PNG, `.jpg`/`.jpeg` for JPG, and so on); symlinks are resolved first.
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
    - `textWrapStyle` (TEXT) — `'AUTO' | 'BALANCE' | 'PRETTY'`, node-wide, validated; all fonts in the node are auto-loaded first. Per-range: `set_text_range_property` (Figma applies wrap style per paragraph, so a sub-range sets its whole paragraph). Included in text node reads.
    - **Text details** (TEXT; all fonts in the node auto-loaded first; included in text node reads, mixed/null omitted): `leadingTrim` (`'CAP_HEIGHT' | 'NONE'`), `listSpacing` (number), `hangingPunctuation` / `hangingList` (boolean), `textDecorationStyle` (`'SOLID' | 'WAVY' | 'DOTTED'`), `textDecorationOffset` / `textDecorationThickness` (`{ value, unit: 'PIXELS' | 'PERCENT' }` or `{ unit: 'AUTO' }`; shorthand `'AUTO'` or a px number), `textDecorationColor` (`{ value: 'AUTO' }` or `{ value: <solid paint {hex|color, opacity}> }`; shorthand `'AUTO'` or a color string; reads hex-encode the paint), `textDecorationSkipInk` (boolean). Values are validated. Decoration extras are `null` (omitted on read) while `textDecoration` is `NONE`. Read-only `hasMissingFont` is also serialized on TEXT nodes (selectable via `properties`).
    - `fontName` (TEXT) — `{ family, style?, variationSettings? }`: omit `style` to let Figma pick the named instance nearest the axes; `variationSettings` e.g. `{ wght: 550 }` (axis tags via `list_fonts { axesFor }`; unknown axes throw). The font is auto-loaded. Reads return `fontName` including `variationSettings` for variable fonts.
    - `width`, `height` — call `node.resize()` (preserves the other axis).
    - `characters` — TEXT only; loads the current font first.
    - `fontName`, `fontFamily`, `fontWeight`, `fontSize` — TEXT only; loads font.
    - `fills`, `strokes` — array of `{ type, hex, opacity, sourceColor? }` or bare color strings; gradients accept `{ type, stops: [{ position, hex, opacity, sourceColor? }], transform }`. See **Color spaces** below.
    - `effects` — `Effect[]` (Figma shape); colors may be given as `{ hex, opacity, sourceColor? }` (what reads emit), a CSS color string, or `{ space, ... }`.
    - `layoutGrids` — `LayoutGrid[]`.
    - `componentProperties` — INSTANCE only; `Record<string, string|boolean>`.
    - `devStatus` — frames/components/instances/sections: `{ type: 'READY_FOR_DEV'|'COMPLETED', description? }`, a bare type string, or `null` (clear). Figma only allows it on a node directly under a page or section, and not inside a node that already has one. See **Hand-off / Dev Mode**.
    - `description`, `descriptionMarkdown` — COMPONENT/COMPONENT_SET string (the markdown one is the rich-text description).
    - PAGE nodes (pass the page id as `nodeId`): `guides` (`[{ axis: 'X'|'Y', offset }]`, replaces all), `backgrounds` (Paint[] like `fills`; Figma supports one solid paint), `flowStartingPoints` (`[{ nodeId, name? }]`, bare id strings also work; `name` defaults to the node's name). `prototypeStartNode` is read-only (reads emit `prototypeStartNodeId`).
    - `counterAxisAlignContent` — `'AUTO' | 'SPACE_BETWEEN'` (wrap-track alignment). The frame must have `layoutWrap: 'WRAP'` (set that first) or it errors. Read back only when `layoutWrap` is `WRAP` (or when named in `properties`).
    - `maskType` — `'ALPHA' | 'VECTOR' | 'LUMINANCE'`. Does **not** turn the node into a mask — set `isMask: true` too. Reads include `maskType` on masks (`isMask: true`) or when named in `properties`.
    - `handleMirroring` — `'NONE' | 'ANGLE' | 'ANGLE_AND_LENGTH'` on VECTOR (and HIGHLIGHT) nodes, not STAR/POLYGON (read-only on TEXT_PATH). Read via `properties: ['handleMirroring']` (`'mixed'` possible).
    - `numberOfFixedChildren` — non-negative integer, frames: the top-most N children stay fixed while a scrolling frame scrolls in a prototype. Reads include it when > 0.
    - `overlayPositionType`, `overlayBackground`, `overlayBackgroundInteraction` — **read-only** in the Plugin API (typings mark them `readonly`); writes throw a clear error. Read via `properties: [...]` (opt-in, not in default reads).
    - `fills`, `strokes` with a `PATTERN` paint (`{ type:'PATTERN', sourceNodeId, tileType, scalingFactor, spacing:{x,y}, horizontalAlignment }`) are applied via `setFillsAsync`/`setStrokesAsync` (the plain setters throw on pattern paints); all other paints keep the sync path.
- Returns: `{ success: true }`.

### `create_node`
Create a new node + optionally apply a batch of props.
- Params: `type` (req: `FRAME | TEXT | RECTANGLE | ELLIPSE | LINE | POLYGON | STAR | VECTOR | COMPONENT | INSTANCE`), `parentId` (default current page), `pageId` (no `parentId`: create on this page without switching the current page), `name`, `x`, `y`, `width`, `height`, `componentId` (req for INSTANCE), `props` (any `set_node_property` values, applied in order at creation), `selectAfter`.
- Returns: `{ id, name }`.

### `create_tree`
Build a nested node subtree from one spec in a single call — reuses `create_node`'s type factory + `set_node_property` for props, so a form/card/list doesn't cost one round-trip per node.
- Params: `parentId` (default current page), `index`, `spec` (req, recursive: `{ type, props?, children? }`).
- Capped at 2000 nodes per call, no rollback on a partial build (`map_nodes`-style).
- Returns: the created id tree.

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
- Params: `nodeId`, `parentId` (req), `index`, `row`, `column`.
- `row` + `column` (0-based integers, both required together): `parentId` must be a GRID auto-layout frame; places the node in that cell via `GridLayoutMixin.appendChildAt`. `index` is ignored then. To re-position a node already inside a grid use `set_grid_child_position`.
- Returns: `{ id, parentId }` (plus `row`, `column` for a grid placement).

### `group`
Merged: group/ungroup, dispatched on `op`.
- `op: 'group'` — `{ op, nodeIds[] (req), parentId (default first node's parent), asFrame (default false → GROUP; true → FRAME wrapping their bbox), name }` → `{ id, name, type }`.
- `op: 'ungroup'` — `{ op, nodeId (req) }` → `{ released: [id] }` (release a GROUP or FRAME's children to its parent).

---

## Write — viewport / selection

### `set_selection`
Replace current page selection.
- Params: `nodeIds[]` (req), `scrollTo` (default false), `keepPage` (default false).
- Auto-switches to the page containing the first target node, unless `keepPage: true`: then it never switches, and fails with `node_on_other_page` (naming that page) if any node is elsewhere.
- Returns: `{ selected: [id] }`.

### `scroll_to`
Scroll + zoom to fit.
- Params: `nodeId` or `nodeIds[]`, `keepPage` (default false).
- Auto-switches pages, unless `keepPage: true`: then it never switches, and fails with `node_on_other_page` if any node is on another page.
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

### `create_component_set`
Build a variant set from an axes matrix: one COMPONENT per combination, named `Axis=Value, Axis=Value`, laid out in a grid, then combined into one COMPONENT_SET. One call is one undo step.
- Params: `axes` **req** (`{ Size: ['S','M','L'], State: ['default','hover'] }`: at least one axis, each with at least one unique value; names and values may not contain `,` or `=`; at most 200 combinations, else `too_many_variants`), `name?`, `template?` (node cloned for every variant: a COMPONENT or any node Figma can turn into one; not an INSTANCE, a COMPONENT_SET or a variant already inside a set; the template stays untouched), `parentId?`, `x?`/`y?` (grid top-left), `gap?` (default 16).
- Without `template` each variant is an empty 100x100 component. Variant order follows axis order, last axis fastest: the last axis becomes the columns, the other axes the rows. Default position: right of the template, or the viewport centre on a page, else 0,0.
- Returns: `{ id, name, type: 'COMPONENT_SET', variantCount, variants: [{ id, name }] }`. All-or-nothing: a failure removes the components already made.
- Axis order follows JS key order, so integer-like axis names (`'1'`) sort first; use letters. Add component properties or styling afterwards with `component_property` / `set_node_property`.

---

## Write — styles & variables

### `set_style`
Create or update a local style. Omit `styleId` to create.
- Params: `styleId`, `name` (req), `type` (req: `PAINT | TEXT | EFFECT | GRID`), `value` (req — shape varies by type), `description`.
- PAINT `value` = `Paint[]` (same shapes as `set_node_property` fills, incl. CSS color strings and `sourceColor`). EFFECT `value` = `Effect[]` (read-back `{ hex, opacity, sourceColor? }` colors are accepted). GRID `value` = `LayoutGrid[]`. TEXT `value` = `{ fontName, fontSize, lineHeight, letterSpacing, textCase, textDecoration, textWrapStyle, paragraphSpacing, paragraphIndent }`.
- TEXT `value` also accepts `leadingTrim` (`'CAP_HEIGHT' | 'NONE'`), `listSpacing` (number), `hangingPunctuation`, `hangingList` (boolean) — `get_styles` returns them too. TextStyle has no `textDecoration*` extras (node/range-only).
- TEXT `textWrapStyle`: `'AUTO' | 'BALANCE' | 'PRETTY'` (validated). TEXT `fontName` is `{ family, style?, variationSettings? }` — omit `style` to let Figma resolve the named instance nearest `variationSettings` (e.g. `{ wght: 550 }`); the font is auto-loaded. `get_styles` text entries return `textWrapStyle` and `fontName` (with `variationSettings` for variable fonts).
- Returns: `{ id, name }`.

### `move_local_style`
Reorder a local PAINT/TEXT/EFFECT/GRID style, or a style folder.
- Style: `{ styleId, afterStyleId? }` — omit `afterStyleId` = first. Style type is inferred from `styleId`.
- Folder: `{ folder, styleType, afterFolder? }` — `styleType` (req: `PAINT | TEXT | EFFECT | GRID`); `folder`/`afterFolder` are full `/`-delimited folder names (e.g. `'Brand/Primary'`); target and reference must share the same parent folder; omit `afterFolder` = first in the parent. Wraps `figma.moveLocal{Paint,Text,Effect,Grid}FolderAfter`. Figma Design only.
- Returns: `{ success: true }`.

### `apply_style`
Bind a node property to a local style.
- Params: `nodeId`, `styleId`, `kind` (`fill | stroke | effect | grid | text`).
- Returns: `{ success: true }`.

### `set_variable_value`
Set a variable's value for a mode.
- Params: `variableId`, `modeId`, `value`. COLOR accepts `'#hex'`, any CSS color string (`'oklch(0.7 0.1 200)'`, `'hsl(...)'`, `'lab(...)'`, `'rgb(...)'` — string alpha becomes `a`), `{ hex, opacity }`, `{ r, g, b, a? }`, `{ space, ... }` (a `ColorWithColorSpace`), an alias, or a composed color. Non-hex input is converted to sRGB RGBA via `figma.util.rgba` (Figma update 141+); variable values don't keep the authoring color space, so reads stay `{ hex, opacity }`. FLOAT/BOOLEAN/STRING are coerced, or may be an alias.
- **Alias** (any type): `{ aliasOf: '<variableId>' }` — the shape `get_variables` emits (`{ variableId }` and Figma's `{ type: 'VARIABLE_ALIAS', id }` are also accepted).
- **Composed color** (COLOR only — needs Figma typings ≥ 1.142): a color plus a separate opacity, where the color **or** the opacity (or both) is an alias: `{ color: <'#hex' | { hex, opacity } | { r,g,b,a? } | { aliasOf }>, opacity: <0–1 number | { aliasOf }> }`. Neither part aliased is rejected — use `{ hex, opacity }`. `get_variables` returns the same shape. Also accepted by variable create (`value` / `valuesByMode`).
- Returns: `{ success: true }`.

### `bind_to_variable`
Merged: bind a node field/paint/effect/layout-grid to a variable, dispatched on `target`.
- `target: 'property'` — `{ target, nodeId, field (e.g. 'cornerRadius', 'paddingTop', 'characters', 'height'), variableId }` → `{ success: true }`. Whole-property binding. For per-paint color binding (the common "fill = my-color-variable" case), use `target: 'paint'` instead.
- `target: 'paint'` — `{ target, nodeId, variableId, paintField ('fills'|'strokes', default 'fills'), paintIndex (default 0), field (default 'color') }` → `{ success: true, paintIndex, field }`. Binds a single paint's color (or other bindable paint field) to a COLOR variable; the node's `fills`/`strokes` array gets a new paint at the same index with the binding applied.
- `target: 'effect'` — bind a bindable effect field to a variable.
- `target: 'layout_grid'` — bind a bindable layout-grid field to a variable.

### `variable_collection`
Merged: create/delete a local variable collection, dispatched on `op`.
- `op: 'create'` — `{ op, name }` → `{ id, name, defaultModeId, modes: [{ modeId, name }] }`. Comes with one default mode.
- `op: 'delete'` — `{ op, collectionId }` → `{ success: true }`. Deletes the collection and all its variables.
- `op: 'extend'` — `{ op, collectionId, name }` → `{ id, name, isExtension: true, parentVariableCollectionId, rootVariableCollectionId, variableOverrides }`. Creates an **extended** collection from a local collection (Enterprise plan only).
- `op: 'remove_overrides'` — `{ op, collectionId (extended), variableId }` → `{ success: true }`. Clears every overridden value of that variable in the extended collection. To *set* an override, use `set_variable_value` with the extended collection's own `modeId`.
- `op: 'remove_override_for_mode'` — `{ op, variableId, modeId (an EXTENDED collection's mode id), collectionId? }` → `{ success: true }`. Clears the override of just that one extended mode so it returns to the inherited value (`Variable.removeOverrideForMode`). When `collectionId` is given it is validated as an extension that owns `modeId`.

### `variable`
Merged: create/delete a variable, dispatched on `op`.
- `op: 'create'` — `{ op, name, collectionId, resolvedType ('COLOR'|'FLOAT'|'STRING'|'BOOLEAN'|'EASING'|'TIMING'), value? (sets default mode) or valuesByMode: { [modeId]: value }, description?, scopes?, codeSyntax?: { web, iOS, androidstudio }, hiddenFromPublishing? }` → `{ id, name, resolvedType }`.
- **Motion variable value shapes** (create `value`/`valuesByMode` and `set_variable_value`; any of them may instead be an alias `{ aliasOf: '<variableId>' }`):
  - `EASING` — a `MotionEasing`: a bare type name (`'EASE_IN'|'EASE_OUT'|'EASE_IN_AND_OUT'|'LINEAR'|'EASE_IN_BACK'|'EASE_OUT_BACK'|'EASE_IN_AND_OUT_BACK'|'GENTLE'|'QUICK'|'BOUNCY'|'SLOW'|'HOLD'`) or `{ type, easingFunctionCubicBezier?: { x1, y1, x2, y2 }, easingFunctionSpring?: { bounce } }`. Custom curves also accept flat shorthands: `{ type: 'CUSTOM_CUBIC_BEZIER', x1, y1, x2, y2 }` and `{ type: 'CUSTOM_SPRING', bounce }` (bounce 0..1). Unknown types / missing numbers are rejected.
  - `TIMING` — a number of **seconds** (finite, >= 0). (The typings don't state the unit; seconds matches every other Motion duration in the Plugin API.)
  - Reads (`get_variables` `valuesByMode`) return EASING as the plain `MotionEasing` object (`{ type, easingFunctionCubicBezier?, easingFunctionSpring? }`) and TIMING as the number; aliases as `{ aliasOf }`.
- `op: 'delete'` — `{ op, variableId }` → `{ success: true }`.

### `variable_mode`
Merged: add/remove/rename a variable collection's modes, dispatched on `op`.
- `op: 'add'` — `{ op, collectionId, name }` → `{ modeId, name }`.
- `op: 'remove'` — `{ op, collectionId, modeId }` → `{ success: true }`.
- `op: 'rename'` — `{ op, collectionId, modeId, name }` → `{ success: true }`.

### `explicit_variable_mode`
Merged: set/clear a node's explicit mode override for a collection, dispatched on `op`.
- `op: 'set'` — `{ op, nodeId, collectionId, modeId }` → `{ success: true }`.
- `op: 'clear'` — `{ op, nodeId, collectionId }` → `{ success: true }`.

### `set_variable_meta`
Update a variable's metadata. Values not touched — use `set_variable_value` for those.
- Params: `variableId`, optional `name`, `description`, `scopes`, `codeSyntax`, `hiddenFromPublishing`.
- `codeSyntax` is `{ WEB|ANDROID|iOS: string }`; a platform set to `null` **removes** its definition (`Variable.removeVariableCodeSyntax`), e.g. `{ WEB: '--brand', ANDROID: null }`.
- `scopes` values: `ALL_SCOPES`, `TEXT_CONTENT`, `CORNER_RADIUS`, `WIDTH_HEIGHT`, `GAP`, `ALL_FILLS`, `FRAME_FILL`, `SHAPE_FILL`, `TEXT_FILL`, `STROKE_COLOR`, `STROKE_FLOAT`, `EFFECT_FLOAT`, `EFFECT_COLOR`, `OPACITY`, `COLOR_OPACITY` (**FLOAT variables only** — setting it on a COLOR variable is rejected by Figma; it marks a number variable usable as a composed color's opacity; Update 139), `FONT_FAMILY`, `FONT_STYLE`, `FONT_WEIGHT`, `FONT_SIZE`, `LINE_HEIGHT`, `LETTER_SPACING`, `PARAGRAPH_SPACING`, `PARAGRAPH_INDENT`. Scopes only control where the variable shows in Figma's pickers; they don't block API bindings.
- Returns: `{ success: true }`.

---

## Write — text range

### `set_text_range_property`
Apply a per-range property to part of a TEXT node.
- Params: `nodeId`, `start`, `end`, `property`, `value`.
- `property` matches Figma's `setRange<Property>` suffix (`fills`, `fontName`, `fontSize`, `lineHeight`, `letterSpacing`, `textCase`, `textDecoration`, `hyperlink`, `listOptions`, `paragraphSpacing`, `paragraphIndent`, `textWrapStyle`).
- `textWrapStyle`: `'AUTO' | 'BALANCE' | 'PRETTY'` (validated; Figma applies it to the paragraph(s) containing the range).
- `fontName`: `{ family, style?, variationSettings? }` (variable fonts; omit `style` to get the nearest named instance; unknown axis tags throw — see `list_fonts { axesFor }`). The target font is auto-loaded.
- Also: `listSpacing` (number), `textDecorationStyle`, `textDecorationOffset`, `textDecorationThickness`, `textDecorationColor`, `textDecorationSkipInk` (same value shapes as `set_node_property`, validated). `leadingTrim`, `hangingPunctuation`, `hangingList` have no range setter in the Plugin API (use `set_node_property`).
- Auto-loads the fonts present in the range first.
- Read per-range values back with `get_styled_text_segments` (`fields: ['fontName','textWrapStyle']`).
- Returns: `{ success: true }`.

### `edit_characters`
Merged: insert/delete characters on a TEXT node's `characters` string, dispatched on `op`.
- `op: 'insert'` — `{ op, nodeId, start, characters, behavior? }` (was `insert_characters`).
- `op: 'delete'` — `{ op, nodeId, start, end }` (was `delete_characters`, half-open `[start, end)`).

### `replace_text`
Bulk find/replace across TEXT nodes in a bounded, font-loading loop (no `run_script`).
- Params: `find` (req), `replace` (req), `regex` (literal unless true), `scope` (subtree nodeId), `pageId`, `allPages`, `budget`, `chunk`.
- Scope defaults to the current page if none of `scope`/`pageId`/`allPages` is given.
- Returns: `{ matched, changed, truncated }`.

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
- **Safety:** the file must be inside the home or temp directory (more via `GRIP_ALLOWED_DIRS`), not behind a hidden entry (`~/.ssh`, `~/.zshrc`) or `~/Library`, a regular file of at most 64 MB, and start with PNG, JPEG, GIF or WebP bytes. Anything else is refused before it is read.

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

These don't round-trip the plugin per call: they flip a flag on the calling MCP session. The bridge sends `selectionchange` / `documentchange` / `currentpagechange` events to subscribed sessions as MCP `notifications/message` with `data: { event, payload, fileKey, fileName, pluginSessionId, causedBy }`. A session only receives events from the file it routes to: its bound file (`set_active_file` / `GRIP_FILE`), or the one open file when unbound; while it is ambiguous (several files open, not bound) it receives none. `causedBy` is a best-effort hint: `'self'` (this session had a change in flight on that file, or one finished in the last 1.5s), `'other'` (another agent did), `'unknown'` (nobody did, so probably the user; also when both did).

### `subscribe`
Merged (bridge-side): subscribe to a live event stream, dispatched on `target`.
- `target: 'selection'` — stream `selectionchange` events. Payload: `[{ id, name, type }]`.
- `target: 'document'`: stream `documentchange` events (debounced 500ms). Payload: `{ changes: <count>, origins: { LOCAL: <n>, REMOTE: <n> } }`, counted over the whole 500ms window. `LOCAL` = made in this Figma session (the user here, or any agent through Grip); `REMOTE` = another collaborator. `origins` needs plugin capability `docChangeOrigins`.
- `target: 'currentpage'` — stream `currentpagechange` events. Payload: `{ pageId, pageName }`.

---

## SerializedNode — what reads return

Always present: `id`, `name`, `type`. Other fields appear when the node has them.

| Field | Notes |
|---|---|
| `parent` | Only when `includeParent: true`. `{ id, name, type }`. |
| `visible`, `locked`, `x`, `y`, `width`, `height`, `rotation`, `opacity`, `blendMode`, `isMask`, `clipsContent`, `constraints` | Mixin-dependent. |
| `relativeTransform`, `absoluteBoundingBox` | Useful for camera math. |
| `absoluteTransform`, `absoluteRenderBounds` | **Opt-in** (name in `properties`). Page-relative 2x3 matrix / bounds including shadows+strokes (`null` if invisible). |
| `fillGeometry`, `strokeGeometry` | **Opt-in** (name in `properties`). Raw vector outlines `[{ windingRule, data }]` — can be huge; `get_node`/`get_nodes`/`get_selection` still enforce the `read_too_large` cap (`search_nodes` and `export_node` JSON do not), so request them on few nodes. |
| `counterAxisAlignContent`, `maskType`, `numberOfFixedChildren` | Emitted only when meaningful (wrapping frame / mask / > 0); name in `properties` to force. |
| `overlayPositionType`, `overlayBackground`, `overlayBackgroundInteraction`, `handleMirroring` | **Opt-in** (name in `properties`). |
| `fills`, `strokes`, `effects`, `layoutGrids` | Arrays. Fills/strokes use rich Paint shape (`type`, `hex`, `stops`, `imageHash`, `opacity`, `visible`, `blendMode`, `boundVariable`). |
| `strokeWeight`, `strokeAlign`, `strokeJoin`, `strokeCap`, `strokeMiterLimit`, `dashPattern`, `strokeTopWeight`/`Right`/`Bottom`/`Left` | When present. |
| `cornerRadius`, `topLeftRadius`/`TopRight`/`BottomLeft`/`BottomRight`, `cornerSmoothing` | `cornerRadius` omitted when mixed (per-corner). |
| Auto-layout: `layoutMode`, `paddingTop`/`Right`/`Bottom`/`Left`, `itemSpacing`, `counterAxisSpacing`, `primaryAxisSizingMode`, `counterAxisSizingMode`, `primaryAxisAlignItems`, `counterAxisAlignItems`, `layoutWrap`, `itemReverseZIndex`, `strokesIncludedInLayout` | FRAME/COMPONENT/etc. |
| Layout-as-child: `layoutAlign`, `layoutGrow`, `layoutPositioning`, `layoutSizingHorizontal`, `layoutSizingVertical`, `minWidth`, `maxWidth`, `minHeight`, `maxHeight` | Children of auto-layout containers. |
| Style binding ids: `fillStyleId`, `strokeStyleId`, `effectStyleId`, `gridStyleId`, `textStyleId` | Empty string when unbound. |
| TEXT-only: `characters`, `fontSize`, `fontFamily`, `fontWeight`, `fontName`, `textAlignHorizontal`/`Vertical`, `textAutoResize`, `textCase`, `textDecoration`, `lineHeight`, `letterSpacing`, `paragraphSpacing`, `paragraphIndent`, `hyperlink`, `listOptions` | Mixed values omitted. |
| INSTANCE: `componentId`, `componentName`, `componentProperties`, `overrides`, `exposedInstances`, `isExposedInstance` | `componentId`/`Name` resolved via `getMainComponentAsync`. |
| COMPONENT/COMPONENT_SET: `key`, `description`, `documentationLinks`, `componentPropertyDefinitions` | Definitions optional. |
| COMPONENT/COMPONENT_SET: `descriptionMarkdown` | Only when non-empty. Writable via `set_node_property`. |
| COMPONENT_SET: `defaultVariant`, `variantGroupProperties` | `defaultVariant` = `{ id, name }` of the top-left-most variant; `variantGroupProperties` = `{ [prop]: { values } }` (deprecated in Figma; prefer `componentPropertyDefinitions`). |
| INSTANCE: `scaleFactor` | Read-only here; normally `1`, differs only after the scale tool (K). |
| `devStatus` | Frames/components/instances/sections with a Dev Mode status: `{ type: 'READY_FOR_DEV'|'COMPLETED', description? }`. Omitted when unset. Writable via `set_node_property` (`null` clears). |
| PAGE: `guides`, `backgrounds`, `flowStartingPoints`, `prototypeStartNodeId` | `guides` = `[{ axis, offset }]`, `backgrounds` = Paint[], `flowStartingPoints` = `[{ nodeId, name }]`, `prototypeStartNodeId` = id or `null` (read-only). In `get_page`/`get_node` of a PAGE; deliberately NOT in `list_pages`/`get_document` (kept cheap). First three writable via `set_node_property` on the page id. |
| `boundVariables` | Only when `includeBoundVariables: true`. Map of field → `{ variableId, type }`. |
| `pluginData` | Only when `includePluginData: true`. `{ key: value }`. Filter with `pluginDataKeys`. |
| `exportSettings` | Array of Figma export presets. |
| `children` | Recursive serialized children. Absent on a node cut off at max depth (see `childCount`); when the node budget is spent, the remaining children collapse to stubs `{ id, name, type, childCount }`. |
| `childCount` | On a node cut off at max depth (it then has no `children`). Always present on stubs. |
| `truncated` | `true` on any node whose children were cut off by `depth` or the node budget. |

Read params (`get_node`/`get_nodes`/`get_selection`/`get_page`): `depth: N` returns exactly N levels below the root; a node cut off there gets `childCount` + `truncated: true` instead of `children`. Pass `stubs: true` to also list the next layer as `{ id, name, type, childCount }` stubs (handy for getting the ids to descend into).

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

### Dev status (`devStatus`)
Read: `get_node`/`get_page`/`search_nodes` (`properties:['devStatus']`) return `devStatus: { type: 'READY_FOR_DEV'|'COMPLETED', description? }` on nodes that have one (omitted otherwise). Write: `set_node_property { nodeId, property: 'devStatus', value }` with `{ type, description? }`, a bare `'READY_FOR_DEV'`/`'COMPLETED'`, or `null` to clear. Figma restrictions: only on a node directly under a page or section, and not inside a node that already has a status.

### `dev_resource`
Merged: manage Dev Mode resources on a node, dispatched on `op`.
- `op: 'add'` — `{ op, nodeId, url, name? }` (defaults to url) → `{ success: true }`.
- `op: 'edit'` — `{ op, nodeId, currentUrl, name?, url? }` → `{ success: true }`.
- `op: 'delete'` — `{ op, nodeId, url }` → `{ success: true }`.
- `op: 'get'` — `{ op, nodeId }` → `{ resources: [...] }`.

### `set_annotation`
Set annotations on a node. Pass `{ label, properties? }` or `annotations: [...]`.
- Params: `nodeId`, plus `label` + `properties` for one, or `annotations` for many.
- Returns: `{ success: true, count }`.

### `get_annotations`
- Params: `nodeId`. → `{ annotations: [...] }`.

### `annotation_category`
Merged: manage Dev Mode annotation categories, dispatched on `op`.
- `op: 'add'` — `{ op, label, color? }` → new category.
- `op: 'edit'` — `{ op, categoryId, label?, color? }` → `{ success: true }`.
- `op: 'delete'` — `{ op, categoryId }` → `{ success: true }`.
- `op: 'get'` — `{ op, categoryId }` → one category.
- `op: 'list'` — `{ op }` → all categories in the file.

### `measurement`
Merged: manage Dev Mode measurements, dispatched on `op`.
- `op: 'add'` — `{ op, startNodeId, endNodeId, startSide?, endSide?, offset?, freeText? }`.
- `op: 'edit'` — `{ op, measurementId, offset?, freeText? }` → `{ success: true }`.
- `op: 'delete'` — `{ op, measurementId }` → `{ success: true }`.
- `op: 'list'` — `{ op }` → all measurements in the file.
- `op: 'for_node'` — `{ op, nodeId }` → measurements anchored on that node.

### `set_file_thumbnail`
Set the file thumbnail node (must be FRAME/COMPONENT/COMPONENT_SET/SECTION). `nodeId: null` clears. To READ the current thumbnail node use the existing `get_file_thumbnail_node` (`{}` → `{ id, name, type }` or null; uses `getFileThumbnailNodeAsync`).
- Returns: `{ success: true }`.

---

## Library imports (remote)

Every by-key import (`import_component_by_key`, `import_component_set_by_key`, `import_style_by_key`, `import_variable_by_key`, `extend_library_collection_by_key`, and `map_nodes` swaps by `componentKey`) fails fast with `library_key_unresolved` after 6s. Figma never answers for a key it can't resolve — unknown key, a library not enabled for this file, or an internal/unpublished item (often underscore-named) — so Grip turns that silence into an actionable error instead of a 10s `request_timeout`.

### `import_component_by_key`
- Params: `key`. → `{ id, name, key }`.

### `import_style_by_key`
- Params: `key`. → `{ id, name, type, key }`.

### `import_variable_by_key`
- Params: `key`. → `{ id, name, resolvedType, key }`.

### `list_library_variables`
Browse the variables of connected team libraries (wraps `figma.teamLibrary`). Use it to find the `key`s that `import_variable_by_key` and `extend_library_collection_by_key` need.
- No params → `{ collections: [{ name, key, libraryName }] }`: the variable collections available to this file.
- `collectionKey` → `{ collectionKey, variables: [{ name, key, resolvedType }] }`: the variables inside that collection.
- The Plugin API has no equivalent listing for library **components** or **styles** — their keys come from the REST API or from existing instances/styles (`get_node` on an instance's main component, `get_styles` `key`).

### `extend_library_collection_by_key`
- Params: `key` (a library collection key from `list_library_variables`), `name?` (default `"Extended collection"`). → `{ id, name, isExtension: true, parentVariableCollectionId, rootVariableCollectionId, variableOverrides }`. Enterprise plan only. (Earlier versions omitted the name the API requires.) To extend a **local** collection use `variable_collection` `op: 'extend'`.

### `get_publish_status`
- Params: `id` — a style id, variable id, variable-collection id, or a component / component-set node id. → `{ id, status }`.

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
- Params: `family` (substring filter, optional), `axesFor` (exact family, case-insensitive, optional). → `[{ family, style }]`.
- `axesFor: '<family>'` instead returns one object `{ family, available, variable, axes, styles }`: `axes` = OpenType axis tags from `figma.getFontFamilyVariationAxes` (e.g. `['wght','wdth','slnt','opsz']`, `null` for a static family), `variable = axes !== null`, `styles` = the family's named instances. Tags only (the API exposes no min/max/default). If the API is missing (Figma older than update 138) or the family is unknown: `{ available: false, axes: null, variable: null, styles, error }`. Use the tags as keys of `fontName.variationSettings`.

### `load_font`
Pre-load a font for upcoming text writes.
- Params: `family` (req), `style` (optional), `variationSettings` (optional, e.g. `{ wght: 550 }`; ignored by loading — it only affects rendering — and echoed back when `style` is omitted).
- With `style` → `{ success, family, style }`. Without `style` → loads **every** style of the family (variable and static) → `{ success, family, style: null, allStyles: true }`; if the client rejects a style-less load it falls back to the legacy `Regular` default → `{ success, family, style: 'Regular', allStyles: false }`.

### `get_styled_text_segments`
Read per-range styled segments from a TEXT node.
- Params: `nodeId`, `fields[]` (default sensible set), `start`, `end`.
- `fields` also accepts `textWrapStyle`, `listSpacing`, `indentation`, `textDecorationStyle`, `textDecorationOffset`, `textDecorationThickness`, `textDecorationColor` (hex-encoded paint), `textDecorationSkipInk` (not in the default set).
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
- `create_sticky` also takes `authorVisible`, `isWideWidth` (booleans). **Batch:** `create_sticky {items:[{text?,x?,y?,author?,authorVisible?,isWideWidth?,color?}]}` (1-200) makes them all in one call and one undo step, returning `{ids, count}` instead of `{id, type}`. Top-level `author`, `authorVisible`, `isWideWidth`, `color` (hex fill) are defaults per item; top-level `text` is rejected with `items`. Items without both `x` and `y` are laid out in a grid (origin = top-level `x`/`y`, else where Figma places a new sticky; `columns` default `min(count,5)`, `gap` default 24); an item with its own `x` and `y` goes exactly there. All-or-nothing: a failure removes the stickies already made. `create_connector` also takes `startStrokeCap`, `endStrokeCap` (`NONE | ARROW_EQUILATERAL | ARROW_LINES | TRIANGLE_FILLED | DIAMOND_FILLED | CIRCLE_FILLED | ERD_*`).
- Post-creation via `set_node_property`: STICKY `authorVisible`, `isWideWidth`, `authorName`; CONNECTOR `connectorStartStrokeCap`, `connectorEndStrokeCap`, `textBackground` (Paint[] or `{ fills }` for the label background; `[]` clears). `get_node` reads all of these (connector `textBackground` as `{ fills }`), and TABLE_CELL nodes carry read-only `rowIndex`/`columnIndex`.

### `table_op`
Merged: insert/remove/move/resize/read rows and columns of a FigJam TABLE, dispatched on `op`.
- `op: 'insert_row'` / `'insert_column'` — `{ op, nodeId, index? }` (defaults to end).
- `op: 'remove_row'` / `'remove_column'` — `{ op, nodeId, index }`.
- `op: 'move_row'` / `'move_column'` — `{ op, nodeId, fromIndex, toIndex }`.
- `op: 'resize_row'` — `{ op, nodeId, index, height }`. `op: 'resize_column'` — `{ op, nodeId, index, width }`.
- `op: 'cell_at'` — `{ op, nodeId, row, column }` → the cell at that position.

---

## Cross-plugin metadata

### `set_shared_plugin_data`
- Params: `nodeId`, `namespace`, `key`, `value` (string or null to clear). → `{ success: true }`.

### `get_shared_plugin_data`
- Params: `nodeId`, `namespace`, `key` (optional). → `{ key, value }` or `{ keys, data }`.

---

## Misc

### `ui`
Merged: show/hide/resize/reposition the plugin window, dispatched on `op`.
- `op: 'show'` / `op: 'hide'` — `{ op }` (was `ui_show`/`ui_hide`).
- `op: 'resize'` — `{ op, width, height }` (was `ui_resize`).
- `op: 'reposition'` — `{ op, x, y }` (was `ui_reposition`).

### `notify`
Show a Figma toast.
- Params: `message` (req), `timeout` ms, `error` (red toast).
- Returns: `{ success: true }`.

### `create_image_from_url`
Bridge fetches an http(s) URL and registers an image. Returns `{ imageHash }`. Subject to Figma's CORS rules. Only public http(s) URLs: `file:`, `javascript:`, embedded credentials, `localhost` and private or link-local addresses are refused (`GRIP_ALLOW_LOCAL_URLS=1` allows local ones). Same rule for `open_external_url` and `create_link_preview`.

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

### `component_property`
Merged: manage component property definitions, dispatched on `op`.
- `op: 'add'` — `{ op, componentId, name, type ('VARIANT'|'TEXT'|'BOOLEAN'|'INSTANCE_SWAP'|'SLOT'), defaultValue (omit for SLOT), preferredValues?, description? (SLOT only), slotSettings? (SLOT only) }` → `{ propertyName }` — Figma appends `#<hash>` to the name.
- `op: 'edit'` — `{ op, componentId, propertyName, newName?, defaultValue?, preferredValues?, description? (SLOT only), slotSettings? (SLOT only) }` → `{ propertyName }`.
- `slotSettings` (SLOT properties): `{ minChildren?: int|null, maxChildren?: int|null (null clears a limit), stretchChildOnInsert?: bool, displayEmptyByDefault?: bool, allowPreferredValuesOnly?: bool }`. Unknown keys / wrong types are rejected before calling Figma; `slotSettings` on a non-SLOT type is an error on `add`.
- Reads: `componentPropertyDefinitions` (on `get_node` for COMPONENT/COMPONENT_SET, and `get_components`) carries `slotSettings` on SLOT properties. A SLOT node serializes `limitViolations` — `[]` when within limits, else any of `'BELOW_MIN'|'ABOVE_MAX'|'HAS_NON_PREFERRED'` (the last when `allowPreferredValuesOnly` and a child isn't a preferred value). Observed live: a component's own SLOT stays `[]` even over `maxChildren` — violations appear to be evaluated on instances.
- `op: 'delete'` — `{ op, componentId, propertyName }` → `{ success: true }`.

### `create_slot`
Create a SLOT inside a COMPONENT.
- Params: `componentId`, optional `name`, `slotSettings` (same shape as `component_property`), `preferredValues` (`[{ type: 'COMPONENT'|'COMPONENT_SET', key }]`), `description`, `propertyName`.
- `createSlot()` takes no arguments, so settings are applied after creation with `editComponentProperty` on the SLOT property the call just created (auto-detected as the single new SLOT key in `componentPropertyDefinitions`; pass `propertyName` to target one explicitly).
- Returns `{ id, name, type }`, plus `{ propertyName, slotSettingsApplied: true }` when settings were requested — or `slotSettingsApplied: false` + `warning` if the property couldn't be identified (then use `component_property` `op: 'edit'`).

### `reset_instance_overrides`
Remove all direct overrides on an INSTANCE (`removeOverrides()`, falling back to the deprecated `resetOverrides()` on older clients), or reset a SLOT node to the component's original slot content (`resetSlot()`).
- Params: `nodeId` (an INSTANCE or a SLOT). → `{ success: true, reset: 'overrides' | 'slot' }`.

---

## Bulk / scripting

### `map_nodes`
Bulk-edit matched nodes with a **Grip-owned, chunked, yielding loop** — the safe way to "set X on every matching node" without run_script (can't freeze Figma).
- Params: `query` (req: `{ types, name, nameFlags, scope:<nodeId>, page }` — must have `types` (fast findAllWithCriteria) or `scope`; a bare page-wide match is refused), then one of:
  - `set` — property→value map applied per node like `set_node_property`.
  - `delete:true` — removes matched nodes.
  - `rename:{find,replace,regex?}` — literal substring substitution unless `regex:true` (then `find` is a RegExp source, global flag).
  - `swap:{componentKey?,componentId?}` — resolves `componentKey` via `importComponentByKeyAsync` or `componentId` via `getNode`, swaps it onto each matched INSTANCE (non-instance matches skipped).
  - `applyStyle:{styleId,type?}` — `type` selects the style slot (`fill|text|effect|grid|stroke`, default `fill`); uses the same async setter as `apply_style`.
  - `budget` (default 10000), `chunk` (default 200).
- Returns: `{ matched, applied, truncated, limitations }`. `truncated:true` (applied < matched) means the budget was hit — narrow the query or raise budget and re-run. 60s timeout.

### `run_script`
Execute JS in the plugin sandbox — powerful, for bulk ops / custom logic. Returns `{ result, logs[], ms }`.
- Scope injects, besides `figma`/`args`/`serializeNode`/`coerce`/`asIds`/`log`/`getNode`, the **gentle bulk helpers**: `findNodes(query)` (typed, findAllWithCriteria; refuses a bare page walk), `forEachNode(itemsOrQuery, fn, {chunk,budget})` / `mapNodes(...)` (chunk + yield so the thread never freezes), and `yieldNow()`. Each script has its own yield pacing clock, so concurrent work never shifts another script's yields.
- **The transport inspects your code and pushes back.** Freeze patterns are rejected BEFORE running with a teaching `run_script_rejected: …` error: `while(true)`/`for(;;)`, and page/document-wide `figma.currentPage|root.findAll(...)`. Do bulk work via `await forEachNode(findNodes({types:[...]}), n => {...})`; bound any hand-written loop and `await yieldNow()`. Single-threaded plugin: a synchronous loop cannot be interrupted, so this is enforced up front, not mid-run.

---

## Search variants / refactor helpers

### `find_with_criteria`
Optimized subtree walker (typed). Faster than `search_nodes` for plain type filters.
- Params: `scope` (default current page), `pageId` (search that page, loaded but not made current; `scope` wins), `types[]`, `pluginData`, `sharedPluginData`, `maxResults` (default 200).
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
- Params: `url` (public http(s) only, see `create_image_from_url`). → `{ success: true }`.

---

## Per-user persistent storage

`figma.clientStorage` is per-user, per-plugin, per-machine; survives reloads. Useful for agent memory tied to the human user.

### `client_storage`
Merged: read/write per-user client storage, dispatched on `op`.
- `op: 'get'` — `{ op, key }` → `{ key, value }`.
- `op: 'set'` — `{ op, key, value }` → `{ success: true }`.
- `op: 'delete'` — `{ op, key }` → `{ success: true }`.
- `op: 'keys'` — `{ op }` → `{ keys }`.

---

## Niche node creation

### `create_slice` — slice/export region.
### `create_text_path` — text along an existing path node (Figma Draw). Params: `pathNodeId` (req), `startSegment` (default 0), `startPosition` (default 0), `text?`, `parentId?`. Returns `{ id, type, textPathStartData }`.
### `create_gif` — GIF node referencing existing image hash.
### `create_video` — video node from base64 bytes.
### `create_link_preview` — link preview from URL (FigJam).
### `create_page_divider` — divider in pages list.
### `create_slide` / `create_slide_row` — Slides editor.
### `create_code_block` — FigJam code block. Params: `code`, `language`, `parentId`.

All return `{ id, type, ... }` with editor-specific extras.

### `slides_canvas`
Merged, Slides editor only: manage the canvas row grid, dispatched on `op`.
- `op: 'create_row'` — `{ op }` (was `slides_create_canvas_row`).
- `op: 'get_grid'` — `{ op }` → the current canvas grid (was `slides_get_canvas_grid`).
- `op: 'set_grid'` — `{ op, grid }` (was `slides_set_canvas_grid`).
- `op: 'move_nodes'` — `{ op, nodeIds, row, column }` (was `slides_move_nodes_to_coord`).
- `op: 'focus'` — the slide in single-slide view (`currentPage.focusedSlide`). `{ op }` reads → `{ focusedSlideId }` (null if none); `{ op, nodeId: '<SLIDE id>' }` focuses it; `{ op, nodeId: null }` clears. `get_page_context` also returns `focusedSlideId` (only when a slide is focused).
- SLIDE nodes: `isSkippedSlide` (skipped in presentation) is read by `get_node` and written with `set_node_property`. The deprecated `getSlideGrid`/`setSlideGrid` are superseded by `get_grid`/`set_grid` (canvas grid) and not wrapped separately.

---

## FigJam timer

### `timer`
Merged: control the FigJam timer, dispatched on `op`.
- `op: 'start'` — `{ op, seconds }`.
- `op: 'stop'` / `op: 'pause'` / `op: 'resume'` — `{ op }`.

---

## Multiplayer / identity

Both require manifest `permissions: ["activeusers", "currentuser"]`.

### `get_active_users`
Returns array of `{ id, name, color, sessionId, position }`.

### `get_current_user`
Returns `{ id, name, color, sessionId }` or null.

---

## CSS-grid auto-layout (v0.2.6)

Set `layoutMode="GRID"` via `set_node_property`, then configure with more `set_node_property` calls:
- Container: `gridRowCount`, `gridColumnCount`, `gridRowGap`, `gridColumnGap`, `gridColumnSizes`/`gridRowSizes` (arrays of `{ type: 'FLEX'|'FIXED'|'HUG', value }`), `gridAutoTracks`, `gridItemsPositioning`.
- Grid child (on a direct child): `gridRowSpan`, `gridColumnSpan`, `gridRowAnchorIndex`, `gridColumnAnchorIndex`, `gridChildHorizontalAlign`, `gridChildVerticalAlign`.

### `set_grid_child_position` — `{ nodeId, row, column }` (0-based). Wraps `node.setGridChildPosition`. To *reparent into* a grid cell use `move_node` with `row`/`column` (wraps `appendChildAt`).

### `reorder_grid_tracks` — `{ nodeId, axis: 'rows' | 'columns', fromIndices: number[], insertionIndex }` → `{ success, moves: [{ from, to }] }`. Wraps `reorderRows` / `reorderColumns` (typings ≥ 1.142) on a GRID auto-layout frame. `fromIndices` need not be sorted or contiguous; `insertionIndex` is against the **original** order, `0..count` inclusive (rows `[0]` with `insertionIndex: 3` on a 3-row grid moves row 0 to the end). Spanning children pull their tracks along, and `moves` lists them. Not for FigJam tables — use `table_op` `move_row` / `move_column`.

## Shaders (v0.2.9)

### `list_shaders` — none. Returns shader descriptors available to the file (`[]` if none).
### `import_shader` — `{ shaderId }` (from `list_shaders`). Materializes it into the file. Apply via `set_node_property` fills/effects with `{ type: 'SHADER', shaderId }`.

## Motion — keyframe/timeline animation (v0.2.10)

Native Figma Motion; distinct from prototype `reactions`.
### `list_animation_styles` — none. Returns the 6 presets (Position, Scale, Rotation, Size, Opacity, Path) with `{ styleId, name, description, props }`. `props` is a DESCRIPTOR, not the strict `animation_style` (`op: 'apply'`) input schema.
### `get_animations` — `{ nodeId }`. Returns `{ animationStyles, animations, manualKeyframeTracks, timelines }`.
### `animation_style`
Merged: apply/remove Motion animation styles on a node and manage CUSTOM animation styles (Figma update 140), dispatched on `op`.
- `op: 'apply'` — `{ op, nodeId, styleId, props? }`. For a Figma preset, `props` forwarded verbatim (Figma validates per-preset — start minimal, e.g. `{ duration: 0.5 }`). For a custom style (`styleId` = id from `create`/`list_local`), `type: 'CUSTOM'` is injected automatically; `props` may carry `{ timelineOffset }` (seconds). Returns `{ success, id }` (`id` = applied-instance id).
- `op: 'remove'` — `{ op, nodeId, id }`. `id` = applied-instance id (`animationStyles[].id`), NOT the style id.
- `op: 'create'` — `{ op, name?, description?, entries?: [{ styleId, props? }] }`. Creates a custom style (`figma.createCustomAnimationStyle`); each entry is a preset from `list_animation_styles` added via `addAnimationEntryAsync`. A `"Folder/Name"` name places it in a folder. Returns `{ id, key, name, description, type:'CUSTOM_ANIMATION', remote, animationEntries:[{ id, name, type:'FIGMA', duration, timelineOffset, props, ... }] }`. If an entry fails the new style is removed again.
- `op: 'list_local'` — `{ op }`. Local custom animation styles, same shape as `create`'s result.
- `op: 'update'` — `{ op, styleId, name?, description? }`. Returns the style.
- `op: 'move_style'` — `{ op, styleId, afterStyleId? }`. Reorder within the folder (omit `afterStyleId` = first). Both must be local custom styles in the same folder. Returns `{ success }`.
- `op: 'move_folder'` — `{ op, folder, afterFolder? }`. Full `/`-delimited folder names; same parent required; omit `afterFolder` = first. Returns `{ success }`.
- `op: 'add_entry'` — `{ op, styleId, entryStyleId, props? }`. Adds a Figma animation to a custom style; returns `{ entry, style }`. Throws for remote styles / presets that cannot be added programmatically.
- `op: 'remove_entry'` — `{ op, styleId, entryId }` (`entryId` = `animationEntries[].id`). Returns the updated style.
- Delete a custom style with `delete_style { styleId }`. Custom styles applied to a node appear in `get_animations.animationStyles` (`type: 'CUSTOM'`).

### `manual_keyframe_track`
Merged: apply/remove a manual keyframe track, dispatched on `op`.
- `op: 'apply'` — `{ op, nodeId, field, track }`. `field` = `{type:'PROPERTY', name}` or `{type:'INDEXED_ITEM', collection:'effects', index, field:'RADIUS'|'COLOR'|'SPREAD'|…}`; `track` = `{ keyframes:[{ timelinePosition, value:{type:'FLOAT', value}, easing? }] }`. Node needs a timeline (apply a preset first) and the referenced item must exist.
- `op: 'remove'` — `{ op, nodeId, field }` (same `field` descriptor).
### `set_timeline_duration` — `{ nodeId, timelineId, duration }` (seconds). `timelineId` from `get_animations` `timelines[].id`.
### `spring_to_normalized` — `{ spring }` → `figma.motion.physicalSpringToNormalized`.

## Figma Draw strokes / transform groups (v0.2.11)

- Dynamic strokes via `set_node_property` (passthrough + serialized): `complexStrokeProperties` (brush/stretch/scatter), `variableWidthStrokeProperties`.
- Newer auto-layout enum values (all plain passthrough, no special handling):
  - `primaryAxisAlignItems`: `'MIN'|'CENTER'|'MAX'|'SPACE_BETWEEN'|'SPACE_EVENLY'|'SPACE_AROUND'` — `SPACE_EVENLY` spaces children evenly with equal gaps before the first, between each pair and after the last (Update 137); `SPACE_AROUND` makes the gaps between children equal with half-size gaps at both ends.
  - `layoutWrap`: `'NO_WRAP'|'WRAP'` — `WRAP` is valid on `layoutMode: 'VERTICAL'` (Update 140) as well as `'HORIZONTAL'`; set `layoutMode` first (Figma throws if the frame has no HORIZONTAL/VERTICAL auto-layout).
  - `NOISE`/`TEXTURE` effects carry an optional read-only-in-practice `noiseSizeVector: { x, y }` (per-axis size; `x` must equal `noiseSize`). The generic effect serializer already emits it as `{x, y}`. A NOISE effect needs `noiseSize` (a number); `noiseSizeVector` can be set alongside it, and `blendMode`/`opacity` are rejected on NOISE.
### `transform_group` — `{ nodeIds, parentId?, index?, transformModifiers? }`. Wraps nodes in a `TRANSFORM_GROUP`; `transformModifiers` is an array (default `[]`).

## Color spaces (Figma update 141)

Figma can author colors in a color space; the sRGB result is the paint's `color`, and the authored value is its `sourceColor`.
- **Reads** — SOLID paints emit `hex`, `opacity` **and** `sourceColor` (when the color was authored in a space); gradient `stops[]` and effect colors (`color`, `secondaryColor`) likewise emit `{ hex, opacity, sourceColor? }`. `sourceColor` is a `ColorWithColorSpace`: `{ space: 'SRGB'|'DISPLAY_P3', r, g, b }`, `{ space: 'HSL', h, s, l }`, `{ space: 'HSB', h, s, b }`, `{ space: 'OKLAB', l, a, b }`, or `{ space: 'OKLCH', l, c, h }`. Pass it back unchanged to round-trip.
- **Writes** — everywhere a hex string is accepted for a color (fills/strokes shorthand and `hex`/`color`, gradient stop `hex`/`color`, effect colors, `set_style` PAINT/EFFECT, variable COLOR values) you may instead pass any CSS color string (`'oklch(0.7 0.1 200)'`, `'hsl(220 90% 50%)'`, `'lab(...)'`, `'rgb(...)'`, `#RRGGBBAA`) or a `{ space, ... }` object. Parsing goes through one helper using `figma.util.rgba`; plain `#hex` keeps the original parser. A CSS-string alpha becomes the paint `opacity` (unless `opacity` is given) or the color's `a`. A paint can be `{ type:'SOLID', sourceColor:{space:'OKLCH',l,c,h}, opacity }` with no hex.
- **Stale sourceColor** — if `hex` and `sourceColor` are both given and disagree (you edited `hex` on a read-back paint), `hex` wins and `sourceColor` is dropped.
- Non-hex input requires a Figma build exposing `figma.util.rgba` (update 141+); otherwise a clear error is thrown.

## New paint / effect variants (v0.2.8)

Applied via `set_node_property` fills/strokes/effects (fully-shaped objects pass through; reads are lossless):
- Paints: `SHADER` (`{ type:'SHADER', shaderId }`), `VIDEO`, `GRADIENT_DIAMOND`.
- Effects: `NOISE` (`noiseType: MONOTONE|DUOTONE|MULTITONE`), `TEXTURE`, `GLASS` (`refraction/depth/lightIntensity/lightAngle/dispersion/radius`), progressive blur (`blurType:'PROGRESSIVE'` + `startRadius/startOffset/endOffset`).

## Tool scoping (`GRIP_TOOLS`)

By default an agent only sees the `core` scope (~35 always-useful tools), not the full 155 — this keeps per-turn schema weight small. Widen the scope per agent — at launch (below) or mid-session with `grip_load_tools {categories:['motion', …]}` (or `'all'`), and drop them again with `grip_load_tools {unload:['motion']}` (`'all'` resets to core; `core`/`meta` can't be unloaded, and tools that are also in core stay). Each change refreshes the tool list via `tools/list_changed` (applies next turn; clients that ignore the notification can still use `run_script`). Not available to restricted scopes without `run_script` (e.g. `GRIP_TOOLS=read`):

- **stdio:** set env `GRIP_TOOLS=core,motion` on the agent process (delivered to the daemon as an IPC control frame, alongside `GRIP_FILE`).
- **HTTP:** pass `?tools=core,motion` on the `/mcp` URL.

Tokens are comma-separated. `core` (the default when `GRIP_TOOLS` is unset) and `all` (every tool) are presets; anything else must be one of the category names below (unknown tokens are ignored, never fatal):

`meta`, `read`, `write`, `pages`, `styles`, `variables`, `components`, `text`, `export`, `vector`, `motion`, `figjam`, `slides`, `devmode`, `library`, `assets`, `storage`, `subscribe`, `misc`.

`meta` tools (`grip_health`, `grip_diagnose`, `list_files`, `set_active_file`, `get_page_context`, `grip_capabilities`, `grip_load_tools`, `grip_update`) are always present regardless of scope. Regardless of scope, `run_script` (in `core` and in `write`) can reach any Plugin API surface, including tools your scope doesn't expose typed schemas for.

Call `grip_capabilities` to see every category, its tool count, a sample of its tools, and whether it's currently `loaded` for your session — the way to discover what a narrower scope is hiding, and to know what to add to `GRIP_TOOLS`/`?tools=` to get it back as typed tools instead of reaching it via `run_script`.

Deep per-tool guidance (param recipes, enum shapes, edge cases) is pull-based, not always injected: the fattest always-injected (core/meta) tools carry a tight what+when `description` plus a fuller `detail`; call `grip_capabilities {tool:'<name>'}` to get that detail.
