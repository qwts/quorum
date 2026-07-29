// Casting a ballot from the stream's proposal chips — wiring with a
// lifecycle, split from the composition root for the same reason posting.js
// is: every bug this can have is a timing or identity bug, not a markup bug.

import { api } from './api.js';
import { liveDeliberations, roomByName } from './store.js';

/**
 * Listen for chip selections in the stream and turn them into votes.
 *
 * Delegated from the region rather than bound to the card, because the card
 * is rebuilt on every render and a listener on it would go with it.
 *
 * @param {object} ports
 * @param {HTMLElement|null} ports.region
 * @param {() => any} ports.getState
 * @param {() => string} ports.getRoomName
 * @param {() => Promise<{id: string, name: string}|null>} ports.identify
 * @param {(who: {id: string, name: string}|null) => void} ports.setMe
 * @param {(message: string|null) => void} ports.setNotice
 * @param {() => void} ports.settled
 */
export function attachStreamVoting({ region, getState, getRoomName, identify, setMe, setNotice, settled }) {
  /**
   * Nothing is painted optimistically: during voting the tally is concealed
   * (deliberation.md §6), so an optimistic chip would be the one thing on
   * screen claiming to know something the protocol is withholding.
   *
   * @param {string} deliberationId @param {number} choice
   */
  async function cast(deliberationId, choice) {
    setNotice(null);
    try {
      const me = await identify();
      setMe(me);
      if (!me) {
        setNotice('Voting needs a name — a ballot with nobody behind it is not a ballot.');
      } else {
        await api.vote(deliberationId, me.id, choice);
      }
    } catch (error) {
      // Re-casting, a closed phase, not being in the frozen roster — the
      // domain says which, in words worth showing as they stand.
      setNotice(error instanceof Error ? error.message : String(error));
    }
    settled();
  }

  region?.addEventListener('select', (/** @type {any} */ event) => {
    // The card the chip belongs to, not "the" deliberation: a room may be
    // running several, and picking the first would cast a ballot in one
    // proposal from a chip belonging to another.
    const card = event.target?.closest?.('q-proposal-card');
    const id = card?.dataset?.deliberation;
    const state = getState();
    const live = liveDeliberations(state, roomByName(state, getRoomName())?.id).find(
      (deliberation) => deliberation.id === id,
    );
    if (!live) return;
    const choice = (live.options ?? []).indexOf(event.detail.option);
    if (choice >= 0) void cast(live.id, choice);
  });
}
