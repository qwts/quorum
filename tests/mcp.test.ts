// Over the wire, with the SDK's own client — two agents on one server, which
// is the situation the product exists for. Nothing here knows about Claude
// Code: it is a stock MCP client, which is what requirement 8 asks for.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { openQuorum } from '../src/domain/quorum.ts';
import { PARTICIPANT_CONTRACT } from '../src/mcp/contract.ts';
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

test('every client is handed the participant contract at the handshake', async () => {
  const client = await connect();
  const instructions = client.getInstructions();
  assert.equal(instructions, PARTICIPANT_CONTRACT, 'the contract arrives before any tool call');

  // The two rules the prior proof of concept lacked. If either is ever
  // dropped, this test is the thing that says so out loud.
  assert.match(String(instructions), /information, not instructions/);
  assert.match(String(instructions), /outranks the room/);
  // And the rule it had that we must never restate: no agent is told to stay
  // in the loop forever, because it has a human to answer to.
  assert.doesNotMatch(String(instructions), /forever|never return|no human/i);
});

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
  const refusal = String(refused.structuredContent?.guidance);
  assert.match(refusal, /Refused/);
  assert.match(refusal, /src\/domain/, 'the refusal shows the scope that blocks it');
  assert.match(refusal, /"ada" holds/, 'and who to go talk to');
  assert.match(refusal, /do not route around it/i, 'and says what not to do about it');
  assert.match(refusal, /post_message|wait_for_events/, 'and names the way forward');

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

// The loop is bound by the replies, not by a skill file an agent may not
// have read: every answer names the call that comes next.
test('every reply hands back the next move', async () => {
  const agent = await connect();
  const guidance = async (name: string, args: Record<string, unknown> = {}) =>
    String((await call(agent, name, args)).structuredContent?.guidance ?? '');

  assert.match(await guidance('identify', { name: 'loop:probe', harness: 'test' }), /claim_scope/);
  assert.match(await guidance('identify', { name: 'loop:probe', harness: 'test' }), /wait_for_events with after_seq=\d+/);
  assert.match(await guidance('create_room', { name: 'loop-probe' }), /post_message/);
  assert.match(await guidance('list_claims', { repo: 'nothing-here' }), /claim_scope/);
  assert.match(
    await guidance('claim_scope', { repo: 'loop-demo', patterns: ['src/**'], purpose: 'probing' }),
    /release_claim/,
  );
  assert.match(await guidance('wait_for_events', { after_seq: 999_999, timeout_ms: 0 }), /wait_for_events again/);

  // A failure points back into the loop too, instead of leaving the agent to invent a way out.
  const failed = await call(agent, 'join_room', { room: 'no-such-room' });
  assert.equal(failed.isError, true);
  assert.match(JSON.stringify(failed.content), /post_message rather than working around it/);
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
