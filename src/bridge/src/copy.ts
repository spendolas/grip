// copy_between_files: copy layers from one open file to another, bridge-side.
//
// The bridge reads the source subtree from the source window (export_tree),
// moves image bytes (get_image_by_hash -> upload_image), maps styles, variables
// and components to the target (see the map* functions), and rebuilds the tree
// in the target window (import_tree). The tree never passes through the model:
// the agent gets a report. Both files must run a plugin with the `copyTree`
// capability.
import type { PluginBridge } from './ws-server.js';
import { callContext } from './ws-server.js';
import type { McpSession } from './types.js';

export interface CopyOptions {
  nodeIds?: string[];
  parentId?: string;
  pageId?: string;
  x?: number;
  y?: number;
  select?: boolean;
  maxNodes?: number;
  reactions?: boolean;
}

export interface CopyArgs {
  from: string;
  to: string;
  options?: CopyOptions;
  dryRun?: boolean;
}

export interface FileSide {
  fileName: string;
  fileKey: string | null;
  sessionId: string;
}

// A figma.com URL's ?node-id=1-2 (or 1:2, %3A) -> "1:2".
export function nodeIdFromUrl(target: string): string | undefined {
  if (!/^https?:\/\//i.test(target)) return undefined;
  try {
    const raw = new URL(target).searchParams.get('node-id');
    if (!raw) return undefined;
    const id = raw.replace(/-/g, ':');
    return /^[0-9]+:[0-9]+$/.test(id) || /^I?[0-9:;]+$/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

// Every paint list in a spec tree (node fills/strokes and text segment fills),
// for image rewriting and counting.
export function forEachPaintList(roots: any[], fn: (list: any[], owner: any) => any[] | void): void {
  const visit = (spec: any) => {
    if (!spec || typeof spec !== 'object') return;
    for (const k of ['fills', 'strokes']) {
      const l = spec.props?.[k];
      if (Array.isArray(l)) { const r = fn(l, spec); if (r) spec.props[k] = r; }
    }
    for (const seg of spec.text?.segments ?? []) {
      if (Array.isArray(seg.fills)) { const r = fn(seg.fills, spec); if (r) seg.fills = r; }
    }
    for (const c of spec.children ?? []) visit(c);
  };
  for (const r of roots) visit(r);
}

// Point image paints at the target's hashes; drop the ones whose bytes could
// not be moved (and video paints, which cannot be moved at all).
export function rewriteImages(roots: any[], map: Record<string, string>, failed: Set<string>): { dropped: number; videos: number } {
  let dropped = 0, videos = 0;
  forEachPaintList(roots, (list) => {
    const out: any[] = [];
    for (const p of list) {
      if (p && p.type === 'VIDEO') { videos++; continue; }
      if (p && typeof p.imageHash === 'string') {
        if (failed.has(p.imageHash)) { dropped++; continue; }
        if (map[p.imageHash]) { out.push({ ...p, imageHash: map[p.imageHash] }); continue; }
      }
      out.push(p);
    }
    return out;
  });
  return { dropped, videos };
}

function countNodes(roots: any[]): number {
  let n = 0;
  const v = (s: any) => { n++; for (const c of s.children ?? []) v(c); };
  for (const r of roots) v(r);
  return n;
}

export async function copyBetweenFiles(
  bridge: PluginBridge,
  mcp: McpSession,
  args: CopyArgs,
  others: McpSession[] = [],
): Promise<Record<string, unknown>> {
  const from = String(args.from ?? '').trim();
  const to = String(args.to ?? '').trim();
  if (!from || !to) throw new Error('copy_missing_file: both `from` and `to` are required (fileKey, exact file name, sessionId or figma.com URL; see list_files).');
  const opts: CopyOptions = args.options ?? {};
  const nodeIds = Array.isArray(opts.nodeIds) && opts.nodeIds.length ? opts.nodeIds.map(String) : (nodeIdFromUrl(from) ? [nodeIdFromUrl(from)!] : []);

  const src = await bridge.describeTarget(from, mcp, others);
  const tgt = await bridge.describeTarget(to, mcp, others);
  const side = (d: typeof src): FileSide => ({ fileName: d.fileName, fileKey: d.fileKey, sessionId: d.sessionId });
  if (src.entryId === tgt.entryId) {
    throw new Error(`copy_same_file: \`from\` and \`to\` are the same file ("${src.fileName}"). To duplicate layers inside one file use clone_node.`);
  }
  for (const [label, d] of [['source', src], ['target', tgt]] as const) {
    if (!d.capabilities.includes('copyTree')) {
      throw new Error(`plugin_too_old: the Grip plugin in the ${label} file "${d.fileName}" (version ${d.pluginVersion}) cannot copy between files. Update the Grip plugin in Figma, then retry.`);
    }
  }
  const warnings: string[] = [];
  if (tgt.boundAgents > 0) {
    warnings.push(`${tgt.boundAgents} other agent${tgt.boundAgents === 1 ? ' is' : 's are'} bound to "${tgt.fileName}": the copy can collide with their edits.`);
  }

  // Every call below goes to the exact window resolved above.
  const on = <T = any>(sessionId: string, method: string, params: Record<string, unknown>): Promise<T> =>
    callContext.run({ fileTarget: sessionId }, () => bridge.request(method, params, mcp)) as Promise<T>;

  // Target first: a read-only target fails before anything is read.
  const check = await on<any>(tgt.sessionId, 'copy_check', {});
  if (!check?.editable) {
    throw new Error(`copy_target_read_only: "${tgt.fileName}" cannot be edited (${check?.reason ?? check?.editorType ?? 'view only'}). Open it with edit access in Design mode, then retry.`);
  }

  const exp = await on<any>(src.sessionId, 'export_tree', {
    ...(nodeIds.length ? { nodeIds } : { useSelection: true }),
    ...(typeof opts.maxNodes === 'number' ? { maxNodes: opts.maxNodes } : {}),
  });
  const roots: any[] = exp.roots ?? [];
  const fonts: Array<{ family: string; style: string }> = exp.fonts ?? [];
  const fontCheck = fonts.length ? await on<any>(tgt.sessionId, 'copy_check', { fonts }) : { missingFonts: [] };

  const styles = Object.values(exp.styles ?? {}) as any[];
  const variables = Object.values(exp.variables ?? {}) as any[];
  const summary = {
    layers: exp.count ?? countNodes(roots),
    byType: exp.byType ?? {},
    roots: roots.map((r) => ({ sourceId: r.sourceId, name: r.name, type: r.type })),
    images: (exp.images ?? []).length,
    unsupported: exp.unsupported ?? [],
  };
  const base = {
    from: side(src),
    to: side(tgt),
    ...(warnings.length ? { warnings } : {}),
  };

  if (args.dryRun) {
    return {
      dryRun: true,
      ...base,
      wouldCopy: summary,
      missingFonts: fontCheck.missingFonts ?? [],
      styles: { referenced: styles.length, willDetach: styles.length },
      variables: { referenced: variables.length, willDetach: variables.length },
      instances: { count: (exp.instances ?? []).length, willDetach: (exp.instances ?? []).length },
      note: 'Nothing was written. Run again without dryRun to copy.',
    };
  }

  // Images: move the bytes, then point the paints at the target's hashes.
  const imageMap: Record<string, string> = {};
  const failed = new Set<string>();
  const imageErrors: Array<{ hash: string; reason: string }> = [];
  for (const hash of exp.images ?? []) {
    try {
      const img = await on<any>(src.sessionId, 'get_image_by_hash', { imageHash: hash });
      if (!img?.base64) throw new Error('the source file has no bytes for this image');
      const up = await on<any>(tgt.sessionId, 'upload_image', { base64: img.base64 });
      imageMap[hash] = up.imageHash;
    } catch (e) {
      failed.add(hash);
      imageErrors.push({ hash, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  const img = rewriteImages(roots, imageMap, failed);

  const res = await on<any>(tgt.sessionId, 'import_tree', {
    roots,
    ...(opts.parentId ? { parentId: opts.parentId } : {}),
    ...(opts.pageId ? { pageId: opts.pageId } : {}),
    ...(typeof opts.x === 'number' ? { x: opts.x } : {}),
    ...(typeof opts.y === 'number' ? { y: opts.y } : {}),
    ...(opts.select ? { select: true } : {}),
    ...(opts.reactions === false ? { reactions: false } : {}),
  });

  const skipped: any[] = [...(res.skipped ?? [])];
  for (const u of summary.unsupported) skipped.push({ sourceId: u.sourceId, name: u.name, what: 'layer', reason: `${u.type} layers cannot be copied between files` });
  if (imageErrors.length) for (const e of imageErrors) skipped.push({ what: 'image', reason: `image ${e.hash.slice(0, 8)}: ${e.reason}` });
  if (img.videos) skipped.push({ what: 'video', reason: `${img.videos} video fill(s) cannot be copied between files` });
  return {
    copied: true,
    ...base,
    created: { count: res.created ?? 0, roots: res.roots ?? [], parentId: res.parentId },
    images: { moved: Object.keys(imageMap).length, failed: imageErrors.length },
    missingFonts: res.missingFonts ?? [],
    styles: { referenced: styles.length, detached: styles.length },
    variables: { referenced: variables.length, detached: variables.length },
    instances: { count: (exp.instances ?? []).length, detached: res.detachedInstances ?? 0 },
    skipped,
  };
}
