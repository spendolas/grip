import { createServer, type Server as HttpNetServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { v4 as uuid } from 'uuid';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createSession, destroySession, type LiveSession } from './mcp-server.js';
import type { PluginBridge } from './ws-server.js';

// Direct HTTP MCP transport for the daemon. Clients (Claude Hub, Claude
// Code) connect to http://127.0.0.1:<port>/mcp by URL — NO per-process shim,
// NO IPC hop. This removes the class of stall where a shim died mid-call and
// the agent hung with no counterparty to emit an error: over HTTP the client
// talks to the long-lived daemon directly, and a dead daemon is an instant
// connection error, not a silent 142s hang.
//
// Each MCP session gets its own StreamableHTTPServerTransport (stateful mode)
// wired to a transport-agnostic createSession() — the identical LiveSession
// the IPC and stdio paths use, so routing/binding/rate-limits are shared and
// HTTP sessions are counted by activeSessionCount() (keeps the daemon warm).

const SESSION_IDLE_MS = 5 * 60_000; // reap a session with no activity this long

interface HttpSession {
  transport: StreamableHTTPServerTransport;
  live: LiveSession;
  lastActivity: number;
}

export class HttpServer {
  private server: HttpNetServer;
  private sessions = new Map<string, HttpSession>();
  private sweepTimer?: NodeJS.Timeout;

  constructor(private port: number, private bridge: PluginBridge) {
    this.server = createServer((req, res) => this.onRequest(req, res));
    this.server.on('error', (err: Error & { code?: string }) => {
      process.stderr.write(`[grip] http server error: ${err.code ?? err.message}\n`);
    });
  }

  private onRequest(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/mcp') {
      // Cheap liveness probe; everything else 404s.
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('grip ok\n');
      } else {
        res.writeHead(404).end();
      }
      return;
    }
    const handler =
      req.method === 'POST' ? this.handlePost(req, res)
      : req.method === 'GET' || req.method === 'DELETE' ? this.handleSession(req, res)
      : Promise.resolve(res.writeHead(405).end());
    handler.catch((err: Error) => {
      process.stderr.write(`[grip] http request error: ${err.message}\n`);
      if (!res.headersSent) res.writeHead(500).end();
    });
  }

  // POST /mcp — an existing session (mcp-session-id header) or a new one
  // (no header → an initialize request; the transport mints the sessionId).
  private async handlePost(req: IncomingMessage, res: ServerResponse) {
    const sid = req.headers['mcp-session-id'];
    if (typeof sid === 'string') {
      const entry = this.sessions.get(sid);
      if (!entry) { res.writeHead(404).end('unknown mcp-session-id'); return; }
      entry.lastActivity = Date.now();
      return entry.transport.handleRequest(req, res);
    }
    // New session. createSession is transport-agnostic — identical to the
    // IPC/stdio path. The transport clobbers Transport.onclose in
    // server.connect(), so teardown is driven off onsessionclosed (DELETE)
    // + a chained onclose + the idle sweep, mirroring ipc-server's pattern.
    const live = createSession(this.bridge);
    // Tool scoping over HTTP: no shim-over-HTTP exists to forward GRIP_TOOLS
    // env per-agent, so a direct HTTP client picks its scope via a `?tools=`
    // query param on the initialize request itself (e.g. "?tools=core,motion").
    // Read only here — session creation — never on a reused mcp-session-id,
    // so a later POST on an already-initialized session can't clobber it.
    const tools = new URL(req.url ?? '/', 'http://localhost').searchParams.get('tools');
    if (tools) live.session.toolScopeSpec = tools;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => uuid(),
      onsessioninitialized: (id) => {
        this.sessions.set(id, { transport, live, lastActivity: Date.now() });
        process.stderr.write(`[grip] http session ${id.slice(0, 8)} initialized (${this.sessions.size} http)\n`);
      },
      onsessionclosed: (id) => this.cleanup(id, 'client DELETE'),
    });
    await live.server.connect(transport);
    const serverOnClose = transport.onclose;
    transport.onclose = () => {
      serverOnClose?.();
      if (transport.sessionId) this.cleanup(transport.sessionId, 'transport close');
    };
    return transport.handleRequest(req, res);
  }

  // GET (SSE stream) / DELETE (teardown) — must carry a known session id.
  private async handleSession(req: IncomingMessage, res: ServerResponse) {
    const sid = req.headers['mcp-session-id'];
    const entry = typeof sid === 'string' ? this.sessions.get(sid) : undefined;
    if (!entry) { res.writeHead(400).end('missing or unknown mcp-session-id'); return; }
    entry.lastActivity = Date.now();
    return entry.transport.handleRequest(req, res);
  }

  private cleanup(sessionId: string, reason: string) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.sessions.delete(sessionId);
    try { destroySession(entry.live); } catch {}
    try { void entry.transport.close(); } catch {}
    process.stderr.write(`[grip] http session ${sessionId.slice(0, 8)} gone (${reason}), ${this.sessions.size} left\n`);
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  // Resolves true if listening, false if the port was taken (daemon keeps
  // running WS+IPC without HTTP rather than dying — WS :7777 is the real
  // single-instance lock). Rejects only on unexpected errors.
  listen(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const onErr = (err: Error & { code?: string }) => {
        this.server.removeListener('error', onErr);
        if (err.code === 'EADDRINUSE') {
          process.stderr.write(`[grip] http port ${this.port} in use; skipping HTTP transport\n`);
          resolve(false);
        } else {
          reject(err);
        }
      };
      this.server.once('error', onErr);
      this.server.listen(this.port, '127.0.0.1', () => {
        this.server.removeListener('error', onErr);
        process.stderr.write(`[grip] http server listening on 127.0.0.1:${this.port}/mcp\n`);
        // Reap sessions whose client vanished without a DELETE, so a leaked
        // LiveSession can't pin the daemon alive (activeSessionCount) forever.
        this.sweepTimer = setInterval(() => {
          const now = Date.now();
          for (const [id, e] of this.sessions) {
            if (now - e.lastActivity > SESSION_IDLE_MS) this.cleanup(id, 'idle');
          }
        }, 60_000);
        this.sweepTimer.unref();
        resolve(true);
      });
    });
  }

  close() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const [id] of this.sessions) this.cleanup(id, 'daemon shutdown');
    try { this.server.close(); } catch {}
  }
}
