// <q-vote-chip> — a ballot to cast, a recorded vote, or a tally row.
//
// Two adaptations, both forced and both narrow:
//
//   * the design's `hidden` prop is `ballot-hidden` here, because `hidden` is a
//     global HTML attribute and a chip carrying it would not be drawn at all.
//     The state it names is the opposite: the chip is very much on screen, it
//     is the ballot's *content* that is withheld.
//   * an interactive chip dispatches a `select` event rather than taking an
//     `onClick` prop. A screen listens; it never reaches inside.
//
// `ballot` is `for | against` — the design's third value, `abstain`, is v1
// (protocol §10: "considered and declined" needs presence to be trustworthy).
// See QUESTIONS.md.

import { QuorumElement, define, h } from '../lib/element.js';

export class VoteChip extends QuorumElement {
  static props = ['option', 'count', 'total', 'participant', 'ballot', 'ballotHidden', 'hue', 'selected', 'dissent', 'size', 'interactive'];

  static styles = `
    :host { display: block; }
    :host([total]) { width: 100%; }
    button {
      appearance: none; text-align: left; width: 100%; position: relative; overflow: hidden;
      display: flex; align-items: center; gap: var(--sp-4);
      padding: var(--sp-4) var(--sp-5);
      background: var(--surface-raised); color: var(--fg-1);
      border: var(--border-width) solid var(--line-2); border-radius: var(--radius-md);
      font: var(--type-body-strong); cursor: default; transition: var(--transition-hover);
    }
    :host([size="sm"]) button { padding: var(--sp-2) var(--sp-4); }
    :host([selected]) button { background: color-mix(in oklab, var(--tone) 16%, var(--surface-raised)); border-color: var(--tone); }
    :host([interactive]) button { cursor: pointer; }
    :host([interactive]) button:hover { background: var(--surface-hover); border-color: var(--line-strong); }
    .fill {
      position: absolute; inset: 0; transform-origin: left center;
      transform: scaleX(var(--share, 0));
      background: color-mix(in oklab, var(--tone) 20%, transparent);
      animation: q-tally var(--dur-slow) var(--ease-out);
    }
    .dot {
      position: relative; width: 7px; height: 7px; flex: 0 0 auto;
      border-radius: var(--radius-pill); background: var(--tone);
    }
    /* Cast but not shown: the outline says a ballot is there, the empty centre
       says you are not being told what it is. */
    :host([ballot-hidden]) .dot { background: transparent; box-shadow: inset 0 0 0 1px var(--tone); }
    .option { position: relative; flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .who { position: relative; font: var(--type-mono); color: var(--text-meta); }
    .dissent { position: relative; font: var(--type-label); letter-spacing: var(--ls-caps); color: var(--dissent); }
    .count { position: relative; font: var(--type-mono-strong); color: var(--fg-1); }
    @media (prefers-reduced-motion: reduce) { .fill { animation: none; } }
  `;

  render() {
    const concealed = this.bool('ballot-hidden');
    const ballot = this.attr('ballot') ?? 'for';
    const count = this.num('count');
    const total = this.num('total');
    const interactive = this.bool('interactive');

    const tone = concealed
      ? 'var(--fg-3)'
      : (this.attr('hue') ?? (ballot === 'against' ? 'var(--phase-failed)' : 'var(--phase-converged)'));
    this.style.setProperty('--tone', tone);
    if (total) this.style.setProperty('--share', String((count ?? 0) / total));

    const button = h(
      'button',
      {
        type: 'button',
        disabled: !interactive,
        onclick: interactive
          ? () =>
              this.dispatchEvent(
                // composed, or it never leaves this component's shadow root.
                new CustomEvent('select', { bubbles: true, composed: true, detail: { option: this.attr('option') } }),
              )
          : null,
      },
      total != null && h('span', { class: 'fill', 'aria-hidden': 'true' }),
      h('span', { class: 'dot', 'aria-hidden': 'true' }),
      h('span', { class: 'option' }, concealed ? 'ballot cast — hidden until close' : (this.attr('option') ?? '')),
      this.attr('participant') && h('span', { class: 'who' }, this.attr('participant')),
      this.bool('dissent') && h('span', { class: 'dissent' }, '+ DISSENT'),
      count != null && h('span', { class: 'count' }, total ? `${count} / ${total}` : String(count)),
    );

    if (interactive) button.setAttribute('aria-pressed', String(this.bool('selected')));
    return button;
  }
}

define('q-vote-chip', VoteChip);
