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
  identified_at INTEGER NOT NULL,
  -- How far this participant has consumed the feed. Owned by the participant
  -- rather than the connection, so a reconnect resumes instead of skipping
  -- (issue #11). Advances only when events are handed over.
  cursor       INTEGER NOT NULL DEFAULT 0
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

-- The deliberation protocol (docs/deliberation.md). The eligible roster is
-- frozen at propose (D3); the phase deadline lives on the deliberation, never
-- on a participant (D2); vote_ttl is fixed at propose so the voting window is
-- known before anyone casts.
CREATE TABLE IF NOT EXISTS deliberations (
  id            TEXT PRIMARY KEY,
  room_id       TEXT NOT NULL REFERENCES rooms(id),
  convener_id   TEXT NOT NULL REFERENCES participants(id),
  question      TEXT NOT NULL,
  options       TEXT NOT NULL,  -- JSON array of option strings
  eligible      TEXT NOT NULL,  -- JSON array of participant ids, frozen at propose
  phase         TEXT NOT NULL,  -- 'challenging' | 'voting' | 'converged' | 'failed'
  phase_ends_at INTEGER,        -- deadline of the OPEN phase; NULL once closed
  vote_ttl      INTEGER NOT NULL, -- milliseconds; fixed at propose
  created_at    INTEGER NOT NULL,
  closed_at     INTEGER
);
CREATE INDEX IF NOT EXISTS deliberations_open ON deliberations (phase, phase_ends_at);

-- One ballot per voter per deliberation; a re-cast replaces (D6). Dissent is
-- stored verbatim — never trimmed, never rewritten (requirements 1.1 #4).
CREATE TABLE IF NOT EXISTS ballots (
  deliberation_id TEXT NOT NULL REFERENCES deliberations(id),
  participant_id  TEXT NOT NULL REFERENCES participants(id),
  choice          INTEGER NOT NULL,
  dissent         TEXT,
  cast_at         INTEGER NOT NULL,
  PRIMARY KEY (deliberation_id, participant_id)
);

-- Written exactly once, at close, in the same transaction as the phase change
-- and its event (D9). The record column is the immutable snapshot the product
-- exists to keep.
CREATE TABLE IF NOT EXISTS decisions (
  deliberation_id TEXT PRIMARY KEY REFERENCES deliberations(id),
  room_id         TEXT NOT NULL REFERENCES rooms(id),
  outcome         TEXT NOT NULL,  -- 'converged' | 'failed'
  chosen          INTEGER,        -- option index; NULL when failed
  failure_kind    TEXT,           -- 'rule_unmet' | 'quorum_absent'; NULL when converged
  reason          TEXT NOT NULL,
  record          TEXT NOT NULL,  -- JSON snapshot: question, options, rule, roster, ballots, challenges, tally
  closed_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  room_id    TEXT,
  -- Who caused it, or NULL when the server did (a lease expiring on its own).
  -- Consumers need this to tell an answer from their own echo.
  actor_id   TEXT,
  payload    TEXT NOT NULL,  -- JSON object
  created_at INTEGER NOT NULL
);
`;
