// The overlay ballot's local, D6-safe selection state (#60). DOM-free so the
// acknowledgement/echo race is testable without a browser.

/** @returns {{pick: string|null, cast: string|null, awaitingOwnEcho: boolean}} */
export function emptyBallotSelection() {
  return { pick: null, cast: null, awaitingOwnEcho: false };
}

/**
 * @param {{pick: string|null, cast: string|null, awaitingOwnEcho: boolean}} state
 * @param {{kind: 'pick', option: string}|{kind: 'acknowledged', option: string}|{kind: 'echo', own: boolean}} action
 */
export function applyBallotSelection(state, action) {
  if (action.kind === 'pick') return { ...state, pick: action.option };
  if (action.kind === 'acknowledged') {
    // The request may have left while this option was selected and returned
    // after the person picked another. The acknowledgement confirms what the
    // server accepted; it does not rewind the newer local choice.
    return { pick: state.pick ?? action.option, cast: action.option, awaitingOwnEcho: true };
  }
  if (action.own && state.awaitingOwnEcho) return { ...state, awaitingOwnEcho: false };
  return state;
}

/** @param {{pick: string|null, cast: string|null}} state */
export function selectedBallot(state) {
  return state.pick ?? state.cast;
}

/**
 * The displayed facts only: transport ordering flags must not cause a paint.
 * @param {any} state @param {any} deliberation @param {any} room
 * @param {any} own @param {string|null} notice @param {any} me
 */
export function ballotPanelKey(state, deliberation, room, own, notice, me) {
  const eligible = Array.isArray(deliberation.eligible) ? deliberation.eligible : [];
  return JSON.stringify({
    id: deliberation.id,
    phase: deliberation.phase,
    options: deliberation.options,
    eligible,
    castBy: deliberation.castBy ?? [],
    rule: room?.decisionRule,
    people: eligible.map((/** @type {string} */ id) => state.participants.get(id) ?? id),
    pick: own.pick,
    cast: own.cast,
    notice,
    me: me?.id ?? null,
  });
}
