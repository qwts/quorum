// The deliberation protocol against docs/deliberation.md D1–D10 and
// requirements 1.1 #3–#6. Deadlines run on the injected clock — no test
// sleeps its way to a phase transition.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openQuorum, QuorumError } from '../src/domain/quorum.ts';

function withClock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

function agent(quorum: ReturnType<typeof openQuorum>, name: string) {
  return quorum.identify({ name, harness: 'test' }).participant;
}

// A room with its members and an open deliberation, ready to argue in.
function convened(
  quorum: ReturnType<typeof openQuorum>,
  names: string[],
  rule: 'majority' | 'unanimity' = 'majority',
) {
  const members = names.map((name) => agent(quorum, name));
  const room = quorum.createRoom({ name: `room-${names.join('-')}`, decisionRule: rule, by: members[0]!.id });
  for (const member of members.slice(1)) quorum.joinRoom({ room: room.id, participantId: member.id });
  const deliberation = quorum.propose({
    participantId: members[0]!.id,
    room: room.id,
    question: 'which way?',
    options: ['left', 'right'],
  });
  return { members, room, deliberation };
}

test('propose freezes the roster, opens challenging, and enforces membership and bounds', () => {
  const quorum = openQuorum();
  const [ada, grace] = [agent(quorum, 'ada'), agent(quorum, 'grace')];
  const room = quorum.createRoom({ name: 'protocol', by: ada.id });
  quorum.joinRoom({ room: room.id, participantId: grace.id });
  const outsider = agent(quorum, 'mallory');

  assert.throws(
    () => quorum.propose({ participantId: outsider.id, room: room.id, question: 'q', options: ['a', 'b'] }),
    /join "protocol" before proposing/,
  );
  assert.throws(
    () => quorum.propose({ participantId: ada.id, room: room.id, question: 'q', options: ['solo'] }),
    /at least two distinct options/,
  );
  assert.throws(
    () => quorum.propose({ participantId: ada.id, room: room.id, question: 'q', options: ['a', 'a'] }),
    /distinct/,
  );
  assert.throws(
    () =>
      quorum.propose({
        participantId: ada.id,
        room: room.id,
        question: 'q',
        options: Array.from({ length: 11 }, (_, i) => `option ${i}`),
      }),
    /at most 10 options/,
  );

  const deliberation = quorum.propose({
    participantId: ada.id,
    room: room.id,
    question: 'gate the schema behind a version field?',
    options: ['add it now', 'defer to v1'],
  });
  assert.equal(deliberation.phase, 'challenging');
  assert.ok(deliberation.phaseEndsAt !== null, 'the challenge window carries a deadline (D2)');
  assert.deepEqual(deliberation.eligible.sort(), [ada.id, grace.id].sort(), 'roster frozen at propose');

  // A later joiner observes; the frozen roster does not move (D3).
  const late = agent(quorum, 'late');
  quorum.joinRoom({ room: room.id, participantId: late.id });
  assert.deepEqual(quorum.getDeliberation({ deliberationId: deliberation.id }).eligible.length, 2);
});

test('challenges are tagged messages, allowed only in the challenge phase and only in the right room', () => {
  const quorum = openQuorum();
  const { members, room, deliberation } = convened(quorum, ['ada', 'grace']);
  const [ada, grace] = members;

  const challenge = quorum.postMessage({
    room: room.id,
    participantId: grace!.id,
    body: 'the state machine is about to freeze names on the wire',
    deliberationId: deliberation.id,
  });
  assert.equal(challenge.deliberationId, deliberation.id, 'the tag is the whole relationship (D4)');
  assert.equal(
    quorum.readMessages({ room: room.id }).find((m) => m.id === challenge.id)?.deliberationId,
    deliberation.id,
  );

  const elsewhere = quorum.createRoom({ name: 'elsewhere', by: ada!.id });
  assert.throws(
    () =>
      quorum.postMessage({ room: elsewhere.id, participantId: ada!.id, body: 'x', deliberationId: deliberation.id }),
    /own room/,
  );

  quorum.closeChallenges({ participantId: ada!.id, deliberationId: deliberation.id });
  assert.throws(
    () =>
      quorum.postMessage({ room: room.id, participantId: grace!.id, body: 'late', deliberationId: deliberation.id }),
    /phase 'voting'.*challenges are closed/,
  );
});

test('phase transitions are server-enforced and name the phase in refusals', () => {
  const quorum = openQuorum();
  const { members, deliberation } = convened(quorum, ['ada', 'grace']);
  const [ada, grace] = members;

  assert.throws(
    () => quorum.vote({ participantId: ada!.id, deliberationId: deliberation.id, choice: 0 }),
    /phase 'challenging'.*voting has not opened/,
  );
  assert.throws(
    () => quorum.closeChallenges({ participantId: grace!.id, deliberationId: deliberation.id }),
    /only the convener/,
  );

  quorum.closeChallenges({ participantId: ada!.id, deliberationId: deliberation.id });
  assert.throws(
    () => quorum.closeChallenges({ participantId: ada!.id, deliberationId: deliberation.id }),
    /no challenge window/,
  );
});

test('ballots are hidden while voting is open: events carry the actor, never the choice', () => {
  const quorum = openQuorum();
  const { members, deliberation } = convened(quorum, ['ada', 'grace', 'linus']);
  const [ada, grace] = members;
  quorum.closeChallenges({ participantId: ada!.id, deliberationId: deliberation.id });

  quorum.vote({ participantId: grace!.id, deliberationId: deliberation.id, choice: 1, dissent: 'reluctantly' });

  const view = quorum.getDeliberation({ deliberationId: deliberation.id });
  assert.deepEqual(view.cast, [grace!.id], 'who has cast is visible (D6)');
  assert.ok(!JSON.stringify(view).includes('"choice"'), 'the view never carries a choice');
  assert.ok(!JSON.stringify(view).includes('reluctantly'), 'nor dissent');

  const events = quorum.readEvents({ afterSeq: 0, limit: 500 });
  const cast = events.filter((event) => event.kind === 'ballot_cast');
  assert.equal(cast.length, 1);
  assert.equal(cast[0]!.actorId, grace!.id);
  assert.ok(!JSON.stringify(cast[0]!.payload).includes('"choice"'), 'ballot_cast announces, it does not reveal');

  // A re-cast before close replaces the ballot and is equally silent.
  quorum.vote({ participantId: grace!.id, deliberationId: deliberation.id, choice: 0 });
  assert.equal(quorum.getDeliberation({ deliberationId: deliberation.id }).cast.length, 1, 'upsert, not append');
});

test('full turnout closes voting early; the record reveals ballots and dissent verbatim', () => {
  const quorum = openQuorum();
  const { members, room, deliberation } = convened(quorum, ['ada', 'grace', 'linus']);
  const [ada, grace, linus] = members;
  quorum.postMessage({
    room: room.id,
    participantId: grace!.id,
    body: 'challenge for the record',
    deliberationId: deliberation.id,
  });
  quorum.closeChallenges({ participantId: ada!.id, deliberationId: deliberation.id });

  quorum.vote({ participantId: ada!.id, deliberationId: deliberation.id, choice: 0 });
  quorum.vote({ participantId: grace!.id, deliberationId: deliberation.id, choice: 0 });
  const last = quorum.vote({
    participantId: linus!.id,
    deliberationId: deliberation.id,
    choice: 1,
    dissent: 'Majority accepted. Recording that I expect this back before v1.',
  });
  assert.equal(last.deliberation.phase, 'converged', 'everyone spoke — the deadline has nothing to wait for (D7)');

  const record = quorum.getDecision({ deliberationId: deliberation.id });
  assert.equal(record.outcome, 'converged');
  assert.equal(record.chosen, 0);
  assert.deepEqual(record.tally, [2, 1]);
  assert.equal(
    record.ballots.find((b) => b.participantId === linus!.id)?.dissent,
    'Majority accepted. Recording that I expect this back before v1.',
    'dissent preserved verbatim (1.1 #4)',
  );
  assert.equal(record.challengeMessageIds.length, 1, 'the record cites its challenges by id (D4)');

  const close = quorum.readEvents({ afterSeq: 0, limit: 500 }).find((e) => e.kind === 'deliberation_converged');
  assert.equal(close?.actorId, linus!.id, 'the final voter is the actor of the close');
  assert.throws(
    () => quorum.vote({ participantId: ada!.id, deliberationId: deliberation.id, choice: 1 }),
    /voting has closed/,
  );
});

test('the challenge deadline opens voting by itself, and the wake deadline knows it', () => {
  const clock = withClock();
  const quorum = openQuorum({ now: clock.now });
  const { members, deliberation } = convened(quorum, ['ada', 'grace']);

  clock.advance(15 * 60 * 1000 + 1); // past the default challenge window
  const view = quorum.getDeliberation({ deliberationId: deliberation.id });
  assert.equal(view.phase, 'voting', 'the clock opened voting; nobody acted');

  const opened = quorum.readEvents({ afterSeq: 0, limit: 500 }).find((e) => e.kind === 'voting_opened');
  assert.ok(opened, 'the call to vote reached the feed (1.1 #8)');
  assert.equal(opened!.actorId, null, 'clock-authored: actor is null');
  assert.ok(view.phaseEndsAt! > clock.now(), 'the voting window starts when the transition lands, not when it was due');
  assert.ok(members.length > 0);
});

test('majority at the deadline: converged at partial turnout when the bar is met', () => {
  const clock = withClock();
  const quorum = openQuorum({ now: clock.now });
  const { members, deliberation } = convened(quorum, ['a', 'b', 'c', 'd', 'e', 'f']);
  quorum.closeChallenges({ participantId: members[0]!.id, deliberationId: deliberation.id });

  // 4 of 6 cast the same choice: absolute majority of the roster (D5).
  for (const voter of members.slice(0, 4)) {
    quorum.vote({ participantId: voter.id, deliberationId: deliberation.id, choice: 1 });
  }
  clock.advance(30 * 60 * 1000 + 1);
  const record = (quorum.listDecisions()[0] && quorum.getDecision({ deliberationId: deliberation.id }))!;
  assert.equal(record.outcome, 'converged');
  assert.equal(record.chosen, 1);
  assert.deepEqual(record.tally, [0, 4]);
});

test('quorum_absent when the absentees were decisive, naming them quoted', () => {
  const clock = withClock();
  const quorum = openQuorum({ now: clock.now });
  const { members, deliberation } = convened(quorum, ['a', 'b', 'c', 'd', 'e', 'f']);
  quorum.closeChallenges({ participantId: members[0]!.id, deliberationId: deliberation.id });

  // 2 of 6 agree; the 4 missing ballots could still have met the rule.
  quorum.vote({ participantId: members[0]!.id, deliberationId: deliberation.id, choice: 0 });
  quorum.vote({ participantId: members[1]!.id, deliberationId: deliberation.id, choice: 0 });
  clock.advance(30 * 60 * 1000 + 1);

  const record = quorum.getDecision({ deliberationId: deliberation.id });
  assert.equal(record.outcome, 'failed');
  assert.equal(record.failureKind, 'quorum_absent');
  for (const name of ['c', 'd', 'e', 'f']) {
    assert.ok(record.reason.includes(`"${name}"`), `non-voter ${name} named, quoted (D8)`);
  }
  const failed = quorum.readEvents({ afterSeq: 0, limit: 500 }).find((e) => e.kind === 'deliberation_failed');
  assert.equal(failed?.actorId, null, 'the deadline closed it; the clock is the actor');
});

test('rule_unmet when no completion could satisfy the rule — even with non-voters remaining', () => {
  const clock = withClock();
  const quorum = openQuorum({ now: clock.now });
  const members = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => agent(quorum, name));
  const room = quorum.createRoom({ name: 'split', by: members[0]!.id });
  for (const member of members.slice(1)) quorum.joinRoom({ room: room.id, participantId: member.id });
  const deliberation = quorum.propose({
    participantId: members[0]!.id,
    room: room.id,
    question: 'three ways?',
    options: ['x', 'y', 'z'],
  });
  quorum.closeChallenges({ participantId: members[0]!.id, deliberationId: deliberation.id });

  // 5 cast: 2/2/1 across three options. One voter never shows. The best any
  // option can reach is 3 of 6 — short of the absolute majority of 4.
  const choices = [0, 0, 1, 1, 2];
  choices.forEach((choice, i) => {
    quorum.vote({ participantId: members[i]!.id, deliberationId: deliberation.id, choice });
  });
  clock.advance(30 * 60 * 1000 + 1);

  const record = quorum.getDecision({ deliberationId: deliberation.id });
  assert.equal(record.failureKind, 'rule_unmet', 'dispersed beyond repair is not a turnout problem');
  assert.deepEqual(record.tally, [2, 2, 1]);
});

test('unanimity: a transient disagreement is not a failure — a re-cast before close converges (D6/D7)', () => {
  const quorum = openQuorum();
  const { members, deliberation } = convened(quorum, ['ada', 'grace', 'linus'], 'unanimity');
  const [ada, grace, linus] = members;
  quorum.closeChallenges({ participantId: ada!.id, deliberationId: deliberation.id });

  quorum.vote({ participantId: ada!.id, deliberationId: deliberation.id, choice: 0 });
  quorum.vote({ participantId: grace!.id, deliberationId: deliberation.id, choice: 1 });
  // Two distinct choices exist. Nothing closes: grace may still re-cast.
  assert.equal(quorum.getDeliberation({ deliberationId: deliberation.id }).phase, 'voting');

  quorum.vote({ participantId: grace!.id, deliberationId: deliberation.id, choice: 0 });
  const last = quorum.vote({ participantId: linus!.id, deliberationId: deliberation.id, choice: 0 });
  assert.equal(last.deliberation.phase, 'converged', 'the re-cast healed the split before close');
  assert.equal(quorum.getDecision({ deliberationId: deliberation.id }).chosen, 0);
});

test('unanimity at the deadline: a split fails rule_unmet; agreement short of turnout fails quorum_absent', () => {
  const clock = withClock();
  const quorum = openQuorum({ now: clock.now });

  const split = convened(quorum, ['s1', 's2', 's3'], 'unanimity');
  quorum.closeChallenges({ participantId: split.members[0]!.id, deliberationId: split.deliberation.id });
  quorum.vote({ participantId: split.members[0]!.id, deliberationId: split.deliberation.id, choice: 0 });
  quorum.vote({
    participantId: split.members[1]!.id,
    deliberationId: split.deliberation.id,
    choice: 1,
    dissent: 'a defaulted field ships the ambiguity it was meant to remove',
  });
  quorum.vote({ participantId: split.members[2]!.id, deliberationId: split.deliberation.id, choice: 0 });
  // Full turnout with a split closes at once — no completion of zero missing
  // ballots can repair it.
  const splitRecord = quorum.getDecision({ deliberationId: split.deliberation.id });
  assert.equal(splitRecord.failureKind, 'rule_unmet');
  assert.ok(splitRecord.ballots.some((b) => b.dissent?.includes('ambiguity')), 'dissent survives failure too');

  const short = convened(quorum, ['t1', 't2', 't3'], 'unanimity');
  quorum.closeChallenges({ participantId: short.members[0]!.id, deliberationId: short.deliberation.id });
  quorum.vote({ participantId: short.members[0]!.id, deliberationId: short.deliberation.id, choice: 0 });
  quorum.vote({ participantId: short.members[1]!.id, deliberationId: short.deliberation.id, choice: 0 });
  clock.advance(60 * 60 * 1000);
  const shortRecord = quorum.getDecision({ deliberationId: short.deliberation.id });
  assert.equal(shortRecord.failureKind, 'quorum_absent', 'the dead voter delayed, bounded, then was named');
  assert.ok(shortRecord.reason.includes('"t3"'));
});

test('only the frozen roster votes, choices are bounded, and dissent needs no permission', () => {
  const quorum = openQuorum();
  const { members, room, deliberation } = convened(quorum, ['ada', 'grace']);
  quorum.closeChallenges({ participantId: members[0]!.id, deliberationId: deliberation.id });

  const late = agent(quorum, 'late');
  quorum.joinRoom({ room: room.id, participantId: late.id });
  assert.throws(
    () => quorum.vote({ participantId: late.id, deliberationId: deliberation.id, choice: 0 }),
    /later joiners observe/,
  );
  assert.throws(
    () => quorum.vote({ participantId: members[0]!.id, deliberationId: deliberation.id, choice: 5 }),
    /option index/,
  );
});

test('decision records are immutable, queryable, and survive a restart (1.1 #6, #10)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quorum-deliberation-'));
  try {
    const path = join(dir, 'quorum.db');
    let deliberationId: string;
    {
      const quorum = openQuorum({ path });
      const { members, deliberation } = convened(quorum, ['ada', 'grace']);
      deliberationId = deliberation.id;
      quorum.closeChallenges({ participantId: members[0]!.id, deliberationId: deliberation.id });
      quorum.vote({ participantId: members[0]!.id, deliberationId: deliberation.id, choice: 0 });
      quorum.vote({ participantId: members[1]!.id, deliberationId: deliberation.id, choice: 0 });
      quorum.close();
    }
    const reopened = openQuorum({ path });
    const record = reopened.getDecision({ deliberationId });
    assert.equal(record.outcome, 'converged');
    assert.equal(reopened.listDecisions().length, 1);
    assert.equal(reopened.listDecisions()[0]?.question, 'which way?');
    assert.throws(() => reopened.getDecision({ deliberationId: 'nope' }), QuorumError);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
