import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID as uuid } from 'node:crypto';
import { EventEmitter } from 'events';
import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  BindingState, FileBind, ListedFileInfo, McpSession, PluginSessionInfo, WSEvent, WSHello, WSResponse,
} from './types.js';
import { BRIDGE_VERSION } from './types.js';
import { compareSemver, isSemver } from './update.js';
import { isRetrySafe, causesEvents, serializedByPlugin } from './methods.js';

interface Pending {
  // The caller's request; settled through item.resolve / item.reject. Kept so
  // a plugin drop can re-send a read on the file's next session.
  item: QueuedRequest;
  timeout: NodeJS.Timeout;
  sessionId: string;
  session: Session;
  startedAt: number;
  method: string;
  mcpId: string;
  // This call's own timeout budget (10s default, longer for SLOW_METHOD_TIMEOUT_MS
  // or a run_script timeoutMs). The busy guard compares against it.
  budgetMs: number;
  // Free the in-flight slot (idempotent) and pump the queue.
  release: () => void;
  // Which in-flight lane it occupies (see Lane).
  lane: Lane;
}

// Flow-control lanes per plugin session. 'main': up to MAX_INFLIGHT_PER_PLUGIN
// calls at once (every call of a plugin without `serialMutations`; reads of one
// with it). 'write': a plugin advertising `serialMutations` runs mutating calls
// one at a time in its own queue, so the bridge keeps at most ONE of them in
// flight and holds the rest here, round-robin per MCP session. A write's budget
// timer then starts when the plugin can actually run it (not while it waits
// behind other writes inside the plugin), and writes never take read slots.
type Lane = 'main' | 'write';

// A request accepted by the bridge but not yet sent to the plugin. Held in a
// per-plugin queue, one FIFO per MCP session, drained round-robin across
// sessions so one agent's burst cannot starve another agent's single call.
// The caller's awaited promise is settled via resolve/reject when the request
// finally dispatches and completes.
interface QueuedRequest {
  method: string;
  params: Record<string, unknown>;
  mcpId: string;
  enqueuedAt: number;
  // The tool call this request belongs to (queuedMs / retryAfterMs metadata).
  ctx?: CallContext;
  // Already re-routed once after a plugin drop: never again.
  retried?: boolean;
  // Write lane only: fires if the call waits in the bridge queue longer than
  // MAX_WRITE_QUEUE_WAIT_MS (it is then rejected, never sent).
  waitTimer?: NodeJS.Timeout;
  // Write lane only: when the call first entered a write queue. Kept when it
  // moves to another window of the file, so the wait cap is never restarted.
  writeWaitSince?: number;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

interface PluginQueue {
  // mcpId -> that session's FIFO. Map order is the round-robin ring: pump takes
  // from the first entry and moves it to the back.
  bySession: Map<string, QueuedRequest[]>;
  total: number;
}

// A request that ran past its own budget with no reply. It stays here (wedge
// evidence for the busy guard) until any reply from that plugin proves its
// thread is alive, the plugin session drops, or OVERDUE_FORGET_MS passes.
interface Overdue {
  sessionId: string;
  method: string;
  startedAt: number;
  budgetMs: number;
  overdueAt: number;
}

// Per tool call, carried through AsyncLocalStorage from mcp-server.ts so the
// bridge can report how long the call waited in the queue and how long to wait
// before retrying, without changing request()'s signature.
export interface CallContext {
  queuedMs?: number;
  retryAfterMs?: number;
}
export const callContext = new AsyncLocalStorage<CallContext>();

// A typed error that carries a retry hint (also written into the message as
// `retryAfterMs=<n>` so it survives being turned into tool-result text).
function retryError(message: string, retryAfterMs: number): Error & { retryAfterMs: number } {
  const ms = Math.round(retryAfterMs);
  const e = new Error(`${message} retryAfterMs=${ms}`) as Error & { retryAfterMs: number };
  e.retryAfterMs = ms;
  return e;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

interface Session {
  id: string;
  ws: WebSocket;
  fileKey: string;
  // Plugin-reported per-file unique id (optional; see fileIdentity).
  fileUid?: string;
  fileName: string;
  currentPageId: string;
  currentPageName: string;
  pluginVersion?: string;
  // Oldest bridge the plugin says it works with (hello.minBridge, plugin 0.8.0+).
  minBridge?: string;
  capabilities?: string[];
  lastPong: number;
  pingTimer?: NodeJS.Timeout;
  // When this session's most recent hello arrived (0 = not helloed yet). The
  // plugin re-sends hello on every page switch, so this is "last active", not
  // "how new the window is": never use it to order windows.
  helloAt: number;
  // When this session FIRST said hello (never bumped), plus a tie-breaking
  // sequence number. Every "which window of a file is newer" decision uses
  // these (routing newest-wins, adoptQueued, the write lane, onTimeout's
  // reconnect check), so a page switch in an older window never makes it look
  // newer than the iframe that replaced it.
  firstHelloAt: number;
  helloSeq: number;
  // HTTP Origin header of the WS upgrade (undefined for non-browser clients).
  // Used only to refuse update requests coming from a web page.
  origin?: string;
  // Key of the last `update` frame sent to this session ('off' until the
  // strip has been told something). Lets us skip duplicate frames.
  updateSent?: string;
}

// Update state pushed to plugin strips (see update.ts / wireUpdateToBridge).
// `available` is the SIGNAL (update available AND compatible with every
// connected plugin), not the raw "a newer release exists".
export interface UpdateBroadcast { available: boolean; latest: string | null; current?: string; headline?: string | null; eligible?: (sessionId: string) => boolean }

// A Figma plugin iframe connects with Origin "null" (sandboxed) — or the
// figma.com origin. A normal web page connecting to ws://localhost:7777 sends
// its own https://... origin, and must not be able to trigger an update.
export function originAllowedForUpdate(origin: string | undefined): boolean {
  if (origin === undefined || origin === '' || origin === 'null') return true;
  try {
    const h = new URL(origin).hostname;
    return h === 'figma.com' || h.endsWith('.figma.com');
  } catch { return false; }
}

// The fileKey every file WITHOUT a real key reports: the plugin sends
// `figma.fileKey ?? figma.root.id`, and root.id is "0:0" in every file. It
// must never be treated as a file identity, or different local/unsaved files
// merge into one entry and routing flips between their windows.
export const PLACEHOLDER_FILE_KEY = '0:0';

// A fileKey that actually identifies one file (non-empty, not the placeholder).
export function isRealFileKey(key: string | undefined | null): key is string {
  return typeof key === 'string' && key !== '' && key !== PLACEHOLDER_FILE_KEY;
}

// The stable identity of the file a plugin session is showing:
//  - its real fileKey when it has one. A fileUid never overrides a real key:
//    the plugin re-mints a uid only when it recorded a real key for it, so a
//    uid minted while the key was still unknown is copied into every duplicate
//    of that file, and two DIFFERENT files can share one uid.
//  - for a key-less file ("0:0" or empty) that reports a fileUid: the uid plus
//    the file name. Two key-less windows that share a uid are one file only
//    when their names also match; a duplicate keeps the uid but gets another
//    name, so they are listed separately and nothing guesses between them.
//  - else undefined: the file cannot be told apart from other key-less files;
//    route/list/bind then treat each such WINDOW on its own.
export function fileIdentity(s: { fileUid?: string; fileKey?: string; fileName?: string }): string | undefined {
  if (isRealFileKey(s.fileKey)) return s.fileKey;
  if (typeof s.fileUid === 'string' && s.fileUid !== '') return `uid:${s.fileUid}:${s.fileName ?? ''}`;
  return undefined;
}

// How a file's identity is shown to agents (never the internal uid:name form).
function identityLabel(s: { fileUid?: string; fileKey?: string }): string | undefined {
  if (isRealFileKey(s.fileKey)) return s.fileKey;
  if (typeof s.fileUid === 'string' && s.fileUid !== '') return `file id ${s.fileUid}`;
  return undefined;
}

// One open file (sessions sharing a stable identity) or, for a file with no
// stable identity, one single window. `id` is the identity, or
// `window:<sessionId>` for an identity-less window.
interface FileEntry {
  id: string;
  identity?: string;
  name: string;
  newest: Session;
  sessions: Session[];
}
type FileMap = Map<string, FileEntry>;

// Result of matching a binding against the open windows (pure, no mutation).
type BindMatch =
  | { kind: 'one'; session: Session }
  | { kind: 'many'; candidates: FileEntry[] }          // a bound NAME matches >1 open file/window
  | { kind: 'none' };

// A plugin event as the bridge re-emits it: tagged with the plugin session and
// file it came from.
export type BridgeEvent = WSEvent & { sessionId: string; fileKey: string; fileName: string };


// Outcome of resolving which plugin session a request should route to.
// The non-ok cases are surfaced to the agent as in-band errors so a
// multi-file session can never silently read/write the wrong file.
type Routing =
  | { kind: 'ok'; session: Session }
  | { kind: 'none' }                                   // no plugin connected at all
  | { kind: 'ambiguous'; files: FileMap }              // >1 file/window open, no bind — agent must choose
  | { kind: 'ambiguous_name'; bind: FileBind; candidates: FileEntry[] } // bound name matches >1 file
  | { kind: 'deferred'; bind: FileBind; files: FileMap }; // bound file not open (yet)

// Default per-call budget; GRIP_REQUEST_TIMEOUT_MS exists for tests and tuning.
const REQUEST_TIMEOUT_MS = Number(process.env.GRIP_REQUEST_TIMEOUT_MS ?? 10_000);
// Some plugin ops are legitimately slow and must NOT be fast-failed as if
// wedged. A raster export (`exportAsync` → PNG/JPG/PDF) of a real frame on a
// big file routinely runs tens of seconds — SVG of a 72×72 node measured
// 7.5s on a large design-system file, so PNG tipped past the 10s default and
// got killed with `request_timeout`. Give known-heavy methods a generous
// ceiling. The plugin_busy guard below still rejects OTHER calls to the same
// plugin instantly once one has been outstanding past BUSY_THRESHOLD_MS, so a
// long-but-alive op cannot reopen the cascade-hang class. Override the export
// budget with GRIP_EXPORT_TIMEOUT_MS.
const EXPORT_TIMEOUT_MS = Number(process.env.GRIP_EXPORT_TIMEOUT_MS ?? 60_000);
// A file-wide library-usage scan walks the tree + resolves remote items; it
// chunks with yields so it never wedges, but the whole thing can still run
// tens of seconds on a large file. Same reasoning as export.
const SCAN_TIMEOUT_MS = Number(process.env.GRIP_SCAN_TIMEOUT_MS ?? 60_000);
// Whole-page operations under documentAccess:'dynamic-page' are O(page weight):
// setCurrentPageAsync loads+switches to the page, loadAllPagesAsync loads every
// page, and serializing a page walks it. On a heavy page these legitimately run
// far past the 10s fast-fail — the plugin isn't wedged, it's loading. Give them
// the same generous ceiling as export/scan so grip doesn't kill a live load.
const PAGE_TIMEOUT_MS = Number(process.env.GRIP_PAGE_TIMEOUT_MS ?? 60_000);
const SLOW_METHOD_TIMEOUT_MS: Record<string, number> = {
  export_node: EXPORT_TIMEOUT_MS,
  get_library_usage: SCAN_TIMEOUT_MS,
  create_component_set: SCAN_TIMEOUT_MS,   // up to 200 clones + a combine in one write
  map_nodes: SCAN_TIMEOUT_MS,   // bulk edit over many nodes; chunks+yields, but the whole run can be long
  set_current_page: PAGE_TIMEOUT_MS,
  get_document: PAGE_TIMEOUT_MS,   // loadAllPagesAsync across the file
  get_page: PAGE_TIMEOUT_MS,       // serialize a whole page tree
  search_nodes: PAGE_TIMEOUT_MS,   // allPages → loadAllPagesAsync; big page walks
  // A cross-page get_node/get_nodes forces getNodeByIdAsync to LOAD that page
  // first — heavy page = slow. (get_selection is current-page only, stays fast.)
  get_node: PAGE_TIMEOUT_MS,
  get_nodes: PAGE_TIMEOUT_MS,
};
// Busy guard. The plugin runs on Figma's single main thread; a synchronous
// run_script loop wedges it and CANNOT be preempted from here. Instead of
// letting every new call eat a full timeout behind a frozen thread (the cascade
// that hung whole agents), request() looks at what is already outstanding on
// that plugin (see busyCheck):
//   - an ordinary call (10s budget) outstanding past BUSY_THRESHOLD_MS, or a
//     call that waited behind it: new calls fail fast with the RETRYABLE
//     plugin_working (names the method, how long it has run, retryAfterMs);
//   - a call past its OWN budget with no reply (and no in-budget slow call to
//     explain it): plugin_busy, the thread is probably wedged;
//   - a known-slow call (export, page load, map_nodes, run_script timeoutMs...)
//     still inside its own longer budget is NOT evidence of anything: other
//     agents' calls go through as normal.
// Fast concurrent calls finish in ms and never cross any of this.
const BUSY_THRESHOLD_MS = Number(process.env.GRIP_BUSY_THRESHOLD_MS ?? 5_000);
// How long an unanswered past-budget call keeps counting as wedge evidence.
const OVERDUE_FORGET_MS = Number(process.env.GRIP_OVERDUE_FORGET_MS ?? 30_000);
// Flow control: the plugin runs on Figma's single main thread, so a flood of
// concurrent commands saturates it and wedges the window (only a panel reload
// recovers). The bridge meters requests per plugin — at most this many
// in-flight at once; the rest queue (transparent to the agent) and drain as
// responses return. This is the VOLUME guard (many fast ops); the busy guard
// above is the WEDGE guard (one op frozen). Override with env.
const MAX_INFLIGHT_PER_PLUGIN = Number(process.env.GRIP_MAX_INFLIGHT ?? 8);
// Hard backstop on the queue so a runaway agent can't build unbounded backlog
// (memory) — beyond this, shed load with a typed plugin_overloaded error.
const MAX_QUEUE_PER_PLUGIN = Number(process.env.GRIP_MAX_QUEUE ?? 500);
// Per MCP session share of one plugin's queue, so a single flooding agent
// cannot fill the global backstop and lock every other agent out.
const MAX_QUEUE_PER_SESSION = Number(process.env.GRIP_MAX_QUEUE_PER_SESSION ?? 125);
// Longest a mutating call may wait in the bridge's write lane (behind other
// writes to the same file) before it is rejected with plugin_working, never
// sent. Healthy writes take ms; this only bounds the wait behind a long write
// (map_nodes, run_script with a large timeoutMs).
const MAX_WRITE_QUEUE_WAIT_MS = Number(process.env.GRIP_MAX_WRITE_WAIT_MS ?? 60_000);
// How long a write that timed out on the bridge (and may still be running in
// the plugin) is remembered: the plugin releases a write that never settles
// after budget + 5s, at most 125s (MAX_MUTATION_HOLD_MS in code.ts).
const LOST_WRITE_FORGET_MS = 125_000;
// Following a renamed key-less file. Its identity is fileUid + name, so a
// rename changes it. A window that says hello under a new name is a rename for
// sure; otherwise, when the last window of a key-less file closes and a window
// of another key-less file with the same fileUid first appears within this long
// of it (either order), that is Figma respawning the plugin iframe after a
// rename. A copy (same uid, other name) that was open long before, or opened
// long after, is never taken for the renamed file.
const RESPAWN_MATCH_MS = Number(process.env.GRIP_RESPAWN_MATCH_MS ?? 15_000);
// How long a rename / close is remembered (bounded: at most RENAME_MEMORY_MAX).
const RENAME_MEMORY_MS = 24 * 60 * 60_000;
const RENAME_MEMORY_MAX = 200;
// A tool call that waited at least this long in the queue reports it in the
// tool result's _meta (grip/queuedMs). Every queued wait is logged.
export const QUEUED_NOTE_MS = 2_000;
// An event that arrives this soon after an event-causing call settled is still
// attributed to it (the plugin debounces documentchange by 500ms).
const CAUSE_ECHO_MS = 1_500;
// Latency estimate before any reply has been measured (ms).
const DEFAULT_LATENCY_MS = 250;
const HEARTBEAT_INTERVAL_MS = 5_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;        // miss two pings → declare plugin dead
// Reject plugin responses larger than this — a payload this big means an
// unbounded serialize (old plugin / no maxNodes) and ferrying it stalls
// the agent. 8 MB clears legit PNG/PDF exports while catching runaway
// node trees. Override with GRIP_RESPONSE_CAP_BYTES.
const RESPONSE_SOFT_CAP_BYTES = Number(process.env.GRIP_RESPONSE_CAP_BYTES ?? 8 * 1024 * 1024);
// A far LOWER cap for READ results. The 8MB guard is an OOM backstop; it sails
// right past the MCP client's result-token budget (a 219KB get_node overflowed
// a client while being nowhere near 8MB). Worse, an oversized read isn't just
// an error — it's context the client re-sends every turn, billed for the whole
// session. So refuse a too-large read EARLY with an actionable, read-specific
// message (narrow with `properties`/`depth`, or dump to disk). Override with
// GRIP_READ_CAP_BYTES. Only applies to the read methods below.
const READ_SOFT_CAP_BYTES = Number(process.env.GRIP_READ_CAP_BYTES ?? 120 * 1024);
const READ_METHODS = new Set(['get_node', 'get_nodes', 'get_page', 'get_selection', 'get_document']);

export class PluginBridge extends EventEmitter {
  private wss: WebSocketServer;
  private sessions = new Map<string, Session>();
  private pending = new Map<string, Pending>();
  // Flow control (per plugin sessionId): count of requests sent-and-awaiting,
  // and the FIFO backlog of requests waiting for an in-flight slot.
  private inflight = new Map<string, number>();
  private queues = new Map<string, PluginQueue>();
  // The same two, for the write lane of `serialMutations` plugins (see Lane).
  private writeInflight = new Map<string, number>();
  private writeQueues = new Map<string, PluginQueue>();
  // Busy guard: calls that ran past their budget without a reply (by request id).
  private overdue = new Map<string, Overdue>();
  // Recent reply latency per plugin session (EWMA, ms), for retryAfterMs.
  private latency = new Map<string, number>();
  // Event-causing calls that settled recently, per plugin session, so an event
  // that arrives just after (debounced documentchange) is still attributed.
  private recentCauses = new Map<string, Array<{ mcpId: string; at: number }>>();
  // Streamed run_script log() lines, buffered per request id so a timed-out
  // script's partial logs can be attached to the error (the completing-late
  // response is discarded). Cleared when the request settles.
  private scriptLogs = new Map<string, string[]>();
  // Write-lane calls that ran past their budget on the bridge with no reply
  // yet (by request id): the plugin is still running them, so a later write to
  // that window waits behind it inside the plugin. Cleared by the late reply,
  // the window dropping, or LOST_WRITE_FORGET_MS.
  private lostWrites = new Map<string, { sessionId: string; method: string; startedAt: number; at: number }>();
  // The MCP sessions this bridge has routed for (weakly held), so a window's
  // hello can refresh the file name stored in the bindings pinned to it.
  private mcpRefs = new Map<string, WeakRef<McpSession>>();
  // Key-less files seen renamed: old identity -> new identity (see
  // RESPAWN_MATCH_MS), and when the last window of a key-less file closed.
  private renamed = new Map<string, { to: string; at: number }>();
  private closedFiles = new Map<string, { uid: string; name: string; at: number }>();
  private static helloCounter = 0;

  constructor(port: number) {
    super();
    // 10 MB cap — accommodates large export payloads but bounds OOM risk
    // from a misbehaving peer / runaway run_script result.
    this.wss = new WebSocketServer({ port, maxPayload: 10 * 1024 * 1024 });

    this.wss.on('connection', (ws, req) => {
      const id = uuid();
      const session: Session = {
        id,
        ws,
        fileKey: '',
        fileName: '',
        currentPageId: '',
        currentPageName: '',
        lastPong: Date.now(),
        helloAt: 0,
        firstHelloAt: 0,
        helloSeq: 0,
        origin: typeof req?.headers?.origin === 'string' ? req.headers.origin : undefined,
      };
      this.sessions.set(id, session);
      // Hand the plugin its session id; plugin replies with a hello
      // carrying file metadata.
      ws.send(JSON.stringify({ kind: 'welcome', sessionId: id, bridgeVersion: BRIDGE_VERSION }));
      process.stderr.write(`[grip] session ${id.slice(0, 8)} opened (${this.sessions.size} total)\n`);

      // Heartbeat. Figma Desktop terminates plugin iframes every ~1–3min
      // regardless of WS activity (as of mid-2026). Without a heartbeat
      // the bridge thinks the plugin is alive and stalls inflight
      // requests until our 10s timeout. With it, we detect a dead peer
      // within 10s and reject pending with plugin_disconnected.
      const pingTimer = setInterval(() => {
        const s = this.sessions.get(id);
        if (!s) { clearInterval(pingTimer); return; }
        if (Date.now() - s.lastPong > HEARTBEAT_TIMEOUT_MS) {
          process.stderr.write(`[grip] session ${id.slice(0, 8)} heartbeat timeout, terminating\n`);
          try { s.ws.terminate(); } catch {}
          return;
        }
        try { s.ws.ping(); } catch {}
      }, HEARTBEAT_INTERVAL_MS);
      pingTimer.unref();
      session.pingTimer = pingTimer;

      ws.on('pong', () => {
        const s = this.sessions.get(id);
        if (s) s.lastPong = Date.now();
      });
      // Any inbound message also counts as liveness — saves a roundtrip
      // when plugin is actively sending data.
      ws.on('message', (raw) => {
        const s = this.sessions.get(id);
        if (s) s.lastPong = Date.now();
        this.handleMessage(id, raw.toString());
      });
      ws.on('close', () => this.dropSession(id));
      ws.on('error', (err) => {
        process.stderr.write(`[grip] ws error (${id.slice(0, 8)}): ${err.message}\n`);
      });
    });

    this.wss.on('listening', () => {
      process.stderr.write(`[grip] ws server listening on :${port}\n`);
      this.emit('listening');
    });
    this.wss.on('error', (err: Error & { code?: string }) => {
      this.emit('bind-error', err);
    });
  }

  // ---------- session management ----------

  // One entry per open FILE (grouped by stable identity), or per WINDOW for
  // files with no stable identity. Only helloed, open sessions are listed
  // (half-connected sockets are counted in fileListing().connecting).
  // `others` = the OTHER MCP sessions, used only to count boundAgents.
  list(mcp: McpSession, others: McpSession[] = []): ListedFileInfo[] {
    const activeId = this.resolveActiveId(mcp);
    const counts = this.boundCounts(others);
    return [...this.distinctOpenFiles().values()].map((e) => this.fileInfo(e, activeId, counts));
  }

  // Everything list_files returns.
  fileListing(mcp: McpSession, others: McpSession[] = []): {
    files: ListedFileInfo[];
    myBinding: BindingState;
    connecting: number;
  } {
    let connecting = 0;
    for (const s of this.sessions.values()) if (!PluginBridge.isLive(s) && s.ws.readyState === WebSocket.OPEN) connecting++;
    return { files: this.list(mcp, others), myBinding: this.bindingState(mcp), connecting };
  }

  // This agent's binding, truthfully: live (routes now), waiting (bound but
  // the file is not open, or the bound name matches several files) or
  // unbound (sessionId set when single-file auto-routing would route).
  bindingState(mcp: McpSession): BindingState {
    this.track(mcp);
    const r = this.route(mcp);
    if (!mcp.bind) {
      return r.kind === 'ok'
        ? { state: 'unbound', sessionId: r.session.id, fileName: r.session.fileName }
        : { state: 'unbound' };
    }
    const target = { ...mcp.bind };
    if (r.kind === 'ok') return { state: 'live', target, sessionId: r.session.id, fileName: r.session.fileName };
    return { state: 'waiting', target, reason: r.kind === 'ambiguous_name' ? 'ambiguous_name' : 'not_open' };
  }

  // Bind an agent to a file by fileKey, exact file name, sessionId, or a
  // figma.com URL. Binds even if the file isn't open yet (deferred) so a
  // launcher/agent can declare intent ahead of the plugin connecting; the
  // binding survives reconnect churn and ignores every other open file.
  // A file with no stable identity ("0:0") is bound by name or by sessionId,
  // never by the placeholder key.
  setActive(target: string, mcp: McpSession, others: McpSession[] = []): {
    bound: true;
    resolved: boolean;
    target: FileBind;
    file?: ListedFileInfo;
    reason?: 'not_open' | 'ambiguous_name';
    open?: ListedFileInfo[];
    candidates?: Array<{ fileName: string; fileKey: string; sessionId: string }>;
    warnings?: string[];
  } {
    const bind = this.resolveBind(target); // may throw ambiguous_file_name / not_a_file_key
    this.track(mcp);
    mcp.bind = bind;
    mcp.activeFileId = null; // force re-resolve against the new bind
    const r = this.route(mcp);
    if (r.kind === 'ok') {
      const match = r.session;
      process.stderr.write(`[grip] mcp ${mcp.id.slice(0, 8)} bound → ${match.fileName} (${identityLabel(match) ?? 'window ' + match.id.slice(0, 8)})\n`);
      const counts = this.boundCounts(others);
      const entry = this.entryOf(match);
      const file = this.fileInfo(entry, match.id, counts);
      const res: ReturnType<PluginBridge['setActive']> = { bound: true, resolved: true, target: bind, file };
      if (file.boundAgents > 0) {
        res.warnings = [
          `${file.boundAgents} other agent${file.boundAgents === 1 ? ' is' : 's are'} already bound to "${file.fileName}". ` +
            `Your edits can collide with theirs: agree on separate frames/pages, or work in a different file.`,
        ];
      }
      return res;
    }
    if (r.kind === 'ambiguous_name') {
      return {
        bound: true, resolved: false, reason: 'ambiguous_name', target: bind,
        candidates: this.candidateList(r.candidates), open: this.list(mcp, others),
      };
    }
    // Not open yet — hold the binding (deferred). Return the open files so a
    // typo is caught immediately while a genuine cold-start file resolves
    // when it connects.
    const label = bind.key ?? bind.uid ?? bind.name ?? bind.sessionId ?? target;
    process.stderr.write(`[grip] mcp ${mcp.id.slice(0, 8)} bound → ${label} (deferred, not open)\n`);
    const res: ReturnType<PluginBridge['setActive']> = { bound: true, resolved: false, reason: 'not_open', target: bind, open: this.list(mcp, others) };
    const sameTarget = others.filter((o) => o.bind && ((bind.key && o.bind.key === bind.key) || (bind.uid && o.bind.uid === bind.uid))).length;
    if (sameTarget > 0) {
      res.warnings = [`${sameTarget} other agent${sameTarget === 1 ? ' is' : 's are'} already bound to this file. Your edits can collide with theirs once it opens.`];
    }
    return res;
  }

  private fileInfo(e: FileEntry, activeId: string | null, counts: Map<string, number>): ListedFileInfo {
    const s = e.newest;
    const now = Date.now();
    const info: ListedFileInfo = {
      sessionId: s.id,
      fileKey: s.fileKey,
      fileName: s.fileName,
      currentPageId: s.currentPageId,
      currentPageName: s.currentPageName,
      active: activeId !== null && e.sessions.some((x) => x.id === activeId),
      ...(s.fileUid ? { fileUid: s.fileUid } : {}),
      stableKey: e.identity !== undefined,
      windows: e.sessions.map((x) => ({
        sessionId: x.id,
        currentPageId: x.currentPageId,
        currentPageName: x.currentPageName,
        pluginVersion: x.pluginVersion ?? 'unknown',
        helloAgoMs: now - x.helloAt,
      })),
      boundAgents: counts.get(e.id) ?? 0,
    };
    if (e.identity === undefined) {
      info.note = 'This file has no stable file key (local or unsaved files all report "0:0"), so each window is listed on its own. Bind it by name or by this sessionId.';
    }
    return info;
  }

  // Entry id of each file other agents are bound/pinned to → how many agents.
  // Pure: never moves another agent's pin.
  private boundCounts(others: McpSession[]): Map<string, number> {
    const m = new Map<string, number>();
    for (const o of others) {
      if (!o.bind) continue;
      let s: Session | null = null;
      if (o.activeFileId) {
        const p = this.sessions.get(o.activeFileId);
        if (p && PluginBridge.isLive(p)) s = p;
      }
      if (!s) {
        const r = this.matchBind(o.bind);
        if (r.kind === 'one') s = r.session;
      }
      if (!s) continue;
      const id = this.entryId(s);
      m.set(id, (m.get(id) ?? 0) + 1);
    }
    return m;
  }

  // ---------- request routing ----------

  // Cold-start grace: when an MCP client spawns the bridge, the plugin
  // needs ~1–2s to (re)connect via its WebSocket backoff. Without this
  // wait, the very first tool call after idle hits "No plugin connected"
  // and agents have to learn to retry. This soaks the lag instead.
  private static readonly PLUGIN_WAIT_MS = 3_000;

  private waitForPlugin(mcp: McpSession, timeoutMs: number): Promise<Session | null> {
    const immediate = this.activeSession(mcp);
    if (immediate) return Promise.resolve(immediate);
    return new Promise((resolve) => {
      const onChange = () => {
        const s = this.activeSession(mcp);
        if (!s) return;
        cleanup();
        resolve(s);
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(null);
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off('session-change', onChange);
      };
      this.on('session-change', onChange);
    });
  }

  // Wait for any plugin (file-agnostic) — used by list_files so an agent's
  // first discovery call doesn't return empty during cold-start.
  waitForAnyPlugin(timeoutMs: number): Promise<boolean> {
    if (this.hasReadyPlugin()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const onChange = () => {
        if (!this.hasReadyPlugin()) return;
        cleanup();
        resolve(true);
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off('session-change', onChange);
      };
      this.on('session-change', onChange);
    });
  }

  private hasReadyPlugin(): boolean {
    for (const s of this.sessions.values()) {
      if (PluginBridge.isLive(s)) return true;
    }
    return false;
  }

  async request(method: string, params: Record<string, unknown>, mcp: McpSession): Promise<unknown> {
    this.track(mcp);
    let session = this.activeSession(mcp);
    if (!session) {
      // Not routable right now. Distinguish WHY so the agent gets an
      // actionable, in-band error instead of a silently-wrong file.
      const r = this.route(mcp);
      if (r.kind === 'ambiguous') throw this.ambiguousError(r.files);
      if (r.kind === 'ambiguous_name') throw this.ambiguousNameError(r.bind, r.candidates);
      // 'none' (cold start) or 'deferred' (bound file mid-respawn / just
      // opening) may resolve once a plugin (re)connects — soak the reconnect
      // grace, then re-check. waitForPlugin re-runs route() on every hello,
      // so the instant the bound file connects it routes.
      session = await this.waitForPlugin(mcp, PluginBridge.PLUGIN_WAIT_MS);
      if (!session) {
        const r2 = this.route(mcp);
        if (r2.kind === 'ambiguous') throw this.ambiguousError(r2.files);
        if (r2.kind === 'ambiguous_name') throw this.ambiguousNameError(r2.bind, r2.candidates);
        if (r2.kind === 'deferred') throw this.deferredError(r2.bind, r2.files);
        throw new Error('plugin_disconnected: No plugin connected');
      }
    }
    // Busy guard (see BUSY_THRESHOLD_MS): fail fast instead of piling 10s
    // timeouts behind a thread that is stuck or busy with someone's slow call.
    const busy = this.busyCheck(session.id, method);
    if (busy) {
      const ctx = callContext.getStore();
      if (ctx) ctx.retryAfterMs = busy.retryAfterMs;
      throw busy;
    }
    // Flow control. If the plugin already has the max requests in flight,
    // QUEUE this one (transparent to the agent, it just awaits a little
    // longer) instead of piling onto the single-threaded plugin. Each MCP
    // session has its own FIFO per plugin and pump() serves them round-robin.
    // A pathologically deep queue is shed with a typed error so a runaway agent
    // can't OOM the daemon or lock other agents out.
    const sess = session;
    return new Promise((resolve, reject) => {
      const item: QueuedRequest = {
        method, params, mcpId: mcp.id, enqueuedAt: Date.now(), ctx: callContext.getStore(), resolve, reject,
      };
      const sid = sess.id;
      const lane = this.laneOf(sess, method);
      const L = this.laneState(lane);
      const pq = L.queues.get(sid);
      // The write lane is per FILE: while an older window of this file still
      // has a write in flight (reconnect overlap), this one waits its turn.
      if ((L.inflight.get(sid) ?? 0) < L.cap && !(pq && pq.total > 0) && !(lane === 'write' && this.writeHeldElsewhere(sess))) {
        this.dispatch(sess, item, lane);
        return;
      }
      const shed = this.overloadCheck(sid, mcp.id, method);
      if (shed) {
        if (item.ctx) item.ctx.retryAfterMs = shed.retryAfterMs;
        reject(shed);
        return;
      }
      this.enqueue(sid, item);
      this.pump(sid);
    });
  }

  // Which lane a call to this plugin session takes (see Lane).
  private laneOf(sess: Session | undefined, method: string): Lane {
    return sess?.capabilities?.includes('serialMutations') && serializedByPlugin(method) ? 'write' : 'main';
  }

  private laneState(lane: Lane): { inflight: Map<string, number>; queues: Map<string, PluginQueue>; cap: number } {
    return lane === 'write'
      ? { inflight: this.writeInflight, queues: this.writeQueues, cap: 1 }
      : { inflight: this.inflight, queues: this.queues, cap: MAX_INFLIGHT_PER_PLUGIN };
  }

  // This call's timeout budget. run_script may opt into a larger budget for a
  // known-heavy script (capped); the default stays the fast-fail 10s so a wedge
  // is caught quickly.
  private budgetFor(method: string, params: Record<string, unknown>): number {
    let timeoutMs = SLOW_METHOD_TIMEOUT_MS[method] ?? REQUEST_TIMEOUT_MS;
    if (method === 'run_script' && typeof (params as any).timeoutMs === 'number') {
      timeoutMs = Math.min(Math.max((params as any).timeoutMs, 1000), 120_000);
    }
    return timeoutMs;
  }

  // The oldest in-flight call on this plugin with a long (slow-method) budget
  // that was sent at or before `sentAt`: a call queued behind it on the
  // plugin's single thread is explained by it, not by a wedge.
  private slowHolder(sid: string, sentAt: number, exceptId?: string): Pending | undefined {
    let best: Pending | undefined;
    for (const [id, p] of this.pending) {
      if (id === exceptId || p.sessionId !== sid || p.budgetMs <= REQUEST_TIMEOUT_MS || p.startedAt > sentAt) continue;
      if (!best || p.startedAt < best.startedAt) best = p;
    }
    return best;
  }

  // Busy guard decision for a new call to plugin `sid` (null = go ahead).
  private busyCheck(sid: string, method: string): (Error & { retryAfterMs: number }) | null {
    const now = Date.now();
    // 1. Wedge evidence: a call past its own budget with no reply, that no
    //    in-budget slow call explains.
    let wedged: Overdue | undefined;
    for (const [id, o] of this.overdue) {
      if (now - o.overdueAt > OVERDUE_FORGET_MS) { this.overdue.delete(id); continue; }
      if (o.sessionId !== sid || this.slowHolder(sid, o.startedAt)) continue;
      if (!wedged || o.startedAt < wedged.startedAt) wedged = o;
    }
    if (wedged) {
      const ranS = ((now - wedged.startedAt) / 1000).toFixed(1);
      return retryError(
        `plugin_busy: '${wedged.method}' has run ${ranS}s on the Figma plugin's main thread, past its ` +
          `${wedged.budgetMs / 1000}s budget, with no reply. The thread is probably wedged (for example a synchronous ` +
          `run_script loop). Rejecting '${method}' fast. If calls keep failing like this after retryAfterMs, the Figma ` +
          `tab must be reloaded to recover.`,
        clamp(OVERDUE_FORGET_MS - (now - wedged.overdueAt), 1_000, 30_000),
      );
    }
    // 2. An ordinary (10s budget) call outstanding past the threshold: the
    //    plugin is busy, not (yet) wedged. Name what is holding it. Only calls
    //    in the SAME lane count: on a `serialMutations` plugin reads never wait
    //    behind a write (and a write never waits behind a read), so a long write
    //    is not a reason to turn reads away, nor the other way round.
    const lane = this.laneOf(this.sessions.get(sid), method);
    let stuck: Pending | undefined;
    for (const p of this.pending.values()) {
      if (p.sessionId !== sid || p.lane !== lane || p.budgetMs > REQUEST_TIMEOUT_MS || now - p.startedAt < BUSY_THRESHOLD_MS) continue;
      if (!stuck || p.startedAt < stuck.startedAt) stuck = p;
    }
    if (stuck) {
      const holder = this.slowHolder(sid, stuck.startedAt) ?? stuck;
      const ranS = ((now - holder.startedAt) / 1000).toFixed(1);
      return retryError(
        `plugin_working: the Figma plugin is busy with '${holder.method}' (running ${ranS}s of its ` +
          `${holder.budgetMs / 1000}s budget) and calls behind it are waiting. '${method}' was not sent. ` +
          `Retry after retryAfterMs; nothing was changed.`,
        clamp(holder.startedAt + holder.budgetMs - now, 500, 10_000),
      );
    }
    // 3. A slow call inside its own budget is normal work: let this one through.
    return null;
  }

  // Rough wait estimate for `depth` queued calls on plugin `sid` (bounded).
  private retryAfterFor(sid: string, depth: number): number {
    const lat = this.latency.get(sid) ?? DEFAULT_LATENCY_MS;
    return clamp(Math.ceil((depth + 1) / MAX_INFLIGHT_PER_PLUGIN) * lat, 250, 30_000);
  }

  private overloadCheck(sid: string, mcpId: string, method: string): (Error & { retryAfterMs: number }) | null {
    // Both lanes share the backstops.
    let total = 0, mine = 0;
    for (const pq of [this.queues.get(sid), this.writeQueues.get(sid)]) {
      total += pq?.total ?? 0;
      mine += pq?.bySession.get(mcpId)?.length ?? 0;
    }
    if (total >= MAX_QUEUE_PER_PLUGIN) {
      return retryError(
        `plugin_overloaded: ${total} requests already queued for this plugin (max ${MAX_QUEUE_PER_PLUGIN}); ` +
          `shedding '${method}', nothing was sent. The plugin can't keep up: reduce concurrent calls or space them out.`,
        this.retryAfterFor(sid, total),
      );
    }
    if (mine >= MAX_QUEUE_PER_SESSION) {
      return retryError(
        `plugin_overloaded: this agent already has ${mine} requests queued for this plugin (max ${MAX_QUEUE_PER_SESSION} ` +
          `per agent); shedding '${method}', nothing was sent. Wait for earlier calls to finish, or batch the work ` +
          `(map_nodes, run_script).`,
        this.retryAfterFor(sid, total),
      );
    }
    return null;
  }

  // Append (or, for re-homed requests, prepend) to the caller's FIFO in the
  // lane the call takes on that plugin session.
  private enqueue(sid: string, item: QueuedRequest, front = false): void {
    const lane = this.laneOf(this.sessions.get(sid), item.method);
    const queues = this.laneState(lane).queues;
    let pq = queues.get(sid);
    if (!pq) { pq = { bySession: new Map(), total: 0 }; queues.set(sid, pq); }
    let q = pq.bySession.get(item.mcpId);
    if (!q) { q = []; pq.bySession.set(item.mcpId, q); }
    if (front) q.unshift(item); else q.push(item);
    pq.total++;
    if (item.waitTimer) { clearTimeout(item.waitTimer); item.waitTimer = undefined; }
    if (lane === 'write') {
      // The cap counts from when the call FIRST entered a write queue: moving
      // it to a newer window of the file must not restart the clock.
      if (item.writeWaitSince === undefined) item.writeWaitSince = Date.now();
      const left = Math.max(0, MAX_WRITE_QUEUE_WAIT_MS - (Date.now() - item.writeWaitSince));
      item.waitTimer = setTimeout(() => this.onWriteWaitTimeout(sid, item), left);
      item.waitTimer.unref?.();
    }
  }

  // A write waited in the bridge's write lane past MAX_WRITE_QUEUE_WAIT_MS:
  // take it out and reject it. It was never sent, so nothing changed.
  private onWriteWaitTimeout(sid: string, item: QueuedRequest): void {
    item.waitTimer = undefined;
    const pq = this.writeQueues.get(sid);
    const q = pq?.bySession.get(item.mcpId);
    const i = q ? q.indexOf(item) : -1;
    if (!pq || !q || i < 0) return;
    q.splice(i, 1);
    pq.total--;
    if (!q.length) pq.bySession.delete(item.mcpId);
    if (pq.total === 0) this.writeQueues.delete(sid);
    const now = Date.now();
    let holder: Pending | undefined;
    const sess = this.sessions.get(sid);
    const ident = sess ? fileIdentity(sess) : undefined;
    for (const p of this.pending.values()) {
      if (p.lane === 'write' && (p.sessionId === sid || (ident !== undefined && fileIdentity(p.session) === ident))) holder = p;
    }
    const what = holder
      ? `'${holder.method}' (running ${((now - holder.startedAt) / 1000).toFixed(1)}s of its ${holder.budgetMs / 1000}s budget)`
      : 'earlier changes';
    const retryAfterMs = holder ? clamp(holder.startedAt + holder.budgetMs - now, 500, 10_000) : 1_000;
    if (item.ctx) item.ctx.retryAfterMs = Math.round(retryAfterMs);
    item.reject(retryError(
      `plugin_working: '${item.method}' waited ${((now - (item.writeWaitSince ?? item.enqueuedAt)) / 1000).toFixed(1)}s for its turn behind ` +
        `${what} on this file and was NOT sent, so nothing was changed. Retry after retryAfterMs.`,
      retryAfterMs,
    ));
  }

  // Send one request to the plugin now, tracking it as in-flight; on settle
  // (response / timeout / disconnect) free the slot and pump the queue.
  private dispatch(session: Session, item: QueuedRequest, lane: Lane): void {
    const sid = session.id;
    const id = uuid();
    const { method, params } = item;
    if (item.waitTimer) { clearTimeout(item.waitTimer); item.waitTimer = undefined; }
    const timeoutMs = this.budgetFor(method, params);
    const now = Date.now();
    const queuedMs = now - item.enqueuedAt;
    if (queuedMs > 0 && item.ctx) item.ctx.queuedMs = Math.max(item.ctx.queuedMs ?? 0, queuedMs);
    const inflight = this.laneState(lane).inflight;
    inflight.set(sid, (inflight.get(sid) ?? 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      inflight.set(sid, Math.max(0, (inflight.get(sid) ?? 1) - 1));
      this.scriptLogs.delete(id);   // clear buffered logs on any settle
      if (causesEvents(method)) {
        const list = (this.recentCauses.get(sid) ?? []).filter((r) => Date.now() - r.at <= CAUSE_ECHO_MS);
        list.push({ mcpId: item.mcpId, at: Date.now() });
        this.recentCauses.set(sid, list.slice(-20));
      }
      // Also wakes the other windows of the file: a write held there because
      // this window had one in flight (per-file write lane) can go now.
      this.pumpFile(session);
    };
    const timeout = setTimeout(() => this.onTimeout(id), timeoutMs);
    this.pending.set(id, {
      item, timeout, sessionId: sid, session, startedAt: now, method, mcpId: item.mcpId, budgetMs: timeoutMs, release, lane,
    });
    // timeoutMs: this call's budget, counted from now. The plugin uses it to skip
    // a write that would only start after the bridge has already given up on it.
    session.ws.send(JSON.stringify({ id, method, params, timeoutMs }));
  }

  private onTimeout(id: string): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    const { session, method, item, budgetMs } = p;
    // Distinguish reconnect churn from a genuine timeout. If a NEWER live
    // session now serves this file, the plugin iframe reconnected during the
    // call (new sessionId) and we were talking to a zombie. That's not a wedge,
    // and the fix is NOT "reload the Figma tab". It must be newer (later
    // hello): an older second window of the same file says nothing about this
    // one, so a genuine wedge there is still reported as one.
    const ident = fileIdentity(session);
    const fresh = ident
      ? this.newestLive((s) => fileIdentity(s) === ident && s.id !== session.id && PluginBridge.isNewer(s, session))
      : null;
    if (fresh) {
      p.release();
      if (isRetrySafe(method) && !item.retried) {
        item.retried = true;
        process.stderr.write(`[grip] '${method}' lost to a reconnect of "${session.fileName}", re-sending once on ${fresh.id.slice(0, 8)}\n`);
        this.enqueue(fresh.id, item, true);
        this.pump(fresh.id);
        return;
      }
      item.reject(isRetrySafe(method)
        ? new Error(
            `plugin_reconnected: the Figma plugin for "${session.fileName}" reconnected during '${method}' ` +
              `(new session id) and the bridge already re-sent it once. It only reads, so it is safe to call again. ` +
              `For stability across Figma's periodic reconnects, pin the file with set_active_file.`,
          )
        : this.maybeAppliedError(method, session, 'reconnected (new session id) after'));
      return;
    }
    // Genuine timeout: keep it as wedge evidence until the plugin answers
    // anything again (see busyCheck).
    this.overdue.set(id, { sessionId: session.id, method, startedAt: p.startedAt, budgetMs, overdueAt: Date.now() });
    // A write sent while an EARLIER write that the bridge already gave up on
    // was still running in the plugin (no late reply yet) has been waiting in
    // the plugin's own queue all along: it never started, and the plugin skips
    // it (plugin_queue_timeout) once it gets its turn.
    let behindLost: { method: string } | undefined;
    if (p.lane === 'write') {
      const now = Date.now();
      for (const [lid, l] of this.lostWrites) {
        if (now - l.at > LOST_WRITE_FORGET_MS) { this.lostWrites.delete(lid); continue; }
        if (l.sessionId === session.id && l.startedAt < p.startedAt) behindLost = l;
      }
      this.lostWrites.set(id, { sessionId: session.id, method, startedAt: p.startedAt, at: now });
    }
    const holder = this.slowHolder(session.id, p.startedAt, id);
    const mutating = !isRetrySafe(method);
    // Surface the script's own log() lines captured before the deadline:
    // turns "something may have happened" into "here's how far it got".
    const streamed = this.scriptLogs.get(id);
    const partialLogs = streamed && streamed.length
      ? ` Partial logs before timeout (${streamed.length}): ${streamed.slice(-15).join(' | ')}`
      : '';
    p.release();
    if (holder) {
      // It waited behind someone's slow call on the single-threaded plugin.
      const ranS = ((Date.now() - holder.startedAt) / 1000).toFixed(1);
      const retryAfterMs = clamp(holder.startedAt + holder.budgetMs - Date.now(), 500, 10_000);
      if (item.ctx) item.ctx.retryAfterMs = Math.round(retryAfterMs);
      item.reject(retryError(
        `plugin_working: '${method}' got no reply within ${budgetMs / 1000}s because the Figma plugin is busy with ` +
          `'${holder.method}' (running ${ranS}s of its ${holder.budgetMs / 1000}s budget). ` +
          (mutating
            ? `The plugin may still apply '${method}' once it gets to it: re-read before retrying (a blind retry can apply it twice).`
            : `It only reads, so it is safe to retry after retryAfterMs.`),
        retryAfterMs,
      ));
      return;
    }
    // A mutating call that times out may still be applied (the plugin keeps
    // running after we give up); a run_script has almost certainly applied SOME
    // of its changes. Warn so the agent re-reads instead of double-applying.
    if (behindLost) {
      item.reject(new Error(
        `request_timeout: '${method}' exceeded ${budgetMs / 1000}s while an earlier change ('${behindLost.method}', which had ` +
          `already timed out) was still running in the Figma plugin. '${method}' waited behind it inside the plugin and was ` +
          `probably never started: the plugin skips a change whose time ran out while it waited (plugin_queue_timeout). ` +
          `So it was most likely NOT applied, but re-read before retrying (a blind retry could apply it twice).${partialLogs}`,
      ));
      return;
    }
    const partial = method === 'run_script'
      ? ` A run_script may have PARTIALLY changed the document before timing out: re-read state before retrying (a blind retry can double-apply). For a known-heavy script pass a larger timeoutMs (max 120s).`
      : mutating
        ? ` Treat it as maybe_applied: the plugin may have started it before the deadline and cannot abort it, so it may still be applied after this error. Re-read before retrying (a blind retry can apply it twice).`
        : '';
    item.reject(new Error(`request_timeout: '${method}' exceeded ${budgetMs / 1000}s.${partial}${partialLogs}`));
  }

  private maybeAppliedError(method: string, session: Session, what: string): Error {
    return new Error(
      `maybe_applied: the Figma plugin for "${session.fileName || session.fileKey || 'this file'}" ${what} '${method}' ` +
        `was sent and before it replied, so the change may already have been applied (or not). Re-read the affected ` +
        `nodes before retrying: a blind retry can apply it twice.`,
    );
  }

  // Dispatch queued requests for a plugin while it has free in-flight slots,
  // round-robin across MCP sessions (one call from each waiting agent per
  // turn). A plugin that is closing keeps its queue; dropSession re-homes it.
  // Both lanes are drained this way. Each call runs the busy guard first, so on
  // a wedged or busy plugin queued calls fail fast (plugin_busy /
  // plugin_working, never sent) instead of going out and each burning a timeout.
  private pump(sid: string): void {
    const sess = this.sessions.get(sid);
    if (!sess || sess.ws.readyState !== WebSocket.OPEN) return;
    // Never send queued calls to a window that a newer window of the same file
    // has replaced (reconnect overlap): move them there instead.
    if (this.newerWindow(sess)) { this.adoptQueued(sess); return; }
    this.drain(sess, 'write');
    this.drain(sess, 'main');
  }

  // Pump this window and every other open window of the same file (a write
  // held on one of them may wait for this window's write; see drain).
  private pumpFile(s: Session): void {
    this.pump(s.id);
    const ident = fileIdentity(s);
    if (!ident) return;
    for (const x of [...this.sessions.values()]) {
      if (x.id !== s.id && fileIdentity(x) === ident) this.pump(x.id);
    }
  }

  // A newer live window of the same file as `s` (null when `s` is the newest,
  // or has no stable identity).
  private newerWindow(s: Session): Session | null {
    const ident = fileIdentity(s);
    if (!ident) return null;
    return this.newestLive((x) => x.id !== s.id && fileIdentity(x) === ident && PluginBridge.isNewer(x, s));
  }

  // A write in flight on ANOTHER window of the same file as `s`. The plugin
  // queues writes per window, so two windows of one file (reconnect overlap)
  // would otherwise run two writes at once: the bridge's write lane is per
  // file, and `s` holds its writes until that one settles or its window drops.
  private writeHeldElsewhere(s: Session): Pending | undefined {
    const ident = fileIdentity(s);
    if (!ident) return undefined;
    for (const p of this.pending.values()) {
      if (p.lane === 'write' && p.sessionId !== s.id && fileIdentity(p.session) === ident) return p;
    }
    return undefined;
  }

  private drain(sess: Session, lane: Lane): void {
    const sid = sess.id;
    const L = this.laneState(lane);
    const pq = L.queues.get(sid);
    if (!pq || pq.total === 0) return;
    if (lane === 'write' && this.writeHeldElsewhere(sess)) return;   // per-file write lane
    while (pq.total > 0 && (L.inflight.get(sid) ?? 0) < L.cap) {
      const first = pq.bySession.entries().next().value as [string, QueuedRequest[]] | undefined;
      if (!first) break;
      const [mcpId, q] = first;
      pq.bySession.delete(mcpId);
      const item = q.shift();
      if (q.length) pq.bySession.set(mcpId, q);   // to the back of the ring
      if (!item) continue;
      pq.total--;
      const busy = this.busyCheck(sid, item.method);
      if (busy) {
        if (item.waitTimer) { clearTimeout(item.waitTimer); item.waitTimer = undefined; }
        if (item.ctx) item.ctx.retryAfterMs = busy.retryAfterMs;
        item.reject(busy);
        continue;
      }
      this.dispatch(sess, item, lane);
    }
    if (pq.total === 0 && L.queues.get(sid) === pq) L.queues.delete(sid);
  }

  // After a plugin session dropped: put requests that may be re-sent onto the
  // newest live session of the same file, once it appears (within the
  // cold-start grace), else reject them with a message that says what is safe.
  private rehome(old: Session, items: Array<{ item: QueuedRequest; sent: boolean }>): void {
    if (items.length === 0) return;
    const ident = fileIdentity(old);
    const giveUp = () => {
      for (const { item, sent } of items) {
        item.reject(new Error(
          `plugin_disconnected: the Figma plugin for "${old.fileName || identityLabel(old) || 'this file'}" disconnected and no ` +
            `plugin for that file reconnected within ${PluginBridge.PLUGIN_WAIT_MS / 1000}s. ` +
            (sent
              ? `'${item.method}' only reads, so it is safe to retry once the plugin is back.`
              : `'${item.method}' was never sent to the plugin, so nothing was changed and it is safe to retry.`),
        ));
      }
    };
    if (!ident) { giveUp(); return; }
    // The same file: its identity, or (a key-less file renamed while it
    // reconnected, so its uid+name identity changed) where that rename led.
    const find = () => this.newestLive((s) => fileIdentity(s) === ident) ?? this.followRename(ident);
    const go = (target: Session) => {
      process.stderr.write(`[grip] re-sending ${items.length} request(s) for "${old.fileName}" on ${target.id.slice(0, 8)}\n`);
      for (let i = items.length - 1; i >= 0; i--) this.enqueue(target.id, items[i].item, true);
      this.pump(target.id);
    };
    const now = find();
    if (now) { go(now); return; }
    const onChange = () => {
      const s = find();
      if (!s) return;
      cleanup();
      go(s);
    };
    const timer = setTimeout(() => { cleanup(); giveUp(); }, PluginBridge.PLUGIN_WAIT_MS);
    const cleanup = () => { clearTimeout(timer); this.off('session-change', onChange); };
    this.on('session-change', onChange);
  }

  // ---------- event routing (read-only views of route()) ----------

  // Does this MCP session route to the plugin session an event came from?
  // Reuses route() on a throwaway copy so the real session's pin and bind are
  // never touched: unbound + one file open -> yes; bound -> only its file;
  // ambiguous / deferred / none -> no.
  sessionTargets(mcp: McpSession, pluginSessionId: string): boolean {
    const src = this.sessions.get(pluginSessionId);
    if (!src) return false;
    const probe: McpSession = { ...mcp, bind: mcp.bind ? { ...mcp.bind } : null };
    const r = this.route(probe);
    if (r.kind !== 'ok') return false;
    const ident = fileIdentity(src);
    return r.session.id === src.id || (!!ident && fileIdentity(r.session) === ident);
  }

  // Best-effort attribution of a plugin event: 'self' when this MCP session
  // has an event-causing call in flight on that plugin (or one that settled in
  // the last CAUSE_ECHO_MS), 'other' when only other sessions do, 'unknown'
  // when nobody does (likely the user) or when both do.
  eventCause(mcp: McpSession, pluginSessionId: string): 'self' | 'other' | 'unknown' {
    let self = false;
    let other = false;
    const mark = (mcpId: string) => { if (mcpId === mcp.id) self = true; else other = true; };
    for (const p of this.pending.values()) {
      if (p.sessionId === pluginSessionId && causesEvents(p.method)) mark(p.mcpId);
    }
    const now = Date.now();
    for (const r of this.recentCauses.get(pluginSessionId) ?? []) {
      if (now - r.at <= CAUSE_ECHO_MS) mark(r.mcpId);
    }
    return self && !other ? 'self' : other && !self ? 'other' : 'unknown';
  }

  // A plugin session that has said hello and whose socket is open.
  private static isLive(s: Session): boolean {
    return s.helloAt > 0 && s.ws.readyState === WebSocket.OPEN;
  }

  // Pick the newest live, helloed session matching a predicate. Newest-wins
  // so reconnect overlap (old dying iframe + fresh one, same file) never
  // routes to the zombie.
  private newestLive(pred: (s: Session) => boolean): Session | null {
    let best: Session | null = null;
    for (const s of this.sessions.values()) {
      if (!PluginBridge.isLive(s)) continue;
      if (!pred(s)) continue;
      if (!best || PluginBridge.isNewer(s, best)) best = s;
    }
    return best;
  }

  // Is window `a` newer than window `b`? By FIRST hello (see firstHelloAt),
  // never by the last one: hello is re-sent on every page switch.
  private static isNewer(a: Session, b: Session): boolean {
    if (a.firstHelloAt !== b.firstHelloAt) return a.firstHelloAt > b.firstHelloAt;
    return a.helloSeq > b.helloSeq;
  }

  // The newest live window of the file that key-less identity `ident` was
  // renamed to (following renames in order), or null.
  private followRename(ident: string): Session | null {
    const seen = new Set<string>([ident]);
    let cur = ident;
    for (let r = this.renamed.get(cur); r && !seen.has(r.to); r = this.renamed.get(cur)) {
      cur = r.to;
      seen.add(cur);
      const s = this.newestLive((x) => fileIdentity(x) === cur);
      if (s) return s;
    }
    return null;
  }

  private noteRename(from: string, to: string): void {
    if (from === to) return;
    this.renamed.delete(from);
    this.renamed.set(from, { to, at: Date.now() });
    process.stderr.write(`[grip] key-less file renamed: ${from} -> ${to}\n`);
    PluginBridge.prune(this.renamed);
  }

  private static prune(m: Map<string, { at: number }>): void {
    const now = Date.now();
    for (const [k, v] of m) {
      if (now - v.at > RENAME_MEMORY_MS || m.size > RENAME_MEMORY_MAX) m.delete(k);
      else break;   // insertion order = age order
    }
  }

  // Key-less uid identity of a window (`uid:<uid>:<name>`), else undefined.
  private static keylessUidIdentity(s: Session): string | undefined {
    return !isRealFileKey(s.fileKey) && s.fileUid ? fileIdentity(s) : undefined;
  }

  // Oldest first-hello among the open windows of identity `ident` (0 = none).
  private firstSeen(ident: string): number {
    let t = 0;
    for (const x of this.sessions.values()) {
      if (PluginBridge.isLive(x) && fileIdentity(x) === ident && (t === 0 || x.firstHelloAt < t)) t = x.firstHelloAt;
    }
    return t;
  }

  // A pin must still show the bound file (cheap guard). A name / uid /
  // sessionId bind trusts its pin while the window is open, so a file rename
  // does not drop it; and the bind's stored name is only a hint that follows
  // the pinned window (refreshBindName on each hello and route), so after the
  // window respawns the binding finds the renamed file (matchBind also falls
  // back to the uid alone when exactly one open key-less file carries it).
  private static pinMatchesBind(s: Session, bind: FileBind | null): boolean {
    if (!bind) return true;
    if (bind.key) return s.fileKey === bind.key;
    if (bind.uid) return s.fileUid === bind.uid;
    return true;
  }

  private entryId(s: Session): string {
    return fileIdentity(s) ?? `window:${s.id}`;
  }

  // Distinct open files → newest live session each. Collapses the many
  // reconnect-churn sessions of one file into a single entry, but ONLY for
  // files with a stable identity: windows of key-less files ("0:0") are never
  // merged, each is its own entry.
  private distinctOpenFiles(): FileMap {
    const m: FileMap = new Map();
    for (const s of this.sessions.values()) {
      if (!PluginBridge.isLive(s)) continue;
      const identity = fileIdentity(s);
      const id = identity ?? `window:${s.id}`;
      const cur = m.get(id);
      if (!cur) { m.set(id, { id, identity, name: s.fileName, newest: s, sessions: [s] }); continue; }
      cur.sessions.push(s);
      if (PluginBridge.isNewer(s, cur.newest)) { cur.newest = s; cur.name = s.fileName; }
    }
    for (const e of m.values()) e.sessions.sort((a, b) => (PluginBridge.isNewer(a, b) ? -1 : PluginBridge.isNewer(b, a) ? 1 : 0));
    return m;
  }

  private entryOf(s: Session): FileEntry {
    return this.distinctOpenFiles().get(this.entryId(s))
      ?? { id: this.entryId(s), identity: fileIdentity(s), name: s.fileName, newest: s, sessions: [s] };
  }

  // The open files (entries) that carry fileUid `uid`, narrowed to the ones
  // named `name` when given. Several = the uid was copied into a duplicate.
  private uidEntries(uid: string, name?: string): FileEntry[] {
    const nm = name?.toLowerCase();
    return [...this.distinctOpenFiles().values()].filter((e) =>
      e.sessions.some((x) => x.fileUid === uid) && (nm === undefined || e.name.toLowerCase() === nm));
  }

  // Match a binding against the open windows. Pure (no mutation). Order:
  // real key, uid (+ name), a live bound window, then the exact name. A uid or
  // name that maps to >1 open file/window is reported as 'many' (ambiguous),
  // never guessed.
  private matchBind(bind: FileBind): BindMatch {
    const one = (s: Session | null): BindMatch => (s ? { kind: 'one', session: s } : { kind: 'none' });
    if (bind.key) return one(this.newestLive((s) => s.fileKey === bind.key));
    if (bind.uid) {
      // A uid is shared by every duplicate of a file whose uid was minted
      // before it had a key, so it only identifies a file together with its
      // name (key-less) or when exactly one open file carries it.
      const hits = this.uidEntries(bind.uid, bind.name);
      if (hits.length === 1) return { kind: 'one', session: hits[0].newest };
      if (hits.length > 1) return { kind: 'many', candidates: hits };
      // No open file has both: the stored name may be stale (the file was
      // renamed, and its window respawned before this agent's next call). The
      // name is a hint, not a key: follow the rename the bridge saw (a window
      // re-saying hello under the new name, or the respawn right after the
      // rename). A copy that shares the uid is never taken for it.
      if (bind.name !== undefined) {
        const s = this.followRename(`uid:${bind.uid}:${bind.name}`);
        if (s) return { kind: 'one', session: s };
      }
      return { kind: 'none' };
    }
    if (bind.sessionId) {
      const s = this.sessions.get(bind.sessionId);
      if (s && PluginBridge.isLive(s)) return { kind: 'one', session: s };
      // that window went away (iframe respawn): fall back to the name below
    }
    if (bind.name) {
      const nm = bind.name.toLowerCase();
      const hits = [...this.distinctOpenFiles().values()].filter((v) => v.name.toLowerCase() === nm);
      if (hits.length === 1) return { kind: 'one', session: hits[0].newest };
      if (hits.length > 1) return { kind: 'many', candidates: hits };
    }
    return { kind: 'none' };
  }

  // After a bind resolved to `s`: promote a uid/name/sessionId bind to the
  // file's stable identity when it has one (real key, else uid + name). A
  // file with neither stays bound by name / sessionId (a sessionId bind
  // follows the window it fell back to by name).
  private promote(bind: FileBind, s: Session): void {
    if (bind.key) return;
    if (isRealFileKey(s.fileKey)) { bind.key = s.fileKey; delete bind.uid; delete bind.sessionId; return; }
    if (s.fileUid) {
      bind.uid = s.fileUid;
      bind.name = s.fileName;   // a uid alone may also match a later duplicate; the name follows the file
      delete bind.sessionId;
      return;
    }
    if (bind.sessionId) bind.sessionId = s.id;
  }

  // A key-less bind's stored file name follows the window it is pinned to
  // (the user may rename the file): it is a hint for finding the file again
  // after the window respawns, never a key.
  private static refreshBindName(bind: FileBind | null, s: Session): void {
    if (!bind || bind.key || isRealFileKey(s.fileKey) || bind.name === undefined || bind.name === s.fileName) return;
    if (bind.uid && s.fileUid !== bind.uid) return;
    bind.name = s.fileName;
  }

  // Remember an MCP session (weakly) so hellos can refresh its binding.
  private track(mcp: McpSession): void {
    const ref = this.mcpRefs.get(mcp.id);
    if (!ref || ref.deref() !== mcp) this.mcpRefs.set(mcp.id, new WeakRef(mcp));
  }

  // The single routing decision. Never guesses among multiple files: a
  // wrong guess silently reads/writes the wrong canvas (the bug agents hit).
  private route(mcp: McpSession): Routing {
    // 1. Honor the resolved live pin while its session is still open — but
    //    if a NEWER live session serves the same file (reconnect overlap),
    //    re-pin to it so we never keep talking to a dying zombie. Only
    //    possible for files with a stable identity; a key-less window is
    //    kept while it is open (another window may be another file). The
    //    new window must match the binding too, so a re-pin can never hop.
    if (mcp.activeFileId) {
      const s = this.sessions.get(mcp.activeFileId);
      if (s && PluginBridge.isLive(s) && PluginBridge.pinMatchesBind(s, mcp.bind)) {
        PluginBridge.refreshBindName(mcp.bind, s);
        const ident = fileIdentity(s);
        if (ident) {
          const newest = this.newestLive((x) => fileIdentity(x) === ident && PluginBridge.pinMatchesBind(x, mcp.bind));
          if (newest && newest.id !== s.id) {
            mcp.activeFileId = newest.id;
            return { kind: 'ok', session: newest };
          }
        }
        return { kind: 'ok', session: s };
      }
      mcp.activeFileId = null; // session died (iframe respawn) — re-resolve
    }
    // 2. Bound to a specific file: route there, or defer until it connects.
    //    Never falls to another open file — that silent hop is the bug.
    if (mcp.bind) {
      const m = this.matchBind(mcp.bind);
      if (m.kind === 'one') {
        mcp.activeFileId = m.session.id;
        this.promote(mcp.bind, m.session);
        return { kind: 'ok', session: m.session };
      }
      if (m.kind === 'many') return { kind: 'ambiguous_name', bind: mcp.bind, candidates: m.candidates };
      return { kind: 'deferred', bind: mcp.bind, files: this.distinctOpenFiles() };
    }
    // 3. Unbound. One open file → frictionless. Zero → none. Many (files, or
    //    windows of key-less files that can't be told apart) → ambiguous.
    const files = this.distinctOpenFiles();
    if (files.size === 0) return { kind: 'none' };
    if (files.size === 1) return { kind: 'ok', session: files.values().next().value!.newest };
    return { kind: 'ambiguous', files };
  }

  // Resolve a free-form target (fileKey | exact name | sessionId | figma.com
  // URL | fileUid) into a bind. Resolves against currently-open files where
  // possible; an unmatched value is held as key (if keyish/URL) or name
  // (deferred). `lenient` (launch-time binds) keeps an ambiguous name as a
  // name bind instead of throwing, so calls then fail loud with the candidates.
  private resolveBind(input: string, lenient = false): FileBind {
    const trimmed = input.trim();
    const url = trimmed.match(PluginBridge.FIGMA_URL_RE);
    if (url) return { key: url[1] };
    // sessionId of an open plugin → its file's identity, or (key-less file)
    // that window, with its name as the fallback when the window respawns.
    const sess = this.sessions.get(trimmed);
    if (sess && sess.helloAt > 0) {
      if (isRealFileKey(sess.fileKey)) return { key: sess.fileKey };
      if (sess.fileUid) return { uid: sess.fileUid, name: sess.fileName };
      return { sessionId: sess.id, name: sess.fileName };
    }
    if (trimmed === PLACEHOLDER_FILE_KEY) {
      throw new Error(
        `not_a_file_key: "${PLACEHOLDER_FILE_KEY}" is the placeholder id that every local or unsaved Figma file reports, ` +
          `so it does not identify one file. Bind by the file name or by the window's sessionId (see list_files).`,
      );
    }
    for (const s of this.sessions.values()) {
      if (PluginBridge.isLive(s) && s.fileKey === trimmed) return { key: trimmed };
    }
    // A fileUid: one open file carries it → that file's key (or uid + name);
    // several (a duplicate kept the uid) → ambiguous, never guessed.
    const uidHits = this.uidEntries(trimmed);
    if (uidHits.length === 1) {
      const n = uidHits[0].newest;
      return isRealFileKey(n.fileKey) ? { key: n.fileKey } : { uid: trimmed, name: n.fileName };
    }
    if (uidHits.length > 1) {
      if (lenient) return { uid: trimmed };
      throw this.ambiguousNameError({ uid: trimmed }, uidHits);
    }
    const nameHits = [...this.distinctOpenFiles().values()].filter((v) => v.name.toLowerCase() === trimmed.toLowerCase());
    if (nameHits.length === 1) {
      const n = nameHits[0].newest;
      if (isRealFileKey(n.fileKey)) return { key: n.fileKey };
      if (n.fileUid) return { uid: n.fileUid, name: n.fileName };
      return { name: trimmed };   // key-less file: stay bound by name, never by "0:0"
    }
    if (nameHits.length > 1) {
      if (lenient) return { name: trimmed };
      throw this.ambiguousNameError({ name: trimmed }, nameHits);
    }
    // Unresolved → defer. Bare Figma-style keys are ≥16 url-safe chars, no spaces.
    if (/^[A-Za-z0-9]{16,}$/.test(trimmed)) return { key: trimmed };
    return { name: trimmed };
  }

  // Apply a launch-time binding (GRIP_FILE over stdio, ?file= over HTTP).
  // Best-effort: a bad target is logged and ignored — the agent still works
  // (just unbound).
  bindFromLaunch(target: string, mcp: McpSession): void {
    try {
      const bind = this.resolveBind(target, true);
      this.track(mcp);
      mcp.bind = bind;
      mcp.activeFileId = null;
      const r = this.route(mcp);
      process.stderr.write(
        `[grip] mcp ${mcp.id.slice(0, 8)} launch-bound → ${bind.key ?? bind.uid ?? bind.name ?? bind.sessionId} (${r.kind === 'ok' ? 'resolved' : r.kind === 'ambiguous_name' ? 'ambiguous name' : 'deferred'})\n`,
      );
    } catch (err) {
      process.stderr.write(`[grip] launch bind failed for '${target}': ${(err as Error).message}\n`);
    }
  }

  private resolveActiveId(mcp: McpSession): string | null {
    const r = this.route(mcp);
    return r.kind === 'ok' ? r.session.id : null;
  }

  private activeSession(mcp: McpSession): Session | null {
    const r = this.route(mcp);
    return r.kind === 'ok' ? r.session : null;
  }

  private static windowLabel(e: FileEntry): string {
    if (isRealFileKey(e.newest.fileKey)) return `"${e.name}" (${e.newest.fileKey})`;
    if (e.identity) return `"${e.name}" (${identityLabel(e.newest)}, sessionId ${e.newest.id})`;
    return `"${e.name}" (no stable file key, sessionId ${e.newest.id})`;
  }

  private fileList(files: FileMap): string {
    return [...files.values()].map((e) => PluginBridge.windowLabel(e)).join(', ');
  }

  private candidateList(entries: FileEntry[]): Array<{ fileName: string; fileKey: string; sessionId: string }> {
    return entries.map((e) => ({ fileName: e.name, fileKey: e.newest.fileKey, sessionId: e.newest.id }));
  }

  private ambiguousError(files: FileMap): Error {
    const keyless = [...files.values()].some((e) => !isRealFileKey(e.newest.fileKey));
    const what = keyless ? 'Figma files/windows are open' : 'Figma files are open';
    const why = keyless
      ? ' Local or unsaved files have no real file key, so windows that cannot be proven to show one file (marked "no stable file key", or sharing a file id under different names) are listed on their own; if two of them are the same file reconnecting, retry in a few seconds.'
      : '';
    return new Error(
      `ambiguous_active_file: ${files.size} ${what} (${this.fileList(files)}).${why} ` +
        `grip won't guess which one. Call set_active_file with the fileKey, file name, or sessionId of your ` +
        `target first, or use list_files to see them. This is deliberate: guessing silently reads/writes the wrong file.`,
    );
  }

  private ambiguousNameError(bind: FileBind, candidates: FileEntry[]): Error {
    const list = candidates
      .map((e) => `"${e.name}" (${isRealFileKey(e.newest.fileKey) ? 'fileKey ' + e.newest.fileKey : e.identity ? identityLabel(e.newest) : 'no stable file key'}, sessionId ${e.newest.id})`)
      .join(', ');
    const what = bind.name ? `the file name "${bind.name}"` : `the file id ${bind.uid}`;
    return new Error(
      `ambiguous_file_name: ${what} matches ${candidates.length} open files/windows: ${list}. ` +
        `grip won't guess which one. Call set_active_file with the fileKey, or with the sessionId of the window you mean.`,
    );
  }

  private deferredError(bind: FileBind, files: FileMap): Error {
    const label = bind.key ? `fileKey ${bind.key}`
      : bind.uid ? `file id ${bind.uid}${bind.name ? ` ("${bind.name}")` : ''}`
      : bind.sessionId ? `window ${bind.sessionId}${bind.name ? ` ("${bind.name}")` : ''}`
      : `file "${bind.name}"`;
    const others = files.size ? ` Open now: ${this.fileList(files)}.` : ' No Figma files are open.';
    return new Error(
      `bound_file_not_open: this agent is bound to ${label}, which isn't open in Figma.${others} ` +
        `Open it in Figma, or call set_active_file to bind a different target.`,
    );
  }

  // fileKey out of any figma.com editor URL (design/dev/proto/board/slides).
  private static readonly FIGMA_URL_RE = /figma\.com\/(?:file|design|proto|board|slides)\/([A-Za-z0-9]+)/i;

  // ---------- message handling ----------

  private handleMessage(sessionId: string, raw: string) {
    let msg: WSResponse | WSEvent | WSHello;
    try {
      msg = JSON.parse(raw);
    } catch {
      process.stderr.write('[grip] dropped non-JSON message\n');
      return;
    }

    if ('kind' in msg && msg.kind === 'hello') {
      this.applyHello(sessionId, msg);
      return;
    }

    // User clicked the purple strip. Older bridges drop this frame (no
    // id/event/kind), older plugins never send it: compatible both ways.
    // `version` is the version the user was shown; the handler installs only if
    // the latest release still equals it.
    if ((msg as { type?: unknown }).type === 'update_request') {
      const sess = this.sessions.get(sessionId);
      if (!originAllowedForUpdate(sess?.origin)) {
        process.stderr.write(`[grip] update_request from ${sessionId.slice(0, 8)} refused (origin ${sess?.origin})\n`);
        this.sendTo(sessionId, { type: 'update_result', status: 'error', code: 'origin', message: 'update requests are only accepted from the Figma plugin' });
        return;
      }
      const reqVersion = (msg as { version?: unknown }).version;
      process.stderr.write(`[grip] update_request from ${sessionId.slice(0, 8)} (version ${typeof reqVersion === 'string' ? reqVersion.slice(0, 32) : 'not given'})\n`);
      this.emit('update-request', { sessionId, version: typeof reqVersion === 'string' ? reqVersion : undefined });
      return;
    }

    if ('event' in msg) {
      const sess = this.sessions.get(sessionId);
      this.emit('event', { ...msg, sessionId, fileKey: sess?.fileKey ?? '', fileName: sess?.fileName ?? '' } as BridgeEvent);
      return;
    }

    // Streamed run_script log line — buffer it (bounded) against its request id
    // so a later timeout can surface how far the script got. A line for a call
    // that already settled (timed out, answered, dropped) is ignored: its
    // buffer was cleared on settle and must not be recreated (never cleared).
    if ((msg as any).scriptLog && typeof (msg as any).id === 'string') {
      const { id, line } = msg as unknown as { id: string; line: string };
      if (!this.pending.has(id)) return;
      let buf = this.scriptLogs.get(id);
      if (!buf) { buf = []; this.scriptLogs.set(id, buf); }
      buf.push(String(line ?? '').slice(0, 300));
      if (buf.length > 200) buf.shift();   // keep the most recent lines, bound memory
      return;
    }

    if ('id' in msg) {
      // Any reply proves this plugin's thread is not frozen: clear its wedge
      // evidence (including a late reply to a call that already timed out).
      for (const [oid, o] of this.overdue) if (o.sessionId === sessionId) this.overdue.delete(oid);
      this.lostWrites.delete(msg.id);   // the late reply: that write is done in the plugin
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timeout);
      const ms = Date.now() - p.startedAt;
      const prev = this.latency.get(sessionId);
      this.latency.set(sessionId, prev === undefined ? ms : prev * 0.8 + ms * 0.2);
      p.release();
      const pending = { method: p.method, resolve: p.item.resolve, reject: p.item.reject };
      // Response-size backstop. An un-upgraded plugin (no nodeBudget cap)
      // can return a multi-MB serialized tree; ferrying that to the agent
      // and parsing it into context is what produces the 120s+ "idle"
      // stall (the plugin answered fast, the client choked). Reject early
      // with an actionable, typed error instead.
      // Read-specific soft cap (much lower than the 8MB OOM guard, tuned to the
      // MCP token budget). A too-large read would overflow the client AND poison
      // context for the rest of the session — refuse early with the remedy.
      if (READ_METHODS.has(pending.method) && raw.length > READ_SOFT_CAP_BYTES) {
        pending.reject(new Error(
          `read_too_large: '${pending.method}' returned ${Math.round(raw.length / 1024)}KB, over the ${Math.round(READ_SOFT_CAP_BYTES / 1024)}KB read cap — ` +
          `this would overflow the MCP result token budget and re-cost every turn. Narrow it: pass \`properties\` (a field whitelist that recurses to the whole tree, e.g. properties:["name","variantProperties"]) and/or lower \`depth\`/\`maxNodes\`. ` +
          `For a genuinely-full dump, use export_node format:"JSON" with a \`path\` (writes to disk, no token limit). Raise GRIP_READ_CAP_BYTES only if your client's budget is larger.`,
        ));
        return;
      }
      if (raw.length > RESPONSE_SOFT_CAP_BYTES) {
        pending.reject(new Error(
          `response_too_large: ${Math.round(raw.length / 1024)}KB exceeds ${Math.round(RESPONSE_SOFT_CAP_BYTES / 1024)}KB. ` +
          `For reads: re-call with depth + maxNodes to bound it (e.g. depth:3, maxNodes:500), or reload the plugin if it predates the nodeBudget cap. ` +
          `For a large export (esp. video): raise GRIP_RESPONSE_CAP_BYTES on the daemon.`,
        ));
        return;
      }
      if (msg.error !== undefined) pending.reject(new Error(msg.error));
      else pending.resolve(msg.result);
    }
  }

  private applyHello(sessionId: string, hello: WSHello) {
    const sess = this.sessions.get(sessionId);
    if (!sess) return;
    const prevIdent = sess.helloAt > 0 ? PluginBridge.keylessUidIdentity(sess) : undefined;
    const prevUid = sess.fileUid;
    sess.fileKey = typeof hello.fileKey === 'string' ? hello.fileKey : '';
    sess.fileUid = typeof hello.fileUid === 'string' && hello.fileUid !== '' ? hello.fileUid : undefined;
    sess.fileName = hello.fileName;
    sess.currentPageId = hello.currentPageId;
    sess.currentPageName = hello.currentPageName;
    sess.helloAt = Date.now();
    if (!sess.firstHelloAt) { sess.firstHelloAt = sess.helloAt; sess.helloSeq = ++PluginBridge.helloCounter; }
    sess.pluginVersion = hello.version ?? 'unknown';
    sess.minBridge = typeof hello.minBridge === 'string' ? hello.minBridge : undefined;
    sess.capabilities = hello.capabilities ?? [];
    if (hello.version && hello.version !== BRIDGE_VERSION) {
      process.stderr.write(
        `[grip] WARNING plugin version ${hello.version} != bridge ${BRIDGE_VERSION}. ` +
        `Reload the plugin (Figma may be serving stale cached code).\n`,
      );
    }
    process.stderr.write(
      `[grip] hello ${sessionId.slice(0, 8)} v${sess.pluginVersion} → ${hello.fileName} / ${hello.currentPageName}\n`,
    );
    // The plugin needs a NEWER bridge than this one: the bridge is the stale side.
    // Informational (grip_health shows it; it counts as "update recommended").
    if (sess.minBridge && isSemver(sess.minBridge) && compareSemver(sess.minBridge, BRIDGE_VERSION) > 0) {
      process.stderr.write(
        `[grip] WARNING plugin ${sess.pluginVersion} in "${hello.fileName}" needs bridge >= ${sess.minBridge} but this is ${BRIDGE_VERSION}: the bridge is out of date, update it.\n`,
      );
    }
    this.noteHelloRename(sess, prevIdent, prevUid);
    this.refreshBindNames(sess);
    this.adoptQueued(sess);
    // Listeners (update signal) recompute against the new session list and
    // broadcast; then make sure THIS strip has the current state (deduped).
    this.emit('session-change');
    this.pushUpdate(sessionId);
  }

  // Rename tracking on a hello (see RESPAWN_MATCH_MS): the same window under a
  // new name, or the first window of a key-less file appearing right after the
  // last window of another file with its fileUid closed.
  private noteHelloRename(sess: Session, prevIdent: string | undefined, prevUid: string | undefined): void {
    const ident = PluginBridge.keylessUidIdentity(sess);
    if (!ident) return;
    if (prevIdent) {
      if (prevIdent !== ident && prevUid === sess.fileUid) this.noteRename(prevIdent, ident);
      return;
    }
    // first hello of this window: is it the first window of this file?
    for (const x of this.sessions.values()) {
      if (x !== sess && PluginBridge.isLive(x) && fileIdentity(x) === ident) return;
    }
    const now = Date.now();
    const hits = [...this.closedFiles].filter(([id, c]) =>
      c.uid === sess.fileUid && id !== ident && now - c.at <= RESPAWN_MATCH_MS && this.firstSeen(id) === 0);
    if (hits.length === 1) this.noteRename(hits[0][0], ident);
  }

  // Every agent pinned to this window: its key-less binding's stored file name
  // follows the window (a rename), so the binding still finds the file once
  // Figma respawns the plugin iframe.
  private refreshBindNames(sess: Session): void {
    for (const [id, ref] of this.mcpRefs) {
      const m = ref.deref();
      if (!m) { this.mcpRefs.delete(id); continue; }
      if (m.activeFileId === sess.id) PluginBridge.refreshBindName(m.bind, sess);
    }
  }

  // A newer window of the same file said hello while older ones are still
  // open (reconnect overlap), or an older window was pumped: routing goes to
  // the newest window, so calls still QUEUED on older windows (never sent),
  // reads and writes alike, move to it instead of being sent to a window that
  // is about to die. Calls already sent stay where they are (their reply or the
  // disconnect handling settles them); the per-file write lane keeps the
  // newest window's writes waiting until an older window's write settles.
  private adoptQueued(sess: Session): void {
    const ident = fileIdentity(sess);
    if (!ident) return;
    const target = this.newestLive((s) => fileIdentity(s) === ident);
    if (!target) return;
    const moved: QueuedRequest[] = [];
    for (const queues of [this.writeQueues, this.queues]) {
      for (const [sid, pq] of [...queues]) {
        if (sid === target.id) continue;
        const old = this.sessions.get(sid);
        if (!old || fileIdentity(old) !== ident) continue;
        for (const q of pq.bySession.values()) moved.push(...q);
        queues.delete(sid);
      }
    }
    if (moved.length === 0) return;
    moved.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
    process.stderr.write(`[grip] moving ${moved.length} queued request(s) for "${target.fileName}" to the newer window ${target.id.slice(0, 8)}\n`);
    // enqueue re-picks the lane on the target and re-arms a write's wait
    // timer with the time it has LEFT (writeWaitSince is kept).
    for (let i = moved.length - 1; i >= 0; i--) this.enqueue(target.id, moved[i], true);
    this.pump(target.id);
  }

  // ---------- update notices ----------

  private updateState: UpdateBroadcast | null = null;

  // Set by the daemon whenever the update SIGNAL changes (new release, a
  // plugin connecting/leaving...); sent to every connected strip and replayed
  // to each plugin on its hello. Frames identical to the last one a session got
  // are skipped. `null` = nothing known, strips are told "off".
  setUpdateState(s: UpdateBroadcast | null) {
    this.updateState = s;
    for (const id of this.sessions.keys()) this.pushUpdate(id);
  }

  // Send the current update state to one strip (deduped; a fresh strip that
  // has nothing to show is not sent a frame at all). `force` ignores the dedupe
  // (used to re-push after a refused update_request).
  pushUpdate(sessionId: string, force = false) {
    const sess = this.sessions.get(sessionId);
    if (!sess || sess.helloAt === 0) return;
    const st = this.updateState;
    const frame = {
      type: 'update',
      available: !!st?.available && (st.eligible ? st.eligible(sessionId) : true),
      latest: st?.latest ?? null,
      current: st?.current ?? BRIDGE_VERSION,
      headline: st?.headline ?? null,
    };
    const key = frame.available ? JSON.stringify(frame) : 'off';
    if (!force && key === (sess.updateSent ?? 'off')) return;
    sess.updateSent = key;
    this.sendTo(sessionId, frame);
  }

  // Send one JSON frame to one plugin session (best effort, never throws).
  // A toast in ONE Figma window (the plugin's own `notify` method, so it works with every
  // plugin version). Fire and forget: no flow control, no pending entry; the plugin's reply
  // carries an id nobody waits for and is ignored. Returns whether it was sent.
  toast(sessionId: string, message: string, timeoutMs = 8000): boolean {
    const sess = this.sessions.get(sessionId);
    if (!sess || sess.helloAt === 0 || sess.ws.readyState !== 1) return false;
    try {
      sess.ws.send(JSON.stringify({ id: `toast-${uuid()}`, method: 'notify', params: { message, timeout: timeoutMs }, timeoutMs: 5000 }));
      return true;
    } catch { return false; }
  }

  sendTo(sessionId: string, msg: Record<string, unknown>) {
    const s = this.sessions.get(sessionId);
    if (!s || s.ws.readyState !== WebSocket.OPEN) return;
    try { s.ws.send(JSON.stringify(msg)); } catch { /* peer going away */ }
  }

  private dropSession(sessionId: string) {
    const sess = this.sessions.get(sessionId);
    if (!sess) return;
    if (sess.pingTimer) clearInterval(sess.pingTimer);
    this.sessions.delete(sessionId);
    process.stderr.write(`[grip] session ${sessionId.slice(0, 8)} closed (${this.sessions.size} remain)\n`);

    // In-flight and queued requests for that plugin. Take the queue first so
    // releasing the in-flight slots below does not pump it into a dead socket.
    const pqs = [this.writeQueues.get(sessionId), this.queues.get(sessionId)];
    this.queues.delete(sessionId);
    this.writeQueues.delete(sessionId);
    const again: Array<{ item: QueuedRequest; sent: boolean }> = [];
    for (const [reqId, p] of this.pending) {
      if (p.sessionId !== sessionId) continue;
      clearTimeout(p.timeout);
      this.pending.delete(reqId);
      p.release();
      if (!isRetrySafe(p.method)) {
        // Sent and possibly already applied: never re-send a change blindly.
        p.item.reject(this.maybeAppliedError(p.method, sess, 'disconnected after'));
      } else if (!p.item.retried) {
        p.item.retried = true;           // a read: re-send once on the file's next session
        again.push({ item: p.item, sent: true });
      } else {
        p.item.reject(new Error(
          `plugin_disconnected: the Figma plugin disconnected during '${p.method}' and the bridge already re-sent it ` +
            `once. It only reads, so it is safe to call again.`,
        ));
      }
    }
    // Queued requests were never sent, so even a change is safe to re-send.
    for (const pq of pqs) {
      if (!pq) continue;
      for (const q of pq.bySession.values()) {
        for (const item of q) {
          if (item.waitTimer) { clearTimeout(item.waitTimer); item.waitTimer = undefined; }
          if (!item.retried) { item.retried = true; again.push({ item, sent: false }); }
          else item.reject(new Error(`plugin_disconnected: the Figma plugin disconnected again while '${item.method}' was waiting to be sent. It was never sent, so nothing was changed and it is safe to retry.`));
        }
      }
    }
    this.inflight.delete(sessionId);
    this.writeInflight.delete(sessionId);
    this.latency.delete(sessionId);
    this.recentCauses.delete(sessionId);
    for (const [oid, o] of this.overdue) if (o.sessionId === sessionId) this.overdue.delete(oid);
    for (const [lid, l] of this.lostWrites) if (l.sessionId === sessionId) this.lostWrites.delete(lid);
    this.noteClosed(sess);

    // Per-MCP-session pins clean themselves up lazily in resolveActiveId
    // when the pinned plugin is gone.
    this.emit('session-change');
    this.rehome(sess, again);
  }

  // The last window of a key-less file closed: remember when, and if a window
  // of another key-less file with the same fileUid first appeared just before
  // (Figma respawned the iframe after a rename), that is where it went.
  private noteClosed(sess: Session): void {
    const ident = PluginBridge.keylessUidIdentity(sess);
    if (!ident || !sess.fileUid || this.firstSeen(ident) !== 0) return;
    const now = Date.now();
    this.closedFiles.delete(ident);
    this.closedFiles.set(ident, { uid: sess.fileUid, name: sess.fileName, at: now });
    PluginBridge.prune(this.closedFiles);
    const hits = [...this.distinctOpenFiles().values()].filter((e) =>
      e.identity !== undefined && e.identity !== ident && !isRealFileKey(e.newest.fileKey) &&
      e.newest.fileUid === sess.fileUid && now - this.firstSeen(e.identity) <= RESPAWN_MATCH_MS);
    if (hits.length === 1) this.noteRename(ident, hits[0].identity!);
  }

  close() {
    for (const [, p] of this.pending) {
      clearTimeout(p.timeout);
      p.item.reject(new Error(
        isRetrySafe(p.method)
          ? 'leader_shutdown: Bridge shutting down'
          : `leader_shutdown: Bridge shutting down while '${p.method}' was in flight; the change may already have been applied, re-read before retrying`,
      ));
    }
    this.pending.clear();
    for (const pq of [...this.queues.values(), ...this.writeQueues.values()]) {
      for (const q of pq.bySession.values()) {
        for (const item of q) {
          if (item.waitTimer) clearTimeout(item.waitTimer);
          item.reject(new Error('leader_shutdown: Bridge shutting down (the call was never sent)'));
        }
      }
    }
    this.queues.clear();
    this.writeQueues.clear();
    this.inflight.clear();
    this.writeInflight.clear();
    this.wss.close();
  }

  // Snapshot for grip_health.
  snapshot() {
    return {
      pluginCount: this.sessions.size,
      pendingCount: this.pending.size,
      plugins: Array.from(this.sessions.values()).map((s) => ({
        sessionId: s.id,
        fileKey: s.fileKey,
        ...(s.fileUid ? { fileUid: s.fileUid } : {}),
        stableKey: fileIdentity(s) !== undefined,
        fileName: s.fileName,
        currentPageId: s.currentPageId,
        currentPageName: s.currentPageName,
        pluginVersion: s.pluginVersion ?? 'unknown',
        minBridge: s.minBridge ?? null,
        // false until the plugin's hello arrives (version/file not known yet)
        hello: s.helloAt > 0,
        capabilities: s.capabilities ?? [],
        wsReady: s.ws.readyState === WebSocket.OPEN,
        lastPongMsAgo: s.lastPong ? Date.now() - s.lastPong : null,
        // Flow control: requests currently sent-and-awaiting vs. metered-behind
        // in the queue. queued > 0 means the plugin is being throttled to keep
        // it responsive under a command burst.
        // (Both lanes; writeLane = the `serialMutations` write lane alone.)
        inflight: (this.inflight.get(s.id) ?? 0) + (this.writeInflight.get(s.id) ?? 0),
        queued: (this.queues.get(s.id)?.total ?? 0) + (this.writeQueues.get(s.id)?.total ?? 0),
        // How many MCP sessions have calls waiting (served round-robin).
        queuedSessions: new Set([
          ...(this.queues.get(s.id)?.bySession.keys() ?? []),
          ...(this.writeQueues.get(s.id)?.bySession.keys() ?? []),
        ]).size,
        writeLane: {
          serial: (s.capabilities ?? []).includes('serialMutations'),
          inflight: this.writeInflight.get(s.id) ?? 0,
          queued: this.writeQueues.get(s.id)?.total ?? 0,
        },
      })),
    };
  }
}
