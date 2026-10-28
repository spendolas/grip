import assert from 'node:assert';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSession } from '../dist/mcp-server.js';
import { BRIDGE_VERSION } from '../dist/types.js';

// A plugin that predates a method returns no result; that must surface as an actionable
// tool error, not an MCP protocol error ("expected string, received undefined").
const bridge = { on() {}, request: async () => undefined };
const live = createSession(bridge);
live.session.toolScopeSpec = 'all';
const [ct, st] = InMemoryTransport.createLinkedPair();
await live.server.connect(st);
const client = new Client({ name: 't', version: '0' }, { capabilities: {} });
await client.connect(ct);

// plain tool
const plain = await client.callTool({ name: 'list_library_variables', arguments: {} });
assert.ok(plain.isError, 'undefined plugin result is a tool error');
assert.match(plain.content[0].text, /older build/);
assert.match(plain.content[0].text, /list_library_variables/);

// merged tool: the message names the underlying plugin method
const merged = await client.callTool({ name: 'variable_collection', arguments: { op: 'extend', collectionId: 'c', name: 'x' } });
assert.ok(merged.isError);
assert.match(merged.content[0].text, /extend_variable_collection/);

// a legitimate falsy result still passes through
live.session.toolScopeSpec = 'all';
const ok = createSession({ on() {}, request: async () => ({ success: true }) });
const [ct2, st2] = InMemoryTransport.createLinkedPair();
await ok.server.connect(st2);
const c2 = new Client({ name: 't', version: '0' }, { capabilities: {} });
await c2.connect(ct2);
const good = await c2.callTool({ name: 'list_library_variables', arguments: {} });
assert.ok(!good.isError && JSON.parse(good.content[0].text).success === true);

// plugin and bridge versions are bumped in lockstep (plugin constant is read from source)
import { readFileSync } from 'node:fs';
const pluginSrc = readFileSync(new URL('../../plugin/code.ts', import.meta.url), 'utf8');
assert.match(pluginSrc, new RegExp(`const PLUGIN_VERSION = '${BRIDGE_VERSION.replace(/\./g, '\\.')}'`), 'PLUGIN_VERSION matches BRIDGE_VERSION');

console.log('stale-plugin.mjs OK');
