// The deliberation overlay (#20; design 0.4.0 `DeliberationOverlay`). Its
// states are the named protocol phases: challenging → voting → converged |
// failed, with `phase_ends_at` as a live countdown — expiry is not a state,
// it is how the terminal state gets decided, and the server decides it.
// State in, DOM out, like every view; the timing lives in room-overlay.js.

import { h, meta } from '../../lib/element.js';
import { clock } from './format.js';
import { participant } from './store.js';
import { isTerminal, phaseColor } from '../../lib/phase.js';
import { recordProps } from './record.js';
import { ballotHint, countdown, phaseNote, quorumOf, turnoutNote } from './overlay-model.js';

/**
 * @param {import('./store.js').State} state
 * @param {any} d              the deliberation from the fold
 * @param {any} room           the room it runs in
 * @param {{now: number, pick: string|null, cast: string|null, record: any,
 *          notice: string|null, me: {id: string, name: string}|null,
 *          composer: HTMLElement, ballot: HTMLElement}} ui   pick/cast are
 *          this person's own knowledge (D6-safe); the composer and stable
 *          ballot panel are owned by the controller
 * @param {{close: () => void, pick: (option: string) => void, cast: () => void,
 *          closeChallenges: () => void}} on
 */
export function overlayView(state, d, room, ui, on) {
  const hue = phaseColor(d.phase);
  const eligible = Array.isArray(d.eligible) ? d.eligible : [];
  const quorum = quorumOf(room?.decisionRule, eligible.length);
  const castBy = d.castBy ?? [];
  const terminal = isTerminal(d.phase);
  const convener = participant(state, d.convenerId);
  const members = room?.members;

  const head = h(
    'header',
    { class: 'ov-head' },
    h(
      'div',
      { class: 'ov-headrow' },
      h('span', { class: 'label', style: `color:${hue}` }, 'deliberation'),
      h('span', { class: 'quiet' }, meta(d.id.slice(0, 8), room ? `#${room.name}` : null)),
      terminal
        ? h('span', { class: 'quiet ov-right' }, 'record written · immutable')
        : h(
            'span',
            { class: 'ov-pill ov-right', style: `color:${hue};border-color:${hue}` },
            d.phaseEndsAt ? `phase_ends_at ${clock(d.phaseEndsAt)} · ${countdown(d.phaseEndsAt, ui.now)} left` : '—',
          ),
      h('button', { type: 'button', class: 'ov-back', onclick: on.close }, `Back to #${room?.name ?? 'room'}`),
    ),
    h('h2', { class: 'ov-question' }, d.question),
    h(
      'div',
      { class: 'ov-meta' },
      // A view rebuilt from a record has no convener and no convene time —
      // the record does not carry them — and saying nothing is more honest
      // than "unknown".
      (convener || d.by) &&
        h(
          'span',
          { class: 'ov-meta-item' },
          'convened by ',
          h('q-identity-chip', {
            name: convener?.name ?? d.by,
            harness: convener?.harness === 'human' ? null : convener?.harness,
            kind: convener?.harness === 'human' ? 'human' : 'agent',
            size: 'sm',
          }),
        ),
      h('span', {}, `rule: ${room?.decisionRule ?? 'majority'}`),
      h('span', {}, `quorum: ${quorum} of ${eligible.length}`),
      h(
        'span',
        {},
        d.createdAt
          ? `eligible: ${eligible.length} · roster frozen at convene ${clock(d.createdAt)}`
          : `eligible: ${eligible.length} · roster frozen at convene`,
      ),
      typeof members === 'number' && members !== eligible.length
        ? h('span', { class: 'quiet' }, `room now: ${members} · ${members - eligible.length} joined after convene and cannot cast`)
        : null,
    ),
    h('q-phase-stepper', {
      phase: d.phase,
      'failure-kind': d.phase === 'failed' ? d.failureKind : null,
      note: phaseNote(d.phase, quorum, eligible.length),
    }),
  );

  const body = terminal ? terminalBody(d, ui.record) : liveBody(state, d, ui, on);

  return h(
    'div',
    { class: 'ov-scrim' },
    h('section', { class: 'ov-panel', style: `border-top-color:${hue}`, role: 'dialog', 'aria-label': `deliberation: ${d.question}` }, head, body),
  );
}

/** @param {any} d @param {any} record */
function terminalBody(d, record) {
  const region = h('div', { class: 'ov-record' });
  if (!record) {
    region.append(h('div', { class: 'quiet' }, 'Fetching the decision record…'));
    return region;
  }
  const props = recordProps({ deliberationId: d.id, ...record }, record);
  const card = /** @type {any} */ (
    h('q-decision-card', {
      'record-id': props.recordId,
      question: props.question,
      result: props.result,
      'failure-kind': props.failureKind,
      'decision-rule': props.decisionRule,
      'decided-at': clock(record.closedAt),
      summary: props.summary,
      outcome: props.outcome,
      variant: 'full',
    })
  );
  card.options = props.options;
  card.silent = props.silent;
  card.dissents = props.dissents;
  region.append(
    card,
    h(
      'div',
      { class: 'quiet' },
      d.phase === 'converged'
        ? 'decision_recorded · queryable over get_decision'
        : `deliberation_failed · failure_kind ${d.failureKind} · the ${props.silent.length} eligible voters who never cast are named, quoted, in the record`,
    ),
  );
  return region;
}

/**
 * @param {import('./store.js').State} state @param {any} d @param {any} ui @param {any} on
 */
function liveBody(state, d, ui, on) {
  const voting = d.phase === 'voting';
  const challenges = (state.messages.get(d.roomId) ?? []).filter((m) => m.deliberationId === d.id);

  const rows = h('div', { class: 'ov-challenge-rows' });
  for (const [index, message] of challenges.entries()) {
    const author = participant(state, message.participantId);
    rows.append(
      h('q-message-row', {
        name: author?.name ?? 'unknown',
        harness: author?.harness,
        kind: author?.harness === 'human' ? 'human' : 'agent',
        body: message.body,
        time: clock(message.createdAt),
        variant: 'challenge',
        label: index === 0 ? 'challenge' : null,
      }),
    );
  }
  if (challenges.length === 0) {
    rows.append(h('div', { class: 'empty' }, 'No challenges yet. A consideration posted here appears without a refresh.'));
  }

  const left = h(
    'div',
    { class: 'ov-challenges' },
    h(
      'div',
      { class: 'ov-challenge-head' },
      h('span', { class: 'label' }, `challenges · ${challenges.length}`),
      h('span', { class: 'quiet' }, voting ? 'window closed · read-only' : 'window open'),
    ),
    rows,
    d.phase === 'challenging'
      ? h('div', { class: 'ov-composer' }, ui.composer)
      : h(
          'div',
          { class: 'ov-window-closed quiet' },
          `The challenge window is closed. A challenge posted now would be rejected out-of-phase — post it in the room instead.`,
        ),
  );

  return h('div', { class: 'ov-body' }, left, ui.ballot);
}

/**
 * The stable right-hand panel. The controller keeps its host node alive and
 * replaces these children only when a displayed ballot fact changes (#60).
 * @param {import('./store.js').State} state @param {any} d @param {any} room
 * @param {any} ui @param {any} on
 */
export function ballotView(state, d, room, ui, on) {
  const voting = d.phase === 'voting';
  const eligible = Array.isArray(d.eligible) ? d.eligible : [];
  const castBy = d.castBy ?? [];
  const quorum = quorumOf(room?.decisionRule, eligible.length);
  const chips = h('div', { class: 'ov-options' });
  for (const option of d.options ?? []) {
    chips.append(h('q-vote-chip', {
      option,
      selected: (ui.pick ?? ui.cast) === option || null,
      interactive: voting || null,
      onselect: () => on.pick(option),
    }));
  }
  const castLabel = !ui.pick ? 'Select an option'
    : !ui.cast ? `Cast ballot: ${ui.pick}`
    : ui.pick === ui.cast ? `Ballot cast: ${ui.pick}`
    : `Re-cast ballot: ${ui.pick}`;
  const roster = h('div', { class: 'ov-roster' });
  for (const id of eligible) {
    const person = participant(state, id);
    roster.append(h('div', { class: 'ov-voter' },
      h('q-identity-chip', {
        name: person?.name ?? id,
        harness: person?.harness === 'human' ? null : person?.harness,
        kind: person?.harness === 'human' ? 'human' : 'agent',
        size: 'sm',
      }),
      d.phase === 'challenging' ? null
        : h('q-vote-chip', { size: 'sm', 'ballot-hidden': castBy.includes(id) || null, pending: !castBy.includes(id) || null }),
    ));
  }
  return h('div', { class: 'ov-ballot' },
    h('div', {},
      h('div', { class: 'label ov-gap' }, 'your ballot'),
      chips,
      voting ? h('button', {
        type: 'button', class: 'ov-cast',
        disabled: !ui.pick || ui.pick === ui.cast || null,
        onclick: on.cast,
      }, castLabel) : null,
      ui.notice ? h('div', { class: 'ov-notice' }, ui.notice) : null,
      h('div', { class: 'quiet ov-gap-t' }, ballotHint(d.phase, ui.cast != null)),
    ),
    h('div', {},
      h('div', { class: 'label ov-gap' }, `ballots in · ${castBy.length} of ${eligible.length}`),
      roster,
      h('div', { class: `quiet ov-gap-t${castBy.length >= eligible.length ? ' ov-full' : ''}` },
        turnoutNote(d.phase, castBy.length, quorum, eligible.length)),
    ),
    d.phase === 'challenging' && ui.me && ui.me.id === d.convenerId
      ? h('button', { type: 'button', class: 'ov-resolve', onclick: on.closeChallenges }, 'Close challenges → open voting')
      : null,
  );
}
