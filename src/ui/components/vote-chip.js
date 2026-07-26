// <q-vote-chip> — a ballot to cast, a ballot already cast, or a tally row.
//
// A v0 ballot is an **option index**, never a stance (deliberation.md §6):
// "add it now" versus "defer to v1" has no against. So the chip carries the
// option's text and, where a row cites one, its index — there is no
// for/against/abstain union left to be wrong about.
//
// Two quiet states, and telling them apart is the whole job during voting.
// `ballot-hidden` is *cast, not shown*; `pending` is *no ballot yet*. The
// roster is drawn cast/not-cast per eligible voter and never the choice —
// turnout is what closes the phase, so it is public; the choice is not.
//
// Two adaptations, both forced and both narrow:
//
//   * the design's `hidden` prop is `ballot-hidden` here, because `hidden` is a
//     global HTML attribute and a chip carrying it would not be drawn at all.
//     The state it names is the opposite: the chip is very much on screen, it
//     is the ballot's *content* that is withheld.
//   * an interactive chip dispatches a `select` event rather than taking an
//     `onClick` prop. A screen listens; it never reaches inside.

import { QuorumElement, define, h } from '../lib/element.js';

export class VoteChip extends QuorumElement {
  static props = ['option', 'choice', 'count', 'total', 'participant', 'ballotHidden', 'pending', 'hue', 'selected', 'dissent', 'size', 'interactive'];

  static styles = `
    :host { display: block; }
    :host([total]) { width: 100%; }
    .chip {
      appearance: none; text-align: left; width: 100%; position: relative; overflow: hidden;
      display: flex; align-items: center; gap: var(--sp-4);
      padding: var(--sp-4) var(--sp-5);
      background: var(--surface-raised); color: var(--fg-1);
      border: var(--border-width) solid var(--line-2); border-radius: var(--radius-md);
      font: var(--type-body-strong); cursor: default; transition: var(--transition-hover);
    }
    :host([size="sm"]) .chip { padding: var(--sp-2) var(--sp-4); }
    :host([selected]) .chip { background: color-mix(in oklab, var(--tone) 16%, var(--surface-raised)); border-color: var(--tone); }
    /* Not cast yet: dashed and faint. Absence has to look different from a
       ballot that is present but withheld, or turnout cannot be read. */
    :host([pending]) .chip { border-style: dashed; color: var(--text-faint); }
    button.chip { cursor: pointer; }
    button.chip:hover { background: var(--surface-hover); border-color: var(--line-strong); }
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
    :host([pending]) .dot { background: transparent; box-shadow: inset 0 0 0 1px var(--line-strong); }
    .index { font: var(--type-mono); color: var(--text-faint); margin-right: var(--sp-3); }
    .option { position: relative; flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .who { position: relative; font: var(--type-mono); color: var(--text-meta); }
    .dissent { position: relative; font: var(--type-label); letter-spacing: var(--ls-caps); color: var(--dissent); }
    .count { position: relative; font: var(--type-mono-strong); color: var(--fg-1); }
    @media (prefers-reduced-motion: reduce) { .fill { animation: none; } }
  `;

  render() {
    const concealed = this.bool('ballot-hidden');
    const pending = this.bool('pending');
    const quiet = concealed || pending;
    const count = this.num('count');
    const total = this.num('total');
    const choice = this.num('choice');
    const interactive = this.bool('interactive');
    const small = this.attr('size') === 'sm';

    this.style.setProperty('--tone', quiet ? 'var(--fg-3)' : (this.attr('hue') ?? 'var(--phase-converged)'));
    if (total) this.style.setProperty('--share', String((count ?? 0) / total));

    const label = pending
      ? (small ? 'no ballot yet' : 'no ballot cast yet')
      : concealed
        ? (small ? 'ballot cast · hidden' : 'ballot cast — hidden until close')
        : (this.attr('option') ?? '');

    // A chip is a real button only when something is listening. An element
    // that tells a screen reader it is pressable and then answers only the
    // mouse is making a promise it cannot keep — so without `interactive` this
    // is a plain element with no role and no tab stop, rather than a disabled
    // button impersonating a row.
    const chip = h(
      interactive ? 'button' : 'div',
      {
        class: 'chip',
        type: interactive ? 'button' : null,
        onclick: interactive
          ? () =>
              this.dispatchEvent(
                // composed, or it never leaves this component's shadow root.
                new CustomEvent('select', {
                  bubbles: true,
                  composed: true,
                  detail: { option: this.attr('option'), choice },
                }),
              )
          : null,
      },
      total != null && h('span', { class: 'fill', 'aria-hidden': 'true' }),
      h('span', { class: 'dot', 'aria-hidden': 'true' }),
      h(
        'span',
        { class: 'option' },
        // A stored ballot cites its index; a concealed or absent one cites
        // nothing, because the index *is* the choice.
        choice != null && !quiet && h('span', { class: 'index' }, `[${choice}]`),
        label,
      ),
      this.attr('participant') && h('span', { class: 'who' }, this.attr('participant')),
      this.bool('dissent') && h('span', { class: 'dissent' }, '+ DISSENT'),
      count != null && h('span', { class: 'count' }, total ? `${count} / ${total}` : String(count)),
    );

    if (interactive) chip.setAttribute('aria-pressed', String(this.bool('selected')));
    return chip;
  }
}

define('q-vote-chip', VoteChip);
