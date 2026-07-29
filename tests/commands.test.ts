// Room commands (#52): one parser, three dispatch classes — actions on the
// record, answers to the asker alone, and everything else is just a message.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openQuorum } from '../src/domain/quorum.ts';

function setup() {
  const quorum = openQuorum();
  const chris = quorum.identify({ name: 'chris', harness: 'human' }).participant;
  const fable = quorum.identify({ name: 'fable', harness: 'claude-code' }).participant;
  const room = quorum.createRoom({ name: 'protocol', by: chris.id });
  quorum.joinRoom({ room: 'protocol', participantId: fable.id });
  return { quorum, chris, fable, room };
}

test('a plain message and an unknown /command both post; chat has no syntax that can fail', async () => {
  const { quorum, chris } = setup();
  const plain = await quorum.post({ room: 'protocol', participantId: chris.id, body: 'hello' });
  assert.equal(plain.message?.body, 'hello');
  assert.equal(plain.command, undefined);

  const unknown = await quorum.post({ room: 'protocol', participantId: chris.id, body: '/smack fable' });
  assert.equal(unknown.message?.body, '/smack fable', 'an unknown command is a message, never an error');
  assert.equal(unknown.command, undefined);
});

test('/help answers the asker and leaves no trace — not even the typed line', async () => {
  const { quorum, chris } = setup();
  const before = quorum.latestSeq();
  const { message, command } = await quorum.post({ room: 'protocol', participantId: chris.id, body: '/help' });
  assert.equal(message, undefined, 'nothing was posted');
  assert.equal(quorum.latestSeq(), before, 'no event was appended');
  assert.match(command!.text, /\/kick/, 'the index lists the commands');
  assert.match(command!.text, /\/status/);

  const scoped = await quorum.post({ room: 'protocol', participantId: chris.id, body: '/help kick' });
  assert.match(scoped.command!.text, /\/kick <name\|id>/, 'scoped help carries usage');
});

test('/list answers with every room and posts nothing', async () => {
  const { quorum, chris } = setup();
  quorum.createRoom({ name: 'design', topic: 'the look', by: chris.id });
  const before = quorum.latestSeq();
  const { command } = await quorum.post({ room: 'protocol', participantId: chris.id, body: '/list' });
  assert.match(command!.text, /#protocol/);
  assert.match(command!.text, /#design — the look/);
  assert.equal(quorum.latestSeq(), before);
});

test('/status with text is an action on the record; bare /status is an answer', async () => {
  const { quorum, chris, fable } = setup();
  const set = await quorum.post({ room: 'protocol', participantId: fable.id, body: '/status shipping #52' });
  assert.equal(set.message?.body, '/status shipping #52', 'the typed line is on the record');
  assert.equal(set.command?.recorded, true);

  const roster = quorum.listParticipants().find((p) => p.id === fable.id);
  assert.equal(roster?.status?.text, 'shipping #52', 'the roster carries the status');
  assert.equal(roster?.status?.kind, 'status');

  const before = quorum.latestSeq();
  const ask = await quorum.post({ room: 'protocol', participantId: chris.id, body: '/status' });
  assert.equal(ask.message, undefined);
  assert.equal(quorum.latestSeq(), before, 'asking is not a room fact');
  assert.match(ask.command!.text, /fable \(claude-code\) — shipping #52/);
  assert.match(ask.command!.text, /1 participant has no status/);
});

test('/blocked is a status with teeth, and refuses without a reason', async () => {
  const { quorum, fable } = setup();
  await assert.rejects(
    () => quorum.post({ room: 'protocol', participantId: fable.id, body: '/blocked' }),
    /say what you are blocked by/,
  );
  await quorum.post({ room: 'protocol', participantId: fable.id, body: '/blocked waiting on review' });
  const roster = quorum.listParticipants().find((p) => p.id === fable.id);
  assert.equal(roster?.status?.kind, 'blocked');
  const ask = await quorum.post({ room: 'protocol', participantId: fable.id, body: '/status' });
  assert.match(ask.command!.text, /BLOCKED: waiting on review/);
});

test('/room creates the room from chat and needs no room to exist first', async () => {
  const { quorum, chris } = setup();
  const { message, command } = await quorum.post({
    room: 'protocol',
    participantId: chris.id,
    body: '/room design the look of things',
  });
  assert.match(command!.text, /Room #design created/);
  assert.equal(message, undefined, 'creation announces itself (room_created); no chat line is posted');
  assert.ok(quorum.listRooms().some((r) => r.name === 'design' && r.topic === 'the look of things'));

  // The bootstrap path /list advertises: a fresh server, zero rooms, and
  // /room still works — the room named in the request does not have to exist.
  const fresh = openQuorum();
  const solo = fresh.identify({ name: 'solo', harness: 'test' }).participant;
  const made = await fresh.post({ room: 'protocol', participantId: solo.id, body: '/room protocol first light' });
  assert.match(made.command!.text, /Room #protocol created/);
  assert.equal(fresh.listRooms()[0]?.name, 'protocol');
});

test('a challenge-tagged body is never a command — the phase gate speaks first', async () => {
  const { quorum, chris, fable } = setup();
  const deliberation = quorum.propose({
    room: 'protocol',
    participantId: chris.id,
    question: 'ship it?',
    options: ['yes', 'no'],
  });
  const tagged = await quorum.post({
    room: 'protocol',
    participantId: fable.id,
    body: '/status busy',
    deliberationId: deliberation.id,
  });
  assert.equal(tagged.command, undefined, 'the tag wins: this is a challenge, not an order');
  assert.equal(tagged.message?.body, '/status busy');
  assert.equal(quorum.listParticipants().find((p) => p.id === fable.id)?.status, null, 'no action ran');
});

test('/invite wakes the invitee alone; the room sees only the typed line', async () => {
  const { quorum, chris, fable, room } = setup();
  const outsider = quorum.identify({ name: 'codex', harness: 'codex' }).participant;
  const before = quorum.latestSeq();
  const { command } = await quorum.post({ room: 'protocol', participantId: chris.id, body: '/invite codex' });
  assert.match(command!.text, /Invited codex/);

  // The invitee receives the invitation with joining instructions…
  const forInvitee = quorum.readEvents({ afterSeq: before, viewerId: outsider.id });
  const invite = forInvitee.find((e) => e.kind === 'invited');
  assert.ok(invite, 'the invitee is woken');
  assert.match((invite!.payload as any).guidance, /join_room/);
  assert.equal((invite!.payload as any).room.id, room.id);

  // …and a third party sees the typed line but no invitation event.
  const forBystander = quorum.readEvents({ afterSeq: before, viewerId: fable.id });
  assert.ok(!forBystander.some((e) => e.kind === 'invited'), 'the invitation itself is audience-scoped');
  assert.ok(forBystander.some((e) => e.kind === 'message'), 'the typed /invite line is on the record');

  // Inviting someone already present is refused in words.
  await assert.rejects(
    () => quorum.post({ room: 'protocol', participantId: chris.id, body: '/invite fable' }),
    /already in #protocol/,
  );
});

test('/kick is the owner’s call: members leave, non-owners are refused by name', async () => {
  const { quorum, chris, fable, room } = setup();
  await assert.rejects(
    () => quorum.post({ room: 'protocol', participantId: fable.id, body: '/kick chris' }),
    /only the room owner may \/kick here — #protocol belongs to chris/,
  );

  const { command } = await quorum.post({ room: 'protocol', participantId: chris.id, body: '/kick fable' });
  assert.match(command!.text, /Kicked fable from #protocol/);
  assert.equal(quorum.listRooms().find((r) => r.id === room.id)?.members, 1);

  // Kicked is not banned (#54): rejoining works today, and says so.
  quorum.joinRoom({ room: 'protocol', participantId: fable.id });
  assert.equal(quorum.listRooms().find((r) => r.id === room.id)?.members, 2);
});

test('the god-mod outranks the room owner for /kick (#54 ladder, first rung)', async () => {
  process.env.QUORUM_GOD = 'god--human';
  try {
    const quorum = openQuorum();
    const owner = quorum.identify({ name: 'owner', harness: 'test' }).participant;
    const god = quorum.identify({ name: 'god', harness: 'human' }).participant;
    quorum.createRoom({ name: 'theirs', by: owner.id });
    quorum.joinRoom({ room: 'theirs', participantId: god.id });
    const { command } = await quorum.post({ room: 'theirs', participantId: god.id, body: '/kick owner' });
    assert.match(command!.text, /Kicked owner/);
  } finally {
    delete process.env.QUORUM_GOD;
  }
});

test('/version answers to the asker alone and treats offline as a normal answer', async () => {
  const { quorum, chris } = setup();
  const original = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
  try {
    const before = quorum.latestSeq();
    const { message, command } = await quorum.post({ room: 'protocol', participantId: chris.id, body: '/version' });
    assert.equal(message, undefined);
    assert.equal(quorum.latestSeq(), before);
    assert.match(command!.text, /Running v0\.1\.0-alpha\.1/);
    assert.match(command!.text, /could not reach GitHub/);
  } finally {
    globalThis.fetch = original;
  }
});

test('/who lists the room in join order with statuses, and leaves no trace (#56)', async () => {
  const { quorum, chris, fable } = setup();
  await quorum.post({ room: 'protocol', participantId: fable.id, body: '/blocked waiting on review' });

  const before = quorum.latestSeq();
  const { message, command } = await quorum.post({ room: 'protocol', participantId: chris.id, body: '/who' });
  assert.equal(message, undefined);
  assert.equal(quorum.latestSeq(), before, 'asking who is here is not a room fact');
  const lines = command!.text.split('\n');
  assert.equal(lines[0], '#protocol · 2 members:');
  assert.equal(lines[1], 'chris (human)', 'join order: the creator joined first');
  assert.equal(lines[2], 'fable (claude-code) — BLOCKED: waiting on review', 'statuses ride along');

  // The domain query underneath agrees, and a kick shrinks it.
  await quorum.post({ room: 'protocol', participantId: chris.id, body: '/kick fable' });
  assert.deepEqual(quorum.listMembers({ room: 'protocol' }).map((p) => p.name), ['chris']);
  const rooms = quorum.listRooms().find((r) => r.name === 'protocol');
  assert.deepEqual(rooms?.memberIds, [chris.id], 'the rooms read carries member ids for first paint');
  assert.equal(rooms?.members, 1, 'the count is the list, derived');
});

test('an action command from a non-member is the same refusal as posting', async () => {
  const { quorum } = setup();
  const outsider = quorum.identify({ name: 'codex', harness: 'codex' }).participant;
  await assert.rejects(
    () => quorum.post({ room: 'protocol', participantId: outsider.id, body: '/status busy' }),
    /join "protocol" before posting/,
  );
  const roster = quorum.listParticipants().find((p) => p.id === outsider.id);
  assert.equal(roster?.status, null, 'the refusal left nothing half-done');
});
