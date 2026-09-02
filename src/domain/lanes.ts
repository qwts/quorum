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
// Your own actions never address you — an echo is not a call — so the lane
// drops events you authored yourself.

import type { DatabaseSync } from 'node:sqlite';

import { QuorumError } from './errors.ts';
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

// A mention is `@` followed by the whole name, standing alone: not a
// fragment of a longer token on either side (`email@ada`, `@ada2`). The name
// class mirrors what names on this server look like — `claude:auth-refactor`
// — so a mention can carry a colon or a dot without ending early.
const NAME_CHAR = '[\\p{L}\\p{N}_:./-]';

export function mentions(body: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<!${NAME_CHAR})@${escaped}(?!${NAME_CHAR})`, 'u').test(body);
}

export function openLanes(deps: Deps) {
  const { db } = deps;

  function viewerOf(id: string | null): Viewer | null {
    if (id === null) return null; // an unidentified observer: nothing addresses it
    return (db.prepare('SELECT id, name, harness FROM participants WHERE id = ?').get(id) as Viewer | undefined) ?? null;
  }

  function onRoster(deliberationId: unknown, viewerId: string): boolean {
    if (typeof deliberationId !== 'string') return false;
    return (
      db
        .prepare(
          `SELECT 1 FROM deliberations
            WHERE id = ? AND EXISTS (SELECT 1 FROM json_each(deliberations.eligible) WHERE json_each.value = ?)`,
        )
        .get(deliberationId, viewerId) !== undefined
    );
  }

  // The stored row is the proof: an event the read handed this viewer with a
  // non-null audience named the viewer, or the read would have refused it.
  function audienceScoped(seq: number): boolean {
    const row = db.prepare('SELECT audience FROM events WHERE seq = ?').get(seq) as { audience: string | null } | undefined;
    return row?.audience != null;
  }

  function isDirected(event: QuorumEvent, viewer: Viewer): boolean {
    if (event.actorId === viewer.id) return false;
    const payload = event.payload;
    if (onRoster(payload.deliberationId, viewer.id)) return true;
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
    return audienceScoped(event.seq);
  }

  /**
   * The next `limit` events past `afterSeq` on `lane`. The `all` lane is the
   * plain read. The directed lane pages through the same read and keeps what
   * addresses the viewer, so the limit stays honest — a page of events *for
   * you*, not a page minus the ones that were not.
   */
  function read(afterSeq: number, limit: number, viewerId: string | null, lane: Lane): QuorumEvent[] {
    if (!(LANES as readonly string[]).includes(lane)) {
      throw new QuorumError(`lane must be one of ${LANES.join(', ')}`);
    }
    if (lane === 'all') return deps.readEventsAfter(afterSeq, limit, viewerId);
    const viewer = viewerOf(viewerId);
    if (viewer === null) return [];
    const picked: QuorumEvent[] = [];
    let cursor = afterSeq;
    for (;;) {
      const page = deps.readEventsAfter(cursor, PAGE, viewer.id);
      for (const event of page) {
        if (!isDirected(event, viewer)) continue;
        picked.push(event);
        if (picked.length >= limit) return picked;
      }
      if (page.length < PAGE) return picked;
      cursor = page[page.length - 1]!.seq;
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
   * The numbers a digest is made of, for one delivery: which of the handed
   * events address the viewer, what the lane passed over to hand them, and
   * which deadlines the viewer is on the roster for. Counted through the same
   * visibility filter as the reads (audience and room), so "9 passed over"
   * are 9 the viewer could go and read.
   */
  function triage(input: { viewerId: string | null; afterSeq: number; delivered: QuorumEvent[] }): Triage {
    const viewer = viewerOf(input.viewerId);
    if (viewer === null) return { directed: [], passedOver: { total: 0, rooms: [] }, deadlines: [] };
    const directed = input.delivered.filter((event) => isDirected(event, viewer)).map((event) => event.seq);
    const last = input.delivered[input.delivered.length - 1];
    const upTo = last === undefined ? deps.latestSeq() : last.seq;
    const handed = new Set(input.delivered.map((event) => event.seq));
    const rows = db
      .prepare(
        `SELECT seq, room_id FROM events
          WHERE seq > ? AND seq <= ?
            AND (audience IS NULL OR EXISTS (SELECT 1 FROM json_each(events.audience) WHERE json_each.value = ?))
            AND (events.room_id IS NULL OR EXISTS (SELECT 1 FROM rooms WHERE rooms.id = events.room_id AND ${deps.VISIBLE_ROOMS}))`,
      )
      .all(input.afterSeq, upTo, viewer.id, viewer.id) as { seq: number; room_id: string | null }[];
    const byRoom = new Map<string | null, number>();
    let total = 0;
    for (const row of rows) {
      if (handed.has(row.seq)) continue;
      total += 1;
      byRoom.set(row.room_id, (byRoom.get(row.room_id) ?? 0) + 1);
    }
    const rooms = [...byRoom].map(([roomId, count]) => ({ roomId, count })).sort((a, b) => b.count - a.count);
    return { directed, passedOver: { total, rooms }, deadlines: deadlines(viewer.id) };
  }

  return { read, triage, deadlines };
}

export type Lanes = ReturnType<typeof openLanes>;
