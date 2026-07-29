// The overlay's controller: what opening, closing, casting and the clock do,
// split from room.js so the composition root stays the smallest interesting
// module. The markup lives in overlay.js, the derivations in overlay-model.js;
// what is here is wiring with a lifecycle — the same reason posting.js exists.

import { api } from './api.js';
import { clock } from './format.js';
import { ensureIdentified, forget, isStaleIdentity } from './me.js';
import { createSender } from './posting.js';
import { overlayView } from './overlay.js';
import { countdown } from './overlay-model.js';
import { isTerminal } from '../../lib/phase.js';

/**
 * @param {object} ports
 * @param {Document} ports.doc
 * @param {Window} ports.win
 * @param {() => number} ports.now
 * @param {HTMLElement|null} ports.region             where the overlay mounts
 * @param {() => any} ports.getState                  the room fold
 * @param {() => {id: string, name: string}|null} ports.getMe
 * @param {(who: {id: string, name: string}|null) => void} ports.setMe
 * @param {() => string} ports.getRoomName            the open room, for the URL
 */
export function createOverlayController({ doc, win, now, region, getState, getMe, setMe, getRoomName }) {
  /** The deliberation the overlay shows, or null — in the URL, so a link to a
   *  deliberation is a link. @type {string|null} */
  let overlayId = new URLSearchParams(win.location.search).get('deliberation');
  /** Option picked but not yet cast, per deliberation. @type {Map<string, string>} */
  const picks = new Map();
  /** Option this browser cast, per deliberation. Its own knowledge only —
   *  nothing on the feed could tell it, and that is D6 working. @type {Map<string, string>} */
  const casts = new Map();
  /** Fetched decision records by deliberation id. Immutable, so never refetched. @type {Map<string, any>} */
  const records = new Map();
  /** Record fetches in flight, so a re-render does not start a second one. @type {Set<string>} */
  const fetching = new Set();
  /** A refusal meant for this person alone. @type {string|null} */
  let notice = null;

  const identify = () => ensureIdentified({ ask: (message) => win.prompt(message), identify: api.identify });

  // The overlay's challenge window has its own composer for the same reason
  // the room keeps one live element: it holds a draft, and every other part of
  // the overlay is rebuilt from the model on each render. A send here is an
  // ordinary room message tagged to the open deliberation (D4); the server
  // enforces the phase gate.
  const challengeComposer = /** @type {any} */ (doc.createElement('q-composer'));
  Object.assign(challengeComposer, {
    placeholder: 'Add a consideration to the challenge window',
    phase: 'challenging',
    rows: 3,
  });
  const sendChallenge = createSender({
    room: getRoomName,
    me: getMe,
    setMe,
    draft: () => challengeComposer.value,
    setDraft: (value) => { challengeComposer.value = value; },
    setNotice: (message) => { notice = message; },
    settled: () => render(),
    identify,
    join: api.join,
    post: (name, participantId, body) => api.post(name, participantId, body, overlayId ?? undefined),
    isStaleIdentity,
    forget,
  });
  challengeComposer.addEventListener('send', (/** @type {any} */ event) => void sendChallenge(event.detail.value));

  /**
   * A deliberation the fold never saw — a link followed after close, when the
   * paint carries only open ones — still has a record, and the record carries
   * everything the terminal view shows. Rebuilt in the fold's shape.
   * @param {any} record
   */
  const fromRecord = (record) => ({
    id: record.deliberationId,
    roomId: record.roomId,
    question: record.question,
    options: record.options,
    eligible: (record.eligible ?? []).map((/** @type {any} */ person) => person.id),
    phase: record.outcome,
    failureKind: record.failureKind,
    phaseEndsAt: null,
    createdAt: null, // the record does not carry the convene time
    castBy: (record.ballots ?? []).map((/** @type {any} */ ballot) => ballot.participantId),
  });

  /** Repaint the overlay region from the model, or clear it. */
  const render = () => {
    if (!region) return;
    const id = overlayId;
    let deliberation = id ? getState().deliberations.get(id) : null;
    if (!deliberation && id && records.has(id)) deliberation = fromRecord(records.get(id));
    if (!deliberation && id && !fetching.has(id)) {
      // Not in the fold: either it closed before this page loaded, or the
      // link is stale. The record answers which; a 404 clears the overlay
      // rather than leaving a scrim over nothing.
      fetching.add(id);
      void api
        .decision(id)
        .then(({ decision }) => records.set(id, decision))
        .catch(() => {
          if (overlayId === id) overlayId = null;
        })
        .then(() => render());
    }
    if (!deliberation) {
      region.replaceChildren();
      return;
    }
    // A terminal deliberation shows its record, fetched once — it is
    // immutable, so asking again would be asking a settled question twice.
    if (isTerminal(deliberation.phase) && !records.has(deliberation.id) && !fetching.has(deliberation.id)) {
      fetching.add(deliberation.id);
      void api
        .decision(deliberation.id)
        .then(({ decision }) => records.set(deliberation.id, decision))
        .catch(() => fetching.delete(deliberation.id)) // retried on the next render
        .then(() => render());
    }
    const state = getState();
    const inRoom = [...state.rooms.values()].find((candidate) => candidate.id === deliberation.roomId) ?? null;
    // The challenge composer is the one node that must survive this repaint —
    // it is passed through as itself, so its draft does. Focus does not
    // survive a DOM move, so it is restored when the field held it.
    const composerHadFocus = doc.activeElement === challengeComposer;
    region.replaceChildren(
      overlayView(
        state,
        deliberation,
        inRoom,
        {
          now: now(),
          pick: picks.get(deliberation.id) ?? null,
          cast: casts.get(deliberation.id) ?? null,
          record: records.get(deliberation.id) ?? null,
          notice,
          me: getMe(),
          composer: challengeComposer,
        },
        {
          close,
          pick: (option) => {
            picks.set(deliberation.id, option);
            render();
          },
          cast: () => void castBallot(deliberation),
          closeChallenges: () => void closeChallenges(deliberation),
        },
      ),
    );
    if (composerHadFocus) challengeComposer.shadowRoot?.querySelector('textarea')?.focus();
  };

  /**
   * Cast (or re-cast) this browser's ballot. Same rules as the stream's chips:
   * nothing optimistic, the server's refusals shown as they stand — except our
   * own choice, which we are allowed to remember.
   * @param {any} deliberation
   */
  async function castBallot(deliberation) {
    notice = null;
    const option = picks.get(deliberation.id);
    if (option === undefined) return;
    const choice = (deliberation.options ?? []).indexOf(option);
    if (choice < 0) return;
    try {
      const me = await identify();
      setMe(me);
      if (!me) {
        notice = 'Voting needs a name — a ballot with nobody behind it is not a ballot.';
      } else {
        await api.vote(deliberation.id, me.id, choice);
        casts.set(deliberation.id, option);
      }
    } catch (error) {
      notice = error instanceof Error ? error.message : String(error);
    }
    render();
  }

  /**
   * Convener only, and the server enforces it — the button only renders for
   * the convener, but the refusal is still shown if the server disagrees.
   * @param {any} deliberation
   */
  async function closeChallenges(deliberation) {
    notice = null;
    try {
      const me = await identify();
      setMe(me);
      if (me) await api.closeChallenges(deliberation.id, me.id);
    } catch (error) {
      notice = error instanceof Error ? error.message : String(error);
    }
    render();
  }

  /** @param {string} id */
  function open(id) {
    overlayId = id;
    notice = null;
    const room = getRoomName();
    win.history?.pushState(
      { room, deliberation: id },
      '',
      `?room=${encodeURIComponent(room)}&deliberation=${encodeURIComponent(id)}`,
    );
    render();
  }

  function close() {
    overlayId = null;
    notice = null;
    const room = getRoomName();
    win.history?.pushState({ room }, '', `?room=${encodeURIComponent(room)}`);
    render();
  }

  // The overlay is a place you can leave without reaching for the mouse.
  win.addEventListener?.('keydown', (/** @type {any} */ event) => {
    if (event.key === 'Escape' && overlayId) close();
  });

  /**
   * The 1s tick. Only the countdown pill's text moves — repainting the whole
   * overlay every second would drop the challenge composer's focus
   * mid-sentence.
   */
  const tick = () => {
    const deliberation = overlayId ? getState().deliberations.get(overlayId) : null;
    if (deliberation && !isTerminal(deliberation.phase) && deliberation.phaseEndsAt) {
      const pill = region?.querySelector('.ov-pill');
      if (pill) {
        pill.textContent = `phase_ends_at ${clock(deliberation.phaseEndsAt)} · ${countdown(deliberation.phaseEndsAt, now())} left`;
      }
    }
  };

  return {
    render,
    tick,
    open,
    close,
    /** Adopt an id from the URL (a popstate, a room switch) without pushing history. */
    adopt(/** @type {string|null} */ id) {
      overlayId = id;
      notice = null;
    },
  };
}
