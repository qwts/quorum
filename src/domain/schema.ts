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
  cursor       INTEGER NOT NULL DEFAULT 0,
  -- Advisory presence (#52 /status, #17): what this participant says it is
  -- doing. Never load-bearing for the protocol — a deliberation must not wait
  -- on anyone's status. kind is 'status' | 'blocked'.
  status       TEXT,
  status_kind  TEXT,
  status_at    INTEGER,
  -- Which agent identity this participant is, once one is authenticated
  -- (ADR-0001). NULL is v0: a self-asserted (name, harness) with nothing
  -- behind it. Claims, cursors, and DMs hang off participants and are
  -- untouched by this column.
  principal_id TEXT REFERENCES principals(id)
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
CREATE INDEX IF NOT EXISTS decisions_by_room ON decisions (room_id, closed_at);

-- A DM thread is its participant pair, canonically ordered (low_id < high_id),
-- so sending to the same person from any connection, session, or server
-- lifetime resumes the one thread (requirements 1.1 #7, resume-by-identity-
-- pair). The thread row exists so messages have something durable to hang off;
-- it carries no state of its own.
CREATE TABLE IF NOT EXISTS dm_threads (
  id         TEXT PRIMARY KEY,
  low_id     TEXT NOT NULL REFERENCES participants(id),
  high_id    TEXT NOT NULL REFERENCES participants(id),
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS dm_threads_pair ON dm_threads (low_id, high_id);

CREATE TABLE IF NOT EXISTS dm_messages (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id      TEXT NOT NULL REFERENCES dm_threads(id),
  participant_id TEXT NOT NULL REFERENCES participants(id),
  body           TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS dm_messages_by_thread ON dm_messages (thread_id, id);

-- Identity is a derivation tree rooted at a human account (ADR-0001,
-- docs/design/agent-identity.md §2): account → principal → grant → session.
-- Authority only attenuates downward, attribution reads upward, and revoking
-- a node revokes its subtree. Phase 1 fills the tree from the operator's own
-- machine; Phase 3 fills provider/subject in when humans sign in with OIDC.
CREATE TABLE IF NOT EXISTS accounts (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  provider   TEXT,            -- OIDC issuer, once humans sign in (design §5)
  subject    TEXT,            -- that provider's subject for this human
  created_at INTEGER NOT NULL
);

-- An agent identity. Sponsored, never self-registered (design §5): it exists
-- because an account vouched for it, and that account holds the revocation
-- switch. Revoking a principal revokes every grant beneath it.
CREATE TABLE IF NOT EXISTS principals (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS principals_name ON principals (name);

-- One agent-harness pairing's credential. Only the SHA-256 hash of the token
-- is stored: the secret is shown once, at mint, and a database someone reads
-- later holds nothing that can be replayed. The scopes column is one word in
-- Phase 1 ('participant' — full participant rights); the vocabulary is
-- Phase 2's, and this column is where it lands.
CREATE TABLE IF NOT EXISTS grants (
  id           TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  token_hash   TEXT NOT NULL,
  scopes       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER,
  revoked_at   INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS grants_token ON grants (token_hash);

-- What a grant is good for: opening exactly one session (design §4.1). Every
-- action attributes to (principal, session), never to the principal alone.
-- The asserted_ columns are what the agent said about itself — data, never
-- authority, and never read by anything that decides what a caller may do.
CREATE TABLE IF NOT EXISTS sessions (
  id                    TEXT PRIMARY KEY,
  grant_id              TEXT NOT NULL REFERENCES grants(id),
  started_at            INTEGER NOT NULL,
  last_seen_at          INTEGER NOT NULL,
  ended_at              INTEGER,
  ended_reason          TEXT,           -- 'superseded' | 'revoked'
  source                TEXT NOT NULL,  -- the transport that established it
  user_agent            TEXT,
  asserted_conversation TEXT,
  asserted_start        TEXT
);
CREATE INDEX IF NOT EXISTS sessions_live ON sessions (grant_id, ended_at, last_seen_at);

CREATE TABLE IF NOT EXISTS events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  room_id    TEXT,
  -- Who caused it, or NULL when the server did (a lease expiring on its own).
  -- Consumers need this to tell an answer from their own echo.
  actor_id   TEXT,
  payload    TEXT NOT NULL,  -- JSON object
  created_at INTEGER NOT NULL,
  -- NULL for the shared feed. A JSON array of participant ids makes the event
  -- audience-scoped: delivered only to those participants, invisible —
  -- content and existence both — to every other reader (issue #42, the
  -- precedent v1 authentication builds on).
  audience   TEXT
);
`;
