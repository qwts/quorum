# ADR-0002: Authority is scoped grants on the identity tree, and visibility is one table

**Status:** Proposed
**Date:** 2026-07-29
**Issue:** [qwts/quorum#91](https://github.com/qwts/quorum/issues/91)

## Context

Quorum has no authority model. Every room is visible to the whole instance,
roles do not exist, and `created_by` is the only thing resembling ownership.
That was correct for one operator on one machine and is wrong the day a second
human signs in — which is the entire multi-human wave: sign-in
([#81](https://github.com/qwts/quorum/issues/81)) creates accounts, room roles
([#82](https://github.com/qwts/quorum/issues/82)) grant capabilities, room
lifecycle ([#83](https://github.com/qwts/quorum/issues/83)) says "a chaperone
may delete", moderation ([#54](https://github.com/qwts/quorum/issues/54)) bans,
delegated moderation ([#87](https://github.com/qwts/quorum/issues/87)) hands
rights to humans *and agents*, conduct policies
([#79](https://github.com/qwts/quorum/issues/79)) scope to rooms, and the
bridge ([#77](https://github.com/qwts/quorum/issues/77)) admits foreign guests.
Picked up independently, those seven would invent between three and seven
permission models and the disagreements would surface in review — the failure
[ENG-0007](https://github.com/qwts/playbook-engineering/blob/main/docs/decisions/ENG-0007-feature-lifecycle.md)
exists to prevent. ADR-0001 made this move for identity, and it is why #72
landed clean.

Two pressures shape the answer beyond "write the roles down":

- **Visibility is a security surface, not a UI preference.** Three read
  surfaces already exist (HTTP API, SSE, MCP tools). Three readings of a
  prose paragraph is three products, so what a non-member may see has to be a
  table every surface answers from.
- **The strongest tier is defined by what it does not say.** An `exclusive`
  room is completely invisible to non-members — no signal at all. That single
  requirement propagates: it forbids a globally unique room name, it
  constrains every refusal, and it puts a hard constraint on presence, paging,
  and any future cross-room feature.

The full design, including both matrices, the threat analysis, and the seam
table, is [docs/design/authority.md](../design/authority.md).

## Decision

1. **Authority is scoped grants on the ADR-0001 derivation tree**, not a
   parallel permission system. `grants.scopes` is where the vocabulary lands,
   so attenuation, revocation cascade, and `(principal, session)` attribution
   apply to roles unchanged. Three rules follow and are relied on throughout:
   authority is exercised only through a live derivation (a revoked root holds
   nothing), no grant may act on its own ancestry, and an agent's acts are its
   sponsor's acts.
2. **The account is the human root, and today's principals already sit on
   one.** Phase 1 seeds an `operator` account that every minted principal
   references, so the first OIDC sign-in **claims that row** — filling in
   provider and subject — rather than creating a second account; nothing is
   re-parented and nothing is orphaned. The claim is authorized by a one-time
   token minted on the host, so being first to sign in does not inherit the
   operator's agents. One human holds **one participation account** with
   several linked provider identities (#81), because per-provider accounts
   would make a root ban evadable with a different login button.
3. **The ladder above rooms is owner → admin → moderator, as grants.** The
   **instance owner** — the person hosting the service — is a break-glass
   account with god mode, separate from their daily account, expected to sit
   unused, and loudly logged on the shared feed; it is not a participation
   identity, so it sponsors nothing and owns nothing. **Admins and room owners
   are ordinary rule-following users**, which means an admin cannot see into,
   or administer, an exclusive room. It also means **authorship of
   server-authored guidance stops at admin**: a room owner is an ordinary user,
   so room etiquette they write reaches agents through `quoted()` as data, never
   as text that may steer. A **moderator may be an agent**; a moderation scope
   may not exceed the scope of its sponsoring account, enforcement reaches equal
   or lower standing only, and banning a human root is not a moderator
   capability.
4. **Room roles are owner / member / guest, with `bring agents` a capability
   separate from `post`.** One account owns a room, never a committee; where an
   agent created it, the sponsoring chaperone inherits ownership. A guest does
   not enter a deliberation's eligible roster unless granted in, because
   [D5](../deliberation.md) derives the quorum threshold from that roster.
   The bridge's foreign participants (#77) are this same `guest` role with a
   remote root, not a second vocabulary.
5. **One visibility matrix answers every read surface**, stating what a
   non-member may see across existence, name, occupants, history,
   deliberations, and decisions for public / private / exclusive. **Exclusive
   means no signal whatsoever**: no list entry, no count, no event, and
   refusals indistinguishable from a room that does not exist.
6. **Room names are therefore unique only among the rooms a caller can see.**
   Global uniqueness would answer "that name is taken" and disclose the room.
   Because decision 5 lists public **and** private rooms by name to everyone,
   uniqueness still binds across both of those tiers instance-wide; only
   `exclusive` escapes it. Two rooms may share a name only when at least one is
   exclusive. A name is an address only where it is unambiguous for the caller;
   ids are the unambiguous handle. **This requires changing the current
   schema**, which declares `name TEXT NOT NULL UNIQUE` and pre-checks it
   instance-wide.
7. **No answer may vary with a room the caller cannot see.** Every read is
   computed *over* the caller's visible set rather than globally-then-filtered,
   because a count, a rank, or a latency carries what it was meant to hide.
   This is the general rule behind the presence ruling (#17: liveness names no
   room, advisory status is the participant's own speech, and `busy` is dropped
   because the server would have had to *derive* it), and it binds any future
   `/page` (#84), search, or notification surface. Disclosure is an act —
   invitation, a scoped moderation grant, a member's report — never an
   inference.
8. **Archive is the default and deletion is privileged, and invitation
   attenuates the owner's authority.** Idle rooms auto-archive, never
   auto-delete. A non-public room may be marked for deletion only once every
   chaperone has left; agents may hold it, and a hold expires on a
   settings-backed window. Once no chaperones remain, the agent or the room
   owner may delete — room-owner authority wins over generic chaperone
   authority, and an agent deleting is exercising its sponsor's authority.
   **Eviction-then-deletion stays permitted, not prevented.**
9. **One domain gate, called by both transports.** `src/domain/authority.ts`
   exports the visible set as a SQL predicate and the capability check, and
   evaluates **visibility before capability** — a capability refusal admits the
   room exists. A refusal names the room, the caller's role, and the capability
   that would permit the act, with participant text quoted; a room outside the
   visible set gets the unknown-room refusal instead.
10. **Where the model grants power rather than restricting it, the check is the
    record.** Antisocial-but-permitted acts are recorded and made visible
    (#94), not blocked. Explicit non-goals keep the model small: per-message
    ACLs, groups, custom roles, cross-room inheritance, a trust score here,
    and presence as an authority input.

## Consequences

- The multi-human wave becomes implementable in parallel: #81, #82, #83, #87,
  #54, #79, and #77 cite the two matrices instead of each inventing a model,
  and #82 implements one table rather than three readings of a paragraph.
- Roles inherit the revocation cascade #72 already shipped. Banning a root
  removes its admin scope, its moderator scopes, and its agents' scopes in one
  act, with no separate list to prune.
- Delegated moderation to agents costs no new machinery — an agent moderator is
  a scoped grant with the same attribution and the same revocation.
- The exclusive tier becomes a real boundary rather than a filter: it holds
  against admins and moderators, not only against strangers.
- The no-inference rule gives the presence and paging work a written constraint
  before either is built, so the leak is designed out rather than reviewed out.

Downsides, accepted:

- **Room names stop being globally unique**, which costs the convenience of a
  name as a permanent address. Two visible rooms of one name make a by-name
  reference ambiguous, and the refusal that asks for an id is a worse
  experience than the one it replaces. The cost is confined to callers who can
  see an exclusive room, since every other tier stays unique.
- **This is the repo's first migration that is not additive.** The inline
  `UNIQUE` on `rooms.name` is an implicit index SQLite will not drop, so
  removing it means rebuilding the table; the `addColumn` path in `openQuorum`
  cannot carry it.
- **Every read surface gains a filter, and a missed one is a leak, not a bug in
  the display.** Mitigated by making the visible set a SQL predicate composed
  into each query rather than a post-filter, and by the gate being the only
  place policy lives.
- **An exclusive room can be governed only by its members or by break-glass.**
  Admins are deliberately blind to it. That is the tier's price, and it puts
  weight on the loud logging of the owner account.
- **Eviction-then-deletion is permitted**, and the deletion protocol resists
  carelessness rather than will: evicting members satisfies the
  chaperones-have-left condition immediately, so the hold window never opens.
  The check is the record (#94), which does not exist yet.
- **The one-account rule has a named exception** in the break-glass account.
  It is constrained to hold no participation — no sponsorship, no rooms, no
  roster — which is what keeps it from becoming an alternate identity.
- **The ladder ends at three rungs and the room roles at three.** Deployments
  wanting finer structure get capability switches, not custom roles, and some
  will find that too coarse.

## References

- [Design: docs/design/authority.md](../design/authority.md)
- [ADR-0001: Agent identity](ADR-0001-agent-identity.md) — the derivation tree
  this extends
- Feature issue [qwts/quorum#91](https://github.com/qwts/quorum/issues/91)
  (operator rulings, 2026-07-29), consumed by
  [#54](https://github.com/qwts/quorum/issues/54),
  [#77](https://github.com/qwts/quorum/issues/77),
  [#79](https://github.com/qwts/quorum/issues/79),
  [#81](https://github.com/qwts/quorum/issues/81),
  [#82](https://github.com/qwts/quorum/issues/82),
  [#83](https://github.com/qwts/quorum/issues/83),
  [#87](https://github.com/qwts/quorum/issues/87),
  [#94](https://github.com/qwts/quorum/issues/94)
- Constraining rulings: [#17](https://github.com/qwts/quorum/issues/17)
  (presence axes), [#84](https://github.com/qwts/quorum/issues/84) (`/page` as
  a seam)
- [Requirements §3, §4](../requirements.md),
  [Architecture §5](../architecture.md),
  [Deliberation D3, D5, D10](../deliberation.md)
- Playbook: [ENG-0007](https://github.com/qwts/playbook-engineering/blob/main/docs/decisions/ENG-0007-feature-lifecycle.md),
  [ENG-0008](https://github.com/qwts/playbook-engineering/blob/main/docs/decisions/ENG-0008-shared-sop-inheritance.md),
  [agent conventions](https://github.com/qwts/playbook-engineering/blob/main/docs/reference/agent-conventions.md)
