// <q-phase-stepper> — the server-enforced phases as a four-step rail.
//
// `Failed` replaces the terminal step rather than joining the rail as a fifth
// box. A stepper that showed both `Converged` and `Failed` would be drawing a
// path the deliberation did not take, next to the one it did.

import { QuorumElement, define, h } from '../lib/element.js';
import { FAILED, PHASES } from '../lib/phase.js';

export class PhaseStepper extends QuorumElement {
  static props = ['phase', 'size', 'note', 'failureKind'];

  static styles = `
    :host { display: flex; flex-direction: column; gap: var(--sp-3); }
    .rail { display: flex; flex-wrap: wrap; row-gap: var(--sp-3); align-items: center; gap: var(--sp-4); }
    :host([size="sm"]) .rail { gap: var(--sp-3); }
    .step {
      display: inline-flex; align-items: center; gap: var(--sp-3);
      padding: var(--sp-2) var(--sp-4); border-radius: var(--radius-sm);
      border: var(--border-width) solid transparent;
      color: var(--fg-4); font: var(--type-mono-strong);
      letter-spacing: var(--ls-caps); text-transform: uppercase;
      transition: var(--transition-phase);
    }
    :host([size="sm"]) .step { padding: 2px var(--sp-3); font: var(--type-label); }
    .step.done { color: var(--step-hue); }
    .step.active {
      color: var(--step-hue); background: var(--step-tint);
      border-color: currentColor; box-shadow: 0 0 20px -10px currentColor;
    }
    .dot { width: 5px; height: 5px; border-radius: var(--radius-pill); background: currentColor; }
    .step.done .dot { opacity: .55; }
    /* Only an *open* phase pulses. A terminal step is finished, and a finished
       thing that keeps breathing reads as still waiting for you. */
    .step.active.open .dot { animation: q-pulse 1.8s var(--ease-in-out) infinite; }
    .link { flex: 1 1 auto; min-width: 0; height: 1px; background: var(--line-1); }
    .link.done { background: color-mix(in oklab, var(--line-strong) 90%, transparent); }
    .note { font: var(--type-mono); color: var(--text-meta); }
    @media (prefers-reduced-motion: reduce) { .dot { animation: none !important; } }
  `;

  render() {
    const phase = this.attr('phase') ?? 'proposed';
    const failed = phase === 'failed';
    const steps = failed ? [...PHASES.slice(0, 3), FAILED] : PHASES;
    const activeIndex = steps.findIndex((step) => step.id === phase);

    const rail = h('div', { class: 'rail', role: 'group', 'aria-label': 'deliberation phase' });
    steps.forEach((step, index) => {
      const done = index < activeIndex;
      const active = index === activeIndex;
      // `converged` is terminal and `failed` is terminal; both are done breathing.
      const open = active && step.id !== 'converged' && step.id !== 'failed';
      rail.append(
        h(
          'span',
          {
            class: ['step', done && 'done', active && 'active', open && 'open'].filter(Boolean).join(' '),
            style: `--step-hue:${step.hue};--step-tint:${step.tint}`,
            'aria-current': active ? 'step' : null,
          },
          h('span', { class: 'dot', 'aria-hidden': 'true' }),
          // The typed reason rides *inside* the Failed step (D8) — four
          // states, no fifth box. A failure is a phase with a reason, not a
          // separate thing that happened alongside one.
          step.id === 'failed' && this.attr('failureKind')
            ? `${step.label} · ${this.attr('failureKind')}`
            : step.label,
        ),
      );
      if (index < steps.length - 1) {
        rail.append(h('span', { class: `link${done ? ' done' : ''}`, 'aria-hidden': 'true' }));
      }
    });

    const note = this.attr('note');
    return h('div', { style: 'display:contents' }, rail, note && h('div', { class: 'note' }, note));
  }
}

define('q-phase-stepper', PhaseStepper);
