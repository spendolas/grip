// copy_between_files, plugin side: the grip:copy-tree block of figma-plugin/code.js
// (export_tree / import_tree / copy_check) runs in node:vm against two small fake
// `figma` files. A tree is exported from one, passed through JSON (as it is over
// the wire) and imported into the other.
// What this cannot show: real Figma geometry, real font loading, real image and
// vector handling, real undo. Those need the live spike (two files in Figma).
import assert from 'node:assert';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(HERE, '..', '..', '..', 'figma-plugin', 'code.js'), 'utf8');
const m = /\/\/ ---- grip:copy-tree begin[^\n]*\n([\s\S]*?)\/\/ ---- grip:copy-tree end ----/.exec(code);
assert.ok(m, 'code.js carries the grip:copy-tree block');
const BLOCK = m[1];

const COMMON = ['visible', 'locked', 'opacity', 'blendMode', 'isMask', 'effects', 'exportSettings', 'constraints'];
const GEO = ['fills', 'strokes', 'strokeWeight', 'strokeAlign', 'cornerRadius'];
const FRAME = ['clipsContent', 'layoutMode', 'paddingTop', 'paddingLeft', 'itemSpacing', 'primaryAxisSizingMode', 'counterAxisSizingMode', 'layoutGrids'];
const CHILD = ['layoutAlign', 'layoutGrow', 'layoutPositioning', 'layoutSizingHorizontal', 'layoutSizingVertical'];
const PROPS = {
  FRAME: [...COMMON, ...GEO, ...FRAME, ...CHILD], COMPONENT: [...COMMON, ...GEO, ...FRAME, ...CHILD, 'description'],
  COMPONENT_SET: [...COMMON, ...GEO, ...FRAME, 'description'], INSTANCE: [...COMMON, ...GEO, ...FRAME, ...CHILD],
  RECTANGLE: [...COMMON, ...GEO, ...CHILD], ELLIPSE: [...COMMON, ...GEO, ...CHILD, 'arcData'], VECTOR: [...COMMON, ...GEO, ...CHILD],
  TEXT: [...COMMON, ...GEO, ...CHILD, 'textAlignHorizontal', 'textAutoResize'], GROUP: [...COMMON, ...CHILD],
  BOOLEAN_OPERATION: [...COMMON, ...GEO, ...CHILD], STICKY: ['visible'], SECTION: ['visible', 'fills'], LINE: [...COMMON, ...GEO, ...CHILD], STAR: [...COMMON, ...GEO, ...CHILD, 'pointCount', 'innerRadius'], POLYGON: [...COMMON, ...GEO, ...CHILD, 'pointCount'], SLICE: ['visible'],
};
const DEFAULT = { visible: true, locked: false, opacity: 1, blendMode: 'NORMAL', isMask: false, effects: [], exportSettings: [], constraints: { horizontal: 'MIN', vertical: 'MIN' }, fills: [], strokes: [], strokeWeight: 1, strokeAlign: 'INSIDE', cornerRadius: 0, clipsContent: true, layoutMode: 'NONE', paddingTop: 0, paddingLeft: 0, itemSpacing: 0, primaryAxisSizingMode: 'AUTO', counterAxisSizingMode: 'FIXED', layoutGrids: [], layoutAlign: 'INHERIT', layoutGrow: 0, layoutPositioning: 'AUTO', layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'FIXED', description: '', textAlignHorizontal: 'LEFT', textAutoResize: 'NONE', arcData: { startingAngle: 0, endingAngle: 6.28, innerRadius: 0 }, pointCount: 5, innerRadius: 0.4 };
const CONTAINERS = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'GROUP', 'BOOLEAN_OPERATION', 'SECTION', 'PAGE']);

function fakeFile({ prefix, name, styles = {}, variables = {}, readOnly = false, fonts = [['Inter', 'Regular'], ['Inter', 'Bold']] }) {
  let seq = 1;
  const nodes = new Map();
  const mixed = Symbol('mixed');
  const loaded = new Set();
  const available = new Set(fonts.map(([f, s]) => `${f}|${s}`));
  const calls = { group: 0, combine: 0, setProperties: [], addProp: [] };

  class N {
    constructor(type) {
      this.id = `${prefix}:${seq++}`; this.type = type; this.name = type; this.parent = null; this._pd = {};
      for (const k of PROPS[type] ?? []) this[k] = JSON.parse(JSON.stringify(DEFAULT[k]));
      if (CONTAINERS.has(type)) this.children = [];
      if (type !== 'PAGE') { this.width = 100; this.height = 100; this.relativeTransform = [[1, 0, 0], [0, 1, 0]]; this.reactions = []; }
      nodes.set(this.id, this);
    }
    get absoluteTransform() {
      let x = 0, y = 0;
      for (let n = this; n && n.type !== 'PAGE'; n = n.parent) {
        // group children are positioned in their frame's space (groups add nothing)
        if (n === this || !['GROUP', 'BOOLEAN_OPERATION'].includes(n.type)) { x += n.relativeTransform[0][2]; y += n.relativeTransform[1][2]; }
      }
      return [[1, 0, x], [0, 1, y]];
    }
    resize(w, h) { this.width = w; this.height = h; }
    resizeWithoutConstraints(w, h) { this.width = w; this.height = h; }
    appendChild(c) { this.insertChild(this.children.length, c); }
    insertChild(i, c) { if (c.parent) c.parent.children.splice(c.parent.children.indexOf(c), 1); c.parent = this; this.children.splice(i, 0, c); }
    remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
    setPluginData(k, v) { this._pd[k] = v; }
    getPluginData(k) { return this._pd[k] ?? ''; }
    async setReactionsAsync(r) { this.reactions = JSON.parse(JSON.stringify(r)); }
    setBoundVariable(f, v) { this.boundVariables = { ...(this.boundVariables ?? {}), [f]: { type: 'VARIABLE_ALIAS', id: v.id } }; }
    async setFillStyleIdAsync(id) { this.fillStyleId = id; }
  }
  class T extends N {
    constructor() { super('TEXT'); this.fontName = { family: 'Inter', style: 'Regular' }; this._chars = []; this.fillStyleId = ''; this.textStyleId = ''; }
    get characters() { return this._chars.map((c) => c.ch).join(''); }
    set characters(s) {
      if (!loaded.has(`${this.fontName.family}|${this.fontName.style}`)) throw new Error('font not loaded');
      this._chars = [...s].map((ch) => ({ ch, st: { fontName: { ...this.fontName }, fontSize: 12, fills: [] } }));
    }
    getStyledTextSegments(fields) {
      const out = [];
      this._chars.forEach((c, i) => {
        const st = {}; for (const f of fields) if (f in c.st) st[f] = c.st[f];
        const last = out[out.length - 1];
        if (last && JSON.stringify(last._st) === JSON.stringify(st)) { last.end = i + 1; last.characters += c.ch; return; }
        out.push({ start: i, end: i + 1, characters: c.ch, _st: st, ...JSON.parse(JSON.stringify(st)) });
      });
      return out.map(({ _st, ...s }) => s);
    }
    _range(s, e, f, v) { for (let i = s; i < e; i++) this._chars[i].st = { ...this._chars[i].st, [f]: v }; }
    setRangeFontName(s, e, v) { if (!loaded.has(`${v.family}|${v.style}`)) throw new Error('font not loaded'); this._range(s, e, 'fontName', v); }
    setRangeFontSize(s, e, v) { this._range(s, e, 'fontSize', v); }
    setRangeFills(s, e, v) { this._range(s, e, 'fills', v); }
    async setRangeTextStyleIdAsync(s, e, v) { this._range(s, e, 'textStyleId', v); }
  }
  class C extends N {
    constructor(type = 'COMPONENT') { super(type); this.key = `key-${this.id}`; this.remote = false; this._defs = {}; }
    get componentPropertyDefinitions() { return this._defs; }
    addComponentProperty(n, type, def) { const k = `${n}#${prefix}${seq++}`; this._defs[k] = { type, defaultValue: def }; calls.addProp.push([n, type, def]); return k; }
    createInstance() {
      const inst = new N('INSTANCE');
      inst._main = this; inst.componentProperties = {};
      inst.getMainComponentAsync = async () => inst._main;
      inst.setProperties = (v) => { calls.setProperties.push(v); for (const [k, x] of Object.entries(v)) inst.componentProperties[k] = { type: 'TEXT', value: x }; };
      const clone = (src, parent) => {
        const n = src.type === 'TEXT' ? new T() : new N(src.type);
        n.name = src.name;
        if (src.type === 'TEXT') { loaded.add('Inter|Regular'); n.fontName = { family: 'Inter', style: 'Regular' }; n.characters = src.characters; }
        parent.appendChild(n);
        for (const c of src.children ?? []) clone(c, n);
      };
      for (const c of this.children) clone(c, inst);
      inst.width = this.width; inst.height = this.height;
      return inst;
    }
  }

  const page = new N('PAGE'); page.name = 'Page 1'; page.selection = [];
  const root = { name, getPluginData: () => '', setPluginData: () => { if (readOnly) throw new Error('Cannot write to a read-only document'); } };
  const vars = new Map(Object.entries(variables));
  const cols = [];
  const localStyles = [];
  const makeStyle = (type) => () => { const st = { id: `${prefix}S:${seq++}`, key: `sk-${seq}`, type, name: '', description: '' }; if (type === 'TEXT') st.setBoundVariable = (f, v) => { st.boundVariables = { ...(st.boundVariables ?? {}), [f]: { type: 'VARIABLE_ALIAS', id: v.id } }; }; localStyles.push(st); return st; };
  const figma = {
    mixed, editorType: 'figma', root, currentPage: page, viewport: { scrollAndZoomIntoView() {} },
    createFrame: () => new N('FRAME'), createRectangle: () => new N('RECTANGLE'), createEllipse: () => new N('ELLIPSE'),
    createPolygon: () => new N('POLYGON'), createStar: () => new N('STAR'), createLine: () => new N('LINE'),
    createVector: () => { const v = new N('VECTOR'); v.vectorNetwork = { vertices: [], segments: [], regions: [] }; v.vectorPaths = []; v.setVectorNetworkAsync = async (x) => { v.vectorNetwork = x; }; return v; },
    createText: () => new T(), createComponent: () => new C(), createSection: () => new N('SECTION'), createSlice: () => new N('SLICE'),
    group(kids, parent) {
      calls.group++;
      const g = new N('GROUP');
      parent.insertChild(parent.children.indexOf(kids[0]), g);
      for (const k of kids) g.appendChild(k);
      return g;
    },
    union(kids, parent) { const b = figma.group(kids, parent); b.type = 'BOOLEAN_OPERATION'; b.booleanOperation = 'UNION'; return b; },
    subtract(kids, parent) { const b = figma.union(kids, parent); b.booleanOperation = 'SUBTRACT'; return b; },
    combineAsVariants(kids, parent) {
      calls.combine++;
      const s = new C('COMPONENT_SET');
      parent.insertChild(parent.children.indexOf(kids[0]), s);
      for (const k of kids) s.appendChild(k);
      return s;
    },
    async loadFontAsync(f) { if (!available.has(`${f.family}|${f.style}`)) throw new Error(`font ${f.family} ${f.style} not available`); loaded.add(`${f.family}|${f.style}`); },
    async listAvailableFontsAsync() { return [...available].map((k) => { const [family, style] = k.split('|'); return { fontName: { family, style } }; }); },
    async getNodeByIdAsync(id) { return nodes.get(id) ?? null; },
    async getStyleByIdAsync(id) { return styles[id] ?? null; },
    createPaintStyle: makeStyle('PAINT'), createTextStyle: makeStyle('TEXT'), createEffectStyle: makeStyle('EFFECT'), createGridStyle: makeStyle('GRID'),
    async getLocalPaintStylesAsync() { return localStyles.filter((x) => x.type === 'PAINT'); },
    async getLocalTextStylesAsync() { return localStyles.filter((x) => x.type === 'TEXT'); },
    async getLocalEffectStylesAsync() { return []; },
    async getLocalGridStylesAsync() { return []; },
    variables: {
      async getLocalVariableCollectionsAsync() { return cols; },
      async getLocalVariablesAsync() { return [...vars.values()].filter((v) => v.local); },
      createVariableCollection(n) {
        const c = { id: `${prefix}C:${seq++}`, name: n, modes: [{ modeId: `${prefix}M:${seq++}`, name: 'Mode 1' }] };
        c.renameMode = (id, nm) => { c.modes.find((m) => m.modeId === id).name = nm; };
        c.addMode = (nm) => { const id = `${prefix}M:${seq++}`; c.modes.push({ modeId: id, name: nm }); return id; };
        cols.push(c); return c;
      },
      createVariable(n, col, type) {
        const v = { id: `${prefix}V:${seq++}`, key: `vk-${seq}`, name: n, resolvedType: type, variableCollectionId: col.id, valuesByMode: {}, local: true, description: '' };
        v.setValueForMode = (m, x) => { v.valuesByMode[m] = x; };
        vars.set(v.id, v); return v;
      },
      async getVariableByIdAsync(id) { return vars.get(id) ?? null; },
      async getVariableCollectionByIdAsync() { return { name: 'Tokens', modes: [{ modeId: 'M:1', name: 'Light' }] }; },
      setBoundVariableForPaint(p, f, v) { return { ...p, boundVariables: { [f]: { type: 'VARIABLE_ALIAS', id: v.id } } }; },
      setBoundVariableForEffect(e, f, v) { return { ...e, boundVariables: { [f]: { type: 'VARIABLE_ALIAS', id: v.id } } }; },
    },
  };
  const ctx = vm.createContext({
    figma, JSON, Object, Array, Map, Set, Math, String, Number, Error, Promise, Symbol,
    asIds: (v) => (Array.isArray(v) ? v : []),
    hasChildren: (n) => 'children' in n,
    pageOf: () => page,
    async getNode(id) { const n = nodes.get(id); if (!n) throw new Error(`Node not found: ${id}`); return n; },
    async loadedPage(id) { const n = nodes.get(id); if (!n || n.type !== 'PAGE') throw new Error(`Not a page: ${id}`); return n; },
  });
  vm.runInContext(BLOCK, ctx);
  const add = (n, parent = page, props = {}) => { Object.assign(n, props); parent.appendChild(n); return n; };
  return { figma, page, nodes, calls, ctx, N, T, C, add, loaded, cols, vars, localStyles, run: (fn, params) => ctx[fn](params) };
}

const wire = (x) => JSON.parse(JSON.stringify(x));
// Values made inside the vm have its own Array/Object prototypes: compare as JSON.
const eq = (a, b, msg) => assert.deepStrictEqual(a === undefined ? a : wire(a), b === undefined ? b : wire(b), msg);
const at = (x, y) => [[1, 0, x], [0, 1, y]];

// ---------------------------------------------------------------- source file
const A = fakeFile({
  prefix: 'A', name: 'Source', fonts: [['Inter', 'Regular'], ['Inter', 'Bold'], ['Brand', 'Regular']],
  styles: { 'S:1': { key: 'sk1', name: 'Brand/Blue', type: 'PAINT', remote: false, description: 'Primary', paints: [{ type: 'SOLID', color: { r: 0, g: 0, b: 1 } }] } },
  variables: { 'V:1': { id: 'V:1', key: 'vk1', name: 'color/primary', resolvedType: 'COLOR', remote: false, variableCollectionId: 'C:1', valuesByMode: { 'M:1': { r: 0, g: 0, b: 1, a: 1 } } } },
});
// A local component used by an instance in the copied tree, with a TEXT property.
const btn = A.add(new A.C(), A.page, { name: 'Btn', relativeTransform: at(900, 0) });
const btnLabel = A.add(new A.T(), btn, { name: 'Label' });
A.loaded.add('Inter|Regular'); btnLabel.characters = 'Button';
btn._defs = { 'Text#1:0': { type: 'TEXT', defaultValue: 'Button' } };
btnLabel.componentPropertyReferences = { characters: 'Text#1:0' };

const card = A.add(new A.N('FRAME'), A.page, {
  name: 'Card', relativeTransform: at(40, 60), width: 320, height: 200, layoutMode: 'VERTICAL', itemSpacing: 8, paddingTop: 16,
  fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 1 }, opacity: 1, boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'V:1' } } }],
  fillStyleId: 'S:1', boundVariables: { itemSpacing: { type: 'VARIABLE_ALIAS', id: 'V:1' } },
  effects: [{ type: 'DROP_SHADOW', radius: 4, visible: true }],
});
const title = A.add(new A.T(), card, { name: 'Title', textAutoResize: 'WIDTH_AND_HEIGHT', layoutSizingHorizontal: 'FILL' });
A.loaded.add('Inter|Bold'); A.loaded.add('Brand|Regular');
title.characters = 'HelloWorld';
title.setRangeFontName(0, 5, { family: 'Inter', style: 'Bold' });
title.setRangeFontName(5, 10, { family: 'Brand', style: 'Regular' });
title.setRangeFontSize(0, 5, 24);
const photo = A.add(new A.N('RECTANGLE'), card, { name: 'Photo', fills: [{ type: 'IMAGE', imageHash: 'img1', scaleMode: 'FILL' }], cornerRadius: 8 });
const e1 = A.add(new A.N('ELLIPSE'), card, { name: 'Dot1', relativeTransform: at(10, 150) });
const e2 = A.add(new A.N('ELLIPSE'), card, { name: 'Dot2', relativeTransform: at(30, 150) });
A.figma.group([e1, e2], card).name = 'Dots';
const vec = A.add(new A.N('VECTOR'), card, { name: 'Icon', vectorNetwork: { vertices: [{ x: 0, y: 0 }, { x: 10, y: 10 }], segments: [{ start: 0, end: 1 }], regions: [] }, vectorPaths: [] });
const inst = btn.createInstance(); inst.name = 'Btn'; card.appendChild(inst);
inst.children[0].characters = 'Buy now';
inst.componentProperties = { 'Text#1:0': { type: 'TEXT', value: 'Buy now' } };
const sticky = A.add(new A.N('STICKY'), card, { name: 'Note' });
const outside = A.add(new A.N('FRAME'), A.page, { name: 'Elsewhere' });
photo.reactions = [
  { trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE', destinationId: e1.id, navigation: 'NAVIGATE' }] },
  { trigger: { type: 'ON_HOVER' }, actions: [{ type: 'NODE', destinationId: outside.id, navigation: 'NAVIGATE' }] },
];

// ---- export
const exp = wire(await A.run('exportTree', { nodeIds: [card.id], includeComponents: true }));
assert.strictEqual(exp.roots.length, 1);
const r0 = exp.roots[0];
assert.strictEqual(r0.type, 'FRAME');
eq(r0.absoluteTransform, at(40, 60), 'root carries its page position');
eq(r0.children.map((c) => c.type), ['TEXT', 'RECTANGLE', 'GROUP', 'VECTOR', 'INSTANCE', 'STICKY']);
eq(exp.images, ['img1']);
eq(exp.fonts.map((f) => `${f.family}|${f.style}`).sort(), ['Brand|Regular', 'Inter|Bold', 'Inter|Regular'], 'fonts of every text layer, incl. instances and components');
eq(Object.keys(exp.styles), ['S:1']);
assert.strictEqual(exp.styles['S:1'].name, 'Brand/Blue');
eq(Object.keys(exp.variables), ['V:1'], 'variables found in node and paint bindings');
assert.strictEqual(exp.variables['V:1'].collection, 'Tokens');
eq(exp.unsupported.map((u) => u.type), ['STICKY']);
assert.strictEqual(r0.children[0].text.segments.length, 2, 'two text runs');
assert.strictEqual(r0.children[4].instance.componentId, btn.id);
eq(exp.localComponents, [btn.id]);
assert.strictEqual(exp.components.length, 1, 'includeComponents brings the local main component');
assert.strictEqual(exp.components[0].name, 'Btn');
eq(exp.components[0].children[0].propertyReferences, { characters: 'Text#1:0' });
assert.ok(r0.children[1].reactions.length === 2);

// ---- props that do not apply are not exported (Figma refuses them on import)
{
  const plain = wire(await A.run('exportTree', { nodeIds: [outside.id] })).roots[0];
  for (const k of ['paddingTop', 'itemSpacing', 'primaryAxisSizingMode']) assert.ok(!(k in plain.props), `${k} not exported without auto-layout`);
  assert.ok('layoutMode' in plain.props && 'clipsContent' in plain.props);
  assert.ok('itemSpacing' in r0.props && 'paddingTop' in r0.props, 'auto-layout frame keeps them');
}

// ---- export guards
await assert.rejects(A.run('exportTree', {}), /copy_no_source/);
await assert.rejects(A.run('exportTree', { nodeIds: [card.id], maxNodes: 3 }), /copy_too_large/);
await assert.rejects(A.run('exportTree', { nodeIds: [A.page.id] }), /copy_bad_source/);
A.page.selection = [photo];
assert.strictEqual(wire(await A.run('exportTree', { useSelection: true })).roots[0].name, 'Photo', 'selection is the default source');

// ---------------------------------------------------------------- 1. detach everything (empty maps)
{
  const B = fakeFile({ prefix: 'B', name: 'Target' });
  const res = wire(await B.run('importTree', { roots: exp.roots, reactions: true }));
  const copy = B.page.children[0];
  assert.strictEqual(copy.name, 'Card');
  eq(copy.relativeTransform, at(40, 60), 'placed at the source page position');
  assert.strictEqual(copy.layoutMode, 'VERTICAL');
  assert.strictEqual(copy.itemSpacing, 8);
  assert.strictEqual(copy.width, 320);
  assert.ok(!copy.fills[0].boundVariables, 'unmapped variable binding dropped, value kept');
  eq(copy.fills[0].color, { r: 0, g: 0, b: 1 });
  assert.ok(!copy.fillStyleId, 'unmapped style not applied');
  assert.ok(!copy.boundVariables, 'unmapped node binding dropped');
  eq(copy.children.map((c) => c.type), ['TEXT', 'RECTANGLE', 'GROUP', 'VECTOR', 'FRAME'], 'instance became a frame, sticky skipped');
  const t = copy.children[0];
  assert.strictEqual(t.characters, 'HelloWorld');
  const segs = t.getStyledTextSegments(['fontName', 'fontSize']);
  eq(segs.map((s) => [s.characters, s.fontName.family, s.fontName.style]), [['Hello', 'Inter', 'Bold'], ['World', 'Inter', 'Regular']]);
  assert.strictEqual(segs[0].fontSize, 24);
  eq(res.missingFonts, [{ family: 'Brand', style: 'Regular', substitute: { family: 'Inter', style: 'Regular' } }]);
  assert.strictEqual(t.layoutSizingHorizontal, 'FILL', 'auto-layout child props applied');
  assert.strictEqual(t.textAutoResize, 'WIDTH_AND_HEIGHT');
  const g = copy.children[2];
  eq(g.children.map((c) => c.relativeTransform[0][2]), [10, 30], 'group children keep their positions');
  eq(copy.children[3].vectorNetwork.segments, [{ start: 0, end: 1 }], 'vector network copied');
  assert.strictEqual(res.detachedInstances, 1);
  assert.ok(copy.children[4].getPluginData('grip.copiedFrom').includes('Btn'), 'detached frame remembers its component');
  assert.strictEqual(copy.children[4].children[0].characters, 'Buy now', 'detached instance keeps its text');
  const rx = copy.children[1].reactions;
  assert.strictEqual(rx.length, 1, 'link to a layer outside the copy dropped');
  assert.strictEqual(rx[0].actions[0].destinationId, g.children[0].id, 'link re-aimed at the copied layer');
  assert.ok(res.skipped.some((s) => s.what === 'prototype links'));
  assert.ok(res.skipped.some((s) => /STICKY/.test(s.reason)));
  assert.strictEqual(res.roots[0].id, copy.id);
}

// ---------------------------------------------------------------- 2. placement options
{
  const B = fakeFile({ prefix: 'B', name: 'Target' });
  const parent = B.add(new B.N('FRAME'), B.page, { relativeTransform: at(500, 500) });
  await B.run('importTree', { roots: exp.roots, parentId: parent.id });
  eq(parent.children[0].relativeTransform, at(40, 60), 'in a parent: relative position kept');
  const B2 = fakeFile({ prefix: 'C', name: 'Target2' });
  await B2.run('importTree', { roots: exp.roots, x: 0, y: 5 });
  eq(B2.page.children[0].relativeTransform, at(0, 5), 'x/y moves the first root there');
  await assert.rejects(B2.run('importTree', { roots: [] }), /nothing to import/);
}

// ---------------------------------------------------------------- 3. mapped styles, variables and components
{
  const B = fakeFile({ prefix: 'B', name: 'Target', variables: { 'VB:1': { id: 'VB:1' } } });
  // The bridge first copies the local main component (exp.components) ...
  const pre = wire(await B.run('importTree', { roots: exp.components, returnIdMap: true }));
  const newBtn = B.nodes.get(pre.idMap[btn.id]);
  assert.strictEqual(newBtn.type, 'COMPONENT');
  eq(B.calls.addProp, [['Text', 'TEXT', 'Button']], 'TEXT property recreated');
  const newKey = pre.propKeyMap['Text#1:0'];
  assert.ok(newKey && newKey !== 'Text#1:0');
  eq(newBtn.children[0].componentPropertyReferences, { characters: newKey }, 'label wired to the new property');
  // ... then the tree, with every map filled.
  const res = wire(await B.run('importTree', {
    roots: exp.roots, styleMap: { 'S:1': 'SB:1' }, variableMap: { 'V:1': 'VB:1' },
    componentMap: { [btn.id]: newBtn.id }, propKeyMap: pre.propKeyMap,
  }));
  const copy = B.page.children[1];
  eq(copy.fills[0].boundVariables, { color: { type: 'VARIABLE_ALIAS', id: 'VB:1' } }, 'paint re-bound to the target variable');
  assert.strictEqual(copy.fillStyleId, 'SB:1', 'style mapped');
  eq(copy.boundVariables, { itemSpacing: { type: 'VARIABLE_ALIAS', id: 'VB:1' } }, 'node field re-bound');
  const i = copy.children[4];
  assert.strictEqual(i.type, 'INSTANCE', 'mapped component: a real instance');
  assert.strictEqual(i._main, newBtn);
  eq(B.calls.setProperties.at(-1), { [newKey]: 'Buy now' }, 'property value set under the new key');
  assert.strictEqual(i.children[0].characters, 'Buy now', 'text override applied');
  assert.strictEqual(res.detachedInstances, 0);
}

// ---------------------------------------------------------------- 4. component sets
{
  const S = fakeFile({ prefix: 'S', name: 'Lib' });
  const v1 = S.add(new S.C(), S.page, { name: 'Size=S', relativeTransform: at(20, 20) });
  const v2 = S.add(new S.C(), S.page, { name: 'Size=L', relativeTransform: at(20, 140) });
  const set = S.figma.combineAsVariants([v1, v2], S.page);
  set.name = 'Chip'; set.relativeTransform = at(100, 100); set.width = 200; set.height = 260;
  set._defs = { 'Size': { type: 'VARIANT', defaultValue: 'S' }, 'Icon#3:1': { type: 'BOOLEAN', defaultValue: true } };
  const e = wire(await S.run('exportTree', { nodeIds: [set.id] }));
  const B = fakeFile({ prefix: 'B', name: 'Target' });
  await B.run('importTree', { roots: e.roots });
  const copy = B.page.children[0];
  assert.strictEqual(copy.type, 'COMPONENT_SET');
  assert.strictEqual(B.calls.combine, 1);
  eq(copy.children.map((c) => [c.name, c.relativeTransform[1][2]]), [['Size=S', 20], ['Size=L', 140]], 'variants keep their place in the set');
  eq(B.calls.addProp, [['Icon', 'BOOLEAN', true]], 'non-variant properties recreated, variant ones come from names');
  eq(copy.relativeTransform, at(100, 100));
}

// ---------------------------------------------------------------- 5. copy_check
{
  const ro = fakeFile({ prefix: 'R', name: 'RO', readOnly: true });
  const c1 = await ro.run('copyCheck', {});
  assert.strictEqual(c1.editable, false);
  assert.match(c1.reason, /read-only/);
  const ok = fakeFile({ prefix: 'O', name: 'OK' });
  const c2 = wire(await ok.run('copyCheck', { fonts: [{ family: 'Inter', style: 'Bold' }, { family: 'Brand', style: 'Regular' }] }));
  assert.strictEqual(c2.editable, true);
  eq(c2.missingFonts, [{ family: 'Brand', style: 'Regular' }]);
  ok.figma.editorType = 'dev';
  assert.strictEqual((await ok.run('copyCheck', {})).editable, false, 'Dev Mode is read-only');
}

// ---------------------------------------------------------------- 6. create styles and variables (create mode)
{
  const B = fakeFile({ prefix: 'B', name: 'Target' });
  const existing = B.figma.variables.createVariableCollection('Primitives');
  existing.renameMode(existing.modes[0].modeId, 'Light');
  const res = wire(await B.run('importTree', {
    roots: exp.roots,
    create: {
      variables: [
        { srcId: 'V:1', name: 'color/primary', resolvedType: 'COLOR', collection: 'Tokens', collectionModes: ['Light', 'Dark'], modes: [{ mode: 'Light', value: { type: 'VARIABLE_ALIAS', id: 'V:2' } }, { mode: 'Dark', value: { r: 1, g: 1, b: 1, a: 1 } }] },
        { srcId: 'V:2', name: 'blue/500', resolvedType: 'COLOR', collection: 'Primitives', collectionModes: ['Light'], modes: [{ mode: 'Light', value: { r: 0, g: 0, b: 1, a: 1 } }] },
        { srcId: 'V:3', name: 'broken', resolvedType: 'COLOR', collection: 'Tokens', modes: [{ mode: 'Light', value: { type: 'VARIABLE_ALIAS', id: 'V:404' } }] },
      ],
      styles: [
        { srcId: 'S:1', type: 'PAINT', name: 'Brand/Blue', value: { paints: [{ type: 'SOLID', color: { r: 0, g: 0, b: 1 }, boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'V:1' } } }] } },
        { srcId: 'S:2', type: 'TEXT', name: 'Text/Title', value: { fontName: { family: 'Inter', style: 'Bold' }, fontSize: 24 } },
      ],
    },
  }));
  assert.strictEqual(res.createdVariables, 3);
  assert.strictEqual(res.createdStyles, 2);
  eq(B.cols.map((c) => [c.name, c.modes.map((m) => m.name)]), [['Primitives', ['Light']], ['Tokens', ['Light', 'Dark']]], 'existing collection reused, new one takes the source modes');
  const v1 = B.vars.get(res.variableMap['V:1']), v2 = B.vars.get(res.variableMap['V:2']);
  const tokens = B.cols[1];
  eq(v1.valuesByMode[tokens.modes[0].modeId], { type: 'VARIABLE_ALIAS', id: v2.id }, 'alias re-aimed at the created variable');
  eq(v1.valuesByMode[tokens.modes[1].modeId], { r: 1, g: 1, b: 1, a: 1 });
  assert.ok(res.skipped.some((x) => x.name === 'broken' && /not copied/.test(x.reason)), 'alias to an unknown variable reported');
  const paint = B.localStyles.find((x) => x.name === 'Brand/Blue');
  eq(paint.paints[0].boundVariables, { color: { type: 'VARIABLE_ALIAS', id: v1.id } }, 'style paint bound to the created variable');
  const text = B.localStyles.find((x) => x.name === 'Text/Title');
  eq([text.fontName, text.fontSize], [{ family: 'Inter', style: 'Bold' }, 24]);
  const copy = B.page.children[0];
  assert.strictEqual(copy.fillStyleId, paint.id, 'layers use the created style');
  eq(copy.fills[0].boundVariables, { color: { type: 'VARIABLE_ALIAS', id: v1.id } }, 'layers use the created variable');
  // inventory: what the bridge matches against next time
  const inv = wire(await B.run('copyCheck', { inventory: true })).inventory;
  eq(inv.styles.map((x) => [x.name, x.type]), [['Brand/Blue', 'PAINT'], ['Text/Title', 'TEXT']]);
  eq(inv.collections.map((c) => c.name), ['Primitives', 'Tokens']);
  eq(inv.variables.map((v) => [v.name, v.collection]), [['color/primary', 'Tokens'], ['blue/500', 'Primitives'], ['broken', 'Tokens']]);
}

// ---------------------------------------------------------------- 6b. nested local components copied along
{
  const S = fakeFile({ prefix: 'S', name: 'Src' });
  const icon = S.add(new S.C(), S.page, { name: 'Icon', relativeTransform: at(0, 300) });
  const chip = S.add(new S.C(), S.page, { name: 'Chip', relativeTransform: at(0, 400) });
  const inner = icon.createInstance(); inner.name = 'Icon'; chip.appendChild(inner);
  const frame = S.add(new S.N('FRAME'), S.page, { name: 'Screen' });
  const use = chip.createInstance(); use.name = 'Chip'; frame.appendChild(use);
  const e = wire(await S.run('exportTree', { nodeIds: [frame.id], includeComponents: true }));
  eq(e.components.map((c) => c.name), ['Chip', 'Icon'], 'a component is exported before the ones it uses');
  const B = fakeFile({ prefix: 'B', name: 'Target' });
  // The bridge imports them reversed (dependencies first) ...
  const pre = wire(await B.run('importTree', { roots: [...e.components].reverse(), returnIdMap: true }));
  const newChip = B.nodes.get(pre.idMap[chip.id]);
  assert.strictEqual(newChip.children[0].type, 'INSTANCE', 'the copied Chip uses the copied Icon');
  assert.strictEqual(newChip.children[0]._main, B.nodes.get(pre.idMap[icon.id]));
  // ... then the layers, with componentMap from that.
  await B.run('importTree', { roots: e.roots, componentMap: { [chip.id]: newChip.id } });
  const screen = B.page.children.find((n) => n.name === 'Screen');
  assert.strictEqual(screen.children[0]._main, newChip, 'the copied layers use the copied component');
}

// ---------------------------------------------------------------- 7. export describes styles and variables fully
{
  eq(exp.styles['S:1'].value, { paints: [{ type: 'SOLID', color: { r: 0, g: 0, b: 1 } }] }, 'a style carries its value, so the target can recreate it');
  assert.strictEqual(exp.styles['S:1'].description, 'Primary');
  eq(exp.variables['V:1'].modes, [{ mode: 'Light', value: { r: 0, g: 0, b: 1, a: 1 } }], 'values by mode NAME');
  eq(exp.variables['V:1'].direct, true);
}

console.log('copy-tree.mjs OK');
