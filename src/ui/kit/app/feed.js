// The event port. The other of the two modules that know HTTP exists.
//
// `EventSource` already does the hard part: it reconnects on its own and sends
// `Last-Event-ID`, and the server resumes after exactly that seq. So there is
// no retry loop here, no backoff, and no cursor bookkeeping — writing any of
// those would mean reimplementing, slightly worse, something the platform is
// already doing correctly.
//
// What this module does add is a single subscription surface: the caller gets
// every event through one callback regardless of kind, because the fold that
// consumes them is a table lookup and does not want a listener per kind.

/** Domain event kinds the server can emit. Each arrives as its own SSE event name. */
const KINDS = [
  'participant_identified',
  'room_created',
  'room_joined',
  'message',
  'claim_granted',
  'claim_renewed',
  'claim_released',
  'claim_expired',
  'deliberation_opened',
  'voting_opened',
  'ballot_cast',
  'deliberation_converged',
  'deliberation_failed',
];

/**
 * Open the feed at `after` and call `onEvent` for every domain event.
 *
 * @param {object} options
 * @param {number} options.after      feed position from the first-paint read
 * @param {(event: any) => void} options.onEvent
 * @param {(state: 'live'|'reconnecting') => void} [options.onStatus]
 * @returns {{close: () => void}}
 */
export function openFeed({ after, onEvent, onStatus }) {
  const source = new EventSource(`/api/events?after=${after}`);

  const deliver = (/** @type {MessageEvent} */ message) => {
    try {
      onEvent(JSON.parse(message.data));
    } catch {
      // A frame we cannot parse is the server's problem, not a reason to tear
      // down a working stream. Skipping it loses one event; throwing here
      // would silently kill every event after it.
    }
  };

  for (const kind of KINDS) source.addEventListener(kind, deliver);

  // Not a domain event: the server states where the reader is on connect, so a
  // page knows its stream is established rather than merely not-yet-failing.
  source.addEventListener('cursor', () => onStatus?.('live'));
  source.addEventListener('open', () => onStatus?.('live'));
  // EventSource reconnects by itself; an error is "we are between attempts",
  // not "we are finished".
  source.addEventListener('error', () => onStatus?.('reconnecting'));

  return { close: () => source.close() };
}
