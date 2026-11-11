import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ElicitResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { randomUUID as uuid } from 'node:crypto';
import { readFile, writeFile, stat, open, mkdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TOOLS, toolInputSchema, resolveToolScope, mergeToolScope, toolInScope, toolCategorySummary, toolDetail,
  MERGED_TOOLS, resolveMerged,
} from './tools.js';
import type { PluginBridge, BridgeEvent } from './ws-server.js';
import { callContext, QUEUED_NOTE_MS, type CallContext } from './ws-server.js';
import type { McpSession } from './types.js';
import { BRIDGE_VERSION } from './types.js';
import {
  getUpdateState, updatesDisabled, checkForUpdate, installAndScheduleRestart, updateNoticeText,
  updateInstructionsParagraph, updateSignal, pluginInfos, claimNotice, bridgeStaleReason, UpdateError,
  helpNotices, pluginsBehind, findPluginCopies, copyNeedsWork,
  type UpdateState, type PluginInfo,
} from './update.js';

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
  bridge.on('event', (evt: BridgeEvent) => {
    for (const { server, session } of liveSessions) {
      const subbed =
        (evt.event === 'selectionchange' && session.subscriptions.selection) ||
        (evt.event === 'documentchange' && session.subscriptions.document) ||
        (evt.event === 'currentpagechange' && session.subscriptions.currentPage);
      if (!subbed) continue;
      // Only events from the file this session routes to (its bound file, or
      // the one open file when unbound; nothing while ambiguous). Without this
      // every agent got every file's events with no way to tell them apart.
      if (!bridge.sessionTargets(session, evt.sessionId)) continue;
      server
        .notification({
          method: 'notifications/message',
          params: {
            level: 'info',
            logger: 'grip',
            // event + payload as before; the rest is additive.
            data: {
              event: evt.event,
              payload: evt.data,
              fileKey: evt.fileKey,
              fileName: evt.fileName,
              pluginSessionId: evt.sessionId,
              causedBy: bridge.eventCause(session, evt.sessionId),
            },
          },
        })
        .catch((err: Error) => {
          process.stderr.write(`[grip] notification failed: ${err.message}\n`);
        });
    }
  });
}

// The OTHER live MCP sessions (other agents). Used only for counts
// (list_files boundAgents, set_active_file warnings, grip_health otherAgents);
// no other agent's id or name is ever returned.
function otherSessions(self: McpSession): McpSession[] {
  return liveSessions.map((l) => l.session).filter((s) => s !== self);
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
    updateNoticeSent: false,
  };
  // Agent update notice (this paragraph + the first tool result's text block):
  // only when an update is signalled (available AND compatible with every
  // connected plugin) and not already shown for this version in the last 3
  // days, across sessions. The purple strip is not throttled.
  let updateParagraph = '';
  if (!updatesDisabled()) {
    const u = getUpdateState();
    if (u && updateSignal(u, pluginInfos(bridge)).signal) {
      if (claimNotice(u.latest!)) { session.updateNoticeGranted = true; updateParagraph = updateInstructionsParagraph(u); }
      else session.updateNoticeSent = true;   // throttled: nothing more to show this session
    }
    // Plugin / bridge behind what auto-update can reach: the agent helps the user (same throttle).
    const granted: string[] = [];
    for (const n of helpNotices(safePluginInfos(bridge))) {
      if (claimNotice(n.key)) { granted.push(n.key); updateParagraph += `\n\n${n.text}`; }
    }
    if (granted.length) session.helpNoticesGranted = granted;
  }
  // `instructions` is returned with initialize and injected into the agent's
  // context once — unlike tool descriptions, it costs nothing per tool and is
  // not subject to the per-description budget.
  //
  // It exists because of an observed failure: with both Grip and a REST-based
  // Figma integration present, agents asked about "Figma" reached for the one
  // NAMED Figma and reported no access, while Grip sat loaded and ready. The
  // tool names here (get_document, get_page, search_nodes) never say "Figma",
  // so nothing connected the request to this server. This states the mapping
  // plainly, and the distinction it draws is factual: Grip is a live link to
  // the open canvas, REST integrations read published file data.
  const server = new Server(
    { name: 'grip', version: BRIDGE_VERSION },
    {
      capabilities: { tools: { listChanged: true }, logging: {} },
      instructions:
        'Grip is a live connection to Figma. Use these tools for anything involving Figma — ' +
        'reading or editing a document, page, frame, component, style, variable or the current ' +
        'selection.\n\n' +
        'Grip drives the Figma app itself through a plugin, so it sees the file the user has open ' +
        'right now, including unsaved and unpublished changes, and can write back to it. Other ' +
        'Figma integrations read published data over the REST API and cannot edit the canvas — ' +
        'for the document the user is looking at, use Grip.\n\n' +
        'Start with get_page_context (cheap: which file and page, how many nodes selected). ' +
        'If it reports no plugin connected, the user needs to run the Grip plugin in Figma — ' +
        'say so rather than reporting that you have no Figma access.' +
        updateParagraph,
    },
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
    // Per-call context the bridge fills in (time spent queued behind other
    // calls, a retry hint on plugin_working / plugin_busy / plugin_overloaded).
    const ctx: CallContext = {};
    const res = await callContext.run(ctx, () => handleCall(name, args));
    if ((ctx.queuedMs ?? 0) >= QUEUED_NOTE_MS || ctx.retryAfterMs !== undefined) {
      const meta: Record<string, unknown> = { ...((res as any)._meta ?? {}) };
      if ((ctx.queuedMs ?? 0) >= QUEUED_NOTE_MS) meta['grip/queuedMs'] = ctx.queuedMs;
      if (ctx.retryAfterMs !== undefined) meta['grip/retryAfterMs'] = ctx.retryAfterMs;
      (res as any)._meta = meta;
    }
    // Update notice: ONE extra text block on the first SUCCESSFUL result of
    // this session (never on errors, never on grip_update itself), only while
    // the update is signalled (available AND compatible with every connected
    // plugin) and the 3-day per-version throttle allows it. content[0] is
    // untouched, so callers that parse the first block as JSON keep working.
    if (!(res as any)?.isError && !session.updateNoticeSent) {
      if (name === 'grip_update') {
        session.updateNoticeSent = true;
      } else if (!updatesDisabled()) {
        const u = getUpdateState();
        if (u && updateSignal(u, pluginInfos(bridge)).signal) {
          if (session.updateNoticeGranted || claimNotice(u.latest!)) {
            (res as any).content.push({ type: 'text' as const, text: updateNoticeText(u) });
          }
          session.updateNoticeSent = true;   // shown, or throttled: not again this session
        }
      }
    }
    // Help notice: the plugin (or bridge) is behind and auto-update cannot reach it. One extra
    // block on the first successful result once a plugin has said hello; same 3-day throttle.
    if (!(res as any)?.isError && !session.helpNoticeSent && name !== 'grip_update' && !updatesDisabled()) {
      const plugins = safePluginInfos(bridge);
      const texts = helpNotices(plugins)
        .filter((n) => session.helpNoticesGranted?.includes(n.key) || claimNotice(n.key))
        .map((n) => n.text);
      if (texts.length) (res as any).content.push({ type: 'text' as const, text: texts.join('\n\n') });
      if (texts.length || plugins.some((p) => p.hello !== false && p.wsReady !== false)) session.helpNoticeSent = true;
    }
    const ms = Date.now() - t0;
    const isErr = (res as any)?.isError;
    const text = (res as any)?.content?.[0]?.text ?? '';
    const size = typeof text === 'string' ? text.length : 0;
    process.stderr.write(
      `[grip] « ${sid} ${name} ${ms}ms ${isErr ? 'ERR ' + String(text).slice(0, 100) : size + 'B'}` +
        `${ctx.queuedMs ? ` queuedMs=${ctx.queuedMs}` : ''}\n`,
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
          // What this agent asked for (null = unbound) and whether it routes now.
          bind: session.bind,
          ...(typeof bridge.bindingState === 'function' ? { binding: bridge.bindingState(session) } : {}),
        },
        // Other agents connected to this bridge right now (a count only).
        otherAgents: otherSessions(session).length,
        update: updateSummary(undefined, pluginInfos(bridge)),
      });
    }
    if (name === 'grip_update') {
      const { action = 'check', version } = parsed.data as { action?: 'check' | 'install'; version?: string };
      const plugins = pluginInfos(bridge);
      if (action === 'check') {
        if (updatesDisabled()) {
          return okResult({ ...updateSummary(undefined, plugins), disabled: true, note: 'Automatic update checks are off (GRIP_NO_UPDATE_CHECK). Nothing was contacted. If the user wants to update, call grip_update {action:\'install\', version} after they agree.' });
        }
        const s = await checkForUpdate();
        const sum = updateSummary(s, plugins);
        return okResult({
          ...sum,
          // What's new, from the release notes (first ~1200 chars). Relay it to the user.
          headline: s.headline ?? null,
          notes: s.notes ?? null,
          ...(s.error ? { error: s.error } : {}),
          note: s.available
            ? (sum.signalled
              ? `Update available. Tell the user what's new (headline/notes) and ask if they want it; only after they say yes, call grip_update {action:'install', version:'${s.latest}'}.${sum.staleWindows ? ` Warn them: ${sum.staleWindows.length} other open Figma window(s) have a Grip plugin that is too old for ${s.latest} and will stop working until it is updated in Figma (${sum.staleWindows.join('; ')}).` : ''}`
              : `Update ${s.latest} exists but is NOT offered: ${sum.blockedReason}. Do not install it.`)
            : s.error ? 'Could not reach the update server; nothing changed.' : 'Grip is up to date.',
        });
      }
      if (!version) {
        return errorResult(`version_required: grip_update {action:'install'} needs version:'<x.y.z>', the exact version you told the user about (call grip_update {action:'check'} and read \`latest\`), and only after the user explicitly said yes.`);
      }
      let consent: 'user_confirmed' | 'agent_attested' = 'agent_attested';
      try {
        const r = await installAndScheduleRestart({
          version,
          plugins,
          // The user must really agree: where the client can ask them (MCP
          // elicitation) we ask here; the agent's "they said yes" alone is only
          // accepted from clients that cannot ask.
          confirm: async (info) => {
            const a = await askUserToConfirm(server, `Install Grip ${info.from} → ${info.to}?${info.headline ? ' ' + info.headline : ''}`);
            if (a === 'accept') consent = 'user_confirmed';
            return a !== 'decline';
          },
        });
        if (r.status === 'declined') return okResult({ status: 'declined', note: 'The user declined. Nothing was installed or changed.' });
        if (r.status === 'version_changed') {
          return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'version_changed', requested: version, latest: r.to, headline: r.headline, notes: r.notes,
            note: `The latest release is now ${r.to}, not ${version}. Nothing was installed. Tell the user what ${r.to} is and ask again; if they agree, call grip_update {action:'install', version:'${r.to}'}.`,
          }, null, 2) }] };
        }
        if (r.status === 'incompatible_plugin') return errorResult(`incompatible_plugin: ${r.reason}. Nothing was installed.`);
        if (r.status === 'plugins_unverifiable') return errorResult('plugins_unverifiable: no Grip plugin is connected. Open the Grip plugin in Figma first so compatibility can be verified, then try again. Nothing was installed.');
        if (r.status === 'up_to_date') return okResult({ status: 'up_to_date', current: BRIDGE_VERSION, latest: r.to });
        if (r.status === 'already_installing') return okResult({ status: 'already_installing', note: 'An update is already being installed; wait a few seconds.' });
        if (r.status === 'clone_install') {
          return okResult({
            status: 'clone_install',
            from: r.from,
            to: r.to,
            next: r.next,
            note: 'This is a developer install (Grip runs from a git clone), so nothing was changed: updating would overwrite it. Tell the user to run the commands in next[] inside their Grip clone.',
          });
        }
        return okResult({
          status: 'updated',
          from: r.from,
          to: r.to,
          restart: r.restart,
          pluginFilesWritten: r.pluginFilesWritten,
          ...(r.pluginCopies ? { pluginCopies: r.pluginCopies } : {}),
          consent,
          next: installNextSteps(r.restart, r.pluginCopies),
        });
      } catch (err) {
        return errorResult(`${err instanceof UpdateError && err.code ? err.code + ': ' : ''}update failed: ${(err as Error).message}`);
      }
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
          bind: session.bind,
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
      let listing = bridge.fileListing(session, otherSessions(session));
      if (listing.files.length === 0) {
        await bridge.waitForAnyPlugin(2_000);
        listing = bridge.fileListing(session, otherSessions(session));
      }
      return okResult(listing);
    }
    if (name === 'set_active_file') {
      try {
        const target = (parsed.data as { target: string }).target;
        return okResult(bridge.setActive(target, session, otherSessions(session)));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    }
    // get_page_context is a plugin round-trip, but we annotate it with this
    // agent's bind (bridge-side state) so the answer covers both "where am
    // I" and "where am I bound" in one call. The state is read from the
    // router after the call, not assumed: live / deferred / unbound.
    if (name === 'get_page_context') {
      try {
        const result = (await bridge.request(name, parsed.data as Record<string, unknown>, session)) as object;
        const st = bridge.bindingState(session);
        const state = st.state === 'waiting' ? 'deferred' : st.state;
        const bind = session.bind ? { target: session.bind, resolved: state === 'live', state } : null;
        const binding = {
          state,
          ...(st.target ? { target: st.target } : {}),
          ...(st.sessionId ? { sessionId: st.sessionId } : {}),
          ...(st.reason ? { reason: st.reason } : {}),
        };
        return okResult({ ...result, bind, binding });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    }

    if (name === 'grip_load_tools') {
      const a = parsed.data as { categories?: string[]; unload?: string[] };
      if (!a.categories?.length && !a.unload?.length) return errorResult("Pass `categories` to load and/or `unload` to drop (category names from grip_capabilities, or 'all').");
      const r = mergeToolScope(session.toolScopeSpec, a.categories ?? [], a.unload ?? []);
      if (!r.ok) return errorResult(r.error);
      session.toolScopeSpec = r.spec;
      if (r.added.length || r.removed.length) {
        setTimeout(() => {
          server.sendToolListChanged().catch((err: Error) => {
            process.stderr.write(`[grip] tools/list_changed failed: ${err.message}\n`);
          });
        }, 0);
      }
      return okResult({
        scope: r.spec,
        added: r.added,
        removed: r.removed,
        unknownCategories: r.unknown,
        ignored: r.ignored.length ? `${r.ignored.join(', ')} cannot be unloaded` : undefined,
        note: r.added.length || r.removed.length
          ? 'Tool list refreshed; changes apply on your next turn. If your client does not refresh, call tools via run_script.'
          : 'No change (already loaded/unloaded, or unknown category).',
      });
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
          "Call grip_load_tools {categories:[...]} to load a category into this session. Or set the launch scope: env GRIP_TOOLS=core,<category> (stdio) / ?tools=core,<category> (HTTP). run_script reaches any tool regardless. Call grip_capabilities {tool:'<name>'} for a tool's full detail.",
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
    // the consuming agent's context — 94 inline exports once made a resumed agent
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
        return pluginResult(name, merged.method, result);
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
      return pluginResult(name, name, result);
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

// The help notices are a convenience: a bridge that cannot list its plugins (a test stub, a
// half-started daemon) just means no notice, never a failed session or tool call.
function safePluginInfos(bridge: PluginBridge): PluginInfo[] {
  try { return typeof (bridge as any).snapshot === 'function' ? pluginInfos(bridge) : []; } catch { return []; }
}

// Always the truth (never throttled): what exists, what it needs, and whether
// the bridge offers it (`signalled`) or why not (`blockedReason`).
function updateSummary(s: UpdateState | null = getUpdateState(), plugins: PluginInfo[] = []) {
  const sig = updateSignal(s, plugins);
  const stale = bridgeStaleReason(plugins);
  const behind = pluginsBehind(plugins);
  const notices = helpNotices(plugins);
  const pluginNotice = notices.find((n) => n.kind === 'plugin');
  const bridgeNotice = notices.find((n) => n.kind === 'bridge');
  const found = behind.length ? findPluginCopies().copies : [];
  const refreshable = found.filter((c) => !c.skip && c.behind).map((c) => c.dir);
  const needsYou = found.filter((c) => c.skip && copyNeedsWork(c)).map((c) => ({ dir: c.dir, reason: c.skip }));
  const copyFacts = refreshable.length || needsYou.length ? { refreshable, needsYou } : null;
  return {
    current: BRIDGE_VERSION,
    latest: s?.latest ?? null,
    available: s?.available ?? false,
    checkedAt: s?.checkedAt ?? null,
    minPlugin: s?.minPlugin ?? null,
    signalled: sig.signal && !updatesDisabled(),
    ...(sig.blockedReason ? { blockedReason: sig.blockedReason } : {}),
    ...(sig.staleWindows ? { staleWindows: sig.staleWindows } : {}),
    // A connected plugin needs a NEWER bridge than this one: the bridge is the stale side.
    ...(stale ? { bridgeStale: stale, updateRecommended: true } : {}),
    ...(bridgeNotice ? { bridgeHelp: bridgeNotice.text } : {}),
    // A plugin window older than the copy next to this bridge. The bridge refreshes imported copies by
    // itself (the strip offers it); `pluginHelp` is only set when it cannot and the user has to act.
    ...(behind.length ? { pluginBehind: behind } : {}),
    ...(pluginNotice ? { pluginHelp: pluginNotice.text } : {}),
    ...(copyFacts ? { pluginCopies: copyFacts } : {}),
  };
}

// Ask the person (not the agent) to confirm an install, through MCP elicitation
// (a form-less confirm). 'unsupported' = this client cannot ask; anything but an
// explicit accept (decline, cancel, timeout after 60s, error) counts as a decline.
async function askUserToConfirm(server: Server, message: string): Promise<'accept' | 'decline' | 'unsupported'> {
  const caps = server.getClientCapabilities()?.elicitation;
  if (!caps) return 'unsupported';
  const requestedSchema = { type: 'object' as const, properties: {} };
  // 60s at most (GRIP_ELICIT_TIMEOUT_MS can only lower it; tests).
  const t = Number(process.env.GRIP_ELICIT_TIMEOUT_MS);
  const timeout = Number.isFinite(t) && t > 0 ? Math.min(t, 60_000) : 60_000;
  try {
    let res;
    if (caps.form) {
      res = await server.elicitInput({ message, requestedSchema }, { timeout });
    } else if (Object.keys(caps).length === 0) {
      // `elicitation: {}` is the older spelling of form support
      res = await server.request({ method: 'elicitation/create', params: { mode: 'form', message, requestedSchema } }, ElicitResultSchema, { timeout });
    } else {
      return 'unsupported';   // url-only client
    }
    return res.action === 'accept' ? 'accept' : 'decline';
  } catch (err) {
    process.stderr.write(`[grip] update confirmation failed, treating as declined: ${(err as Error).message}\n`);
    return 'decline';
  }
}

// What the agent should tell the user after a successful install.
function installNextSteps(restart: string | undefined, copies?: { updated: string[]; skipped: Array<{ dir: string; reason: string }> }): string[] {
  const steps: string[] = [];
  if (restart === 'scheduled') {
    steps.push('The Grip bridge restarts in about a second to load the new version; your next Grip call may fail once with a connection error, simply retry it. stdio agents reconnect on their own; agents on the HTTP transport (http://127.0.0.1:7778/mcp) may need to reconnect their MCP server.');
  } else if (restart === 'not_managed') {
    steps.push('The files were installed to ~/.grip, but this bridge is not running from ~/.grip/grip-bridge.mjs, so it did NOT restart. Restart it from the installed copy to use the new version.');
  } else {
    steps.push('Restart your agent / the Grip bridge to load the new version.');
  }
  steps.push(
    'Figma plugin: the copy in ~/.grip/figma-plugin was updated in place.' +
    (copies?.updated.length ? ` The bridge also refreshed the plugin the user imported from ${copies.updated.join(', ')}; a dev plugin reloads itself when its files change, so there is nothing to do.` : '') +
    (copies?.skipped.length ? ` The bridge did NOT touch ${copies.skipped.map((c) => `${c.dir} (${c.reason})`).join(', ')}: for a git checkout the user runs \`git pull && npm run build\` there, otherwise they can import ~/.grip/figma-plugin/manifest.json in Figma instead.` : '') +
    (!copies ? ' If the user imported the plugin from some other folder, the bridge could not find it: they can import ~/.grip/figma-plugin/manifest.json in Figma instead, or for a git clone run `git pull && npm run build` there (a Figma Community plugin updates through Figma).' : ''),
  );
  steps.push('Undo: `node ~/.grip/grip-bridge.mjs update --rollback` restores the previous bridge (the plugin files stay at the new version).');
  return steps;
}

// A plugin that predates a method answers with no result at all, which MCP rejects as a
// protocol error ("expected string, received undefined") and hides the real cause. Turn it
// into an actionable message; every handler returns a value, so undefined means "unknown method".
function pluginResult(tool: string, method: string, result: unknown) {
  if (result === undefined) {
    return errorResult(
      `${tool}: the Figma plugin returned no result for '${method}'. It is most likely an older build that ` +
      `does not know this method — close and re-run the Grip plugin in Figma (the bridge logs a version ` +
      `mismatch warning, and grip_health lists each plugin's version).`,
    );
  }
  return okResult(result);
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
