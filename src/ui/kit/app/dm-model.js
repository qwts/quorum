// The DM screen's fold, DOM-free so Node can test it. Same replay contract
// as the room fold: the paint's seq is stamped before its read, so an event
// that landed in between arrives twice on purpose, and applying it twice must
// change nothing.

/** @typedef {{threads: any[], messages: any[]}} DmModel */

/** @returns {DmModel} */
export function emptyDm() {
  return { threads: [], messages: [] };
}

/**
 * Fold one event into the model.
 *
 * The event is already audience-scoped by the server (#42) — this fold never
 * has to decide whether the reader was allowed to see it, only where it lands:
 * the inbox always, the open conversation when the thread matches.
 *
 * @param {DmModel} model
 * @param {any} event
 * @param {string} meId
 * @param {string|null} counterpartId  the open thread's other participant
 * @returns {DmModel}
 */
export function applyDm(model, event, meId, counterpartId) {
  if (event.kind !== 'dm_message') return model;
  const { message, thread } = event.payload;

  // The inbox: upsert this thread with its latest message, newest first.
  const others = model.threads.filter((entry) => entry.id !== thread.id);
  const counterpart = thread.participants.find((/** @type {string} */ id) => id !== meId);
  const threads = [
    { id: thread.id, counterpartId: counterpart, lastMessage: message, createdAt: thread.createdAt },
    ...others,
  ];

  // The open conversation, if this message belongs to it. Idempotent by
  // message id, for the replay reason above.
  const inThread = counterpartId !== null && thread.participants.includes(counterpartId);
  const seen = inThread && model.messages.some((existing) => existing.id === message.id);
  const messages = inThread && !seen ? [...model.messages, message] : model.messages;

  return { threads, messages };
}
