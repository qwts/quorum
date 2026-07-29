// The DM thread screen (#20; design 0.4.0 `DmThread`) — two participants
// outside any room (requirements 1.1 #7). No protocol here: DMs cannot
// convene a deliberation, and the screen says so.
//
// Same loop as every screen: read once, open the feed at the seq the read
// stamped, fold, re-render. The feed is opened `as` this browser's
// participant, which is what lets it carry the audience-scoped dm_message
// events addressed to them (#42) — without an identity there is nothing to
// read, and the screen says that instead of pretending an empty inbox.

import { api } from './api.js';
import { openFeed } from './feed.js';
import { applyDm, emptyDm } from './dm-model.js';
import { conversationView, threadHeadView, threadListView } from './dm-views.js';
import { ensureIdentified, forget, isStaleIdentity, remembered } from './me.js';

/**
 * @param {object} options
 * @param {string} [options.counterpart]  participant name or id from the URL
 * @param {Document} [options.doc]
 * @param {Window} [options.win]
 */
export async function mountDm({ counterpart, doc = document, win = window }) {
  const regions = {
    threads: doc.getElementById('threads'),
    head: doc.getElementById('thread-head'),
    stream: doc.getElementById('dm-stream'),
    composer: doc.getElementById('composer'),
  };

  let me = remembered();
  let model = emptyDm();
  /** Everyone on the roster, for names and hues. @type {Map<string, any>} */
  let participants = new Map();
  /** The resolved other side of the open thread. @type {any} */
  let withWhom = null;
  /** A refusal meant for this person alone. @type {string|null} */
  let notice = null;

  const identify = () =>
    ensureIdentified({ ask: (message) => win.prompt(message), identify: api.identify });

  // One live composer, same reasoning as the room's: it holds the draft.
  const composer = /** @type {any} */ (doc.createElement('q-composer'));
  composer.addEventListener('send', (/** @type {any} */ event) => void send(event.detail.value));
  regions.composer?.replaceChildren(composer);

  /** @param {string} body */
  async function send(body) {
    const text = body?.trim();
    if (!text) return;
    notice = null;
    try {
      me = await identify();
      if (!me) {
        notice = 'A DM needs a sender — you were not named, so nothing was sent.';
      } else if (!withWhom) {
        notice = 'Pick who this goes to — open a thread from the left.';
      } else {
        await api.sendDm(me.id, withWhom.id, text);
        // Nothing painted optimistically: the message returns on the feed,
        // audience-scoped to the two of us, like the counterpart sees it.
        composer.value = '';
        if (!started) await start(); // the first send created our identity — the feed can open now
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isStaleIdentity(message)) {
        forget();
        me = null;
      }
      notice = message;
    }
    render();
  }

  const person = (/** @type {string|null|undefined} */ id) => (id && participants.get(id)) || undefined;

  const render = () => {
    regions.threads?.replaceChildren(threadListView(model, person, withWhom, Boolean(me), pickThread));
    regions.head?.replaceChildren(threadHeadView(withWhom));
    regions.stream?.replaceChildren(conversationView(model, person, withWhom));
    Object.assign(composer, {
      placeholder: withWhom ? `Message ${withWhom.name}` : 'Message',
      disabled: !withWhom,
      disabledReason: withWhom ? null : 'Open a thread from the left to write to it.',
      hint: me ? null : 'Enter to send · you will be asked for a name once',
      notice,
    });
  };

  /** @param {string} name */
  const pickThread = (name) => {
    win.history?.pushState({ with: name }, '', `?with=${encodeURIComponent(name)}`);
    void openThread(name);
  };

  /** Held events while a thread paint is in flight. Same reason room.js
   *  buffers: a dm_message landing between the snapshot read and its
   *  assignment would fold against the *old* thread and then be overwritten —
   *  the feed's cursor has moved past it, so it would never come back.
   *  @type {any[]|null} */
  let opening = null;

  /** @param {string|undefined} ref */
  async function openThread(ref) {
    if (!ref || !me) {
      withWhom = null;
      model = { ...model, messages: [] };
      render();
      return;
    }
    opening = [];
    try {
      const painted = await api.dms(me.id, ref);
      const other =
        [...participants.values()].find((candidate) => candidate.id === ref || candidate.name === ref) ?? null;
      withWhom = other;
      model = { ...model, messages: painted.messages };
      // Drain in arrival order, against the thread that is now open. applyDm
      // is idempotent by message id, so an event the snapshot already carried
      // changes nothing.
      const held = opening;
      opening = null;
      for (const event of held) model = applyDm(model, event, me.id, withWhom?.id ?? null);
      doc.title = other ? `${other.name} · quorum` : 'messages · quorum';
      render();
    } catch (error) {
      opening = null;
      throw error;
    }
  }

  let started = false;
  /** @type {{close: () => void}|null} */
  let feed = null;

  async function start() {
    if (started || !me) return;
    started = true;
    const [roster, inbox] = await Promise.all([api.participants(), api.dmThreads(me.id)]);
    participants = new Map(roster.participants.map((/** @type {any} */ row) => [row.id, row]));
    model = {
      threads: inbox.threads.map((/** @type {any} */ thread) => ({
        id: thread.id,
        counterpartId: thread.counterpart.id,
        lastMessage: thread.lastMessage,
        createdAt: thread.createdAt,
      })),
      messages: [],
    };
    for (const thread of inbox.threads) participants.set(thread.counterpart.id, thread.counterpart);
    await openThread(counterpart);

    feed = openFeed({
      after: Math.min(roster.seq, inbox.seq),
      as: me.id,
      onEvent: (/** @type {any} */ event) => {
        if (event.kind === 'participant_identified') {
          participants = new Map(participants).set(event.payload.participant.id, event.payload.participant);
          render();
          return;
        }
        // A thread paint is in flight: hold the event, or it folds against
        // the thread being left and is then overwritten by the snapshot.
        if (opening) {
          opening.push(event);
          return;
        }
        const next = applyDm(model, event, me?.id ?? '', withWhom?.id ?? null);
        if (next === model) return;
        model = next;
        render();
      },
      onStatus: () => {},
    });
  }

  win.addEventListener?.('popstate', () => {
    const ref = new URLSearchParams(win.location.search).get('with') ?? undefined;
    void openThread(ref);
  });

  if (me) await start();
  render();

  return {
    close: () => feed?.close(),
    get model() {
      return model;
    },
  };
}
