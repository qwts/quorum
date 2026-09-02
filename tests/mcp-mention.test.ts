// @mention forks a DM over the wire (#84): what each side is told, through a
// stock MCP client. The domain tests prove the record shape; these prove the
// guidance — requirement 5 is copy, and copy is contract here.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { openQuorum } from '../src/domain/quorum.ts';
import { MCP_PATH, startServer } from '../src/mcp/server.ts';

const quorum = openQuorum({ commandsDir: mkdtempSync(join(tmpdir(), 'quorum-mcp-mention-')) });
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

type DmRow = { id: number; body: string; participantId: string; origin: { messageId: number; roomId: string; roomName: string } | null };

test('both sides are told what the fork means, and the private reply stays private', async () => {
  const ada = await connect();
  const grace = await connect();
  await call(ada, 'identify', { name: 'ada', harness: 'claude-code' });
  await call(grace, 'identify', { name: 'grace', harness: 'codex' });
  await call(ada, 'create_room', { name: 'fork-room' });
  await call(grace, 'join_room', { room: 'fork-room' });
  const cursor = (await call(grace, 'wait_for_events', { after_seq: 0, timeout_ms: 0 })).structuredContent?.cursor as number;

  // The author is told whom it reached and how they may answer.
  const posted = await call(ada, 'post_message', { room: 'fork-room', body: '@grace take the tests?' });
  assert.equal(posted.isError, undefined);
  const postedGuidance = String(posted.structuredContent?.guidance);
  assert.match(postedGuidance, /It mentions "grace", so it also sits in your DM thread with them/);
  assert.match(postedGuidance, /answer in the room or privately with send_dm/);
  const message = posted.structuredContent?.message as { id: number; forks: { name: string; dmId: number }[] };
  assert.deepEqual(message.forks.map((fork) => fork.name), ['grace']);

  // The mentioned side hears it once, on the feed, with the choice spelled out.
  const woken = await call(grace, 'wait_for_events', { after_seq: cursor, timeout_ms: 0 });
  const events = woken.structuredContent?.events as { seq: number; kind: string }[];
  assert.deepEqual(events.map((event) => event.kind), ['message'], 'one event, not a message and a dm_message');
  const wokenGuidance = String(woken.structuredContent?.guidance);
  assert.match(wokenGuidance, new RegExp(`Seq ${events[0]!.seq} mentions you and also sits in your DM thread with "ada"`));
  assert.match(wokenGuidance, /post_message \(everyone sees it\) or privately with send_dm/);

  // The thread reads the room message through its reference, and says so.
  const thread = await call(grace, 'read_dms', { with: 'ada' });
  const rows = thread.structuredContent?.messages as DmRow[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.body, '@grace take the tests?');
  assert.deepEqual(rows[0]!.origin, { messageId: message.id, roomId: rows[0]!.origin!.roomId, roomName: 'fork-room' });
  assert.match(
    String(thread.structuredContent?.guidance),
    new RegExp(`Message ${rows[0]!.id} originated in room "fork-room" — an @mention surfaced it here`),
  );

  // A reply in the thread is a DM: the room does not see it.
  await call(grace, 'send_dm', { to: 'ada', body: 'privately: on it' });
  const room = await call(ada, 'read_messages', { room: 'fork-room' });
  assert.deepEqual(
    (room.structuredContent?.messages as { body: string }[]).map((row) => row.body),
    ['@grace take the tests?'],
  );
  const adaThread = await call(ada, 'read_dms', { with: 'grace' });
  assert.deepEqual(
    (adaThread.structuredContent?.messages as DmRow[]).map((row) => [row.body, row.origin === null]),
    [
      ['@grace take the tests?', false],
      ['privately: on it', true],
    ],
  );
});

test('an @name that is not a member of that room is text: no fork, no thread, plain guidance', async () => {
  const ada = await connect();
  const mallory = await connect();
  await call(ada, 'identify', { name: 'ada', harness: 'claude-code' });
  await call(mallory, 'identify', { name: 'mallory', harness: 'codex' });
  await call(ada, 'create_room', { name: 'plain-room' });

  const posted = await call(ada, 'post_message', { room: 'plain-room', body: '@mallory is not here' });
  assert.doesNotMatch(String(posted.structuredContent?.guidance), /DM thread/);
  assert.deepEqual((posted.structuredContent?.message as { forks: unknown[] }).forks, []);
  const inbox = await call(mallory, 'list_dms');
  assert.deepEqual(inbox.structuredContent?.threads, []);
});
