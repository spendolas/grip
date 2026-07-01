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
  capabilities?: string[];
  fileKey: string;
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

// One MCP client session — either the stdio caller or one IPC proxy.
// Holds per-client routing state so concurrent agents don't trample
// each other's active file or subscription set.
export interface McpSession {
  id: string;
  activeFileId: string | null;
  // Remembered fileKey of the pinned file. Plugin iframes respawn every
  // 1–3min (new sessionId each time), so a sessionId pin dies on reconnect.
  // When activeFileId's session is gone, routing re-pins to the live
  // session with this fileKey — keeping the agent on the same FILE across
  // churn instead of silently falling to another open file's page.
  activeFileKey: string | null;
  subscriptions: { selection: boolean; document: boolean; currentPage: boolean };
  // Token-bucket rate limiter — refills at RATE_LIMIT_REFILL/sec, caps at
  // RATE_LIMIT_BURST. Tool calls cost 1 token. Stops an agent runaway
  // from saturating the single-threaded plugin.
  rateBucket: { tokens: number; lastRefillMs: number };
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
