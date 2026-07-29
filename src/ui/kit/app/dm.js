// The DM thread screen (#20; design 0.4.0 `DmThread`) — two participants
// outside any room (requirements 1.1 #7). No protocol here: DMs cannot
// convene a deliberation, and the screen says so.
//
// Same loop as every screen: read once, open the feed at the seq the read
// stamped, fold, re-render. The feed is opened `as` this browser's
// participant, which is what lets it carry the audience-scoped dm_message
// events addressed to them (#42) — without an identity there is nothing to
// read, and the screen says that instead of pretending an empty inbox.

import { h } from '../../lib/element.js';
import { api } from './api.js';
import { openFeed } from './feed.js';
import { clock } from './format.js';
import { applyDm, emptyDm } from './dm-model.js';
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

  const chipFor = (/** @type {any} */ who, /** @type {string} */ size) =>
    h('q-identity-chip', {
      name: who?.name ?? 'unknown',
      harness: who?.harness === 'human' ? null : who?.harness,
      kind: who?.harness === 'human' ? 'human' : 'agent',
      size,
    });

  const render = () => {
    // The inbox rail.
    if (regions.threads) {
      const list = h('nav', { class: 'thread-list', 'aria-label': 'direct messages' });
      for (const entry of model.threads) {
        const other = person(entry.counterpartId) ?? { name: entry.counterpartId };
        list.append(
          h(
            'button',
            {
              type: 'button',
              class: `thread${withWhom && entry.counterpartId === withWhom.id ? ' open' : ''}`,
              onclick: () => pickThread(other.name ?? entry.counterpartId),
            },
            chipFor(other, 'sm'),
            entry.lastMessage ? h('span', { class: 'thread-when' }, clock(entry.lastMessage.createdAt)) : null,
          ),
        );
      }
      if (model.threads.length === 0) {
        list.append(
          h(
            'div',
            { class: 'quiet thread-empty' },
            me ? 'No DM threads yet — the first message starts one.' : 'Name yourself to read your DMs: press send once.',
          ),
        );
      }
      regions.threads.replaceChildren(list);
    }

    // The open thread's head: who, and what this surface is not.
    regions.head?.replaceChildren(
      withWhom
        ? h(
            'div',
            { class: 'head-stack' },
            chipFor(withWhom, 'md'),
            h(
              'div',
              { class: 'lede' },
              'Direct thread, outside any room. Nothing here is deliberated and nothing here becomes a record — take it to a room when it needs a decision.',
            ),
          )
        : h('div', { class: 'lede' }, 'Direct messages, outside any room. Open a thread from the left, or start one from the connect screen roster.'),
    );

    // The conversation.
    if (regions.stream) {
      const rows = h('div', { class: 'rows' });
      let previous = null;
      for (const message of model.messages) {
        const author = person(message.participantId);
        rows.append(
          h('q-message-row', {
            name: author?.name ?? 'unknown',
            harness: author?.harness,
            kind: author?.harness === 'human' ? 'human' : 'agent',
            body: message.body,
            time: clock(message.createdAt),
            compact: message.participantId === previous,
          }),
        );
        previous = message.participantId;
      }
      if (model.messages.length === 0 && withWhom) {
        rows.append(h('div', { class: 'empty' }, 'Nothing said yet. A message sent here is visible to the two of you and nobody else.'));
      }
      regions.stream.replaceChildren(rows);
    }

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

  /** @param {string|undefined} ref */
  async function openThread(ref) {
    if (!ref || !me) {
      withWhom = null;
      model = { ...model, messages: [] };
      render();
      return;
    }
    const painted = await api.dms(me.id, ref);
    const other =
      [...participants.values()].find((candidate) => candidate.id === ref || candidate.name === ref) ?? null;
    withWhom = other;
    model = { ...model, messages: painted.messages };
    doc.title = other ? `${other.name} · quorum` : 'messages · quorum';
    render();
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
