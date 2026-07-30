// Sessions: what a credential is actually good for (docs/design/agent-identity.md
// §4), and the attribution every action row carries.
//
// A grant opens a session, and a session — not the principal — is what an
// action belongs to (§4.1): an action taken with a stolen credential lands in
// its own session node, with its own id, start time, and origin, so an
// operator reads a distinct record instead of chasing ghosts through the
// victim's transcript. §4.2 is the other half — one live session per grant, so
// theft *during* a live session is refused outright.
//
// Split from identity.ts because the two answer different questions: "is this
// credential good" and "who is acting right now".

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/** How long a session may be silent before another may take its grant (§4.2). */
export const DEFAULT_SESSION_GRACE_MS = 60_000;

export type IdentitySession = { id: string; grantId: string; startedAt: number; lastSeenAt: number; source: string };

/** A refusal is words, because the caller has to be able to act on it. */
export type Refused = { ok: false; refusal: string };
export type Established = { ok: true; session: IdentitySession; superseded: string[] };

/** Everything identity needs from the host domain, and nothing more. */
export type Deps = {
  db: DatabaseSync;
  now: () => number;
  appendEvent: (
    kind: string,
    roomId: string | null,
    payload: Record<string, unknown>,
    actorId: string | null,
    audience?: string[] | null,
  ) => void;
};

type SessionRow = {
  id: string; grant_id: string; started_at: number; last_seen_at: number;
  ended_at: number | null; ended_reason: string | null; source: string;
  asserted_conversation: string | null; asserted_start: string | null;
};

export type SessionRecord = IdentitySession & {
  endedAt: number | null;
  endedReason: string | null;
  assertedConversation: string | null;
  assertedStart: string | null;
};

const seconds = (ms: number): number => Math.max(1, Math.round(ms / 1000));

export function openSessions(deps: Deps) {
  const { db, now, appendEvent } = deps;

  function toSession(row: SessionRow): IdentitySession {
    return {
      id: row.id,
      grantId: row.grant_id,
      startedAt: row.started_at,
      lastSeenAt: row.last_seen_at,
      source: row.source,
    };
  }

  function liveRows(grantId: string): SessionRow[] {
    return db
      .prepare('SELECT * FROM sessions WHERE grant_id = ? AND ended_at IS NULL ORDER BY started_at, rowid')
      .all(grantId) as SessionRow[];
  }

  function end(id: string, reason: string): void {
    db.prepare('UPDATE sessions SET ended_at = ?, ended_reason = ? WHERE id = ? AND ended_at IS NULL').run(
      now(),
      reason,
      id,
    );
  }

  /**
   * Establish a session on a grant: the moment attribution starts.
   *
   * Refused while another session on the grant is live — which is what makes
   * theft of a credential during a live session prevented rather than merely
   * noticed. Past the grace window the silent session is superseded instead,
   * so a crashed harness resumes without needing a human. Either way the feed
   * carries it: a second session on one grant is the sponsoring human's
   * business, and their revocation is one action away.
   */
  function establish(input: {
    grantId: string;
    source: string;
    userAgent?: string | null;
    graceMs?: number;
  }): Established | Refused {
    const graceMs = input.graceMs ?? DEFAULT_SESSION_GRACE_MS;
    const at = now();
    const open = liveRows(input.grantId);
    const live = open.filter((row) => at - row.last_seen_at <= graceMs);
    if (live.length > 0) {
      const held = live[live.length - 1]!;
      appendEvent(
        'session_refused',
        null,
        {
          grantId: input.grantId,
          liveSessionId: held.id,
          attemptedSource: input.source,
          silentForMs: at - held.last_seen_at,
          graceMs,
        },
        null,
      );
      return {
        ok: false,
        refusal:
          `that credential already holds a live session (${held.id}), last seen ${seconds(at - held.last_seen_at)}s ago` +
          ` — a grant carries one session at a time. It frees after ${seconds(graceMs)}s of silence, or at once when that` +
          ` session disconnects cleanly. If you need two at the same time — a second harness, or a script beside it —` +
          ` have the operator mint a second token, so the two are told apart in the record. If this was not you, the` +
          ` operator can revoke the grant now.`,
      };
    }

    const session: IdentitySession = {
      id: randomUUID(),
      grantId: input.grantId,
      startedAt: at,
      lastSeenAt: at,
      source: input.source,
    };
    db.prepare(
      'INSERT INTO sessions (id, grant_id, started_at, last_seen_at, source, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(session.id, session.grantId, at, at, session.source, input.userAgent ?? null);
    const superseded: string[] = [];
    for (const stale of open) {
      end(stale.id, 'superseded');
      superseded.push(stale.id);
      appendEvent(
        'session_superseded',
        null,
        {
          grantId: input.grantId,
          endedSessionId: stale.id,
          sessionId: session.id,
          silentForMs: at - stale.last_seen_at,
          graceMs,
        },
        null,
      );
    }
    return { ok: true, session, superseded };
  }

  return {
    establish,

    /**
     * The PAT-over-HTTP path (§3.2): the first authenticated request mints the
     * session and every later one rides it, so `(principal, session)` holds on
     * every credentialed surface, not only behind an MCP initialize. Riding a
     * session this transport already opened is not a second establishment, so
     * the rule above still bites where a stolen credential shows up.
     */
    attach(input: { grantId: string; source: string; userAgent?: string | null; graceMs?: number }):
      | Established
      | Refused {
      const graceMs = input.graceMs ?? DEFAULT_SESSION_GRACE_MS;
      const at = now();
      const mine = db
        .prepare(
          `SELECT * FROM sessions WHERE grant_id = ? AND source = ? AND ended_at IS NULL
           ORDER BY last_seen_at DESC, rowid DESC LIMIT 1`,
        )
        .get(input.grantId, input.source) as SessionRow | undefined;
      if (mine && at - mine.last_seen_at <= graceMs) {
        db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(at, mine.id);
        return { ok: true, session: { ...toSession(mine), lastSeenAt: at }, superseded: [] };
      }
      return establish({ ...input, graceMs });
    },

    /**
     * Mark a session alive on any authenticated call. False means it is gone —
     * superseded, or ended by a revocation — and the caller must be refused
     * rather than quietly attributed to a dead session.
     */
    touch(sessionId: string): boolean {
      const changes = db
        .prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ? AND ended_at IS NULL')
        .run(now(), sessionId).changes;
      return changes === 1 || changes === 1n;
    },

    /**
     * End one session. A clean disconnect frees the grant at once: the grace
     * window exists for a harness that crashed, not for one that said goodbye.
     */
    close(sessionId: string, reason = 'closed'): void {
      end(sessionId, reason);
    },

    /** End every live session on a grant. What a revocation cascades into. */
    endAll(grantId: string, reason: string): string[] {
      return liveRows(grantId).map((session) => {
        end(session.id, reason);
        return session.id;
      });
    },

    /**
     * What the agent said about where it is calling from (§4.1). Recorded as
     * provenance and read by nothing that decides anything: a lie here
     * misattributes a transcript lookup and can never escalate.
     */
    record(input: { sessionId: string; conversationId?: string; startTime?: string }): void {
      db.prepare('UPDATE sessions SET asserted_conversation = ?, asserted_start = ? WHERE id = ?').run(
        input.conversationId?.trim() || null,
        input.startTime?.trim() || null,
        input.sessionId,
      );
    },

    /** Every session on a grant, oldest first — the forensic record (§4.1). */
    of(grantId: string): SessionRecord[] {
      const q = 'SELECT * FROM sessions WHERE grant_id = ? ORDER BY started_at, rowid';
      const rows = db.prepare(q).all(grantId) as SessionRow[];
      return rows.map((row) => ({
        ...toSession(row),
        endedAt: row.ended_at,
        endedReason: row.ended_reason,
        assertedConversation: row.asserted_conversation,
        assertedStart: row.asserted_start,
      }));
    },
  };
}

export type Sessions = ReturnType<typeof openSessions>;
