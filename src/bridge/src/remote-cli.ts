// `node ~/.grip/grip-bridge.mjs remote status|on|off|allow-file <key|url|name>|deny-file <key|url>|mode read|write [--minutes N]`
//
// Edits <GRIP_HOME>/remote.json only (remote-policy.ts). Like `pair`, it never starts a
// daemon and never writes MCP traffic; the daemon re-reads the file on every remote call,
// so a change applies to live remote sessions at once.
import { readFileSync } from 'node:fs';
import {
  RemotePolicyStore, isRemoteFileKey, writeArmed, DEFAULT_WRITE_MINUTES, MAX_WRITE_MINUTES, type RemotePolicy,
} from './remote-policy.js';
import { liveIdentity } from './identity.js';
import { auditPolicy, auditSummary, filterAudit, formatEntry, parseSince, readAudit, auditPath } from './remote-audit.js';

export function isRemoteCli(argv: string[]): boolean {
  if (argv.includes('--daemon')) return false;
  return argv.slice(2)[0] === 'remote';
}

type Out = (msg?: string) => void;
const FIGMA_URL_RE = /figma\.com\/(?:file|design|proto|board|slides)\/([A-Za-z0-9]+)/i;

// Open files the running daemon reports (status file): [{fileKey, fileName}], or null.
function openFiles(statusPath: string): Array<{ fileKey: string; fileName: string }> | null {
  try {
    const j = JSON.parse(readFileSync(statusPath, 'utf8'));
    const pid = Number(j?.pid);
    if (!Number.isInteger(pid) || pid <= 1) return null;
    try { process.kill(pid, 0); } catch { return null; }
    if (!Array.isArray(j.plugins)) return null;
    return j.plugins
      .filter((p: any) => isRemoteFileKey(p?.fileKey) && typeof p?.fileName === 'string')
      .map((p: any) => ({ fileKey: p.fileKey as string, fileName: p.fileName as string }));
  } catch { return null; }
}

// <key|url|name> -> fileKey, or an error message. A name is looked up among the files open
// in Figma right now (the daemon's status file), exact match, and must name one file.
export function resolveFileArg(arg: string, statusPath: string): { key: string } | { error: string } {
  const t = arg.trim();
  const url = t.match(FIGMA_URL_RE);
  if (url) return isRemoteFileKey(url[1]) ? { key: url[1] } : { error: 'that figma.com URL has no usable file key' };
  if (isRemoteFileKey(t)) return { key: t };
  const files = openFiles(statusPath);
  if (!files) return { error: `"${t}" is not a file key, and no running Grip bridge reports open files. Pass the file's figma.com URL or key.` };
  const keys = [...new Set(files.filter((f) => f.fileName === t).map((f) => f.fileKey))];
  if (keys.length === 1) return { key: keys[0] };
  if (keys.length > 1) return { error: `${keys.length} open files are named "${t}" (${keys.join(', ')}). Pass the key or URL of the one you mean.` };
  return { error: `no open file with a Figma key is named "${t}". Local/unsaved files cannot be shared remotely. Pass the file's figma.com URL or key.` };
}

function describe(p: RemotePolicy, now = Date.now()): string[] {
  const lines = [`remote access: ${p.enabled ? 'ON' : 'off'}`];
  if (writeArmed(p, now)) lines.push(`mode: write, armed until ${new Date(p.writeUntil!).toLocaleString()} (${Math.ceil((p.writeUntil! - now) / 60_000)} min left)`);
  else if (p.mode === 'write') lines.push('mode: write, but the window has expired: read only');
  else lines.push('mode: read only');
  lines.push(p.files.length ? `files (${p.files.length}):` : 'files: none');
  for (const f of p.files) lines.push(`  ${f}  https://www.figma.com/design/${f}/x`);
  if (p.tools) lines.push(`tool list: ${p.tools.length ? p.tools.join(', ') : '(empty: nothing allowed)'}`);
  return lines;
}

const USAGE = 'usage: remote status | on | off | allow-file <key|figma.com URL|exact file name> | deny-file <key|URL> | mode read | mode write [--minutes N] | log [--tail N] [--since 1h] [--json] [--denied]';

export function runRemoteCli(argv: string[], io: { out?: Out; err?: Out; store?: RemotePolicyStore; statusPath?: string; now?: () => number } = {}): number {
  const out: Out = io.out ?? ((m = '') => { process.stdout.write(m + '\n'); });
  const err: Out = io.err ?? ((m = '') => { process.stderr.write(m + '\n'); });
  const store = io.store ?? new RemotePolicyStore();
  const statusPath = io.statusPath ?? liveIdentity().statusPath;
  const now = io.now ?? Date.now;
  const [cmd = 'status', ...rest] = argv.slice(3);
  const p = store.read();
  const home = store.dir;

  switch (cmd) {
    case 'status':
    case '--status':
      for (const l of describe(p, now())) out(l);
      { const a = auditSummary(readAudit(home), 86_400_000, now());
        out(`audit, last 24h: ${a.calls} remote call(s), ${a.denied} denied, ${a.errors} error(s) (\`remote log\` for details)`); }
      out(`(${store.path})`);
      return 0;
    case 'on':
      if (!p.files.length) { err('Refusing: no file is allowed yet. Run `remote allow-file <key|URL|name>` first.'); return 1; }
      store.write({ ...p, enabled: true });
      auditPolicy({ event: 'remote_on', by: 'cli' }, home);
      out(`Remote access is ON for ${p.files.length} file(s), ${writeArmed(p, now()) ? 'write armed' : 'read only'}.`);
      return 0;
    case 'off':
      store.write({ ...p, enabled: false });
      auditPolicy({ event: 'remote_off', by: 'cli' }, home);
      out('Remote access is off. Remote sessions are refused from their next call.');
      return 0;
    case 'allow-file': {
      if (!rest[0]) { err(USAGE); return 2; }
      const r = resolveFileArg(rest.join(' '), statusPath);
      if ('error' in r) { err(r.error); return 1; }
      if (p.files.includes(r.key)) { out(`Already allowed: ${r.key}`); return 0; }
      store.write({ ...p, files: [...p.files, r.key] });
      auditPolicy({ event: 'allow_file', by: 'cli', fileKey: r.key }, home);
      out(`Allowed for remote access: ${r.key}${p.enabled ? '' : ' (remote access is still off: `remote on`)'}`);
      return 0;
    }
    case 'deny-file': {
      if (!rest[0]) { err(USAGE); return 2; }
      const t = rest[0].trim();
      const key = t.match(FIGMA_URL_RE)?.[1] ?? t;
      if (!p.files.includes(key)) { out(`Not in the list: ${key}`); return 0; }
      const files = p.files.filter((f) => f !== key);
      // The last file gone: switch off too, so `on` with no file can never be the state.
      store.write({ ...p, files, enabled: files.length ? p.enabled : false });
      auditPolicy({ event: 'deny_file', by: 'cli', fileKey: key }, home);
      if (!files.length && p.enabled) auditPolicy({ event: 'remote_off', by: 'cli' }, home);
      out(`Removed: ${key}${!files.length && p.enabled ? '. No file is left, so remote access is now off.' : ''}`);
      return 0;
    }
    case 'mode': {
      const m = rest[0];
      if (m === 'read') {
        const { writeUntil: _w, ...keep } = p;
        store.write({ ...keep, mode: 'read' });
        auditPolicy({ event: 'mode_read', by: 'cli' }, home);
        out('Remote mode: read only.');
        return 0;
      }
      if (m === 'write') {
        let minutes = DEFAULT_WRITE_MINUTES;
        const i = rest.indexOf('--minutes');
        if (i >= 0) {
          minutes = Number(rest[i + 1]);
          if (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_WRITE_MINUTES) {
            err(`--minutes must be between 1 and ${MAX_WRITE_MINUTES}`); return 2;
          }
        }
        const until = now() + Math.round(minutes * 60_000);
        store.write({ ...p, mode: 'write', writeUntil: until });
        auditPolicy({ event: 'write_armed', by: 'cli', until: new Date(until).toISOString(), minutes }, home);
        out(`Remote write access armed for ${minutes} min (until ${new Date(until).toLocaleString()}); read only after that.${p.enabled ? '' : ' Remote access is still off: `remote on`.'}`);
        return 0;
      }
      err(USAGE); return 2;
    }
    case 'log': {
      const f: { tail?: number; sinceMs?: number; denied?: boolean } = {};
      let json = false;
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a === '--json') json = true;
        else if (a === '--denied') f.denied = true;
        else if (a === '--tail') {
          const n = Number(rest[++i]);
          if (!Number.isInteger(n) || n < 0) { err('--tail needs a whole number'); return 2; }
          f.tail = n;
        } else if (a === '--since') {
          const ms = parseSince(rest[++i] ?? '');
          if (ms === undefined) { err('--since needs a duration like 30m, 1h or 2d'); return 2; }
          f.sinceMs = ms;
        } else { err(USAGE); return 2; }
      }
      if (f.tail === undefined && f.sinceMs === undefined) f.tail = 50;
      const rows = filterAudit(readAudit(home), f, now());
      if (json) { for (const e of rows) out(JSON.stringify(e)); return 0; }
      if (!rows.length) { out(`No matching entries in ${auditPath(home)}.`); return 0; }
      for (const e of rows) out(formatEntry(e));
      return 0;
    }
    default:
      err(USAGE); return 2;
  }
}
