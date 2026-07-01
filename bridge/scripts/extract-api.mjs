// Crawl Figma Plugin API docs, extract every method/property surface,
// and diff against Grip's exposed tool list.
//
// Usage:
//   node bridge/scripts/extract-api.mjs              # writes report to stdout
//   node bridge/scripts/extract-api.mjs --json       # JSON dump
//
// Output sections:
//   - "documented" (everything we found in the docs)
//   - "covered"    (documented entries that map to a Grip tool)
//   - "uncovered"  (documented entries with no obvious Grip tool)
//
// The mapping is heuristic (substring match on tool name), so verify by
// hand for ambiguous matches. The point is to surface gaps quickly.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = 'https://developers.figma.com';
const INDEX = `${ROOT}/docs/plugins/api/api-reference/`;
const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS_TS = join(HERE, '..', 'src', 'tools.ts');

const ARG_JSON = process.argv.includes('--json');

// Pages we know about a priori. The index page links to the rest, but
// being explicit covers Slides/Dev/FigJam corners that the index drops.
const SEED = [
  '/docs/plugins/api/api-reference/',
  '/docs/plugins/api/figma/',
  '/docs/plugins/api/properties/',
  '/docs/plugins/api/global-objects/',
  '/docs/plugins/api/figma-viewport/',
  '/docs/plugins/api/figma-clientStorage/',
  '/docs/plugins/api/figma-variables/',
  '/docs/plugins/api/figma-teamLibrary/',
  '/docs/plugins/api/figma-payments/',
  '/docs/plugins/api/figma-codegen/',
  '/docs/plugins/api/figma-annotations/',
  '/docs/plugins/api/figma-timer/',
  '/docs/plugins/api/figma-ui/',
  '/docs/plugins/api/figma-textreview/',
  '/docs/plugins/api/figma-parameters/',
  '/docs/plugins/api/figma-vscode/',
  '/docs/plugins/api/figma-buzz/',
  // Node types — most informative for method discovery.
  '/docs/plugins/api/DocumentNode/',
  '/docs/plugins/api/PageNode/',
  '/docs/plugins/api/FrameNode/',
  '/docs/plugins/api/GroupNode/',
  '/docs/plugins/api/SectionNode/',
  '/docs/plugins/api/SliceNode/',
  '/docs/plugins/api/RectangleNode/',
  '/docs/plugins/api/EllipseNode/',
  '/docs/plugins/api/PolygonNode/',
  '/docs/plugins/api/StarNode/',
  '/docs/plugins/api/LineNode/',
  '/docs/plugins/api/VectorNode/',
  '/docs/plugins/api/BooleanOperationNode/',
  '/docs/plugins/api/TextNode/',
  '/docs/plugins/api/TextPathNode/',
  '/docs/plugins/api/ComponentNode/',
  '/docs/plugins/api/ComponentSetNode/',
  '/docs/plugins/api/InstanceNode/',
  '/docs/plugins/api/StickyNode/',
  '/docs/plugins/api/ConnectorNode/',
  '/docs/plugins/api/ShapeWithTextNode/',
  '/docs/plugins/api/CodeBlockNode/',
  '/docs/plugins/api/TableNode/',
  '/docs/plugins/api/TableCellNode/',
  '/docs/plugins/api/MediaNode/',
  '/docs/plugins/api/EmbedNode/',
  '/docs/plugins/api/LinkUnfurlNode/',
  '/docs/plugins/api/StampNode/',
  '/docs/plugins/api/HighlightNode/',
  '/docs/plugins/api/WashiTapeNode/',
  '/docs/plugins/api/SlideNode/',
  '/docs/plugins/api/SlideRowNode/',
  '/docs/plugins/api/SlideGridNode/',
  '/docs/plugins/api/WidgetNode/',
  // Mixins
  '/docs/plugins/api/properties/nodes-shared/',
  '/docs/plugins/api/properties/nodes-blendmixin/',
  '/docs/plugins/api/properties/nodes-childrenmixin/',
  '/docs/plugins/api/properties/nodes-componentpropertiesmixin/',
  '/docs/plugins/api/properties/nodes-constraintmixin/',
  '/docs/plugins/api/properties/nodes-cornermixin/',
  '/docs/plugins/api/properties/nodes-defaultframemixin/',
  '/docs/plugins/api/properties/nodes-defaultshapemixin/',
  '/docs/plugins/api/properties/nodes-effectmixin/',
  '/docs/plugins/api/properties/nodes-exportmixin/',
  '/docs/plugins/api/properties/nodes-fillmixin/',
  '/docs/plugins/api/properties/nodes-framemixin/',
  '/docs/plugins/api/properties/nodes-geometrymixin/',
  '/docs/plugins/api/properties/nodes-individualstrokesmixin/',
  '/docs/plugins/api/properties/nodes-layoutmixin/',
  '/docs/plugins/api/properties/nodes-opacitymixin/',
  '/docs/plugins/api/properties/nodes-publishablemixin/',
  '/docs/plugins/api/properties/nodes-reactionmixin/',
  '/docs/plugins/api/properties/nodes-sceneNodeMixin/',
  '/docs/plugins/api/properties/nodes-strokesmixin/',
  '/docs/plugins/api/properties/nodes-vectorlikemixin/',
];

// Strip HTML to plain text; not robust but good enough for headings.
function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ');
}

// Extract probable Plugin API identifiers: anything that looks like
// `figma.foo()`, `node.bar()`, or a heading like `## name()` or
// `### addComponentProperty()`. Keep just the identifier.
function extractIdents(text) {
  const ids = new Set();
  const patterns = [
    /\bfigma\.([A-Za-z][A-Za-z0-9_]*)/g,
    /\bfigma\.([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z][A-Za-z0-9_]*)/g,
    // Node-method headings: likely "methodName()" or "methodNameAsync()".
    /(?<![A-Za-z0-9_.])([a-z][A-Za-z0-9_]{2,})\(/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const ident = (m[2] ? `${m[1]}.${m[2]}` : m[1]).trim();
      if (ident && /^[A-Za-z][A-Za-z0-9_.]*$/.test(ident)) ids.add(ident);
    }
  }
  // Filter junk language keywords / common non-API matches.
  const junk = new Set([
    'function', 'return', 'typeof', 'string', 'boolean', 'number', 'await',
    'async', 'const', 'let', 'var', 'true', 'false', 'null', 'undefined',
    'console', 'window', 'document', 'parent', 'this', 'new', 'instanceof',
    'forEach', 'map', 'filter', 'find', 'some', 'every', 'reduce', 'slice',
    'push', 'pop', 'shift', 'unshift', 'splice', 'concat', 'includes',
    'indexOf', 'join', 'split', 'toString', 'valueOf', 'hasOwnProperty',
    'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Promise',
    'try', 'catch', 'throw', 'finally', 'switch', 'case', 'break',
    'continue', 'while', 'for', 'if', 'else', 'do', 'class', 'extends',
    'import', 'export', 'from', 'default', 'in', 'of', 'as',
    // generic verbs we don't want
    'yes', 'no', 'see', 'note', 'get', 'set', 'add', 'remove',
  ]);
  return [...ids].filter((i) => !junk.has(i));
}

async function fetchPage(path) {
  const url = path.startsWith('http') ? path : `${ROOT}${path}`;
  try {
    const r = await fetch(url, { redirect: 'follow' });
    if (!r.ok) return { url, ok: false, status: r.status, idents: [] };
    const html = await r.text();
    const text = stripHtml(html);
    return { url, ok: true, idents: extractIdents(text) };
  } catch (err) {
    return { url, ok: false, error: String(err), idents: [] };
  }
}

async function loadGripTools() {
  const src = await readFile(TOOLS_TS, 'utf8');
  const re = /name:\s*'([a-z_][a-z0-9_]*)'/g;
  const tools = new Set();
  let m;
  while ((m = re.exec(src)) !== null) tools.add(m[1]);
  return tools;
}

// Try to map a documented identifier to a Grip tool. The match is loose:
// snake-case the camelCase ident and check if any Grip tool name contains
// that token, OR the ident itself is a substring of any tool name.
function snake(s) {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}
function isCovered(ident, tools) {
  const snk = snake(ident);
  // strip async suffix
  const base = snk.replace(/_async$/, '');
  for (const t of tools) {
    if (t === base || t.includes(base) || base.includes(t)) return true;
  }
  return false;
}

(async () => {
  const tools = await loadGripTools();
  const allIdents = new Set();
  const failed = [];

  // Sequential fetch — politer to docs, easier to read errors.
  for (const path of SEED) {
    const res = await fetchPage(path);
    if (!res.ok) { failed.push(res); continue; }
    for (const id of res.idents) allIdents.add(id);
  }

  // Drop common cross-noise that's not API-relevant.
  const NOISE_PREFIX = ['data', 'window', 'parent', 'this', 'self'];
  for (const id of [...allIdents]) {
    if (NOISE_PREFIX.some((p) => id.startsWith(`${p}.`))) allIdents.delete(id);
  }

  const covered = [];
  const uncovered = [];
  for (const id of [...allIdents].sort()) {
    (isCovered(id, tools) ? covered : uncovered).push(id);
  }

  if (ARG_JSON) {
    process.stdout.write(JSON.stringify({
      gripTools: [...tools].sort(),
      documented: [...allIdents].sort(),
      covered, uncovered, failed,
    }, null, 2));
    return;
  }

  console.log(`# Figma API extraction\n`);
  console.log(`Pages fetched: ${SEED.length} (failed: ${failed.length})`);
  console.log(`Documented identifiers found: ${allIdents.size}`);
  console.log(`Grip tools registered: ${tools.size}`);
  console.log(`Heuristic covered: ${covered.length}`);
  console.log(`Heuristic uncovered: ${uncovered.length}`);
  console.log(`\n## Uncovered (potential gaps)`);
  for (const id of uncovered) console.log(`  - ${id}`);
  if (failed.length) {
    console.log(`\n## Failed pages`);
    for (const f of failed) console.log(`  - ${f.url} :: ${f.status ?? f.error}`);
  }
})();
