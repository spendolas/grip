// Remote audit log: <GRIP_HOME>/remote-audit.jsonl, append-only, 0600, rotated to
// remote-audit.jsonl.1 at GRIP_AUDIT_MAX_BYTES (10MB), like the log mirror.
//
// One JSON line per remote tool call or denial (written by the daemon, mcp-server.ts) and per
// policy event (written by the `remote` CLI, and by the daemon when it sees a write window
// expire). Local sessions never write here. Argument VALUES are not logged, only their keys
// and sizes (plus a few short, id-like values such as nodeId, op or format), so text, base64
// and images never land in the file. Writing must never fail or slow a tool call: every
// error is swallowed with at most one stderr line a minute.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { liveIdentity } from './identity.js';

export const AUDIT_FILE = 'remote-audit.jsonl';
export const ARGS_SUMMARY_MAX = 200;

export type AuditStatus = 'ok' | 'denied' | 'error';
export type PolicyEvent =
  | 'remote_on' | 'remote_off' | 'mode_read' | 'write_armed' | 'write_expired' | 'allow_file' | 'deny_file';

export interface CallEntry {
  ts: string;
  kind: 'call';
  clientId: string;
  sessionId: string;
  tool: string;
  op?: string;
  file?: { fileKey: string; name?: string };
  args: string;
  status: AuditStatus;
  code?: string;
  bytes?: number;
  ms?: number;
}
export interface EventEntry {
  ts: string;
  kind: 'policy';
  event: PolicyEvent;
  by: 'cli' | 'daemon';
  fileKey?: string;
  until?: string;
  minutes?: number;
}
export type AuditEntry = CallEntry | EventEntry;

export function auditPath(home = liveIdentity().home): string { return join(home, AUDIT_FILE); }

function maxBytes(): number {
  const n = Number(process.env.GRIP_AUDIT_MAX_BYTES);
  return Number.isFinite(n) && n > 0 ? n : 10 * 1024 * 1024;
}

// Keys whose value is shown when it is short and id-like (a node id, an op name, a format).
const SHOWN_KEYS = new Set(['op', 'target', 'nodeId', 'parentId', 'pageId', 'format', 'property', 'type', 'styleType',
  'scale', 'depth', 'maxNodes', 'keepPage', 'inline', 'index', 'kind', 'mode']);
const ID_LIKE = /^[A-Za-z0-9_:;.\-]{1,40}$/;

// "nodeId=1:2 props=obj(3) text=str(5120) nodeIds=arr(12)": keys and sizes only.
export function summarizeArgsForAudit(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    const key = k.replace(/[^\w.-]/g, '_').slice(0, 40);
    let s: string;
    if (v === null || v === undefined) s = String(v);
    else if (typeof v === 'boolean') s = String(v);
    else if (typeof v === 'number') s = SHOWN_KEYS.has(k) && Number.isFinite(v) ? String(v) : 'num';
    else if (typeof v === 'string') s = SHOWN_KEYS.has(k) && ID_LIKE.test(v) ? v : `str(${v.length})`;
    else if (Array.isArray(v)) s = `arr(${v.length})`;
    else s = `obj(${Object.keys(v as object).length})`;
    parts.push(`${key}=${s}`);
  }
  const out = parts.join(' ');
  return out.length > ARGS_SUMMARY_MAX ? out.slice(0, ARGS_SUMMARY_MAX - 1) + '…' : out;
}

let lastWarn = 0;
function warn(msg: string): void {
  const now = Date.now();
  if (now - lastWarn < 60_000) return;
  lastWarn = now;
  try { process.stderr.write(`[grip] remote audit log not written: ${msg}\n`); } catch { /* nothing */ }
}

// Append one entry. Never throws.
export function appendAudit(entry: AuditEntry, home?: string): void {
  try {
    const path = auditPath(home);
    const line = JSON.stringify(entry) + '\n';
    const dir = join(path, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    let size = 0;
    try { size = statSync(path).size; } catch { /* new file */ }
    if (size > 0 && size + Buffer.byteLength(line) > maxBytes()) renameSync(path, `${path}.1`);
    appendFileSync(path, line, { mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* Windows */ }
  } catch (err) {
    warn((err as Error)?.message ?? String(err));
  }
}

export function auditCall(e: Omit<CallEntry, 'ts' | 'kind'>, home?: string): void {
  appendAudit({ ts: new Date().toISOString(), kind: 'call', ...e }, home);
}
export function auditPolicy(e: Omit<EventEntry, 'ts' | 'kind'>, home?: string): void {
  appendAudit({ ts: new Date().toISOString(), kind: 'policy', ...e }, home);
}

// Read entries (rotated file first, oldest first). Bad lines are skipped.
export function readAudit(home?: string): AuditEntry[] {
  const path = auditPath(home);
  const out: AuditEntry[] = [];
  for (const p of [`${path}.1`, path]) {
    let text = '';
    try { text = readFileSync(p, 'utf8'); } catch { continue; }
    for (const l of text.split('\n')) {
      if (!l.trim()) continue;
      try {
        const e = JSON.parse(l);
        if (e && typeof e.ts === 'string' && (e.kind === 'call' || e.kind === 'policy')) out.push(e);
      } catch { /* skip */ }
    }
  }
  return out;
}

export interface AuditFilter { sinceMs?: number; denied?: boolean; tail?: number }
export function filterAudit(entries: AuditEntry[], f: AuditFilter, now = Date.now()): AuditEntry[] {
  let r = entries;
  if (f.sinceMs !== undefined) { const from = now - f.sinceMs; r = r.filter((e) => Date.parse(e.ts) >= from); }
  if (f.denied) r = r.filter((e) => e.kind === 'call' && e.status === 'denied');
  if (f.tail !== undefined) r = r.slice(-Math.max(0, f.tail));
  return r;
}

// "90s", "15m", "1h", "2d" -> ms; undefined if unparseable.
export function parseSince(s: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i.exec(s.trim());
  if (!m) return undefined;
  return Number(m[1]) * { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }[m[2].toLowerCase() as 's' | 'm' | 'h' | 'd'];
}

export function auditSummary(entries: AuditEntry[], sinceMs = 86_400_000, now = Date.now()): { calls: number; denied: number; errors: number } {
  const recent = filterAudit(entries, { sinceMs }, now).filter((e): e is CallEntry => e.kind === 'call');
  return {
    calls: recent.length,
    denied: recent.filter((e) => e.status === 'denied').length,
    errors: recent.filter((e) => e.status === 'error').length,
  };
}

export function formatEntry(e: AuditEntry): string {
  const t = e.ts.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
  if (e.kind === 'policy') {
    return `${t}  policy  ${e.event}${e.fileKey ? ` ${e.fileKey}` : ''}${e.until ? ` until ${e.until}` : ''}${e.minutes ? ` (${e.minutes} min)` : ''}  [${e.by}]`;
  }
  const what = `${e.tool}${e.op ? `:${e.op}` : ''}`;
  const file = e.file ? ` ${e.file.name ? `"${e.file.name}" ` : ''}${e.file.fileKey}` : '';
  const extra = [e.code ? `code=${e.code}` : '', e.bytes !== undefined ? `${e.bytes}B` : '', e.ms !== undefined ? `${e.ms}ms` : ''].filter(Boolean).join(' ');
  return `${t}  ${e.status.padEnd(6)}  ${what}  client=${e.clientId}${file}${e.args ? `  ${e.args}` : ''}${extra ? `  ${extra}` : ''}`;
}
