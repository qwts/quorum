// Agent identity: the credentials that open a session on the derivation tree
// (ADR-0001, docs/design/agent-identity.md §3).
//
// Transport-free like the rest of src/domain/ — this file knows tokens, and
// nothing about headers. Pulling a credential out of a request is transport
// work (src/http/auth.ts); deciding whether it is any good is domain work, and
// it happens here, once, for both surfaces. The tree the credential hangs off
// is tree.ts; the session it buys is session.ts. This module composes the
// three into the one surface the rest of the server asks its questions of.
//
// Phase 1 (design §9): an operator account seeded on the machine, principals
// sponsored by it, PATs minted from the command line, and revocation that
// cascades down the tree. OAuth (Phase 2) and human OIDC (Phase 3) land on
// these same tables rather than replacing them.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { QuorumError } from './errors.ts';
import { openSessions, type Deps, type Refused } from './session.ts';
import { openTree, type Grant, type Principal } from './tree.ts';

/** Unmistakable in a config file, and greppable in a log that should not have it. */
export const TOKEN_PREFIX = 'qpat_';

/** Phase 1 has one scope: full participant rights. The vocabulary is Phase 2's. */
export const PARTICIPANT_SCOPE = 'participant';

export type Verified = { ok: true; grant: Grant; principal: Principal };

type GrantRow = {
  id: string;
  principal_id: string;
  token_hash: string;
  scopes: string;
  expires_at: number | null;
  revoked_at: number | null;
  account_id: string;
  principal_name: string;
  principal_revoked: number | null;
  account_revoked: number | null;
};

export function openIdentity(deps: Deps) {
  const { db, now, appendEvent } = deps;
  const sessions = openSessions(deps);
  const tree = openTree({ ...deps, sessions });

  const digestOf = (token: string): Buffer => createHash('sha256').update(token).digest();

  return {
    // Sessions and the tree are the same feature seen from other ends, so they
    // reach the rest of the server through one identity surface rather than
    // three imports at every call site. Each policy stays in its own file.
    establish: sessions.establish,
    attach: sessions.attach,
    touch: sessions.touch,
    endSession: sessions.close,
    recordAssertion: sessions.record,
    sessionsOf: sessions.of,

    revokeGrant: tree.revokeGrant,
    revokePrincipal: tree.revokePrincipal,
    revokeAccount: tree.revokeAccount,
    bindParticipant: tree.bindParticipant,
    principalOf: tree.principalOf,
    participantFor: tree.participantFor,
    attributionOf: tree.attributionOf,

    /**
     * Mint a PAT for an agent, sponsored by the operator account.
     *
     * The secret is returned here and nowhere else, ever: only its SHA-256
     * hash is stored, so a lost token is re-minted rather than recovered, and
     * a database read later holds nothing that can be replayed.
     */
    mint(input: { name: string; ttlMs?: number | null; scopes?: string }): {
      token: string;
      principal: Principal;
      grant: Grant;
    } {
      const name = input.name?.trim();
      if (!name) throw new QuorumError('an agent name is required to mint a token');
      const principal = tree.sponsorPrincipal(name);
      const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
      const grant: Grant = {
        id: randomUUID(),
        principalId: principal.id,
        scopes: input.scopes ?? PARTICIPANT_SCOPE,
        expiresAt: input.ttlMs == null ? null : now() + input.ttlMs,
      };
      db.prepare(
        'INSERT INTO grants (id, principal_id, token_hash, scopes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(grant.id, grant.principalId, digestOf(token).toString('hex'), grant.scopes, now(), grant.expiresAt);
      // Loud on the feed, because a credential appearing is the sponsoring
      // human's business. The payload names the grant; the secret is in the
      // return value and nowhere else.
      appendEvent(
        'grant_minted',
        null,
        { grantId: grant.id, principalId: principal.id, scopes: grant.scopes, expiresAt: grant.expiresAt },
        null,
      );
      return { token, principal, grant };
    },

    /**
     * Whether a presented token is good, and whose it is.
     *
     * Answered on every call rather than once at connect: a revocation has to
     * bite mid-session, and a grant that expires between two calls is expired
     * on the second one.
     */
    verify(presented: string | null): Verified | Refused {
      const token = presented?.trim() ?? '';
      if (token === '') return { ok: false, refusal: 'no access token was presented' };
      if (!token.startsWith(TOKEN_PREFIX)) {
        return { ok: false, refusal: `that credential is not a quorum access token — they begin ${TOKEN_PREFIX}` };
      }
      // One indexed lookup by the token's digest. The key is a SHA-256 of
      // the secret, never the secret: index timing can only leak facts about
      // the digest, which reveals nothing usable about the token — so a
      // constant-time scan of every grant bought no security for its O(n).
      const found = (db
        .prepare(
          `SELECT g.*, p.account_id, p.name AS principal_name, p.revoked_at AS principal_revoked,
                  a.revoked_at AS account_revoked
           FROM grants g
           JOIN principals p ON p.id = g.principal_id
           JOIN accounts a ON a.id = p.account_id
           WHERE g.token_hash = ?`,
        )
        .get(digestOf(token).toString('hex')) ?? null) as GrantRow | null;
      // None of the refusals below repeats the token back. A credential that
      // reaches a log, a transcript, or a model's context is a credential to
      // rotate, and an error message is the easiest way for one to get there.
      if (found === null) return { ok: false, refusal: 'that token is not one this server issued' };
      // Root-first, so the refusal names the highest revoked node: "that
      // token has been revoked" invites minting a replacement, which is the
      // wrong errand when the identity or its sponsor is gone. Revocation
      // cascades (§2), so the root's ban is checked here rather than swept
      // through every grant beneath it.
      if (found.account_revoked !== null) {
        return { ok: false, refusal: 'the account that sponsored that token is revoked' };
      }
      if (found.principal_revoked !== null) return { ok: false, refusal: 'that agent identity has been revoked' };
      if (found.revoked_at !== null) return { ok: false, refusal: 'that token has been revoked' };
      if (found.expires_at !== null && found.expires_at <= now()) {
        return { ok: false, refusal: 'that token has expired' };
      }
      return {
        ok: true,
        grant: { id: found.id, principalId: found.principal_id, scopes: found.scopes, expiresAt: found.expires_at },
        principal: { id: found.principal_id, accountId: found.account_id, name: found.principal_name },
      };
    },

    /** Every grant on the machine, for the operator's CLI. Never token material. */
    listGrants() {
      const rows = db
        .prepare(
          `SELECT g.id, g.scopes, g.created_at, g.expires_at, g.revoked_at, p.name AS principal,
                  (SELECT COUNT(*) FROM sessions s WHERE s.grant_id = g.id AND s.ended_at IS NULL) AS live
           FROM grants g JOIN principals p ON p.id = g.principal_id
           ORDER BY g.created_at, g.rowid`,
        )
        .all() as {
        id: string; scopes: string; created_at: number; expires_at: number | null;
        revoked_at: number | null; principal: string; live: number;
      }[];
      return rows.map((row) => ({
        id: row.id,
        principal: row.principal,
        scopes: row.scopes,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
        liveSessions: row.live,
      }));
    },
  };
}

export type Identity = ReturnType<typeof openIdentity>;
