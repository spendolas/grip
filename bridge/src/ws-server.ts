import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuid } from 'uuid';
import { EventEmitter } from 'events';
import type { McpSession, PluginSessionInfo, WSEvent, WSHello, WSResponse } from './types.js';

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

const REQUEST_TIMEOUT_MS = 10_000;          // tighter than before; matches heartbeat
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
const BRIDGE_VERSION = '0.2.3';
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

  setActive(target: string, mcp: McpSession): PluginSessionInfo {
    // Match by sessionId first, then fileKey (more agent-friendly).
    let match = this.sessions.get(target);
    if (!match) {
      for (const s of this.sessions.values()) {
        if (s.fileKey === target) { match = s; break; }
      }
    }
    if (!match) throw new Error(`No connected plugin matches '${target}'`);
    mcp.activeFileId = match.id;
    mcp.activeFileKey = match.fileKey || null;
    process.stderr.write(`[grip] mcp ${mcp.id.slice(0, 8)} → plugin ${match.id.slice(0, 8)} (${match.fileName})\n`);
    return {
      sessionId: match.id,
      fileKey: match.fileKey,
      fileName: match.fileName,
      currentPageId: match.currentPageId,
      currentPageName: match.currentPageName,
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
    const session = await this.waitForPlugin(mcp, PluginBridge.PLUGIN_WAIT_MS);
    if (!session) throw new Error('plugin_disconnected: No plugin connected');
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
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`request_timeout: '${method}' exceeded ${REQUEST_TIMEOUT_MS / 1000}s`));
        }
      }, REQUEST_TIMEOUT_MS);
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

  private resolveActiveId(mcp: McpSession): string | null {
    // 1. Honor an explicit pin while its session is still live.
    if (mcp.activeFileId) {
      const s = this.sessions.get(mcp.activeFileId);
      if (s && s.ws.readyState === WebSocket.OPEN) return s.id;
      // Pinned session died (iframe respawned on Figma's 1–3min cycle).
      // Re-pin to the live session for the SAME FILE rather than silently
      // falling to another open file — that silent file-hop is what made
      // page-scoped reads return [] against the wrong canvas.
      mcp.activeFileId = null;
      if (mcp.activeFileKey) {
        const same = this.newestLive((s) => s.fileKey === mcp.activeFileKey);
        if (same) {
          mcp.activeFileId = same.id;
          process.stderr.write(
            `[grip] mcp ${mcp.id.slice(0, 8)} re-pinned to ${same.id.slice(0, 8)} (${same.fileName}) after reconnect\n`,
          );
          return same.id;
        }
      }
    }
    // 2. No usable pin. Auto-pick the newest live session.
    const pick = this.newestLive(() => true);
    if (!pick) return null;
    // Warn when auto-picking among multiple distinct files — the agent has
    // not chosen one, and the wrong guess produces silent off-file reads.
    const fileKeys = new Set<string>();
    for (const s of this.sessions.values()) {
      if (s.fileKey && s.ws.readyState === WebSocket.OPEN) fileKeys.add(s.fileKey);
    }
    if (fileKeys.size > 1) {
      process.stderr.write(
        `[grip] mcp ${mcp.id.slice(0, 8)} auto-picked ${pick.fileName} among ${fileKeys.size} open files — ` +
          `use set_active_file to pin a target\n`,
      );
    }
    return pick.id;
  }

  private activeSession(mcp: McpSession): Session | null {
    const id = this.resolveActiveId(mcp);
    return id ? this.sessions.get(id) ?? null : null;
  }

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
