// Lifecycle verbs (#80): a room can be left, renamed, and retopiced; a
// status can be cleared. Each is one mutation and one event on the feed —
// requirement 4: nothing changes silently. The refusals are the interim
// ownership rule (#82 replaces it) and the invariants the audit found
// settled elsewhere.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openQuorum } from '../src/domain/quorum.ts';
import { apply, emptyState, renamedTo, seed } from '../src/ui/kit/app/store.js';

function setup() {
  const quorum = openQuorum();
  const chris = quorum.identify({ name: 'chris', harness: 'human' }).participant;
  const fable = quorum.identify({ name: 'fable', harness: 'claude-code' }).participant;
  const room = quorum.createRoom({ name: 'protocol', topic: 'the wire', by: chris.id });
  quorum.joinRoom({ room: 'protocol', participantId: fable.id });
  return { quorum, chris, fable, room };
}

const kindsAfter = (quorum: ReturnType<typeof openQuorum>, seq: number, viewerId: string) =>
  quorum.readEvents({ afterSeq: seq, viewerId }).map((event) => event.kind);

test('leaving a room ends the membership, keeps the room, and is on the feed', () => {
  const { quorum, chris, fable, room } = setup();
  const before = quorum.latestSeq();

  const left = quorum.leaveRoom({ room: 'protocol', participantId: fable.id });
  assert.equal(left.id, room.id);
  assert.deepEqual(quorum.listMembers({ room: 'protocol' }).map((p) => p.name), ['chris']);
  assert.equal(quorum.listRooms().find((r) => r.id === room.id)?.members, 1, 'the room is one smaller, not gone');

  const events = quorum.readEvents({ afterSeq: before, viewerId: chris.id });
  assert.deepEqual(events.map((e) => e.kind), ['room_left']);
  assert.equal(events[0]!.actorId, fable.id, 'the leaver acted');
  assert.equal(events[0]!.roomId, room.id);
  const payload = events[0]!.payload as { room: { id: string }; participant: { id: string } };
  assert.equal(payload.participant.id, fable.id);
  assert.equal(payload.room.id, room.id);

  // The roster still knows them, and joining again is an ordinary join.
  assert.ok(quorum.listParticipants().some((p) => p.id === fable.id), 'leaving a room is not leaving the server');
  quorum.joinRoom({ room: 'protocol', participantId: fable.id });
  assert.deepEqual(quorum.listMembers({ room: 'protocol' }).map((p) => p.name), ['chris', 'fable']);
});

test('leaving a room you are not in is refused in words, not silently', () => {
  const { quorum } = setup();
  const sol = quorum.identify({ name: 'sol', harness: 'codex' }).participant;
  const before = quorum.latestSeq();
  assert.throws(() => quorum.leaveRoom({ room: 'protocol', participantId: sol.id }), /you are not in "protocol"/);
  assert.equal(quorum.latestSeq(), before, 'a refusal is not a room fact');
});

test('the creator can leave too; the room and its record outlive its members', () => {
  const { quorum, chris, fable, room } = setup();
  quorum.postMessage({ room: 'protocol', participantId: chris.id, body: 'before I go' });
  quorum.leaveRoom({ room: 'protocol', participantId: chris.id });
  quorum.leaveRoom({ room: 'protocol', participantId: fable.id });
  assert.equal(quorum.listRooms().find((r) => r.id === room.id)?.members, 0, 'an empty room still lists');
  assert.equal(quorum.readMessages({ room: 'protocol' }).length, 1, 'history is not membership');
});

test('a rename keeps the id and everything hanging off it, and carries the old name on the feed', () => {
  const { quorum, chris, fable, room } = setup();
  const claim = quorum.claimScope({ participantId: fable.id, repo: 'quorum', patterns: ['src/**'], purpose: 'work' });
  assert.equal(claim.ok, true);
  const before = quorum.latestSeq();

  const { room: renamed, changed } = quorum.renameRoom({ room: 'protocol', participantId: chris.id, name: 'wire' });
  assert.equal(changed, true);
  assert.equal(renamed.id, room.id, 'same room');
  assert.equal(renamed.name, 'wire');
  assert.equal(renamed.topic, 'the wire', 'nothing else moved');
  assert.deepEqual(quorum.listMembers({ room: 'wire' }).map((p) => p.name), ['chris', 'fable'], 'membership follows the id');
  assert.throws(() => quorum.listMembers({ room: 'protocol' }), /unknown room: "protocol"/, 'the old name is an address no more');
  assert.equal(quorum.listClaims({ repo: 'quorum' }).filter((c) => c.participantId === fable.id).length, 1, 'claims are untouched');

  const events = quorum.readEvents({ afterSeq: before, viewerId: fable.id });
  assert.deepEqual(events.map((e) => e.kind), ['room_renamed']);
  assert.equal(events[0]!.actorId, chris.id);
  const payload = events[0]!.payload as { room: { name: string }; previousName: string };
  assert.equal(payload.room.name, 'wire');
  assert.equal(payload.previousName, 'protocol', 'a reader can say what it used to be called');
});

test('a rename is refused when the name is taken among rooms the caller can see, and needs a name', () => {
  const { quorum, chris } = setup();
  quorum.createRoom({ name: 'design', by: chris.id });
  assert.throws(
    () => quorum.renameRoom({ room: 'protocol', participantId: chris.id, name: 'design' }),
    /room already exists: "design"/,
  );
  assert.throws(() => quorum.renameRoom({ room: 'protocol', participantId: chris.id, name: '   ' }), /a room needs a name/);
  assert.equal(quorum.listRooms().find((r) => r.name === 'protocol')?.name, 'protocol', 'a refusal changed nothing');
});

test('renaming to the same name is a no-op with no event', () => {
  const { quorum, chris } = setup();
  const before = quorum.latestSeq();
  const same = quorum.renameRoom({ room: 'protocol', participantId: chris.id, name: 'protocol' });
  assert.equal(same.room.name, 'protocol');
  assert.equal(same.changed, false, 'the caller is told it was a no-op, so nobody waits for an event');
  assert.equal(quorum.latestSeq(), before, 'nothing happened, so nothing is recorded');
});

test('the topic can be set, changed, and cleared, each on the feed with what it was', () => {
  const { quorum, chris, fable } = setup();
  const before = quorum.latestSeq();

  const set = quorum.setTopic({ room: 'protocol', participantId: chris.id, topic: '  the loop  ' });
  assert.deepEqual([set.room.topic, set.changed], ['the loop', true], 'trimmed');
  const cleared = quorum.setTopic({ room: 'protocol', participantId: chris.id, topic: '' });
  assert.deepEqual([cleared.room.topic, cleared.changed], [null, true], 'an empty topic clears it');
  const again = quorum.setTopic({ room: 'protocol', participantId: chris.id, topic: null });
  assert.deepEqual([again.room.topic, again.changed], [null, false], 'clearing a clear topic is a no-op, and says so');

  const events = quorum.readEvents({ afterSeq: before, viewerId: fable.id });
  assert.deepEqual(events.map((e) => e.kind), ['room_topic_set', 'room_topic_set'], 'clearing a clear topic is not a fact');
  const first = events[0]!.payload as { room: { topic: string | null }; previousTopic: string | null };
  const second = events[1]!.payload as { room: { topic: string | null }; previousTopic: string | null };
  assert.deepEqual([first.previousTopic, first.room.topic], ['the wire', 'the loop']);
  assert.deepEqual([second.previousTopic, second.room.topic], ['the loop', null]);
  assert.equal(quorum.listRooms().find((r) => r.name === 'protocol')?.topic, null, 'the list agrees with the feed');
});

test('until room roles land, only the creator renames or retopics — and the refusal says so', () => {
  const { quorum, fable } = setup();
  const before = quorum.latestSeq();
  assert.throws(
    () => quorum.renameRoom({ room: 'protocol', participantId: fable.id, name: 'mine' }),
    /only the creator of "protocol" can rename it until room roles land \(#82\)/,
  );
  assert.throws(
    () => quorum.setTopic({ room: 'protocol', participantId: fable.id, topic: 'hijacked' }),
    /only the creator of "protocol" can change the topic of it until room roles land \(#82\)/,
  );
  assert.equal(quorum.latestSeq(), before);
});

test('a room outside the caller\'s visible set is refused as unknown, for every lifecycle verb (ADR-0002 §6)', () => {
  const { quorum, chris } = setup();
  const stranger = quorum.identify({ name: 'stranger', harness: 'codex' }).participant;
  // The stranger's view has no room named by an id they were never shown.
  const bogus = 'no-such-room';
  for (const verb of [
    () => quorum.leaveRoom({ room: bogus, participantId: stranger.id }),
    () => quorum.renameRoom({ room: bogus, participantId: chris.id, name: 'x' }),
    () => quorum.setTopic({ room: bogus, participantId: chris.id, topic: 'x' }),
  ]) {
    assert.throws(verb, /unknown room: "no-such-room"/);
  }
});

test('clearing a status empties the roster line and the feed says so; clearing twice says nothing twice', async () => {
  const { quorum, chris, fable } = setup();
  await quorum.post({ room: 'protocol', participantId: fable.id, body: '/blocked waiting on review' });
  assert.equal(quorum.listParticipants().find((p) => p.id === fable.id)?.status?.kind, 'blocked');
  const before = quorum.latestSeq();

  const cleared = quorum.clearStatus({ participantId: fable.id });
  assert.equal(cleared.status, null);
  assert.equal(quorum.listParticipants().find((p) => p.id === fable.id)?.status, null, 'the roster shows nothing');

  const events = quorum.readEvents({ afterSeq: before, viewerId: chris.id });
  assert.deepEqual(events.map((e) => e.kind), ['status_changed'], 'the same kind the setting emitted');
  const payload = events[0]!.payload as { participant: { id: string; status: unknown } };
  assert.equal(payload.participant.id, fable.id);
  assert.equal(payload.participant.status, null, 'a reader folds it like any status change');

  const afterClear = quorum.latestSeq();
  quorum.clearStatus({ participantId: fable.id });
  assert.equal(quorum.latestSeq(), afterClear, 'idempotent: exactly one status_changed per clearing');
});

test('/leave answers the leaver, records room_left, and posts no line to a room they just left', async () => {
  const { quorum, chris, fable } = setup();
  const before = quorum.latestSeq();
  const { message, command } = await quorum.post({ room: 'protocol', participantId: fable.id, body: '/leave' });
  assert.equal(message, undefined, 'nothing was posted');
  assert.equal(command?.command, 'leave');
  assert.match(command!.text, /You left #protocol/);
  assert.deepEqual(kindsAfter(quorum, before, chris.id), ['room_left']);
  await assert.rejects(
    () => quorum.post({ room: 'protocol', participantId: fable.id, body: 'still here?' }),
    /join "protocol" before posting/,
    'a leaver posts like any non-member: not at all',
  );
});

test('/topic is an action on the record: the typed line, then room_topic_set; bare /topic clears', async () => {
  const { quorum, chris, fable } = setup();
  const before = quorum.latestSeq();
  const set = await quorum.post({ room: 'protocol', participantId: chris.id, body: '/topic the loop' });
  assert.equal(set.message?.body, '/topic the loop', 'the order given is on the record');
  assert.match(set.command!.text, /Topic of #protocol is now: the loop/);
  // An action runs, then its typed line posts — the order every recorded
  // command has (/status, /kick): the fact, then the words that asked for it.
  assert.deepEqual(kindsAfter(quorum, before, fable.id), ['room_topic_set', 'message']);

  const cleared = await quorum.post({ room: 'protocol', participantId: chris.id, body: '/topic' });
  assert.match(cleared.command!.text, /Topic of #protocol cleared/);
  const nothing = await quorum.post({ room: 'protocol', participantId: chris.id, body: '/topic' });
  assert.match(nothing.command!.text, /#protocol had no topic to clear/, 'a no-op answers as one');
  assert.equal(quorum.listRooms().find((r) => r.name === 'protocol')?.topic, null);

  await assert.rejects(
    () => quorum.post({ room: 'protocol', participantId: fable.id, body: '/topic mine' }),
    /only the creator of "protocol"/,
  );
});

test('/clear takes a status or blocked line off the roster, and says when there was none', async () => {
  const { quorum, chris, fable } = setup();
  await quorum.post({ room: 'protocol', participantId: fable.id, body: '/status refactoring' });
  const cleared = await quorum.post({ room: 'protocol', participantId: fable.id, body: '/clear' });
  assert.equal(cleared.message?.body, '/clear', 'an action, on the record like /status');
  assert.match(cleared.command!.text, /Cleared your status/);
  assert.equal(quorum.listParticipants().find((p) => p.id === fable.id)?.status, null);

  const nothing = await quorum.post({ room: 'protocol', participantId: chris.id, body: '/clear' });
  assert.match(nothing.command!.text, /You had no status to clear/);

  const help = await quorum.post({ room: 'protocol', participantId: chris.id, body: '/help' });
  assert.match(help.command!.text, /\/leave/, 'new commands are in /help by construction');
  assert.match(help.command!.text, /\/topic/);
  assert.match(help.command!.text, /\/clear/);
});

test('the browser store folds a leave, a rename, and a topic like the room facts they are', () => {
  const ROOM = { id: 'r1', name: 'protocol', topic: 'the wire', decisionRule: 'majority', createdBy: 'p1', memberIds: ['p1', 'p2'], members: 2 };
  const event = (seq: number, kind: string, payload: unknown) => ({ seq, kind, roomId: 'r1', actorId: null, payload });

  let state = seed(emptyState(), { seq: 5, rooms: [ROOM], participants: [] });
  state = apply(state, event(6, 'room_left', { room: ROOM, participant: { id: 'p2', name: 'sol' } }));
  assert.deepEqual(state.rooms.get('r1')?.memberIds, ['p1'], 'the leaver is gone, the count follows');
  assert.equal(state.rooms.get('r1')?.members, 1);

  // The domain's payload is a plain Room: no membership fields at all.
  const renamed = { id: 'r1', name: 'wire', topic: 'the wire', decisionRule: 'majority', createdBy: 'p1' };
  state = apply(state, event(7, 'room_renamed', { room: renamed, previousName: 'protocol' }));
  assert.equal(state.rooms.get('r1')?.name, 'wire');
  assert.deepEqual(state.rooms.get('r1')?.memberIds, ['p1'], 'a rename does not forget who is here');

  state = apply(state, event(8, 'room_topic_set', { room: { ...renamed, topic: null }, previousTopic: 'the wire' }));
  assert.equal(state.rooms.get('r1')?.topic, null);
  assert.equal(state.rooms.get('r1')?.name, 'wire');
});

test('the controller follows a rename of the open room, and only the open room', () => {
  const renamed = { kind: 'room_renamed', payload: { room: { id: 'r1', name: 'wire' }, previousName: 'protocol' } };
  assert.equal(renamedTo(renamed, 'protocol'), 'wire', 'the open room moves with its new name');
  assert.equal(renamedTo(renamed, 'design'), null, 'another room renaming is not this address');
  assert.equal(renamedTo({ kind: 'room_topic_set', payload: { room: { id: 'r1', name: 'wire' } } }, 'wire'), null);
  assert.equal(renamedTo(null, 'protocol'), null);
});
