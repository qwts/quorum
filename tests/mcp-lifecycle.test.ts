// The lifecycle tools (#80) over the wire, with the SDK's own client: leave,
// rename, set_topic, clear_status. Each reply carries the next call, each
// mutation reaches the other agent's wait_for_events as its own event, and
// each refusal is a tool error whose text is written to be read.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { openQuorum } from '../src/domain/quorum.ts';
import { MCP_PATH, startServer } from '../src/mcp/server.ts';

const quorum = openQuorum();
const server = await startServer({ quorum });
const url = new URL(`http://127.0.0.1:${server.port}${MCP_PATH}`);
const clients: Client[] = [];

after(async () => {
  for (const client of clients) await client.close();
  await server.close();
  quorum.close();
});

async function connect(): Promise<Client> {
  const client = new Client({ name: 'test-agent', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  clients.push(client);
  return client;
}

type ToolResult = { structuredContent?: Record<string, unknown>; isError?: boolean; content?: { text?: string }[] };

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

// A failure renders as server-authored guidance followed by the error as
// data (AGENTS.md), so a refusal's quoted values arrive JSON-escaped.
const text = (result: ToolResult) => result.content?.map((c) => c.text ?? '').join('\n') ?? '';
const unescaped = (result: ToolResult) => text(result).replaceAll('\\"', '"');

test('the lifecycle family is listed with the rest, each with a hand-written schema', async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  const names = new Set(tools.map((tool) => tool.name));
  for (const name of ['leave_room', 'rename_room', 'set_topic', 'clear_status']) {
    assert.ok(names.has(name), `${name} is on the surface`);
  }
  const rename = tools.find((tool) => tool.name === 'rename_room')!;
  assert.deepEqual(rename.inputSchema.required, ['room', 'name']);
  assert.match(rename.description ?? '', /#82/, 'the interim ownership rule is stated in the contract');
});

test('rename and topic are the creator\'s, reach the other member as events, and the reply says what to do next', async () => {
  const ada = await connect();
  const sol = await connect();
  await call(ada, 'identify', { name: 'ada', harness: 'claude-code' });
  await call(sol, 'identify', { name: 'sol', harness: 'codex' });
  await call(ada, 'create_room', { name: 'protocol', topic: 'the wire' });
  await call(sol, 'join_room', { room: 'protocol' });
  const cursor = quorum.latestSeq();

  const refused = await call(sol, 'rename_room', { room: 'protocol', name: 'mine' });
  assert.equal(refused.isError, true);
  assert.match(unescaped(refused), /only the creator of "protocol" can rename it until room roles land \(#82\)/);

  const renamed = await call(ada, 'rename_room', { room: 'protocol', name: 'wire' });
  assert.equal(renamed.isError, undefined, text(renamed));
  assert.equal((renamed.structuredContent?.room as { name: string }).name, 'wire');
  assert.match(text(renamed), /room_renamed/);
  assert.match(text(renamed), /post_message/, 'the reply carries the next call');

  const topic = await call(ada, 'set_topic', { room: 'wire', topic: '' });
  assert.equal((topic.structuredContent?.room as { topic: string | null }).topic, null, 'an empty topic clears it');
  assert.match(text(topic), /now has no topic/);

  // A no-op says it was one, so a client does not wait for an event that
  // never comes (Codex on #139).
  const same = await call(ada, 'rename_room', { room: 'wire', name: 'wire' });
  assert.equal(same.structuredContent?.changed, false);
  assert.match(text(same), /already named "wire"; nothing changed and no event was recorded/);
  assert.doesNotMatch(text(same), /Members see/);
  const still = await call(ada, 'set_topic', { room: 'wire', topic: '  ' });
  assert.equal(still.structuredContent?.changed, false);
  assert.match(text(still), /already had no topic; nothing changed/);

  const seen = await call(sol, 'wait_for_events', { after_seq: cursor, timeout_ms: 100 });
  const kinds = (seen.structuredContent?.events as { kind: string; payload: { previousName?: string } }[]).map(
    (event) => event.kind,
  );
  assert.deepEqual(kinds, ['room_renamed', 'room_topic_set'], 'a refusal is not on the feed; the two changes are');
  const events = seen.structuredContent?.events as { payload: { previousName?: string } }[];
  assert.equal(events[0]!.payload.previousName, 'protocol');
});

test('leave_room ends the membership and posting afterwards is the non-member refusal', async () => {
  const ada = await connect();
  const sol = await connect();
  await call(ada, 'identify', { name: 'ada-2', harness: 'claude-code' });
  await call(sol, 'identify', { name: 'sol-2', harness: 'codex' });
  await call(ada, 'create_room', { name: 'design' });
  await call(sol, 'join_room', { room: 'design' });
  const cursor = quorum.latestSeq();

  const left = await call(sol, 'leave_room', { room: 'design' });
  assert.equal(left.isError, undefined, text(left));
  assert.match(text(left), /join_room brings you back/);
  assert.match(text(left), /release_claim/, 'leaving says what it does not do');

  const again = await call(sol, 'leave_room', { room: 'design' });
  assert.equal(again.isError, true);
  assert.match(unescaped(again), /you are not in "design"/);

  const post = await call(sol, 'post_message', { room: 'design', body: 'still here?' });
  assert.equal(post.isError, true);
  assert.match(unescaped(post), /join "design" before posting/);

  const seen = await call(ada, 'wait_for_events', { after_seq: cursor, timeout_ms: 100 });
  assert.deepEqual(
    (seen.structuredContent?.events as { kind: string }[]).map((event) => event.kind),
    ['room_left'],
  );
  const rooms = await call(ada, 'list_rooms');
  const design = (rooms.structuredContent?.rooms as { name: string; members: number }[]).find((r) => r.name === 'design');
  assert.equal(design?.members, 1);
});

test('clear_status empties the roster line once, and a second clear is a quiet no-op', async () => {
  const ada = await connect();
  await call(ada, 'identify', { name: 'ada-3', harness: 'claude-code' });
  await call(ada, 'create_room', { name: 'status-room' });
  await call(ada, 'post_message', { room: 'status-room', body: '/blocked waiting on review' });
  const cursor = quorum.latestSeq();

  const cleared = await call(ada, 'clear_status');
  assert.equal(cleared.isError, undefined, text(cleared));
  assert.equal((cleared.structuredContent?.participant as { status: unknown }).status, null);
  assert.match(text(cleared), /wait_for_events/, 'the reply sends the agent back to the room');

  await call(ada, 'clear_status');
  const seen = await call(ada, 'wait_for_events', { after_seq: cursor, timeout_ms: 100 });
  assert.deepEqual(
    (seen.structuredContent?.events as { kind: string }[]).map((event) => event.kind),
    ['status_changed'],
    'one clearing, one event',
  );

  const roster = await call(ada, 'list_participants');
  const me = (roster.structuredContent?.participants as { name: string; status: unknown }[]).find((p) => p.name === 'ada-3');
  assert.equal(me?.status, null);
});

test('lifecycle tools need an identity first, like every other mutation', async () => {
  const anon = await connect();
  for (const [name, args] of [
    ['leave_room', { room: 'x' }],
    ['rename_room', { room: 'x', name: 'y' }],
    ['set_topic', { room: 'x', topic: 'y' }],
    ['clear_status', {}],
  ] as const) {
    const result = await call(anon, name, args);
    assert.equal(result.isError, true, `${name} without identify is refused`);
    assert.match(text(result), /identify/);
  }
});
