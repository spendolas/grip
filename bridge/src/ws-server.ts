import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuid } from 'uuid';
import { EventEmitter } from 'events';
import type { McpSession, PluginSessionInfo, WSEvent, WSHello, WSResponse } from './types.js';
import { BRIDGE_VERSION } from './types.js';

interface Pending {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
  sessionId: string;
  startedAt: number;
  method: string;
}

interface Session {
  id: string;
  ws: WebSocket;
  fileKey: string;
  fileName: string;
  currentPageId: string;
  currentPageName: string;
  pluginVersion?: string;
  capabilities?: string[];
  lastPong: number;
  pingTimer?: NodeJS.Timeout;
  // When this session's most recent hello arrived. Used to break ties when
  // several live sessions share a fileKey (reconnect overlap): newest wins,
  // so routing never lands on a dying zombie iframe.
  helloAt: number;
}

// Distinct open files, keyed by fileKey → newest live session for that file.
type FileMap = Map<string, { name: string; newest: Session }>;

// Outcome of resolving which plugin session a request should route to.
// The non-ok cases are surfaced to the agent as in-band errors so a
// multi-file session can never silently read/write the wrong file.
type Routing =
  | { kind: 'ok'; session: Session }
  | { kind: 'none' }                                   // no plugin connected at all
  | { kind: 'ambiguous'; files: FileMap }              // >1 file open, no bind — agent must choose
  | { kind: 'deferred'; bind: { key?: string; name?: string }; files: FileMap }; // bound file not open (yet)

const REQUEST_TIMEOUT_MS = 10_000;          // tighter than before; matches heartbeat
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
const SLOW_METHOD_TIMEOUT_MS: Record<string, number> = {
  export_node: EXPORT_TIMEOUT_MS,
};
// Fail-fast threshold. The plugin runs on Figma's single main thread; a
// synchronous run_script loop wedges it and CANNOT be preempted from here.
// When a prior request to a plugin has been outstanding past this, the
// thread is almost certainly stuck — so reject NEW requests instantly with
// plugin_busy instead of letting each one eat a full 10s timeout (the
// cascade that made the whole agent hang). Fast concurrent calls finish in
// ms and never cross this, so normal multi-agent use is untouched.
const BUSY_THRESHOLD_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 5_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;        // miss two pings → declare plugin dead
// Reject plugin responses larger than this — a payload this big means an
// unbounded serialize (old plugin / no maxNodes) and ferrying it stalls
// the agent. 8 MB clears legit PNG/PDF exports while catching runaway
// node trees. Override with GRIP_RESPONSE_CAP_BYTES.
const RESPONSE_SOFT_CAP_BYTES = Number(process.env.GRIP_RESPONSE_CAP_BYTES ?? 8 * 1024 * 1024);

export class PluginBridge extends EventEmitter {
  private wss: WebSocketServer;
  private sessions = new Map<string, Session>();
  private pending = new Map<string, Pending>();

  constructor(port: number) {
    super();
    // 10 MB cap — accommodates large export payloads but bounds OOM risk
    // from a misbehaving peer / runaway run_script result.
    this.wss = new WebSocketServer({ port, maxPayload: 10 * 1024 * 1024 });

    this.wss.on('connection', (ws) => {
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

  list(mcp: McpSession): PluginSessionInfo[] {
    const activeId = this.resolveActiveId(mcp);
    return Array.from(this.sessions.values()).map((s) => ({
      sessionId: s.id,
      fileKey: s.fileKey,
      fileName: s.fileName,
      currentPageId: s.currentPageId,
      currentPageName: s.currentPageName,
      active: s.id === activeId,
    }));
  }

  // Bind an agent to a file by fileKey, exact file name, sessionId, or a
  // figma.com URL. Binds even if the file isn't open yet (deferred) so a
  // launcher/agent can declare intent ahead of the plugin connecting; the
  // binding survives reconnect churn and ignores every other open file.
  setActive(target: string, mcp: McpSession): {
    bound: true;
    resolved: boolean;
    target: { key?: string; name?: string };
    file?: PluginSessionInfo;
    reason?: 'not_open';
    open?: PluginSessionInfo[];
  } {
    const bind = this.resolveBind(target); // may throw ambiguous_file_name
    mcp.bind = bind;
    mcp.activeFileId = null; // force re-resolve against the new bind
    const match = this.matchBind(bind);
    if (match) {
      mcp.activeFileId = match.id;
      if (!bind.key && match.fileKey) bind.key = match.fileKey; // promote name→key
      process.stderr.write(`[grip] mcp ${mcp.id.slice(0, 8)} bound → ${match.fileName} (${match.fileKey})\n`);
      return { bound: true, resolved: true, target: bind, file: this.info(match) };
    }
    // Not open yet — hold the binding (deferred). Return the open files so a
    // typo is caught immediately while a genuine cold-start file resolves
    // when it connects.
    const label = bind.key ?? bind.name ?? target;
    process.stderr.write(`[grip] mcp ${mcp.id.slice(0, 8)} bound → ${label} (deferred, not open)\n`);
    return { bound: true, resolved: false, reason: 'not_open', target: bind, open: this.list(mcp) };
  }

  private info(s: Session): PluginSessionInfo {
    return {
      sessionId: s.id,
      fileKey: s.fileKey,
      fileName: s.fileName,
      currentPageId: s.currentPageId,
      currentPageName: s.currentPageName,
      active: true,
    };
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
      if (s.fileKey && s.ws.readyState === WebSocket.OPEN) return true;
    }
    return false;
  }

  async request(method: string, params: Record<string, unknown>, mcp: McpSession): Promise<unknown> {
    let session = this.activeSession(mcp);
    if (!session) {
      // Not routable right now. Distinguish WHY so the agent gets an
      // actionable, in-band error instead of a silently-wrong file.
      const r = this.route(mcp);
      if (r.kind === 'ambiguous') throw this.ambiguousError(r.files);
      // 'none' (cold start) or 'deferred' (bound file mid-respawn / just
      // opening) may resolve once a plugin (re)connects — soak the reconnect
      // grace, then re-check. waitForPlugin re-runs route() on every hello,
      // so the instant the bound file connects it routes.
      session = await this.waitForPlugin(mcp, PluginBridge.PLUGIN_WAIT_MS);
      if (!session) {
        const r2 = this.route(mcp);
        if (r2.kind === 'ambiguous') throw this.ambiguousError(r2.files);
        if (r2.kind === 'deferred') throw this.deferredError(r2.bind, r2.files);
        throw new Error('plugin_disconnected: No plugin connected');
      }
    }
    // Wedge guard: if a prior request to THIS plugin has been stuck past the
    // busy threshold, the main thread is likely frozen. Fail fast so callers
    // don't pile up 10s timeouts behind a dead thread.
    const now = Date.now();
    let stuck: Pending | undefined;
    for (const p of this.pending.values()) {
      if (p.sessionId === session.id && now - p.startedAt >= BUSY_THRESHOLD_MS) {
        if (!stuck || p.startedAt < stuck.startedAt) stuck = p;
      }
    }
    if (stuck) {
      const heldMs = now - stuck.startedAt;
      throw new Error(
        `plugin_busy: '${stuck.method}' has run ${(heldMs / 1000).toFixed(1)}s on the plugin main thread; ` +
          `it may be wedged (e.g. a synchronous run_script loop). Rejecting '${method}' fast. ` +
          `If this persists, the Figma tab must be reloaded to recover.`,
      );
    }
    const id = uuid();
    const timeoutMs = SLOW_METHOD_TIMEOUT_MS[method] ?? REQUEST_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`request_timeout: '${method}' exceeded ${timeoutMs / 1000}s`));
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout, sessionId: session.id, startedAt: Date.now(), method });
      session.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  // Pick the newest live, helloed session matching a predicate. Newest-wins
  // so reconnect overlap (old dying iframe + fresh one, same fileKey) never
  // routes to the zombie.
  private newestLive(pred: (s: Session) => boolean): Session | null {
    let best: Session | null = null;
    for (const s of this.sessions.values()) {
      if (!s.fileKey || s.ws.readyState !== WebSocket.OPEN) continue;
      if (!pred(s)) continue;
      if (!best || s.helloAt > best.helloAt) best = s;
    }
    return best;
  }

  // Distinct open files → newest live session each. Collapses the many
  // reconnect-churn sessions of one file into a single entry.
  private distinctOpenFiles(): FileMap {
    const m: FileMap = new Map();
    for (const s of this.sessions.values()) {
      if (!s.fileKey || s.ws.readyState !== WebSocket.OPEN) continue;
      const cur = m.get(s.fileKey);
      if (!cur || s.helloAt > cur.newest.helloAt) m.set(s.fileKey, { name: s.fileName, newest: s });
    }
    return m;
  }

  // Newest live session satisfying a bind target, or null. Never guesses
  // across a name that maps to >1 distinct open file (that's ambiguous;
  // the agent must use the fileKey) — such a name simply won't resolve.
  private matchBind(bind: { key?: string; name?: string }): Session | null {
    if (bind.key) return this.newestLive((s) => s.fileKey === bind.key);
    if (bind.name) {
      const nm = bind.name.toLowerCase();
      const hits = [...this.distinctOpenFiles().values()].filter((v) => v.name.toLowerCase() === nm);
      return hits.length === 1 ? hits[0].newest : null;
    }
    return null;
  }

  // The single routing decision. Never guesses among multiple files: a
  // wrong guess silently reads/writes the wrong canvas (the bug agents hit).
  private route(mcp: McpSession): Routing {
    // 1. Honor the resolved live pin while its session is still open.
    if (mcp.activeFileId) {
      const s = this.sessions.get(mcp.activeFileId);
      if (s && s.ws.readyState === WebSocket.OPEN) return { kind: 'ok', session: s };
      mcp.activeFileId = null; // session died (iframe respawn) — re-resolve
    }
    // 2. Bound to a specific file: route there, or defer until it connects.
    //    Never falls to another open file — that silent hop is the bug.
    if (mcp.bind) {
      const match = this.matchBind(mcp.bind);
      if (match) {
        mcp.activeFileId = match.id;
        if (!mcp.bind.key && match.fileKey) mcp.bind.key = match.fileKey; // promote name→key
        return { kind: 'ok', session: match };
      }
      return { kind: 'deferred', bind: mcp.bind, files: this.distinctOpenFiles() };
    }
    // 3. Unbound. One open file → frictionless. Zero → none. Many → ambiguous.
    const files = this.distinctOpenFiles();
    if (files.size === 0) return { kind: 'none' };
    if (files.size === 1) return { kind: 'ok', session: files.values().next().value!.newest };
    return { kind: 'ambiguous', files };
  }

  // Resolve a free-form target (fileKey | exact name | sessionId | figma.com
  // URL) into a bind. Resolves against currently-open files where possible;
  // an unmatched value is held as key (if keyish/URL) or name (deferred).
  private resolveBind(input: string): { key?: string; name?: string } {
    const trimmed = input.trim();
    const url = trimmed.match(PluginBridge.FIGMA_URL_RE);
    if (url) return { key: url[1] };
    // sessionId of an open plugin → its fileKey
    const sess = this.sessions.get(trimmed);
    if (sess && sess.fileKey) return { key: sess.fileKey };
    const files = this.distinctOpenFiles();
    if (files.has(trimmed)) return { key: trimmed };
    const nameHits = [...files.entries()].filter(([, v]) => v.name.toLowerCase() === trimmed.toLowerCase());
    if (nameHits.length === 1) return { key: nameHits[0][0] };
    if (nameHits.length > 1) {
      throw new Error(
        `ambiguous_file_name: "${trimmed}" matches ${nameHits.length} open files ` +
          `(${nameHits.map(([k]) => k).join(', ')}). Use the fileKey.`,
      );
    }
    // Unresolved → defer. Bare Figma-style keys are ≥16 url-safe chars, no spaces.
    if (/^[A-Za-z0-9]{16,}$/.test(trimmed)) return { key: trimmed };
    return { name: trimmed };
  }

  // Apply a launch-time (GRIP_FILE) binding. Best-effort: a bad target is
  // logged and ignored — the agent still works (just unbound).
  bindFromLaunch(target: string, mcp: McpSession): void {
    try {
      const bind = this.resolveBind(target);
      mcp.bind = bind;
      mcp.activeFileId = null;
      const match = this.matchBind(bind);
      if (match) {
        mcp.activeFileId = match.id;
        if (!bind.key && match.fileKey) bind.key = match.fileKey;
      }
      process.stderr.write(
        `[grip] mcp ${mcp.id.slice(0, 8)} launch-bound → ${bind.key ?? bind.name} (${match ? 'resolved' : 'deferred'})\n`,
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

  private fileList(files: FileMap): string {
    return [...files.entries()].map(([key, v]) => `"${v.name}" (${key})`).join(', ');
  }

  private ambiguousError(files: FileMap): Error {
    return new Error(
      `ambiguous_active_file: ${files.size} Figma files are open (${this.fileList(files)}). ` +
        `grip won't guess which one — call set_active_file with the fileKey, file name, or sessionId of your ` +
        `target first, or use list_files to see them. This is deliberate: guessing silently reads/writes the wrong file.`,
    );
  }

  private deferredError(bind: { key?: string; name?: string }, files: FileMap): Error {
    const label = bind.key ? `fileKey ${bind.key}` : `file "${bind.name}"`;
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

    if ('event' in msg) {
      const sess = this.sessions.get(sessionId);
      this.emit('event', { ...msg, sessionId, fileKey: sess?.fileKey ?? '' } as WSEvent & { sessionId: string; fileKey: string });
      return;
    }

    if ('id' in msg) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timeout);
      // Response-size backstop. An un-upgraded plugin (no nodeBudget cap)
      // can return a multi-MB serialized tree; ferrying that to the agent
      // and parsing it into context is what produces the 120s+ "idle"
      // stall (the plugin answered fast, the client choked). Reject early
      // with an actionable, typed error instead.
      if (raw.length > RESPONSE_SOFT_CAP_BYTES) {
        pending.reject(new Error(
          `response_too_large: ${Math.round(raw.length / 1024)}KB exceeds ${Math.round(RESPONSE_SOFT_CAP_BYTES / 1024)}KB. ` +
          `Re-call with depth + maxNodes to bound it (e.g. depth:3, maxNodes:500), or reload the plugin if it predates the nodeBudget cap.`,
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
    sess.fileKey = hello.fileKey;
    sess.fileName = hello.fileName;
    sess.currentPageId = hello.currentPageId;
    sess.currentPageName = hello.currentPageName;
    sess.helloAt = Date.now();
    sess.pluginVersion = hello.version ?? 'unknown';
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
    this.emit('session-change');
  }

  private dropSession(sessionId: string) {
    const sess = this.sessions.get(sessionId);
    if (!sess) return;
    if (sess.pingTimer) clearInterval(sess.pingTimer);
    this.sessions.delete(sessionId);
    process.stderr.write(`[grip] session ${sessionId.slice(0, 8)} closed (${this.sessions.size} remain)\n`);

    // Fail any in-flight requests bound to that session.
    for (const [reqId, p] of this.pending) {
      if (p.sessionId === sessionId) {
        clearTimeout(p.timeout);
        p.reject(new Error('plugin_disconnected: Plugin disconnected'));
        this.pending.delete(reqId);
      }
    }

    // Per-MCP-session pins clean themselves up lazily in resolveActiveId
    // when the pinned plugin is gone.
    this.emit('session-change');
  }

  close() {
    for (const [, p] of this.pending) {
      clearTimeout(p.timeout);
      p.reject(new Error('leader_shutdown: Bridge shutting down'));
    }
    this.pending.clear();
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
        fileName: s.fileName,
        currentPageId: s.currentPageId,
        currentPageName: s.currentPageName,
        pluginVersion: s.pluginVersion ?? 'unknown',
        capabilities: s.capabilities ?? [],
        wsReady: s.ws.readyState === WebSocket.OPEN,
        lastPongMsAgo: s.lastPong ? Date.now() - s.lastPong : null,
      })),
    };
  }
}
