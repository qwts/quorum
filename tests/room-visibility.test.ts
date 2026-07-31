// Room names are unique only among the rooms a caller can see (#96, ADR-0002
// §6, docs/design/authority.md §6.1).
//
// Nothing can set a tier until #82, so these tests write `visibility` directly
// and then go through the ordinary API. That is the point of landing the
// column and the resolution rules first: by the time there is a way to make a
// room exclusive, every path that resolves a name already behaves as though
// there were.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DatabaseSync } from 'node:sqlite';

import { openQuorum, QuorumError } from '../src/domain/quorum.ts';

/**
 * A quorum over a file, plus the raw handle #82 will replace with a tier
 * setter. Two connections to one SQLite file, which is what the server itself
 * does across a restart.
 */
function withRooms(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const path = join(dir, 'quorum.db');
  const quorum = openQuorum({ path });
  const raw = new DatabaseSync(path);
  return {
    quorum,
    agent: (name: string) => quorum.identify({ name, harness: 'test' }).participant,
    makeExclusive: (roomId: string) => raw.prepare("UPDATE rooms SET visibility = 'exclusive' WHERE id = ?").run(roomId),
    raw,
    cleanup: () => {
      raw.close();
      quorum.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('a name taken by a room you cannot see is not taken', () => {
  const { quorum, agent, makeExclusive, cleanup } = withRooms('quorum-invisible-name-');
  try {
    const ada = agent('ada');
    const grace = agent('grace');
    const secret = quorum.createRoom({ name: 'war-room', by: ada.id });
    makeExclusive(secret.id);

    // The refusal *is* the disclosure the tier exists to prevent, so there is
    // no refusal: grace's room is created, and she is told nothing about
    // ada's.
    const theirs = quorum.createRoom({ name: 'war-room', topic: 'the visible one', by: grace.id });
    assert.equal(theirs.name, 'war-room');
    assert.notEqual(theirs.id, secret.id);

    // And the ordinary collision is unchanged: two rooms both listed cannot
    // share a name, and the caller who can see the other one is told so.
    assert.throws(
      () => quorum.createRoom({ name: 'war-room', by: ada.id }),
      (error: unknown) => error instanceof QuorumError && /room already exists: "war-room"/.test(error.message),
    );
  } finally {
    cleanup();
  }
});

test('the partial index refuses two listed rooms of one name whatever the caller was told', () => {
  // The pre-check is for the message; this is for the guarantee. A path that
  // forgot to check — a future importer, a bridge, #82 itself — still cannot
  // put two listed rooms of one name into the database.
  const { quorum, agent, raw, cleanup } = withRooms('quorum-index-');
  try {
    const ada = agent('ada');
    const room = quorum.createRoom({ name: 'platform', by: ada.id });
    assert.throws(
      () =>
        raw
          .prepare(
            "INSERT INTO rooms (id, name, topic, decision_rule, created_by, created_at, visibility) VALUES ('forced', 'platform', NULL, 'majority', ?, 1, 'private')",
          )
          .run(ada.id),
      /UNIQUE constraint failed/,
    );
    // Exclusive is the one tier that escapes it — the whole reason the
    // constraint gave way.
    raw
      .prepare(
        "INSERT INTO rooms (id, name, topic, decision_rule, created_by, created_at, visibility) VALUES ('hidden', 'platform', NULL, 'majority', ?, 1, 'exclusive')",
      )
      .run(ada.id);
    assert.equal(quorum.listRooms()[0]?.id, room.id, 'and the listed one is still the only one listed');
    assert.equal(quorum.listRooms().length, 1);
  } finally {
    cleanup();
  }
});

test('a room you cannot see is refused in the words a room that does not exist gets', () => {
  const { quorum, agent, makeExclusive, cleanup } = withRooms('quorum-unknown-');
  try {
    const ada = agent('ada');
    const grace = agent('grace');
    const secret = quorum.createRoom({ name: 'war-room', by: ada.id });
    makeExclusive(secret.id);

    // Same words, by id and by name, as a room nobody ever created. Two
    // refusals that differ by one adjective are an oracle (design §7).
    const refusalFor = (room: string) => {
      try {
        quorum.readMessages({ room, viewerId: grace.id });
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    };
    assert.equal(refusalFor(secret.id), `unknown room: ${JSON.stringify(secret.id)}`);
    assert.equal(refusalFor('war-room'), 'unknown room: "war-room"');
    assert.equal(refusalFor('no-such-room'), 'unknown room: "no-such-room"');

    // Joining is the same refusal: a room you cannot see is not a room you can
    // be told to knock on.
    assert.throws(
      () => quorum.joinRoom({ room: 'war-room', participantId: grace.id }),
      (error: unknown) => error instanceof QuorumError && /unknown room: "war-room"/.test(error.message),
    );

    // Nor does it appear in the list, or in the count that goes with it.
    assert.deepEqual(quorum.listRooms({ viewerId: grace.id }), []);
    assert.deepEqual(
      quorum.listRooms({ viewerId: ada.id }).map((room) => room.id),
      [secret.id],
      'while its own member sees it in full',
    );
  } finally {
    cleanup();
  }
});

test('an ambiguous name is refused in favour of an id, never resolved arbitrarily', () => {
  // The downside ADR-0002 accepted and recorded: the caller who can see both
  // rooms pays for the tier with a worse address book.
  const { quorum, agent, makeExclusive, cleanup } = withRooms('quorum-ambiguous-');
  try {
    const ada = agent('ada');
    const grace = agent('grace');
    const secret = quorum.createRoom({ name: 'war-room', by: ada.id });
    makeExclusive(secret.id);
    const listed = quorum.createRoom({ name: 'war-room', by: grace.id });
    quorum.joinRoom({ room: listed.id, participantId: ada.id });

    assert.throws(
      () => quorum.readMessages({ room: 'war-room', viewerId: ada.id }),
      (error: unknown) =>
        error instanceof QuorumError &&
        /2 rooms you can see are named "war-room"/.test(error.message) &&
        // Written to be read: the refusal is the next move, so it carries the
        // ids it is asking for — and only rooms this caller can already see.
        error.message.includes(secret.id) &&
        error.message.includes(listed.id),
    );

    // The id still resolves, both ways, which is the point of refusing.
    assert.equal(quorum.listMembers({ room: secret.id, viewerId: ada.id }).length, 1);
    assert.equal(quorum.listMembers({ room: listed.id, viewerId: ada.id }).length, 2);

    // And grace, who can see only one of them, is not made to pay for a
    // collision she cannot observe.
    assert.equal(quorum.readMessages({ room: 'war-room', viewerId: grace.id }).length, 0);
    quorum.postMessage({ room: 'war-room', participantId: grace.id, body: 'unambiguous for me' });
  } finally {
    cleanup();
  }
});

test('a command names only rooms its sender can see', async () => {
  const { quorum, agent, makeExclusive, cleanup } = withRooms('quorum-command-');
  try {
    const ada = agent('ada');
    const grace = agent('grace');
    const open = quorum.createRoom({ name: 'platform', by: grace.id });
    const secret = quorum.createRoom({ name: 'war-room', by: ada.id });
    makeExclusive(secret.id);
    quorum.joinRoom({ room: open.id, participantId: ada.id });

    return Promise.all([
      quorum.post({ room: open.id, participantId: grace.id, body: '/list' }),
      quorum.post({ room: open.id, participantId: ada.id, body: '/list' }),
    ]).then(([hers, his]) => {
      assert.doesNotMatch(hers.command?.text ?? '', /war-room/, '/list is answered from the asker\'s visible set');
      assert.match(his.command?.text ?? '', /war-room/, 'and its member still sees it');
      cleanup();
    });
  } catch (error) {
    cleanup();
    throw error;
  }
});
