# Recorded design version + sync procedure

Requirement 8: drift between the Design project and the library must be **detectable rather than
discovered.** This file is the receipt. Copy it into the library root and keep it current.

## What this package is

```
design_system: quorum-design-system
design_version: 0.4.0
captured_at: 2026-07-28
source_project: Quorum Design System (Anthropic Design tool)
upstream_repo: qwts/quorum (branch main)
components: 8          # MessageRow, IdentityChip, ProposalCard, PhaseStepper, VoteChip, DissentBadge, DecisionCard, Composer
screens: 6             # room, deliberation, overlay, records, dm, connect
tokens: 139
foundation_cards: 17
```

`0.4.0` is the receipt for the live components the 0.3.0 receipt had drifted from (#38), plus the
2026-07-28 rulings on #19. One removal, called out first: **VoteChip's `ballot` union is gone** — a
v0 ballot is an option index, `choice?: number` replaces it. Added: VoteChip `pending` and
`onClick`-gated button semantics; PhaseStepper `failureKind`; ProposalCard `eligible` / `eligibleAt`
/ `roomMembers`; DecisionCard `reason` (`summary` deprecated), `challengeRefs`, `onOpen`. Ruled: Q6
ballot copy follows D6 (*re-cast until the phase closes — the last ballot counts*); Q10 `hidden` is
ballot secrecy only — `ProposalOption.hidden` is removed from the contract and the reference JSX no
longer forwards it, so option labels always render. The receipt now also lives at the design
project's root, describing the live sources; the `_handoff_*` snapshots keep frozen copies.

`0.3.0` adds the **composer** — the input `--rail-composer-min` reserved space for and the first pass
never specified. It is a design-system primitive (`components/composer/Composer.jsx` + `.d.ts` +
`.prompt.md`), promoted from the UI kit's local chrome, so the library implements it rather than
composing one from tokens. No token changed; no existing prop changed.

`0.2.0` was the version *after* the protocol-review pass: typed failure kinds (`rule_unmet` |
`quorum_absent`, no `expired`), `phase_ends_at` on every phase, derived quorum against the roster
frozen at convene, private claim refusals, considerations-not-stances challenge copy, and the
deliberation overlay. `0.1.0` was the first pass (foundations + seven components + five screens).

## Library side

Record the version the library implements, next to the code:

```json
// src/ui/design-version.json
{ "implements": "0.4.0", "verified": "2026-07-28" }
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
| 0.3.0 | 2026-07-26 | `Composer` promoted to a primitive (8th component): message-not-ballot rule, `phase`/`phaseEndsAt`, private `notice`, `disabled` + `disabledReason`. No token or prop changes. | — |
| 0.4.0 | 2026-07-28 | live-component receipt (#38): VoteChip `ballot`→`choice` (removal), `pending`; PhaseStepper `failureKind`; ProposalCard frozen-roster props; DecisionCard `reason`/`challengeRefs`/`onOpen`. Rulings: Q6 copy follows D6; Q10 `hidden` = ballot secrecy only, `ProposalOption.hidden` removed. | 0.4.0 |
