// copy_between_files, bridge side: real PluginBridge + MCP client, fake plugins.
// Checks the routing and guards (same file, read-only target, old plugin,
// ambiguous / missing files, other agent bound), that the target is checked
// before the source is read, that dryRun writes nothing, that image bytes move
// from source to target and the paints are re-pointed, and that the caller's
// own binding never moves. The plugin half (export_tree / import_tree) is
// covered by test/copy-tree.mjs.
import assert from 'node:assert';
import { createServer as createNetServer } from 'node:net';
import { WebSocket } from 'ws';

process.env.GRIP_NO_UPDATE_CHECK = '1';
process.env.GRIP_REQUEST_TIMEOUT_MS = '2000';

const { PluginBridge } = await import('../dist/ws-server.js');
const { createSession } = await import('../dist/mcp-server.js');
const { toolMayChangeDocument } = await import('../dist/methods.js');
const { TOOLS, toolInScope, resolveToolScope } = await import('../dist/tools.js');
const { nodeIdFromUrl, rewriteImages, planDefinitions } = await import('../dist/copy.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

setTimeout(() => { console.error('copy-files.mjs: timed out'); process.exit(1); }, 40_000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (pred, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (pred()) return true; await sleep(10); } return false; };

const port = await new Promise((res) => { const s = createNetServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const bridge = new PluginBridge(port);
await new Promise((r) => bridge.once('listening', r));

const TREE = {
  roots: [{
    type: 'FRAME', name: 'Card', sourceId: '1:2', props: { width: 100, height: 50, fills: [{ type: 'IMAGE', imageHash: 'h-src', scaleMode: 'FILL' }, { type: 'IMAGE', imageHash: 'h-bad', scaleMode: 'FILL' }, { type: 'VIDEO', videoHash: 'v' }] },
    children: [{ type: 'TEXT', name: 'Label', sourceId: '1:3', props: {}, text: { characters: 'Hi', segments: [{ start: 0, end: 2, fontName: { family: 'Inter', style: 'Bold' }, fills: [{ type: 'IMAGE', imageHash: 'h-src' }] }] } }],
  }],
  components: [], count: 2, byType: { FRAME: 1, TEXT: 1 }, unsupported: [{ sourceId: '1:9', name: 'Sticky', type: 'STICKY' }],
  images: ['h-src', 'h-bad'], fonts: [{ family: 'Inter', style: 'Bold' }, { family: 'Brand', style: 'Regular' }],
  styles: {
    'S:1': { id: 'S:1', key: 'k1', name: 'Brand/Blue', type: 'PAINT', remote: false, value: { paints: [] } },
    'S:2': { id: 'S:2', key: 'lib-k', name: 'Lib/Red', type: 'PAINT', remote: true, value: { paints: [] } },
  },
  variables: { 'V:1': { id: 'V:1', key: 'vk', name: 'space/4', resolvedType: 'FLOAT', collection: 'Tokens', modes: [{ mode: 'Default', value: 4 }], direct: true } },
  instances: [{ sourceId: '1:4', componentId: '5:1' }], localComponents: ['5:1'],
};

async function plugin(fileKey, fileName, { caps = ['copyTree'], editable = true } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const p = { ws, got: [] };
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.kind === 'welcome') {
      ws.send(JSON.stringify({ kind: 'hello', version: '0.10.0', capabilities: caps, fileKey, fileName, currentPageId: '0:1', currentPageName: 'P' }));
      return;
    }
    if (!m.id || !m.method) return;
    p.got.push(m);
    const reply = (result) => ws.send(JSON.stringify({ id: m.id, result }));
    switch (m.method) {
      case 'copy_check': return reply({
        editable, editorType: 'figma', ...(editable ? {} : { reason: 'view only' }), missingFonts: (m.params.fonts ?? []).filter((f) => f.family === 'Brand'),
        ...(m.params.inventory ? { inventory: { styles: [], variables: [{ id: 'VT:9', key: 'x', name: 'space/4', resolvedType: 'FLOAT', collection: 'Spacing' }], collections: [] } } : {}),
      });
      case 'import_style_by_key': return reply({ id: 'ST:lib', key: m.params.key });
      case 'import_variable_by_key': return ws.send(JSON.stringify({ id: m.id, error: 'library_key_unresolved: no' }));
      case 'export_tree': return reply(JSON.parse(JSON.stringify(TREE)));
      case 'get_image_by_hash':
        if (m.params.imageHash === 'h-bad') return ws.send(JSON.stringify({ id: m.id, error: 'response_too_large: image too big' }));
        return reply({ hash: m.params.imageHash, base64: 'QUJD' });
      case 'upload_image': return reply({ imageHash: 'h-tgt' });
      case 'import_tree': return reply({
        roots: [{ id: '9:1', name: 'Card', type: 'FRAME', sourceId: '1:2' }], created: 2, detachedInstances: 0, missingFonts: [], skipped: [], parentId: '0:1',
        styleMap: { ...(m.params.styleMap ?? {}), ...Object.fromEntries((m.params.create?.styles ?? []).map((x) => [x.srcId, 'new-' + x.srcId])) },
        variableMap: { ...(m.params.variableMap ?? {}), ...Object.fromEntries((m.params.create?.variables ?? []).map((x) => [x.srcId, 'new-' + x.srcId])) },
      });
      default: return reply({ served: fileName });
    }
  });
  await new Promise((r) => ws.on('open', r));
  await waitUntil(() => bridge.snapshot().plugins.some((x) => x.fileKey === fileKey && x.hello));
  return p;
}

async function agent(bind = null) {
  const live = createSession(bridge);
  live.session.bind = bind;
  live.session.updateNoticeSent = true;
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await live.server.connect(st);
  const client = new Client({ name: 't', version: '0' }, { capabilities: {} });
  await client.connect(ct);
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? '';
    let json; try { json = JSON.parse(text); } catch { /* error text */ }
    return { isError: !!r.isError, text, json };
  };
  return { live, call };
}

const methods = (p) => p.got.map((m) => m.method);
const reset = (...ps) => { for (const p of ps) p.got.length = 0; };

const A = await plugin('kA', 'Source');
const B = await plugin('kB', 'Target');

// ---- 0. pure helpers
assert.strictEqual(nodeIdFromUrl('https://www.figma.com/design/kA/x?node-id=12-34'), '12:34');
assert.strictEqual(nodeIdFromUrl('https://www.figma.com/design/kA/x?node-id=12%3A34'), '12:34');
assert.strictEqual(nodeIdFromUrl('kA'), undefined);
{
  const roots = JSON.parse(JSON.stringify(TREE.roots));
  const r = rewriteImages(roots, { 'h-src': 'h-new' }, new Set(['h-bad']));
  assert.deepStrictEqual(roots[0].props.fills.map((f) => f.imageHash), ['h-new'], 'mapped hash rewritten, failed one and video dropped');
  assert.strictEqual(roots[0].children[0].text.segments[0].fills[0].imageHash, 'h-new', 'text segment fills rewritten too');
  assert.deepStrictEqual(r, { dropped: 1, videos: 1 });
}

// ---- 0b. planDefinitions (pure)
{
  const exp = {
    styles: {
      S1: { id: 'S1', key: 'k1', name: 'Brand/Blue', type: 'PAINT', remote: false, value: { paints: [] } },
      S2: { id: 'S2', key: 'lib-k', name: 'Lib/Red', type: 'PAINT', remote: true, value: { paints: [] } },
      S3: { id: 'S3', key: 'k3', name: 'Text/Body', type: 'TEXT', remote: false, value: {} },
      S4: { id: 'S4', key: 'k4', name: 'Other', type: 'EFFECT', remote: false, value: {} },
    },
    variables: {
      V1: { id: 'V1', key: 'a', name: 'color/primary', resolvedType: 'COLOR', collection: 'Tokens', modes: [{ mode: 'Light', value: { type: 'VARIABLE_ALIAS', id: 'V2' } }], direct: true },
      V2: { id: 'V2', key: 'b', name: 'blue/500', resolvedType: 'COLOR', collection: 'Primitives', modes: [{ mode: 'Light', value: { r: 0, g: 0, b: 1, a: 1 } }], direct: false },
      V3: { id: 'V3', key: 'vk3', name: 'lib/space', resolvedType: 'FLOAT', collection: 'Lib', remote: true, modes: [], direct: true },
      V4: { id: 'V4', key: 'd', name: 'radius/m', resolvedType: 'FLOAT', collection: 'Tokens', modes: [], direct: true },
      V5: { id: 'V5', key: 'e', name: 'unused', resolvedType: 'FLOAT', collection: 'Tokens', modes: [], direct: false },
    },
  };
  const inv = {
    styles: [{ id: 'T3', key: 'zz', name: 'Text/Body', type: 'TEXT' }, { id: 'T4', key: 'k4', name: 'Renamed', type: 'EFFECT' }, { id: 'T5', key: 'q', name: 'Brand/Blue', type: 'TEXT' }],
    variables: [{ id: 'TV4', key: 'zz', name: 'radius/m', resolvedType: 'FLOAT', collection: 'Other' }],
  };
  const p1 = planDefinitions(exp, inv, { styles: 'create', variables: 'create' });
  assert.deepStrictEqual(p1.how.styles, { S1: 'create', S3: 'name', S4: 'key' }, 'a name match needs the same type; library style waits for its import');
  assert.deepStrictEqual(p1.toImport.styles, [{ srcId: 'S2', key: 'lib-k' }]);
  assert.deepStrictEqual(p1.styleMap, { S3: 'T3', S4: 'T4' });
  assert.deepStrictEqual(p1.how.variables, { V1: 'create', V4: 'name', V2: 'create' }, 'alias target created with its user; unused closure ignored');
  assert.deepStrictEqual(p1.toImport.variables, [{ srcId: 'V3', key: 'vk3' }]);
  assert.deepStrictEqual(p1.create.variables.map((v) => v.srcId), ['V1', 'V2']);
  const p2 = planDefinitions(exp, inv, { styles: 'create', variables: 'create' }, { styles: { S2: 'TS2' }, variables: { V3: null } });
  assert.strictEqual(p2.how.styles.S2, 'import');
  assert.strictEqual(p2.styleMap.S2, 'TS2');
  assert.strictEqual(p2.how.variables.V3, 'create', 'library not available in the target: created instead');
  assert.deepStrictEqual(p2.toImport, { styles: [], variables: [] });
  const pm = planDefinitions(exp, inv, { styles: 'match', variables: 'match' }, { styles: { S2: null }, variables: { V3: null } });
  assert.deepStrictEqual(pm.how.styles, { S1: 'detach', S2: 'detach', S3: 'name', S4: 'key' });
  assert.deepStrictEqual(pm.how.variables, { V1: 'detach', V3: 'detach', V4: 'name' }, 'match mode never creates, so aliases are not followed');
  assert.deepStrictEqual(pm.create, { styles: [], variables: [] });
  const pd = planDefinitions(exp, inv, { styles: 'detach', variables: 'detach' });
  assert.ok(Object.values(pd.how.styles).every((h) => h === 'detach') && Object.values(pd.how.variables).every((h) => h === 'detach'));
  assert.deepStrictEqual(pd.toImport, { styles: [], variables: [] }, 'detach imports nothing');
}

// ---- 1. dryRun: both files resolved, fonts checked, nothing written.
{
  const a = await agent({ key: 'kA' });
  reset(A, B);
  const r = await a.call('copy_between_files', { from: 'kA', to: 'Target', options: { nodeIds: ['1:2'] }, dryRun: true });
  assert.ok(!r.isError, r.text);
  assert.strictEqual(r.json.dryRun, true);
  assert.deepStrictEqual(r.json.from, { fileName: 'Source', fileKey: 'kA', sessionId: r.json.from.sessionId });
  assert.strictEqual(r.json.to.fileKey, 'kB');
  assert.strictEqual(r.json.wouldCopy.layers, 2);
  assert.strictEqual(r.json.wouldCopy.images, 2);
  assert.deepStrictEqual(r.json.missingFonts, [{ family: 'Brand', style: 'Regular' }]);
  assert.strictEqual(r.json.styles.referenced, 2);
  assert.strictEqual(r.json.styles.create, 1);
  assert.strictEqual(r.json.styles.import, 1, 'dry run lists the library style as an import');
  assert.strictEqual(r.json.variables.name, 1, 'variable matched by name in the target');
  assert.deepStrictEqual(methods(A), ['export_tree'], 'dryRun reads the source once');
  assert.ok(B.got[0].params.inventory, 'the target inventory is asked for');
  assert.deepStrictEqual(methods(B), ['copy_check', 'copy_check'], 'dryRun only checks the target (editable, then fonts)');
  assert.deepStrictEqual(A.got[0].params.nodeIds, ['1:2']);
  assert.deepStrictEqual(a.live.session.bind, { key: 'kA' }, 'caller bind untouched');
}

// ---- 2. a real copy: images move, paints re-pointed, report returned.
{
  const a = await agent();
  reset(A, B);
  const r = await a.call('copy_between_files', { from: 'https://www.figma.com/design/kA/Source?node-id=1-2', to: 'kB', options: { x: 10, y: 20, select: true } });
  assert.ok(!r.isError, r.text);
  assert.strictEqual(r.json.copied, true);
  assert.deepStrictEqual(A.got[0].params.nodeIds, ['1:2'], 'the URL node-id names the source layer');
  assert.deepStrictEqual(methods(A), ['export_tree', 'get_image_by_hash', 'get_image_by_hash']);
  assert.deepStrictEqual(methods(B), ['copy_check', 'copy_check', 'import_style_by_key', 'upload_image', 'import_tree']);
  const imp = B.got.find((m) => m.method === 'import_tree').params;
  assert.deepStrictEqual(imp.styleMap, { 'S:2': 'ST:lib' }, 'library style imported by key');
  assert.deepStrictEqual(imp.variableMap, { 'V:1': 'VT:9' }, 'variable matched by name');
  assert.deepStrictEqual(imp.create.styles.map((x) => x.srcId), ['S:1'], 'local style created in the target');
  assert.strictEqual(r.json.styles.create, 1);
  assert.strictEqual(r.json.styles.import, 1);
  assert.strictEqual(r.json.variables.name, 1);
  assert.deepStrictEqual(imp.roots[0].props.fills.map((f) => f.imageHash), ['h-tgt'], 'image paint points at the target hash');
  assert.strictEqual(imp.x, 10); assert.strictEqual(imp.y, 20); assert.strictEqual(imp.select, true);
  assert.strictEqual(r.json.created.count, 2);
  assert.deepStrictEqual(r.json.images, { moved: 1, failed: 1 });
  assert.ok(r.json.skipped.some((s) => s.what === 'image'), 'failed image reported');
  assert.ok(r.json.skipped.some((s) => s.what === 'video'), 'video fill reported');
  assert.ok(r.json.skipped.some((s) => /STICKY/.test(s.reason)), 'unsupported layer reported');
  assert.strictEqual(a.live.session.bind, null, 'copy never binds the caller');
  assert.strictEqual(a.live.session.activeFileId, null);
}

// ---- 2b. styles/variables 'detach': no inventory, nothing imported or created.
{
  const a = await agent();
  reset(A, B);
  const r = await a.call('copy_between_files', { from: 'kA', to: 'kB', options: { nodeIds: ['1:2'], styles: 'detach', variables: 'detach' } });
  assert.ok(!r.isError, r.text);
  assert.ok(!B.got[0].params.inventory, 'no inventory needed');
  assert.ok(!methods(B).includes('import_style_by_key'));
  const imp = B.got.find((m) => m.method === 'import_tree').params;
  assert.deepStrictEqual([imp.styleMap, imp.variableMap, imp.create], [{}, {}, undefined]);
  assert.strictEqual(r.json.styles.detach, 2);
  const bad = await a.call('copy_between_files', { from: 'kA', to: 'kB', options: { styles: 'nope' } });
  assert.ok(bad.isError, 'unknown mode refused');
}

// ---- 3. no source layers named: the source selection is used.
{
  const a = await agent();
  reset(A, B);
  const r = await a.call('copy_between_files', { from: 'Source', to: 'Target', dryRun: true });
  assert.ok(!r.isError, r.text);
  assert.strictEqual(A.got[0].params.useSelection, true);
}

// ---- 4. guards
{
  const a = await agent();
  reset(A, B);
  const same = await a.call('copy_between_files', { from: 'kA', to: 'Source' });
  assert.ok(same.isError && /copy_same_file/.test(same.text), same.text);
  assert.strictEqual(A.got.length + B.got.length, 0, 'same file: nothing sent');

  const missing = await a.call('copy_between_files', { from: 'kA', to: 'kZ' });
  assert.ok(missing.isError && /bound_file_not_open|not open/.test(missing.text), missing.text);
  assert.strictEqual(A.got.length + B.got.length, 0, 'missing target: nothing sent');

  const ph = await a.call('copy_between_files', { from: '0:0', to: 'kB' });
  assert.ok(ph.isError && /not_a_file_key/.test(ph.text), ph.text);

  const empty = await a.call('copy_between_files', { from: ' ', to: 'kB' });
  assert.ok(empty.isError && /copy_missing_file/.test(empty.text), empty.text);

  const noArgs = await a.call('copy_between_files', { from: 'kA' });
  assert.ok(noArgs.isError, '`to` is required');
}

// ---- 5. read-only target: fails before the source is read.
{
  const R = await plugin('kR', 'ReadOnly', { editable: false });
  const a = await agent();
  reset(A, R);
  const r = await a.call('copy_between_files', { from: 'kA', to: 'kR' });
  assert.ok(r.isError && /copy_target_read_only/.test(r.text), r.text);
  assert.deepStrictEqual(methods(A), [], 'source never read');
  assert.deepStrictEqual(methods(R), ['copy_check']);
  R.ws.close();
}

// ---- 6. an old plugin on either side: clear update message, nothing sent.
{
  const O = await plugin('kO', 'Old', { caps: [] });
  const a = await agent();
  reset(A, O);
  const r1 = await a.call('copy_between_files', { from: 'kO', to: 'kA' });
  assert.ok(r1.isError && /plugin_too_old/.test(r1.text) && /source/.test(r1.text) && /Update the Grip plugin/.test(r1.text), r1.text);
  const r2 = await a.call('copy_between_files', { from: 'kA', to: 'kO' });
  assert.ok(r2.isError && /plugin_too_old/.test(r2.text) && /target/.test(r2.text), r2.text);
  assert.strictEqual(A.got.length + O.got.length, 0, 'old plugin: nothing sent');
  O.ws.close();
}

// ---- 7. two open files with the same name: ambiguous.
{
  const C = await plugin('kC', 'Target');
  const a = await agent();
  const r = await a.call('copy_between_files', { from: 'kA', to: 'Target', dryRun: true });
  assert.ok(r.isError && /ambiguous_file_name/.test(r.text), r.text);
  C.ws.close();
  await sleep(50);
}

// ---- 8. another agent bound to the target: warning, still copies.
{
  const other = await agent({ key: 'kB' });
  await other.call('get_node', { nodeId: '1:1' });
  const a = await agent();
  const r = await a.call('copy_between_files', { from: 'kA', to: 'kB', options: { nodeIds: ['1:2'] } });
  assert.ok(!r.isError, r.text);
  assert.strictEqual(r.json.copied, true);
  assert.ok(r.json.warnings?.some((w) => /bound to "Target"/.test(w)), JSON.stringify(r.json.warnings));
}

// ---- 9. surface
assert.ok(TOOLS.some((t) => t.name === 'copy_between_files'));
assert.ok(toolInScope('copy_between_files', resolveToolScope('core')), 'meta: always listed');
assert.strictEqual(toolMayChangeDocument('copy_between_files', { from: 'a', to: 'b' }), true, 'a lost copy is not blindly retried');
{
  const a = await agent();
  const r = await a.call('on_file', { file: 'kA', tool: 'copy_between_files', args: {} });
  assert.ok(r.isError && /bridge-side/.test(r.text), 'on_file refuses copy_between_files');
}

for (const p of [A, B]) p.ws.close();
await sleep(50);
console.log('copy-files.mjs OK');
process.exit(0);
