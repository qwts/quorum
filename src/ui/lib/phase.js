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
