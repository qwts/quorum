// Direct messages (requirements 1.1 #7): the thread is the identity pair, the
// event is audience-scoped, and both properties hold at every layer — the
// domain first, then over the wire with a stock MCP client.
//
// The audience-scoped event is the design decision at the heart of #42 (and
// the precedent v1 auth builds on), so the assertions here are mostly about
// who does NOT see things: the shared feed, a bystander's wait, a third
// party's read. A privacy feature is tested by its absences.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { openQuorum, QuorumError } from '../src/domain/quorum.ts';
import { MCP_PATH, startServer } from '../src/mcp/server.ts';

function agent(quorum: ReturnType<typeof openQuorum>, name: string) {
  return quorum.identify({ name, harness: 'test' }).participant;
}

/* ── the domain ──────────────────────────────────────────────────────────── */

test('a DM thread is the pair, whichever side speaks, and survives a restart (1.1 #7, #10)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quorum-dm-'));
  try {
    const path = join(dir, 'quorum.db');
    let threadId: string;
    {
      const quorum = openQuorum({ path });
      const ada = agent(quorum, 'ada');
      const grace = agent(quorum, 'grace');

      const sent = quorum.sendDm({ participantId: ada.id, to: grace.id, body: 'outside any room' });
      threadId = sent.thread.id;
      const replied = quorum.sendDm({ participantId: grace.id, to: 'ada', body: 'same thread back' });
      assert.equal(replied.thread.id, threadId, 'replying resumes the thread — the pair is the key, not who spoke first');

      const read = quorum.readDms({ participantId: ada.id, with: grace.id });
      assert.deepEqual(read.messages.map((m) => m.body), ['outside any room', 'same thread back']);
      quorum.close();
    }

    // The identity pair outlives the server: the same two names resume the
    // same conversation after a restart.
    const reopened = openQuorum({ path });
    const ada = agent(reopened, 'ada');
    const grace = agent(reopened, 'grace');
    const resumed = reopened.sendDm({ participantId: ada.id, to: grace.id, body: 'still us' });
    assert.equal(resumed.thread.id, threadId);
    assert.equal(reopened.readDms({ participantId: grace.id, with: ada.id }).messages.length, 3);
    const threads = reopened.listDmThreads({ participantId: grace.id });
    assert.equal(threads.length, 1);
    assert.equal(threads[0]?.counterpart.name, 'ada');
    assert.equal(threads[0]?.lastMessage?.body, 'still us');
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a DM exists only for its two participants — the shared feed never carries it (#42)', () => {
  const quorum = openQuorum();
  const ada = agent(quorum, 'ada');
  const grace = agent(quorum, 'grace');
  const mallory = agent(quorum, 'mallory');

  quorum.sendDm({ participantId: ada.id, to: grace.id, body: 'the launch passphrase is swordfish' });

  // The shared feed — what an unidentified observer or any read without a
  // viewer sees — carries neither the content nor the event.
  const shared = quorum.readEvents({ afterSeq: 0, limit: 500 });
  assert.ok(!shared.some((event) => event.kind === 'dm_message'), 'no dm_message on the shared feed');
  assert.ok(!JSON.stringify(shared).includes('swordfish'), 'and no content anywhere in it');

  // A third participant's view is the shared feed too: naming a viewer widens
  // the read only to events addressed to *that* viewer.
  const bystander = quorum.readEvents({ afterSeq: 0, limit: 500, viewerId: mallory.id });
  assert.ok(!JSON.stringify(bystander).includes('swordfish'), 'a third party sees nothing');
  assert.ok(!bystander.some((event) => event.kind === 'dm_message'), 'not even that it happened');

  // Both ends of the pair see it, sender included — the echo an agent's
  // wait_for_events marks by_you rides the same scoped event.
  for (const member of [ada, grace]) {
    const view = quorum.readEvents({ afterSeq: 0, limit: 500, viewerId: member.id });
    const dm = view.find((event) => event.kind === 'dm_message');
    assert.ok(dm, `${member.name} receives the event`);
    assert.equal((dm.payload.message as { body: string }).body, 'the launch passphrase is swordfish');
  }

  // The unseen count an agent is greeted with obeys the same filter: the
  // count must never promise events the read then refuses to hand over.
  const { cursor, unseen } = quorum.cursorFor(mallory.id);
  assert.equal(unseen, quorum.readEvents({ afterSeq: cursor, limit: 500, viewerId: mallory.id }).length);
  quorum.close();
});

test('a DM wakes the counterpart mid-wait, and leaves a bystander blocked (1.1 #8)', async () => {
  const quorum = openQuorum();
  const ada = agent(quorum, 'ada');
  const grace = agent(quorum, 'grace');
  const mallory = agent(quorum, 'mallory');
  const from = quorum.latestSeq();

  const counterpart = quorum.waitForEvents({ afterSeq: from, timeoutMs: 5_000, participantId: grace.id });
  const bystander = quorum.waitForEvents({ afterSeq: from, timeoutMs: 300, participantId: mallory.id });

  quorum.sendDm({ participantId: ada.id, to: grace.id, body: 'wake up' });

  const woken = await counterpart;
  assert.equal(woken.length, 1, 'the counterpart is woken by the DM itself');
  assert.equal(woken[0]?.kind, 'dm_message');

  const nothing = await bystander;
  assert.deepEqual(nothing, [], 'the bystander wait times out empty — the DM is not visible to it');
  quorum.close();
});

test('a DM refuses the malformed cases in words: yourself, nobody, an ambiguous name', () => {
  const quorum = openQuorum();
  const ada = agent(quorum, 'ada');
  agent(quorum, 'grace');
  // Two harnesses can share a name; a DM must not guess between them.
  quorum.identify({ name: 'grace', harness: 'other-harness' });

  assert.throws(() => quorum.sendDm({ participantId: ada.id, to: ada.id, body: 'hi me' }), /that recipient is you/);
  assert.throws(() => quorum.sendDm({ participantId: ada.id, to: 'nobody-here', body: 'hi' }), /unknown participant/);
  assert.throws(() => quorum.sendDm({ participantId: ada.id, to: 'grace', body: 'hi' }), /2 participants/);
  assert.throws(() => quorum.sendDm({ participantId: ada.id, to: 'grace', body: 'hi' }), QuorumError);

  // Reading before anyone has written is an empty conversation, not an error.
  const grace2 = quorum.listParticipants().find((p) => p.harness === 'other-harness')!;
  const unwritten = quorum.readDms({ participantId: ada.id, with: grace2.id });
  assert.deepEqual(unwritten.messages, []);
  assert.equal(unwritten.thread, null);
  quorum.close();
});

/* ── over the wire, with a stock MCP client ──────────────────────────────── */

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

test('a DM reaches its counterpart mid-wait and never reaches anyone else', async () => {
  const ada = await connect();
  const grace = await connect();
  const mallory = await connect();
  await call(ada, 'identify', { name: 'ada-dm', harness: 'claude-code' });
  await call(grace, 'identify', { name: 'grace-dm', harness: 'codex' });
  await call(mallory, 'identify', { name: 'mallory-dm', harness: 'cursor' });

  const cursorOf = async (client: Client) =>
    ((await call(client, 'wait_for_events', { after_seq: 0, timeout_ms: 0 })).structuredContent?.cursor as number) ?? 0;
  const graceCursor = await cursorOf(grace);
  const malloryCursor = await cursorOf(mallory);

  // Grace blocks in wait_for_events; the DM itself must wake her (1.1 #8).
  const graceWaiting = call(grace, 'wait_for_events', { after_seq: graceCursor, timeout_ms: 5_000 });
  // Mallory blocks too; the DM must NOT wake him, so his wait returns empty.
  const malloryWaiting = call(mallory, 'wait_for_events', { after_seq: malloryCursor, timeout_ms: 500 });

  await new Promise((resolve) => setTimeout(resolve, 25));
  const sent = await call(ada, 'send_dm', { to: 'grace-dm', body: 'between us: the token rotates at noon' });
  assert.ok(!sent.isError, 'send_dm succeeds by name when the name is unique');

  const woken = await graceWaiting;
  const graceEvents = woken.structuredContent?.events as { kind: string; payload: any }[];
  const dm = graceEvents.find((event) => event.kind === 'dm_message');
  assert.ok(dm, 'the counterpart is woken by the DM');
  assert.equal(dm.payload.message.body, 'between us: the token rotates at noon');

  const blocked = await malloryWaiting;
  const malloryEvents = blocked.structuredContent?.events as { kind: string }[];
  assert.ok(!malloryEvents.some((event) => event.kind === 'dm_message'), 'a third party never sees a dm_message');
  assert.ok(
    !JSON.stringify(blocked).includes('token rotates'),
    'and no DM content leaks through any part of the reply',
  );

  // The thread reads back for both ends, and read_dms hands back the cursor
  // discipline every read tool carries.
  const read = await call(grace, 'read_dms', { with: 'ada-dm' });
  const messages = read.structuredContent?.messages as { body: string }[];
  assert.deepEqual(messages.map((m) => m.body), ['between us: the token rotates at noon']);

  const inbox = await call(grace, 'list_dms', {});
  const threads = inbox.structuredContent?.threads as { counterpart: { name: string } }[];
  assert.equal(threads.length, 1);
  assert.equal(threads[0]?.counterpart.name, 'ada-dm');
});

test('a DM tool call before identify is refused with the remedy', async () => {
  const client = await connect();
  const result = await call(client, 'send_dm', { to: 'anyone', body: 'hi' });
  assert.ok(result.isError);
  assert.match(JSON.stringify(result.content), /identify/);
});
