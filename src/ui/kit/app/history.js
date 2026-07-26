// Two rules the decision history needs, kept pure so Node can test them.

/**
 * Attach each record's room name.
 *
 * The list endpoint carries `roomId` and no name. In the all-rooms view that
 * leaves every card unattributed — and two rooms asking similar questions is
 * not a hypothetical here, it is what a fleet of agents working the same
 * codebase produces. A record you cannot place is a record you cannot cite.
 *
 * A room the reader cannot see (or one deleted since) leaves the field unset
 * rather than printing a UUID: an id on a record reads as part of the record.
 *
 * @param {any[]} decisions
 * @param {any[]} rooms
 */
export function withRoomNames(decisions, rooms) {
  const names = new Map(rooms.map((room) => [room.id, room.name]));
  return decisions.map((decision) => ({ ...decision, room: names.get(decision.roomId) }));
}

/**
 * Whether a refresh is newer than what is already painted.
 *
 * Two deliberations closing together start two independent reads. If the later
 * one answers first and the earlier one answers second, applying blindly would
 * replace the newer history with the older snapshot — dropping the freshest
 * record until something else closed or the page reloaded.
 *
 * Every response is stamped with the feed position *before* its read, so the
 * stamps order the responses even when the network does not.
 *
 * @param {number} seq      the stamp on the response that just arrived
 * @param {number} painted  the stamp of what is on screen
 */
export function isFresher(seq, painted) {
  return typeof seq === 'number' && seq >= painted;
}
