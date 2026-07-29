// The HTTP port. One of exactly two modules that know HTTP exists.
//
// Reads here are all first paint. Nothing polls, and nothing here may grow a
// `refresh()` — once the page is painted, change arrives on the feed. A poll
// added "just for this one panel" is how a live UI quietly becomes a stale one
// that happens to update sometimes.
//
// Writes do not return the new state either, for the same reason: the message
// you post comes back to you on the feed like everyone else's. That is what
// makes your own view and an agent's view the same view — a write that painted
// itself optimistically would be the one place they could disagree.

const HEADERS = { accept: 'application/json' };

/**
 * @param {string} path
 * @returns {Promise<any>}
 */
async function read(path) {
  const response = await fetch(path, { headers: HEADERS });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    // The status rides along so a caller can tell "that does not exist" from
    // "the request broke" — paintRoom treats the first as an answer.
    throw Object.assign(new Error(body.error ?? `${path} failed with ${response.status}`), {
      status: response.status,
    });
  }
  return body;
}

/**
 * @param {string} path
 * @param {unknown} body
 * @returns {Promise<any>}
 */
async function write(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    // Not decoration: the server refuses anything else, because a content type
    // it does not insist on is one an attacker can downgrade past a preflight.
    headers: { ...HEADERS, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    // The server's refusals are written to be read — "join #protocol before
    // posting to it" — so they are surfaced as they stand, never replaced with
    // a status code.
    throw new Error(payload.error ?? `${path} failed with ${response.status}`);
  }
  return payload;
}

export const api = {
  rooms: () => read('/api/rooms'),
  participants: () => read('/api/participants'),
  claims: () => read('/api/claims'),
  decisions: (/** @type {string|undefined} */ room) => read(`/api/decisions${room ? `?room=${encodeURIComponent(room)}` : ''}`),
  decision: (/** @type {string} */ deliberationId) => read(`/api/decisions/${encodeURIComponent(deliberationId)}`),
  messages: (/** @type {string} */ room) => read(`/api/rooms/${encodeURIComponent(room)}/messages`),
  deliberations: (/** @type {string} */ room) => read(`/api/rooms/${encodeURIComponent(room)}/deliberations`),

  identify: (/** @type {string} */ name) => write('/api/identify', { name }),
  join: (/** @type {string} */ room, /** @type {string} */ participantId) =>
    write(`/api/rooms/${encodeURIComponent(room)}/join`, { participantId }),
  /**
   * @param {string} room @param {string} participantId @param {string} body
   * @param {string} [deliberationId] set when the message is a challenge (D4)
   */
  post: (room, participantId, body, deliberationId) =>
    write(`/api/rooms/${encodeURIComponent(room)}/messages`, { participantId, body, deliberationId }),
  vote: (/** @type {string} */ deliberationId, /** @type {string} */ participantId, /** @type {number} */ choice) =>
    write(`/api/deliberations/${encodeURIComponent(deliberationId)}/vote`, { participantId, choice }),
  closeChallenges: (/** @type {string} */ deliberationId, /** @type {string} */ participantId) =>
    write(`/api/deliberations/${encodeURIComponent(deliberationId)}/close-challenges`, { participantId }),

  // DM surfaces (#42). `as` is this browser's participant id — self-asserted,
  // like every other v0 write names its participant.
  dmThreads: (/** @type {string} */ as) => read(`/api/dms?as=${encodeURIComponent(as)}`),
  dms: (/** @type {string} */ as, /** @type {string} */ counterpart) =>
    read(`/api/dms?as=${encodeURIComponent(as)}&with=${encodeURIComponent(counterpart)}`),
  sendDm: (/** @type {string} */ participantId, /** @type {string} */ to, /** @type {string} */ body) =>
    write('/api/dms', { participantId, to, body }),
};

/**
 * Everything a room view needs to paint, and the feed position to stream from.
 *
 * The seq returned is the **lowest** of the stamps, because each read stamped
 * itself before it ran and the page must resume from before the earliest of
 * them. Taking the highest would skip events the earlier reads had not yet
 * seen — the gap this stamping exists to close, reintroduced by picking the
 * wrong end of it.
 *
 * @param {string} room
 */
export async function paintRoom(room) {
  // A room that does not exist is an answer, not a failure. Nothing seeds
  // rooms — an agent creates one with create_room — so on a fresh install the
  // front door's default room is missing and its scoped reads 404. That paints
  // as an empty room; the feed still opens, so the room appears the moment an
  // agent makes it exist. A dead server never reaches this: the unscoped reads
  // fail first, without a status, and stay fatal.
  const absent = { seq: Infinity, messages: [], deliberations: [] };
  const orAbsent = (/** @type {any} */ error) => {
    if (error?.status === 404) return absent;
    throw error;
  };
  const [rooms, participants, claims, messages, deliberations] = await Promise.all([
    api.rooms(),
    api.participants(),
    api.claims(),
    api.messages(room).catch(orAbsent),
    api.deliberations(room).catch(orAbsent),
  ]);
  return {
    seq: Math.min(rooms.seq, participants.seq, claims.seq, messages.seq, deliberations.seq),
    // Which room this paint is of, so the seed can retire live deliberations
    // the paint no longer lists (their close happened behind the snapshot).
    room,
    rooms: rooms.rooms,
    participants: participants.participants,
    claims: claims.claims,
    messages: messages.messages,
    deliberations: deliberations.deliberations,
  };
}
