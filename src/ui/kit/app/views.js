// Views: state in, DOM out.
//
// Each one is a plain function of the model — no fetching, no listeners, no
// state of its own. That is what lets the composition root re-render a region
// by calling one function and replacing children, instead of every module
// growing its own opinion about when to update.
//
// None of these picks a colour, a size or a hue. They arrange components from
// the design-system library and pass it data; if a view needed a visual
// decision, that would be a gap in the library and a question for
// `src/ui/QUESTIONS.md` (see the library README).

import { h, meta } from '../../lib/element.js';
import { clock, count, remaining, scopeOf } from './format.js';
import { liveClaims, messagesIn, participant } from './store.js';
import { optionChipProps } from '../../lib/phase.js';

/**
 * The room stream. Consecutive messages from one participant collapse into a
 * compact row, which is what makes a fast-moving room readable.
 *
 * @param {import('./store.js').State} state
 * @param {any} room
 */
export function streamView(state, room) {
  const messages = messagesIn(state, room?.id);
  if (messages.length === 0) {
    // Denser real data is not available yet, so say what is true and what
    // happens next — never an illustration (the design forbids imagery, and
    // an empty room is a fact rather than a sad state).
    return h('div', { class: 'empty' }, 'No messages yet. An agent posting here appears without a refresh.');
  }

  const rows = h('div', { class: 'rows' });
  let previousAuthor = null;
  for (const message of messages) {
    const author = participant(state, message.participantId);
    rows.append(
      h('q-message-row', {
        name: author?.name ?? 'unknown',
        harness: author?.harness,
        kind: author?.harness === 'human' ? 'human' : 'agent',
        body: message.body,
        time: clock(message.createdAt),
        // A challenge is a message tagged to a deliberation (protocol D4), and
        // the tag is the only thing that makes it one.
        variant: message.deliberationId ? 'challenge' : 'message',
        label: message.deliberationId ? 'challenge' : null,
        compact: author?.id != null && author.id === previousAuthor,
      }),
    );
    previousAuthor = author?.id ?? null;
  }
  return rows;
}

/**
 * Who is here, and what they are holding.
 *
 * @param {import('./store.js').State} state
 * @param {number} atMs
 */
export function rosterView(state, atMs) {
  const people = [...state.participants.values()];
  const claims = liveClaims(state, atMs);

  const roster = h('div', { class: 'panel-section' }, h('div', { class: 'label' }, `roster · ${people.length}`));
  const chips = h('div', { class: 'chips' });
  for (const person of people) {
    chips.append(
      h('q-identity-chip', {
        name: person.name,
        harness: person.harness === 'human' ? null : person.harness,
        kind: person.harness === 'human' ? 'human' : 'agent',
        repo: person.repo,
        branch: person.branch,
      }),
    );
  }
  roster.append(chips);

  const held = h(
    'div',
    { class: 'panel-section' },
    h('div', { class: 'label' }, `live claims · ${claims.length}`),
  );
  if (claims.length === 0) {
    held.append(h('div', { class: 'quiet' }, 'Nothing claimed. A claim is a coordination signal, not a lock.'));
  }
  for (const claim of claims) {
    const holder = participant(state, claim.participantId);
    held.append(
      h(
        'div',
        { class: 'claim' },
        h('div', { class: 'claim-scope' }, scopeOf(claim)),
        h('div', { class: 'claim-purpose' }, claim.purpose),
        h(
          'div',
          { class: 'claim-foot' },
          h('q-identity-chip', {
            name: holder?.name ?? 'unknown',
            harness: holder?.harness === 'human' ? null : holder?.harness,
            kind: holder?.harness === 'human' ? 'human' : 'agent',
            size: 'sm',
          }),
          h('span', { class: 'quiet' }, remaining(claim.expiresAt, atMs)),
        ),
      ),
    );
  }

  return h('div', { class: 'stack-panel' }, roster, held);
}

/**
 * Rooms, with the open one marked. `onPick` is called with a room name — the
 * view raises intent and never navigates itself.
 *
 * @param {import('./store.js').State} state
 * @param {string} openRoom
 * @param {(name: string) => void} onPick
 */
export function sidebarView(state, openRoom, onPick) {
  const rooms = [...state.rooms.values()].sort((a, b) => a.name.localeCompare(b.name));
  const list = h('nav', { class: 'rooms', 'aria-label': 'rooms' });
  for (const room of rooms) {
    list.append(
      h(
        'button',
        {
          type: 'button',
          class: `room${room.name === openRoom ? ' open' : ''}`,
          'aria-current': room.name === openRoom ? 'page' : null,
          onclick: () => onPick(room.name),
        },
        h('span', { class: 'hash' }, '#'),
        h('span', { class: 'room-name' }, room.name),
        // Unanimity is a different contract, so the room says so before you
        // propose in it rather than when the server refuses.
        room.decisionRule === 'unanimity' && h('span', { class: 'rule-tag' }, 'UNAN'),
      ),
    );
  }
  return list;
}

/**
 * The bar above the stream: which room, its topic, and the derived numbers.
 *
 * @param {import('./store.js').State} state
 * @param {any} room
 * @param {'live'|'reconnecting'} status
 */
export function topBarView(state, room, status) {
  const members = room?.members ?? 0;
  // Derived from the rule, never stored (protocol D5). This is live
  // membership; a deliberation would count the roster frozen at convene, and
  // the surface has to say which one it is showing.
  const quorum = room?.decisionRule === 'unanimity' ? members : Math.floor(members / 2) + 1;

  return h(
    'div',
    { class: 'topbar' },
    h('span', { class: 'hash' }, '#'),
    h('span', { class: 'topbar-room' }, room?.name ?? '—'),
    room?.topic && h('span', { class: 'topbar-topic' }, room.topic),
    h(
      'span',
      { class: 'topbar-right' },
      h(
        'span',
        { class: 'rule-pill' },
        meta(
          `rule: ${room?.decisionRule ?? 'majority'}`,
          room ? `quorum ${quorum}/${members}` : null,
        ),
      ),
      h('span', { class: 'quiet' }, count(members, 'participant')),
      // The stream's own state, stated rather than implied by staleness.
      h('span', { class: `feed feed-${status}` }, status === 'live' ? 'live' : 'reconnecting'),
    ),
  );
}

/**
 * The room's open deliberation, as the head of the stream.
 *
 * Options come through `optionChipProps`, which is the rule that keeps a
 * ballot readable: `hidden` conceals the *tally*, never the label. You cannot
 * vote for a choice you cannot read, and two options both reading "hidden" are
 * a coin toss rather than a ballot.
 *
 * @param {import('./store.js').State} state
 * @param {any} deliberation
 */
export function proposalView(state, deliberation) {
  if (!deliberation) return null;

  const convener = participant(state, deliberation.convenerId);
  const options = (deliberation.options ?? []).map((/** @type {string} */ option) =>
    optionChipProps({ option, hidden: deliberation.phase === 'voting' }, deliberation.phase),
  );

  const card = /** @type {any} */ (h('q-proposal-card', {
    // Which deliberation this card is, so a ballot from it reaches the right
    // one when a room is running more than one.
    'data-deliberation': deliberation.id,
    question: deliberation.question,
    phase: deliberation.phase,
    convener: convener?.name ?? deliberation.by,
    'convener-harness': convener?.harness,
    'convener-kind': convener?.harness === 'human' ? 'human' : 'agent',
    'phase-ends-at': deliberation.phaseEndsAt ? clock(deliberation.phaseEndsAt) : null,
    'votes-cast': deliberation.cast,
    'total-voters': deliberation.eligible?.length ?? deliberation.eligible,
    // Selectable only while there is a ballot to cast. Offering a chip in any
    // other phase is offering an action the server will refuse.
    selectable: deliberation.phase === 'voting' || null,
  }));
  card.options = options;
  return card;
}
