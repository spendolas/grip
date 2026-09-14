import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { v4 as uuid } from 'uuid';
import { readFile, writeFile, stat, open, mkdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TOOLS, toolInputSchema, resolveToolScope, toolInScope, toolCategorySummary, toolDetail,
  MERGED_TOOLS, resolveMerged,
} from './tools.js';
import type { PluginBridge } from './ws-server.js';
import type { McpSession, WSEvent } from './types.js';

// File extension per export format, for auto temp-file naming.
const EXPORT_EXT: Record<string, string> = {
  SVG: 'svg', PNG: 'png', JPG: 'jpg', PDF: 'pdf', CSS: 'css', JSON: 'json',
  MP4: 'mp4', GIF: 'gif', WEBM: 'webm',
};

// Best-effort pixel dimensions from a raster buffer's header — PNG (IHDR) and
// JPEG (SOF marker) only. Returns undefined for anything else (PDF, unknown),
// so callers spread it and simply omit width/height when unavailable.
function rasterDimensions(buf: Buffer): { width: number; height: number } | undefined {
  try {
    // PNG: \x89PNG, then IHDR width/height as big-endian u32 at offsets 16/20.
    if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    // JPEG: scan segments for a Start-Of-Frame marker (C0–CF, excluding
    // C4/C8/CC), whose payload holds height then width as big-endian u16.
    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let o = 2;
      while (o + 9 < buf.length) {
        if (buf[o] !== 0xff) { o++; continue; }
        const marker = buf[o + 1];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(o + 5), width: buf.readUInt16BE(o + 7) };
        }
        o += 2 + buf.readUInt16BE(o + 2); // skip this segment
      }
    }
  } catch { /* malformed header — just omit dims */ }
  return undefined;
}

// Read last N bytes of the bridge log without slurping the whole thing.
async function tailLog(maxBytes = 8192): Promise<string> {
  const path = process.env.GRIP_LOG_PATH ?? join(homedir(), '.grip-bridge.log');
  try {
    const st = await stat(path);
    const start = Math.max(0, st.size - maxBytes);
    const fh = await open(path, 'r');
    try {
      const { buffer } = await fh.read({
        buffer: Buffer.alloc(st.size - start),
        position: start,
      });
      return buffer.toString('utf8');
    } finally {
      await fh.close();
    }
  } catch {
    return '';
  }
}

// Measure event-loop lag right now: schedule a setImmediate, see how
// long until it actually runs. Honest signal of "is this process pegged
// by sync work at this exact moment".
function measureLoopLag(): Promise<number> {
  return new Promise((r) => {
    const t = process.hrtime.bigint();
    setImmediate(() => r(Number(process.hrtime.bigint() - t) / 1e6));
  });
}

// Compact one-line arg summary for the live call log. Truncates strings,
// counts arrays, never dumps a whole node tree into the log.
function summarizeArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    let s: string;
    if (v == null) s = String(v);
    else if (typeof v === 'string') s = v.length > 40 ? `"${v.slice(0, 40)}…"` : `"${v}"`;
    else if (Array.isArray(v)) s = `[${v.length}]`;
    else if (typeof v === 'object') s = `{${Object.keys(v).length}k}`;
    else s = String(v);
    parts.push(`${k}=${s}`);
  }
  const out = parts.join(' ');
  return out.length > 160 ? out.slice(0, 160) + '…' : out;
}

// Chunked image upload state. Lives on the bridge so the per-tool-call
// stdio frame stays small (some MCP clients truncate large argv).
// Cleaned up on finish, on error, or after UPLOAD_TTL_MS idle.
interface PendingUpload {
  chunks: string[];
  total: number;
  createdAt: number;
}
const uploads = new Map<string, PendingUpload>();
const UPLOAD_TTL_MS = 5 * 60_000;
const UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

function reapUploads() {
  const now = Date.now();
  for (const [id, u] of uploads) {
    if (now - u.createdAt > UPLOAD_TTL_MS) uploads.delete(id);
  }
}

export interface LiveSession {
  server: Server;
  session: McpSession;
}

// Bridge-side subscription registration, shared by the merged `subscribe`
// tool. Sets the session flag the event fan-out in wireBridgeEvents() reads
// (no plugin round-trip — the plugin already always emits these events;
// this just decides which sessions receive them as MCP notifications).
// `channel` is the former standalone tool name (e.g. 'subscribe_selection'),
// echoed back in the result for continuity with pre-merge behavior.
function applySubscription(
  session: McpSession,
  kind: 'selection' | 'document' | 'currentPage',
  channel: string,
) {
  session.subscriptions[kind] = true;
  return okResult({ subscribed: true, channel });
}

// Token bucket: refills RATE_LIMIT_REFILL/sec, caps at RATE_LIMIT_BURST.
// Tool calls cost 1; over-cap returns rate_limited error.
const RATE_LIMIT_REFILL = 30;    // tokens per second
const RATE_LIMIT_BURST = 100;    // max bucket size

function rateLimitTake(s: McpSession): boolean {
  const now = Date.now();
  const elapsed = (now - s.rateBucket.lastRefillMs) / 1000;
  s.rateBucket.tokens = Math.min(
    RATE_LIMIT_BURST,
    s.rateBucket.tokens + elapsed * RATE_LIMIT_REFILL,
  );
  s.rateBucket.lastRefillMs = now;
  if (s.rateBucket.tokens < 1) return false;
  s.rateBucket.tokens -= 1;
  return true;
}

const liveSessions: LiveSession[] = [];
let eventsWired = false;

function wireBridgeEvents(bridge: PluginBridge) {
  if (eventsWired) return;
  eventsWired = true;
  bridge.on('event', (evt: WSEvent) => {
    for (const { server, session } of liveSessions) {
      const subbed =
        (evt.event === 'selectionchange' && session.subscriptions.selection) ||
        (evt.event === 'documentchange' && session.subscriptions.document) ||
        (evt.event === 'currentpagechange' && session.subscriptions.currentPage);
      if (!subbed) continue;
      server
        .notification({
          method: 'notifications/message',
          params: {
            level: 'info',
            logger: 'grip',
            data: { event: evt.event, payload: evt.data },
          },
        })
        .catch((err: Error) => {
          process.stderr.write(`[grip] notification failed: ${err.message}\n`);
        });
    }
  });
}

export function createSession(bridge: PluginBridge): LiveSession {
  wireBridgeEvents(bridge);

  const session: McpSession = {
    id: uuid(),
    activeFileId: null,
    bind: null,
    subscriptions: { selection: false, document: false, currentPage: false },
    rateBucket: { tokens: RATE_LIMIT_BURST, lastRefillMs: Date.now() },
    toolScopeSpec: null,
  };
  const server = new Server(
    { name: 'grip', version: '0.1.0' },
    { capabilities: { tools: {}, logging: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const scope = resolveToolScope(session.toolScopeSpec);
    return {
      tools: TOOLS.filter((t) => toolInScope(t.name, scope)).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: toolInputSchema(t.name),
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const sid = session.id.slice(0, 8);
    const t0 = Date.now();
    // Live call log: who (mcp session), what (tool + compact args), and —
    // emitted on completion below — how long + outcome size. Captures
    // every agent because the leader handles all stdio + proxy sessions.
    process.stderr.write(`[grip] » ${sid} ${name} ${summarizeArgs(args)}\n`);
    // run_script is the one tool that can freeze Figma's main thread; the
    // 40-char arg summary is useless for post-mortem. Log its FULL code to
    // the file so a freeze can be diagnosed after the fact.
    if (name === 'run_script' && typeof (args as any).code === 'string') {
      process.stderr.write(`[grip] run_script[${sid}] code:\n${(args as any).code}\n[grip] run_script[${sid}] /code\n`);
    }
    const res = await handleCall(name, args);
    const ms = Date.now() - t0;
    const isErr = (res as any)?.isError;
    const text = (res as any)?.content?.[0]?.text ?? '';
    const size = typeof text === 'string' ? text.length : 0;
    process.stderr.write(
      `[grip] « ${sid} ${name} ${ms}ms ${isErr ? 'ERR ' + String(text).slice(0, 100) : size + 'B'}\n`,
    );
    return res;
  });

  async function handleCall(name: string, args: Record<string, unknown>) {
    const def = TOOLS.find((t) => t.name === name);
    if (!def) return errorResult(`Unknown tool: ${name}`);

    const parsed = def.schema.safeParse(args);
    if (!parsed.success) {
      return errorResult(`Invalid params for ${name}: ${parsed.error.message}`);
    }

    // Rate limit before doing anything substantive. Subscription toggles
    // and grip_health/grip_diagnose are free — they don't hit the plugin.
    if (name !== 'grip_health' && name !== 'grip_diagnose' && !def.subscription && !rateLimitTake(session)) {
      return errorResult(
        `rate_limited: token bucket empty (cap ${RATE_LIMIT_BURST}, refill ${RATE_LIMIT_REFILL}/s). Wait or batch via run_script.`,
      );
    }

    if (name === 'grip_health') {
      const snap = bridge.snapshot();
      return okResult({
        role: 'leader-or-proxy', // proxy clients receive this through the leader; from the agent's POV irrelevant
        leaderPid: process.pid,
        pluginCount: snap.pluginCount,
        pluginsReady: snap.plugins.filter((p) => p.wsReady).length,
        pendingCount: snap.pendingCount,
        plugins: snap.plugins,
        session: {
          id: session.id,
          activeFileId: session.activeFileId,
          subscriptions: session.subscriptions,
        },
      });
    }
    if (name === 'grip_diagnose') {
      // Full forensic dump. Safe to call any time — no plugin
      // round-trip. Includes process metrics, event-loop lag right now,
      // recent log tail. Use this when grip "feels stuck."
      const snap = bridge.snapshot();
      const cpu = process.cpuUsage();
      const mem = process.memoryUsage();
      const lagMs = await measureLoopLag();
      const log = await tailLog(8192);
      return okResult({
        pid: process.pid,
        uptimeS: Math.round(process.uptime()),
        cpu: { userMs: cpu.user / 1000, systemMs: cpu.system / 1000 },
        memMb: {
          rss: Math.round(mem.rss / 1024 / 1024),
          heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
          heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
          external: Math.round(mem.external / 1024 / 1024),
        },
        eventLoopLagMs: Math.round(lagMs * 100) / 100,
        plugins: snap.plugins,
        pendingCount: snap.pendingCount,
        mcpSession: {
          id: session.id,
          activeFileId: session.activeFileId,
          subscriptions: session.subscriptions,
          rateBucket: session.rateBucket,
        },
        recentLog: log.split('\n').slice(-40).join('\n'),
      });
    }
    if (name === 'list_files') {
      // Soak cold-start lag: wait briefly so a freshly-spawned bridge
      // doesn't hand back an empty list while plugins are still
      // reconnecting their WebSockets.
      let files = bridge.list(session);
      if (files.length === 0) {
        await bridge.waitForAnyPlugin(2_000);
        files = bridge.list(session);
      }
      return okResult({ files });
    }
    if (name === 'set_active_file') {
      try {
        const target = (parsed.data as { target: string }).target;
        return okResult(bridge.setActive(target, session));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    }
    // get_page_context is a plugin round-trip, but we annotate it with this
    // agent's bind (bridge-side state) so the answer covers both "where am
    // I" and "where am I bound" in one call. It routed, so bind is resolved.
    if (name === 'get_page_context') {
      try {
        const result = (await bridge.request(name, parsed.data as Record<string, unknown>, session)) as object;
        const bind = session.bind ? { target: session.bind, resolved: true } : null;
        return okResult({ ...result, bind });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    }

    // grip_capabilities: the "there's more" directory. Bridge-side only —
    // no plugin round-trip — so it answers even with no Figma window open.
    // Tells a scoped agent which categories exist and whether THIS session's
    // scope loaded them, so it can discover tools that weren't injected.
    // Phase 2: with {tool: '<name>'} it instead pulls that one tool's full
    // detail (description relocated out of the trimmed ListTools payload).
    if (name === 'grip_capabilities') {
      const scope = resolveToolScope(session.toolScopeSpec);
      const wanted = (args && typeof args.tool === 'string') ? args.tool : null;
      if (wanted) {
        const d = toolDetail(wanted);
        if (!d) return okResult({ scope: session.toolScopeSpec ?? 'core (default)', error: `no such tool: ${wanted}` });
        return okResult({ scope: session.toolScopeSpec ?? 'core (default)', ...d, inScope: toolInScope(wanted, scope) });
      }
      return okResult({
        scope: session.toolScopeSpec ?? 'core (default)',
        howToChange:
          "Relaunch with env GRIP_TOOLS=core,<category> (stdio) or ?tools=core,<category> (HTTP); or call the API directly via run_script (if run_script is in scope). Call grip_capabilities {tool:'<name>'} for a tool's full detail.",
        categories: toolCategorySummary(scope),
      });
    }

    // ---- chunked image upload (bridge-side state) ----
    if (name === 'upload_image_begin') {
      reapUploads();
      const id = uuid();
      uploads.set(id, { chunks: [], total: 0, createdAt: Date.now() });
      return okResult({ uploadId: id });
    }
    if (name === 'upload_image_chunk') {
      const a = parsed.data as { uploadId: string; data: string; seq?: number };
      const u = uploads.get(a.uploadId);
      if (!u) return errorResult(`Unknown uploadId: ${a.uploadId}`);
      if (u.total + a.data.length > UPLOAD_MAX_BYTES) {
        uploads.delete(a.uploadId);
        return errorResult(`Upload exceeded ${UPLOAD_MAX_BYTES} bytes`);
      }
      u.chunks.push(a.data);
      u.total += a.data.length;
      return okResult({ received: a.data.length, total: u.total });
    }
    if (name === 'upload_image_finish') {
      const a = parsed.data as { uploadId: string };
      const u = uploads.get(a.uploadId);
      if (!u) return errorResult(`Unknown uploadId: ${a.uploadId}`);
      uploads.delete(a.uploadId);
      const base64 = u.chunks.join('');
      try {
        const result = await bridge.request('upload_image', { base64 }, session);
        return okResult(result);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    }
    if (name === 'upload_image_from_path') {
      const a = parsed.data as { path: string };
      let bytes: Buffer;
      try {
        bytes = await readFile(a.path);
      } catch (err) {
        return errorResult(`Failed to read ${a.path}: ${(err as Error).message}`);
      }
      const base64 = bytes.toString('base64');
      try {
        const result = await bridge.request('upload_image', { base64 }, session);
        return okResult(result);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    }

    // Export defaults to disk. A raster/video export returns base64 in `data`;
    // that base64 lands in the MCP tool_result and accumulates IRREVERSIBLY in
    // the consuming agent's context — 94 inline exports once made a resumed Hub
    // session 39MB (82% base64), re-cached every turn until the watchdog killed
    // it. So the bridge writes bytes to disk itself and returns a tiny
    // {path, format, bytes, width?, height?}; the agent Reads the file only if
    // it actually needs pixels. Path selection:
    //   • explicit `path`        → write there
    //   • `inline: true`         → return base64 in `data` (opt-in; NOT video)
    //   • default (raster/video) → auto-write to a temp file, return its path
    //   • text (SVG/CSS/JSON), no path, not inline → returned inline (cheap)
    if (name === 'export_node') {
      const d = parsed.data as Record<string, unknown>;
      const fmt = String(d.format ?? '');
      const isText = fmt === 'SVG' || fmt === 'CSS' || fmt === 'JSON';
      const isVideo = fmt === 'MP4' || fmt === 'GIF' || fmt === 'WEBM';
      const explicitPath = typeof d.path === 'string' ? (d.path as string) : undefined;
      const inline = d.inline === true;

      if (isVideo && inline) {
        return errorResult(`export_node ${fmt}: video is never returned inline — omit 'inline' (auto-written to a temp file) or pass a 'path'.`);
      }

      // Decide the destination. Inline only when explicitly asked (any raster/
      // text), or by default for text with no path (SVG/CSS/JSON are small).
      const wantInline = inline || (isText && !explicitPath);
      if (!wantInline) {
        const { path: _p, inline: _i, ...exportArgs } = d;
        let outPath = explicitPath;
        if (!outPath) {
          // Auto temp path: ~/tmpdir/grip-exports/<node>-<ts>.<ext>
          const dir = join(tmpdir(), 'grip-exports');
          try { await mkdir(dir, { recursive: true }); }
          catch (err) { return errorResult(`export_node: could not create temp dir ${dir}: ${(err as Error).message}`); }
          const nodeTag = String(d.nodeId ?? 'node').replace(/[^\w.-]/g, '_');
          outPath = join(dir, `${nodeTag}-${Date.now()}.${EXPORT_EXT[fmt] ?? fmt.toLowerCase()}`);
        }
        try {
          const result = (await bridge.request('export_node', exportArgs, session)) as {
            format: string; data: string;
          };
          const asText = result.format === 'SVG' || result.format === 'CSS' || result.format === 'JSON';
          const buf = asText ? Buffer.from(result.data, 'utf8') : Buffer.from(result.data, 'base64');
          await writeFile(outPath, buf);
          const dims = asText ? undefined : rasterDimensions(buf);
          return okResult({ path: outPath, format: result.format, bytes: buf.length, ...dims });
        } catch (err) {
          return errorResult(`export_node to '${outPath}' failed: ${(err as Error).message}`);
        }
      }
      // wantInline — fall through to the generic forward, which returns
      // { format, data: <base64|text> } straight from the plugin.
    }

    // Phase 3: merged tools ({op}/{target}-dispatched clusters). Translate
    // back to the underlying (former) tool name + args before it hits the
    // generic forward below — the plugin never sees the merged name, only
    // ever the real method, exactly as the old individual tool sent it.
    const merged = resolveMerged(name, args);
    if (merged) {
      if ('error' in merged) return errorResult(merged.error);
      const spec = MERGED_TOOLS[name];
      if (spec.bridgeSide) {
        // Bridge-side clusters set session state directly instead of
        // routing to the plugin — there is no plugin round-trip and no
        // TOOLS entry for the underlying method, so we must NOT recurse
        // into handleCall(merged.method, ...) (that used to be reachable
        // via a `def.subscription` branch keyed on the now-removed
        // subscribe_selection/document/currentpage TOOLS entries; removing
        // those entries would make the recursion hit the `Unknown tool`
        // guard at the top of handleCall). `subscribe` is currently the
        // only bridgeSide cluster: map its resolved method name straight
        // to the session subscription flag it used to set.
        if (name === 'subscribe') {
          const kindByMethod: Record<string, 'selection' | 'document' | 'currentPage'> = {
            subscribe_selection: 'selection',
            subscribe_document: 'document',
            subscribe_currentpage: 'currentPage',
          };
          const kind = kindByMethod[merged.method];
          if (!kind) return errorResult(`${name}: no bridge-side handler for '${merged.method}'`);
          return applySubscription(session, kind, merged.method);
        }
        return errorResult(`${name}: bridgeSide merged tool has no dispatcher`);
      }
      try {
        const result = await bridge.request(merged.method, merged.rest, session);
        return okResult(result);
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        process.stderr.write(`[grip] handler error in ${name} (merged→${merged.method}): ${message}\n`);
        return errorResult(message);
      }
    }

    try {
      const result = await bridge.request(
        name,
        parsed.data as Record<string, unknown>,
        session,
      );
      return okResult(result);
    } catch (err) {
      // ONLY touch err.message here — accessing err.stack triggers V8's
      // lazy source-position walk, which on hot error paths pegs CPU in
      // CallPrinter/Scanner::Next. The "eager drain" intel was wrong:
      // doing it on every error is what causes the spin we were trying
      // to prevent. Stack lives in Error.stackTraceLimit-bounded form.
      const message = (err as Error)?.message ?? String(err);
      process.stderr.write(`[grip] handler error in ${name}: ${message}\n`);
      return errorResult(message);
    }
  }

  const live: LiveSession = { server, session };
  liveSessions.push(live);
  return live;
}

export function destroySession(live: LiveSession) {
  const idx = liveSessions.indexOf(live);
  if (idx >= 0) liveSessions.splice(idx, 1);
}

export function activeSessionCount(): number {
  return liveSessions.length;
}

export async function connectStdio(bridge: PluginBridge): Promise<LiveSession> {
  const live = createSession(bridge);
  const transport = new StdioServerTransport();
  // Hook process.stdin directly — MCP SDK's server.connect() overrides
  // transport.onclose with its own handler, so setting it here gets lost
  // and destroySession never fires. stdin EOF is the reliable signal.
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    process.stderr.write(`[grip] mcp session ${live.session.id.slice(0, 8)} stdio closed\n`);
    destroySession(live);
  };
  process.stdin.once('end', cleanup);
  process.stdin.once('close', cleanup);
  await live.server.connect(transport);
  process.stderr.write(`[grip] mcp session ${live.session.id.slice(0, 8)} on stdio\n`);
  return live;
}

function okResult(data: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

function errorResult(message: string) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: message }],
  };
}
