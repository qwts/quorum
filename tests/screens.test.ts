// The #20 screens' pure parts: the overlay's derivations and ruled copy, the
// DM screen's fold, the connect screen's commands, and the castBy tracking the
// overlay's ballots-in list stands on. All DOM-free — which is the reason the
// screens split their models out in the first place.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ballotHint, countdown, phaseNote, quorumOf, turnoutNote } from '../src/ui/kit/app/overlay-model.js';
import { paintRoom } from '../src/ui/kit/app/api.js';
import { commandsFor } from '../src/ui/kit/app/connect-model.js';
import { applyDm, emptyDm } from '../src/ui/kit/app/dm-model.js';
import { apply, emptyState, seed } from '../src/ui/kit/app/store.js';

test('quorum is derived from the rule and the frozen roster (D5)', () => {
  assert.equal(quorumOf('majority', 6), 4);
  assert.equal(quorumOf('majority', 5), 3);
  assert.equal(quorumOf('majority', 2), 2);
  assert.equal(quorumOf('unanimity', 6), 6, 'unanimity needs everyone');
});

test('the countdown counts to the deadline and stops at zero', () => {
  assert.equal(countdown(90_000, 0), '01:30');
  assert.equal(countdown(1_000, 400), '00:01', 'ceil, so a live phase never reads 00:00');
  assert.equal(countdown(0, 5_000), '00:00', 'past the deadline it reads zero — the server closes the phase, not the page');
});

test('the overlay copy carries the Q6 ruling: re-cast until the phase closes, the last ballot counts', () => {
  // The exact spot Q6 was about — the sentence under a ballot. If either line
  // stops saying re-casting is allowed, this test is what says so out loud.
  assert.match(ballotHint('voting', true), /re-cast until the phase closes — the last ballot counts/);
  assert.match(ballotHint('voting', false), /re-cast allowed until the phase closes/);
  assert.equal(ballotHint('challenging', false), 'ballots open when the window closes');
  assert.doesNotMatch(ballotHint('voting', true), /no changes after cast/, 'the pre-ruling copy must never return');

  assert.match(phaseNote('voting', 4, 6), /re-cast until then — the last ballot counts/);
  assert.match(phaseNote('voting', 4, 6), /converges at 4 of 6 eligible/);
  assert.match(phaseNote('challenging', 4, 6), /Challenges argue considerations/);
  assert.match(phaseNote('failed', 4, 6), /never a reopened one/);

  assert.equal(turnoutNote('challenging', 0, 4, 6), 'that a ballot exists is public; what it says is not');
  assert.match(turnoutNote('voting', 2, 4, 6), /4 of 6 eligible · 4 yet to cast/);
  assert.match(turnoutNote('voting', 6, 4, 6), /full turnout/);
});

test('the fold tracks who has cast — never what they chose', () => {
  const event = (seq: number, kind: string, actorId: string, payload: unknown) => ({
    seq, kind, roomId: 'r1', actorId, payload, createdAt: 0,
  });
  const deliberation = {
    id: 'd1', roomId: 'r1', convenerId: 'p1',
    question: 'ship it?', options: ['now', 'later'],
    eligible: ['p1', 'p2'], phase: 'voting', phaseEndsAt: 9_000,
  };
  let state = seed(emptyState(), { seq: 10, rooms: [], participants: [], claims: [] });
  state = apply(state, event(11, 'deliberation_opened', 'p1', { deliberationId: 'd1', deliberation, by: 'ada' }));
  assert.deepEqual(state.deliberations.get('d1').castBy, []);

  state = apply(state, event(12, 'ballot_cast', 'p2', { deliberationId: 'd1', by: 'grace', cast: 1, eligible: 2 }));
  assert.deepEqual(state.deliberations.get('d1').castBy, ['p2'], 'the actor is public (D6); the choice is nowhere');

  // A re-cast is the same voter again: the count moves, the set does not grow.
  state = apply(state, event(13, 'ballot_cast', 'p2', { deliberationId: 'd1', by: 'grace', cast: 1, eligible: 2 }));
  assert.deepEqual(state.deliberations.get('d1').castBy, ['p2']);
  assert.ok(!JSON.stringify(state.deliberations.get('d1')).includes('"choice"'), 'nothing in the fold is a ballot');
});

test('a paint seeds castBy from the D6-public cast list (#35 + #20)', () => {
  const view = {
    id: 'd1', roomId: 'r1', convenerId: 'p1', question: 'q?', options: ['a', 'b'],
    eligible: ['p1', 'p2'], phase: 'voting', phaseEndsAt: 9_000, rule: 'majority', cast: ['p2'],
  };
  const state = seed(emptyState(), { seq: 10, deliberations: [view] });
  const folded = state.deliberations.get('d1');
  assert.equal(folded.cast, 1, 'turnout as a count');
  assert.deepEqual(folded.castBy, ['p2'], 'and who, so the ballots-in list can mark them');
});

test('the DM fold lands a message in the inbox always, in the conversation when it matches', () => {
  const event = (id: number, participants: [string, string], from: string) => ({
    kind: 'dm_message',
    payload: {
      message: { id, threadId: `t-${participants.join('')}`, participantId: from, body: `m${id}`, createdAt: id },
      thread: { id: `t-${participants.join('')}`, participants, createdAt: 0 },
    },
  });

  // A DM from the open counterpart lands in both.
  let model = applyDm(emptyDm(), event(1, ['me', 'ada'], 'ada'), 'me', 'ada');
  assert.equal(model.threads.length, 1);
  assert.equal(model.threads[0].counterpartId, 'ada');
  assert.deepEqual(model.messages.map((m: any) => m.id), [1]);

  // Replay changes nothing.
  model = applyDm(model, event(1, ['me', 'ada'], 'ada'), 'me', 'ada');
  assert.deepEqual(model.messages.map((m: any) => m.id), [1]);

  // A DM from someone else updates the inbox, not the open conversation —
  // and the newest-spoken thread moves to the top.
  model = applyDm(model, event(2, ['grace', 'me'], 'grace'), 'me', 'ada');
  assert.deepEqual(model.threads.map((t: any) => t.counterpartId), ['grace', 'ada']);
  assert.deepEqual(model.messages.map((m: any) => m.id), [1], 'the open thread is still the ada one');

  // Anything that is not a dm_message is not this fold's business.
  assert.equal(applyDm(model, { kind: 'message', payload: {} }, 'me', 'ada'), model);
});

test('the connect commands point at this server, not at the mock port', () => {
  const commands = commandsFor('http://127.0.0.1:5151');
  assert.equal(commands['claude-code'], 'claude mcp add --transport http quorum http://127.0.0.1:5151/mcp');
  assert.match(String(commands.codex), /codex mcp add quorum --url http:\/\/127\.0\.0\.1:5151\/mcp/);
  assert.match(String(commands.other), /streamable-HTTP endpoint\nhttp:\/\/127\.0\.0\.1:5151\/mcp/);
});

test('the front door paints a room that does not exist yet as empty, not as a failure (#48)', async (t) => {
  // Nothing seeds rooms — an agent creates one with create_room — so on a
  // fresh install the default room's scoped reads 404. That must paint as an
  // empty room with the sidebar and feed intact, not a dead page telling the
  // person to check a server that is running fine.
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const answered = new Map<string, unknown>([
    ['/api/rooms', { seq: 7, rooms: [] }],
    ['/api/participants', { seq: 7, participants: [] }],
    ['/api/claims', { seq: 7, claims: [] }],
  ]);
  const serving = (missing: { status: number; error: string }) =>
    (async (path: string) => {
      const hit = answered.get(path);
      if (hit) return { ok: true, json: async () => hit };
      return { ok: false, status: missing.status, json: async () => ({ error: missing.error }) };
    }) as unknown as typeof fetch;

  globalThis.fetch = serving({ status: 404, error: 'no such room: protocol' });
  const painted = await paintRoom('protocol');
  assert.equal(painted.seq, 7, 'the stream opens at the stamp of the reads that answered');
  assert.deepEqual(painted.messages, []);
  assert.deepEqual(painted.deliberations, []);

  // Only "not found" is an answer. Anything else is still fatal.
  globalThis.fetch = serving({ status: 500, error: 'boom' });
  await assert.rejects(() => paintRoom('protocol'), /boom/);
});
