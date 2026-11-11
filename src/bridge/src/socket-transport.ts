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
// Until a connection has delivered one valid frame (a real shim or HTTP-less client starts with a
// tiny initialize or control frame) it may park at most this much, and all connections together
// may park at most PARKED_BUDGET bytes of unfinished frames: ten sockets each holding a 9MB frame
// with no newline otherwise cost ~90MB, forty cost half a gigabyte. Env overrides are for tests.
const FIRST_FRAME_BYTES = Number(process.env.GRIP_IPC_FIRST_FRAME_BYTES ?? 1024 * 1024);
const PARKED_BUDGET = Number(process.env.GRIP_IPC_PARKED_BYTES ?? 64 * 1024 * 1024);
let parkedTotal = 0;

export class SocketTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
  // Out-of-band grip control frames (e.g. {grip:'bind',...}) sent by the
  // shim ahead of MCP traffic. Routed here instead of being mis-parsed as
  // JSON-RPC. Shim + daemon are the same binary, so the shape is in sync.
  onControl?: (msg: Record<string, unknown>) => void;

  private parts: string[] = [];
  private partLen = 0;
  private validSeen = false;
  private started = false;
  private closed = false;

  constructor(private socket: Socket) {}

  // Track this connection's parked bytes in the process-wide total.
  private setParked(n: number): void {
    parkedTotal += n - this.partLen;
    this.partLen = n;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.socket.setEncoding('utf8');
    // A frame is one line. Chunks without a newline are only counted and parked, never
    // re-scanned or re-joined: appending to one big string and searching all of it on every
    // 64KB chunk is quadratic, and a 9MB frame with no newline pegged the daemon's CPU.
    const tooLarge = (len: number, why = `cap ${MAX_FRAME_BYTES}`) => {
      const err = new Error(`frame_too_large: ${len} bytes (${why}); closing socket`);
      this.onerror?.(err);
      try { this.socket.destroy(); } catch {}
      this.parts = []; this.setParked(0);
    };
    // Is the parked partial frame still allowed to grow?
    const checkParked = () => {
      if (this.partLen > MAX_FRAME_BYTES) { tooLarge(this.partLen); return; }
      if (!this.validSeen && this.partLen > FIRST_FRAME_BYTES) { tooLarge(this.partLen, `cap ${FIRST_FRAME_BYTES} before the first valid frame`); return; }
      if (parkedTotal > PARKED_BUDGET) tooLarge(this.partLen, `connections hold ${Math.round(parkedTotal / 1048576)}MB of unfinished frames, budget ${Math.round(PARKED_BUDGET / 1048576)}MB`);
    };
    this.socket.on('data', (chunk: string) => {
      if (chunk.indexOf('\n') < 0) {
        this.parts.push(chunk);
        this.setParked(this.partLen + chunk.length);
        checkParked();
        return;
      }
      const buf = this.parts.length ? this.parts.join('') + chunk : chunk;
      this.parts = []; this.setParked(0);
      let start = 0;
      let nl: number;
      while ((nl = buf.indexOf('\n', start)) >= 0) {
        const line = buf.slice(start, nl).trim();
        start = nl + 1;
        if (!line) continue;
        let json: unknown;
        try {
          json = JSON.parse(line);
          this.validSeen = true;
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
      if (start < buf.length) {
        const rest = buf.slice(start);
        this.parts = [rest]; this.setParked(rest.length);
        checkParked();
      }
    });
    this.socket.on('close', () => {
      this.parts = []; this.setParked(0);
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
