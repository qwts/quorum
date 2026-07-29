// The overlay's derivations and normative copy, DOM-free so Node can test
// them — the same treatment store.js and record.js get. What lives here is
// protocol-significant rather than cosmetic: the quorum derivation (D5), and
// the Q6-ruled ballot copy the overlay screen was blocked on.

/**
 * D5: quorum is derived from the rule and the roster frozen at convene —
 * never stored, never typed by hand.
 *
 * @param {string|undefined} rule
 * @param {number} eligible
 */
export function quorumOf(rule, eligible) {
  return rule === 'unanimity' ? eligible : Math.floor(eligible / 2) + 1;
}

/**
 * `mm:ss` to a deadline, clamped at zero. The server closes the phase; the
 * page only counts down to when it will.
 *
 * @param {number} phaseEndsAt @param {number} nowMs
 */
export function countdown(phaseEndsAt, nowMs) {
  const seconds = Math.max(0, Math.ceil((phaseEndsAt - nowMs) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * The stepper's note per phase — normative copy from the design, including
 * the Q6 ruling: re-cast until the phase closes, the last ballot counts.
 *
 * @param {string} phase @param {number} quorum @param {number} eligible
 */
export function phaseNote(phase, quorum, eligible) {
  switch (phase) {
    case 'voting':
      return (
        `Ballots are hidden until close; re-cast until then — the last ballot counts. An option converges at ` +
        `${quorum} of ${eligible} eligible; the phase closes at its deadline, or early once all ${eligible} are in.`
      );
    case 'converged':
      return 'Converged — the decision record below is written once and never edited.';
    case 'failed':
      return 'Failed — a failure record with a typed reason. A correction is a new deliberation, never a reopened one.';
    default:
      return 'Challenges argue considerations. Ballots open when the convener closes the window, or when this deadline expires.';
  }
}

/**
 * The mono line under this participant's own ballot chips (Q6 ruling, D6).
 * @param {string} phase @param {boolean} hasCast
 */
export function ballotHint(phase, hasCast) {
  if (phase === 'challenging') return 'ballots open when the window closes';
  return hasCast
    ? 'ballot recorded · hidden until close · re-cast until the phase closes — the last ballot counts'
    : 'ballots hidden until close · re-cast allowed until the phase closes';
}

/**
 * The mono line under the ballots-in roster.
 * @param {string} phase @param {number} cast @param {number} quorum @param {number} eligible
 */
export function turnoutNote(phase, cast, quorum, eligible) {
  if (phase === 'challenging') return 'that a ballot exists is public; what it says is not';
  if (cast >= eligible) return 'full turnout — the phase closes early, everyone has spoken';
  return `an option converges at ${quorum} of ${eligible} eligible · ${eligible - cast} yet to cast`;
}
