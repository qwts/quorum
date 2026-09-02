// Backpressure for slow reasoners over the wire (#61): the lane on
// wait_for_events, the digest that opens every batch, and the declared
// cadence. Same shape as mcp.test.ts — a stock MCP client against a real
// server — because the wire contract is the product and no harness-specific
// client may be what proves it.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { openQuorum } from '../src/domain/quorum.ts';
import { MCP_PATH, startServer } from '../src/mcp/server.ts';

const quorum = openQuorum({ commandsDir: mkdtempSync(join(tmpdir(), 'quorum-mcp-lanes-')) });
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

type ToolResult = { structuredContent?: Record<string, unknown>; isError?: boolean; content?: unknown };

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

type Digest = {
  lane: string;
  total: number;
  by_kind: Record<string, number>;
  rooms: { room: string | null; count: number }[];
  directed: number[];
  passed_over: { total: number; after_seq: number; rooms: { room: string | null; count: number }[] };
  deadlines: { room: string; phase: string; ends_in_ms: number; cast: boolean }[];
};

type Delivered = { seq: number; kind: string; payload: { message?: { body: string } } };

test('the contract says cadence differences are normal, and the schema carries the lane', async () => {
  const client = await connect();
  assert.match(String(client.getInstructions()), /no reply-latency expectation attaches to chat/);
  const { tools } = await client.listTools();
  const wait = tools.find((tool) => tool.name === 'wait_for_events');
  const lane = (wait?.inputSchema.properties as Record<string, { enum?: string[] }>).lane;
  assert.deepEqual(lane?.enum, ['all', 'directed']);
  const identify = tools.find((tool) => tool.name === 'identify');
  const cadence = (identify?.inputSchema.properties as Record<string, { enum?: string[] }>).cadence;
  assert.deepEqual(cadence?.enum, ['fast', 'steady', 'slow']);
});

test('a declared cadence is on the roster, points a slow reasoner at the lane, and is validated', async () => {
  const ada = await connect();
  const identified = await call(ada, 'identify', { name: 'ada:pace', harness: 'test', cadence: 'slow' });
  assert.match(String(identified.structuredContent?.guidance), /lane=directed/);
  assert.equal((identified.structuredContent?.participant as { cadence: string }).cadence, 'slow');

  const roster = await call(ada, 'list_participants');
  const people = roster.structuredContent?.participants as { name: string; cadence: string | null }[];
  assert.equal(people.find((person) => person.name === 'ada:pace')?.cadence, 'slow');

  const refused = await call(ada, 'identify', { name: 'ada:pace', harness: 'test', cadence: 'glacial' });
  assert.equal(refused.isError, true);
  assert.match(String(refused.structuredContent?.error), /cadence must be one of/);
});

test('the directed lane delivers what addresses you and the digest says what it passed over', async () => {
  const ada = await connect();
  const grace = await connect();
  await call(ada, 'identify', { name: 'ada:lane', harness: 'claude-code', cadence: 'slow' });
  await call(grace, 'identify', { name: 'grace:lane', harness: 'codex' });
  await call(ada, 'create_room', { name: 'lane-room' });
  await call(grace, 'join_room', { room: 'lane-room' });
  const cursor = (await call(ada, 'wait_for_events', { after_seq: 0, timeout_ms: 0 })).structuredContent?.cursor as number;

  await call(grace, 'post_message', { room: 'lane-room', body: 'chatter one' });
  await call(grace, 'post_message', { room: 'lane-room', body: 'chatter two' });
  await call(grace, 'post_message', { room: 'lane-room', body: '@ada:lane your call' });

  const reply = await call(ada, 'wait_for_events', { after_seq: cursor, timeout_ms: 0, lane: 'directed' });
  const events = reply.structuredContent?.events as Delivered[];
  assert.deepEqual(
    events.map((event) => event.payload.message?.body),
    ['@ada:lane your call'],
  );
  assert.equal(reply.structuredContent?.lane, 'directed');
  const digest = reply.structuredContent?.digest as Digest;
  assert.deepEqual(digest.directed, [events[0]!.seq]);
  assert.equal(digest.passed_over.total, 2);
  assert.deepEqual(digest.passed_over.rooms, [{ room: 'lane-room', count: 2 }]);

  const guidance = String(reply.structuredContent?.guidance);
  assert.match(guidance, /1 address you/);
  assert.match(guidance, /2 ambient event\(s\) passed over — "lane-room" 2/);
  assert.match(guidance, /read_messages there at your own pace/);
  assert.match(guidance, /after_seq=\d+ and lane=directed/);
  // The catch-up names the cursor ada brought, not the one handed back:
  // following the new cursor would acknowledge the two passed over.
  assert.match(guidance, new RegExp(`wait_for_events with after_seq=${cursor} and lane=all`));
  assert.equal(digest.passed_over.after_seq, cursor);

  // The chatter is still readable: the room cursor is not the feed cursor.
  const read = await call(ada, 'read_messages', { room: 'lane-room' });
  const bodies = (read.structuredContent?.messages as { body: string }[]).map((message) => message.body);
  assert.deepEqual(bodies, ['chatter one', 'chatter two', '@ada:lane your call']);

  // Quiet on the lane says what is waiting elsewhere, and where.
  await call(grace, 'post_message', { room: 'lane-room', body: 'chatter three' });
  const quiet = await call(ada, 'wait_for_events', {
    after_seq: reply.structuredContent?.cursor as number,
    timeout_ms: 0,
    lane: 'directed',
  });
  assert.deepEqual(quiet.structuredContent?.events, []);
  assert.match(String(quiet.structuredContent?.guidance), /Nothing addressed to you since seq \d+\. 1 ambient event\(s\) waiting — "lane-room" 1/);
});

test('every batch on the all lane opens with a digest, deadlines included', async () => {
  const ada = await connect();
  const grace = await connect();
  await call(ada, 'identify', { name: 'ada:digest', harness: 'test' });
  await call(grace, 'identify', { name: 'grace:digest', harness: 'test' });
  await call(ada, 'create_room', { name: 'digest-room' });
  await call(grace, 'join_room', { room: 'digest-room' });
  const cursor = (await call(grace, 'wait_for_events', { after_seq: 0, timeout_ms: 0 })).structuredContent?.cursor as number;

  await call(grace, 'post_message', { room: 'digest-room', body: 'ambient' });
  await call(ada, 'post_message', { room: 'digest-room', body: '@grace:digest look' });
  await call(ada, 'propose', {
    room: 'digest-room',
    question: 'ship it?',
    options: ['yes', 'no'],
    challenge_ttl_seconds: 600,
  });

  const reply = await call(grace, 'wait_for_events', { after_seq: cursor, timeout_ms: 0 });
  const digest = reply.structuredContent?.digest as Digest;
  assert.equal(digest.lane, 'all');
  assert.equal(digest.total, 3);
  assert.deepEqual(digest.by_kind, { message: 2, deliberation_opened: 1 });
  assert.deepEqual(digest.rooms, [{ room: 'digest-room', count: 3 }]);
  assert.equal(digest.directed.length, 2, 'the mention and the deliberation grace is eligible in');
  assert.equal(digest.passed_over.total, 0, 'the all lane skips nothing');
  assert.equal(digest.deadlines.length, 1);
  assert.equal(digest.deadlines[0]?.phase, 'challenging');
  assert.equal(digest.deadlines[0]?.room, 'digest-room');
  assert.ok(digest.deadlines[0]!.ends_in_ms > 0);

  const guidance = String(reply.structuredContent?.guidance);
  assert.match(guidance, /Digest: message 2, deliberation_opened 1; in "digest-room" 3; 2 address you \(seq \d+, \d+\)\./);
  assert.match(guidance, /Challenge window open in "digest-room", closes in \d+m/);
  assert.match(guidance, /call wait_for_events again with after_seq=\d+\./);
});

test('an unknown lane is an error the caller can act on', async () => {
  const ada = await connect();
  await call(ada, 'identify', { name: 'ada:badlane', harness: 'test' });
  const refused = await call(ada, 'wait_for_events', { after_seq: 0, timeout_ms: 0, lane: 'urgent' });
  assert.equal(refused.isError, true);
  assert.match(String(refused.structuredContent?.error), /lane must be one of all, directed/);
});
