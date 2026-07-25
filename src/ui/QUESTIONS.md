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

### Q4 — `claim_refused` as a domain event
Refusals are returned to the refused caller only and the domain emits nothing,
so `<q-message-row visibility="private">` draws the refusal with no `seq` and
the footnote *visible only to you · not a room event*. If the domain gains a
`claim_refused` event, drop the attribute and give the row a `seq`; it becomes
ordinary shared history. One prop, both futures. **Blocking?** no — the private
form is implemented as designed.

### Q5 — `VoteChip.ballot` typed `'for' | 'against' | 'abstain'`
**Answered upstream, implemented as answered.** `docs/deliberation.md` §10
defers abstain to v1 ("considered and declined" vs "vanished" needs presence to
be trustworthy), and the live design system shrank the union to
`'for' | 'against'`. The shipped `0.2.0` `.d.ts` predates that answer, so this
library implements the two-value union and records the delta as `D-1` in
`design-version.json`. **Blocking?** no.

## Open, from the implementation

### Q6 — The overlay's ballot copy contradicts the protocol on re-casting
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
  about re-casting at all. Recorded as `D-2`.
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

### Q10 — The reference JSX and screenshot 04 disagree about `ProposalOption.hidden`
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
