// The v0 schema. Tables mirror the domain one-to-one (architecture §2), and
// events are derived from these writes rather than being a second source of
// truth — every mutation appends its event in the same transaction.
//
// Only the tables this slice needs exist: deliberations, votes, and decision
// records arrive with the protocol they belong to.

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS participants (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  harness      TEXT NOT NULL,
  repo         TEXT,
  branch       TEXT,
  identified_at INTEGER NOT NULL
);

-- Identity is the pair an agent introduces itself with, so a reconnecting
-- agent resumes its own row — and its own claims — instead of stranding them.
CREATE UNIQUE INDEX IF NOT EXISTS participants_identity ON participants (name, harness);

CREATE TABLE IF NOT EXISTS rooms (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  topic         TEXT,
  -- Rooms are created with their decision rule (requirements 1.1 #5). Nothing
  -- enforces it until deliberations land; it is recorded now so the rule is a
  -- property of the room from the day the room exists.
  decision_rule TEXT NOT NULL,
  created_by    TEXT NOT NULL REFERENCES participants(id),
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS room_members (
  room_id        TEXT NOT NULL REFERENCES rooms(id),
  participant_id TEXT NOT NULL REFERENCES participants(id),
  joined_at      INTEGER NOT NULL,
  PRIMARY KEY (room_id, participant_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id        TEXT NOT NULL REFERENCES rooms(id),
  participant_id TEXT NOT NULL REFERENCES participants(id),
  body           TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_by_room ON messages (room_id, id);

CREATE TABLE IF NOT EXISTS claims (
  id             TEXT PRIMARY KEY,
  participant_id TEXT NOT NULL REFERENCES participants(id),
  repo           TEXT NOT NULL,
  branch         TEXT,
  patterns       TEXT NOT NULL,  -- JSON array of globs
  purpose        TEXT NOT NULL,
  granted_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  -- Closed once, never reopened: a lease that ended is history.
  closed_at      INTEGER,
  closed_reason  TEXT            -- 'released' | 'expired'
);
CREATE INDEX IF NOT EXISTS claims_live ON claims (repo, closed_at, expires_at);

CREATE TABLE IF NOT EXISTS events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  room_id    TEXT,
  payload    TEXT NOT NULL,  -- JSON object
  created_at INTEGER NOT NULL
);
`;
