// The derivation tree: accounts, principals, grants, and who may kill whom
// (ADR-0001, docs/design/agent-identity.md §2).
//
// An identity is its full path from a human root — account → principal →
// grant → session — and two invariants are the whole security model:
// authority only attenuates downward, and revoking a node revokes its
// subtree. This file is where both are written as SQL, together, because a
// cascade split from the node it starts at is a cascade that stops cascading.
// What a credential *is* and whether it is good is identity.ts; what a good
// one is *for* is session.ts.
//
// Phase 1 (design §9) has one root: whoever runs this server, seeded the first
// time a token is minted on the machine. Phase 3 replaces the seeding with an
// OIDC sign-in that fills provider and subject in — the tables do not change,
// only who writes the row.

import { randomUUID } from 'node:crypto';
import { QuorumError } from './errors.ts';
import type { Deps, Sessions } from './session.ts';

/** The human root Phase 1 sponsors from: whoever runs this server. */
const OPERATOR = 'operator';

export type Account = { id: string; name: string };
export type Principal = { id: string; accountId: string; name: string };
export type Grant = { id: string; principalId: string; scopes: string; expiresAt: number | null };

/**
 * An action read upward to its root — which is what attribution *is* (§2).
 * Every field is something the server recorded, except the asserted ones,
 * which are what the agent said about itself and decide nothing.
 */
export type Attribution = {
  session: {
    id: string;
    startedAt: number;
    endedAt: number | null;
    endedReason: string | null;
    source: string;
    assertedConversation: string | null;
    assertedStart: string | null;
  };
  grant: { id: string; scopes: string; revokedAt: number | null };
  principal: { id: string; name: string; revokedAt: number | null };
  account: { id: string; name: string; revokedAt: number | null };
};

type AttributionRow = {
  started_at: number; ended_at: number | null; ended_reason: string | null; source: string;
  asserted_conversation: string | null; asserted_start: string | null;
  grant_id: string; scopes: string; grant_revoked: number | null;
  principal_id: string; principal_name: string; principal_revoked: number | null;
  account_id: string; account_name: string; account_revoked: number | null;
};

export function openTree(deps: Deps & { sessions: Sessions }) {
  const { db, now, appendEvent, sessions } = deps;

  // The root, seeded on first use. The first *live* account, because Phase 1's
  // root is the operator running this process: there is no authority above
  // them to keep a revoked root revoked, so re-seeding after a revocation is
  // honest rather than a bypass. The ban that matters — a revoked root
  // foreclosing future sponsorship (§5.1) — binds in Phase 3, where the root
  // is an OIDC identity nobody can simply mint again.
  function sponsor(): Account {
    const row = db
      .prepare('SELECT id, name FROM accounts WHERE revoked_at IS NULL ORDER BY created_at, rowid LIMIT 1')
      .get() as Account | undefined;
    if (row) return row;
    const account: Account = { id: randomUUID(), name: OPERATOR };
    db.prepare('INSERT INTO accounts (id, name, created_at) VALUES (?, ?, ?)').run(account.id, account.name, now());
    return account;
  }

  function killGrants(grantIds: string[]): string[] {
    const ended: string[] = [];
    for (const grantId of grantIds) {
      db.prepare('UPDATE grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now(), grantId);
      ended.push(...sessions.endAll(grantId, 'revoked'));
    }
    return ended;
  }

  function killPrincipals(principalIds: string[]): { grants: string[]; sessions: string[] } {
    const grants: string[] = [];
    for (const principalId of principalIds) {
      db.prepare('UPDATE principals SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now(), principalId);
      const live = db
        .prepare('SELECT id FROM grants WHERE principal_id = ? AND revoked_at IS NULL')
        .all(principalId) as { id: string }[];
      grants.push(...live.map((row) => row.id));
    }
    return { grants, sessions: killGrants(grants) };
  }

  return {
    /**
     * The agent identity a name stands for, sponsored by the root if it is new.
     *
     * Sponsored, never self-registered (§5): a principal exists because an
     * account vouched for it. Trust-on-first-use minting — whoever asks first
     * owns the name — is the impersonation hole wearing a different hat, so
     * this is only ever reached from the operator's own command line.
     */
    sponsorPrincipal(name: string): Principal {
      const existing = db.prepare('SELECT id, account_id, revoked_at FROM principals WHERE name = ?').get(name) as
        | { id: string; account_id: string; revoked_at: number | null }
        | undefined;
      if (existing?.revoked_at != null) {
        throw new QuorumError(
          `that agent identity is revoked: ${JSON.stringify(name)} — sponsor a new one under a different name`,
        );
      }
      if (existing) return { id: existing.id, accountId: existing.account_id, name };
      const principal: Principal = { id: randomUUID(), accountId: sponsor().id, name };
      db.prepare('INSERT INTO principals (id, account_id, name, created_at) VALUES (?, ?, ?, ?)').run(
        principal.id,
        principal.accountId,
        principal.name,
        now(),
      );
      return principal;
    },

    /** Revoking a grant kills its subtree: the credential, and any session on it. */
    revokeGrant(grantId: string): { sessions: string[] } {
      const row = db.prepare('SELECT id FROM grants WHERE id = ?').get(grantId) as { id: string } | undefined;
      if (!row) throw new QuorumError(`unknown grant: ${JSON.stringify(grantId)}`);
      const ended = killGrants([grantId]);
      appendEvent('grant_revoked', null, { grantId, endedSessionIds: ended }, null);
      return { sessions: ended };
    },

    /** And revoking a principal revokes every grant beneath it (§2). */
    revokePrincipal(name: string): { grants: string[]; sessions: string[] } {
      const row = db.prepare('SELECT id FROM principals WHERE name = ?').get(name?.trim() ?? '') as
        | { id: string }
        | undefined;
      if (!row) throw new QuorumError(`unknown agent identity: ${JSON.stringify(name)}`);
      const killed = killPrincipals([row.id]);
      appendEvent(
        'principal_revoked',
        null,
        { principalId: row.id, grantIds: killed.grants, endedSessionIds: killed.sessions },
        null,
      );
      return killed;
    },

    /**
     * And revoking the root takes the whole tree with it (§5.1): human malice
     * bans the account, not one of the agents it sponsored. Banning the agent
     * while its human sponsors another is choosing the wrong depth.
     */
    revokeAccount(name: string): { principals: string[]; grants: string[]; sessions: string[] } {
      const account = db.prepare('SELECT id FROM accounts WHERE name = ?').get(name?.trim() ?? '') as
        | { id: string }
        | undefined;
      if (!account) throw new QuorumError(`unknown account: ${JSON.stringify(name)}`);
      db.prepare('UPDATE accounts SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now(), account.id);
      const principals = (
        db.prepare('SELECT id FROM principals WHERE account_id = ?').all(account.id) as { id: string }[]
      ).map((row) => row.id);
      const killed = killPrincipals(principals);
      appendEvent(
        'account_revoked',
        null,
        { accountId: account.id, principalIds: principals, grantIds: killed.grants, endedSessionIds: killed.sessions },
        null,
      );
      return { principals, ...killed };
    },

    /**
     * Bind a roster row to the principal that authenticated.
     *
     * The v0 roster keyed on a self-asserted (name, harness) pair; this is the
     * edge that makes a participant an *identity*. A row already bound to
     * another principal is refused — wearing someone else's name is the hole
     * this feature exists to close. An unbound row is claimed by whoever
     * authenticates as it first, which is safe in the way first-come-first-
     * served *credentials* were not: the roster name is a label, and the
     * principal behind it was sponsored before it could present a token.
     */
    bindParticipant(input: { participantId: string; principalId: string }): void {
      const row = db.prepare('SELECT principal_id FROM participants WHERE id = ?').get(input.participantId) as
        | { principal_id: string | null }
        | undefined;
      if (!row) throw new QuorumError(`unknown participant: ${JSON.stringify(input.participantId)}`);
      if (row.principal_id !== null && row.principal_id !== input.principalId) {
        throw new QuorumError('that participant belongs to another agent identity — identify under your own name');
      }
      db.prepare('UPDATE participants SET principal_id = ? WHERE id = ?').run(input.principalId, input.participantId);
    },

    /** Which identity a roster row belongs to, or null while it belongs to none. */
    principalOf(participantId: string): string | null {
      const row = db.prepare('SELECT principal_id FROM participants WHERE id = ?').get(participantId) as
        | { principal_id: string | null }
        | undefined;
      return row?.principal_id ?? null;
    },

    /** The participant a principal identified as most recently, if it has yet. */
    participantFor(principalId: string): string | null {
      const row = db
        .prepare('SELECT id FROM participants WHERE principal_id = ? ORDER BY identified_at DESC, rowid DESC LIMIT 1')
        .get(principalId) as { id: string } | undefined;
      return row?.id ?? null;
    },

    /**
     * An action's identity, read upward from the session it happened in.
     *
     * This is the promise in the ADR's consequences — debugging is a query,
     * not an investigation. An event row carries a session id (quorum.ts), and
     * one read turns it into the whole path back to the sponsoring human.
     */
    attributionOf(sessionId: string): Attribution | null {
      const row = db
        .prepare(
          `SELECT s.started_at, s.ended_at, s.ended_reason, s.source,
                  s.asserted_conversation, s.asserted_start,
                  g.id AS grant_id, g.scopes, g.revoked_at AS grant_revoked,
                  p.id AS principal_id, p.name AS principal_name, p.revoked_at AS principal_revoked,
                  a.id AS account_id, a.name AS account_name, a.revoked_at AS account_revoked
           FROM sessions s
           JOIN grants g ON g.id = s.grant_id
           JOIN principals p ON p.id = g.principal_id
           JOIN accounts a ON a.id = p.account_id
           WHERE s.id = ?`,
        )
        .get(sessionId) as AttributionRow | undefined;
      if (!row) return null;
      return {
        session: {
          id: sessionId,
          startedAt: row.started_at,
          endedAt: row.ended_at,
          endedReason: row.ended_reason,
          source: row.source,
          assertedConversation: row.asserted_conversation,
          assertedStart: row.asserted_start,
        },
        grant: { id: row.grant_id, scopes: row.scopes, revokedAt: row.grant_revoked },
        principal: { id: row.principal_id, name: row.principal_name, revokedAt: row.principal_revoked },
        account: { id: row.account_id, name: row.account_name, revokedAt: row.account_revoked },
      };
    },
  };
}
