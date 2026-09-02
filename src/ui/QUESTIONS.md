# Questions

A gap in the design surfaces here — as a question — **not as a component, a
token, or a plausible value.** This is requirement 7 in practice: it removes
the moment where an agent quietly invents a design decision because it needed
one to keep typing.

Append an entry, keep building around the gap, and ship the question with the
PR. An empty file alongside an invented value is the failure this file exists
to prevent.

## Template

```
### Q<n> — <one-line question>
- **Where:** file / component / screen that needed it
- **What I needed:** the specific value or behaviour (a hue, a size, a variant, a state)
- **Why the system does not answer it:** which token or component I checked, and what it does not cover
- **What I did instead:** left it unstyled / used the nearest existing token verbatim / blocked
- **Blocking?** yes / no
```

## Open, from the design side

Carried from the handoff's own `QUESTIONS.md`. These need a decision from the
owner, not from the implementer.

### Q1 — Fonts: confirm IBM Plex, or ship real files
IBM Plex Sans / Mono / Serif is a substitution; the repo ships no font files.
**Blocking?** no — the roles are ported as named, so swapping the family later
is one token file.

### Q2 — Icons: confirm Lucide, or name the set
Lucide 0.469.0 via CDN is a substitution. Icons never appear alone where a word
will do, and phase state is **never** carried by an icon — hue + word.
**Blocking?** no. The seven components need no icons at all; the question lands
when screen chrome does.

### Q3 — Logo: none exists
Wordmark-only until a real mark exists (`quorum` in Plex Sans 600, `-0.03em`,
brass full stop). **Blocking?** no.

### Q4 — `claim_refused` as a domain event — **CLOSED 2026-07-28**
The human ruling is yes: every refused attempt appends a shared
`claim_refused` event with the actor, requested scope, and conflicting claim
ids, while the caller's refusal reply stays unchanged. The staged hinge is now
flipped: the row has a `seq`, no private visibility attribute, and is ordinary
shared history. The gallery expresses that settled row; the live room still
needs claim-event row composition before it can render the shared history.

### Q5 — `VoteChip.ballot` typed `'for' | 'against' | 'abstain'` — **CLOSED 2026-07-26**

> Resolved upstream, and more thoroughly than asked. The union is gone rather than narrowed: a v0
> ballot is an option index, never a stance, so `choice` replaces it. The delta recording the
> narrowed union is closed with it.

**Answered upstream, implemented as answered.** `docs/deliberation.md` §10
defers abstain to v1 ("considered and declined" vs "vanished" needs presence to
be trustworthy), and the live design system shrank the union to
`'for' | 'against'`. The shipped `0.2.0` `.d.ts` predates that answer, so this
library implements the two-value union and records the delta as `D-1` in
`design-version.json`. **Blocking?** no.

## Open, from the implementation

### Q6 — The overlay's ballot copy contradicts the protocol on re-casting — **CLOSED 2026-07-26**

> Resolved upstream. The live `VoteChip` now documents `hidden` as "Re-casting before close
> replaces it (D6)", which is what the protocol does. The contradictory copy survives only in the
> frozen `templates/_handoff_*` snapshots, which are historical records and correctly left alone.
> The library implemented neither side while this was open; it now implements the design's.

- **Where:** `design/ui_kits/quorum-web/DeliberationOverlay.jsx:222` — the mono
  note under the Cast button, and screenshot `07`.
- **What I needed:** the sentence that goes under a ballot before it is cast.
- **Why the system does not answer it:** the design says
  `one ballot per participant · no changes after cast`. Protocol **D6** says the
  opposite — "Re-casting before close is allowed; the last ballot counts" — and
  the `vote` tool's own guidance names re-cast as the next move. Copy is
  normative in this design system, so the two cannot both ship. The design
  predates the merged protocol (this is drift in the direction the sync
  procedure expects: upstream moved).
- **What I did instead:** implemented neither. `<q-proposal-card>` renders the
  hint the design gives for the *voting phase* — "ballots stay hidden until the
  phase closes" — which is true under both readings, and I wrote no sentence
  about re-casting at all. Recorded as `D-2` — since retired from
  `design-version.json`: 0.4.0 closed Q6 and its `note` field carries the
  ruling in D-2's place.
- **Blocking?** no for the library; **yes for the overlay screen**, which has to
  say something in that spot.
- **Ruled 2026-07-25 — routed to the designer, not settled here.** Our human's
  call: a copy change goes through the design side, because the original intent
  is to keep implementing agents out of design territory. So the answer to Q6 is
  not a sentence; it is *which desk the sentence comes from*. `D-2` stands, the
  spot stays empty until the design system speaks, and the overlay screen waits
  on it rather than shipping a placeholder that would become the answer by
  default.

  Worth naming: this exercised a path the sync procedure does not document.
  `DESIGN_VERSION.md` describes drift in one direction — the design moves, the
  library triages. Here the *implementation* found the design contradicting a
  merged protocol decision, and there is no written route back upstream. See
  "When the library finds the design wrong" in `README.md` for the route this
  question took, so the next one does not have to be invented.

### Q7 — `_ds_manifest.json` is not in the handoff
- **Where:** `src/ui/drift.ts`, and `DESIGN_VERSION.md` §"Sync procedure" step 2.
- **What I needed:** the machine-readable manifest of components, cards and
  tokens, so a design change produces a mechanical diff instead of a visual one.
- **Why the system does not answer it:** the procedure names the file and the
  library zip ships `_ds_bundle.js` (a build artefact, explicitly not to port)
  without it. Requirement 8 asks for detectable drift; without the manifest the
  strongest detectable signal is the version string.
- **What I did instead:** implemented the version comparison — `DESIGN_VERSION.md`
  against `design-version.json`, checked in `tests/ui.test.ts`. A token that
  changes value inside an unchanged version is currently undetectable. Exporting
  the manifest with the next design version closes that hole; `drift.ts` is
  written to grow into it.
- **Blocking?** no.

### Q8 — Fonts and icons load from third-party CDNs in a localhost-only tool
- **Where:** `src/ui/tokens/fonts.css` (`@import` from `fonts.googleapis.com`),
  and Lucide from a CDN in the kit screens.
- **What I needed:** to know whether the shipping product may reach the network
  to render.
- **Why the system does not answer it:** Q1 and Q2 ask which *family* and which
  *set*; neither asks how they arrive. Quorum binds to `127.0.0.1` and its
  premise is "an instrument on your machine" — a UI that renders unstyled on a
  plane, or that tells Google every time a developer opens their decision
  history, is a different product promise than the design's prose makes.
  IBM Plex is SIL OFL, so vendoring the files is permitted; that is a
  distribution decision, not a visual one.
- **What I did instead:** ported `tokens/fonts.css` **verbatim**, CDN import
  included — swapping it is not mine to decide and the fallback stack already
  degrades to `system-ui` / `ui-monospace` / `Georgia`.
- **Blocking?** no.

### Q9 — Sub-token pixel values inside components
- **Where:** dot sizes (5–7px), the 3px message rail, the 2px dissent rail.
- **What I needed:** nothing — recording it so nobody "fixes" it later.
- **Why the system does not answer it:** the spacing scale starts at 2px and
  these are smaller-than-scale ornaments; the design's own reference components
  carry the same literals.
- **What I did instead:** ported them verbatim. The adherence test therefore
  checks **screens**, which is where the acceptance criterion puts it, and not
  component internals.
- **Blocking?** no.

### Q10 — The reference JSX and screenshot 04 disagree about `ProposalOption.hidden` — **CLOSED 2026-07-28**

> Ruled on the design side (#19): `hidden` means **ballot secrecy only** — it conceals what a cast
> ballot says, never an option's label. The screenshot was the intent; the reference JSX was the
> bug. Upstream, `ProposalCard.jsx` no longer forwards `hidden={o.hidden}` and
> `ProposalOption.hidden` is removed from the `.d.ts` (design 0.4.0). This library already did the
> right thing — the rule in `optionChipProps()` stands, now backed by the contract instead of a
> screenshot reading.
- **Where:** `design/components/deliberation/ProposalCard.jsx`, which forwards
  `hidden={o.hidden}` to `VoteChip`'s own `hidden`, versus screenshot
  `04-room-voting.png`.
- **What I needed:** what a proposal's options look like during voting.
- **Why the system does not answer it:** the `.d.ts` documents
  `ProposalOption.hidden` without saying what it conceals, and the two other
  sources say different things. `VoteChip`'s `hidden` replaces the label with
  *ballot cast — hidden until close*, so following the JSX renders both options
  identically and unreadably. Screenshot 04 shows **Add version field now** and
  **Defer to v1** both named, with no counts.
- **What I did instead:** followed the screenshot — the label always shows,
  `hidden` conceals the tally. The rule lives in `optionChipProps()` in
  `lib/phase.js` and is unit-tested, because it is invisible when wrong: a
  concealed option during voting looks deliberate, since concealment during
  voting *is* the design. Found in review on
  [#25](https://github.com/qwts/quorum/pull/25); I had ported the JSX.
- **For the design side:** the reference implementation looks like the bug, not
  the screenshot. Worth a line in the `.d.ts` either way, since the next porter
  meets the same fork.
- **Blocking?** no.

### Q11 — No breakpoint token, and no way to derive one
- **Where:** `src/ui/kit/room.html`, a "this window is too narrow" notice.
- **What I needed:** the width below which the fixed rails stop fitting.
- **Why the system does not answer it:** the design is explicit that the rails
  are fixed and never reflow (requirements §1.3), so it defines no breakpoint —
  correctly, since there is no responsive layout to define one for. The
  *derived* number would be `--rail-nav + --rail-sidebar + --rail-roster`, the
  width at which the stream reaches zero, but a CSS media query cannot read
  custom properties, so it cannot be expressed without writing a literal.
- **What I did instead:** shipped no breakpoint at all. A narrow window gets a
  horizontal scrollbar, which is what "never reflowed" means. The library's own
  adherence test caught the literal I had written first, which is the check
  working.
- **Blocking?** no. If a minimum-width notice is wanted, it needs a designed
  value or a licence to hardcode the derived one.

### Q12 — Naming yourself has no designed step

A human must be a participant before they can post, and v0 has no accounts
(requirements §3) — so the browser asks for a name and calls `identify`, the
same claim an agent makes. There is no component for asking.

The library ships one input, the composer, and it is a message field. Rather
than invent a dialog — the thing this library exists to prevent — the name is
collected with the browser's own `prompt()`. It is platform chrome, not a
design decision, which is the only reason it is acceptable as it stands.

The designed home for this is the **connect screen** (screenshots 16–17,
`ConnectAgent.jsx`), which already covers pairing an agent. Two questions for
the design side:

1. Does the connect screen cover a *human* naming themselves, or is that a
   sixth screen?
2. If a dialog is wanted anywhere in this product, it needs to be a primitive —
   a screen composing one from tokens is the delta this rule forbids.

Until then the composer's hint says what pressing send will do: `you will be
asked for a name once`.

### Q13 — The overlay's dimensions and the mock's pulse period have no tokens

- **Where:** `src/ui/kit/room.html` (the deliberation overlay, #20),
  `src/ui/kit/connect.html` (step 2's waiting dot).
- **What I needed:** three values the `DeliberationOverlay` and `ConnectAgent`
  mocks carry as literals: the overlay panel's size (`min(1060px,100%)` ×
  `min(760px,100%)`), its ballot column's width (`flex: 0 1 320px; min-width:
  244px`), and the waiting-dot pulse (`q-pulse 1.6s`/`1.8s`).
- **Why the system does not answer it:** the spacing scale tops out at
  `--sp-10` (64px) and the rail tokens describe the room's fixed chrome, not a
  floating panel; the motion tokens stop at `--dur-slow` (220ms) and their own
  prose says "nothing over 220ms", which the mock's 1.6s pulse contradicts.
- **What I did instead:** the overlay is sized by inset (`--sp-8` padding on
  the scrim) so it tracks the viewport with no literal; the ballot column is
  `calc(var(--rail-roster) + var(--sp-9))` (280px, inside the mock's 244–320
  range); the dots do not pulse, which is also what the room view already
  decided for its feed label ("No pulse. Motion announces arrival and phase
  change, nothing else").
- **Blocking?** no — but if the floating-panel dimensions are meant to be
  designed values, they need tokens; and the pulse needs either a duration
  token above 220ms or the mocks need their animation removed.

### Q14 — Convening a deliberation has no designed input flow

- **Where:** the room screen; requirements 1.1 #9 says a human can *convene*
  through the web UI, and `POST /api/rooms/:room/deliberations` is live.
- **What I needed:** a designed way to collect a question and two-to-ten
  options from a human. The composer is a message field with optional
  `actions`; the mocks show a `propose` action label but no screen that
  gathers a proposal's fields, and the library ships no dialog or form
  primitive (deliberately — see Q12).
- **Why the system does not answer it:** a proposal is multi-field input, and
  every existing input in the system is single-field. Q12's ruling (the
  browser's own `prompt()` is acceptable platform chrome for the *name*)
  could stretch to three chained prompts, but a three-prompt convening flow
  is a UX decision nobody designed, and copy is normative here.
- **What I did instead:** the room composer's designed `propose` action now
  opens native prompts for the question and two-to-ten options, following
  Q12's platform-chrome precedent. It posts through the same domain route as
  the MCP tool. No screen-owned dialog, field, or token treatment was
  invented; replacing the platform prompts remains a design-lane decision.
- **Blocking?** no for the acceptance walk (#21): a human can convene in the
  served UI and the HTTP-plus-domain path is covered. **Still open** for a
  designed multi-field flow before this is called a polished product UX.

### Q15 — Roster presence lines (/status, /blocked) have no designed treatment — **CLOSED 2026-08-07**

> Resolved upstream in design 0.5.0. `IdentityChip` gains `note` plus
> `noteKind: 'status' | 'blocked'`: blocked uses an uppercase neutral label and
> `--line-strong` rail, status uses a transparent rail for identical alignment,
> and neither gains a hue. The participant-authored note is advisory, rendered
> verbatim as text, and independent of the server-derived `status="waiting"` dot.

- **Where:** the room screen roster; #52 gives participants an advisory
  status ("what I am doing") and a blocked state ("stuck, and on what").
- **What I needed:** a designed way to show a short status line beside a
  roster identity, and a visually distinct treatment for blocked — the
  design system ships `q-identity-chip` with no status affordance and no
  blocked variant.
- **What I did instead:** before 0.5.0, a `.quiet` text line under the chip,
  prefixed `blocked:` for the blocked kind — existing styles arranged, no new
  visual invented. The component treatment now replaces that stopgap.
- **Blocking?** no; the data flows and the words are on screen. A designed
  treatment (and whether blocked deserves color) is a design-lane call.
- **Since #17:** the question is bigger than this entry describes, and its
  vocabulary is now settled. Presence is **two independent axes** — server-
  observed liveness (`online` / `offline` / `unknown`) and this self-declared
  status line — so a chip may have to express both at once, and
  `offline` + `blocked` is a legal, meaningful pair. `unknown` renders as it
  does today: nothing. Meanings and legal combinations are in
  [docs/design/presence.md](../../docs/design/presence.md); what to draw is
  now lives in the component; the two axes remain independent.

### Q16 — A forked room message in the DM thread has no designed treatment (#84)

- **Where:** `src/ui/kit/app/dm-model.js` (the fold composes the row),
  `src/ui/kit/app/dm-views.js` (the conversation renders it).
- **What I needed:** how a room message that an `@mention` surfaced in a DM
  thread looks there: inline with an origin marker, or as a quoted reference
  above the private reply; whether the marker links to the room and what it
  says; and — the reverse — whether the *room* message shows that it was also
  delivered privately.
- **Why the system does not answer it:** `q-message-row` has no state for a
  message that originated elsewhere, and the library may not invent one. The
  reverse view is a privacy property wearing a visual decision: the mention
  text is public, but advertising the private context in the room is a
  choice the desk should make explicitly. The implementation's read is *no*.
- **What I did instead:** the row carries `origin` (message id, room id and
  name) and renders as an ordinary message row, unstyled and unmarked. The
  server's guidance carries the origin for agents; humans wait on the desk.
- **Blocking?** no.

