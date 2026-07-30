// The deliberation surface's views: the stream banner and the proposal card.
//
// Split from views.js along the seam the screens already draw — these two are
// the "room during deliberation" state (§1.3), and they are the only views
// that read the phase vocabulary. Same rules as every view: state in, DOM
// out, no colour or size decided here — hues come from lib/phase.js.

import { h } from '../../lib/element.js';
import { clock } from './format.js';
import { messagesIn, participant } from './store.js';
import { optionChipProps, phaseColor, phaseTint } from '../../lib/phase.js';

/**
 * The sticky banner over a room while a deliberation runs (design 0.4.0
 * `StreamBanner`): one chip for the phase that is open right now — the full
 * rail lives on the proposal card, where it has room to be read — and the one
 * navigation the state allows, into the overlay.
 *
 * @param {any} deliberation
 * @param {() => void} onOpen
 */
export function bannerView(deliberation, onOpen) {
  if (!deliberation) return null;
  const copy =
    deliberation.phase === 'voting'
      ? 'Voting — ballots hidden until close · re-cast until then — the last ballot counts'
      : 'Challenge window open — bounded discussion, then the convener closes it';
  return h(
    'div',
    { class: 'banner' },
    h(
      'span',
      { class: 'banner-chip', style: `color:${phaseColor(deliberation.phase)};background:${phaseTint(deliberation.phase)}` },
      h('span', { class: 'banner-dot' }),
      deliberation.phase,
    ),
    h('span', { class: 'banner-copy' }, copy),
    deliberation.phaseEndsAt
      ? h('span', { class: 'banner-deadline', style: `color:${phaseColor(deliberation.phase)}` }, `phase_ends_at ${clock(deliberation.phaseEndsAt)}`)
      : null,
    h('button', { type: 'button', class: 'banner-open', onclick: onOpen }, 'Open deliberation'),
  );
}

/**
 * The room's open deliberation, as the head of the stream.
 *
 * Options come through `optionChipProps`, which is the rule that keeps a
 * ballot readable: the *phase* conceals the tally, never the label. You
 * cannot vote for a choice you cannot read, and an option with no tally at
 * all is a coin toss rather than a ballot.
 *
 * @param {import('./store.js').State} state
 * @param {any} deliberation
 */
export function proposalView(state, deliberation) {
  if (!deliberation) return null;

  const convener = participant(state, deliberation.convenerId);
  const options = (deliberation.options ?? []).map((/** @type {string} */ option) =>
    optionChipProps({ option }, deliberation.phase),
  );

  // Challenges are ordinary messages tagged to the deliberation (D4), so the
  // count is derived from the stream rather than tracked anywhere.
  const challenges = messagesIn(state, deliberation.roomId).filter(
    (/** @type {any} */ message) => message.deliberationId === deliberation.id,
  ).length;

  const card = /** @type {any} */ (h('q-proposal-card', {
    // Which deliberation this card is, so a ballot from it reaches the right
    // one when a room is running more than one.
    'data-deliberation': deliberation.id,
    question: deliberation.question,
    phase: deliberation.phase,
    'challenge-count': challenges,
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
