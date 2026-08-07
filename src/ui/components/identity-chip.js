// <q-identity-chip> — the `(name, harness)` pair, agent or human.
//
// The chip is the host element itself rather than a wrapper inside it, so a
// screen can place it inline in a sentence and it behaves like a word.

import { QuorumElement, define, h } from '../lib/element.js';
import { participantHue } from '../lib/identity.js';

export class IdentityChip extends QuorumElement {
  static props = ['name', 'harness', 'kind', 'repo', 'branch', 'size', 'status', 'note', 'noteKind'];

  static styles = `
    :host {
      display: inline-flex; max-width: 100%; vertical-align: middle; white-space: nowrap;
    }
    :host([note]) { flex-direction: column; align-items: flex-start; white-space: normal; }
    .chip {
      display: inline-flex; align-items: center; gap: var(--sp-3); max-width: 100%;
      padding: 2px var(--sp-4) 2px var(--sp-3);
      background: color-mix(in oklab, var(--hue) 12%, transparent);
      border: var(--border-width) solid color-mix(in oklab, var(--hue) 34%, transparent);
      border-radius: var(--radius-pill);
      color: var(--fg-1); font: var(--type-mono-strong); letter-spacing: var(--ls-mono);
      white-space: nowrap; transition: var(--transition-hover);
    }
    :host([size="sm"]) .chip { gap: var(--sp-2); padding: 1px var(--sp-3) 1px var(--sp-2); font: var(--type-mono); }
    :host([onclick]), :host([role="button"]) { cursor: pointer; }
    .dot {
      width: 7px; height: 7px; flex: 0 0 auto; background: var(--hue);
      border-radius: var(--radius-pill);
    }
    :host([size="sm"]) .dot { width: 6px; height: 6px; }
    /* Humans are first-class participants: a square dot marks them as different,
       never as lesser — same size, same weight, same neutral-but-full hue. */
    :host([kind="human"]) .dot { border-radius: var(--radius-xs); }
    :host([status="idle"]) .dot { opacity: .4; }
    /* An agent parked in wait_for_events is not gone — it is listening. */
    :host([status="waiting"]) .dot { animation: q-pulse 1.6s var(--ease-in-out) infinite; }
    .name { overflow: hidden; text-overflow: ellipsis; }
    .harness { color: var(--text-meta); font: var(--type-mono); }
    :host([size="sm"]) .harness { display: none; }
    .note {
      box-sizing: border-box; width: 100%; margin-top: var(--sp-2);
      border-left: var(--border-width-accent) solid transparent; padding-left: var(--sp-3);
      color: var(--text-muted); font: var(--type-mono); white-space: pre-wrap; overflow-wrap: anywhere;
    }
    .note.blocked { border-left-color: var(--line-strong); }
    .note-kind {
      display: block; color: var(--text-meta); font: var(--type-label);
      letter-spacing: var(--ls-caps); text-transform: uppercase;
    }
    @media (prefers-reduced-motion: reduce) { .dot { animation: none; } }
  `;

  render() {
    const name = this.attr('name') ?? '';
    const harness = this.attr('harness');
    const human = this.attr('kind') === 'human';
    const repo = this.attr('repo');
    const branch = this.attr('branch');
    const where = branch ? `${repo ?? ''}@${branch}` : repo;
    const note = this.attr('note');
    const noteKind = this.attr('noteKind') === 'blocked' ? 'blocked' : 'status';

    this.style.setProperty('--hue', participantHue(name, harness, this.attr('kind')));
    this.title = human ? `${name} — human` : `${name} — ${harness ?? 'unknown harness'}${where ? ` · ${where}` : ''}`;

    const chip = h(
      'span',
      { class: 'chip' },
      h('span', { class: 'dot', 'aria-hidden': 'true' }),
      h('span', { class: 'name' }, name),
      human ? h('span', { class: 'harness' }, 'human') : harness && h('span', { class: 'harness' }, harness),
    );
    return h(
      'span',
      { style: 'display:contents' },
      chip,
      note === undefined
        ? null
        : h(
            'span',
            { class: `note ${noteKind}` },
            noteKind === 'blocked' ? h('span', { class: 'note-kind' }, 'blocked') : null,
            h('span', { class: 'note-text' }, note),
          ),
    );
  }
}

define('q-identity-chip', IdentityChip);
