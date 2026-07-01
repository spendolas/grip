import { connect, Socket } from 'node:net';

// Lost the leader-bind race. Run as a proxy: parse JSON-RPC frames from
// stdio so we can emit typed errors when the leader dies mid-request,
// then pipe everything else through to the leader's IPC socket.
//
// runProxy returns a boolean to its caller (index.ts main loop):
//   true  → the leader dropped or never showed up; caller should re-run
//           role detection (this process may now win the WS bind).
//   false → our own stdin EOF'd, the parent MCP client is gone for good;
//           caller should let the process exit.
//
// On socket close mid-request we synthesize a JSON-RPC error response
// for every in-flight id so the client sees an actionable, typed error
// instead of the generic -32000 "Connection closed" and can retry.

const RETRY_DELAYS_MS = [50, 100, 200, 400, 800];

async function tryConnect(path: string): Promise<Socket | null> {
  for (const delay of [0, ...RETRY_DELAYS_MS]) {
    if (delay) await sleep(delay);
    try {
      return await new Promise<Socket>((resolve, reject) => {
        const sock = connect(path);
        const onError = (err: Error) => { sock.destroy(); reject(err); };
        sock.once('error', onError);
        sock.once('connect', () => {
          sock.removeListener('error', onError);
          resolve(sock);
        });
      });
    } catch {
      // ignore and retry
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Single shared stdin reader. Bound once, swappable handler so we can
// stop forwarding without losing chunks across reconnect cycles.
let stdinHooked = false;
let onStdinLine: ((line: string) => void) | null = null;
function hookStdin() {
  if (stdinHooked) return;
  stdinHooked = true;
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) onStdinLine?.(line);
    }
  });
}

export async function runProxy(ipcPath: string): Promise<boolean> {
  const sock = await tryConnect(ipcPath);
  if (!sock) {
    process.stderr.write(`[grip] proxy: no leader at ${ipcPath}, re-detecting role\n`);
    return true;
  }
  process.stderr.write(`[grip] proxy attached to leader at ${ipcPath}\n`);

  hookStdin();

  // Track in-flight request ids. On close we emit a typed error response
  // for each so the client never gets a silent -32000 hang.
  const inflight = new Map<string | number, string>();

  onStdinLine = (line: string) => {
    try {
      const msg = JSON.parse(line);
      if (msg && msg.id !== undefined && typeof msg.method === 'string') {
        inflight.set(msg.id, msg.method);
      }
    } catch {
      // not JSON, still forward
    }
    sock.write(line + '\n');
  };

  // Parse responses from leader so we can untrack ids.
  let inBuf = '';
  sock.setEncoding('utf8');
  sock.on('data', (chunk: string) => {
    inBuf += chunk;
    let nl: number;
    while ((nl = inBuf.indexOf('\n')) >= 0) {
      const line = inBuf.slice(0, nl);
      inBuf = inBuf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg && msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
          inflight.delete(msg.id);
        }
      } catch {}
      process.stdout.write(line + '\n');
    }
  });

  return new Promise<boolean>((resolve) => {
    let resolved = false;
    const settle = (retry: boolean, reason: string, code: string) => {
      if (resolved) return;
      resolved = true;
      process.stderr.write(`[grip] proxy: ${reason} (${inflight.size} inflight)\n`);
      // Tell the client about each dropped in-flight request with a typed
      // error so it can retry cleanly. Without this, MCP SDK surfaces a
      // generic -32000 Connection closed and the agent has no signal.
      for (const [id, method] of inflight) {
        const errPayload = {
          jsonrpc: '2.0' as const,
          id,
          error: {
            code: -32000,
            message: `${code}: ${reason} (method=${method}); retry safe`,
            data: { code, method, retry: true },
          },
        };
        try { process.stdout.write(JSON.stringify(errPayload) + '\n'); } catch {}
      }
      inflight.clear();
      onStdinLine = null;
      try { sock.destroy(); } catch {}
      resolve(retry);
    };

    sock.on('close', () => settle(true, 'leader socket closed, re-detecting role', 'leader_dropped'));
    sock.on('error', (err) => settle(true, `socket error: ${err.message}`, 'socket_error'));
    process.stdin.on('end', () => {
      try { sock.end(); } catch {}
      settle(false, 'stdin closed, exiting', 'stdin_closed');
    });
  });
}
