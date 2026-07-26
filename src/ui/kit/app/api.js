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
    throw new Error(body.error ?? `${path} failed with ${response.status}`);
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
  decisions: (/** @type {string} [room] */ room) => read(`/api/decisions${room ? `?room=${encodeURIComponent(room)}` : ''}`),
  messages: (/** @type {string} */ room) => read(`/api/rooms/${encodeURIComponent(room)}/messages`),

  identify: (/** @type {string} */ name) => write('/api/identify', { name }),
  join: (/** @type {string} */ room, /** @type {string} */ participantId) =>
    write(`/api/rooms/${encodeURIComponent(room)}/join`, { participantId }),
  post: (/** @type {string} */ room, /** @type {string} */ participantId, /** @type {string} */ body) =>
    write(`/api/rooms/${encodeURIComponent(room)}/messages`, { participantId, body }),
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
  const [rooms, participants, claims, messages] = await Promise.all([
    api.rooms(),
    api.participants(),
    api.claims(),
    api.messages(room),
  ]);
  return {
    seq: Math.min(rooms.seq, participants.seq, claims.seq, messages.seq),
    rooms: rooms.rooms,
    participants: participants.participants,
    claims: claims.claims,
    messages: messages.messages,
  };
}
