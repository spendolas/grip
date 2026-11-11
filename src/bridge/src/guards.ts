// Guards for the few tools where the BRIDGE touches the user's disk or opens something for
// them on an agent's say-so: upload_image_from_path (reads a file), export_node with a path
// (writes a file), open_external_url / create_image_from_url / create_link_preview (reach out).
// An agent can be steered by text inside a Figma document it reads, so these tools must not be
// a way to read a secret, overwrite a dotfile or fetch a loopback address.
//
// Policy (set GRIP_ALLOW_ANY_PATH=1 to switch the path rules off, GRIP_ALLOWED_DIRS=dir1:dir2
// to allow more directories):
//  - only inside the home directory or the temp directory (and GRIP_ALLOWED_DIRS);
//  - never through a hidden file or directory (~/.ssh, ~/.zshrc, ~/.config ...) or ~/Library;
//  - symlinks are resolved first, so a link cannot lead out;
//  - reads: a regular file of at most 64 MB whose first bytes are a PNG, JPEG, GIF or WebP;
//  - writes: the extension must match the export format, and an existing file is only
//    replaced with overwrite:true.
import { lstat, realpath, stat, open } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve, sep, basename } from 'node:path';

const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

export type PathCheck = { ok: true; path: string } | { ok: false; error: string };

function expand(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~' + sep)) return join(homedir(), p.slice(2));
  return isAbsolute(p) ? p : resolve(p);
}

async function realOrSelf(p: string): Promise<string> {
  try { return await realpath(p); } catch { return p; }
}

async function allowedRoots(): Promise<string[]> {
  const roots = [homedir(), tmpdir(), ...(process.env.GRIP_ALLOWED_DIRS ?? '').split(delimiter).filter(Boolean).map(expand)];
  return Promise.all(roots.map(realOrSelf));
}

const within = (p: string, root: string): boolean => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

// Real path of the deepest existing ancestor of `p`, with the missing tail re-attached.
async function resolveThroughSymlinks(p: string): Promise<string> {
  const tail: string[] = [];
  let cur = p;
  for (;;) {
    try { return join(await realpath(cur), ...tail.reverse()); }
    catch {
      const up = dirname(cur);
      if (up === cur) return p;
      tail.push(basename(cur));
      cur = up;
    }
  }
}

async function checkLocation(raw: string, verb: 'read' | 'write'): Promise<PathCheck> {
  if (typeof raw !== 'string' || raw === '' || raw.includes('\0')) return { ok: false, error: `${verb}: empty or invalid path` };
  const lexical = expand(raw);
  const real = await resolveThroughSymlinks(lexical);
  if (process.env.GRIP_ALLOW_ANY_PATH === '1') return { ok: true, path: real };
  const roots = await allowedRoots();
  const root = roots.find((r) => within(real, r));
  if (!root) {
    return { ok: false, error: `Refusing to ${verb} ${raw}: outside the home and temp directories. Add the folder to GRIP_ALLOWED_DIRS on the bridge if you really want it.` };
  }
  const rel = real.slice(root.length).split(sep).filter(Boolean);
  const hidden = rel.find((c) => c.startsWith('.'));
  if (hidden) return { ok: false, error: `Refusing to ${verb} ${raw}: path goes through the hidden entry "${hidden}" (dotfiles and dot directories such as ~/.ssh are off limits).` };
  if (root === (await realOrSelf(homedir())) && rel[0] === 'Library') {
    return { ok: false, error: `Refusing to ${verb} ${raw}: ~/Library is off limits.` };
  }
  return { ok: true, path: real };
}

// upload_image_from_path
export async function checkImageRead(raw: string): Promise<PathCheck & { bytes?: Buffer }> {
  const loc = await checkLocation(raw, 'read');
  if (!loc.ok) return loc;
  try {
    const st = await stat(loc.path);
    if (!st.isFile()) return { ok: false, error: `${raw} is not a regular file.` };
    if (st.size > MAX_IMAGE_BYTES) return { ok: false, error: `${raw} is ${Math.round(st.size / 1048576)} MB, over the ${MAX_IMAGE_BYTES / 1048576} MB image limit.` };
    const fh = await open(loc.path, 'r');
    try {
      const head = Buffer.alloc(12);
      await fh.read(head, 0, 12, 0);
      if (!looksLikeImage(head)) return { ok: false, error: `${raw} is not a PNG, JPEG, GIF or WebP image, so it was not read.` };
      const all = Buffer.alloc(st.size);
      let off = 0;
      while (off < st.size) {
        const { bytesRead } = await fh.read(all, off, st.size - off, off);
        if (bytesRead === 0) break;
        off += bytesRead;
      }
      return { ok: true, path: loc.path, bytes: all.subarray(0, off) };
    } finally { await fh.close(); }
  } catch (err) {
    return { ok: false, error: `Failed to read ${raw}: ${(err as Error).message}` };
  }
}

export function looksLikeImage(h: Buffer): boolean {
  if (h.length >= 8 && h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4e && h[3] === 0x47) return true;                  // PNG
  if (h.length >= 3 && h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return true;                                    // JPEG
  if (h.length >= 6 && h.toString('latin1', 0, 4) === 'GIF8') return true;                                              // GIF
  if (h.length >= 12 && h.toString('latin1', 0, 4) === 'RIFF' && h.toString('latin1', 8, 12) === 'WEBP') return true;    // WebP
  return false;
}

const EXT_OK: Record<string, string[]> = {
  SVG: ['svg'], PNG: ['png'], JPG: ['jpg', 'jpeg'], PDF: ['pdf'], CSS: ['css'], JSON: ['json'],
  MP4: ['mp4'], GIF: ['gif'], WEBM: ['webm'],
};

// export_node with an explicit path
export async function checkExportWrite(raw: string, format: string, overwrite: boolean): Promise<PathCheck> {
  const loc = await checkLocation(raw, 'write');
  if (!loc.ok) return loc;
  const exts = EXT_OK[format] ?? [format.toLowerCase()];
  const ext = basename(loc.path).includes('.') ? basename(loc.path).split('.').pop()!.toLowerCase() : '';
  if (process.env.GRIP_ALLOW_ANY_PATH !== '1' && !exts.includes(ext)) {
    return { ok: false, error: `export_node ${format}: the path must end in .${exts[0]} (got ${raw}). Exports only write files with the format's own extension.` };
  }
  try {
    const st = await lstat(loc.path);
    if (st.isSymbolicLink()) return { ok: false, error: `Refusing to write ${raw}: it is a symbolic link.` };
    if (!overwrite) return { ok: false, error: `${raw} already exists. Pass overwrite:true to replace it, or choose another path.` };
  } catch { /* does not exist yet: fine */ }
  return { ok: true, path: loc.path };
}

// ---- web URLs ----
// Anything the agent asks the user's browser or Figma to open or fetch must be a plain web URL
// that does not point at this machine or the local network. The URL is parsed first (WHATWG
// parsing already turns decimal/hex/octal IPv4 such as http://2130706433/ into 127.0.0.1), the
// host is then judged as an address (IPv4, IPv6 including IPv4-mapped and NAT64 forms) or as a
// name. A DNS name that RESOLVES to a local address cannot be caught here (known limit).
function ipv4Local(a: number, b: number): boolean {
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

// Expand an IPv6 literal (no brackets, no zone) to 8 groups; null if it is not valid.
function parseIPv6(h: string): number[] | null {
  if (!/^[0-9a-f:.]+$/i.test(h)) return null;
  let t = h;
  const m = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(t);
  if (m) {
    const o = m.slice(1).map(Number);
    if (o.some((n) => n > 255)) return null;
    t = t.slice(0, m.index) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
  }
  const parts = t.split('::');
  if (parts.length > 2) return null;
  const groups = (x: string) => (x === '' ? [] : x.split(':'));
  const head = groups(parts[0]);
  const rest = parts.length === 2 ? groups(parts[1]) : [];
  if (parts.length === 1 && head.length !== 8) return null;
  if (parts.length === 2 && head.length + rest.length > 7) return null;
  const fill = parts.length === 2 ? new Array<string>(8 - head.length - rest.length).fill('0') : [];
  const nums = [...head, ...fill, ...rest].map((x) => (/^[0-9a-f]{1,4}$/i.test(x) ? parseInt(x, 16) : NaN));
  return nums.length === 8 && nums.every(Number.isFinite) ? nums : null;
}

function ipv6Local(g: number[]): boolean {
  if (g.every((x) => x === 0)) return true;                                           // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true;                 // ::1
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && (g[5] === 0xffff || g[5] === 0)) {
    return ipv4Local(g[6] >> 8, g[6] & 255);                                          // ::ffff:a.b.c.d and ::a.b.c.d
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return ipv4Local(g[6] >> 8, g[6] & 255);   // NAT64
  if ((g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xff00) === 0xff00) return true;                // fc00::/7, fe80::/10, ff00::/8
  if (g[0] === 0x2002) return ipv4Local(g[1] >> 8, g[1] & 255);                       // 6to4
  return false;
}

export function hostIsLocal(hostname: string): boolean {
  let h = hostname.toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) {
    const g = parseIPv6(h.slice(1, -1).replace(/%.*$/, ''));
    return g === null ? true : ipv6Local(g);              // an unparseable literal is refused
  }
  h = h.replace(/\.+$/, '');                                // "localhost." is localhost
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (v4) return ipv4Local(Number(v4[1]), Number(v4[2]));
  if (h === '' || !h.includes('.')) return true;            // "intranet", "printer": single-label names are local
  return h === 'localhost' || ['.localhost', '.local', '.internal', '.lan', '.home', '.home.arpa', '.corp', '.intranet', '.localdomain'].some((x) => h.endsWith(x));
}

export function checkWebUrl(raw: unknown, what: string): { ok: true; url: string } | { ok: false; error: string } {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return { ok: false, error: `${what}: url must be a non-empty string of at most 2048 characters.` };
  let u: URL;
  try { u = new URL(raw); } catch { return { ok: false, error: `${what}: not a valid URL.` }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, error: `${what}: only http(s) URLs are allowed (got ${u.protocol}).` };
  if (u.username || u.password) return { ok: false, error: `${what}: URLs with embedded credentials are refused.` };
  if (hostIsLocal(u.hostname) && process.env.GRIP_ALLOW_LOCAL_URLS !== '1') {
    return { ok: false, error: `${what}: ${u.hostname} is a local or private address; refused (set GRIP_ALLOW_LOCAL_URLS=1 on the bridge to allow).` };
  }
  return { ok: true, url: u.toString() };
}
