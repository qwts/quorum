// The DM screen's views: inbox rail, thread head, conversation. State in,
// DOM out, split from dm.js along the same seam views.js draws for the room —
// the mount keeps the timing and the model, these keep the markup.

import { h } from '../../lib/element.js';
import { clock } from './format.js';

const chipFor = (/** @type {any} */ who, /** @type {string} */ size) =>
  h('q-identity-chip', {
    name: who?.name ?? 'unknown',
    harness: who?.harness === 'human' ? null : who?.harness,
    kind: who?.harness === 'human' ? 'human' : 'agent',
    size,
  });

/**
 * The inbox rail.
 *
 * @param {import('./dm-model.js').DmModel} model
 * @param {(id: string|null|undefined) => any} person
 * @param {any} withWhom
 * @param {boolean} named  whether this browser has an identity yet
 * @param {(counterpartId: string) => void} onPick
 */
export function threadListView(model, person, withWhom, named, onPick) {
  const list = h('nav', { class: 'thread-list', 'aria-label': 'direct messages' });
  for (const entry of model.threads) {
    const other = person(entry.counterpartId) ?? { name: entry.counterpartId };
    list.append(
      h(
        'button',
        {
          type: 'button',
          class: `thread${withWhom && entry.counterpartId === withWhom.id ? ' open' : ''}`,
          // By id, never by display name: identity is (name, harness), so two
          // participants can share a name — and the resolver rightly refuses
          // to guess between them. The name is for reading.
          onclick: () => onPick(entry.counterpartId),
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
        named ? 'No DM threads yet — the first message starts one.' : 'Name yourself to read your DMs: press send once.',
      ),
    );
  }
  return list;
}

/** The open thread's head: who, and what this surface is not. @param {any} withWhom */
export function threadHeadView(withWhom) {
  return withWhom
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
    : h('div', { class: 'lede' }, 'Direct messages, outside any room. Open a thread from the left, or start one from the connect screen roster.');
}

/**
 * The conversation.
 *
 * @param {import('./dm-model.js').DmModel} model
 * @param {(id: string|null|undefined) => any} person
 * @param {any} withWhom
 */
export function conversationView(model, person, withWhom) {
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
  return rows;
}
