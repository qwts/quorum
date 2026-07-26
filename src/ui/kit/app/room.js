// Composition root for the room view.
//
// This is the only module that is allowed to know about all the others, and it
// is deliberately the smallest interesting one: paint, fold, render. Every
// rule lives somewhere testable — the model in `store.js`, the strings in
// `format.js`, the markup in `views.js` — and what is left here is wiring.
//
// The loop is: read once for first paint, open the feed at the seq that read
// stamped, fold every event into the model, re-render the regions that can
// change. There is no refresh, no poll, and no place to add one.

import { openFeed } from './feed.js';
import { paintRoom } from './api.js';
import { applyAll, emptyState, roomByName, seed } from './store.js';
import { rosterView, sidebarView, streamView, topBarView } from './views.js';

/**
 * @param {object} options
 * @param {string} options.room   room name to open
 * @param {Document} [options.doc]
 * @param {() => number} [options.now]
 */
export async function mountRoom({ room, doc = document, now = Date.now }) {
  const regions = {
    sidebar: doc.getElementById('sidebar'),
    topbar: doc.getElementById('topbar'),
    stream: doc.getElementById('stream'),
    roster: doc.getElementById('roster'),
  };

  let state = emptyState();
  let openRoom = room;
  let status = /** @type {'live'|'reconnecting'} */ ('reconnecting');

  const render = () => {
    const current = roomByName(state, openRoom);
    regions.sidebar?.replaceChildren(sidebarView(state, openRoom, pick));
    regions.topbar?.replaceChildren(topBarView(state, current, status));
    regions.stream?.replaceChildren(streamView(state, current));
    regions.roster?.replaceChildren(rosterView(state, now()));
  };

  /** Switching rooms repaints from the model — the feed is room-agnostic and keeps running. */
  const pick = (/** @type {string} */ name) => {
    if (name === openRoom) return;
    openRoom = name;
    doc.title = `#${name} · quorum`;
    void paint(name).then(render);
  };

  /** @param {string} name */
  async function paint(name) {
    const painted = await paintRoom(name);
    state = seed(state, painted);
    return painted.seq;
  }

  const from = await paint(openRoom);
  render();

  const feed = openFeed({
    after: from,
    onEvent: (event) => {
      state = applyAll(state, [event]);
      render();
    },
    onStatus: (next) => {
      if (next === status) return;
      status = next;
      render();
    },
  });

  return { close: () => feed.close(), get state() {
    return state;
  } };
}
