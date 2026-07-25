// The core domain: participants, rooms, messages, claims, and the event feed.
//
// Transport-free (architecture §5): nothing here imports MCP or HTTP. The MCP
// endpoint adapts these calls, and the human web UI will call the same ones,
// which is what keeps one behavior behind two surfaces.

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { SCHEMA } from './schema.ts';
import { normalizePatterns, PatternError, scopesOverlap } from './glob.ts';

export type DecisionRule = 'majority' | 'unanimity';

export type Participant = {
  id: string;
  name: string;
  harness: string;
  repo: string | null;
  branch: string | null;
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

// Domain errors reach agents as text. Any participant- or caller-authored
// value interpolated into one is JSON-quoted at the throw site, so a room
// named with a newline and a directive cannot read as guidance downstream.
export class QuorumError extends Error {}

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

  function appendEvent(kind: string, roomId: string | null, payload: Record<string, unknown>): void {
    db.prepare('INSERT INTO events (kind, room_id, payload, created_at) VALUES (?, ?, ?, ?)').run(
      kind,
      roomId,
      JSON.stringify(payload),
      now(),
    );
    for (const wake of waiters) wake();
  }

  function requireParticipant(id: string): Participant {
    const row = db.prepare('SELECT * FROM participants WHERE id = ?').get(id) as
      | { id: string; name: string; harness: string; repo: string | null; branch: string | null }
      | undefined;
    if (!row) throw new QuorumError(`unknown participant: ${JSON.stringify(id)} — call identify first`);
    return { id: row.id, name: row.name, harness: row.harness, repo: row.repo, branch: row.branch };
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
      appendEvent('claim_expired', null, { claim: toClaim(row) });
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
    return row?.next ?? null;
  }

  function readEventsAfter(afterSeq: number, limit: number): QuorumEvent[] {
    const rows = db.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?').all(afterSeq, limit) as {
      seq: number;
      kind: string;
      room_id: string | null;
      payload: string;
      created_at: number;
    }[];
    return rows.map((row) => ({
      seq: row.seq,
      kind: row.kind,
      roomId: row.room_id,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
      createdAt: row.created_at,
    }));
  }

  function ttlToExpiry(ttlSeconds: number | undefined): number {
    const ttl = ttlSeconds ?? DEFAULT_TTL_SECONDS;
    if (!Number.isFinite(ttl) || ttl <= 0) throw new QuorumError('ttl_seconds must be a positive number');
    if (ttl > MAX_TTL_SECONDS) {
      throw new QuorumError(`ttl_seconds must not exceed ${MAX_TTL_SECONDS} (12 hours)`);
    }
    return now() + Math.round(ttl * 1000);
  }

  return {
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
        appendEvent('participant_identified', null, { participant, resumed: true });
        return { participant, resumed: true, claims: held };
      }

      const participant: Participant = { id: randomUUID(), name, harness, repo, branch };
      db.prepare(
        'INSERT INTO participants (id, name, harness, repo, branch, identified_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(participant.id, participant.name, participant.harness, participant.repo, participant.branch, now());
      appendEvent('participant_identified', null, { participant, resumed: false });
      return { participant, resumed: false, claims: [] };
    },

    listParticipants(): Participant[] {
      const rows = db.prepare('SELECT * FROM participants ORDER BY identified_at').all() as {
        id: string;
        name: string;
        harness: string;
        repo: string | null;
        branch: string | null;
      }[];
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        harness: row.harness,
        repo: row.repo,
        branch: row.branch,
      }));
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
      appendEvent('room_created', room.id, { room });
      return room;
    },

    listRooms(): (Room & { members: number })[] {
      const rows = db
        .prepare(
          `SELECT r.*, (SELECT COUNT(*) FROM room_members m WHERE m.room_id = r.id) AS members
           FROM rooms r ORDER BY r.created_at`,
        )
        .all() as {
        id: string;
        name: string;
        topic: string | null;
        decision_rule: string;
        created_by: string;
        members: number;
      }[];
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        topic: row.topic,
        decisionRule: row.decision_rule as DecisionRule,
        createdBy: row.created_by,
        members: row.members,
      }));
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
        appendEvent('room_joined', room.id, { room, participant });
      }
      return room;
    },

    postMessage(input: { room: string; participantId: string; body: string }): Message {
      const participant = requireParticipant(input.participantId);
      const room = requireRoom(input.room);
      const member = db
        .prepare('SELECT 1 FROM room_members WHERE room_id = ? AND participant_id = ?')
        .get(room.id, participant.id);
      if (!member) throw new QuorumError(`join ${JSON.stringify(room.name)} before posting to it`);
      const body = input.body?.trim();
      if (!body) throw new QuorumError('message body is required');

      const at = now();
      const result = db
        .prepare('INSERT INTO messages (room_id, participant_id, body, created_at) VALUES (?, ?, ?, ?)')
        .run(room.id, participant.id, body, at);
      const message: Message = {
        id: Number(result.lastInsertRowid),
        roomId: room.id,
        participantId: participant.id,
        body,
        createdAt: at,
      };
      appendEvent('message', room.id, { message, from: participant.name });
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
        created_at: number;
      }[];
      return rows.map((row) => ({
        id: row.id,
        roomId: row.room_id,
        participantId: row.participant_id,
        body: row.body,
        createdAt: row.created_at,
      }));
    },

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
      appendEvent('claim_granted', null, { claim, by: participant.name });
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
      appendEvent('claim_renewed', null, { claim });
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
      appendEvent('claim_released', null, { claim });
      return claim;
    },

    listClaims(input: { repo?: string } = {}): Claim[] {
      return liveClaims(input.repo?.trim() || undefined);
    },

    readEvents(input: { afterSeq?: number; limit?: number } = {}): QuorumEvent[] {
      return readEventsAfter(input.afterSeq ?? 0, Math.min(Math.max(input.limit ?? 100, 1), 500));
    },

    latestSeq(): number {
      const row = db.prepare('SELECT MAX(seq) AS seq FROM events').get() as { seq: number | null } | undefined;
      return row?.seq ?? 0;
    },

    // Cursor long-poll: block until events pass the caller's cursor. The wake
    // deadline is the earlier of the caller's timeout and the next lease
    // expiry, so an agent waiting for a scope to free up is woken by the
    // expiry itself without any background timer existing.
    async waitForEvents(input: { afterSeq: number; timeoutMs?: number }): Promise<QuorumEvent[]> {
      const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 25_000, 0), 120_000);
      const deadline = Date.now() + timeoutMs;

      for (;;) {
        sweepExpired();
        const events = readEventsAfter(input.afterSeq, 100);
        if (events.length > 0) return events;

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
}

export type Quorum = ReturnType<typeof openQuorum>;
