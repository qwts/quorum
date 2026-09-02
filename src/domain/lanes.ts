// Priority lanes over the event feed (#61): which events address a
// participant, so a slow reasoner can wait on those alone and read the rest
// at its own cadence.
//
// A lane is a lens over the caller-owned cursor — not a second feed, and not
// push. `read` filters what `readEventsAfter` already delivers, and the
// triage numbers here are counted through the same visibility filter as the
// reads, so a reply never promises an event the feed would then refuse.
// Nothing in this file is protocol-load-bearing: the deliberation rule engine
// does not import it, and a lane changes what an agent is handed, never what
// happened.
//
// "Directed at you" is four things, and this list is the contract:
//
//   1. An audience-scoped event that names you — a DM (#42).
//   2. A deliberation event for a roster you are on: the call to vote and
//      the phase changes of a deliberation you are eligible in.
//   3. A room message that mentions you by name (@name), or carries a
//      delivery-time command aimed at you (#51's targeted templates).
//   4. A server event about you: your own lease expiring or being revoked,
//      or you being kicked from a room.
//
// Your own actions never address you: an echo is not a call.
//
// Cost is the other half. A directed read walks ambient events it will not
// hand over, in a process every client shares, so the walk is bounded
// (`MAX_SCAN` per call; the caller resumes from `scannedTo`) and makes no
// query per event: rosters and audience-scoped seqs come one query per page.

import type { DatabaseSync } from 'node:sqlite';

import { QuorumError } from './errors.ts';
import { mentions } from './mention.ts';
import type { QuorumEvent } from './quorum.ts';

export const LANES = ['all', 'directed'] as const;
export type Lane = (typeof LANES)[number];

export type Deadline = {
  deliberationId: string;
  roomId: string;
  phase: 'challenging' | 'voting';
  endsAt: number;
  /** Whether the viewer has already cast in this deliberation. */
  cast: boolean;
};

export type Triage = {
  /** The seqs among `delivered` that address the viewer. */
  directed: number[];
  /**
   * Events in (afterSeq, upTo] the viewer could see but was not handed —
   * upTo being the last delivered seq, or the feed head when nothing was.
   * Zero on the `all` lane by construction: that lane skips nothing.
   */
  passedOver: { total: number; rooms: { roomId: string | null; count: number }[] };
  /** Open phases of deliberations the viewer is eligible in, soonest first. */
  deadlines: Deadline[];
};

/**
 * One read. `scannedTo` is the last seq examined — resume there, not at the
 * cursor; `exhausted` is false when `MAX_SCAN` stopped the scan short of the
 * head, and the caller should come straight back rather than sleep.
 */
export type LaneRead = { events: QuorumEvent[]; scannedTo: number; exhausted: boolean };

export type Deps = {
  db: DatabaseSync;
  now: () => number;
  VISIBLE_ROOMS: string;
  readEventsAfter: (afterSeq: number, limit: number, viewer: string | null) => QuorumEvent[];
  latestSeq: () => number;
  /** The target of a targeted delivery-time command in `body`, or null (#51). */
  addresseeOf: (body: string, harness: string) => string | null;
};

type Viewer = { id: string; name: string; harness: string };

/** One page of the underlying read while the lane looks for what it wants. */
const PAGE = 100;

/** Ambient events one directed read may walk before handing control back. */
export const MAX_SCAN = 1_000;

// The filter every read applies (src/domain/quorum.ts readEventsAfter), so a
// count here never exceeds what a read would deliver. Binds viewer twice.
const VISIBLE_EVENTS = (visibleRooms: string) =>
  `(audience IS NULL OR EXISTS (SELECT 1 FROM json_each(events.audience) WHERE json_each.value = ?))
   AND (events.room_id IS NULL OR EXISTS (SELECT 1 FROM rooms WHERE rooms.id = events.room_id AND ${visibleRooms}))`;

export function openLanes(deps: Deps) {
  const { db } = deps;
  const visible = VISIBLE_EVENTS(deps.VISIBLE_ROOMS);

  function viewerOf(id: string | null): Viewer | null {
    if (id === null) return null; // an unidentified observer: nothing addresses it
    return (db.prepare('SELECT id, name, harness FROM participants WHERE id = ?').get(id) as Viewer | undefined) ?? null;
  }

  // The deliberations whose frozen roster names the viewer, one query per
  // read. Closed ones stay in: their closing event is the viewer's business.
  function rostersOf(viewerId: string): Set<string> {
    const rows = db
      .prepare(
        `SELECT id FROM deliberations
          WHERE EXISTS (SELECT 1 FROM json_each(deliberations.eligible) WHERE json_each.value = ?)`,
      )
      .all(viewerId) as { id: string }[];
    return new Set(rows.map((row) => row.id));
  }

  // The audience-scoped seqs within a page: a read already proved each names
  // the viewer, or it would have refused the row.
  function audiencedIn(from: number, to: number): Set<number> {
    const rows = db
      .prepare('SELECT seq FROM events WHERE seq > ? AND seq <= ? AND audience IS NOT NULL')
      .all(from, to) as { seq: number }[];
    return new Set(rows.map((row) => row.seq));
  }

  type Lens = { viewer: Viewer; rosters: Set<string>; audienced: Set<number> };

  function isDirected(event: QuorumEvent, lens: Lens): boolean {
    const { viewer } = lens;
    if (event.actorId === viewer.id) return false;
    const payload = event.payload;
    if (typeof payload.deliberationId === 'string' && lens.rosters.has(payload.deliberationId)) return true;
    if (event.kind === 'message') {
      const body = (payload.message as { body?: unknown } | undefined)?.body;
      if (typeof body !== 'string') return false;
      return mentions(body, viewer.name) || deps.addresseeOf(body, viewer.harness) === viewer.name;
    }
    if (event.kind === 'claim_expired' || event.kind === 'claim_revoked') {
      return (payload.claim as { participantId?: unknown } | undefined)?.participantId === viewer.id;
    }
    if (event.kind === 'participant_kicked') {
      return (payload.participant as { id?: unknown } | undefined)?.id === viewer.id;
    }
    return lens.audienced.has(event.seq);
  }

  /**
   * The next `limit` events past `afterSeq` on `lane`. The directed lane
   * pages through the plain read and keeps what addresses the viewer, so the
   * limit stays honest — a page of events *for you* — and stops after
   * `MAX_SCAN` ambient events so one slow reader cannot hold the process.
   */
  function read(afterSeq: number, limit: number, viewerId: string | null, lane: Lane): LaneRead {
    if (!(LANES as readonly string[]).includes(lane)) {
      throw new QuorumError(`lane must be one of ${LANES.join(', ')}`);
    }
    if (lane === 'all') {
      const events = deps.readEventsAfter(afterSeq, limit, viewerId);
      return { events, scannedTo: events.length > 0 ? events[events.length - 1]!.seq : afterSeq, exhausted: true };
    }
    const viewer = viewerOf(viewerId);
    if (viewer === null) return { events: [], scannedTo: afterSeq, exhausted: true };
    const rosters = rostersOf(viewer.id);
    const picked: QuorumEvent[] = [];
    let cursor = afterSeq;
    let walked = 0;
    for (;;) {
      const page = deps.readEventsAfter(cursor, PAGE, viewer.id);
      if (page.length === 0) return { events: picked, scannedTo: cursor, exhausted: true };
      const last = page[page.length - 1]!.seq;
      const lens: Lens = { viewer, rosters, audienced: audiencedIn(cursor, last) };
      for (const event of page) {
        cursor = event.seq;
        if (!isDirected(event, lens)) continue;
        picked.push(event);
        if (picked.length >= limit) return { events: picked, scannedTo: cursor, exhausted: true };
      }
      walked += page.length;
      if (page.length < PAGE) return { events: picked, scannedTo: cursor, exhausted: true };
      if (walked >= MAX_SCAN) return { events: picked, scannedTo: cursor, exhausted: false };
    }
  }

  function deadlines(viewerId: string): Deadline[] {
    const rows = db
      .prepare(
        `SELECT id, room_id, phase, phase_ends_at,
                EXISTS (SELECT 1 FROM ballots WHERE ballots.deliberation_id = deliberations.id AND ballots.participant_id = ?) AS cast
           FROM deliberations
          WHERE phase IN ('challenging', 'voting') AND phase_ends_at > ?
            AND EXISTS (SELECT 1 FROM json_each(deliberations.eligible) WHERE json_each.value = ?)
          ORDER BY phase_ends_at`,
      )
      .all(viewerId, deps.now(), viewerId) as {
      id: string;
      room_id: string;
      phase: 'challenging' | 'voting';
      phase_ends_at: number;
      cast: number;
    }[];
    return rows.map((row) => ({
      deliberationId: row.id,
      roomId: row.room_id,
      phase: row.phase,
      endsAt: row.phase_ends_at,
      cast: row.cast === 1,
    }));
  }

  /**
   * The numbers a digest is made of: which handed events address the viewer,
   * what the lane passed over to hand them (counted in SQL through the same
   * visibility filter as the reads, nothing materialized), and the deadlines
   * the viewer is on the roster for.
   */
  function triage(input: { viewerId: string | null; afterSeq: number; delivered: QuorumEvent[]; lane: Lane }): Triage {
    const viewer = viewerOf(input.viewerId);
    if (viewer === null) return { directed: [], passedOver: { total: 0, rooms: [] }, deadlines: [] };
    const last = input.delivered[input.delivered.length - 1];
    const lens: Lens = {
      viewer,
      rosters: rostersOf(viewer.id),
      audienced: last === undefined ? new Set() : audiencedIn(input.afterSeq, last.seq),
    };
    const directed = input.delivered.filter((event) => isDirected(event, lens)).map((event) => event.seq);
    const passedOver = input.lane === 'all' ? { total: 0, rooms: [] } : passedOverBy(viewer.id, input.afterSeq, input.delivered);
    return { directed, passedOver, deadlines: deadlines(viewer.id) };
  }

  function passedOverBy(viewerId: string, afterSeq: number, delivered: QuorumEvent[]): Triage['passedOver'] {
    const last = delivered[delivered.length - 1];
    const upTo = last === undefined ? deps.latestSeq() : last.seq;
    const rows = db
      .prepare(
        `SELECT room_id, COUNT(*) AS n FROM events
          WHERE seq > ? AND seq <= ? AND ${visible}
          GROUP BY room_id`,
      )
      .all(afterSeq, upTo, viewerId, viewerId) as { room_id: string | null; n: number }[];
    const byRoom = new Map<string | null, number>(rows.map((row) => [row.room_id, row.n]));
    // The handed events sit inside the counted range; take them back out.
    for (const event of delivered) byRoom.set(event.roomId, (byRoom.get(event.roomId) ?? 0) - 1);
    const rooms = [...byRoom]
      .filter(([, count]) => count > 0)
      .map(([roomId, count]) => ({ roomId, count }))
      .sort((a, b) => b.count - a.count);
    return { total: rooms.reduce((sum, room) => sum + room.count, 0), rooms };
  }

  return { read, triage, deadlines };
}

export type Lanes = ReturnType<typeof openLanes>;
