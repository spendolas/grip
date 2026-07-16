# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Grip is a Figma plugin + local Node bridge that exposes full canvas read/write access to MCP agents. Pairs with **Gaffer** (separate tool — see `mcp__gaffer__*`). This file is canonical for architecture; [`TOOLS.md`](./TOOLS.md) is canonical for the tool surface.

## Architecture

One long-lived **daemon** serves three MCP transports against the same `PluginBridge`; its lifetime is independent of any agent:

```
agent ─HTTP MCP──── http://127.0.0.1:7778/mcp ──────────────────────────┐   (direct; no shim)
agent (claude -p) ─stdio MCP─ shim (dist/index.js) ─IPC unix sock─┐      │
agent (claude -p) ─stdio MCP─ shim (dist/index.js) ─IPC unix sock─┤      │
                                                                  ▼      ▼
                              DETACHED daemon (dist/index.js --daemon)
                                • own session, PPID 1 — survives agent kills
                                • HTTP :7778 /mcp  ⇄ direct MCP clients (one McpSession per HTTP session)
                                • IPC unix sock    ⇄ each shim (one McpSession per)
                                • WS :7777         ⇄ each Figma plugin iframe ⇄ postMessage ⇄ plugin main
```

Two transports for agents, chosen by how grip is registered in `~/.claude.json`:

- **HTTP (preferred for Hub):** register `{type:'http', url:'http://127.0.0.1:7778/mcp'}`. The agent connects **directly** to the daemon — no shim, no IPC hop. This removes the leader-death stall class: a call can't be lost in a dying intermediary, and a dead daemon is an instant connection error, not a silent hang. `http-server.ts` runs a stateful `StreamableHTTPServerTransport` per session (one `createSession()` each, reused verbatim). Requires the daemon to be already running → keep it warm with the launchd LaunchAgent (`bridge/scripts/install-launchd.sh`, sets `GRIP_PERSISTENT=1` which disables idle-exit so KeepAlive owns lifecycle).
- **stdio (on-demand, zero-setup):** register `command: dist/index.js` (no flag). That binary is the **shim** by default, **daemon** with `--daemon`. Each agent spawns a shim; the shim probes the IPC socket and, if no daemon, `spawn(detached:true)`s `dist/index.js --daemon` (`stdio:'ignore'`, `.unref()`), waits for the bind, then pipes stdio MCP traffic over IPC. Good for local Claude Code — no always-on daemon needed.
- **Single-instance:** the daemon binds WS `:7777` first (atomic lock); a second daemon losing that bind exits. HTTP `:7778` bind failure is non-fatal (logs + skips HTTP). The launchd install kills any on-demand daemon so the persistent one wins the port.

Implications that span files:

- **stdout is sacred.** Shim stdout is the MCP transport to the agent. All logging goes to **stderr only** (mirrored to `~/.grip-bridge.log`). Any `console.log` corrupts the stream.
- **Per-MCP-session state.** Each transport connection (shim over IPC, or a direct HTTP session) becomes one `McpSession` (`bridge/src/types.ts`) on the daemon, with independent `activeFileId`, `bind`, `subscriptions`, `rateBucket`. `bridge.request(method, params, mcp)` and `bridge.list/setActive(target, mcp)` route by the passed session — no global "active file."
- **Agents bind to a file; routing never guesses.** `route()` (`ws-server.ts`) is the single decision, driven by `McpSession.bind` (`{key?,name?}` — what the agent WANTS) and `activeFileId` (resolved live pin). Order: (1) live pin still open → route; (2) `bind` set → newest live session matching it, else **`deferred`** (never falls to another file); (3) unbound → one open file routes frictionlessly, zero → `plugin_disconnected` after cold-start grace, **>1 → `ambiguous_active_file`** naming every open file + fileKey. grip will NOT silently pick among files (the old auto-pick only logged a stderr warning the agent couldn't see → agents landed on the wrong file).
- **Two ways to bind.** Runtime: `set_active_file` accepts fileKey / exact name / sessionId / figma.com URL (`resolveBind` + `FIGMA_URL_RE`); binds even if the file isn't open yet (deferred), returning `{bound,resolved,...}` + the open-file list so a typo is caught. Launch-time: env **`GRIP_FILE=<key|name|url>`** on the agent process — the shim (`proxy.ts`) forwards it as a `{grip:'bind'}` **control frame** (first line on the IPC socket, before MCP traffic); `SocketTransport.onControl` routes it out-of-band (not JSON-RPC) and `ipc-server` calls `bridge.bindFromLaunch`. Agent never calls a tool. Re-sent on every reconnect. **Launch-time `GRIP_FILE` is stdio-only** — there is no shim over HTTP, so env doesn't reach the daemon per-agent; HTTP clients bind at runtime via `set_active_file` (multi-file unbound calls fail loud with `ambiguous_active_file`, so the agent knows to bind).
- **Sticky across reconnect churn.** Figma respawns plugin iframes every ~1–3min — each is a **new sessionId**. When the live pin dies, `route()` re-resolves from `bind` (re-pins to the same file's newest live session; a name-bind promotes to `bind.key` on first resolve). If the bound file is fully closed → `deferred` → `bound_file_not_open` after the wait grace (never hops). Sessions carry `helloAt`; same-fileKey ties resolve newest-wins so routing never lands on a dying zombie. This all exists because a dead pin + two open files used to make page-scoped reads (`figma.currentPage.findAll`, `.selection`) silently hit the *wrong file's* page and return `[]` — a false-negative, not an error.
- **Plugin sessions.** Many Figma windows can run the plugin at once. Each opens its own WebSocket to the daemon; plugin replies with a `hello` carrying `version`/`capabilities`/`fileKey`/`fileName`/page. Fan-out by design.
- **Correlation by UUID.** `bridge/src/ws-server.ts` keeps `Map<uuid, {...}>` for in-flight WS requests. 10s timeout + 5s heartbeat (`ws.ping`); dead plugin → reject pending with `plugin_disconnected`. Response >8MB rejected with `response_too_large`.
- **Plugin main thread is the only place Figma API runs.** `plugin/code.ts` dispatches by `method`, serializes, returns via `postMessage`. UI iframe (`plugin/ui.html`) is a thin relay + 32px status strip — it owns the WebSocket and **forwards the full `hello` (incl. version/capabilities)**; an earlier allow-list that dropped fields caused a long false-positive cache hunt.
- **Reads are bounded by default.** `get_node`/`get_nodes`/`get_selection` default to depth 12 + a 3000-node budget (`maxNodes`); children beyond collapse to stubs with `truncated:true`. Pass `depth:-1` + `maxNodes:0` for full fidelity. Unbounded reads were the `get_selection` 128s-stall cause.
- **Never read `err.stack` on hot paths.** Accessing it triggers V8's `CallPrinter`/`Scanner` source walk and pegs CPU at 100% (an "eager drain" we added then reverted). `Error.stackTraceLimit = 3` is set in `index.ts`; handlers log `err.message` only.
- **Idle shutdown.** Daemon exits 60s after **0 shims AND 0 plugins**. While any Figma plugin is connected it stays warm. On-demand cold-start note below.

## On-demand cold-start tradeoff

A Figma plugin opened **before** any agent has called grip shows disconnected — the Figma sandbox can't launch a local process, so plugin-open alone can't start the daemon. The first agent call spawns the daemon; the plugin's exponential-backoff WS reconnect latches within ~2s. From the agent's side the first call "just works" (the shim spawns + waits). Inherent to on-demand given Figma's sandbox; the alternative is a launchd always-on daemon.

## File map

```
bridge/src/
  index.ts            role split: shim (default) vs daemon (--daemon); shim spawns detached daemon
  ws-server.ts        WebSocketServer on :7777; PluginBridge tracks plugin sessions; heartbeat; response cap
  ipc-server.ts       UNIX socket server; one MCP session per accepted shim
  http-server.ts      HTTP :7778 /mcp; StreamableHTTPServerTransport per session (direct clients)
  socket-transport.ts MCP SDK Transport over a Node socket (newline JSON-RPC)
  proxy.ts            shim pipe: stdin↔socket↔stdout + typed-error-on-drop + reconnect signal
  mcp-server.ts       per-session Server() factory; event fan-out; grip_health/grip_diagnose; call logging
  tools.ts            zod schemas + JSON-Schema descriptors for the tools
  serializer.ts       hex/depth helpers (real serialization is in plugin)
  types.ts            shared interfaces (McpSession, PluginSessionInfo, WSHello w/ version+capabilities)
plugin/
  manifest.json       documentAccess: dynamic-page; networkAccess: localhost:7777; permissions
  code.ts             Plugin API dispatcher + inline serializer; PLUGIN_VERSION + capabilities
  ui.html             120×32 status strip; auto-reconnect; busy pulse; forwards full hello
```

## Diagnostics

- `grip_health` / `grip_diagnose` — MCP tools, no plugin round-trip; return plugin versions+capabilities, event-loop lag, pending count, mem/cpu, log tail.
- `~/.grip-bridge.log` — all stderr (per-call `»`/`«` lines, hellos, heartbeat, errors). `~/.grip-bridge.status` — daemon pid/version/counts, refreshed 5s. `~/.grip-bridge.dump-*.json` — written when the watchdog self-exits.
- `bridge/scripts/grip-doctor.sh` — shell snapshot (lsof/ps/sample/log/status) for when the daemon is wedged past MCP reach.

## MCP tool surface

178 tools. Per-tool reference lives in [`TOOLS.md`](./TOOLS.md). Quick map:

**Bridge-side (no plugin round-trip):**
- `list_files`, `set_active_file` — multi-file session routing.

**Read:** `get_document`, `get_page`, `get_page_context` (cheap "where am I": file/page/selectionCount), `get_node`, `get_nodes` (bulk), `get_selection`, `get_styles`, `get_variables`, `get_components`, `search_nodes`, `get_plugin_data`.

**Export:** `export_node` (SVG, PNG, JPG, PDF, CSS, JSON).

**Write — node-level:** `set_node_property` (one dispatcher across ~60 props — numeric/bool/passthrough buckets), `create_node` (10 types incl. GROUP/LINE/POLYGON/STAR/VECTOR; `props` payload applied at creation), `delete_node`, `clone_node`, `move_node`, `group_nodes`, `ungroup_node`.

**Write — selection / viewport:** `set_selection`, `scroll_to`.

**Write — pages:** `create_page`, `set_current_page`, `delete_page`.

**Write — components / instances:** `detach_instance`, `swap_instance`, `create_component_from_node`, `combine_as_variants`.

**Write — styles & variables:** `set_style` (PAINT/TEXT/EFFECT/GRID), `apply_style`, `set_variable_value`, `bind_property_to_variable`, `bind_paint_to_variable`, `create_variable_collection`, `delete_variable_collection`, `create_variable`, `delete_variable`, `add_variable_mode`, `remove_variable_mode`, `rename_variable_mode`, `set_variable_meta`.

**Write — text range:** `set_text_range_property` (per-range styling on TEXT nodes).

**Write — assets / metadata:** `upload_image` (small inline base64), `upload_image_from_path` (bridge reads from disk — bypasses MCP stdio truncation), `upload_image_begin`/`upload_image_chunk`/`upload_image_finish` (chunked, when only bytes available), `set_plugin_data`.

**Subscribe (notifications, no round-trip):** `subscribe_selection`, `subscribe_document` (debounced 500ms), `subscribe_currentpage`.

**Vector / boolean / SVG:** `flatten_nodes`, `boolean_operation` (UNION/SUBTRACT/INTERSECT/EXCLUDE), `create_node_from_svg`, `set_vector_network`.

**Hand-off / dev mode:** `add_dev_resource`, `delete_dev_resource`, `get_dev_resources`, `set_annotation`, `get_annotations`, `set_file_thumbnail`.

**Library imports (remote):** `import_component_by_key`, `import_style_by_key`, `import_variable_by_key`.

**Layout / viewport / history:** `create_section`, `set_viewport`, `commit_undo`, `save_version`.

**Fonts / text introspection:** `list_fonts`, `load_font`, `get_styled_text_segments`.

**Prototype:** `set_reactions`.

**FigJam-only:** `create_sticky`, `create_connector`, `create_shape_with_text`, `create_table`.

**Cross-plugin metadata:** `set_shared_plugin_data`, `get_shared_plugin_data`.

**Misc:** `notify` (toast), `create_image_from_url`, `get_selection_colors`, `get_deep_link` (figma.com URL to a node; kind=design/dev/proto; needs real `figma.fileKey` — works because manifest sets `enablePrivatePluginApi` + grip runs in an org; returns `available:false` if fileKey is `0:0`).

**Component property definitions:** `add_component_property`, `edit_component_property`, `delete_component_property`. Plus `reset_instance_overrides`.

**Search variants:** `find_with_criteria` (typed subtree walker, faster than `search_nodes` for plain type filters).

**Refactor helpers:** `get_style_consumers`.

**Undo / external:** `trigger_undo` (companion to `commit_undo`), `open_external_url`.

**Per-user persistent storage:** `client_storage_get`, `client_storage_set`, `client_storage_delete`, `client_storage_keys`.

**Niche node creation:** `create_slice`, `create_text_path`, `create_gif`, `create_video`, `create_link_preview`, `create_page_divider`, `create_slide`, `create_slide_row`, `create_code_block`.

**FigJam timer:** `timer_start`, `timer_stop`, `timer_pause`, `timer_resume`.

**Multiplayer / identity:** `get_active_users`, `get_current_user`. Both require manifest `permissions: ["activeusers", "currentuser"]` (added).

Highlights worth knowing while editing:

- `set_node_property` value buckets: `NUMERIC_PROPS`, `BOOL_PROPS`, `PASSTHROUGH_PROPS` (in `plugin/code.ts`). Adding a new prop = adding to the right bucket; cases above the bucket switch handle props that need special async work (font loading, paint shaping, instance setProperties).
- `serializeNode` accepts a `SerializeOpts` ({ depth, maxDepth, includeChildren, includeParent, includePluginData, pluginDataKeys, includeBoundVariables, properties }). Old positional `(node, depth, maxDepth, include)` still works via shim.
- `figma.on('documentchange')` requires `figma.loadAllPagesAsync()` first under `dynamic-page` access — done in `registerDocumentChange()` at boot.
- INSTANCE serialization uses `getMainComponentAsync()` (sync getter throws under `dynamic-page`).
- `figma.fileKey` returns null for unpublished/local files; plugin falls back to `figma.root.id` (`"0:0"` constant) — fileKey-based targeting only works for cloud files. SessionId-based targeting always works.
- `set_text_range_property` derives the setter name (`setRange<Property>`) and pre-loads the fonts in the range. Property names match Figma's setter suffix.

## Build / run

```sh
# Bridge
cd bridge && npm install
npm run build              # tsc → dist/ (+ chmod +x)
node dist/index.js         # runs as shim; auto-spawns the detached daemon
node dist/index.js --daemon  # run the daemon in the foreground (debugging)

# Plugin
cd plugin && npm install
npm run build              # produces build/code.js (referenced by manifest)
# Then: Figma Desktop → Plugins → Development → Import from manifest → plugin/manifest.json
# Plugin hot-reloads on rebuild — no manual reload needed.
```

Register — two options (writes user-scope MCP config to `~/.claude.json`):

```sh
# stdio (on-demand, zero-setup — good for local Claude Code)
claude mcp add --scope user grip node /abs/path/to/grip/bridge/dist/index.js

# HTTP (preferred for Claude Hub — direct connect, no shim; fixes leader-death hang)
bash bridge/scripts/start-daemon.sh                                      # keep the daemon always-on (nohup)
claude mcp add --transport http -s user grip http://127.0.0.1:7778/mcp   # then register the URL
```

Order matters for HTTP: start the daemon first (nothing else starts it for HTTP — Figma's sandbox can't). **Always-on mechanism:** use `start-daemon.sh` (nohup, gaffer-style) — run it once and/or have Claude Hub run it at startup. A launchd LaunchAgent (`install-launchd.sh`) is the "nicer" option BUT **launchd refuses to run a program on a `noowners` volume** (secondary APFS / `/Volumes/…/CloudStorage` cloud mounts) with `Bootstrap failed: 5: Input/output error` — grip's repo lives on exactly such a volume, so launchd is unusable here (this is why gaffer, same Dropbox tree, also uses nohup). `install-launchd.sh` preflights for this and redirects to the starter. Note: spec/older docs say `~/.claude/mcp.json` — that file isn't read by Claude Code; the CLI writes `~/.claude.json`.

Multiple Claude sessions / Claude Hub all share one detached daemon automatically. To inspect: `lsof -i:7777` shows the daemon (PPID 1, own process group); each agent's shim lives only as long as its `claude` session. `cat ~/.grip-bridge.status` for daemon pid/version/counts without an MCP round-trip.

## Test scripts (development only)

`bridge/test-call.mjs` and `bridge/test-chain.mjs` spawn a shim (which ensures/attaches the daemon) and drive the MCP protocol over stdio. Useful for end-to-end probing without an MCP client. Both wait ~11s for plugin reconnect (UI uses exponential backoff up to 10s).

## Plugin UI

The actual UI is a 120×32 colored strip — Figma's chrome handles the title bar/close. Single state machine:

| State | Color | Trigger |
|---|---|---|
| Disconnected | `#B3B3B3` grey | WS closed, no special reason |
| Connected | `#19E54C` green | WS open + helloed |
| Warning | `#E5C319` yellow | (legacy code path; current bridge accepts all plugins) |
| Error | `#E53519` red | WS error or plugin tool threw — auto-clears in 2s if still connected |

When a tool is in flight: `.pulsing` class on the strip → 900ms ease-in-out opacity breath. Triggered by `kind:'busy'` messages from `code.ts` around `handle()`.

`figma.showUI({ width: 120, height: 32 })`. No HTML chrome. No light/dark modes. Plugin icon is published-only metadata — not configurable in dev manifest.

## Error handling contract

- Plugin API errors → catch and `figma.ui.postMessage({kind:'response', id, error: msg})`; never crash plugin.
- WS disconnect → bridge rejects pending requests bound to that plugin session with `"Plugin disconnected"`.
- Validate params before any Plugin API call. Standard messages: `"Node not found: <id>"`, `"Property '<prop>' not supported on node type <type>"`.
- Bridge never logs to stdout. Anything informational → `process.stderr.write`.
- **Wedge guard (`plugin_busy`).** The plugin runs on Figma's single main thread; a synchronous `run_script` loop freezes it and the bridge cannot preempt it. `PluginBridge.request` (`ws-server.ts`, `BUSY_THRESHOLD_MS = 5s`) checks for a prior request to the same plugin still outstanding past the threshold; if found it rejects new requests **instantly** with `plugin_busy: '<method>' has run <N>s … may be wedged` instead of letting each one burn a full 10s timeout (the cascade that hung the whole agent). Fast concurrent calls finish in ms and never trip it. Only a Figma tab reload recovers a truly wedged thread.
- **run_script forensics.** `mcp-server.ts` logs the **full** `code` arg of every `run_script` to `~/.grip-bridge.log` (bracketed `run_script[<sid>] code: … /code`), bypassing `summarizeArgs`' 40-char truncation, so a freeze can be diagnosed post-mortem. The tool description carries hard guardrails (chunk + `await`, no unbounded sync loops, prefer `findAllWithCriteria`/bounded reads, small payloads).
