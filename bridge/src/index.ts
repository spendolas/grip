#!/usr/bin/env node
// Cap V8's lazy source-rendering work for any Error.stack lookup. Default
// is 10 frames + full source-position walk per frame, which on hot error
// paths (heartbeat reject loops, rate-limit retries) lights up the V8
// parser/CallPrinter and pegs CPU. 3 short frames is enough to debug
// real bugs without the quadratic.
Error.stackTraceLimit = 3;

import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { openSync, writeSync, closeSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { connect } from 'node:net';
import { PluginBridge } from './ws-server.js';
import { activeSessionCount } from './mcp-server.js';
import { IpcServer } from './ipc-server.js';
import { runProxy } from './proxy.js';

const WS_PORT = Number(process.env.GRIP_WS_PORT ?? 7777);
const IPC_PATH = process.env.GRIP_IPC_PATH ?? join(tmpdir(), 'grip-bridge.sock');
const STATUS_PATH = process.env.GRIP_STATUS_PATH ?? join(homedir(), '.grip-bridge.status');
const IS_DAEMON = process.argv.includes('--daemon');
const IDLE_GRACE_MS = 60_000;       // daemon exits this long after 0 plugins AND 0 shims
const MAX_LIFETIME_MS = 6 * 60 * 60 * 1000;
const BRIDGE_VERSION = '0.2.3';

// Mirror stderr to ~/.grip-bridge.log (or GRIP_LOG_PATH) so forensics
// survive across crashes. Done in-process — no bash wrap, no PATH issue.
// Goes to both real stderr (so MCP clients can read it) AND the file.
(() => {
  try {
    const path = process.env.GRIP_LOG_PATH ?? join(homedir(), '.grip-bridge.log');
    const fd = openSync(path, 'a');
    writeSync(fd, `\n=== started pid=${process.pid} role=${IS_DAEMON ? 'daemon' : 'shim'} at ${new Date().toISOString()} ===\n`);
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: any, ...rest: any[]) => {
      try { writeSync(fd, typeof chunk === 'string' ? chunk : chunk.toString()); } catch {}
      return origWrite(chunk, ...rest);
    };
    process.on('exit', () => { try { closeSync(fd); } catch {} });
  } catch {
    // logging is best-effort; never block startup
  }
})();

// Ignore SIGHUP everywhere. When our parent (claude -p one-shot) exits,
// the kernel sends SIGHUP to children — default action terminates. We
// want the bridge to survive parent death so other Claude sessions can
// keep attaching. SIGINT/SIGTERM still take us down cleanly.
process.on('SIGHUP', () => {
  process.stderr.write('[grip] SIGHUP ignored (parent exited; staying alive for proxies)\n');
});

// Daemon: bind the WS port. Success → we are the single daemon. Bind
// error → another daemon already owns it; resolve null so we exit. The
// port bind is the atomic single-instance lock.
function tryBindWs(): Promise<PluginBridge | null> {
  return new Promise((resolve) => {
    const bridge = new PluginBridge(WS_PORT);
    bridge.once('listening', () => resolve(bridge));
    bridge.once('bind-error', () => resolve(null));
  });
}

// Best-effort forensic dump triggered when the watchdog is about to
// self-exit. Synchronous + minimal allocations so we don't recurse into
// whatever just hung us. Lands in ~/.grip-bridge.dump-<ts>.json.
function dumpForensics(reason: string, extra: Record<string, unknown>, bridge?: PluginBridge) {
  try {
    const path = join(homedir(), `.grip-bridge.dump-${Date.now()}.json`);
    const snap = bridge?.snapshot?.() ?? null;
    const cpu = process.cpuUsage();
    const mem = process.memoryUsage();
    const body = {
      reason,
      pid: process.pid,
      version: BRIDGE_VERSION,
      uptimeS: Math.round(process.uptime()),
      cpu: { userMs: cpu.user / 1000, systemMs: cpu.system / 1000 },
      memMb: {
        rss: Math.round(mem.rss / 1024 / 1024),
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
        external: Math.round(mem.external / 1024 / 1024),
      },
      snapshot: snap,
      extra,
      timestamp: new Date().toISOString(),
    };
    writeFileSync(path, JSON.stringify(body, null, 2));
    process.stderr.write(`[grip] forensic dump written to ${path}\n`);
  } catch (err) {
    process.stderr.write(`[grip] dump failed: ${(err as Error).message}\n`);
  }
}

// Watchdog. Catches two stuck patterns:
//   (a) Event-loop blocked: a single sync task running >2s. The 1s timer
//       can't fire on time → lag accumulates. Trips after sustained lag.
//   (b) CPU pegged but loop still ticking: an inner loop doing many tiny
//       async iterations (e.g. V8 reparsing source for error traces). Lag
//       stays low while CPU stays at 100%. Trips on cpuUsage delta.
function startWatchdog(bridge: PluginBridge) {
  const SAMPLE_MS = 1000;
  const LAG_THRESHOLD_MS = 2_000;
  const LAG_TICKS_TO_EXIT = 10;
  const CPU_HIGH_RATIO = 0.85;          // 85% of one core
  const CPU_TICKS_TO_EXIT = 5;          // 5s sustained
  let lastTick = Date.now();
  let lagTicks = 0;
  let cpuTicks = 0;
  let lastCpu = process.cpuUsage();
  setInterval(() => {
    const now = Date.now();
    const lag = now - lastTick - SAMPLE_MS;
    lastTick = now;

    const cpu = process.cpuUsage();
    const userMs = (cpu.user - lastCpu.user) / 1000;
    const sysMs = (cpu.system - lastCpu.system) / 1000;
    lastCpu = cpu;
    const ratio = (userMs + sysMs) / SAMPLE_MS;

    if (lag > LAG_THRESHOLD_MS) {
      lagTicks++;
      process.stderr.write(`[grip] watchdog lag ${lag}ms (#${lagTicks})\n`);
      if (lagTicks >= LAG_TICKS_TO_EXIT) {
        process.stderr.write('[grip] watchdog: event loop hung, self-exiting\n');
        dumpForensics('event_loop_hung', { lagMs: lag, lagTicks }, bridge);
        process.exit(2);
      }
    } else if (lagTicks > 0) {
      lagTicks = 0;
    }

    if (ratio > CPU_HIGH_RATIO) {
      cpuTicks++;
      process.stderr.write(`[grip] watchdog cpu ${(ratio * 100).toFixed(0)}% (#${cpuTicks})\n`);
      if (cpuTicks >= CPU_TICKS_TO_EXIT) {
        process.stderr.write('[grip] watchdog: cpu pegged, self-exiting\n');
        dumpForensics('cpu_pegged', { cpuRatio: ratio, cpuTicks }, bridge);
        process.exit(2);
      }
    } else if (cpuTicks > 0) {
      cpuTicks = 0;
    }
  }, SAMPLE_MS).unref();
}

async function runDaemon(bridge: PluginBridge) {
  startWatchdog(bridge);
  const ipc = new IpcServer(IPC_PATH, bridge);
  await ipc.listen();
  // No connectStdio: the daemon is detached with stdio ignored. Its only
  // MCP peers are shims arriving over the IPC socket (one session each).

  // Status file — cheap external probe target. Future tooling can read
  // this instead of paying the MCP-handshake cost to check liveness.
  const startedAt = Date.now();
  const writeStatus = () => {
    try {
      const snap = bridge.snapshot();
      writeFileSync(STATUS_PATH, JSON.stringify({
        pid: process.pid,
        version: BRIDGE_VERSION,
        wsPort: WS_PORT,
        ipcPath: IPC_PATH,
        startedAt,
        uptimeMs: Date.now() - startedAt,
        activeMcpSessions: activeSessionCount(),
        pluginCount: snap.pluginCount,
        pluginsReady: snap.plugins.filter((p) => p.wsReady).length,
        pendingCount: snap.pendingCount,
      }, null, 2));
    } catch {
      // best-effort; never crash on a status write
    }
  };
  writeStatus();
  setInterval(writeStatus, 5_000).unref();
  process.on('exit', () => { try { unlinkSync(STATUS_PATH); } catch {} });

  // Socket-vanished self-heal. macOS periodically sweeps /var/folders tmp
  // dirs; if our IPC socket file is removed out from under us while we hold
  // the WS port, shims can no longer connect and can't spawn a replacement
  // (we still own the port), wedging the whole system. Detect the missing
  // socket and exit so the next shim spawns a clean daemon that rebinds
  // both port and socket. existsSync on a unix socket path is cheap.
  setInterval(() => {
    if (!existsSync(IPC_PATH)) {
      process.stderr.write('[grip] daemon: IPC socket vanished, exiting for clean respawn\n');
      bridge.close();
      process.exit(2);
    }
  }, 5_000).unref();

  // Lifetime ceiling — exit cleanly after MAX_LIFETIME_MS when no MCP
  // sessions are attached. Avoids slow leaks accumulating across days.
  setInterval(() => {
    if (Date.now() - startedAt < MAX_LIFETIME_MS) return;
    if (activeSessionCount() !== 0) {
      process.stderr.write('[grip] uptime ceiling reached but sessions active; deferring\n');
      return;
    }
    process.stderr.write('[grip] uptime ceiling reached + idle, self-exiting for fresh spawn\n');
    ipc.close();
    bridge.close();
    process.exit(0);
  }, 60_000).unref();

  // Idle shutdown: exit only when there are NO shim sessions AND NO
  // connected plugins for the grace period. While any Figma plugin is
  // open the daemon stays warm, so the common case (Figma running) keeps
  // it alive across agent churn. Fully idle → clean up so nothing lingers.
  let idleTimer: NodeJS.Timeout | null = null;
  const checkIdle = () => {
    const idle = activeSessionCount() === 0 && bridge.snapshot().pluginCount === 0;
    if (idle) {
      if (idleTimer) return;
      idleTimer = setTimeout(() => {
        process.stderr.write('[grip] idle (no shims, no plugins), shutting down\n');
        ipc.close();
        bridge.close();
        process.exit(0);
      }, IDLE_GRACE_MS);
    } else if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };
  setInterval(checkIdle, 5_000).unref();

  const shutdown = async (signal: string) => {
    process.stderr.write(`[grip] ${signal} received, shutting down\n`);
    // Reject any pending plugin requests with typed error so attached MCP
    // clients see actionable codes instead of stdio-just-closed -32000s.
    bridge.close();
    ipc.close();
    // Give the event loop one tick to flush JSON-RPC error frames before
    // we exit; otherwise the stderr->stdout flush races process.exit.
    await new Promise((r) => setImmediate(r));
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
}

// ---------- shim role ----------

// Probe the daemon's IPC socket. Resolves a connected socket or null.
function probeDaemon(): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect(IPC_PATH);
    const done = (ok: boolean) => { try { sock.destroy(); } catch {} resolve(ok); };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    setTimeout(() => done(false), 1000);
  });
}

function spawnDaemonDetached() {
  const self = fileURLToPath(import.meta.url);
  process.stderr.write('[grip] shim: no daemon, spawning detached daemon\n');
  const child = spawn(process.execPath, [self, '--daemon'], {
    detached: true,          // new session/group — immune to our parent's group signals
    stdio: 'ignore',         // fully decoupled; daemon logs to the file via stderr mirror
    env: process.env,
  });
  child.unref();
}

// Ensure a daemon is reachable: probe, and if absent spawn one detached
// then wait for it to bind. Returns true once reachable, false if it
// never came up. Concurrent shims may both spawn — only one daemon wins
// the WS bind; the losers exit(0); every shim then connects to the winner.
async function ensureDaemon(): Promise<boolean> {
  if (await probeDaemon()) return true;
  spawnDaemonDetached();
  for (const delay of [50, 100, 200, 400, 600, 800, 1000, 1000, 1500]) {
    await new Promise((r) => setTimeout(r, delay));
    if (await probeDaemon()) return true;
  }
  return false;
}

async function runShim() {
  while (true) {
    const up = await ensureDaemon();
    if (!up) {
      // Couldn't reach or start a daemon. Surface a typed startup error on
      // stdout so the MCP client fails loudly instead of hanging, then exit.
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: null,
        error: { code: -32000, message: 'daemon_unavailable: grip daemon failed to start; retry the call', data: { code: 'daemon_unavailable', retry: true } },
      }) + '\n');
      process.stderr.write('[grip] shim: daemon unavailable, exiting\n');
      process.exit(1);
    }
    const retry = await runProxy(IPC_PATH);
    if (!retry) return;            // our stdin closed → agent gone → exit
    // retry === true → daemon socket dropped; loop re-ensures (reconnect
    // to a survivor or spawn a fresh daemon) then re-proxies.
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function main() {
  if (IS_DAEMON) {
    const bridge = await tryBindWs();
    if (!bridge) {
      // Another daemon already owns the port. Single-instance lock held
      // elsewhere — exit cleanly; the shim that spawned us will connect
      // to the incumbent.
      process.stderr.write('[grip] daemon: port already bound, exiting\n');
      process.exit(0);
    }
    process.stderr.write(`[grip] role=daemon ws=:${WS_PORT} ipc=${IPC_PATH}\n`);
    await runDaemon(bridge);       // runs forever; only returns on shutdown signal
    return;
  }
  process.stderr.write(`[grip] role=shim ipc=${IPC_PATH}\n`);
  await runShim();
}

main().catch((err) => {
  process.stderr.write(`[grip] fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
