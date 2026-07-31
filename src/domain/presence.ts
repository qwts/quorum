// Presence: whether the server has heard from a participant lately (#17).
//
// A projection, not a store. Everything it reports is already in the sessions
// table (ADR-0001 §4), because a session's `last_seen_at` is refreshed by every
// authenticated call — the one auth seam touches it (src/http/auth.ts), so the
// heartbeat is the traffic that already exists rather than a loop anyone has to
// remember to run. Contract rule 4 forbids busy-polling, and this file adds no
// timer, no column, and no write to be satisfied by construction rather than by
// care.
//
// The whole point is observability, and observability that overstates itself is
// worse than none: a roster that says a working agent is gone teaches its reader
// to stop believing the roster. So the states are what the server *observed*.
//
// Two axes, ruled on #17, and they are independent:
//
//   1. **Liveness** — server-derived, and this file. A heartbeat can prove that
//      someone is there; it can prove nothing about what they are doing.
//   2. **Advisory state** — self-declared: the `/status` line and the `blocked`
//      flag (#52), which live on the participant row and are that participant's
//      own claim about itself. Not here, and not derivable from here.
//
// So `offline` + `blocked` is representable and is exactly the state a person
// debugging most wants to see: an agent that said it was stuck and then went
// quiet. Under one combined enum it is unreachable.
//
// D10 (docs/deliberation.md) is the hard boundary: presence may inform
// guidance, never outcomes. Nothing in the deliberation rule engine imports
// this module, and tests/presence.test.ts holds that to it.

import type { DatabaseSync } from 'node:sqlite';

/**
 * What the server knows about whether someone is there.
 *
 * `unknown` is not a hedge — it is the honest answer whenever there is no
 * session to observe. `QUORUM_AUTH` is off by default (v0 localhost trust), and
 * a participant with no principal bound to it never opens a session at all, so
 * the server has no observation channel rather than an observation of absence.
 * Reporting `offline` there would be the server asserting precisely what it
 * cannot see. It renders as it always has: no dot, no line.
 */
export type Liveness = 'online' | 'offline' | 'unknown';

export type Presence = {
  liveness: Liveness;
  /** When the server last heard from this identity, or null if it never has. */
  lastSeenAt: number | null;
  /**
   * How long that was ago, measured at the moment of the read. Derivable from
   * `lastSeenAt`, and carried anyway because the reader's clock is not this
   * server's: a browser rendering "last seen 4m ago" from its own `Date.now()`
   * is wrong by the skew between them, and silently so.
   */
  quietForMs: number | null;
};

/**
 * How long a session may be silent before its participant reads `offline`.
 *
 * Deliberately *not* the session grace window (`DEFAULT_SESSION_GRACE_MS`,
 * 60s), which answers a different question — how long before another harness
 * may take a silent grant. That one is a security parameter, and tuning what a
 * roster says must never move what a stolen credential can do.
 *
 * The floor is the long poll. `wait_for_events` clamps its timeout to 120s and
 * refreshes the session when the call *arrives*, not while it blocks, so an
 * agent doing exactly what the contract asks can be silent for a full 120s. A
 * window at that ceiling would flap; three minutes clears it with room to
 * spare, and still surfaces a crashed harness while someone is still looking.
 */
export const PRESENCE_WINDOW_MS = 180_000;

/** No session, so nothing observed. The answer for an uncredentialed roster. */
export const UNOBSERVED: Presence = { liveness: 'unknown', lastSeenAt: null, quietForMs: null };

export type Deps = { db: DatabaseSync; now: () => number; windowMs?: number };

type PresenceRow = {
  participant_id: string;
  principal_id: string | null;
  /** Latest heartbeat on any session of this identity, ended ones included. */
  last_seen: number | null;
  /** Latest heartbeat on a session that could still make the next call. */
  live_seen: number | null;
};

// One statement answers both the roster and the single lookup; only the
// predicate differs. LEFT JOIN throughout so a participant with no principal —
// or a principal with no session yet — still comes back as a row to be
// classified, rather than vanishing into an absence the caller has to guess at.
//
// `live_seen` asks the question `identity.verify()` asks, deliberately: an open
// session row is not enough, because the credential behind it must still work
// for the next call to arrive. Revocation already ends sessions as it cascades
// (tree.ts), but **expiry is passive** — a grant with a finite TTL simply stops
// verifying, and its session row stays open forever. Without the check below,
// an agent whose token expired would read `online` for a further presence
// window while it was in fact unable to speak at all. The whole conditions list
// is mirrored rather than expiry alone, so a future revocation path that
// forgets to end a session cannot quietly leave someone lit up here either.
const PROJECTION = `
  SELECT p.id AS participant_id,
         p.principal_id AS principal_id,
         MAX(s.last_seen_at) AS last_seen,
         MAX(CASE WHEN s.ended_at IS NULL
                   AND g.revoked_at IS NULL
                   AND (g.expires_at IS NULL OR g.expires_at > ?)
                   AND pr.revoked_at IS NULL
                   AND a.revoked_at IS NULL
                  THEN s.last_seen_at END) AS live_seen
    FROM participants p
    LEFT JOIN principals pr ON pr.id = p.principal_id
    LEFT JOIN accounts a ON a.id = pr.account_id
    LEFT JOIN grants g ON g.principal_id = p.principal_id
    LEFT JOIN sessions s ON s.grant_id = g.id`;

export function openPresence(deps: Deps) {
  const { db, now } = deps;
  const windowMs = deps.windowMs ?? PRESENCE_WINDOW_MS;

  function project(row: PresenceRow, at: number): Presence {
    // No identity behind the name, so no session and nothing to observe.
    if (row.principal_id === null) return UNOBSERVED;
    const lastSeenAt = row.last_seen;
    // A session that ended is not a session gone quiet: a clean disconnect, a
    // supersede, and a revocation are all the server watching someone leave.
    // Only a usable session can hold someone online, and only while its last
    // heartbeat is inside the window.
    const live = row.live_seen !== null && at - row.live_seen <= windowMs;
    return {
      liveness: live ? 'online' : 'offline',
      lastSeenAt,
      quietForMs: lastSeenAt === null ? null : Math.max(0, at - lastSeenAt),
    };
  }

  // One clock reading per call, shared by the query and the comparison: two
  // readings could straddle a millisecond and answer about two instants.
  return {
    /** What the server has observed of one participant. */
    of(participantId: string): Presence {
      const at = now();
      const row = db.prepare(`${PROJECTION} WHERE p.id = ? GROUP BY p.id`).get(at, participantId) as
        | PresenceRow
        | undefined;
      return row ? project(row, at) : UNOBSERVED;
    },

    /** The same for everyone on the roster, in one read. */
    all(): Map<string, Presence> {
      const at = now();
      const rows = db.prepare(`${PROJECTION} GROUP BY p.id`).all(at) as PresenceRow[];
      return new Map(rows.map((row) => [row.participant_id, project(row, at)]));
    },
  };
}

export type PresenceProjection = ReturnType<typeof openPresence>;

/**
 * How guidance says someone has gone quiet, or null when it must say nothing.
 *
 * Null for `online` (there is nothing to report) and for `unknown` (there is
 * nothing to report *from*, and inventing a line there is the overstatement
 * this module exists to avoid). The clause carries no subject, so a caller
 * composes it after a `quoted()` name — participant text and server text stay
 * on their own sides of the sentence.
 *
 * Advice, never a rule: every caller below produces the same decision with this
 * line and without it (D10). It changes what a reader expects, not what happens.
 */
export function goneQuiet(presence: Presence): string | null {
  if (presence.liveness !== 'offline') return null;
  if (presence.quietForMs === null) return 'has never been seen on this server';
  return `has been quiet for ${elapsed(presence.quietForMs)}`;
}

/** Rounded on purpose: a presence window measured to the second reads as a promise. */
function elapsed(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}
