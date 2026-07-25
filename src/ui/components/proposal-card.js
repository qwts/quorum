// <q-proposal-card> — the head of a live deliberation.
//
// The card offers exactly one action: the one the current phase allows. That
// is not a courtesy — out-of-phase actions are refused by the server, so a
// button for one is a button whose only outcome is an error. A screen sets
// `action-label` for the legal move and listens for the `action` event; when
// no move is legal for this participant, it sets nothing.
//
// Once the phase is terminal, stop rendering this and render
// <q-decision-card>. The record is what exists after close; the proposal is
// not a record with a different border.

import { QuorumElement, define, h } from '../lib/element.js';
import { isTerminal, phaseColor } from '../lib/phase.js';

export class ProposalCard extends QuorumElement {
  static props = [
    'question', 'detail', 'phase', 'convener', 'convenerHarness', 'convenerKind',
    'decisionRule', 'quorum', 'phaseEndsAt', 'challengeCount', 'votesCast', 'totalVoters',
    'selectedOption', 'actionLabel', 'compact', 'selectable',
  ];

  /** `[{ option, count?, total?, hidden? }]` — hidden during voting (protocol D6). */
  static data = ['options'];

  static styles = `
    :host {
      display: flex; flex-direction: column; gap: var(--sp-5);
      background: var(--surface-panel);
      border: var(--border-width) solid var(--line-2);
      border-top: var(--border-width-accent) solid var(--hue);
      border-radius: var(--radius-lg); padding: var(--sp-6) var(--sp-7);
      transition: var(--transition-phase);
    }
    :host([compact]) { padding: var(--sp-5); }
    .top { display: flex; align-items: center; gap: var(--sp-5); flex-wrap: wrap; }
    .label {
      font: var(--type-label); letter-spacing: var(--ls-caps);
      text-transform: uppercase; color: var(--hue);
    }
    .deadline {
      margin-left: auto; font: var(--type-mono); color: var(--hue);
      border: var(--border-width) solid var(--hue); border-radius: var(--radius-pill);
      padding: 1px var(--sp-4); white-space: nowrap;
    }
    h3 { margin: 0; font: var(--type-heading); letter-spacing: var(--ls-tight); color: var(--fg-1); max-width: var(--measure-record); }
    p { margin: var(--sp-4) 0 0; font: var(--type-body); color: var(--text-muted); max-width: var(--measure-message); }
    .meta { display: flex; align-items: center; gap: var(--sp-5); flex-wrap: wrap; font: var(--type-mono); color: var(--text-meta); }
    .by { display: inline-flex; align-items: center; gap: var(--sp-3); }
    .options { display: flex; flex-direction: column; gap: var(--sp-3); }
    .act { display: flex; gap: var(--sp-4); align-items: center; }
    .act button {
      appearance: none; padding: var(--sp-4) var(--sp-6); border-radius: var(--radius-md);
      border: none; background: var(--brass-500); color: var(--fg-on-accent);
      font: var(--type-body-strong); cursor: pointer; transition: var(--transition-hover);
    }
    .act button:hover { background: var(--brass-400); }
    .act button:active { background: var(--brass-600); }
    .hint { font: var(--type-mono); color: var(--text-faint); }
  `;

  render() {
    const phase = this.attr('phase') ?? 'proposed';
    const voting = phase === 'voting';
    const terminal = isTerminal(phase);
    const challenges = this.num('challengeCount') ?? 0;
    const votesCast = this.num('votesCast');
    const deadline = this.attr('phase-ends-at');
    const actionLabel = this.attr('action-label');
    const selected = this.attr('selected-option');

    this.style.setProperty('--hue', phaseColor(phase));

    const options = h('div', { class: 'options' });
    for (const option of this.list('options')) {
      const chip = h('q-vote-chip', {
        option: option.option,
        // During voting a tally would be exactly the anchoring hidden ballots prevent.
        count: voting ? null : option.count,
        total: voting ? null : option.total,
        'ballot-hidden': option.hidden === true,
        selected: selected === option.option,
        interactive: this.hasAttribute('selectable'),
      });
      options.append(chip);
    }

    return h(
      'div',
      { style: 'display:contents' },
      h(
        'div',
        { class: 'top' },
        h('span', { class: 'label' }, 'deliberation'),
        h('q-phase-stepper', { phase, size: 'sm' }),
        deadline && !terminal && h('span', { class: 'deadline' }, `phase_ends_at ${deadline}`),
      ),
      h(
        'div',
        {},
        h('h3', {}, this.attr('question') ?? ''),
        this.attr('detail') && h('p', {}, this.attr('detail')),
      ),
      h(
        'div',
        { class: 'meta' },
        h(
          'span',
          { class: 'by' },
          'convened by',
          h('q-identity-chip', {
            name: this.attr('convener'),
            harness: this.attr('convener-harness'),
            kind: this.attr('convener-kind'),
            size: 'sm',
          }),
        ),
        h('span', {}, `rule: ${this.attr('decision-rule') ?? 'simple majority'}`),
        // Derived from the roster frozen at convene, never typed by hand (protocol D3/D5).
        this.attr('quorum') && h('span', {}, `quorum: ${this.attr('quorum')}`),
        h('span', {}, `${challenges} challenge${challenges === 1 ? '' : 's'}`),
        votesCast != null && h('span', {}, `${votesCast}/${this.num('totalVoters') ?? 0} voted`),
      ),
      this.list('options').length ? options : null,
      actionLabel &&
        h(
          'div',
          { class: 'act' },
          h(
            'button',
            {
              type: 'button',
              // composed, or the event dies at this component's shadow boundary
              // and the screen that owns the deliberation never hears it.
              onclick: () => this.dispatchEvent(new CustomEvent('action', { bubbles: true, composed: true })),
            },
            actionLabel,
          ),
          voting && h('span', { class: 'hint' }, 'ballots stay hidden until the phase closes'),
        ),
    );
  }
}

define('q-proposal-card', ProposalCard);
