// The migration mechanism (#96), and the one thing it must never do.
//
// A migration is the most plausible way to lose the decision records that are
// the product's memory (requirements §3), so the first test here builds a
// database at the shape that shipped, with a converged deliberation and its
// record in it, and proves every row is still there afterwards. The rest hold
// the mechanism itself honest: applied once, all-or-nothing, and producing the
// same schema a fresh database gets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DatabaseSync } from 'node:sqlite';

import { openQuorum } from '../src/domain/quorum.ts';
import { migrate, type Migration } from '../src/domain/migrate.ts';

const clock = () => 1_700_000_000_000;

function tempDb(prefix: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { path: join(dir, 'quorum.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Rewind `rooms` to the shape that shipped before #96: `name TEXT NOT NULL
 * UNIQUE`, no `visibility`, no partial index — and no ledger row for the
 * migration that changed it, because a database from before the change is a
 * database from before its record too.
 */
function rewindRooms(path: string): void {
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA foreign_keys = OFF');
  raw.exec(`
    BEGIN;
    CREATE TABLE rooms_v0 (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL UNIQUE,
      topic         TEXT,
      decision_rule TEXT NOT NULL,
      created_by    TEXT NOT NULL REFERENCES participants(id),
      created_at    INTEGER NOT NULL
    );
    INSERT INTO rooms_v0 SELECT id, name, topic, decision_rule, created_by, created_at FROM rooms;
    DROP TABLE rooms;
    ALTER TABLE rooms_v0 RENAME TO rooms;
    DELETE FROM schema_migrations WHERE id = 2;
    COMMIT;
  `);
  const sql = (raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'rooms'").get() as { sql: string }).sql;
  assert.match(sql, /UNIQUE/, 'the rewind has to actually produce the old shape, or the test proves nothing');
  raw.close();
}

test('the rooms rebuild keeps every row, including the decision records', () => {
  const { path, cleanup } = tempDb('quorum-migrate-');
  try {
    // A database with something to lose: two rooms, members, messages, a
    // deliberation carried to convergence, and the record it wrote.
    const before = openQuorum({ path, now: clock });
    const ada = before.identify({ name: 'ada', harness: 'test' }).participant;
    const grace = before.identify({ name: 'grace', harness: 'test' }).participant;
    const room = before.createRoom({ name: 'platform', topic: 'infra', decisionRule: 'unanimity', by: ada.id });
    before.createRoom({ name: 'design', by: grace.id });
    before.joinRoom({ room: room.id, participantId: grace.id });
    before.postMessage({ room: room.id, participantId: ada.id, body: 'starting on the parser' });
    const deliberation = before.propose({
      participantId: ada.id,
      room: room.id,
      question: 'ship the parser?',
      options: ['yes', 'no'],
    });
    before.closeChallenges({ participantId: ada.id, deliberationId: deliberation.id });
    before.vote({ participantId: ada.id, deliberationId: deliberation.id, choice: 0 });
    before.vote({ participantId: grace.id, deliberationId: deliberation.id, choice: 0, dissent: 'with reservations' });
    const record = before.getDecision({ deliberationId: deliberation.id });
    const messages = before.readMessages({ room: room.id });
    const events = before.readEvents({ limit: 500 });
    before.close();

    rewindRooms(path);

    // Open again: migration 2 finds the old shape and rebuilds the table.
    const after = openQuorum({ path, now: clock });

    const rooms = after.listRooms();
    assert.deepEqual(
      rooms.map((r) => [r.id, r.name, r.topic, r.decisionRule, r.createdBy]),
      [
        [room.id, 'platform', 'infra', 'unanimity', ada.id],
        [rooms[1]!.id, 'design', null, 'majority', grace.id],
      ],
      'every room came across, with every column it had',
    );
    assert.deepEqual(
      rooms.map((r) => r.visibility),
      ['public', 'public'],
      'and lands in the tier they were all in: the uniqueness they were created under is the one public keeps',
    );
    assert.deepEqual(
      after.listMembers({ room: room.id }).map((p) => p.id),
      [ada.id, grace.id],
      'members still point at a room that exists, in join order',
    );
    assert.deepEqual(after.readMessages({ room: room.id }), messages, 'messages are untouched');
    assert.deepEqual(after.getDecision({ deliberationId: deliberation.id }), record, 'and the record is verbatim');
    assert.deepEqual(after.readEvents({ limit: 500 }), events, 'the feed did not lose or renumber an event');

    const raw = new DatabaseSync(path);
    assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(), [], 'nothing was left dangling');
    raw.close();
    after.close();
  } finally {
    cleanup();
  }
});

test('a migrated database and a fresh one are the same database', () => {
  // The trap this catches: a migration is frozen in time and schema.ts is not,
  // so the two shapes drift apart in silence and the bug surfaces years later
  // as "works on my machine, but only if you installed before March".
  const migrated = tempDb('quorum-migrated-');
  const fresh = tempDb('quorum-fresh-');
  try {
    const seeded = openQuorum({ path: migrated.path, now: clock });
    const ada = seeded.identify({ name: 'ada', harness: 'test' }).participant;
    seeded.createRoom({ name: 'platform', by: ada.id });
    seeded.close();
    rewindRooms(migrated.path);
    openQuorum({ path: migrated.path, now: clock }).close();
    openQuorum({ path: fresh.path, now: clock }).close();

    const shape = (path: string) => {
      const db = new DatabaseSync(path);
      const rows = db
        .prepare("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name")
        .all() as { name: string; sql: string }[];
      db.close();
      // Two differences that are not differences: a rebuilt table is recorded
      // with its name quoted — `CREATE TABLE "rooms"` — because ALTER TABLE
      // RENAME writes it that way, and a migration's frozen copy of the DDL
      // carries none of schema.ts's commentary. Comments are documentation;
      // the shape is what has to agree.
      return rows.map((row) => [
        row.name,
        row.sql
          .replace(/--[^\n]*/g, '')
          .replace(/"/g, '')
          .replace(/\s+/g, ' ')
          .trim(),
      ]);
    };
    assert.deepEqual(shape(migrated.path), shape(fresh.path));
  } finally {
    migrated.cleanup();
    fresh.cleanup();
  }
});

test('a migration is applied once, and reopening applies nothing', () => {
  const { path, cleanup } = tempDb('quorum-ledger-');
  try {
    openQuorum({ path, now: clock }).close();
    const raw = new DatabaseSync(path);
    const first = raw.prepare('SELECT id, name, applied_at FROM schema_migrations ORDER BY id').all();
    assert.deepEqual(
      first.map((row) => (row as { id: number }).id),
      [1, 2, 3],
      'the ledger names every migration this version knows',
    );

    let ran = 0;
    const counted: Migration[] = [{ id: 1, name: 'already applied', up: () => (ran += 1) }];
    migrate(raw, clock, counted);
    migrate(raw, clock, counted);
    assert.equal(ran, 0, 'a recorded migration never runs again, whatever its body would have done');

    raw.close();
    openQuorum({ path, now: () => 1_800_000_000_000 }).close();
    const reopened = new DatabaseSync(path);
    assert.deepEqual(
      reopened.prepare('SELECT id, name, applied_at FROM schema_migrations ORDER BY id').all(),
      first,
      'and reopening leaves the record exactly as it was',
    );
    reopened.close();
  } finally {
    cleanup();
  }
});

test('a database with pre-attribution ballots gains their nullable session column', () => {
  const { path, cleanup } = tempDb('quorum-ballot-session-');
  try {
    openQuorum({ path, now: clock }).close();
    const before = new DatabaseSync(path);
    before.exec('ALTER TABLE ballots DROP COLUMN session_id');
    before.exec('DELETE FROM schema_migrations WHERE id = 3');
    before.close();

    openQuorum({ path, now: clock }).close();
    const after = new DatabaseSync(path);
    const columns = after.prepare('PRAGMA table_info(ballots)').all() as { name: string }[];
    assert.ok(columns.some((column) => column.name === 'session_id'));
    assert.equal(after.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE id = 3').get()?.n, 1);
    after.close();
  } finally {
    cleanup();
  }
});

test('a migration that fails leaves neither its change nor its record', () => {
  const db = new DatabaseSync(':memory:');
  const halfway: Migration[] = [
    {
      id: 1,
      name: 'creates a table and then thinks better of it',
      up(db) {
        db.exec('CREATE TABLE half_done (id TEXT PRIMARY KEY)');
        throw new Error('no');
      },
    },
  ];
  assert.throws(() => migrate(db, clock, halfway), /migration 1 .* failed: no/);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'half_done'").get()?.n,
    0,
    'the table went back',
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()?.n, 0, 'and so did the ledger row');
  db.close();
});

test('a rebuild that strands a child row is refused before it commits', () => {
  // The failure mode the whole procedure exists to catch: copy the parent
  // table, miss a row, and every child pointing at it is orphaned. Cheap to
  // check, and the check is what makes "every row survives" a claim rather
  // than a hope.
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE parents (id TEXT PRIMARY KEY);
    CREATE TABLE children (parent_id TEXT NOT NULL REFERENCES parents(id));
    INSERT INTO parents VALUES ('kept'), ('dropped');
    INSERT INTO children VALUES ('kept'), ('dropped');
  `);
  const lossy: Migration[] = [
    {
      id: 1,
      name: 'rebuilds parents and forgets one',
      up(db) {
        db.exec(`
          CREATE TABLE parents_new (id TEXT PRIMARY KEY);
          INSERT INTO parents_new SELECT id FROM parents WHERE id <> 'dropped';
          DROP TABLE parents;
          ALTER TABLE parents_new RENAME TO parents;
        `);
      },
    },
  ];
  assert.throws(() => migrate(db, clock, lossy), /dangling reference\(s\) in children/);
  assert.deepEqual(
    db.prepare('SELECT id FROM parents ORDER BY id').all().map((row) => (row as { id: string }).id),
    ['dropped', 'kept'],
    'and the row it would have dropped is still there',
  );
  db.close();
});
