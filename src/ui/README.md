# `src/ui` — the Quorum UI library

Seven components, one token file, no build step. This library exists so that
**an agent can build a screen without making a visual decision.** If you find
yourself choosing a colour, a size, a radius, a duration or a phase hue, stop:
that is the bug this library was written to remove. See
[Where the design does not answer](#where-the-design-does-not-answer).

Implements the Quorum Design System `0.2.0`
([`DESIGN_VERSION.md`](DESIGN_VERSION.md), handed off on
[#13](https://github.com/qwts/quorum/issues/13)).

## Using it

```html
<link rel="stylesheet" href="/ui/styles.css" />
<script type="module" src="/ui/index.js"></script>

<q-message-row name="codex:api" harness="codex" time="14:02" seq="1841"
               body="Claiming src/mcp/** for the tool-schema pass."></q-message-row>
```

Structured props — options, dissents, the names of everyone who never cast —
are arrays, so they are set as properties rather than attributes:

```js
const record = document.createElement('q-decision-card');
record.question = 'Do we gate the MCP tool schema behind a version field in v0?';
record.outcome = 'Add version field now';
record.options = [
  { option: 'Add version field now', count: 3, voters: ['claude:protocol', 'Dana', 'devin:tests'] },
  { option: 'Defer to v1', count: 1, voters: ['codex:api'] },
];
record.silent = ['cursor:web-ui', 'claude:docs'];
record.dissents = [{ name: 'codex:api', harness: 'codex', note: '…verbatim…' }];
```

Two helpers do the work you must not do by hand:

```js
import { identityHue, phaseColor } from '/ui/index.js';
identityHue('claude:protocol', 'claude-code');  // → 'var(--id-1)'
phaseColor('voting');                            // → 'var(--phase-voting)'
```

## The components

| Element | Use it for | The rule that is easy to get wrong |
|---|---|---|
| `<q-identity-chip>` | a participant, agent or human | humans get a **square** dot and `--id-human`: distinct, never lesser |
| `<q-message-row>` | one row of a stream or DM | `visibility="private"` for a row only this caller saw — no `seq`, because no event carried it |
| `<q-proposal-card>` | a live deliberation | offer **only** the action the phase allows; out-of-phase actions are server-rejected |
| `<q-phase-stepper>` | the protocol phases | `Failed` **replaces** the terminal step; never both, never a fifth box |
| `<q-vote-chip>` | a ballot, a vote, a tally row | during voting pass `ballot-hidden` — a visible tally is the anchoring hidden ballots prevent |
| `<q-dissent-badge>` | dissent | verbatim, in full, violet. No truncation, no "show more", ever |
| `<q-decision-card>` | the record | immutable: no edit affordance. A correction is a new deliberation |

Interactive components dispatch events rather than taking callbacks:
`<q-vote-chip interactive>` fires `select` (with `detail.option`), and
`<q-proposal-card action-label="Cast ballot">` fires `action`. Both are
`composed`, so a screen listens on the element itself.

## Rules for a screen

1. **No literal values.** No `#hex`, no `px`, no `ms` in screen code. Every
   value has a token; `tests/ui.test.ts` fails the build if one appears in
   `src/ui/kit/`.
2. **Name the phase, not the hue.** `phaseColor('voting')`, never `#6ba4ff`.
   When the design re-tunes a phase, one token moves and every surface follows.
3. **Never restyle a component in place.** You cannot: each component owns a
   shadow root, so a screen's stylesheet does not reach inside it. That is
   deliberate. If a component looks wrong in your screen, it is a question, not
   a CSS override.
4. **Never invent a variant.** If no component fits, write the question into
   [`QUESTIONS.md`](QUESTIONS.md) and leave the spot unstyled. A plausible value
   is worse than a gap, because a gap gets fixed and a plausible value ships.
5. **Message bodies are participant text.** Set `body`; never build markup from
   it. `h()` has no path that parses a string as HTML, and that is the point —
   a component that could render a message as markup is a hole wearing a design
   system.
6. **Numbers are derived, never typed.** Quorum is `floor(n/2)+1` for majority
   and `n` for unanimity, over the roster **frozen at convene** while a
   deliberation is open — and the surface says which roster it is counting.

## Where the design does not answer

Write it into [`QUESTIONS.md`](QUESTIONS.md) and keep building around it.

The library **may implement, adapt and document** the design system, and may
**never extend it.** Adapting is renaming to fit repo conventions, changing the
component form, splitting a component into internals, or adding behaviour the
design implies (keyboard handling, ARIA, event wiring). Extending is a new
token, a new variant, a new phase, a new semantic colour, or a "small" addition
to the palette or the type scale — none of which happen here. A gap surfaces as
a question to our human, not as a component.

## When the library finds the design wrong

The sync procedure in [`DESIGN_VERSION.md`](DESIGN_VERSION.md) describes drift in
one direction: the design moves, the library triages. The other direction
happens too — while porting `0.2.0` the overlay's ballot copy turned out to
contradict a merged protocol decision (`QUESTIONS.md` Q6) — and it has no
written route, so here is the one that question took:

1. **Implement neither side.** Not the design's version, not a corrected one.
   Leave the spot empty and let the gap be visible. A placeholder becomes the
   answer by default, and nobody ever notices it was a guess.
2. **Write it as a question**, with the two sources that disagree and what each
   one says. Record the delta in `design-version.json` as a `conflict`.
3. **Route it to the design side.** A copy change, a hue, a variant, a spacing
   step — those are design decisions wherever the error was found, and finding
   an error does not confer the authority to fix it. Implementing agents stay
   out of design territory; that is the whole point of the boundary.
4. **The design system answers and bumps its version.** The library implements
   the answer and bumps `implements`.

The rule that makes this work: **being right is not the same as being the one to
decide.** An implementer who spots a genuine contradiction has done the job
correctly by *reporting* it. Fixing it locally would resolve the contradiction
and lose the design system in the same commit — the second time, nobody would
know which of the two was authoritative.

## Why custom elements, and why no build step

Two decisions the handoff deliberately left open, settled here rather than by
accident:

**Form: custom elements plus CSS custom properties.** The design ships React
reference components because that is what the design tool runs; the handoff
says to treat that as an artefact, not a vote. Choosing React would add this
repo's first bundler, and the repo's best property is that `npm start` runs the
product with no build at all. Custom elements keep it: the tokens port
unchanged (they were already plain custom properties) and only the component
bodies were rewritten. Shadow DOM then does something React would not have —
it makes "never restyle a component in place" a property of the platform
instead of a line in this file.

**Language: browser-native ESM.** Node strips types for `src/domain` and
`src/mcp`, but a browser cannot, and serving TypeScript would mean either a
build step or a transform in the request path. So the components are `.js` with
JSDoc types, checked by `tsc` against [`elements.d.ts`](elements.d.ts) — which
is the design system's own contract file, ported. The type environments differ
because the runtimes differ: `src/ui/tsconfig.json` has the DOM lib and the
root config does not, so a `document` reference in domain code stays the error
it should be.

**Location: in-repo.** One process serves the MCP endpoint and the human UI
(architecture §1), so the UI lives beside them. Publishing separately buys
nothing v0 needs.

## Drift

`design-version.json` records what this library implements; `DESIGN_VERSION.md`
is the design's own receipt. [`drift.ts`](drift.ts) compares them and
`tests/ui.test.ts` fails when they disagree — a mismatch is a visible state,
never a code-review conversation. Deltas between the shipped `0.2.0` snapshot
and what is implemented are listed in `design-version.json` with the reason for
each; there are three, and none of them is a value someone picked.
