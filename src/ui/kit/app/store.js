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
 * @param {{seq: number, rooms?: any[], participants?: any[], claims?: any[], room?: string, messages?: any[]}} painted
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

/* ── handlers ─────────────────────────────────────────────────────────────── */

/** @param {any[]} rows @returns {Map<string, any>} */
function byId(rows) {
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Replace one entry in one map, leaving every other map alone.
 * @param {any} state @param {'rooms'|'participants'|'claims'|'deliberations'} key
 * @param {string} id @param {any} value
 * @returns {State}
 */
function put(state, key, id, value) {
  const map = new Map(state[key]);
  map.set(id, value);
  return { ...state, [key]: map };
}

/**
 * @param {any} state @param {'rooms'|'participants'|'claims'|'deliberations'} key @param {string} id
 * @returns {State}
 */
function drop(state, key, id) {
  const map = new Map(state[key]);
  map.delete(id);
  return { ...state, [key]: map };
}

/**
 * @param {State} state @param {string} roomId @param {any} message
 * @returns {State}
 */
function appendMessage(state, roomId, message) {
  const messages = new Map(state.messages);
  const existing = messages.get(roomId) ?? [];
  // Idempotent by message id, for the same replay reason as the seq guard.
  if (existing.some((/** @type {any} */ m) => m.id === message.id)) return state;
  messages.set(roomId, [...existing, message]);
  return { ...state, messages };
}

/**
 * The deliberation a room is currently running, if any.
 *
 * Terminal ones stay in the model — the record is the point — but only a live
 * one is the room's *current* business, so a converged decision does not sit
 * at the top of the stream forever pretending to need a vote.
 *
 * @param {State} state
 * @param {string|undefined} roomId
 */
export function openDeliberation(state, roomId) {
  if (!roomId) return undefined;
  for (const deliberation of state.deliberations.values()) {
    if (deliberation.roomId !== roomId) continue;
    if (deliberation.phase === 'converged' || deliberation.phase === 'failed') continue;
    return deliberation;
  }
  return undefined;
}

/**
 * Event kind → reducer. Adding a kind is one entry here and nothing else.
 * @type {Record<string, (state: State, event: any) => State>}
 */
const HANDLERS = {
  participant_identified: (state, { payload }) => put(state, 'participants', payload.participant.id, payload.participant),

  room_created: (state, { payload }) => put(state, 'rooms', payload.room.id, { ...payload.room, members: 1 }),

  room_joined: (state, { payload }) => {
    const room = state.rooms.get(payload.room.id);
    const withMember = put(state, 'rooms', payload.room.id, { ...payload.room, members: (room?.members ?? 0) + 1 });
    return put(withMember, 'participants', payload.participant.id, payload.participant);
  },

  message: (state, { roomId, payload }) => appendMessage(state, roomId, payload.message),

  claim_granted: (state, { payload }) => put(state, 'claims', payload.claim.id, payload.claim),
  claim_renewed: (state, { payload }) => put(state, 'claims', payload.claim.id, payload.claim),
  claim_released: (state, { payload }) => drop(state, 'claims', payload.claim.id),
  // The clock acted, not a participant — but the roster reads the same either
  // way, so it is the same reducer.
  claim_expired: (state, { payload }) => drop(state, 'claims', payload.claim.id),

  // A deliberation is folded from its events rather than fetched: the read API
  // has no route for an open one, because the domain has no room-scoped query
  // and that file is another lane's. A page opened mid-deliberation therefore
  // sees it on the next event, not on first paint — tracked, not forgotten.
  deliberation_opened: (state, { payload }) =>
    put(state, 'deliberations', payload.deliberationId, {
      ...payload.deliberation,
      by: payload.by,
      cast: 0,
    }),

  voting_opened: (state, { payload }) =>
    amend(state, payload.deliberationId, { phase: 'voting', phaseEndsAt: payload.phaseEndsAt }),

  // Carries who voted and how many have, never *what* they chose. The feed
  // cannot leak a ballot because the ballot is not in it (deliberation.md §6).
  ballot_cast: (state, { payload }) =>
    amend(state, payload.deliberationId, { cast: payload.cast, eligible: payload.eligible }),

  deliberation_converged: (state, { payload }) =>
    amend(state, payload.deliberationId, { phase: 'converged', chosen: payload.chosen }),

  deliberation_failed: (state, { payload }) =>
    amend(state, payload.deliberationId, { phase: 'failed', failureKind: payload.failureKind }),
};

/**
 * Merge fields into a deliberation we already hold.
 *
 * An event for one we never saw is ignored rather than half-created: a
 * deliberation with a phase and no question would render as an empty card,
 * which is worse than rendering nothing until the page is reloaded.
 *
 * @param {State} state
 * @param {string} id
 * @param {Record<string, unknown>} fields
 */
function amend(state, id, fields) {
  const existing = state.deliberations.get(id);
  if (!existing) return state;
  return put(state, 'deliberations', id, { ...existing, ...fields });
}

/** Exposed so a test can assert the table covers what the domain emits. */
export const HANDLED_KINDS = Object.keys(HANDLERS);
