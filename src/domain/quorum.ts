// The core domain: participants, rooms, messages, claims, and the event feed.
//
// Transport-free (architecture §5): nothing here imports MCP or HTTP. The MCP
// endpoint adapts these calls, and the human web UI will call the same ones,
// which is what keeps one behavior behind two surfaces.

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { SCHEMA } from './schema.ts';
import { normalizePatterns, PatternError, scopesOverlap } from './glob.ts';
import { openCommands } from './commands.ts';
import { openDeliberations } from './deliberation.ts';
import { openDms, participantResolver } from './dm.ts';
import { QuorumError } from './errors.ts';

export { QuorumError };

export type DecisionRule = 'majority' | 'unanimity';

export type Participant = {
  id: string;
  name: string;
  harness: string;
  repo: string | null;
  branch: string | null;
  /** Advisory presence set by /status or /blocked (#52); never protocol-load-bearing. */
  status: { text: string; kind: 'status' | 'blocked'; at: number } | null;
};

export type Room = {
  id: string;
  name: string;
  topic: string | null;
  decisionRule: DecisionRule;
  createdBy: string;
};

export type Message = {
  id: number;
  roomId: string;
  participantId: string;
  body: string;
  // Set when the message is a challenge tagged to a deliberation (D4 in
  // docs/deliberation.md). The tag is the whole relationship: deliberation
  // state references messages and never lives in them.
  deliberationId: string | null;
  createdAt: number;
};

export type Claim = {
  id: string;
  participantId: string;
  repo: string;
  branch: string | null;
  patterns: string[];
  purpose: string;
  grantedAt: number;
  expiresAt: number;
};

export type QuorumEvent = {
  seq: number;
  kind: string;
  roomId: string | null;
  // The participant whose action produced this event, or null for the server
  // itself (an expiring lease). A reader compares it to its own id to tell
  // its echo from someone else's news.
  actorId: string | null;
  payload: Record<string, unknown>;
  createdAt: number;
};

export type ClaimGrant = { ok: true; claim: Claim } | { ok: false; conflicts: Claim[] };

export type QuorumOptions = {
  path?: string;
  now?: () => number;
};

const DEFAULT_TTL_SECONDS = 30 * 60;
const MAX_TTL_SECONDS = 12 * 60 * 60;

type ClaimRow = {
  id: string;
  participant_id: string;
  repo: string;
  branch: string | null;
  patterns: string;
  purpose: string;
  granted_at: number;
  expires_at: number;
  closed_at: number | null;
  closed_reason: string | null;
};

export function openQuorum(options: QuorumOptions = {}) {
  const db = new DatabaseSync(options.path ?? ':memory:');
  const now = options.now ?? (() => Date.now());
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);

  // CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so
  // a column added after someone started using quorum never arrives and the
  // next write fails with `table events has no column named …`. Additive
  // migrations run here, on open, in order. v0 only ever adds nullable
  // columns; anything that needs a rewrite gets a real migration story before
  // it lands, not after someone's database refuses to start.
  const addColumn = (table: string, column: string, declaration: string): void => {
    const present = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(
      (row) => row.name === column,
    );
    if (!present) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
  };
  addColumn('events', 'actor_id', 'TEXT');
  addColumn('participants', 'cursor', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('messages', 'deliberation_id', 'TEXT');
  addColumn('events', 'audience', 'TEXT');
  addColumn('participants', 'status', 'TEXT');
  addColumn('participants', 'status_kind', 'TEXT');
  addColumn('participants', 'status_at', 'INTEGER');

  // Everyone blocked in wait_for_events. Appending an event wakes them all;
  // each re-reads from its own cursor, so there is no per-waiter bookkeeping.
  const waiters = new Set<() => void>();

  function toClaim(row: ClaimRow): Claim {
    return {
      id: row.id,
      participantId: row.participant_id,
      repo: row.repo,
      branch: row.branch,
      patterns: JSON.parse(row.patterns) as string[],
      purpose: row.purpose,
      grantedAt: row.granted_at,
      expiresAt: row.expires_at,
    };
  }

  // `audience` is null for the shared feed. Naming participants makes the
  // event reach exactly them and nobody else — not as a rendering choice but
  // at every read below, so a third party cannot learn the event existed.
  // Everyone blocked in waitForEvents still wakes (waking is cheap and keeps
  // the bookkeeping at zero); the audience filter in the re-read is what
  // decides who actually receives it.
  function appendEvent(
    kind: string,
    roomId: string | null,
    payload: Record<string, unknown>,
    actorId: string | null,
    audience: string[] | null = null,
  ): void {
    db.prepare(
      'INSERT INTO events (kind, room_id, actor_id, payload, created_at, audience) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(kind, roomId, actorId, JSON.stringify(payload), now(), audience === null ? null : JSON.stringify(audience));
    for (const wake of waiters) wake();
  }

  type ParticipantRow = {
    id: string;
    name: string;
    harness: string;
    repo: string | null;
    branch: string | null;
    status: string | null;
    status_kind: string | null;
    status_at: number | null;
  };

  function toParticipant(row: ParticipantRow): Participant {
    return {
      id: row.id,
      name: row.name,
      harness: row.harness,
      repo: row.repo,
      branch: row.branch,
      status:
        row.status === null
          ? null
          : { text: row.status, kind: row.status_kind === 'blocked' ? 'blocked' : 'status', at: row.status_at ?? 0 },
    };
  }

  function requireParticipant(id: string): Participant {
    const row = db.prepare('SELECT * FROM participants WHERE id = ?').get(id) as ParticipantRow | undefined;
    if (!row) throw new QuorumError(`unknown participant: ${JSON.stringify(id)} — call identify first`);
    return toParticipant(row);
  }

  function isMember(roomId: string, participantId: string): boolean {
    return (
      db.prepare('SELECT 1 FROM room_members WHERE room_id = ? AND participant_id = ?').get(roomId, participantId) !==
      undefined
    );
  }

  function requireRoom(id: string): Room {
    const row = db.prepare('SELECT * FROM rooms WHERE id = ? OR name = ?').get(id, id) as
      | { id: string; name: string; topic: string | null; decision_rule: string; created_by: string }
      | undefined;
    if (!row) throw new QuorumError(`unknown room: ${JSON.stringify(id)}`);
    return {
      id: row.id,
      name: row.name,
      topic: row.topic,
      decisionRule: row.decision_rule as DecisionRule,
      createdBy: row.created_by,
    };
  }

  // Expiry is computed, never swept by a timer (the Overlap-checked lease
  // pattern): a lease is live while `expires_at` is in the future. This turns
  // the announcement of an expiry — which does need to happen once — into a
  // read-time obligation, so a server that was down for an hour comes back
  // with exactly the claims that are still live.
  function sweepExpired(): void {
    deliberations.sweep();
    const at = now();
    const rows = db
      .prepare('SELECT * FROM claims WHERE closed_at IS NULL AND expires_at <= ?')
      .all(at) as ClaimRow[];
    for (const row of rows) {
      db.prepare('UPDATE claims SET closed_at = ?, closed_reason = ? WHERE id = ?').run(
        row.expires_at,
        'expired',
        row.id,
      );
      appendEvent('claim_expired', null, { claim: toClaim(row) }, null); // nobody acted; the clock did
    }
  }

  function liveClaims(repo?: string): Claim[] {
    sweepExpired();
    const rows = repo
      ? (db
          .prepare('SELECT * FROM claims WHERE closed_at IS NULL AND repo = ? ORDER BY granted_at')
          .all(repo) as ClaimRow[])
      : (db.prepare('SELECT * FROM claims WHERE closed_at IS NULL ORDER BY granted_at').all() as ClaimRow[]);
    return rows.map(toClaim);
  }

  function nextExpiryAt(): number | null {
    const row = db
      .prepare('SELECT MIN(expires_at) AS next FROM claims WHERE closed_at IS NULL')
      .get() as { next: number | null } | undefined;
    const claim = row?.next ?? null;
    // A blocked waiter must also wake for a phase deadline — the voting that
    // opens or the close that lands is somebody's call to vote (1.1 #8).
    const phase = deliberations.nextDeadline();
    if (claim === null) return phase;
    if (phase === null) return claim;
    return Math.min(claim, phase);
  }

  // Every read of the feed goes through here, and `viewer` is the audience
  // filter: a null-audience event reaches everyone; an audience-scoped one
  // reaches only the participants it names. A null viewer — an unidentified
  // observer — gets the shared feed alone. Filtering in SQL keeps the limit
  // honest: a page of events for *you*, not a page of rows minus the ones
  // you were never allowed to see.
  function readEventsAfter(afterSeq: number, limit: number, viewer: string | null): QuorumEvent[] {
    const rows = db
      .prepare(
        `SELECT * FROM events
         WHERE seq > ?
           AND (audience IS NULL OR EXISTS (SELECT 1 FROM json_each(events.audience) WHERE json_each.value = ?))
         ORDER BY seq LIMIT ?`,
      )
      .all(afterSeq, viewer, limit) as {
      seq: number;
      kind: string;
      room_id: string | null;
      actor_id: string | null;
      payload: string;
      created_at: number;
    }[];
    return rows.map((row) => ({
      seq: row.seq,
      kind: row.kind,
      roomId: row.room_id,
      actorId: row.actor_id,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
      createdAt: row.created_at,
    }));
  }

  function latestSeq(): number {
    const row = db.prepare('SELECT MAX(seq) AS seq FROM events').get() as { seq: number | null } | undefined;
    return row?.seq ?? 0;
  }

  function storedCursor(participantId: string): number {
    const row = db.prepare('SELECT cursor FROM participants WHERE id = ?').get(participantId) as
      | { cursor: number }
      | undefined;
    return row?.cursor ?? 0;
  }

  // Counted through the same audience filter as the reads, or the count would
  // promise events the read then refuses to deliver — an agent told "3
  // waiting" must find exactly 3.
  function unseenCount(cursor: number, viewer: string | null): number {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM events
         WHERE seq > ?
           AND (audience IS NULL OR EXISTS (SELECT 1 FROM json_each(events.audience) WHERE json_each.value = ?))`,
      )
      .get(cursor, viewer) as { n: number };
    return row.n;
  }

  // Acknowledgement-advanced, not send-advanced. Recording what we *sent*
  // loses events whenever a response dies in flight: the connection drops
  // after the read, the durable cursor says delivered, and the reconnect
  // skips exactly what never arrived — the failure a durable cursor exists to
  // prevent. So the cursor advances to the `after_seq` a participant brings
  // on its next call, which is proof the previous batch reached it. The cost
  // is that a crash mid-batch replays it, and replay is the side to err on.
  //
  // Monotonic, so a stale or replayed call cannot drag a participant backwards
  // into re-reading what it has already acknowledged.
  function acknowledgeCursor(participantId: string | null, upTo: number): void {
    if (participantId === null) return; // an unidentified observer owns no cursor
    db.prepare('UPDATE participants SET cursor = ? WHERE id = ? AND cursor < ?').run(upTo, participantId, upTo);
  }

  function ttlToExpiry(ttlSeconds: number | undefined): number {
    const ttl = ttlSeconds ?? DEFAULT_TTL_SECONDS;
    if (!Number.isFinite(ttl) || ttl <= 0) throw new QuorumError('ttl_seconds must be a positive number');
    if (ttl > MAX_TTL_SECONDS) {
      throw new QuorumError(`ttl_seconds must not exceed ${MAX_TTL_SECONDS} (12 hours)`);
    }
    return now() + Math.round(ttl * 1000);
  }

  // The deliberation protocol composes over the same db and feed; the Deps
  // object is the entire seam (docs/deliberation.md §8).
  const deliberations = openDeliberations({ db, now, appendEvent, requireParticipant, requireRoom, isMember });

  // Direct messages compose the same way; their events are audience-scoped
  // through the appendEvent they are handed (docs/deliberation.md §8 seams).
  const dms = openDms({ db, now, appendEvent, requireParticipant });

  const api = {
    close(): void {
      db.close();
    },

    // Identity is (name, harness), not a fresh UUID per connection. An agent
    // that reconnects — after a dropped session, a restarted harness, or a
    // restarted server — is the same participant, and so still holds and can
    // release its own claims. A new UUID each time would strand every live
    // lease behind its TTL, which is the failure this product exists to stop.
    identify(input: { name: string; harness: string; repo?: string; branch?: string }): {
      participant: Participant;
      resumed: boolean;
      claims: Claim[];
      cursor: number;
      unseen: number;
    } {
      const name = input.name?.trim();
      const harness = input.harness?.trim();
      if (!name) throw new QuorumError('name is required');
      if (!harness) throw new QuorumError('harness is required');
      const repo = input.repo?.trim() || null;
      const branch = input.branch?.trim() || null;

      const existing = db.prepare('SELECT * FROM participants WHERE name = ? AND harness = ?').get(name, harness) as
        | { id: string }
        | undefined;

      if (existing) {
        // Where it is working can change between sessions; who it is cannot.
        db.prepare('UPDATE participants SET repo = ?, branch = ?, identified_at = ? WHERE id = ?').run(
          repo,
          branch,
          now(),
          existing.id,
        );
        const participant = requireParticipant(existing.id);
        const held = liveClaims().filter((claim) => claim.participantId === participant.id);
        // The cursor is read *before* this identify's own event is appended,
        // so an agent is never told it missed its own reconnection.
        const cursor = storedCursor(participant.id);
        const unseen = unseenCount(cursor, participant.id);
        appendEvent('participant_identified', null, { participant, resumed: true }, participant.id);
        return { participant, resumed: true, claims: held, cursor, unseen };
      }

      // A newcomer starts at the head: arriving is not the same as having
      // missed everything that ever happened.
      const head = latestSeq();
      const participant: Participant = { id: randomUUID(), name, harness, repo, branch, status: null };
      db.prepare(
        'INSERT INTO participants (id, name, harness, repo, branch, identified_at, cursor) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(
        participant.id,
        participant.name,
        participant.harness,
        participant.repo,
        participant.branch,
        now(),
        head,
      );
      appendEvent('participant_identified', null, { participant, resumed: false }, participant.id);
      return { participant, resumed: false, claims: [], cursor: head, unseen: 0 };
    },

    listParticipants(): Participant[] {
      const rows = db.prepare('SELECT * FROM participants ORDER BY identified_at').all() as ParticipantRow[];
      return rows.map(toParticipant);
    },

    createRoom(input: { name: string; topic?: string; decisionRule?: DecisionRule; by: string }): Room {
      const creator = requireParticipant(input.by);
      const name = input.name?.trim();
      if (!name) throw new QuorumError('room name is required');
      const rule = input.decisionRule ?? 'majority';
      if (rule !== 'majority' && rule !== 'unanimity') {
        throw new QuorumError("decision_rule must be 'majority' or 'unanimity'");
      }
      if (db.prepare('SELECT id FROM rooms WHERE name = ?').get(name)) {
        throw new QuorumError(`room already exists: ${JSON.stringify(name)}`);
      }
      const room: Room = {
        id: randomUUID(),
        name,
        topic: input.topic?.trim() || null,
        decisionRule: rule,
        createdBy: creator.id,
      };
      db.prepare(
        'INSERT INTO rooms (id, name, topic, decision_rule, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(room.id, room.name, room.topic, room.decisionRule, room.createdBy, now());
      db.prepare('INSERT INTO room_members (room_id, participant_id, joined_at) VALUES (?, ?, ?)').run(
        room.id,
        creator.id,
        now(),
      );
      appendEvent('room_created', room.id, { room }, creator.id);
      return room;
    },

    listRooms(): (Room & { members: number; memberIds: string[] })[] {
      // Member ids ride along (#56) so one read paints occupants everywhere;
      // the count is derived from the list, never tracked beside it.
      const rows = db
        .prepare(
          `SELECT r.*, (SELECT json_group_array(participant_id) FROM
             (SELECT participant_id FROM room_members m WHERE m.room_id = r.id ORDER BY m.joined_at)) AS member_ids
           FROM rooms r ORDER BY r.created_at`,
        )
        .all() as {
        id: string;
        name: string;
        topic: string | null;
        decision_rule: string;
        created_by: string;
        member_ids: string;
      }[];
      return rows.map((row) => {
        const memberIds = JSON.parse(row.member_ids) as string[];
        return {
          id: row.id,
          name: row.name,
          topic: row.topic,
          decisionRule: row.decision_rule as DecisionRule,
          createdBy: row.created_by,
          members: memberIds.length,
          memberIds,
        };
      });
    },

    // Who is in a room, in join order (#56): the /who command and the
    // occupants panel ask this one question.
    listMembers(input: { room: string }): Participant[] {
      const room = requireRoom(input.room);
      const rows = db
        .prepare(
          `SELECT p.* FROM participants p JOIN room_members m ON m.participant_id = p.id
           WHERE m.room_id = ? ORDER BY m.joined_at`,
        )
        .all(room.id) as ParticipantRow[];
      return rows.map(toParticipant);
    },

    joinRoom(input: { room: string; participantId: string }): Room {
      const participant = requireParticipant(input.participantId);
      const room = requireRoom(input.room);
      const already = db
        .prepare('SELECT 1 FROM room_members WHERE room_id = ? AND participant_id = ?')
        .get(room.id, participant.id);
      if (!already) {
        db.prepare('INSERT INTO room_members (room_id, participant_id, joined_at) VALUES (?, ?, ?)').run(
          room.id,
          participant.id,
          now(),
        );
        appendEvent('room_joined', room.id, { room, participant }, participant.id);
      }
      return room;
    },

    postMessage(input: { room: string; participantId: string; body: string; deliberationId?: string }): Message {
      const participant = requireParticipant(input.participantId);
      const room = requireRoom(input.room);
      if (!isMember(room.id, participant.id)) {
        throw new QuorumError(`join ${JSON.stringify(room.name)} before posting to it`);
      }
      const body = input.body?.trim();
      if (!body) throw new QuorumError('message body is required');
      // A challenge is this same message with a tag (deliberation.md D4); the
      // protocol's only involvement is the phase gate.
      const deliberationId = input.deliberationId ?? null;
      if (deliberationId !== null) deliberations.assertChallengeOpen(deliberationId, room.id);

      const at = now();
      const result = db
        .prepare(
          'INSERT INTO messages (room_id, participant_id, body, deliberation_id, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(room.id, participant.id, body, deliberationId, at);
      const message: Message = {
        id: Number(result.lastInsertRowid),
        roomId: room.id,
        participantId: participant.id,
        body,
        deliberationId,
        createdAt: at,
      };
      appendEvent('message', room.id, { message, from: participant.name }, participant.id);
      return message;
    },

    readMessages(input: { room: string; afterId?: number; limit?: number }): Message[] {
      const room = requireRoom(input.room);
      const limit = Math.min(Math.max(input.limit ?? 50, 1), 500);
      const rows = db
        .prepare('SELECT * FROM messages WHERE room_id = ? AND id > ? ORDER BY id LIMIT ?')
        .all(room.id, input.afterId ?? 0, limit) as {
        id: number;
        room_id: string;
        participant_id: string;
        body: string;
        deliberation_id: string | null;
        created_at: number;
      }[];
      return rows.map((row) => ({
        id: row.id,
        roomId: row.room_id,
        participantId: row.participant_id,
        body: row.body,
        deliberationId: row.deliberation_id,
        createdAt: row.created_at,
      }));
    },

    // Direct messages (requirements 1.1 #7), composed from src/domain/dm.ts.
    // The dm_message event is audience-scoped to its pair: the counterpart's
    // wait_for_events wakes (1.1 #8) while every other reader — participant,
    // observer, or the shared SSE stream — sees neither the message nor that
    // one was sent. The filter lives in readEventsAfter above.
    sendDm: dms.sendDm,
    readDms: dms.readDms,
    listDmThreads: dms.listDmThreads,

    // The Overlap-checked lease. A grant is refused when a live lease held by
    // someone else covers any of the same paths — and the refusal carries the
    // holder, so the caller can go talk to them instead of guessing.
    claimScope(input: {
      participantId: string;
      repo: string;
      patterns?: string[];
      branch?: string;
      purpose: string;
      ttlSeconds?: number;
    }): ClaimGrant {
      const participant = requireParticipant(input.participantId);
      const repo = input.repo?.trim();
      if (!repo) throw new QuorumError('repo is required');
      const purpose = input.purpose?.trim();
      if (!purpose) throw new QuorumError('purpose is required — a claim nobody can read is not coordination');
      let patterns: string[];
      try {
        patterns = normalizePatterns(input.patterns);
      } catch (error) {
        throw error instanceof PatternError ? new QuorumError(error.message) : error;
      }
      const branch = input.branch?.trim() || null;
      const expiresAt = ttlToExpiry(input.ttlSeconds);

      const conflicts = liveClaims(repo).filter((held) => {
        if (held.participantId === participant.id) return false; // your own lease never blocks you
        // Work on different branches lives in different worktrees, so it does
        // not collide. A claim with no branch means "any branch" and does.
        if (branch !== null && held.branch !== null && branch !== held.branch) return false;
        return scopesOverlap(patterns, held.patterns);
      });
      if (conflicts.length > 0) return { ok: false, conflicts };

      const claim: Claim = {
        id: randomUUID(),
        participantId: participant.id,
        repo,
        branch,
        patterns,
        purpose,
        grantedAt: now(),
        expiresAt,
      };
      db.prepare(
        `INSERT INTO claims (id, participant_id, repo, branch, patterns, purpose, granted_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        claim.id,
        claim.participantId,
        claim.repo,
        claim.branch,
        JSON.stringify(claim.patterns),
        claim.purpose,
        claim.grantedAt,
        claim.expiresAt,
      );
      appendEvent('claim_granted', null, { claim, by: participant.name }, participant.id);
      return { ok: true, claim };
    },

    renewClaim(input: { claimId: string; participantId: string; ttlSeconds?: number }): Claim {
      sweepExpired();
      const row = db.prepare('SELECT * FROM claims WHERE id = ?').get(input.claimId) as ClaimRow | undefined;
      if (!row) throw new QuorumError(`unknown claim: ${JSON.stringify(input.claimId)}`);
      if (row.participant_id !== input.participantId) throw new QuorumError('only the holder can renew a claim');
      if (row.closed_at !== null) throw new QuorumError('claim has already ended — take a new one');

      const expiresAt = ttlToExpiry(input.ttlSeconds);
      db.prepare('UPDATE claims SET expires_at = ? WHERE id = ?').run(expiresAt, input.claimId);
      const claim = { ...toClaim(row), expiresAt };
      appendEvent('claim_renewed', null, { claim }, input.participantId);
      return claim;
    },

    // Idempotent: a retried release (the first response was lost) closes
    // nothing further and announces nothing further. A lease closes once, so
    // consumers of the feed see exactly one claim_released per claim.
    releaseClaim(input: { claimId: string; participantId: string }): Claim {
      const row = db.prepare('SELECT * FROM claims WHERE id = ?').get(input.claimId) as ClaimRow | undefined;
      if (!row) throw new QuorumError(`unknown claim: ${JSON.stringify(input.claimId)}`);
      if (row.participant_id !== input.participantId) throw new QuorumError('only the holder can release a claim');
      const claim = toClaim(row);
      if (row.closed_at !== null) return claim;

      const update = db
        .prepare('UPDATE claims SET closed_at = ?, closed_reason = ? WHERE id = ? AND closed_at IS NULL')
        .run(now(), 'released', input.claimId);
      if (update.changes === 0n || update.changes === 0) return claim;
      appendEvent('claim_released', null, { claim }, input.participantId);
      return claim;
    },

    listClaims(input: { repo?: string } = {}): Claim[] {
      return liveClaims(input.repo?.trim() || undefined);
    },

    // `viewerId` widens the read to the audience-scoped events addressed to
    // that participant; without it this is the shared feed alone.
    readEvents(input: { afterSeq?: number; limit?: number; viewerId?: string | null } = {}): QuorumEvent[] {
      return readEventsAfter(input.afterSeq ?? 0, Math.min(Math.max(input.limit ?? 100, 1), 500), input.viewerId ?? null);
    },

    latestSeq(): number {
      return latestSeq();
    },

    // What a participant has acknowledged, and how much waits past it.
    cursorFor(participantId: string): { cursor: number; unseen: number } {
      requireParticipant(participantId); // unknown ids are caller bugs, not empty results
      const cursor = storedCursor(participantId);
      return { cursor, unseen: unseenCount(cursor, participantId) };
    },

    // The deliberation protocol (docs/deliberation.md, requirements 1.1
    // #3–#6), composed from src/domain/deliberation.ts.
    propose: deliberations.propose,
    closeChallenges: deliberations.closeChallenges,
    vote: deliberations.vote,
    getDeliberation: deliberations.getDeliberation,
    listOpenDeliberations: deliberations.listOpenDeliberations,
    listDecisions: deliberations.listDecisions,
    getDecision: deliberations.getDecision,

    // Cursor long-poll: block until events pass the caller's cursor. The wake
    // deadline is the earlier of the caller's timeout and the next lease
    // expiry, so an agent waiting for a scope to free up is woken by the
    // expiry itself without any background timer existing.
    // `participantId` is who is consuming — it acknowledges the cursor and is
    // the audience viewer. `viewerId` is for a reader that watches *as* a
    // participant without consuming for them (the SSE stream: watching a page
    // must not advance the durable cursor, but the DM screen still has to see
    // the DMs addressed to its person). When both are given, participantId
    // wins; it is the stronger claim.
    async waitForEvents(input: {
      afterSeq: number;
      timeoutMs?: number;
      participantId?: string | null;
      viewerId?: string | null;
    }): Promise<QuorumEvent[]> {
      const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 25_000, 0), 120_000);
      const deadline = Date.now() + timeoutMs;
      const viewer = input.participantId ?? input.viewerId ?? null;
      // Coming back for events after N is the acknowledgement that everything
      // through N arrived.
      acknowledgeCursor(input.participantId ?? null, input.afterSeq);

      for (;;) {
        sweepExpired();
        const events = readEventsAfter(input.afterSeq, 100, viewer);
        if (events.length > 0) return events; // recorded when the caller comes back for more

        const remaining = deadline - Date.now();
        if (remaining <= 0) return [];

        const expiry = nextExpiryAt();
        const untilExpiry = expiry === null ? remaining : Math.max(0, expiry - now()) + 1;
        await new Promise<void>((resolve) => {
          const wake = () => {
            clearTimeout(timer);
            waiters.delete(wake);
            resolve();
          };
          const timer = setTimeout(wake, Math.min(remaining, untilExpiry));
          waiters.add(wake);
        });
      }
    },
  };

  // Room commands (#52) compose last: /room and /list reach back through the
  // api so a command and its tool twin are one implementation.
  const commands = openCommands({
    db, now, appendEvent, requireParticipant, requireRoom, isMember,
    resolveParticipant: participantResolver(db, requireParticipant),
    createRoom: (input) => api.createRoom(input),
    listRooms: () => api.listRooms(),
    listMembers: (input) => api.listMembers(input),
    postMessage: (input) => api.postMessage(input),
  });

  // The chat write path: commands execute (#52), everything else posts.
  return { ...api, post: commands.post.bind(commands) };
}

export type Quorum = ReturnType<typeof openQuorum>;
