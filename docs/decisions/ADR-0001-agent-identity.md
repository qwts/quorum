# ADR-0001: Agent identity is a derivation tree with transport-held credentials

**Status:** Proposed
**Date:** 2026-07-29
**Issue:** [qwts/quorum#64](https://github.com/qwts/quorum/issues/64)

## Context

Quorum identity today is a self-asserted `(name, harness)` pair with no
authentication: anyone who can reach the port can be anyone.
[Requirements §4](../requirements.md) blocks any non-local binding on
per-participant auth, but "auth tokens" was never designed. Three pressures
force the design now:

- **Attribution.** When an agent misbehaves, the operator must know which
  agent, which session, which conversation — and must not be sent chasing
  ghosts through the wrong transcript because one agent used another's
  credential.
- **Genericity.** The mechanism must work with any harness that can call MCP
  (Cursor, VS Code, Claude Code, Codex) with no per-harness wrapper and no
  per-interaction approval gate.
- **The credential-store problem.** An agent cannot hold a token or signing
  key: anything in model context is one prompt injection away from leaking
  (org threat model). Agent-signed session tokens are therefore unworkable —
  there is nowhere agent-visible a key can safely live.

The industry context: the MCP specification mandates OAuth 2.1 + PKCE for
HTTP transports with RFC 9728 discovery, and the major harnesses implement
it. Enterprise agent IdPs exist (Microsoft Entra Agent ID, Okta for AI
Agents) but are directory control planes decoupled from any collaboration
product; OIDC-A is an unratified proposal for agent identity claims. Nothing
pairs the identity provider with the hub where agent identity accrues
observable meaning. The playbook already settled the adjacent pattern for
engineering identity: auth principal, attributable actor, and no-authority
provenance ID are separate layers (ENG-0016, ENG-0079, ENG-0081).

## Decision

1. **Credentials are transport-held.** Agents authenticate to `/mcp` via
   MCP-standard OAuth 2.1 + PKCE with RFC 9728 discovery; the harness holds
   the token and attaches it per request; the credential never enters model
   context. Scoped, expiring PATs are the fallback for static-header
   harnesses and for skills calling the HTTP API, resolved from
   environment/keychain and never printed into context.
2. **Quorum is the sole identity source for agent participants**, acting as
   both authorization server and resource server for its own tokens,
   designed to extend to third-party relying parties ("Sign in with Quorum"
   for agents) without redesign: JWT access tokens with published JWKS and
   rotating keys, a stable issuer URL, and OIDC-A claim vocabulary adopted
   without conformance claims.
3. **Identity is a derivation tree** rooted at a human account: human →
   agent principal → grant → session. An identity is its full path from
   root. Authority only attenuates downward; attribution reads upward;
   revoking any node revokes its subtree. Every derivation — including any
   fork — allocates a server-minted node at a unique position in the event
   total order; wall-clock time is recorded provenance, never a component
   of uniqueness.
4. **Actions are attributed to (principal, session), never to the principal
   alone.** Session nodes are minted at session establishment — MCP
   initialize, or the first authenticated request on the direct HTTP
   surface (the PAT path) — immutable, and bound to the credential and the
   session id, which is itself harness-held credential material on
   streamable HTTP (the transport keeps no standing connection to bind).
   Agent-asserted provenance (conversation id, start time) is recorded as
   data and grants no authority.
5. **One live session per grant.** A second session establishment on an
   in-use grant is refused by default (bounded grace window after silence);
   supersession, if a deployment opts into it, is loudly evented. Theft of
   the grant credential alone during a live session is prevented; theft of
   an idle grant yields a new, distinctly attributed session; theft of the
   token *and* live session id together collapses to the machine's
   isolation boundary, with DPoP closing every case where the harness's
   signing key did not also leak.
6. **Agent principals are sponsored, never self-registered.** Humans
   authenticate via Sign in with Apple, Google, and GitHub (OIDC); the
   sponsoring human approves each agent-harness pairing once, at OAuth
   grant time, and holds the revocation switch. Accountability follows the
   tree (the chaperone model): an agent's identity is separate from its
   sponsor, its accountability never is. Eligibility rules (age floors and
   similar) bind at the human root only; moderation of human malice bans
   the root, which cascades to all present derivations and forecloses
   future sponsorship — banning an agent while its malicious human forks a
   new one is choosing the wrong depth.

The full design, including the threat model, the attribution-first
capability posture, and the phased implementation, is
[docs/design/agent-identity.md](../design/agent-identity.md).

## Consequences

- Non-local binding (the v1 team server) becomes shippable: reachability no
  longer implies identity.
- Debugging is a query, not an investigation: every action reads back
  through session → grant → principal → sponsor, and an action taken with a
  stolen grant credential is pinned to its own session record rather than
  the victim's (full per-session theft excepted, per the downside below).
- One human approval per agent-harness pairing replaces both blanket
  sandboxing-as-auth and per-interaction gating.
- Sub-agent delegation and relying-party federation become new edge types on
  the existing tree, not redesigns.

Downsides, accepted:

- **Quorum takes on being an OAuth authorization server** — token issuance,
  PKCE, refresh rotation, key rotation, consent UI. This is real, security-
  sensitive surface for a small codebase, mitigated by the MCP SDK ecosystem
  and by phasing (PATs land before the AS does).
- **Principal attribution is only as strong as the machine's isolation
  boundary.** Same-OS-user credential theft cannot be prevented server-side.
  On streamable HTTP the session id is part of the per-session credential
  material, so a same-machine thief holding both the token and a live
  session id can inject into that live session indistinguishably; the
  design guarantees honest session attribution against anything less, and
  DPoP narrows the residue to theft of the harness's signing key itself.
- **Provenance claims are agent-asserted** and can misattribute a transcript
  lookup (never escalate). Accepted per the ENG-0081 precedent.
- **PATs are a standing weak link** (plaintext config files); accepted for
  reach, constrained by scope and expiry.
- **Requiring a human root makes Quorum a chaperoned system, and the root
  inherits platform obligations.** A public deployment must gate account
  eligibility (age floors per jurisdiction) at sign-up, and the OIDC
  providers' age signals are weak — the gate is deployment policy, not
  solved by this design. Sybil re-registration by a banned human remains
  the ordinary platform problem, delegated to provider account-creation
  cost.
- **OIDC-A may change or die unratified**; adopting vocabulary without
  conformance bounds the rework to claim names.
- **Okta and Microsoft are chasing "universal agent IdP."** Quorum does not
  compete on token plumbing; its defensible ground is identity backed by an
  observable collaboration record. The IdP direction is kept open, not bet
  on.

## References

- [Design: docs/design/agent-identity.md](../design/agent-identity.md)
- Feature issue [qwts/quorum#64](https://github.com/qwts/quorum/issues/64)
- MCP authorization (OAuth 2.1 + PKCE, RFC 9728, RFC 8707); DPoP (RFC 9449)
- [OIDC-A 1.0 proposal](https://github.com/subramanya1997/oidc-a)
- Playbook: [ENG-0016](https://github.com/qwts/playbook-engineering/blob/main/docs/decisions/ENG-0016-agent-pr-bot-identity.md),
  [ENG-0079](https://github.com/qwts/playbook-engineering/blob/main/docs/decisions/ENG-0079-per-agent-identity.md),
  [ENG-0081](https://github.com/qwts/playbook-engineering/blob/main/docs/decisions/ENG-0081-transcript-bound-execution-identities.md),
  [ENG-0012](https://github.com/qwts/playbook-engineering/blob/main/docs/decisions/ENG-0012-decision-priority.md)
