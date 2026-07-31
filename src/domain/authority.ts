// The visible set: which rooms a caller may know exist (ADR-0002 §6,
// docs/design/authority.md §6 and §9.1). Transport-free like the rest of the
// domain — both surfaces ask this one question rather than each filtering to
// its own taste, because three readings of a visibility rule is three products.
//
// This file is half of the gate the design names. `may(caller, capability,
// scope)` — the capability matrix — is #82's and lands here beside it; #96
// lands the visible set alone, because room *names* stop being unique the day
// exclusive rooms are possible and name resolution has to be scoped before
// anything can set a tier.
//
// Two properties are worth stating because they are easy to lose in a later
// edit:
//
//   * **A predicate, composed into the query — never a filter afterwards.**
//     A count, a page size, an ordering, or a latency computed globally and
//     then filtered carries the fact it was meant to hide (design §7). This
//     is the shape `readEventsAfter` already uses for the audience filter.
//   * **A missing viewer sees less, never more.** Every entry point takes
//     `viewer: string | null`, and null is the stranger's view: non-exclusive
//     rooms only. A read surface that forgets to thread its caller through
//     therefore refuses where it should have resolved — a bug someone reports,
//     rather than a leak nobody sees.

import type { DatabaseSync } from 'node:sqlite';
import { QuorumError } from './errors.ts';
import type { DecisionRule, Room } from './quorum.ts';

/**
 * The visible set as a SQL predicate over a query that has `rooms` in scope.
 * Binds exactly one parameter: the viewing participant's id, or null.
 *
 * Membership is by participant today. ADR-0002 holds room roles at the
 * account level; #82 moves this to the account without moving the seam.
 */
export const VISIBLE_ROOMS = `(
    rooms.visibility <> 'exclusive'
    OR EXISTS (
      SELECT 1 FROM room_members
       WHERE room_members.room_id = rooms.id AND room_members.participant_id = ?
    )
  )`;

export type RoomRow = {
  id: string;
  name: string;
  topic: string | null;
  decision_rule: string;
  created_by: string;
  visibility: string;
};

export function toRoom(row: RoomRow): Room {
  return {
    id: row.id,
    name: row.name,
    topic: row.topic,
    decisionRule: row.decision_rule as DecisionRule,
    createdBy: row.created_by,
    visibility: row.visibility as Room['visibility'],
  };
}

/**
 * A room by its id, unscoped. For resolving an id this server itself stored —
 * the room a deliberation row points at — where the row's existence is already
 * proof the caller reached it. Never for a reference a caller supplied.
 */
export function roomById(db: DatabaseSync, id: string): Room {
  const row = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id) as RoomRow | undefined;
  if (!row) throw new QuorumError(`unknown room: ${JSON.stringify(id)}`);
  return toRoom(row);
}

/**
 * Resolve a caller's room reference — an id or a name — inside their visible
 * set. Ids first, because an id is the unambiguous handle and a name is only
 * an address where it happens to be unique for this caller.
 *
 * A room outside the visible set gets the refusal a room that does not exist
 * gets: the same words, from the same throw, in the same shape (design §7,
 * corollary 3). Two refusals that differ by one adjective are an oracle.
 */
export function requireVisibleRoom(db: DatabaseSync, ref: string, viewer: string | null): Room {
  const unknown = () => new QuorumError(`unknown room: ${JSON.stringify(ref)}`);
  const byId = db.prepare(`SELECT * FROM rooms WHERE rooms.id = ? AND ${VISIBLE_ROOMS}`).get(ref, viewer) as
    | RoomRow
    | undefined;
  if (byId) return toRoom(byId);

  const byName = db
    .prepare(`SELECT * FROM rooms WHERE rooms.name = ? AND ${VISIBLE_ROOMS} ORDER BY created_at`)
    .all(ref, viewer) as RoomRow[];
  if (byName.length === 0) throw unknown();
  if (byName.length === 1) return toRoom(byName[0]!);

  // The cost ADR-0002 accepted and recorded: two rooms may share a name when
  // one of them is exclusive, and the caller who can see both is the one who
  // pays. Refused in favour of an id rather than resolved arbitrarily — a
  // reference that silently picks one of two rooms is worse than one that
  // stops. The ids listed are rooms this caller can already see, so the
  // refusal discloses nothing.
  throw new QuorumError(
    `${byName.length} rooms you can see are named ${JSON.stringify(ref)} — a name is an address only where it is` +
      ` unambiguous. Use the id: ${byName.map((row) => row.id).join(', ')}`,
  );
}

/**
 * Whether `name` is already taken among the rooms this caller can see — the
 * caller-scoped half of createRoom's pre-check. A collision the caller cannot
 * see is not reported to them, because the report *is* the disclosure; the
 * partial index is what still refuses the write if both rooms would be listed.
 */
export function visibleNameTaken(db: DatabaseSync, name: string, viewer: string | null): boolean {
  return (
    db.prepare(`SELECT 1 FROM rooms WHERE rooms.name = ? AND ${VISIBLE_ROOMS}`).get(name, viewer) !== undefined
  );
}
