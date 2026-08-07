// Schema migrations: numbered, recorded, applied once, in one ordered list.
//
// `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so
// every change after the first release needs somewhere to live. Until #96 that
// somewhere was a run of guarded `addColumn` calls in `openQuorum`, which
// works for exactly one kind of change — adding a nullable column — and the
// comment there reserved the rest: anything needing a rewrite gets a real
// migration story before it lands, not after someone's database refuses to
// start. Dropping the inline `UNIQUE` on `rooms.name` (ADR-0002 §6) is that
// change, because SQLite implements an inline `UNIQUE` as an implicit index it
// will not let you drop. The table has to be rebuilt.
//
// The mechanism, and the three rules that keep it honest:
//
//   1. **Ids are permanent.** A migration's id is its name in every database
//      that ever applied it. Never renumber, never reuse, never reorder.
//   2. **A migration's SQL is frozen.** It says what the schema looked like
//      then, not what `schema.ts` says now — editing an applied migration
//      changes history for new databases only, and the two shapes drift
//      apart in silence. `tests/migrate.test.ts` proves they have not.
//   3. **Every body guards on what it is about to change.** The ledger is the
//      gate, but the guard is what lets one list serve three kinds of
//      database: a brand-new one, where `schema.ts` has already delivered the
//      result and every migration finds nothing to do; one from before the
//      ledger existed, which runs the whole list; and one already current.
//
// These run *before* `schema.ts` is applied, against whatever the database
// happens to be — so a migration never trips over a shape a later release
// introduced, and `CREATE TABLE IF NOT EXISTS` afterwards is what fills in
// whatever a new database still lacks.
//
// Each migration runs inside its own transaction with foreign keys off — the
// SQLite-sanctioned 12-step `ALTER TABLE` procedure — and `foreign_key_check`
// runs before the commit, so a rebuild that stranded a child row fails instead
// of landing.

import type { DatabaseSync } from 'node:sqlite';

export type Migration = {
  /** Permanent. The ledger stores it; see rule 1 above. */
  id: number;
  /** For the ledger and for the person reading it two years from now. */
  name: string;
  up: (db: DatabaseSync) => void;
};

const LEDGER = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
`;

/**
 * True when the table exists. A migration runs before schema.ts, so on a new
 * database the table it is about to change is simply not there yet — and there
 * is nothing to do, because schema.ts is about to create it in the shape this
 * migration would have produced.
 */
function hasTable(db: DatabaseSync, table: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}

/** True when `table` already has `column`. The guard every additive step uses. */
function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some((row) => row.name === column);
}

function addColumn(db: DatabaseSync, table: string, column: string, declaration: string): void {
  if (!hasTable(db, table) || hasColumn(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'baseline: the additive columns that shipped before this ledger existed',
    // One entry rather than ten because that is how they shipped — as a set of
    // guarded steps applied together on open, with nothing recording which of
    // them had run. Splitting them now would invent a per-column history no
    // database can attest to. Everything after this line is numbered one
    // change at a time.
    up(db) {
      addColumn(db, 'events', 'actor_id', 'TEXT');
      addColumn(db, 'participants', 'cursor', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'messages', 'deliberation_id', 'TEXT');
      addColumn(db, 'events', 'audience', 'TEXT');
      addColumn(db, 'participants', 'status', 'TEXT');
      addColumn(db, 'participants', 'status_kind', 'TEXT');
      addColumn(db, 'participants', 'status_at', 'INTEGER');
      addColumn(db, 'participants', 'principal_id', 'TEXT REFERENCES principals(id)');
      addColumn(db, 'events', 'session_id', 'TEXT');
      addColumn(db, 'accounts', 'revoked_at', 'INTEGER');
    },
  },
  {
    id: 2,
    name: 'rooms: visibility, and name uniqueness scoped to the listed tiers',
    // The first non-additive change (ADR-0002 §6, docs/design/authority.md
    // §6.2). `name TEXT NOT NULL UNIQUE` is an implicit index SQLite will not
    // drop, so the table is rebuilt: create, copy, drop, rename. The runner
    // supplies the transaction, the foreign keys being off, and the
    // `foreign_key_check` that proves messages, members, deliberations, and
    // decisions still point at rooms that exist.
    //
    // Every existing room becomes `public`, which is what they all were: the
    // instance-wide uniqueness they were created under is exactly the rule
    // `rooms_listed_name` keeps for them.
    up(db) {
      // Nothing to rebuild in a database that has no rooms table yet (a new
      // one, which schema.ts is about to create in this shape) or one already
      // carrying the column.
      if (!hasTable(db, 'rooms') || hasColumn(db, 'rooms', 'visibility')) return;
      db.exec(`
        CREATE TABLE rooms_rebuilt (
          id            TEXT PRIMARY KEY,
          name          TEXT NOT NULL,
          topic         TEXT,
          decision_rule TEXT NOT NULL,
          created_by    TEXT NOT NULL REFERENCES participants(id),
          created_at    INTEGER NOT NULL,
          visibility    TEXT NOT NULL DEFAULT 'public'
            CHECK (visibility IN ('public', 'private', 'exclusive'))
        );
        INSERT INTO rooms_rebuilt (id, name, topic, decision_rule, created_by, created_at, visibility)
          SELECT id, name, topic, decision_rule, created_by, created_at, 'public' FROM rooms;
        DROP TABLE rooms;
        ALTER TABLE rooms_rebuilt RENAME TO rooms;
        CREATE UNIQUE INDEX IF NOT EXISTS rooms_listed_name ON rooms (name) WHERE visibility <> 'exclusive';
      `);
    },
  },
  {
    id: 3,
    name: 'ballots: retain the session behind the surviving cast',
    up(db) {
      addColumn(db, 'ballots', 'session_id', 'TEXT REFERENCES sessions(id)');
    },
  },
];

/**
 * Apply every migration this database has not recorded, in id order. Called on
 * open, before anything reads or writes — a database that cannot be brought up
 * to date must fail loudly here rather than at the first query that trips over
 * the shape it expected.
 */
export function migrate(db: DatabaseSync, now: () => number, migrations: Migration[] = MIGRATIONS): void {
  db.exec(LEDGER);
  const applied = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as { id: number }[]).map((row) => row.id),
  );

  for (const migration of [...migrations].sort((a, b) => a.id - b.id)) {
    if (applied.has(migration.id)) continue;

    // `PRAGMA foreign_keys` is a connection setting and a no-op inside a
    // transaction, so it toggles out here — step 1 and step 12 of the
    // sanctioned rebuild procedure, around the BEGIN rather than inside it.
    const enforcing = (db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys === 1;
    if (enforcing) db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      migration.up(db);
      // Recorded in the same transaction as the change it records. A ledger
      // that could commit without its migration — or the reverse — is worse
      // than no ledger, because it is believed.
      db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(
        migration.id,
        migration.name,
        now(),
      );
      const violations = db.prepare('PRAGMA foreign_key_check').all() as { table: string }[];
      if (violations.length > 0) {
        const tables = [...new Set(violations.map((row) => row.table))].join(', ');
        throw new Error(`migration ${migration.id} left ${violations.length} dangling reference(s) in ${tables}`);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${migration.id} (${migration.name}) failed: ${(error as Error).message}`, {
        cause: error,
      });
    } finally {
      if (enforcing) db.exec('PRAGMA foreign_keys = ON');
    }
  }
}
