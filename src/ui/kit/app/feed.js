// The event port. The other of the two modules that know HTTP exists.
//
// `EventSource` already does the hard part: it reconnects on its own and sends
// `Last-Event-ID`, and the server resumes after exactly that seq. So there is
// no retry loop here, no backoff, and no cursor bookkeeping — writing any of
// those would mean reimplementing, slightly worse, something the platform is
// already doing correctly.
//
// What this module adds is a single subscription surface: the caller gets every
// event through one callback regardless of kind, because the fold that consumes
// them is a table lookup and does not want a listener per kind — and because a
// per-kind listener list is a second place to update when the server grows an
// event, which is a place someone will forget.

/**
 * Open the feed at `after` and call `onEvent` for every domain event.
 *
 * @param {object} options
 * @param {number} options.after      feed position from the first-paint read
 * @param {string} [options.as]       participant id whose audience-scoped events
 *                                    (DMs) the stream should include (#42);
 *                                    omitted, this is the shared feed alone
 * @param {(event: any) => void} options.onEvent
 * @param {(state: 'live'|'reconnecting') => void} [options.onStatus]
 * @returns {{close: () => void}}
 */
export function openFeed({ after, as, onEvent, onStatus }) {
  const source = new EventSource(`/api/events?after=${after}${as ? `&as=${encodeURIComponent(as)}` : ''}`);

  const deliver = (/** @type {MessageEvent} */ message) => {
    try {
      onEvent(JSON.parse(message.data));
    } catch {
      // A frame we cannot parse is the server's problem, not a reason to tear
      // down a working stream. Skipping it loses one event; throwing here
      // would silently kill every event after it.
    }
  };

  // One listener, every kind. The server sends domain events under SSE's
  // default `message` name precisely so this works: a listener list would have
  // to be updated in lockstep with the server, and a tab open across a deploy
  // would silently drop the kind it had not been taught — which is the exact
  // failure the fold's unknown-kind handling exists to survive.
  source.addEventListener('message', deliver);

  // Not a domain event: the server states where the reader is on connect, so a
  // page knows its stream is established rather than merely not-yet-failing.
  source.addEventListener('cursor', () => onStatus?.('live'));
  source.addEventListener('open', () => onStatus?.('live'));
  // EventSource reconnects by itself; an error is "we are between attempts",
  // not "we are finished".
  source.addEventListener('error', () => onStatus?.('reconnecting'));

  return { close: () => source.close() };
}
