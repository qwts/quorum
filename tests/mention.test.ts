// @mention forks a DM (#84): one canonical message, two delivery contexts.
//
// The assertions are mostly about what does NOT happen — no copy, no second
// event, no fork to a non-member, no fork to yourself — because the naive
// build gets every one of those wrong and each is a drift or a leak.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openQuorum } from '../src/domain/quorum.ts';

function fresh() {
  return openQuorum({ path: join(mkdtempSync(join(tmpdir(), 'quorum-mention-')), 'quorum.db') });
}

function agent(quorum: ReturnType<typeof openQuorum>, name: string, harness = 'test') {
  return quorum.identify({ name, harness }).participant;
}

test('a mention forks the room message into the DM thread as a reference, not a copy', () => {
  const quorum = fresh();
  const ada = agent(quorum, 'ada');
  const grace = agent(quorum, 'grace');
  quorum.createRoom({ name: 'fork', by: ada.id });
  quorum.joinRoom({ room: 'fork', participantId: grace.id });

  const posted = quorum.postMessage({ room: 'fork', participantId: ada.id, body: '@grace can you take the tests?' });
  assert.equal(posted.forks.length, 1);
  assert.equal(posted.forks[0]!.participantId, grace.id);

  // The thread between them now holds the message — body read through the
  // reference, attributed to ada, pointing back at the room.
  const thread = quorum.readDms({ participantId: grace.id, with: ada.id });
  assert.equal(thread.messages.length, 1);
  const forked = thread.messages[0]!;
  assert.equal(forked.id, posted.forks[0]!.dmId);
  assert.equal(forked.body, '@grace can you take the tests?');
  assert.equal(forked.participantId, ada.id);
  assert.deepEqual(forked.origin, { messageId: posted.id, roomId: posted.roomId, roomName: 'fork' });
  assert.equal(forked.createdAt, posted.createdAt);

  // One record: the fork row stores no body of its own.
  const stored = quorum.readDms({ participantId: ada.id, with: grace.id }).messages[0]!;
  assert.equal(stored.origin?.messageId, posted.id);
  const inbox = quorum.listDmThreads({ participantId: grace.id });
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0]!.lastMessage?.origin?.messageId, posted.id, 'the inbox shows the fork as the last word');

  // The room still has exactly the one message.
  assert.equal(quorum.readMessages({ room: 'fork', viewerId: ada.id }).length, 1);
  quorum.close();
});

test('no second event: the room event carries the forks, and unseen counts stay single', async () => {
  const quorum = fresh();
  const ada = agent(quorum, 'ada');
  const grace = agent(quorum, 'grace');
  quorum.createRoom({ name: 'once', by: ada.id });
  quorum.joinRoom({ room: 'once', participantId: grace.id });
  const before = quorum.latestSeq();

  const posted = quorum.postMessage({ room: 'once', participantId: ada.id, body: 'ping @grace' });
  assert.equal(quorum.latestSeq(), before + 1, 'exactly one event for a mention');
  assert.equal(quorum.cursorFor(grace.id).unseen, quorum.latestSeq() - quorum.cursorFor(grace.id).cursor);

  const events = await quorum.waitForEvents({ afterSeq: before, timeoutMs: 0, participantId: grace.id });
  assert.deepEqual(events.map((event) => event.kind), ['message']);
  assert.deepEqual(events[0]!.payload.forks, posted.forks);

  // The directed lane counts it as addressed to grace (#61 already did).
  const directed = await quorum.waitForEvents({ afterSeq: before, timeoutMs: 0, participantId: grace.id, lane: 'directed' });
  assert.equal(directed.length, 1);
  quorum.close();
});

test('a mention resolves against the roster of the room it is posted in, and only that', () => {
  const quorum = fresh();
  const ada = agent(quorum, 'ada');
  const grace = agent(quorum, 'grace');
  const mallory = agent(quorum, 'mallory'); // on the server, not in the room
  quorum.createRoom({ name: 'small', by: ada.id });
  quorum.joinRoom({ room: 'small', participantId: grace.id });

  const posted = quorum.postMessage({
    room: 'small',
    participantId: ada.id,
    body: '@mallory is not here, @grace is, and @ada is me; @nobody and email@grace are text',
  });
  assert.deepEqual(
    posted.forks.map((fork) => fork.name),
    ['grace'],
    'a non-member stays text, the author forks nothing, fragments do not match',
  );
  assert.equal(quorum.readDms({ participantId: mallory.id, with: ada.id }).messages.length, 0);
  assert.equal(quorum.listDmThreads({ participantId: mallory.id }).length, 0, 'no thread was even opened');
  quorum.close();
});

test('a non-member mention wakes nobody: the directed lane follows the resolved forks, not the text', async () => {
  const quorum = fresh();
  const ada = agent(quorum, 'ada');
  const mallory = agent(quorum, 'mallory');
  quorum.createRoom({ name: 'public', by: ada.id }); // public: mallory can read it without joining
  const before = quorum.latestSeq();
  quorum.postMessage({ room: 'public', participantId: ada.id, body: '@mallory is not in here' });

  const all = await quorum.waitForEvents({ afterSeq: before, timeoutMs: 0, participantId: mallory.id });
  assert.equal(all.length, 1, 'the room is public, so the event is visible on the all lane');
  const directed = await quorum.waitForEvents({ afterSeq: before, timeoutMs: 0, participantId: mallory.id, lane: 'directed' });
  assert.deepEqual(directed, [], 'but it did not resolve to her, so it does not address her');
  quorum.close();
});

test('combining marks are name characters, and both sides are NFC-normalized', () => {
  const quorum = fresh();
  const ada = agent(quorum, 'ada');
  const jose = agent(quorum, 'José'); // NFC: precomposed é
  const plain = agent(quorum, 'Jose');
  quorum.createRoom({ name: 'accents', by: ada.id });
  quorum.joinRoom({ room: 'accents', participantId: jose.id });
  quorum.joinRoom({ room: 'accents', participantId: plain.id });

  // Decomposed in the body, precomposed on the roster: still José, and not Jose.
  const decomposed = quorum.postMessage({ room: 'accents', participantId: ada.id, body: '@Jose\u0301 hola' });
  assert.deepEqual(decomposed.forks.map((fork) => fork.participantId), [jose.id]);
  // The bare name is Jose alone.
  const bare = quorum.postMessage({ room: 'accents', participantId: ada.id, body: '@Jose hola' });
  assert.deepEqual(bare.forks.map((fork) => fork.participantId), [plain.id]);
  quorum.close();
});

test('two members sharing a name are both mentioned, and the fork lands in the thread a DM would', () => {
  const quorum = fresh();
  const ada = agent(quorum, 'ada');
  const grace1 = agent(quorum, 'grace', 'claude-code');
  const grace2 = agent(quorum, 'grace', 'codex');
  quorum.createRoom({ name: 'twins', by: ada.id });
  quorum.joinRoom({ room: 'twins', participantId: grace1.id });
  quorum.joinRoom({ room: 'twins', participantId: grace2.id });

  // An existing thread is resumed, not duplicated.
  const earlier = quorum.sendDm({ participantId: grace1.id, to: ada.id, body: 'before the mention' });
  const posted = quorum.postMessage({ room: 'twins', participantId: ada.id, body: '@grace both of you' });
  assert.deepEqual(new Set(posted.forks.map((fork) => fork.participantId)), new Set([grace1.id, grace2.id]));
  assert.equal(posted.forks.find((fork) => fork.participantId === grace1.id)!.threadId, earlier.thread.id);

  const thread = quorum.readDms({ participantId: grace1.id, with: ada.id });
  assert.deepEqual(
    thread.messages.map((message) => [message.body, message.origin?.messageId ?? null]),
    [
      ['before the mention', null],
      ['@grace both of you', posted.id],
    ],
  );

  // A reply composed in the thread is an ordinary DM: private, not in the room.
  const roomBefore = quorum.readMessages({ room: 'twins', viewerId: ada.id }).length;
  quorum.sendDm({ participantId: grace1.id, to: ada.id, body: 'privately: yes' });
  assert.equal(quorum.readMessages({ room: 'twins', viewerId: ada.id }).length, roomBefore);
  assert.equal(quorum.readDms({ participantId: grace2.id, with: ada.id }).messages.length, 1, "grace2's thread is her own");
  quorum.close();
});

test('the thread cursor is the same unit for forks and DMs, so paging past a fork works', () => {
  const quorum = fresh();
  const ada = agent(quorum, 'ada');
  const grace = agent(quorum, 'grace');
  quorum.createRoom({ name: 'page', by: ada.id });
  quorum.joinRoom({ room: 'page', participantId: grace.id });
  quorum.sendDm({ participantId: ada.id, to: grace.id, body: 'one' });
  quorum.postMessage({ room: 'page', participantId: ada.id, body: '@grace two' });
  quorum.sendDm({ participantId: grace.id, to: ada.id, body: 'three' });

  const first = quorum.readDms({ participantId: grace.id, with: ada.id, limit: 2 });
  assert.deepEqual(first.messages.map((message) => message.body), ['one', '@grace two']);
  const rest = quorum.readDms({ participantId: grace.id, with: ada.id, afterId: first.messages.at(-1)!.id });
  assert.deepEqual(rest.messages.map((message) => message.body), ['three']);
  quorum.close();
});
