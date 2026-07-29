// Event kind → reducer: the only place that knows how a single event changes
// the model.
//
// Split from store.js because they answer different questions — that file is
// what the model *is* and how it is read, this is what each event does to it —
// and because adding a kind should not mean opening the file that defines the
// shape.
//
// Every reducer returns a new state, or the one it was handed. Returning the
// same object is how a caller skips a repaint on identity.

/** @typedef {import('./store.js').State} State */

/* ── handlers ─────────────────────────────────────────────────────────────── */

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
 * Event kind → reducer. Adding a kind is one entry here and nothing else.
 * @type {Record<string, (state: State, event: any) => State>}
 */
export const HANDLERS = {
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

  // A deliberation opened while the page is up is folded from this event; one
  // already open at load arrives in the first paint instead (seed, #35).
  // Either way the feed owns every change after.
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
