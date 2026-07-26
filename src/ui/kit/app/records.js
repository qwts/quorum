// Composition root for the decision history.
//
// The same loop as the room view — read once, open the feed at the seq that
// read stamped, fold, re-render — over a different question. What a room shows
// is what is happening; this shows what was settled, and why.
//
// A decision is immutable (D9), so there is no editing here and no place to
// add any. The one interaction is opening a record, which fetches the full
// thing: the list carries summaries, and the record names every ballot and
// every participant who never cast. Those names are not list furniture.

import { openFeed } from './feed.js';
import { api } from './api.js';
import { historyView } from './records-view.js';

/**
 * @param {object} options
 * @param {string} [options.room]  narrow to one room; omitted means the account
 * @param {Document} [options.doc]
 */
export async function mountRecords({ room, doc = document }) {
  const region = doc.getElementById('records');

  /** @type {any[]} */
  let decisions = [];
  /** Full records by deliberation id, fetched when one is opened. @type {Map<string, any>} */
  const opened = new Map();
  /** @type {string|null} */
  let notice = null;

  const render = () => region?.replaceChildren(historyView(decisions, opened, notice));

  /** @param {string} deliberationId */
  async function open(deliberationId) {
    if (opened.has(deliberationId)) {
      // Opening a second time closes it. The record stays fetched — it cannot
      // change, so re-requesting it would be asking a settled question twice.
      opened.delete(deliberationId);
      render();
      return;
    }
    try {
      const { decision } = await api.decision(deliberationId);
      opened.set(deliberationId, decision);
      notice = null;
    } catch (error) {
      notice = error instanceof Error ? error.message : String(error);
    }
    render();
  }

  /** @param {any} target */
  const decisionAt = (target) => target?.closest?.('q-decision-card')?.dataset?.decision;

  // The card marks itself `role="button"` with a tab stop but dispatches
  // nothing — opening it is the screen's job. Which means the keyboard is the
  // screen's job too: a card that announces itself as a button to a screen
  // reader and then answers only the mouse is making a promise it cannot keep.
  region?.addEventListener('click', (/** @type {any} */ event) => {
    const id = decisionAt(event.target);
    if (id) void open(id);
  });

  region?.addEventListener('keydown', (/** @type {any} */ event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const id = decisionAt(event.target);
    if (!id) return;
    // Space scrolls the page by default, which would move the record out from
    // under the person who just opened it.
    event.preventDefault();
    void open(id);
  });

  const first = await api.decisions(room);
  decisions = first.decisions;
  render();

  // A decision that closes while this page is open belongs at the top of it.
  // Nothing here polls: the feed is the only thing that adds a row.
  const feed = openFeed({
    after: first.seq,
    onEvent: (/** @type {any} */ event) => {
      if (event.kind !== 'deliberation_converged' && event.kind !== 'deliberation_failed') return;
      void api
        .decisions(room)
        .then((fresh) => {
          decisions = fresh.decisions;
          render();
        })
        .catch(() => {
          // The row will be there on the next close or the next load. A
          // history that shouts about a failed refresh is worse than one that
          // is briefly a record short.
        });
    },
    onStatus: () => {},
  });

  return {
    close: () => feed.close(),
    get decisions() {
      return decisions;
    },
  };
}
