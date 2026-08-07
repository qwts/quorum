// The overlay ballot panel's local state and stable DOM boundary (#60).
//
// The event feed deliberately never carries a choice (D6), so this browser's
// accepted choice cannot be reconstructed from an echo. It stays local, and
// the panel is redrawn only when one of the facts it actually displays moves.

import { ballotView } from './overlay.js';
import { applyBallotSelection, ballotPanelKey, emptyBallotSelection } from './ballot-selection.js';

/**
 * Owns the one ballot-panel node that survives full overlay repaints.
 * @param {{doc: Document, getState: () => any, getMe: () => {id: string}|null}} ports
 */
export function createBallotPanel({ doc, getState, getMe }) {
  const region = doc.createElement('div');
  region.className = 'ov-ballot';
  /** @type {Map<string, ReturnType<typeof emptyBallotSelection>>} */
  const selections = new Map();
  let rendered = '';

  const selection = (/** @type {string} */ id) => selections.get(id) ?? emptyBallotSelection();
  const change = (/** @type {string} */ id, /** @type {any} */ action) => {
    selections.set(id, applyBallotSelection(selection(id), action));
  };

  return {
    region,
    selection,
    pick(/** @type {string} */ id, /** @type {string} */ option) { change(id, { kind: 'pick', option }); },
    acknowledged(/** @type {string} */ id, /** @type {string} */ option) { change(id, { kind: 'acknowledged', option }); },
    echo(/** @type {any} */ event, /** @type {string} */ id) {
      if (event.kind !== 'ballot_cast' || event.payload?.deliberationId !== id) return;
      change(id, { kind: 'echo', own: event.actorId === getMe()?.id });
    },
    /** @param {any} deliberation @param {any} room @param {string|null} notice @param {any} on */
    render(deliberation, room, notice, on) {
      const state = getState();
      const own = selection(deliberation.id);
      const key = ballotPanelKey(state, deliberation, room, own, notice, getMe());
      if (key === rendered) return false;
      const fresh = ballotView(state, deliberation, room, { ...own, notice, me: getMe() }, on);
      region.replaceChildren(...fresh.childNodes);
      rendered = key;
      return true;
    },
  };
}
