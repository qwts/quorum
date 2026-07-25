// The base every Quorum component extends.
//
// Three properties of this base are load-bearing, and each one turns a rule
// that would otherwise live in a document into something the platform enforces:
//
//   1. Shadow DOM. A screen cannot restyle a component in place, because a
//      screen's stylesheet does not reach inside one. The design system's
//      "never restyle a component" is not a convention here; it is a boundary.
//      Design tokens still reach in — custom properties inherit through the
//      shadow boundary — which is exactly the split we want: values cross,
//      overrides do not.
//   2. Text, never markup. `h()` sets `textContent` and has no path that
//      parses a string as HTML. Message bodies are participant-authored
//      (AGENTS.md), so a component that could render them as markup is a
//      cross-site scripting hole wearing a design system.
//   3. Attributes are the API. Everything a screen passes is a string
//      attribute or a property, so a screen written by an agent is inspectable
//      in devtools and diffable in a PR.
//
// There is no build step and no framework: this file is the whole runtime.

/** Compiled stylesheets, one per component class, built the first time it renders. */
const SHEETS = new WeakMap();

/**
 * Build an element. Children that are strings become text nodes — there is no
 * code path here that interprets a string as HTML.
 *
 * @param {string} tag
 * @param {Record<string, string|number|boolean|null|undefined|((e: Event) => void)>} [attrs]
 * @param {...(Node|string|number|null|undefined|false)} children
 * @returns {HTMLElement}
 */
export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/**
 * A `·`-separated mono meta line. Falsy parts drop out rather than leaving a
 * stray separator.
 * @param {...(string|number|null|undefined|false)} parts
 */
export function meta(...parts) {
  return parts.filter((part) => part != null && part !== false && part !== '').join(' · ');
}

export class QuorumElement extends HTMLElement {
  /**
   * Attributes this component reads. Listed here, they become observed
   * attributes and same-named properties, so both `<q-vote-chip option="…">`
   * and `chip.option = '…'` work and both schedule a render.
   * @type {readonly string[]}
   */
  static props = [];

  /**
   * Structured props — arrays and objects, which an attribute cannot carry
   * honestly. These are properties only: `card.options = [...]`. Setting one
   * schedules a render the same way an attribute write does.
   * @type {readonly string[]}
   */
  static data = [];

  /** Component CSS. Compiled once per class into a constructable stylesheet. */
  static styles = '';

  static get observedAttributes() {
    return this.props.map(toAttribute);
  }

  #dirty = false;

  /** Backing store for `static data` props. @type {Map<string, unknown>} */
  values = new Map();

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    const constructor = /** @type {typeof QuorumElement} */ (this.constructor);
    let sheet = SHEETS.get(constructor);
    if (!sheet) {
      sheet = new CSSStyleSheet();
      sheet.replaceSync(constructor.styles);
      SHEETS.set(constructor, sheet);
    }
    root.adoptedStyleSheets = [sheet];
  }

  connectedCallback() {
    this.#schedule();
  }

  attributeChangedCallback() {
    this.#schedule();
  }

  /**
   * Read a structured prop, with a default for the common empty case.
   * @param {string} name
   * @returns {any[]}
   */
  list(name) {
    const value = this.values.get(name);
    return Array.isArray(value) ? value : [];
  }

  /** Coalesce a burst of attribute writes into one render. */
  schedule() {
    this.#schedule();
  }

  /** Coalesce a burst of attribute writes into one render. */
  #schedule() {
    if (this.#dirty || !this.isConnected) return;
    this.#dirty = true;
    queueMicrotask(() => {
      this.#dirty = false;
      if (this.isConnected) this.paint();
    });
  }

  /** Re-render now. Call after setting a property that is not an attribute. */
  paint() {
    const root = /** @type {ShadowRoot} */ (this.shadowRoot);
    root.replaceChildren(this.render());
  }

  /**
   * Return this component's shadow content. Subclasses override.
   * @returns {Node}
   */
  render() {
    return document.createDocumentFragment();
  }

  /**
   * Read an attribute as a string, or `undefined` when absent.
   *
   * Accepts either spelling — `phaseEndsAt` or `phase-ends-at`. A component
   * declares its props in camelCase and reads them back the same way; asking
   * for `challengeCount` and silently getting nothing because the attribute is
   * `challenge-count` is a bug that renders as a plausible zero.
   *
   * @param {string} name
   */
  attr(name) {
    const value = this.getAttribute(toAttribute(name));
    return value === null ? undefined : value;
  }

  /**
   * Read an attribute as a number, or `undefined` when absent or not a number.
   * @param {string} name
   */
  num(name) {
    const value = this.attr(name);
    if (value === undefined || value.trim() === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  /**
   * Read a boolean attribute — present (even empty) means true, `="false"` means false.
   * @param {string} name
   */
  bool(name) {
    const value = this.attr(name);
    return value !== undefined && value !== 'false';
  }
}

/**
 * `phaseEndsAt` → `phase-ends-at`.
 * @param {string} prop
 */
function toAttribute(prop) {
  return prop.replace(/[A-Z]/g, (/** @type {string} */ c) => `-${c.toLowerCase()}`);
}

/**
 * Register a component and give every listed prop an attribute-backed accessor.
 * Doing it here rather than in each class keeps the components declarative:
 * they state their props once and never write a getter.
 *
 * @param {string} tag
 * @param {typeof QuorumElement} constructor
 */
export function define(tag, constructor) {
  for (const prop of constructor.props) {
    const attribute = toAttribute(prop);
    if (Object.getOwnPropertyDescriptor(constructor.prototype, prop)) continue;
    Object.defineProperty(constructor.prototype, prop, {
      get() {
        return this.getAttribute(attribute) ?? undefined;
      },
      set(value) {
        if (value == null || value === false) this.removeAttribute(attribute);
        else this.setAttribute(attribute, value === true ? '' : String(value));
      },
      configurable: true,
      enumerable: true,
    });
  }
  for (const prop of constructor.data) {
    if (Object.getOwnPropertyDescriptor(constructor.prototype, prop)) continue;
    Object.defineProperty(constructor.prototype, prop, {
      get() {
        return this.values.get(prop);
      },
      set(value) {
        this.values.set(prop, value);
        this.schedule();
      },
      configurable: true,
      enumerable: true,
    });
  }
  if (!customElements.get(tag)) customElements.define(tag, constructor);
}
