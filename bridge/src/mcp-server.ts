import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { v4 as uuid } from 'uuid';
import { readFile, writeFile, stat, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  TOOLS, toolInputSchema, resolveToolScope, toolInScope, toolCategorySummary, toolDetail,
  MERGED_TOOLS, resolveMerged,
} from './tools.js';
import type { PluginBridge } from './ws-server.js';
import type { McpSession, WSEvent } from './types.js';

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

    if (def.subscription) {
      if (name === 'subscribe_selection') session.subscriptions.selection = true;
      if (name === 'subscribe_document') session.subscriptions.document = true;
      if (name === 'subscribe_currentpage') session.subscriptions.currentPage = true;
      return okResult({ subscribed: true, channel: name });
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

    // Export-to-disk. A raster export returns base64 in `data`; even a
    // modest PNG (~165KB) blows the MCP tool-result token limit, so the
    // agent gets an error instead of an image. When `path` is set, the
    // bridge writes the bytes to disk itself (like upload_image_from_path in
    // reverse) and returns just {path, format, bytes} — no giant payload
    // crosses MCP. PNG/JPG/PDF decode from base64; SVG/CSS/JSON write as text.
    // Video formats always produce large binary — inline base64 would blow
    // the MCP token limit. Refuse them without a `path`.
    if (name === 'export_node') {
      const fmt = (parsed.data as any)?.format;
      if ((fmt === 'MP4' || fmt === 'GIF' || fmt === 'WEBM') && typeof (parsed.data as any)?.path !== 'string') {
        return errorResult(`export_node ${fmt} requires a 'path' (video is written to disk, never returned inline).`);
      }
    }
    if (name === 'export_node' && typeof (parsed.data as any)?.path === 'string') {
      const { path: outPath, ...exportArgs } = parsed.data as Record<string, unknown> & { path: string };
      try {
        const result = (await bridge.request('export_node', exportArgs, session)) as {
          format: string;
          data: string;
        };
        const isText = result.format === 'SVG' || result.format === 'CSS' || result.format === 'JSON';
        const buf = isText ? Buffer.from(result.data, 'utf8') : Buffer.from(result.data, 'base64');
        await writeFile(outPath, buf);
        return okResult({ path: outPath, format: result.format, bytes: buf.length });
      } catch (err) {
        return errorResult(`export_node to '${outPath}' failed: ${(err as Error).message}`);
      }
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
        // TODO(phase3 task6): no bridgeSide cluster exists yet (3a's two
        // merges — bind_to_variable, group — are both plugin-forward). A
        // later task (subscribe) lands here — verify the
        // recursive handleCall(merged.method, ...) below still finds a
        // TOOLS entry for merged.method (bridgeSide dispatch such as
        // subscribe_selection is branched on `name === '<tool>'` further
        // up in this function, not via a TOOLS lookup, so this recursion
        // is expected to reach that branch rather than the `Unknown tool`
        // guard at the top — confirm when wiring that cluster).
        return await handleCall(merged.method, merged.rest);
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
