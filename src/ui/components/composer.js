// <q-composer> — the participant's one input.
//
// The eighth primitive, and the first one in this library that holds state.
// Every other component is a pure function of its attributes and can be thrown
// away and rebuilt on any change. A composer owns a draft, a caret and focus,
// and none of those survive `replaceChildren` — which is the whole reason this
// file is longer than its siblings and overrides `paint`.
//
// Two adaptations, both forced by the platform rather than chosen:
//
//   * `value` / `onChange` is React's controlled-input idiom. Here the draft
//     lives in the field and `value` is a property, as on every native input —
//     never an attribute, so a half-typed message is not reflected into the
//     DOM for devtools and screenshots to carry around. Sending dispatches
//     `send`; a screen listens and never reaches inside.
//   * `actions` may carry an already-rendered glyph, which an attribute cannot
//     hold. They are a structured prop, and a click dispatches `action`.
//
// The protocol rules below are the design system's, not this file's.

import { QuorumElement, define, h } from '../lib/element.js';
import { sendsOnEnter } from '../lib/keys.js';
import { composerHint, phaseColor } from '../lib/phase.js';

export class Composer extends QuorumElement {
  static props = [
    'placeholder', 'hint', 'phase', 'phaseEndsAt', 'notice',
    'disabled', 'disabledReason', 'rows', 'autofocus',
  ];

  static data = ['actions'];

  static styles = `
    :host { display: block; flex: 0 0 auto; }
    .bar {
      min-height: var(--rail-composer-min);
      border-top: var(--border-width) solid var(--line-1);
      background: var(--surface-app);
      padding: var(--sp-5) var(--sp-7) var(--sp-6);
      display: flex; flex-direction: column; gap: var(--sp-4);
    }

    /* A refusal came back to you alone, so it is drawn as a private row —
       dashed rail, no seq, footnoted — and never as an error banner. */
    .notice { border-left: 2px dashed var(--line-strong); padding-left: var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-2); }
    .notice-body { font: var(--type-body); color: var(--text-muted); }
    .notice-foot { font: var(--type-mono); color: var(--text-faint); }

    .phase { display: flex; align-items: baseline; gap: var(--sp-4); }
    .phase-word { font: var(--type-label); letter-spacing: var(--ls-caps); text-transform: uppercase; color: var(--tone); }
    /* Motion announces the phase change and nothing else — one pass, not a loop. */
    :host([phase="challenging"]) .phase-word,
    :host([phase="voting"]) .phase-word { animation: q-pulse var(--dur-slow) var(--ease-out); }
    .ends { font: var(--type-mono); color: var(--text-meta); }

    .box {
      border: var(--border-width) solid var(--line-2);
      border-radius: var(--radius-lg); background: var(--surface-input); overflow: hidden;
    }
    :host([phase]) .box { border-top: var(--border-width-accent) solid var(--tone); }
    :host([disabled]) .box { border-color: var(--line-1); background: var(--surface-panel); opacity: 0.85; }

    /* border-box, or width:100% measures the content and the padding pushes the
       field past .box, whose overflow is hidden — clipping the right edge and
       the end of every long line, in any rail narrower than the measure. */
    textarea {
      width: 100%; box-sizing: border-box; display: block; resize: none; border: none; outline: none;
      background: transparent; color: var(--fg-1); font: var(--type-body);
      max-width: var(--measure-message); padding: var(--sp-5) var(--sp-5) var(--sp-3);
    }

    .foot { display: flex; align-items: center; gap: var(--sp-4); padding: var(--sp-3) var(--sp-4) var(--sp-4); }
    .hint { margin-left: auto; font: var(--type-mono); color: var(--text-faint); text-align: right; }

    button { appearance: none; display: inline-flex; align-items: center; gap: var(--sp-3); flex: 0 0 auto;
      border-radius: var(--radius-md); cursor: pointer; transition: var(--transition-hover); white-space: nowrap; }
    .act { background: transparent; border: var(--border-width) solid var(--line-2); color: var(--text-muted); font: var(--type-mono-strong); padding: var(--sp-3) var(--sp-4); }
    .act[data-accent] { color: var(--text-accent); }
    .act:hover { border-color: var(--line-strong); background: var(--surface-hover); }

    .send { background: var(--brass-500); color: var(--fg-on-accent); border: none; font: var(--type-body-strong); padding: var(--sp-3) var(--sp-5); }
    /* Inert on an empty draft: Enter does nothing and the button says so. */
    .send:disabled { background: var(--ink-600); color: var(--text-faint); cursor: default; }
    .ret { font: var(--type-mono); opacity: 0.7; }

    @media (prefers-reduced-motion: reduce) { .phase-word { animation: none; } }
  `;

  /**
   * The field and the send button outlive every render, and their listeners are
   * bound once here — binding them in `render` would stack another listener on
   * the same node per attribute change, until one keystroke sent several times.
   */
  #field = /** @type {HTMLTextAreaElement} */ (h('textarea', {
    oninput: () => this.#sync(),
    onkeydown: (/** @type {Event} */ event) => {
      // Only prevented when it actually sends: a newline and an IME confirming
      // a candidate both need the keystroke to reach the field.
      if (!sendsOnEnter(/** @type {KeyboardEvent} */ (event))) return;
      event.preventDefault();
      this.#submit();
    },
  }));

  #send = /** @type {HTMLButtonElement} */ (h(
    'button',
    { type: 'button', class: 'send', onclick: () => this.#submit() },
    'Send',
    h('span', { class: 'ret', 'aria-hidden': 'true' }, '⏎'),
  ));

  connectedCallback() {
    super.connectedCallback();
    // After the base's first paint has queued, so the field is attached and
    // focusable by the time this runs.
    if (this.bool('autofocus') && !this.bool('disabled')) queueMicrotask(() => this.#field.focus());
  }

  /** The draft. A property rather than an attribute, as on any native input. */
  get value() {
    return this.#field.value;
  }

  set value(next) {
    this.#field.value = next ?? '';
    this.#sync();
  }

  /** Whether sending would do anything: something to send, and somewhere to send it. */
  get #ready() {
    return !this.bool('disabled') && this.#field.value.trim().length > 0;
  }

  #sync() {
    this.#send.disabled = !this.#ready;
  }

  /**
   * Hand the draft to the screen. Deliberately does **not** clear the field:
   * the screen clears it once the server has the message, so a post that fails
   * leaves the words on screen instead of eating them.
   */
  #submit() {
    if (!this.#ready) return;
    this.dispatchEvent(
      // composed, or it dies at this component's shadow boundary.
      new CustomEvent('send', { bubbles: true, composed: true, detail: { value: this.#field.value } }),
    );
  }

  /**
   * Re-render without losing what is being typed. `replaceChildren` detaches
   * the field, which blurs it and drops the caret — and a phase change or an
   * arriving notice re-renders mid-sentence, jumping the cursor to the end of
   * the draft while someone is editing the middle of it.
   */
  paint() {
    const focused = this.shadowRoot?.activeElement === this.#field;
    const { selectionStart, selectionEnd } = this.#field;
    super.paint();
    if (!focused) return;
    this.#field.focus();
    if (selectionStart != null && selectionEnd != null) {
      this.#field.setSelectionRange(selectionStart, selectionEnd);
    }
  }

  render() {
    const disabled = this.bool('disabled');
    const phase = this.attr('phase');
    const notice = this.attr('notice');
    const endsAt = this.attr('phaseEndsAt');

    if (phase) this.style.setProperty('--tone', phaseColor(phase));

    this.#field.placeholder = disabled ? '' : (this.attr('placeholder') ?? 'Message');
    this.#field.rows = this.num('rows') ?? 2;
    this.#field.disabled = disabled;
    this.#sync();

    // A disabled composer states the limit where the hint would be, because
    // that is the line the eye already goes to. The rule itself lives in
    // lib/phase.js, where it can be tested without a browser.
    const hint = composerHint({
      disabled,
      disabledReason: this.attr('disabledReason'),
      hint: this.attr('hint'),
      phase,
    });

    return h(
      'div',
      { class: 'bar' },
      notice &&
        h(
          'div',
          { class: 'notice' },
          h('span', { class: 'notice-body' }, notice),
          h('span', { class: 'notice-foot' }, 'visible only to you · not a room event'),
        ),
      phase &&
        h(
          'div',
          { class: 'phase' },
          h('span', { class: 'phase-word' }, phase),
          endsAt && h('span', { class: 'ends' }, `phase_ends_at ${endsAt}`),
        ),
      h(
        'div',
        { class: 'box' },
        this.#field,
        h(
          'div',
          { class: 'foot' },
          ...(disabled ? [] : this.list('actions').map((action) => this.#actionButton(action))),
          h('span', { class: 'hint' }, hint),
          disabled ? null : this.#send,
        ),
      ),
    );
  }

  /**
   * Actions are words, optionally with a glyph the caller has already rendered
   * — the design system ships no icon set on purpose. A click both calls the
   * action's own `onClick` and dispatches `action`; a screen uses one or the
   * other, and neither is silently dropped.
   *
   * @param {{ label: string, accent?: boolean, icon?: Node, onClick?: () => void }} action
   */
  #actionButton(action) {
    return h(
      'button',
      {
        type: 'button',
        class: 'act',
        'data-accent': action.accent || null,
        onclick: () => {
          action.onClick?.();
          this.dispatchEvent(
            new CustomEvent('action', { bubbles: true, composed: true, detail: { label: action.label } }),
          );
        },
      },
      action.icon,
      action.label,
    );
  }
}

define('q-composer', Composer);
