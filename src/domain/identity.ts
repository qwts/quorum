// Agent identity: the derivation tree and its credentials (ADR-0001,
// docs/design/agent-identity.md §2–§3).
//
// Transport-free like the rest of src/domain/ — this file knows accounts,
// principals, grants, and tokens, and nothing about headers. Pulling a
// credential out of a request is transport work (src/http/auth.ts); deciding
// whether it is any good is domain work, and it happens here, once, for both
// surfaces. Sessions — what a good credential is *for* — are in session.ts.
//
// Phase 1 (design §9): an operator account seeded on the machine, principals
// sponsored by it, PATs minted from the command line, and revocation that
// cascades down the tree. OAuth (Phase 2) and human OIDC (Phase 3) land on
// these same tables rather than replacing them.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { QuorumError } from './errors.ts';
import { openSessions, type Deps, type Refused } from './session.ts';

/** Unmistakable in a config file, and greppable in a log that should not have it. */
export const TOKEN_PREFIX = 'qpat_';

/** Phase 1 has one scope: full participant rights. The vocabulary is Phase 2's. */
export const PARTICIPANT_SCOPE = 'participant';

/** The human root Phase 1 sponsors from: whoever runs this server. */
const OPERATOR = 'operator';

export type Principal = { id: string; accountId: string; name: string };
export type Grant = { id: string; principalId: string; scopes: string; expiresAt: number | null };
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
};

export function openIdentity(deps: Deps) {
  const { db, now, appendEvent } = deps;
  const sessions = openSessions(deps);

  const digestOf = (token: string): Buffer => createHash('sha256').update(token).digest();

  // The human root. Phase 1 has exactly one, seeded here the first time a
  // token is minted on this machine; Phase 3 replaces this with an OIDC
  // sign-in that fills provider and subject in.
  function sponsor(): { id: string; name: string } {
    const row = db.prepare('SELECT id, name FROM accounts ORDER BY created_at, rowid LIMIT 1').get() as
      | { id: string; name: string }
      | undefined;
    if (row) return row;
    const account = { id: randomUUID(), name: OPERATOR };
    db.prepare('INSERT INTO accounts (id, name, created_at) VALUES (?, ?, ?)').run(account.id, account.name, now());
    return account;
  }

  function principalByName(name: string): (Principal & { revokedAt: number | null }) | null {
    const row = db.prepare('SELECT id, account_id, name, revoked_at FROM principals WHERE name = ?').get(name) as
      | { id: string; account_id: string; name: string; revoked_at: number | null }
      | undefined;
    return row ? { id: row.id, accountId: row.account_id, name: row.name, revokedAt: row.revoked_at } : null;
  }

  return {
    // Sessions are the same feature seen from the other end, so they are
    // reachable through one identity surface rather than two imports at every
    // call site. The policy itself lives in session.ts.
    establish: sessions.establish,
    attach: sessions.attach,
    touch: sessions.touch,
    endSession: sessions.close,
    recordAssertion: sessions.record,
    sessionsOf: sessions.of,

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
      const account = sponsor();
      const existing = principalByName(name);
      if (existing?.revokedAt != null) {
        throw new QuorumError(
          `that agent identity is revoked: ${JSON.stringify(name)} — sponsor a new one under a different name`,
        );
      }
      const principal: Principal = existing ?? { id: randomUUID(), accountId: account.id, name };
      if (!existing) {
        db.prepare('INSERT INTO principals (id, account_id, name, created_at) VALUES (?, ?, ?, ?)').run(
          principal.id,
          principal.accountId,
          principal.name,
          now(),
        );
      }
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
      const digest = digestOf(token);
      const rows = db
        .prepare(
          `SELECT g.*, p.account_id, p.name AS principal_name, p.revoked_at AS principal_revoked
           FROM grants g JOIN principals p ON p.id = g.principal_id`,
        )
        .all() as GrantRow[];
      // Compared in constant time, and the loop runs to the end whatever it
      // finds: a byte-wise compare that returns on the first difference, or a
      // scan that stops at the first hit, takes measurably longer for a near
      // miss than for a wrong guess. Cheap discipline, and a small number of
      // grants is not a reason to skip it.
      let found: GrantRow | null = null;
      for (const row of rows) {
        const stored = Buffer.from(row.token_hash, 'hex');
        if (stored.length === digest.length && timingSafeEqual(stored, digest)) found = row;
      }
      // None of the refusals below repeats the token back. A credential that
      // reaches a log, a transcript, or a model's context is a credential to
      // rotate, and an error message is the easiest way for one to get there.
      if (found === null) return { ok: false, refusal: 'that token is not one this server issued' };
      if (found.revoked_at !== null) return { ok: false, refusal: 'that token has been revoked' };
      if (found.principal_revoked !== null) return { ok: false, refusal: 'that agent identity has been revoked' };
      if (found.expires_at !== null && found.expires_at <= now()) {
        return { ok: false, refusal: 'that token has expired' };
      }
      return {
        ok: true,
        grant: { id: found.id, principalId: found.principal_id, scopes: found.scopes, expiresAt: found.expires_at },
        principal: { id: found.principal_id, accountId: found.account_id, name: found.principal_name },
      };
    },

    /** Revoking a grant kills its subtree: the credential, and any session on it. */
    revokeGrant(grantId: string): { ended: string[] } {
      const row = db.prepare('SELECT id FROM grants WHERE id = ?').get(grantId) as { id: string } | undefined;
      if (!row) throw new QuorumError(`unknown grant: ${JSON.stringify(grantId)}`);
      db.prepare('UPDATE grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now(), grantId);
      const ended = sessions.endAll(grantId, 'revoked');
      appendEvent('grant_revoked', null, { grantId, endedSessionIds: ended }, null);
      return { ended };
    },

    /** And revoking a principal revokes every grant beneath it (§2). */
    revokePrincipal(name: string): { grants: string[]; ended: string[] } {
      const principal = principalByName(name?.trim() ?? '');
      if (!principal) throw new QuorumError(`unknown agent identity: ${JSON.stringify(name)}`);
      db.prepare('UPDATE principals SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now(), principal.id);
      const grants = (
        db.prepare('SELECT id FROM grants WHERE principal_id = ? AND revoked_at IS NULL').all(principal.id) as {
          id: string;
        }[]
      ).map((row) => row.id);
      const ended: string[] = [];
      for (const grantId of grants) {
        db.prepare('UPDATE grants SET revoked_at = ? WHERE id = ?').run(now(), grantId);
        ended.push(...sessions.endAll(grantId, 'revoked'));
      }
      appendEvent(
        'principal_revoked',
        null,
        { principalId: principal.id, grantIds: grants, endedSessionIds: ended },
        null,
      );
      return { grants, ended };
    },

    /**
     * Bind a participant row to the principal that authenticated.
     *
     * The v0 roster keyed on a self-asserted (name, harness) pair; this is the
     * edge that makes a participant an *identity*. A row already bound to
     * another principal is refused — wearing someone else's name is the hole
     * this feature exists to close.
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

    /** The participant a principal identified as, if it has yet. */
    participantFor(principalId: string): string | null {
      const row = db
        .prepare('SELECT id FROM participants WHERE principal_id = ? ORDER BY identified_at DESC, rowid DESC LIMIT 1')
        .get(principalId) as { id: string } | undefined;
      return row?.id ?? null;
    },
  };
}

export type Identity = ReturnType<typeof openIdentity>;
