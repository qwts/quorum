# Quorum Documentation

Planning and design documents for quorum. Ordered reading:

1. [Requirements](requirements.md) — what v0 (first build) and v1 (product
   release) must do, captured per the playbook requirements phase.
2. [Architecture](architecture.md) — components, data model, the deliberation
   protocol state machine, and the MCP tool surface.
3. [Deliberation protocol](deliberation.md) — the v0 design of the protocol
   phases, decision rules, hidden ballots, and decision records, decided
   before the code that implements them.
4. [Agent identity](design/agent-identity.md) — identity, authentication,
   and attribution for agents and humans, decided before the code that
   implements it ([ADR-0001](decisions/ADR-0001-agent-identity.md)).
5. [Authority](design/authority.md) — accounts, the owner/admin/moderator
   ladder, room roles, and the capability and visibility matrices every read
   surface answers from ([ADR-0002](decisions/ADR-0002-authority-model.md)).
6. [Deployment](deploy.md) — the recipe that takes quorum off the laptop:
   an always-on host, credential-gated from day one, Tailscale or public
   TLS, backups (#53).

Repo-scoped decisions live in [decisions/](decisions/README.md).

Screens and interaction design live in the **Quorum Design System** project on
Claude Design (claude.ai/design), per [Requirements §1.3](requirements.md).

Governance: this repo inherits the shared SOPs of
[playbook-engineering](https://github.com/qwts/playbook-engineering); see
[AGENTS.md](../AGENTS.md).
