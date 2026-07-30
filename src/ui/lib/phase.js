// The protocol's own vocabulary, as tokens.
//
// Nothing in a screen may name `#6ba4ff`; it names `voting` and asks here.
// That is the whole point of semantic tokens: when the design changes the
// voting hue, one token moves and every surface follows.
//
// A note on `proposed`, because the wire and the rail disagree on purpose:
// `proposed` is a step on the stepper but never a phase the server stores.
// Protocol D1 makes it real-but-instantaneous — `propose` opens the challenge
// window in the same transaction — so `deliberations.phase` is only ever
// 'challenging' | 'voting' | 'converged' | 'failed'. Draw `proposed` as a
// completed step; never wait for it to arrive on the event stream.

/** @typedef {'proposed'|'challenging'|'voting'|'converged'|'failed'} Phase */

/** The four steps of the rail, in order. `failed` replaces the fourth. */
export const PHASES = [
  { id: 'proposed', label: 'Proposed', hue: 'var(--phase-proposed)', tint: 'var(--phase-proposed-tint)' },
  { id: 'challenging', label: 'Challenging', hue: 'var(--phase-challenging)', tint: 'var(--phase-challenging-tint)' },
  { id: 'voting', label: 'Voting', hue: 'var(--phase-voting)', tint: 'var(--phase-voting-tint)' },
  { id: 'converged', label: 'Converged', hue: 'var(--phase-converged)', tint: 'var(--phase-converged-tint)' },
];

/** Failure is an outcome with a reason (protocol D8), not an error state. */
export const FAILED = { id: 'failed', label: 'Failed', hue: 'var(--phase-failed)', tint: 'var(--phase-failed-tint)' };

/** Phases the server can actually report — `proposed` is not one of them (D1). */
export const LIVE_PHASES = ['challenging', 'voting', 'converged', 'failed'];

/**
 * @param {string} [phase]
 * @returns {{id: string, label: string, hue: string, tint: string}}
 */
export function phaseStep(phase) {
  if (phase === 'failed') return FAILED;
  return PHASES.find((step) => step.id === phase) ?? /** @type {typeof FAILED} */ (PHASES[0]);
}

/**
 * The hue for a phase — use this for headers, rails, badges and countdowns
 * instead of picking a colour.
 * @param {string} [phase]
 */
export function phaseColor(phase) {
  return phaseStep(phase).hue;
}

/**
 * The tint (the phase hue as a background) for a phase.
 * @param {string} [phase]
 */
export function phaseTint(phase) {
  return phaseStep(phase).tint;
}

/**
 * Terminal phases write a record and stop accepting actions.
 * @param {string} [phase]
 */
export function isTerminal(phase) {
  return phase === 'converged' || phase === 'failed';
}

/**
 * What a proposal's option hands its vote chip, given the phase.
 *
 * A pure function rather than three lines inside `render()`, because the rule
 * it encodes is easy to get subtly wrong and invisible once it is wrong:
 * **the phase conceals the tally, never the label.** You cannot cast a ballot
 * for a choice you cannot read, and an option with no tally at all is not a
 * ballot, it is a coin toss. Screenshot 04 shows both options named during
 * voting, with no counts, and the screenshot is the design (Q10, #19).
 *
 * It lives here, away from the DOM, so it can be tested in Node without a
 * browser — which is the only reason this rule is checkable at all today.
 *
 * @param {{option: string, count?: number, total?: number}} option
 * @param {string} [phase]
 * @returns {{option: string, count: number|null, total: number|null}}
 */
export function optionChipProps(option, phase) {
  // During voting a visible count is exactly the anchoring hidden ballots
  // exist to prevent — suppressed by phase, and only by phase (Q10).
  const concealTally = phase === 'voting';
  return {
    option: option.option,
    count: concealTally ? null : (option.count ?? null),
    total: concealTally ? null : (option.total ?? null),
  };
}

/**
 * The composer's footnote, given what the screen passed.
 *
 * Pure, and here rather than inside `render()`, because the rule it encodes is
 * normative copy the protocol depends on: during a challenge window the hint
 * **must** say that challenges argue considerations. A stance typed into a
 * composer is public voting, and once some ballots are public the hidden ones
 * protect nothing (deliberation.md §6) — so a permissive default hint in that
 * phase would quietly undo the concealment the whole vote rests on.
 *
 * The other half is the disabled case: a quiet field with no explanation is
 * this component's only real failure mode, so there is always a sentence, even
 * when the screen forgets to supply one.
 *
 * An explicit `hint` still wins. The design states the no-permissive-hint rule
 * as guidance to the screen author, not as something the component overrides —
 * implementing it as enforcement would be extending the design, not adapting
 * it.
 *
 * @param {{disabled?: boolean, disabledReason?: string, hint?: string, phase?: string}} input
 * @returns {string}
 */
export function composerHint({ disabled, disabledReason, hint, phase } = {}) {
  if (disabled) return disabledReason || 'Posting is unavailable here.';
  if (hint) return hint;
  return phase === 'challenging'
    ? 'challenges argue considerations — cost, precedent, constraint, timing. Ballots come later and stay hidden.'
    : 'Enter to send · Shift+Enter for a newline';
}
