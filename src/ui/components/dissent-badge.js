// <q-dissent-badge> — dissent as recorded, verbatim.
//
// There is deliberately no truncation, no line clamp, no "show more" and no
// summary path in this component. The product promises that a dissenting
// participant's words survive the decision that went against them; a UI that
// collapses the note at 200 characters breaks that promise quietly, on the
// exact records where it matters most.
//
// Violet, never red. Dissent is a record, not an error.

import { QuorumElement, define, h, meta } from '../lib/element.js';

export class DissentBadge extends QuorumElement {
  static props = ['name', 'harness', 'note', 'variant', 'count'];

  static styles = `
    :host {
      display: grid; grid-template-columns: 2px 1fr; gap: var(--sp-5);
      padding: var(--sp-4) var(--sp-5); border-radius: var(--radius-sm);
      background: var(--dissent-tint);
    }
    :host([variant="paper"]) { background: color-mix(in oklab, var(--dissent) 8%, var(--paper-200)); }
    :host([variant="count"]) {
      display: inline-flex; align-items: center; gap: var(--sp-3); vertical-align: middle;
      padding: 2px var(--sp-4); border-radius: var(--radius-pill);
      background: var(--dissent-tint); color: var(--dissent);
      border: var(--border-width) solid color-mix(in oklab, var(--dissent) 38%, transparent);
      font: var(--type-label); letter-spacing: var(--ls-caps); text-transform: uppercase;
    }
    .rail { background: var(--dissent); border-radius: var(--radius-pill); }
    .content { min-width: 0; }
    .head { display: flex; align-items: baseline; gap: var(--sp-4); margin-bottom: var(--sp-2); }
    .label {
      font: var(--type-label); letter-spacing: var(--ls-caps);
      text-transform: uppercase; color: var(--dissent);
    }
    :host([variant="paper"]) .label { color: color-mix(in oklab, var(--dissent) 70%, var(--paper-ink)); }
    .who { font: var(--type-mono); color: var(--text-meta); }
    :host([variant="paper"]) .who { color: var(--paper-ink-2); }
    .note { font: var(--type-body); color: var(--fg-1); max-width: var(--measure-record); }
    :host([variant="paper"]) .note { font: var(--type-record-body); color: var(--paper-ink); }
  `;

  render() {
    if (this.attr('variant') === 'count') {
      const count = this.num('count') ?? 0;
      return h('span', {}, `${count} dissent${count === 1 ? '' : 's'} recorded`);
    }

    return h(
      'div',
      { style: 'display:contents' },
      h('div', { class: 'rail', 'aria-hidden': 'true' }),
      h(
        'div',
        { class: 'content' },
        h(
          'div',
          { class: 'head' },
          h('span', { class: 'label' }, 'dissent'),
          h('span', { class: 'who' }, meta(this.attr('name'), this.attr('harness'))),
        ),
        h('div', { class: 'note' }, this.attr('note') ?? ''),
      ),
    );
  }
}

define('q-dissent-badge', DissentBadge);
