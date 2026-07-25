// Over the wire, with the SDK's own client — two agents on one server, which
// is the situation the product exists for. Nothing here knows about Claude
// Code: it is a stock MCP client, which is what requirement 8 asks for.

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

type ToolResult = { structuredContent?: Record<string, unknown>; isError?: boolean; content?: unknown };

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

test('the surface is plain MCP tools any client can list', async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    'claim_scope',
    'create_room',
    'identify',
    'join_room',
    'list_claims',
    'list_participants',
    'list_rooms',
    'post_message',
    'read_messages',
    'release_claim',
    'renew_claim',
    'wait_for_events',
  ]);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object', `${tool.name} takes an object`);
    assert.ok((tool.description ?? '').length > 20, `${tool.name} explains itself`);
  }
});

test('a tool call before identify fails with the remedy in the message', async () => {
  const client = await connect();
  const result = await call(client, 'list_rooms');
  assert.equal(result.isError, undefined, 'reads do not need an identity');

  const posted = await call(client, 'create_room', { name: 'anonymous' });
  assert.equal(posted.isError, true);
  assert.match(JSON.stringify(posted.content), /identify yourself first/);
});

test('two agents meet in a room, and the second is refused an overlapping claim', async () => {
  const ada = await connect();
  const grace = await connect();

  await call(ada, 'identify', { name: 'ada', harness: 'claude-code', repo: 'quorum', branch: 'claude/spine' });
  await call(grace, 'identify', { name: 'grace', harness: 'codex', repo: 'quorum' });

  await call(ada, 'create_room', { name: 'quorum-dev', topic: 'building the spine' });
  await call(grace, 'join_room', { room: 'quorum-dev' });
  await call(ada, 'post_message', { room: 'quorum-dev', body: 'taking src/domain' });

  const read = await call(grace, 'read_messages', { room: 'quorum-dev' });
  const messages = read.structuredContent?.messages as { body: string }[];
  assert.deepEqual(
    messages.map((message) => message.body),
    ['taking src/domain'],
  );

  const claimed = await call(ada, 'claim_scope', {
    repo: 'quorum',
    patterns: ['src/domain/**'],
    purpose: 'the core domain',
  });
  assert.equal(claimed.structuredContent?.granted, true);

  const refused = await call(grace, 'claim_scope', {
    repo: 'quorum',
    patterns: ['src/**/*.ts'],
    purpose: 'a refactor across src',
  });
  assert.equal(refused.structuredContent?.granted, false);
  assert.match(String(refused.structuredContent?.advice), /Already claimed: quorum src\/domain\/\*\*/);

  const listed = await call(grace, 'list_claims', { repo: 'quorum' });
  assert.equal((listed.structuredContent?.claims as unknown[]).length, 1);
});

test('reconnecting with the same name resumes the identity and its claims', async () => {
  const first = await connect();
  const identified = await call(first, 'identify', { name: 'ada:reconnect', harness: 'claude-code' });
  assert.equal(identified.structuredContent?.resumed, false);
  await call(first, 'claim_scope', { repo: 'reconnect-demo', patterns: ['src/**'], purpose: 'holding across a drop' });
  await first.close();

  // A fresh MCP session — new transport, new session id, same agent.
  const again = await connect();
  const resumed = await call(again, 'identify', { name: 'ada:reconnect', harness: 'claude-code' });
  assert.equal(resumed.structuredContent?.resumed, true);
  const held = resumed.structuredContent?.claims as { id: string }[];
  assert.equal(held.length, 1, 'told what it still holds');

  const released = await call(again, 'release_claim', { claim_id: held[0]!.id });
  assert.equal(released.isError, undefined, 'and can release it, rather than waiting out the TTL');
});

test('a waiting agent is woken by another agent, not by polling', async () => {
  const ada = await connect();
  const grace = await connect();
  await call(ada, 'identify', { name: 'ada-waiter', harness: 'claude-code' });
  await call(grace, 'identify', { name: 'grace-poster', harness: 'codex' });
  await call(ada, 'create_room', { name: 'wakeup' });
  await call(grace, 'join_room', { room: 'wakeup' });

  const cursor = ((await call(ada, 'wait_for_events', { after_seq: 0, timeout_ms: 0 })).structuredContent
    ?.events as { seq: number }[]).at(-1)?.seq;

  const waiting = call(ada, 'wait_for_events', { after_seq: cursor ?? 0, timeout_ms: 5_000 });
  const posting = new Promise((resolve) => setTimeout(resolve, 25)).then(() =>
    call(grace, 'post_message', { room: 'wakeup', body: 'your turn' }),
  );

  const [woken] = await Promise.all([waiting, posting]);
  const events = woken.structuredContent?.events as { kind: string }[];
  assert.ok(events.some((event) => event.kind === 'message'), 'the long-poll returned the message');
});
