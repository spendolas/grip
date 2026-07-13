import { createServer, type Server as NetServer } from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';
import { createSession, destroySession } from './mcp-server.js';
import { SocketTransport } from './socket-transport.js';
import type { PluginBridge } from './ws-server.js';

// Leader-side IPC server. Each accepted connection is a separate MCP
// session — the proxy on the other end forwards stdio JSON-RPC bytes
// straight through.

const PARSE_ERROR_THRESHOLD = 5;

export class IpcServer {
  private server: NetServer;

  constructor(private path: string, private bridge: PluginBridge) {
    this.server = createServer((socket) => {
      const live = createSession(this.bridge);
      const transport = new SocketTransport(socket);
      // Launch-time file binding: the shim forwards GRIP_FILE as a control
      // frame ahead of MCP traffic. Applied to this session so the agent is
      // routed to its file without ever calling a tool. Set before connect()
      // so it's ready when the transport starts reading.
      transport.onControl = (msg) => {
        if (msg.grip === 'bind' && typeof msg.target === 'string') {
          this.bridge.bindFromLaunch(msg.target, live.session);
        }
      };
      let cleaned = false;
      const cleanup = (reason: string) => {
        if (cleaned) return;
        cleaned = true;
        destroySession(live);
        process.stderr.write(`[grip] ipc client gone (${live.session.id.slice(0, 8)}) ${reason}\n`);
      };

      // Hook the underlying socket — MCP SDK's server.connect() overrides
      // transport.onclose with its own handler, so we can't rely on that
      // path to fire destroySession. Direct socket events always fire.
      socket.on('close', () => cleanup('socket close'));
      socket.on('error', (err) => {
        process.stderr.write(`[grip] ipc socket error (${live.session.id.slice(0, 8)}): ${err.message}\n`);
      });

      // Watch parse errors. A flapping proxy that streams garbage frames
      // can otherwise peg V8 building stack traces. Drop the noisy peer.
      let parseErrors = 0;
      transport.onerror = (err) => {
        parseErrors++;
        process.stderr.write(`[grip] ipc parse error #${parseErrors} (${live.session.id.slice(0, 8)}): ${err.message}\n`);
        if (parseErrors >= PARSE_ERROR_THRESHOLD) {
          process.stderr.write(`[grip] dropping noisy ipc client (${live.session.id.slice(0, 8)})\n`);
          try { socket.destroy(); } catch {}
          cleanup('parse-error threshold');
        }
      };

      live.server.connect(transport).then(
        () => {
          process.stderr.write(`[grip] ipc client attached (${live.session.id.slice(0, 8)})\n`);
        },
        (err: Error) => {
          process.stderr.write(`[grip] ipc connect failed: ${err.message}\n`);
          cleanup('connect-failed');
          socket.destroy();
        },
      );
    });

    this.server.on('error', (err: Error & { code?: string }) => {
      process.stderr.write(`[grip] ipc server error: ${err.code ?? err.message}\n`);
    });
  }

  async listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const start = (retried = false) => {
        const onErr = (err: Error & { code?: string }) => {
          if (err.code === 'EADDRINUSE' && !retried && existsSync(this.path)) {
            // Stale socket from a crashed leader. Remove and retry once.
            try { unlinkSync(this.path); } catch {}
            this.server.removeListener('error', onErr);
            start(true);
            return;
          }
          reject(err);
        };
        this.server.once('error', onErr);
        this.server.listen(this.path, () => {
          this.server.removeListener('error', onErr);
          process.stderr.write(`[grip] ipc server listening on ${this.path}\n`);
          resolve();
        });
      };
      start();
    });
  }

  close() {
    this.server.close();
    if (existsSync(this.path)) {
      try { unlinkSync(this.path); } catch {}
    }
  }
}
