// The room view's model and its strings, in Node with no browser.
//
// This is why `store.js` and `format.js` are pure and why the composition root
// is thin: the rules worth testing are all in here, and none of them needs a
// DOM. What is left in `room.js` is wiring, which a screenshot checks better
// than an assertion would.

import test from 'node:test';
import assert from 'node:assert/strict';

import { apply, applyAll, emptyState, liveClaims, messagesIn, liveDeliberations, roomByName, seed } from '../src/ui/kit/app/store.js';
import { clock, count, remaining, scopeOf } from '../src/ui/kit/app/format.js';
import { ensureIdentified, isStaleIdentity } from '../src/ui/kit/app/me.js';
import { createSender } from '../src/ui/kit/app/posting.js';
import { composerProps } from '../src/ui/kit/app/composer.js';
import { recordProps } from '../src/ui/kit/app/record.js';
import { isFresher, withRoomNames } from '../src/ui/kit/app/history.js';

const ROOM = { id: 'r1', name: 'protocol', topic: 'the wire contract', decisionRule: 'majority', members: 2 };
const CODEX = { id: 'p1', name: 'codex:api', harness: 'codex', repo: null, branch: null };
const DANA = { id: 'p2', name: 'Dana', harness: 'human', repo: null, branch: null };

const event = (seq: number, kind: string, payload: unknown, roomId: string | null = null) => ({
  seq,
  kind,
  roomId,
  actorId: null,
  payload,
  createdAt: 0,
});

function painted() {
  return seed(emptyState(), {
    seq: 10,
    rooms: [ROOM],
    participants: [CODEX, DANA],
    claims: [],
    messages: [{ id: 1, roomId: 'r1', participantId: 'p1', body: 'first', deliberationId: null, createdAt: 0 }],
  });
}

test('the model is a fold over the feed, and folding is idempotent', () => {
  const state = painted();
  assert.equal(state.seq, 10);
  assert.equal(messagesIn(state, 'r1').length, 1);

  const message = { id: 2, roomId: 'r1', participantId: 'p2', body: 'second', deliberationId: null, createdAt: 0 };
  const once = apply(state, event(11, 'message', { message, from: 'Dana' }, 'r1'));
  assert.equal(messagesIn(once, 'r1').length, 2);

  // The API stamps its seq *before* its read, so an event that landed in
  // between arrives twice on purpose. Replay must therefore change nothing,
  // or that trade would be paid for in duplicate rows on screen.
  const twice = apply(once, event(11, 'message', { message, from: 'Dana' }, 'r1'));
  assert.equal(messagesIn(twice, 'r1').length, 2);
  assert.equal(twice, once, 'a stale event returns the same state, so a renderer can skip on identity');
});

test('an event kind the page has not learned advances the cursor and changes nothing', () => {
  // A server that grows an event must not break a page running older code —
  // the page is served from the same process, but a browser tab open across a
  // restart is exactly that situation.
  const state = painted();
  const next = apply(state, event(11, 'some_future_event', { whatever: true }));
  assert.equal(next.seq, 11, 'the page has seen it; it just had nothing to do about it');
  assert.deepEqual(messagesIn(next, 'r1'), messagesIn(state, 'r1'));
  assert.equal(next.rooms, state.rooms, 'untouched maps are not copied');
});

test('folding never mutates what the caller was holding', () => {
  const before = painted();
  const rooms = before.rooms;
  const after = applyAll(before, [
    event(11, 'room_joined', { room: ROOM, participant: DANA }),
    event(12, 'claim_granted', {
      claim: { id: 'c1', participantId: 'p1', repo: 'quorum', branch: 'main', patterns: ['src/mcp/**'], purpose: 'schema pass', expiresAt: 5_000 },
    }),
  ]);

  assert.equal(before.rooms, rooms, 'the previous state is still the previous state');
  assert.equal(before.claims.size, 0);
  assert.equal(after.claims.size, 1);
  assert.equal(after.rooms.get('r1')!.members, 3);
});

test('a released or expired claim leaves the roster', () => {
  const claim = { id: 'c1', participantId: 'p1', repo: 'quorum', patterns: ['src/**'], purpose: 'x', expiresAt: 5_000 };
  const held = apply(painted(), event(11, 'claim_granted', { claim }));
  assert.equal(liveClaims(held, 0).length, 1);

  assert.equal(liveClaims(apply(held, event(12, 'claim_released', { claim })), 0).length, 0);
  assert.equal(liveClaims(apply(held, event(12, 'claim_expired', { claim })), 0).length, 0);

  // Expiry is a clock fact, not only an event: a lease whose time has passed
  // is gone whether or not the sweep has run yet.
  assert.equal(liveClaims(held, 6_000).length, 0);
});

test('claims sort by who frees up first', () => {
  const at = (id: string, expiresAt: number) => ({ id, participantId: 'p1', repo: 'q', patterns: [], purpose: '', expiresAt });
  const state = applyAll(painted(), [
    event(11, 'claim_granted', { claim: at('late', 9_000) }),
    event(12, 'claim_granted', { claim: at('soon', 2_000) }),
  ]);
  assert.deepEqual(
    liveClaims(state, 0).map((c) => c.id),
    ['soon', 'late'],
    'whoever is waiting on a scope reads the one about to free up first',
  );
});

test('rooms are found by the name a human types, not the id', () => {
  assert.equal(roomByName(painted(), 'protocol')?.id, 'r1');
  assert.equal(roomByName(painted(), 'nope'), undefined);
});

test('numbers are exact, because rounding them together hides the difference', () => {
  assert.equal(remaining(90_000, 0), '1m left');
  // Under a minute is exactly when a waiting agent needs the real number.
  assert.equal(remaining(45_000, 0), '45s left');
  assert.equal(remaining(0, 1), 'expired');

  assert.equal(count(1, 'participant'), '1 participant');
  assert.equal(count(0, 'participant'), '0 participants');

  assert.equal(scopeOf({ repo: 'quorum', branch: 'main', patterns: ['src/mcp/**'] }), 'quorum@main src/mcp/**');
  assert.equal(scopeOf({ repo: 'quorum', patterns: [] }), 'quorum the whole repository');

  const noon = new Date(2026, 6, 25, 9, 5).getTime();
  assert.equal(clock(noon), '09:05', 'zero-padded, so a column of times lines up');
});

test('a repaint that lands behind the feed does not swallow what arrived meanwhile', () => {
  // The room-switch race, as a unit. A paint snapshots at seq S and lands
  // milliseconds later; an event arriving in that window has a seq above S.
  // If the snapshot kept the higher cursor, its effect would be discarded by
  // the seed *and* its replay rejected as already-seen — the message would
  // vanish permanently, and only for whoever switched rooms at the wrong
  // moment. So `seed` moves the cursor back to the snapshot, and the caller
  // drains what it held across the paint.
  const live = apply(painted(), event(11, 'message', {
    message: { id: 2, roomId: 'r1', participantId: 'p2', body: 'arrived first', deliberationId: null, createdAt: 0 },
  }, 'r1'));
  assert.equal(live.seq, 11);

  const heldBack = { id: 3, roomId: 'r1', participantId: 'p1', body: 'arrived during the repaint', deliberationId: null, createdAt: 0 };

  // The snapshot was stamped at 10, before either message.
  const reseeded = seed(live, {
    seq: 10,
    rooms: [ROOM],
    participants: [CODEX, DANA],
    claims: [],
    messages: [{ id: 1, roomId: 'r1', participantId: 'p1', body: 'first', deliberationId: null, createdAt: 0 }],
  });
  assert.equal(reseeded.seq, 10, 'the cursor follows the data back, or the buffer cannot drain');

  const drained = applyAll(reseeded, [
    event(11, 'message', { message: { id: 2, roomId: 'r1', participantId: 'p2', body: 'arrived first', deliberationId: null, createdAt: 0 } }, 'r1'),
    event(12, 'message', { message: heldBack }, 'r1'),
  ]);
  assert.deepEqual(
    messagesIn(drained, 'r1').map((m: any) => m.body),
    ['first', 'arrived first', 'arrived during the repaint'],
    'nothing was lost across the repaint, and nothing was duplicated',
  );
});

test('declining to be named is an answer, not a failure', async () => {
  // v0 has no accounts: naming yourself is a claim, the same one `identify`
  // makes for an agent. So a cancelled prompt must not look like an error, and
  // must not create a participant called "" or "null".
  const calls: string[] = [];
  const identify = async (name: string) => {
    calls.push(name);
    return { participant: { id: 'p9', name } };
  };

  assert.equal(await ensureIdentified({ ask: () => null, identify }), null, 'cancelled');
  assert.equal(await ensureIdentified({ ask: () => '   ', identify }), null, 'whitespace is not a name');
  assert.deepEqual(calls, [], 'nothing was created for someone who declined');

  assert.deepEqual(await ensureIdentified({ ask: () => '  Rowan  ', identify }), { id: 'p9', name: 'Rowan' });
  assert.deepEqual(calls, ['Rowan'], 'the name is trimmed before it becomes an identity');
});

test('a disabled composer always says why, and a notice is not an error banner', () => {
  const closed = composerProps(null, null, null);
  assert.equal(closed.disabled, true);
  assert.ok(String(closed.disabledReason).length > 0, 'never quiet without a reason');
  assert.match(String(closed.disabledReason), /room/i, 'and the reason names the next action');

  const room = { id: 'r1', name: 'protocol' };
  const anonymous = composerProps(room, null, null);
  assert.equal(anonymous.disabled, false);
  assert.equal(anonymous.placeholder, 'Message #protocol', 'the placeholder names the destination');
  assert.match(String(anonymous.hint), /asked for a name/, 'says what send will actually do first');

  // Named: the hint goes back to the component's own keyboard default.
  assert.equal(composerProps(room, { id: 'p1', name: 'Rowan' }, null).hint, null);

  // A refusal rides as `notice` — a private row, not a banner, because the
  // server returned it to this person and it is not a room event.
  const refused = composerProps(room, null, 'join "protocol" before posting to it');
  assert.match(String(refused.notice), /before posting/);
  assert.equal(refused.disabled, false, 'a refusal does not lock the field you need to retry from');
});

/** A sender wired to spies, with every port overridable. */
function harness(overrides: Record<string, any> = {}) {
  const calls: { joined: string[]; posted: [string, string][]; identified: number; forgot: number } = {
    joined: [], posted: [], identified: 0, forgot: 0,
  };
  const box = { room: 'protocol', me: { id: 'p1', name: 'Rowan' } as any, draft: '', notice: null as any, settled: 0 };
  const send = createSender({
    room: () => box.room,
    me: () => box.me,
    setMe: (who: any) => { box.me = who; },
    draft: () => box.draft,
    setDraft: (v: string) => { box.draft = v; },
    setNotice: (m: any) => { box.notice = m; },
    settled: () => { box.settled += 1; },
    identify: async () => { calls.identified += 1; return { id: 'p2', name: 'Rowan' }; },
    join: async (room: string) => { calls.joined.push(room); },
    post: async (room: string, _id: string, body: string) => { calls.posted.push([room, body]); },
    isStaleIdentity,
    forget: () => { calls.forgot += 1; },
    ...overrides,
  });
  return { send, calls, box };
}

test('the room is fixed when you press send, not when the request lands', async () => {
  // Switching rooms mid-send would otherwise join one room and post to
  // another — and if you were already a member of the second, the message
  // lands in the wrong room with nothing on screen to say so.
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const h = harness({ join: async (room: string) => { await gate; h.calls.joined.push(room); } });

  h.box.draft = 'about the wire contract';
  const inFlight = h.send('about the wire contract');
  h.box.room = 'web-ui';           // the person clicks another room
  release();
  await inFlight;

  assert.deepEqual(h.calls.joined, ['protocol']);
  assert.deepEqual(h.calls.posted, [['protocol', 'about the wire contract']]);
});

test('a second Enter while the first is in flight does not post twice', async () => {
  // Joining is idempotent; posting is not. A duplicate here is two permanent
  // messages in the record.
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const h = harness({ post: async (room: string, _id: string, body: string) => { await gate; h.calls.posted.push([room, body]); } });

  const first = h.send('once');
  const second = h.send('once');
  release();
  await Promise.all([first, second]);

  assert.equal(h.calls.posted.length, 1, 'the second submission was refused, not queued');
});

test('a draft typed while the post was in flight is not swallowed', async () => {
  // The field stays editable on purpose, so a failed post keeps your words —
  // which means the next draft may already exist by the time this succeeds.
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const h = harness({ post: async () => { await gate; } });

  h.box.draft = 'first';
  const inFlight = h.send('first');
  h.box.draft = 'first and a second thought';   // typed while pending
  release();
  await inFlight;

  assert.equal(h.box.draft, 'first and a second thought', 'only the submitted text may be cleared');

  // The ordinary case still clears.
  h.box.draft = 'plain';
  await h.send('plain');
  assert.equal(h.box.draft, '');
});

test('an identity the server has forgotten is replaced, once', async () => {
  // Point the server at a different or recreated database and this browser
  // still holds a UUID that names nobody. Without this the same failure
  // repeats forever and the only fix is clearing site data by hand.
  let attempts = 0;
  const h = harness({
    join: async (room: string) => {
      attempts += 1;
      if (attempts === 1) throw new Error('unknown participant: "p1" — call identify first');
      h.calls.joined.push(room);
    },
  });

  await h.send('after a database reset');

  assert.equal(h.calls.forgot, 1, 'the dead id was discarded');
  assert.equal(h.calls.identified, 1, 'and a new one asked for');
  assert.deepEqual(h.calls.posted, [['protocol', 'after a database reset']]);
  assert.equal(h.box.notice, null, 'recovery is silent — it was not the person\'s mistake');
});

test('a refusal that is not about identity is shown, not retried', async () => {
  const h = harness({ join: async () => { throw new Error('join "protocol" before posting to it'); } });
  await h.send('nope');

  assert.equal(h.calls.identified, 0, 'no identity churn for an unrelated refusal');
  assert.match(String(h.box.notice), /before posting/, 'the server said it better than we would');
  assert.equal(h.box.draft, '', 'nothing was submitted, so nothing was cleared');
  assert.equal(h.box.settled, 1, 'the field is released exactly once, whatever happened');
});

const DELIBERATION = {
  id: 'd1', roomId: 'r1', convenerId: 'p1',
  question: 'Do we gate the tool schema behind a version field?',
  options: ['Add it now', 'Defer to v1'],
  eligible: ['p1', 'p2'], phase: 'challenging', phaseEndsAt: 5_000,
};

test('a deliberation is folded from its events, and its ballots stay secret', () => {
  // The feed carries who voted and how many have — never what they chose. The
  // concealment is a property of the event, not of the screen: a page cannot
  // leak a ballot it was never sent (deliberation.md §6).
  let state = apply(painted(), event(11, 'deliberation_opened', {
    deliberationId: 'd1', deliberation: DELIBERATION, by: 'codex:api',
  }, 'r1'));
  assert.equal(liveDeliberations(state, 'r1')[0]?.question, DELIBERATION.question);

  state = apply(state, event(12, 'voting_opened', { deliberationId: 'd1', phaseEndsAt: 9_000 }, 'r1'));
  assert.equal(liveDeliberations(state, 'r1')[0]?.phase, 'voting');

  state = apply(state, event(13, 'ballot_cast', { deliberationId: 'd1', by: 'Dana', cast: 1, eligible: 2 }, 'r1'));
  const live = liveDeliberations(state, 'r1')[0];

  // The options are public — you cannot vote for a choice you cannot read.
  assert.deepEqual(live?.options, ['Add it now', 'Defer to v1']);
  // How many have voted is public, because turnout is what closes the phase.
  assert.equal(live?.cast, 1);
  // The frozen roster survives the fold as ids — the ballot_cast event's
  // eligible count never downgrades it, or the overlay's quorum and
  // ballots-in list would lose their denominators (#20).
  assert.deepEqual(live?.eligible, ['p1', 'p2']);

  // What must not exist is a mapping from a voter to a choice. The event does
  // not carry one, so the model cannot hold one however it folds — the
  // concealment is a property of the feed, not a discipline of the screen.
  assert.equal(
    Object.values(live ?? {}).some((value) => typeof value === 'object' && value !== null && !Array.isArray(value)),
    false,
    'nothing in a live deliberation is a per-voter record',
  );
});

test('a closed deliberation stops being the room\'s current business', () => {
  // The record is kept — that is the point — but a converged decision must not
  // sit at the top of the stream forever asking to be voted on.
  const opened = apply(painted(), event(11, 'deliberation_opened', {
    deliberationId: 'd1', deliberation: DELIBERATION, by: 'codex:api',
  }, 'r1'));

  for (const [kind, payload] of [
    ['deliberation_converged', { deliberationId: 'd1', chosen: 'Add it now' }],
    ['deliberation_failed', { deliberationId: 'd1', failureKind: 'quorum_absent' }],
  ] as const) {
    const closed = apply(opened, event(12, kind, payload, 'r1'));
    assert.deepEqual(liveDeliberations(closed, 'r1'), [], `${kind} is no longer open`);
    assert.equal(closed.deliberations.size, 1, 'but it is still on the record');
  }
});

test('a paint carries the room\'s open deliberation, and the feed takes over from it (#35)', () => {
  // The bug this guards: a page loaded mid-deliberation folded from events
  // alone, so the live proposal was invisible until the next event on it —
  // and the phase could close without the late arrival ever seeing a ballot.
  const state = seed(painted(), {
    seq: 12,
    deliberations: [{ ...DELIBERATION, phase: 'voting', rule: 'majority', cast: ['p2'] }],
  });

  const [live] = liveDeliberations(state, 'r1');
  assert.equal(live.id, 'd1');
  assert.equal(live.phase, 'voting');
  assert.deepEqual(live.options, DELIBERATION.options, 'the ballot is castable from the paint alone');
  assert.equal(live.cast, 1, 'the model keeps turnout as a count, matching what ballot_cast will say');

  // The fold continues from the seeded entry — the paint seeds, the feed owns
  // every change after.
  const voted = apply(state, event(13, 'ballot_cast', { deliberationId: 'd1', by: 'codex:api', cast: 2, eligible: 2 }, 'r1'));
  assert.equal(voted.deliberations.get('d1').cast, 2);
  const closed = apply(voted, event(14, 'deliberation_converged', { deliberationId: 'd1', chosen: 0 }, 'r1'));
  assert.deepEqual(liveDeliberations(closed, 'r1'), [], 'and it can close a deliberation it painted');
});

test('an event for a deliberation we never saw changes nothing', () => {
  // A page opened mid-deliberation seeds from the paint — but an event can
  // still name a deliberation this fold has never held (a room switched away
  // from, a paint that failed). Half-creating from a later event would draw a
  // card with a phase and no question, which is worse than drawing nothing.
  const state = painted();
  const orphan = apply(state, event(11, 'ballot_cast', { deliberationId: 'ghost', by: 'Dana', cast: 1, eligible: 2 }, 'r1'));
  assert.equal(orphan.deliberations.size, 0);
  assert.equal(orphan.seq, 11, 'the cursor still advances — it has been seen, it just did nothing');
});

test('a room running two proposals shows both, soonest deadline first', () => {
  // The domain permits it — `propose` refuses a non-member and a bad question,
  // not a second live deliberation. Returning only the first would hide the
  // second completely, and keep hiding it past its own deadline, so a ballot
  // could become impossible to cast with nothing ever saying why.
  const second = { ...DELIBERATION, id: 'd2', question: 'Do we ship presence first?', phaseEndsAt: 2_000 };
  const state = applyAll(painted(), [
    event(11, 'deliberation_opened', { deliberationId: 'd1', deliberation: DELIBERATION, by: 'codex:api' }, 'r1'),
    event(12, 'deliberation_opened', { deliberationId: 'd2', deliberation: second, by: 'codex:api' }, 'r1'),
  ]);

  assert.deepEqual(
    liveDeliberations(state, 'r1').map((d: any) => d.id),
    ['d2', 'd1'],
    'whoever is deciding meets the one that closes first',
  );

  // Closing one leaves the other alone.
  const closed = apply(state, event(13, 'deliberation_converged', { deliberationId: 'd2', chosen: 'x' }, 'r1'));
  assert.deepEqual(liveDeliberations(closed, 'r1').map((d: any) => d.id), ['d1']);
});

const RECORD = {
  deliberationId: 'd-abcdef12', question: 'Do we gate the tool schema behind a version field?',
  outcome: 'converged', chosen: 0, failureKind: null, reason: 'Carried 2 of 3 cast.',
  closedAt: 0, rule: 'majority', options: ['Add it now', 'Defer to v1'], tally: [2, 1],
  eligible: [{ id: 'p1', name: 'codex:api' }, { id: 'p2', name: 'Dana' }, { id: 'p3', name: 'devin:tests' }, { id: 'p4', name: 'cursor:web-ui' }],
  ballots: [
    { participantId: 'p1', name: 'codex:api', choice: 0, dissent: null },
    { participantId: 'p2', name: 'Dana', choice: 0, dissent: null },
    { participantId: 'p3', name: 'devin:tests', choice: 1, dissent: 'The field defaults on, which ships the risk the challenge was about.' },
  ],
};

test('a record names who never cast, not just how many did', () => {
  // "3 of 4 ballots" is a number. Who the fourth was is the record — and it is
  // the part that says whether the room decided or whoever happened to be awake.
  const props = recordProps(RECORD, RECORD);
  assert.deepEqual(props.silent, ['cursor:web-ui']);
  assert.equal(props.outcome, 'Add it now', 'the winner is named, not its index');
  assert.equal(props.variant, 'full');

  // Every option appears, including ones nobody chose — a tally listing only
  // winners is an advert rather than a record.
  assert.deepEqual(props.options.map((o: any) => [o.option, o.count]), [['Add it now', 2], ['Defer to v1', 1]]);
  assert.deepEqual(props.options[0]?.voters, ['codex:api', 'Dana']);

  assert.deepEqual(props.dissents, [{ name: 'devin:tests', note: RECORD.ballots[2]?.dissent }]);
});

test('an unopened record shows a summary and claims no tally', () => {
  // The list carries summaries; ballots and silent participants are fetched
  // only when someone opens one. Guessing at them from a summary would put
  // names on screen that the response never contained.
  const props = recordProps({ deliberationId: 'd-99', question: 'q?', outcome: 'failed', failureKind: 'quorum_absent', reason: 'r', closedAt: 0 });
  assert.equal(props.variant, 'summary');
  assert.deepEqual(props.options, []);
  assert.deepEqual(props.silent, []);
  assert.deepEqual(props.dissents, []);
  assert.equal(props.outcome, null, 'a failure chose nothing, and says so rather than nothing');
  assert.equal(props.failureKind, 'quorum_absent');
});

test('a record in the all-rooms view says which room decided it', () => {
  // The list endpoint carries roomId and no name. Two rooms asking similar
  // questions is not hypothetical with a fleet of agents on one codebase, and
  // a record you cannot place is a record you cannot cite.
  const named = withRoomNames(
    [{ deliberationId: 'd1', roomId: 'r1' }, { deliberationId: 'd2', roomId: 'r2' }],
    [{ id: 'r1', name: 'protocol' }, { id: 'r2', name: 'web-ui' }],
  );
  assert.deepEqual(named.map((d: any) => d.room), ['protocol', 'web-ui']);

  // A room the reader cannot see leaves the field unset rather than printing a
  // UUID — an id on a record reads as part of the record.
  const orphan = withRoomNames([{ deliberationId: 'd3', roomId: 'gone' }], []);
  assert.equal(orphan[0]?.room, undefined);
});

test('an older refresh cannot replace a newer history', () => {
  // Two deliberations closing together start two independent reads. If the
  // later one answers first and the earlier answers second, applying blindly
  // deletes the freshest record until something else closes or the page
  // reloads. Every response is stamped before its read, so the stamps order
  // them even when the network does not.
  assert.equal(isFresher(12, 10), true, 'a newer snapshot lands');
  assert.equal(isFresher(10, 12), false, 'a straggler is dropped');
  assert.equal(isFresher(12, 12), true, 'an equal stamp is the same history, so either is fine');
  assert.equal(isFresher(0, -1), true, 'the first paint always lands');
  assert.equal(isFresher(undefined as any, 5), false, 'a response with no stamp cannot be ordered, so it is not trusted');
});
