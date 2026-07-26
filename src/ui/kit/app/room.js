// Composition root for the room view.
//
// The only module allowed to know about all the others, and deliberately the
// smallest interesting one: paint, fold, render. Every rule lives somewhere
// testable — the model in `store.js`, the strings in `format.js`, the markup
// in `views.js` — and what is left here is wiring and three timing decisions
// that have nowhere else to live.
//
// The loop is: read once for first paint, open the feed at the seq that read
// stamped, fold every event into the model, re-render. There is no refresh, no
// poll, and no place to add one.

import { openFeed } from './feed.js';
import { paintRoom } from './api.js';
import { apply, applyAll, emptyState, roomByName, seed } from './store.js';
import { rosterView, sidebarView, streamView, topBarView } from './views.js';

/**
 * How often the roster re-renders on the clock alone.
 *
 * Not a poll — it fetches nothing. Claim expiry is a *clock* fact, not an
 * event: a lease whose time has passed is over whether or not the server has
 * swept it yet. Without this, an idle room shows an expired claim and a frozen
 * countdown indefinitely, and the one number a waiting agent came to read is
 * the one that stops being true.
 */
const CLOCK_MS = 1_000;

/**
 * @param {object} options
 * @param {string} options.room   room name to open
 * @param {Document} [options.doc]
 * @param {() => number} [options.now]
 * @param {Window} [options.win]
 */
export async function mountRoom({ room, doc = document, now = Date.now, win = window }) {
  const regions = {
    sidebar: doc.getElementById('sidebar'),
    topbar: doc.getElementById('topbar'),
    stream: doc.getElementById('stream'),
    roster: doc.getElementById('roster'),
  };

  let state = emptyState();
  let openRoom = room;
  let status = /** @type {'live'|'reconnecting'} */ ('reconnecting');
  /** Non-null while a paint is in flight. See `receive`. @type {any[]|null} */
  let buffered = null;

  const render = () => {
    const current = roomByName(state, openRoom);
    regions.sidebar?.replaceChildren(sidebarView(state, openRoom, pick));
    regions.topbar?.replaceChildren(topBarView(state, current, status));
    regions.stream?.replaceChildren(streamView(state, current));
    renderRoster();
  };

  // Split out because the clock re-renders only this region — repainting the
  // stream every second would fight the scroll position for no reason.
  const renderRoster = () => regions.roster?.replaceChildren(rosterView(state, now()));

  /**
   * Fold an event, or hold it if a paint is in flight.
   *
   * The buffer is the whole reason this is not three lines. A paint takes a
   * snapshot stamped at seq S and then, milliseconds later, overwrites the
   * model with it. An event that arrives in that window has a seq above S, so
   * folding it first and seeding second loses it twice over: the snapshot
   * discards its effect, and the fold then rejects any replay as already seen.
   * A message would simply vanish, permanently, and only when someone switched
   * rooms at the wrong moment.
   */
  const receive = (/** @type {any} */ event) => {
    if (buffered) {
      buffered.push(event);
      return;
    }
    const next = apply(state, event);
    if (next === state) return; // stale or unknown-and-inert: nothing to redraw
    state = next;
    render();
  };

  /** @param {string} name */
  async function paint(name) {
    buffered = [];
    try {
      const painted = await paintRoom(name);
      state = seed(state, painted);
      // Drain in arrival order. `seed` moves the cursor back to the snapshot's
      // seq, so everything held here is past it and applies cleanly.
      const held = buffered;
      buffered = null;
      state = applyAll(state, held);
      return painted.seq;
    } catch (error) {
      buffered = null;
      throw error;
    }
  }

  /** Switching rooms repaints from the model — the feed is room-agnostic and keeps running. */
  const pick = (/** @type {string} */ name) => {
    if (name === openRoom) return;
    show(name);
    // A link to a room is a link. Without this the address bar keeps naming
    // the room you started in, so reloading or copying the URL opens the wrong
    // one — which is the claim this page makes about itself, unmade.
    win.history?.pushState({ room: name }, '', `?room=${encodeURIComponent(name)}`);
  };

  /** @param {string} name */
  function show(name) {
    openRoom = name;
    doc.title = `#${name} · quorum`;
    void paint(name).then(render);
  }

  // Back and forward move between rooms, because they are addresses.
  //
  // The `?? room` is load-bearing: the page can be opened with no query at all,
  // so going back to that first entry means "the room we started in", not "no
  // room". Without it, back appears to do nothing — the URL changes and the
  // screen does not, which reads as the button being broken.
  win.addEventListener?.('popstate', () => {
    const name = new URLSearchParams(win.location.search).get('room') ?? room;
    if (name !== openRoom) show(name);
  });

  // Make the opening entry name its room, so history is uniform from the start
  // rather than having one special entry at the bottom of the stack.
  if (!new URLSearchParams(win.location.search).get('room')) {
    win.history?.replaceState({ room: openRoom }, '', `?room=${encodeURIComponent(openRoom)}`);
  }

  const from = await paint(openRoom);
  render();

  const feed = openFeed({
    after: from,
    onEvent: receive,
    onStatus: (next) => {
      if (next === status) return;
      status = next;
      render();
    },
  });

  const ticking = setInterval(renderRoster, CLOCK_MS);

  return {
    close: () => {
      clearInterval(ticking);
      feed.close();
    },
    get state() {
      return state;
    },
  };
}
