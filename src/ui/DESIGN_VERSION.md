# Recorded design version + sync procedure

Requirement 8: drift between the Design project and the library must be **detectable rather than
discovered.** This file is the receipt. Copy it into the library root and keep it current.

## What this package is

```
design_system: quorum-design-system
design_version: 0.2.0
captured_at: 2026-07-25
source_project: Quorum Design System (Anthropic Design tool)
upstream_repo: qwts/quorum (branch main)
components: 7          # MessageRow, IdentityChip, ProposalCard, PhaseStepper, VoteChip, DissentBadge, DecisionCard
screens: 6             # room, deliberation, overlay, records, dm, connect
tokens: 139
foundation_cards: 17
```

`0.2.0` is the version *after* the protocol-review pass: typed failure kinds (`rule_unmet` |
`quorum_absent`, no `expired`), `phase_ends_at` on every phase, derived quorum against the roster
frozen at convene, private claim refusals, considerations-not-stances challenge copy, and the
deliberation overlay. `0.1.0` was the first pass (foundations + seven components + five screens).

## Library side

Record the version the library implements, next to the code:

```json
// src/ui/design-version.json
{ "implements": "0.2.0", "verified": "2026-07-25" }
```

## Sync procedure

1. **The design project bumps `design_version`** on any change to tokens, component APIs, or the
   normative copy rules. Patch = copy or docs. Minor = a token value, a new prop, a new state.
   Major = a removed token, a renamed component, a changed protocol vocabulary.
2. **Export the manifest with the version.** The design project compiles
   `_ds_manifest.json` (components, cards, tokens); commit it alongside `design-version.json` so a
   diff is mechanical rather than visual.
3. **The library checks on every build/start.** Compare `implements` against the design version in
   the vendored manifest. A mismatch is a **visible state** — fail the check or warn at startup.
   Never leave it to code review.
4. **A mismatch is triaged, not silently absorbed.** For each changed token or prop: implement it, or
   record it as a question (see `QUESTIONS.md`). Bump `implements` only when the delta is closed.
5. **Never resolve a mismatch by editing a value locally.** Downstream-only: the library implements,
   adapts and documents the design system — it never extends it.

## Change log to maintain

| design_version | date | what changed | library `implements` |
|---|---|---|---|
| 0.1.0 | 2026-07-24 | first pass: foundations, 7 components, 5 screens | — |
| 0.2.0 | 2026-07-25 | failure kinds typed; `phase_ends_at`; derived/frozen quorum; private refusals; challenge-copy rule; deliberation overlay | — |
