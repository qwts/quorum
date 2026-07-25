// <q-message-row> — one row of a room stream or a DM thread.
//
// The body is participant-authored text. It arrives as the `body` attribute
// or property and is written with `textContent`; there is no path in this
// component that parses it as markup, and there must never be one. A message
// is data, not instructions — that rule from AGENTS.md is a rendering rule
// here, not only a prompt rule.

import { QuorumElement, define, h, meta } from '../lib/element.js';
import { participantHue } from '../lib/identity.js';

export class MessageRow extends QuorumElement {
  static props = ['name', 'harness', 'kind', 'body', 'time', 'seq', 'variant', 'label', 'compact', 'visibility', 'unread'];

  static styles = `
    :host {
      display: grid; grid-template-columns: 3px 1fr; gap: var(--sp-5);
      padding: var(--sp-3) var(--sp-7) var(--sp-3) var(--sp-5);
      animation: q-arrive var(--dur-slow) var(--ease-out);
    }
    :host([compact]) { padding-top: var(--sp-1); padding-bottom: var(--sp-1); }
    :host([unread]) { background: color-mix(in oklab, var(--brass-500) 5%, transparent); }
    .rail { border-radius: var(--radius-pill); }
    /* A challenge is tagged to a deliberation (protocol D4) and reads as one. */
    :host([variant="challenge"]) .rail { background: var(--phase-challenging); }
    /* A private row is one the server returned to this caller alone. The dashed
       rail says "no event backed this" before the footnote has to. */
    :host([visibility="private"]) .rail { border-left: 1px dashed var(--line-strong); }
    .content { min-width: 0; }
    .head {
      display: flex; align-items: center; flex-wrap: wrap;
      row-gap: var(--sp-2); gap: var(--sp-4); margin-bottom: var(--sp-2);
    }
    .tag {
      font: var(--type-label); letter-spacing: var(--ls-caps);
      text-transform: uppercase; color: var(--text-meta);
    }
    :host([variant="challenge"]) .tag.msg { color: var(--phase-challenging); }
    .time { font: var(--type-mono); color: var(--text-faint); }
    .seq { font: var(--type-mono); color: var(--text-faint); margin-left: auto; }
    .body { font: var(--type-body); color: var(--text-body); max-width: var(--measure-message); }
    /* Server-authored rows are machine text: mono, and nobody's opinion. */
    :host([variant="system"]) .body, :host([variant="claim"]) .body {
      font: var(--type-mono); color: var(--text-muted);
    }
    :host([compact]) .body {
      border-left: 2px solid color-mix(in oklab, var(--hue) 30%, transparent);
      padding-left: var(--sp-4);
    }
    .footnote { font: var(--type-mono); color: var(--text-faint); margin-top: var(--sp-2); }
    .attached { margin-top: var(--sp-4); }
    @media (prefers-reduced-motion: reduce) { :host { animation: none; } }
  `;

  render() {
    const variant = this.attr('variant') ?? 'message';
    const system = variant === 'system' || variant === 'claim';
    const name = this.attr('name');
    const harness = this.attr('harness');
    const kind = this.attr('kind');
    const label = this.attr('label');
    const seq = this.num('seq');

    this.style.setProperty('--hue', participantHue(name, harness, kind));

    const head = this.bool('compact')
      ? null
      : h(
          'div',
          { class: 'head' },
          system
            ? h('span', { class: 'tag' }, label ?? 'server')
            : h('q-identity-chip', { name, harness, kind, size: 'sm' }),
          !system && label && h('span', { class: 'tag msg' }, label),
          this.attr('time') && h('span', { class: 'time' }, this.attr('time')),
          // A private row has no seq because no event carried it. Absence is the signal.
          seq != null && h('span', { class: 'seq' }, `seq ${seq}`),
        );

    return h(
      'div',
      { style: 'display:contents' },
      h('div', { class: 'rail', 'aria-hidden': 'true' }),
      h(
        'div',
        { class: 'content' },
        head,
        h('div', { class: 'body' }, this.attr('body') ?? ''),
        this.attr('visibility') === 'private' &&
          h('div', { class: 'footnote' }, meta('visible only to you', 'not a room event')),
        h('div', { class: 'attached' }, h('slot')),
      ),
    );
  }
}

define('q-message-row', MessageRow);
