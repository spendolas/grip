import { Socket } from 'node:net';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  JSONRPCMessageSchema,
  type JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js';

// MCP SDK Transport that reads/writes newline-delimited JSON-RPC frames
// over a Node socket. Used for IPC between the leader bridge and proxy
// processes, both directions (proxy uses raw socket; leader wraps each
// inbound socket with this transport and feeds an MCP Server).

// 10 MB cap on an in-flight buffer for a single line. Prevents one
// misbehaving peer from OOM'ing the bridge by streaming a frame that
// never terminates with a newline.
const MAX_FRAME_BYTES = 10 * 1024 * 1024;

export class SocketTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
  // Out-of-band grip control frames (e.g. {grip:'bind',...}) sent by the
  // shim ahead of MCP traffic. Routed here instead of being mis-parsed as
  // JSON-RPC. Shim + daemon are the same binary, so the shape is in sync.
  onControl?: (msg: Record<string, unknown>) => void;

  private buf = '';
  private started = false;
  private closed = false;

  constructor(private socket: Socket) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk: string) => {
      this.buf += chunk;
      if (this.buf.length > MAX_FRAME_BYTES) {
        const err = new Error(
          `frame_too_large: ${this.buf.length} bytes (cap ${MAX_FRAME_BYTES}); closing socket`,
        );
        this.onerror?.(err);
        try { this.socket.destroy(); } catch {}
        this.buf = '';
        return;
      }
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        let json: unknown;
        try {
          json = JSON.parse(line);
        } catch (err) {
          this.onerror?.(err as Error);
          continue;
        }
        // Grip control frame — not JSON-RPC. Route out-of-band, don't error.
        if (json && typeof json === 'object' && 'grip' in (json as object)) {
          this.onControl?.(json as Record<string, unknown>);
          continue;
        }
        try {
          this.onmessage?.(JSONRPCMessageSchema.parse(json));
        } catch (err) {
          this.onerror?.(err as Error);
        }
      }
    });
    this.socket.on('close', () => {
      if (this.closed) return;
      this.closed = true;
      this.onclose?.();
    });
    this.socket.on('error', (err) => {
      this.onerror?.(err);
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.write(JSON.stringify(message) + '\n', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.socket.end();
    this.onclose?.();
  }
}
