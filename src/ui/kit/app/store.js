// The client-side model — a fold over the event feed.
//
// The rule this exists to enforce is the domain's, not the UI's: **the page
// never computes protocol state.** Every fact on screen either arrived in the
// first-paint read or arrived as an event, and the only thing this module does
// is decide where an event lands. A screen that derived "the deliberation must
// be in voting now" locally would be one refresh away from disagreeing with
// the server, and disagreements about what happened are the failure quorum
// exists to prevent.
//
// Two properties make this shape worth the indirection:
//
//   * **It is pure.** No DOM, no fetch, no clock. So it is unit-tested in Node
//     with no browser, which is the only reason these rules are checkable at
//     all — the alternative is asserting on rendered markup.
//   * **New event kinds are table entries, not branches.** `HANDLERS` is a map
//     from event kind to a reducer. An unknown kind advances the cursor and
//     changes nothing, so a server that grows an event does not break a page
//     that has not learned it yet.

import { HANDLERS } from './handlers.js';

/**
 * @typedef {object} State
 * @property {number} seq          feed position this state reflects
 * @property {Map<string, any>} rooms         by room id
 * @property {Map<string, any>} participants  by participant id
 * @property {Map<string, any>} claims        live claims by claim id
 * @property {Map<string, any[]>} messages    room id → messages, in arrival order
 * @property {Map<string, any>} deliberations  by deliberation id, live and closed
 */

/** @returns {State} */
export function emptyState() {
  return {
    seq: 0,
    rooms: new Map(),
    participants: new Map(),
    claims: new Map(),
    messages: new Map(),
    deliberations: new Map(),
  };
}

/**
 * Seed from the first-paint reads. The `seq` is the one the API stamped before
 * its read, so the caller opens its stream there and cannot miss anything.
 *
 * @param {State} state
 * @param {{seq: number, rooms?: any[], participants?: any[], claims?: any[], room?: string, messages?: any[], deliberations?: any[]}} painted
 * @returns {State}
 */
export function seed(state, painted) {
  // The snapshot's seq wins, even when it is *behind* where the fold had got
  // to. A repaint replaces these maps with data as of that seq, so the cursor
  // has to move back with them — otherwise events between the stamp and now
  // are neither in the snapshot nor replayable, and vanish. The caller holds
  // those events across the paint and drains them after (see room.js).
  const next = { ...state, seq: painted.seq ?? state.seq };
  if (painted.rooms) next.rooms = byId(painted.rooms);
  if (painted.participants) next.participants = byId(painted.participants);
  if (painted.claims) next.claims = byId(painted.claims);
  if (painted.messages) {
    next.messages = new Map(state.messages);
    const roomId = painted.messages[0]?.roomId;
    if (roomId) next.messages.set(roomId, [...painted.messages]);
  }
  // Merged by id rather than replaced: the paint carries one room's *open*
  // deliberations, and the closed ones already folded are the record, not
  // staleness. The API view says who has cast (D6-public); the model keeps
  // only the count, so the paint and the ballot_cast event agree on shape.
  if (painted.deliberations) {
    next.deliberations = new Map(state.deliberations);
    // The paint is authoritative for the painted room's *live* set. A live
    // deliberation the fold holds but the paint no longer lists closed while
    // this page could not hear it — and its closing event sits *behind* the
    // snapshot's seq, so replay would be rejected as already-folded. The
    // absence is the fact; keeping the entry would offer a ballot forever.
    const paintedIds = new Set(painted.deliberations.map((view) => view.id));
    const roomId = painted.room
      ? [...next.rooms.values()].find((candidate) => candidate.name === painted.room)?.id
      : undefined;
    if (roomId) {
      for (const [id, deliberation] of next.deliberations) {
        const live = deliberation.phase === 'challenging' || deliberation.phase === 'voting';
        if (live && deliberation.roomId === roomId && !paintedIds.has(id)) next.deliberations.delete(id);
      }
    }
    for (const view of painted.deliberations) {
      next.deliberations.set(view.id, {
        ...view,
        cast: Array.isArray(view.cast) ? view.cast.length : view.cast,
      });
    }
  }
  return next;
}

/**
 * Apply one event. Never mutates — a caller can hold the previous state and
 * compare, which is what makes rendering a diff rather than a repaint.
 *
 * @param {State} state
 * @param {{seq: number, kind: string, roomId: string|null, payload: any}} event
 * @returns {State}
 */
export function apply(state, event) {
  // Already folded. The feed can replay — the API stamp is taken before its
  // read, so an event that landed in between arrives twice on purpose — and
  // replay must be idempotent for that trade to be worth making.
  if (event.seq <= state.seq) return state;

  const handler = HANDLERS[event.kind];
  const next = handler ? handler(state, event) : state;
  // An unknown kind still moves the cursor: the page has seen it, it just had
  // nothing to do about it.
  return { ...next, seq: event.seq };
}

/** @param {State} state @param {Iterable<any>} events @returns {State} */
export function applyAll(state, events) {
  let next = state;
  for (const event of events) next = apply(next, event);
  return next;
}

/* ── selectors ──────────────────────────────────────────────────────────────
   Reading questions live here rather than in a renderer, so two screens
   asking the same question get the same answer. */

/** @param {State} state @param {string} name */
export function roomByName(state, name) {
  for (const room of state.rooms.values()) if (room.name === name) return room;
  return undefined;
}

/** @param {State} state @param {string|undefined} roomId */
export function messagesIn(state, roomId) {
  return (roomId && state.messages.get(roomId)) || [];
}

/** @param {State} state @param {string|null|undefined} id */
export function participant(state, id) {
  return (id && state.participants.get(id)) || undefined;
}

/**
 * Live claims, soonest to expire first — the one about to free up reads first.
 * @param {State} state
 * @param {number} atMs
 */
export function liveClaims(state, atMs) {
  return [...state.claims.values()]
    .filter((claim) => claim.expiresAt > atMs)
    .sort((a, b) => a.expiresAt - b.expiresAt);
}

/** @param {any[]} rows @returns {Map<string, any>} */
function byId(rows) {
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Every deliberation a room is currently running, soonest deadline first.
 *
 * Plural because the domain allows it: `propose` refuses an unnamed question,
 * a short option list and a non-member, but not a second live deliberation in
 * a room. Returning only the first would hide the second completely — and it
 * would stay hidden past its own deadline, so a ballot could become impossible
 * to cast without anything ever saying why.
 *
 * Ordered by deadline for the same reason claims are: whoever is deciding
 * should meet the one that closes first.
 *
 * Terminal ones stay in the model — the record is the point — but only a live
 * one is the room's *current* business, so a converged decision does not sit
 * at the top of the stream forever pretending to need a vote.
 *
 * @param {State} state
 * @param {string|undefined} roomId
 * @returns {any[]}
 */
export function liveDeliberations(state, roomId) {
  if (!roomId) return [];
  const live = [];
  for (const deliberation of state.deliberations.values()) {
    if (deliberation.roomId !== roomId) continue;
    if (deliberation.phase === 'converged' || deliberation.phase === 'failed') continue;
    live.push(deliberation);
  }
  return live.sort((a, b) => (a.phaseEndsAt ?? Infinity) - (b.phaseEndsAt ?? Infinity));
}

export { HANDLERS, HANDLED_KINDS } from './handlers.js';
