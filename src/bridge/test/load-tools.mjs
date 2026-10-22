import assert from 'node:assert';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { createSession } from '../dist/mcp-server.js';

// Stub bridge: grip_load_tools is bridge-side and never touches it.
const bridge = { on() {} };

async function connect(spec) {
  const live = createSession(bridge);
  if (spec) live.session.toolScopeSpec = spec;
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await live.server.connect(st);
  const client = new Client({ name: 't', version: '0' }, { capabilities: {} });
  let changed = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => { changed++; });
  await client.connect(ct);
  return { client, changedCount: () => changed };
}
const names = async (c) => (await c.listTools()).tools.map((t) => t.name);
const call = async (c, name, args) => JSON.parse((await c.callTool({ name, arguments: args })).content[0].text);

// Default (core) session: widen with motion.
{
  const { client, changedCount } = await connect(null);
  const before = await names(client);
  assert.ok(before.includes('grip_load_tools'), 'load tool is listed');
  assert.ok(!before.includes('animation_style'), 'motion not loaded initially');
  const res = await call(client, 'grip_load_tools', { categories: ['motion'] });
  assert.ok(res.added.includes('animation_style'), 'reports added tools');
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(changedCount(), 1, 'exactly one tools/list_changed sent');
  const after = await names(client);
  assert.ok(after.includes('animation_style'), 'motion tools now listed');
  assert.ok(after.length > before.length);
  // Loading again is a no-op: no extra notification.
  const again = await call(client, 'grip_load_tools', { categories: ['motion'] });
  assert.strictEqual(again.added.length, 0);
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(changedCount(), 1, 'no notification when nothing new');

  // Unload: tools disappear, one more notification, run_script survives.
  const un = await call(client, 'grip_load_tools', { unload: ['motion'] });
  assert.ok(un.removed.includes('animation_style'), 'reports removed tools');
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(changedCount(), 2, 'unload sends tools/list_changed');
  const gone = await names(client);
  assert.ok(!gone.includes('animation_style') && gone.includes('run_script'), 'motion gone, run_script kept');
  assert.deepStrictEqual(gone.sort(), before.sort(), 'back to the original tool list');

  // Empty call is an error, not a silent no-op.
  const empty = await client.callTool({ name: 'grip_load_tools', arguments: {} });
  assert.ok(empty.isError, 'empty call is rejected');
}

// Restricted (read-only) session cannot self-escalate.
{
  const { client } = await connect('read');
  const r = await client.callTool({ name: 'grip_load_tools', arguments: { categories: ['write'] } });
  assert.ok(r.isError, 'read-only scope is refused');
  assert.ok(!(await names(client)).includes('set_node_property'), 'still read-only');
}

console.log('load-tools.mjs OK');
