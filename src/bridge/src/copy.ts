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
  styles?: DefMode;
  variables?: DefMode;
  components?: DefMode;
}

// How styles / variables the copied layers use reach the target:
// create = use the target's (same key, or same name) and create the missing
// ones there (what a paste in Figma does); match = use the target's, detach the
// rest (their values stay); detach = never link, keep plain values.
export type DefMode = 'create' | 'match' | 'detach';
export type How = 'key' | 'import' | 'name' | 'create' | 'copy' | 'detach';

export interface Inventory {
  styles: Array<{ id: string; key: string; name: string; type: string }>;
  variables: Array<{ id: string; key: string; name: string; resolvedType: string; collection?: string }>;
  collections?: Array<{ id: string; name: string; modes: string[] }>;
  components?: Array<{ id: string; key: string; name: string; setName?: string }>;
}

// A main component that copied instances use.
export interface CompRef { componentId: string; key?: string; name: string; remote?: boolean; setName?: string }

// Every main component used by an instance anywhere in these spec trees.
export function collectInstances(specs: any[]): Map<string, CompRef> {
  const out = new Map<string, CompRef>();
  const visit = (s: any) => {
    if (!s || typeof s !== 'object') return;
    const i = s.instance;
    if (i && i.componentId && !out.has(i.componentId)) {
      out.set(i.componentId, { componentId: i.componentId, key: i.key, name: i.name, remote: !!i.remote, ...(i.setName ? { setName: i.setName } : {}) });
    }
    for (const c of s.children ?? []) visit(c);
  };
  for (const s of specs) visit(s);
  return out;
}

export interface CompPlan {
  componentMap: Record<string, string>;
  toImport: Array<{ componentId: string; key: string }>;
  how: Record<string, How>;
}

// Pure: how each main component reaches the target. create = library ones
// imported by key, local ones copied along ('copy': the bridge copies the
// exported components first and fills componentMap from that); match = library
// ones imported, local ones matched by name (and set name) in the target;
// detach = instances become plain frames. A target component with the same
// key is always used.
export function planComponents(
  refs: Map<string, CompRef>,
  mode: DefMode,
  targetComponents: NonNullable<Inventory['components']>,
  imported: Record<string, string | null> = {},
): CompPlan {
  const plan: CompPlan = { componentMap: {}, toImport: [], how: {} };
  for (const r of refs.values()) {
    const set = (how: How, id?: string) => { plan.how[r.componentId] = how; if (id) plan.componentMap[r.componentId] = id; };
    if (mode === 'detach') { set('detach'); continue; }
    const byKey = r.key ? targetComponents.find((t) => t.key === r.key) : undefined;
    if (byKey) { set('key', byKey.id); continue; }
    if (r.remote && r.key) {
      const got = imported[r.componentId];
      if (got === undefined) { plan.toImport.push({ componentId: r.componentId, key: r.key }); continue; }
      if (got) { set('import', got); continue; }
    }
    if (!r.remote && mode === 'create') { set('copy'); continue; }
    const byName = targetComponents.find((t) => t.name === r.name && (t.setName ?? null) === (r.setName ?? null));
    if (byName) { set('name', byName.id); continue; }
    set('detach');
  }
  return plan;
}

export interface DefPlan {
  styleMap: Record<string, string>;
  variableMap: Record<string, string>;
  // Library items to import into the target by key before the copy (remote
  // in the source); `imported` on the next planDefinitions call says how it went.
  toImport: { styles: Array<{ srcId: string; key: string }>; variables: Array<{ srcId: string; key: string }> };
  create: { styles: any[]; variables: any[] };
  how: { styles: Record<string, How>; variables: Record<string, How> };
}

// Pure: decide, for every style and variable the copied layers use, how it
// reaches the target. `imported` holds the results of earlier key imports
// (target id, or null when the library is not available there).
export function planDefinitions(
  exp: { styles?: Record<string, any>; variables?: Record<string, any> },
  inv: Inventory,
  modes: { styles: DefMode; variables: DefMode },
  imported: { styles: Record<string, string | null>; variables: Record<string, string | null> } = { styles: {}, variables: {} },
): DefPlan {
  const plan: DefPlan = {
    styleMap: {}, variableMap: {}, toImport: { styles: [], variables: [] },
    create: { styles: [], variables: [] }, how: { styles: {}, variables: {} },
  };
  // Styles
  for (const st of Object.values(exp.styles ?? {}) as any[]) {
    const set = (how: How, id?: string) => { plan.how.styles[st.id] = how; if (id) plan.styleMap[st.id] = id; };
    if (modes.styles === 'detach') { set('detach'); continue; }
    const byKey = inv.styles.find((t) => t.key && t.key === st.key);
    if (byKey) { set('key', byKey.id); continue; }
    if (st.remote && st.key) {
      const r = imported.styles[st.id];
      if (r === undefined) { plan.toImport.styles.push({ srcId: st.id, key: st.key }); continue; }
      if (r) { set('import', r); continue; }
    }
    const byName = inv.styles.find((t) => t.name === st.name && t.type === st.type);
    if (byName) { set('name', byName.id); continue; }
    if (modes.styles === 'create' && st.value) {
      set('create');
      plan.create.styles.push({ srcId: st.id, type: st.type, name: st.name, description: st.description, value: st.value });
      continue;
    }
    set('detach');
  }
  // Variables: the ones the layers (and styles) use, plus what the ones we
  // create alias.
  const all = exp.variables ?? {};
  const queue = (Object.values(all) as any[]).filter((v) => v.direct !== false).map((v) => v.id);
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const v = all[id];
    if (!v) continue;
    const set = (how: How, tid?: string) => { plan.how.variables[id] = how; if (tid) plan.variableMap[id] = tid; };
    if (modes.variables === 'detach') { set('detach'); continue; }
    const byKey = inv.variables.find((t) => t.key && t.key === v.key);
    if (byKey) { set('key', byKey.id); continue; }
    if (v.remote && v.key) {
      const r = imported.variables[id];
      if (r === undefined) { plan.toImport.variables.push({ srcId: id, key: v.key }); continue; }
      if (r) { set('import', r); continue; }
    }
    const sameType = inv.variables.filter((t) => t.name === v.name && t.resolvedType === v.resolvedType);
    const byName = sameType.find((t) => t.collection === v.collection) ?? (sameType.length === 1 ? sameType[0] : undefined);
    if (byName) { set('name', byName.id); continue; }
    if (modes.variables === 'create') {
      set('create');
      plan.create.variables.push({
        srcId: id, name: v.name, resolvedType: v.resolvedType, collection: v.collection, collectionModes: v.collectionModes,
        modes: v.modes ?? [], scopes: v.scopes, description: v.description,
      });
      for (const m of v.modes ?? []) {
        if (m.value && typeof m.value === 'object' && m.value.type === 'VARIABLE_ALIAS') queue.push(m.value.id);
      }
      continue;
    }
    set('detach');
  }
  return plan;
}

// Counts + named items (capped) for the report.
export function summarizeHow(how: Record<string, How>, defs: Record<string, any>): Record<string, unknown> {
  const counts: Record<string, number> = {};
  const items: Array<{ name: string; how: How }> = [];
  for (const [id, h] of Object.entries(how)) {
    counts[h] = (counts[h] ?? 0) + 1;
    if (items.length < 50) items.push({ name: defs[id]?.name ?? id, how: h });
  }
  return { referenced: Object.keys(how).length, ...counts, items };
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

// In a dry run nothing is imported yet: list library items as 'import'.
function dryHow(how: Record<string, How>, toImport: Array<{ srcId: string }>): Record<string, How> {
  const out = { ...how };
  for (const t of toImport) out[t.srcId] = 'import';
  return out;
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
  const styleMode: DefMode = opts.styles ?? 'create';
  const varMode: DefMode = opts.variables ?? 'create';
  const compMode: DefMode = opts.components ?? 'create';
  const needInv = styleMode !== 'detach' || varMode !== 'detach' || compMode === 'match';
  const check = await on<any>(tgt.sessionId, 'copy_check', needInv ? { inventory: true, ...(compMode === 'match' ? { components: true } : {}) } : {});
  if (!check?.editable) {
    throw new Error(`copy_target_read_only: "${tgt.fileName}" cannot be edited (${check?.reason ?? check?.editorType ?? 'view only'}). Open it with edit access in Design mode, then retry.`);
  }

  const exp = await on<any>(src.sessionId, 'export_tree', {
    ...(nodeIds.length ? { nodeIds } : { useSelection: true }),
    ...(typeof opts.maxNodes === 'number' ? { maxNodes: opts.maxNodes } : {}),
    ...(compMode === 'create' ? { includeComponents: true } : {}),
  });
  const roots: any[] = exp.roots ?? [];
  // Local main components copied along (create mode). Built dependencies
  // first: a component is exported before the ones it uses.
  const comps: any[] = [...(exp.components ?? [])].reverse();
  const refs = collectInstances([...roots, ...comps]);
  const fonts: Array<{ family: string; style: string }> = exp.fonts ?? [];
  const fontCheck = fonts.length ? await on<any>(tgt.sessionId, 'copy_check', { fonts }) : { missingFonts: [] };

  const inv: Inventory = check.inventory ?? { styles: [], variables: [] };
  const modes = { styles: styleMode, variables: varMode };
  let plan = planDefinitions(exp, inv, modes);
  let cplan = planComponents(refs, compMode, inv.components ?? []);
  const refNames = Object.fromEntries([...refs.values()].map((r) => [r.componentId, { name: r.setName ? `${r.setName} / ${r.name}` : r.name }]));
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
      // 'import' here means: from a library, imported by key if the target has that library.
      styles: summarizeHow(dryHow(plan.how.styles, plan.toImport.styles), exp.styles ?? {}),
      variables: summarizeHow(dryHow(plan.how.variables, plan.toImport.variables), exp.variables ?? {}),
      components: summarizeHow(dryHow(cplan.how, cplan.toImport.map((t) => ({ srcId: t.componentId }))), refNames),
      instances: (exp.instances ?? []).length,
      note: 'Nothing was written. Run again without dryRun to copy.',
    };
  }

  // Library styles/variables: import them into the target by key (rounds:
  // a created variable can alias another library variable).
  const imported = { styles: {} as Record<string, string | null>, variables: {} as Record<string, string | null> };
  for (let round = 0; round < 5 && (plan.toImport.styles.length || plan.toImport.variables.length); round++) {
    for (const it of plan.toImport.styles) {
      try { imported.styles[it.srcId] = (await on<any>(tgt.sessionId, 'import_style_by_key', { key: it.key })).id ?? null; }
      catch { imported.styles[it.srcId] = null; }
    }
    for (const it of plan.toImport.variables) {
      try { imported.variables[it.srcId] = (await on<any>(tgt.sessionId, 'import_variable_by_key', { key: it.key })).id ?? null; }
      catch { imported.variables[it.srcId] = null; }
    }
    plan = planDefinitions(exp, inv, modes, imported);
  }

  // Library components: import by key (a variant's key brings its set).
  if (cplan.toImport.length) {
    const got: Record<string, string | null> = {};
    for (const it of cplan.toImport) {
      try { got[it.componentId] = (await on<any>(tgt.sessionId, 'import_component_by_key', { key: it.key })).id ?? null; }
      catch { got[it.componentId] = null; }
    }
    cplan = planComponents(refs, compMode, inv.components ?? [], got);
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
  const img = rewriteImages([...roots, ...comps], imageMap, failed);

  // Local components first (create mode), on the target page at their source
  // positions; their ids and new property keys feed the main import.
  let styleMap = plan.styleMap, variableMap = plan.variableMap;
  let create: DefPlan['create'] | undefined = plan.create.styles.length || plan.create.variables.length ? plan.create : undefined;
  let propKeyMap: Record<string, string> = {};
  let compRes: any;
  const copied = Object.entries(cplan.how).filter(([, h]) => h === 'copy').map(([id]) => id);
  if (copied.length && comps.length) {
    compRes = await on<any>(tgt.sessionId, 'import_tree', {
      roots: comps,
      ...(opts.pageId ? { pageId: opts.pageId } : {}),
      ...(opts.reactions === false ? { reactions: false } : {}),
      styleMap, variableMap, componentMap: cplan.componentMap, returnIdMap: true,
      ...(create ? { create } : {}),
    });
    styleMap = compRes.styleMap ?? styleMap;
    variableMap = compRes.variableMap ?? variableMap;
    create = undefined;
    propKeyMap = compRes.propKeyMap ?? {};
  }
  // A main component that is itself among the copied layers is built in the
  // same import (the plugin maps it there), so it stays 'copy'.
  const inTree = new Set<string>();
  const walk = (x: any) => { inTree.add(x.sourceId); for (const c of x.children ?? []) walk(c); };
  for (const r of roots) walk(r);
  for (const id of copied) {
    const to = compRes?.idMap?.[id];
    if (to) cplan.componentMap[id] = to;
    else if (!inTree.has(id)) cplan.how[id] = 'detach';
  }

  const res = await on<any>(tgt.sessionId, 'import_tree', {
    roots,
    ...(opts.parentId ? { parentId: opts.parentId } : {}),
    ...(opts.pageId ? { pageId: opts.pageId } : {}),
    ...(typeof opts.x === 'number' ? { x: opts.x } : {}),
    ...(typeof opts.y === 'number' ? { y: opts.y } : {}),
    ...(opts.select ? { select: true } : {}),
    ...(opts.reactions === false ? { reactions: false } : {}),
    styleMap, variableMap, componentMap: cplan.componentMap, propKeyMap,
    ...(create ? { create } : {}),
  });
  // Anything the target failed to create is detached.
  for (const [id, h] of Object.entries(plan.how.styles)) if (h === 'create' && !res.styleMap?.[id]) plan.how.styles[id] = 'detach';
  for (const [id, h] of Object.entries(plan.how.variables)) if (h === 'create' && !res.variableMap?.[id]) plan.how.variables[id] = 'detach';

  const skipped: any[] = [...(compRes?.skipped ?? []), ...(res.skipped ?? [])];
  for (const u of summary.unsupported) skipped.push({ sourceId: u.sourceId, name: u.name, what: 'layer', reason: `${u.type} layers cannot be copied between files` });
  if (imageErrors.length) for (const e of imageErrors) skipped.push({ what: 'image', reason: `image ${e.hash.slice(0, 8)}: ${e.reason}` });
  if (img.videos) skipped.push({ what: 'video', reason: `${img.videos} video fill(s) cannot be copied between files` });
  return {
    copied: true,
    ...base,
    created: { count: res.created ?? 0, roots: res.roots ?? [], parentId: res.parentId },
    images: { moved: Object.keys(imageMap).length, failed: imageErrors.length },
    missingFonts: res.missingFonts ?? [],
    styles: summarizeHow(plan.how.styles, exp.styles ?? {}),
    variables: summarizeHow(plan.how.variables, exp.variables ?? {}),
    components: {
      ...summarizeHow(cplan.how, refNames),
      ...(compRes ? { copiedTo: { count: compRes.created ?? 0, roots: compRes.roots ?? [] } } : {}),
    },
    instances: { count: (exp.instances ?? []).length, detached: (res.detachedInstances ?? 0) + (compRes?.detachedInstances ?? 0) },
    skipped,
  };
}
