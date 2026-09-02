// Priority lanes and the digest's numbers (#61), at the domain seam.
//
// The directed lane is a lens over the caller-owned cursor: what addresses a
// participant, counted through the same visibility filter as the reads. The
// tests here are the contract for "addresses you" — one case per class in
// src/domain/lanes.ts — plus the two properties a lens must keep: the limit
// stays honest across pages, and nothing here reaches a rule.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openQuorum, QuorumError } from '../src/domain/quorum.ts';
import { mentions } from '../src/domain/lanes.ts';

function withClock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

// A pinned, empty deployment dir so a developer's ~/.quorum/commands cannot
// leak in; the built-in /smack still backs it, which is what class 3 needs.
function fresh(now?: () => number) {
  return openQuorum({ now, commandsDir: mkdtempSync(join(tmpdir(), 'quorum-lanes-')) });
}

type Q = ReturnType<typeof openQuorum>;

function agent(quorum: Q, name: string, harness = 'test') {
  return quorum.identify({ name, harness }).participant;
}

async function directed(quorum: Q, participantId: string | null, afterSeq = 0) {
  return quorum.waitForEvents({ afterSeq, timeoutMs: 0, participantId, lane: 'directed' });
}

test('a mention is the whole name standing alone', () => {
  assert.ok(mentions('@ada can you look?', 'ada'));
  assert.ok(mentions('cc @claude:auth-refactor, thanks', 'claude:auth-refactor'));
  assert.ok(mentions('(@ada)', 'ada'));
  assert.ok(!mentions('@ada2 is someone else', 'ada'));
  assert.ok(!mentions('mail me at email@ada', 'ada'));
  assert.ok(!mentions('@ad', 'ada'));
  // A name is data: regex metacharacters in it never widen the match.
  assert.ok(mentions('@a.b ping', 'a.b'));
  assert.ok(!mentions('@axb ping', 'a.b'));
});

test('the directed lane hands over mentions and DMs, and drops ambient chatter and your own echo', async () => {
  const quorum = fresh();
  const ada = agent(quorum, 'ada');
  const grace = agent(quorum, 'grace');
  const tom = agent(quorum, 'tom');
  quorum.createRoom({ name: 'infra', by: ada.id });
  quorum.joinRoom({ room: 'infra', participantId: grace.id });
  quorum.joinRoom({ room: 'infra', participantId: tom.id });

  quorum.postMessage({ room: 'infra', participantId: grace.id, body: 'working on the parser' });
  quorum.postMessage({ room: 'infra', participantId: grace.id, body: '@ada can you review the parser?' });
  quorum.postMessage({ room: 'infra', participantId: grace.id, body: 'reach me at email@ada — not a mention' });
  quorum.postMessage({ room: 'infra', participantId: grace.id, body: '@ada2 is a different agent' });
  quorum.postMessage({ room: 'infra', participantId: ada.id, body: '@ada talking to myself' });
  quorum.sendDm({ participantId: tom.id, to: 'ada', body: 'quiet word' });

  const events = await directed(quorum, ada.id);
  assert.deepEqual(
    events.map((event) => [event.kind, (event.payload.message as { body: string }).body]),
    [
      ['message', '@ada can you review the parser?'],
      ['dm_message', 'quiet word'],
    ],
  );

  // Nothing addresses grace: her own posts are echoes, and the DM is not hers.
  assert.deepEqual(await directed(quorum, grace.id), []);
  // An unidentified observer has nothing addressed to it — not the shared feed.
  assert.deepEqual(await directed(quorum, null), []);

  // The digest's numbers: the two seqs address ada, and everything visible
  // between her cursor and the last handed event was passed over.
  const triage = quorum.triage({ viewerId: ada.id, afterSeq: 0, delivered: events });
  assert.deepEqual(triage.directed, events.map((event) => event.seq));
  const visible = quorum.readEvents({ afterSeq: 0, limit: 500, viewerId: ada.id }).filter(
    (event) => event.seq <= events[events.length - 1]!.seq,
  );
  assert.equal(triage.passedOver.total, visible.length - events.length);
  const infra = quorum.listRooms()[0]!;
  const inInfra = triage.passedOver.rooms.find((room) => room.roomId === infra.id);
  assert.equal(
    inInfra?.count,
    7,
    'by room: the creation, two joins, the ambient post, the two non-mentions, and ada\'s own post',
  );
  assert.deepEqual(triage.deadlines, []);
});

test('a targeted delivery-time command reaches its addressee\'s lane and nobody else\'s', async () => {
  const quorum = fresh();
  const ada = agent(quorum, 'ada');
  const grace = agent(quorum, 'grace');
  const tom = agent(quorum, 'tom');
  quorum.createRoom({ name: 'ops', by: grace.id });
  quorum.joinRoom({ room: 'ops', participantId: ada.id });
  quorum.joinRoom({ room: 'ops', participantId: tom.id });
  quorum.postMessage({ room: 'ops', participantId: grace.id, body: '/smack ada' });
  quorum.postMessage({ room: 'ops', participantId: grace.id, body: '/smack tom wake up' });
  // /status is an executed room command (#52); its posted line is a plain
  // record and never a directed one.
  quorum.post({ room: 'ops', participantId: grace.id, body: '/status ada is slow today' });

  const forAda = await directed(quorum, ada.id);
  assert.deepEqual(
    forAda.map((event) => (event.payload.message as { body: string }).body),
    ['/smack ada'],
  );
  const forTom = await directed(quorum, tom.id);
  assert.deepEqual(
    forTom.map((event) => (event.payload.message as { body: string }).body),
    ['/smack tom wake up'],
  );
});

test('deliberation events address the frozen roster, and deadlines are theirs', async () => {
  const clock = withClock();
  const quorum = fresh(clock.now);
  const ada = agent(quorum, 'ada');
  const grace = agent(quorum, 'grace');
  quorum.createRoom({ name: 'protocol', by: ada.id });
  quorum.joinRoom({ room: 'protocol', participantId: grace.id });
  const opened = quorum.propose({
    participantId: ada.id,
    room: 'protocol',
    question: 'tabs or spaces',
    options: ['tabs', 'spaces'],
    challengeTtlSeconds: 60,
    voteTtlSeconds: 120,
  });
  // A later joiner observes: it is not on the roster, so nothing here is its call.
  const tom = agent(quorum, 'tom');
  quorum.joinRoom({ room: 'protocol', participantId: tom.id });

  assert.deepEqual((await directed(quorum, grace.id)).map((event) => event.kind), ['deliberation_opened']);
  assert.deepEqual(await directed(quorum, ada.id), [], 'the convener\'s own proposal is an echo, not a call');
  assert.deepEqual(await directed(quorum, tom.id), []);

  assert.deepEqual(quorum.deadlinesFor(grace.id), [
    { deliberationId: opened.id, roomId: opened.roomId, phase: 'challenging', endsAt: opened.phaseEndsAt, cast: false },
  ]);
  assert.deepEqual(quorum.deadlinesFor(tom.id), []);

  const graceCursor = quorum.latestSeq();
  quorum.closeChallenges({ participantId: ada.id, deliberationId: opened.id });
  const [voting] = quorum.deadlinesFor(grace.id);
  assert.equal(voting?.phase, 'voting');
  assert.equal(voting?.cast, false);
  // The call to vote is ada's act, so it addresses grace and not ada.
  assert.deepEqual((await directed(quorum, grace.id, graceCursor)).map((event) => event.kind), ['voting_opened']);
  assert.deepEqual(await directed(quorum, ada.id), []);

  quorum.vote({ participantId: grace.id, deliberationId: opened.id, choice: 0 });
  assert.equal(quorum.deadlinesFor(grace.id)[0]?.cast, true, 'a cast ballot is reported, never its choice');
  // And grace's ballot addresses ada: on the roster, not the author.
  assert.deepEqual((await directed(quorum, ada.id)).map((event) => event.kind), ['ballot_cast']);

  // Past its deadline, an open phase is no deadline at all.
  clock.advance(10 * 60_000);
  assert.deepEqual(quorum.deadlinesFor(ada.id), []);
});

test('the clock\'s events about your own lease are yours', async () => {
  const clock = withClock();
  const quorum = fresh(clock.now);
  const ada = agent(quorum, 'ada');
  const grace = agent(quorum, 'grace');
  quorum.claimScope({ participantId: ada.id, repo: 'quorum', patterns: ['src/**'], purpose: 'lanes', ttlSeconds: 60 });
  clock.advance(61_000);

  const forAda = await directed(quorum, ada.id);
  assert.deepEqual(forAda.map((event) => [event.kind, event.actorId]), [['claim_expired', null]]);
  assert.deepEqual(await directed(quorum, grace.id), [], 'someone else\'s lease expiring is ambient');
});

test('the limit stays honest across pages of ambient chatter', async () => {
  const quorum = fresh();
  const ada = agent(quorum, 'ada');
  const grace = agent(quorum, 'grace');
  quorum.createRoom({ name: 'busy', by: grace.id });
  quorum.joinRoom({ room: 'busy', participantId: ada.id });
  for (let i = 0; i < 150; i += 1) {
    quorum.postMessage({ room: 'busy', participantId: grace.id, body: `chatter ${i}` });
  }
  quorum.postMessage({ room: 'busy', participantId: grace.id, body: '@ada finally' });

  const events = await directed(quorum, ada.id);
  assert.equal(events.length, 1, 'the mention past the first page is found');
  assert.equal((events[0]!.payload.message as { body: string }).body, '@ada finally');
  const triage = quorum.triage({ viewerId: ada.id, afterSeq: 0, delivered: events });
  assert.ok(triage.passedOver.total >= 150);

  // The all lane skips nothing, so it passes over nothing.
  const all = await quorum.waitForEvents({ afterSeq: 0, timeoutMs: 0, participantId: ada.id });
  assert.equal(all.length, 100);
  assert.equal(quorum.triage({ viewerId: ada.id, afterSeq: 0, delivered: all }).passedOver.total, 0);
});

test('a directed wait sleeps through chatter and wakes for a DM', async () => {
  const quorum = fresh();
  const ada = agent(quorum, 'ada');
  const grace = agent(quorum, 'grace');
  quorum.createRoom({ name: 'late', by: grace.id });
  quorum.joinRoom({ room: 'late', participantId: ada.id });
  const cursor = quorum.latestSeq();

  const started = Date.now();
  const waiting = quorum.waitForEvents({ afterSeq: cursor, timeoutMs: 5_000, participantId: ada.id, lane: 'directed' });
  setTimeout(() => quorum.postMessage({ room: 'late', participantId: grace.id, body: 'nothing for ada' }), 20);
  setTimeout(() => quorum.sendDm({ participantId: grace.id, to: 'ada', body: 'now' }), 60);
  const events = await waiting;
  assert.ok(Date.now() - started < 4_000, 'the DM woke the wait; the chatter did not end it');
  assert.deepEqual(events.map((event) => event.kind), ['dm_message']);
});

test('an unknown lane is refused, and the rule engine never sees one', async () => {
  const quorum = fresh();
  const ada = agent(quorum, 'ada');
  await assert.rejects(
    quorum.waitForEvents({ afterSeq: 0, timeoutMs: 0, participantId: ada.id, lane: 'urgent' as 'all' }),
    (error: unknown) => error instanceof QuorumError && /lane/.test(error.message),
  );
});

test('cadence is declared on identify, kept across reconnects, and shown on the roster', () => {
  const quorum = fresh();
  const first = quorum.identify({ name: 'ada', harness: 'test', cadence: 'slow' }).participant;
  assert.equal(first.cadence, 'slow');

  const back = quorum.identify({ name: 'ada', harness: 'test' }).participant;
  assert.equal(back.cadence, 'slow', 'omitting it on a reconnect keeps the declaration');

  const changed = quorum.identify({ name: 'ada', harness: 'test', cadence: 'fast' }).participant;
  assert.equal(changed.cadence, 'fast');

  assert.throws(() => quorum.identify({ name: 'grace', harness: 'test', cadence: 'glacial' }), /cadence must be one of/);
  assert.equal(quorum.identify({ name: 'grace', harness: 'test' }).participant.cadence, null);

  assert.deepEqual(
    quorum.roster().map((person) => [person.name, person.cadence]),
    [
      ['ada', 'fast'],
      ['grace', null],
    ],
  );
});
