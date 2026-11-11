// Single source of truth for the bridge version — imported by index.ts (status
// file / grip_health) and ws-server.ts (welcome frame + plugin-mismatch warning)
// so they can never drift. Keep in lockstep with bridge/package.json + the
// plugin's PLUGIN_VERSION on a release bump.
export const BRIDGE_VERSION = '0.9.3';

// The OLDEST Figma plugin version this bridge supports. The published plugin is
// updated through Figma, not by the bridge's self-updater, so an installed
// plugin can lag the bridge. The bridge refuses to signal or install an update
// to a bridge version that the connected plugins cannot talk to (see
// updateSignal in update.ts). Packaged into the release as compat.json by
// scripts/package-release.mjs — this line is the single source of truth.
// Raise it ONLY when a bridge release needs plugin features/protocol that older
// plugins lack, and publish the new plugin in Figma BEFORE cutting that release.
// 0.6.0: the first plugin with the `hello` contract (version + capabilities + fileKey).
// Plugins 0.6.x can lack newer methods: the bridge then returns a clear "older build"
// tool error for just those tools (mcp-server.ts), so everything else keeps working.
export const MIN_PLUGIN_VERSION = '0.6.0';

export interface WSRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface WSResponse {
  id: string;
  result?: unknown;
  error?: string;
}

export interface WSEvent {
  event: 'selectionchange' | 'documentchange' | 'currentpagechange';
  data: unknown;
}

export interface WSHello {
  kind: 'hello';
  version?: string;
  // The oldest bridge this plugin works with (informational; plugin 0.8.0+).
  minBridge?: string;
  capabilities?: string[];
  fileKey: string;
  // Per-file unique id from the plugin's document plugin data (capability fileUid;
  // absent when it cannot be written, e.g. view-only). It identifies a file only
  // when the file has no real fileKey (local/unsaved files all report the
  // placeholder "0:0"), and then together with the file name: a duplicate of a
  // file keeps its uid, so a uid is never trusted over a real key.
  fileUid?: string;
  fileName: string;
  currentPageId: string;
  currentPageName: string;
}

export type WSMessage = WSResponse | WSEvent | WSHello;

export interface PluginSessionInfo {
  sessionId: string;
  fileKey: string;
  fileName: string;
  currentPageId: string;
  currentPageName: string;
  active: boolean;
}

// One open Figma window (plugin session) inside a listed file.
export interface FileWindowInfo {
  sessionId: string;
  currentPageId: string;
  currentPageName: string;
  pluginVersion: string;
  // ms since this window's latest hello (newest window serves the file)
  helloAgoMs: number;
}

// One entry of list_files: one per FILE when the file has a stable identity
// (a real fileKey, else fileUid + name), one per WINDOW when it does not ("0:0").
// The first six fields are the pre-grouping PluginSessionInfo shape, taken
// from the newest live window, so older callers keep working.
export interface ListedFileInfo extends PluginSessionInfo {
  fileUid?: string;
  // false = this file reports no unique id (local or unsaved files report the
  // shared placeholder "0:0"), so it is listed once per window, never merged.
  stableKey: boolean;
  note?: string;
  windows: FileWindowInfo[];
  // How many OTHER agents are currently bound or pinned to this file.
  boundAgents: number;
}

// What an agent asked to be bound to (set_active_file / GRIP_FILE / ?file=).
// `key` is a real Figma fileKey (never the "0:0" placeholder), `uid` a
// plugin-reported fileUid, `name` an exact file name, `sessionId` one window
// (used only for files with no stable identity; falls back to `name` when that
// window goes away).
export interface FileBind {
  key?: string;
  uid?: string;
  name?: string;
  sessionId?: string;
}

// The binding state of one agent, as reported by list_files (myBinding),
// get_page_context and grip_health.
export interface BindingState {
  state: 'live' | 'waiting' | 'unbound';
  target?: FileBind;
  // the window calls route to right now (live, or unbound auto-routing)
  sessionId?: string;
  fileName?: string;
  // why a bound agent is waiting
  reason?: 'not_open' | 'ambiguous_name';
}

// One MCP client session — either the stdio caller or one IPC proxy.
// Holds per-client routing state so concurrent agents don't trample
// each other's active file or subscription set.
export interface McpSession {
  id: string;
  // Resolved live pin: the plugin session id this agent is routed to now.
  // Cleared and re-resolved from `bind` when that session dies (Figma
  // respawns plugin iframes every ~1–3min, new sessionId each time).
  activeFileId: string | null;
  // What file this agent WANTS — its durable binding, independent of how
  // many other files are open. Set by set_active_file (runtime) or a
  // GRIP_FILE / ?file= launch hint. `key` is a real Figma fileKey; `name` is
  // held until the file connects and resolves to a key (files with no stable
  // key stay bound by name or sessionId, never by the "0:0" placeholder).
  // null = unbound (auto-route only when exactly one file is open, else
  // ambiguous).
  bind: FileBind | null;
  subscriptions: { selection: boolean; document: boolean; currentPage: boolean };
  // Token-bucket rate limiter — refills at RATE_LIMIT_REFILL/sec, caps at
  // RATE_LIMIT_BURST. Tool calls cost 1 token. Stops an agent runaway
  // from saturating the single-threaded plugin.
  rateBucket: { tokens: number; lastRefillMs: number };
  // GRIP_TOOLS spec for this session (tool-scoping phase 1) — resolved via
  // resolveToolScope() in tools.ts. null = unset, which resolves to the
  // 'core' default. Set by later tasks (launch-time env / runtime tool);
  // this task only carries the field and defaults it on session creation.
  toolScopeSpec: string | null;
  // True once this session has been shown the "update available" notice on a
  // tool result (it is appended to the FIRST successful result only, once).
  updateNoticeSent: boolean;
  // True when the notice throttle (once per 3 days per version, across
  // sessions) was claimed for this session at creation, i.e. the session
  // `instructions` already carry the paragraph; the first tool result then
  // carries the matching notice.
  updateNoticeGranted?: boolean;
  // The 'help the user update the plugin/bridge' notices were handled for this session (shown or throttled).
  helpNoticeSent?: boolean;
  helpNoticesGranted?: string[];
}

export interface SerializedPaint {
  type: string;
  hex?: string;
  opacity: number;
  visible: boolean;
  stops?: Array<{ position: number; hex: string; opacity: number }>;
  imageHash?: string;
  scaleMode?: string;
  variableBinding?: { variableId: string; variableName: string };
}

export interface SerializedEffect {
  type: string;
  visible: boolean;
  radius?: number;
  spread?: number;
  offset?: { x: number; y: number };
  color?: { hex: string; opacity: number };
  blendMode?: string;
}

export interface SerializedNode {
  id: string;
  name: string;
  type: string;
  visible: boolean;
  locked: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  opacity: number;
  fills: SerializedPaint[];
  strokes: SerializedPaint[];
  strokeWeight?: number;
  effects: SerializedEffect[];
  cornerRadius?: number;
  layoutMode?: string;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  itemSpacing?: number;
  characters?: string;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: number;
  textAlignHorizontal?: string;
  lineHeight?: unknown;
  letterSpacing?: unknown;
  componentId?: string;
  componentName?: string;
  overrides?: unknown;
  children?: SerializedNode[] | SerializedNodeStub[];
  childCount?: number;
}

export interface SerializedNodeStub {
  id: string;
  name: string;
  type: string;
  childCount: number;
}

export interface SerializedStyle {
  id: string;
  name: string;
  description: string;
  type: 'PAINT' | 'TEXT' | 'EFFECT' | 'GRID';
  value: unknown;
}

export interface SerializedVariableCollection {
  id: string;
  name: string;
  modes: Array<{ modeId: string; name: string }>;
  variables: Array<{
    id: string;
    name: string;
    resolvedType: 'COLOR' | 'FLOAT' | 'STRING' | 'BOOLEAN';
    valuesByMode: Record<string, unknown>;
  }>;
}

export interface DocumentSummary {
  name: string;
  id: string;
  pages: Array<{ id: string; name: string; nodeCount: number }>;
  currentPageId: string;
}
