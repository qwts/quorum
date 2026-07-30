// The credential guard: which requests may act as anybody at all.
//
// Sibling of origin.ts, and deliberately the same shape — one function that
// returns the refusal to send, or the caller it recognised. Both transports go
// through it, so there is exactly one place that decides what a credential
// buys: the MCP endpoint (src/mcp/server.ts) and the human/skills HTTP surface
// (write.ts, api.ts, events.ts). A second check would be a second policy.
//
// The split of labour with the domain is the layering rule (AGENTS.md): taking
// a token out of an `Authorization` header is transport work and lives here;
// deciding whether the token is good, and minting or riding the session it
// opens, is domain work and lives in src/domain/identity.ts.
//
// Two properties this file is responsible for:
//
//   * **Off by default.** With `QUORUM_AUTH` unset, nothing here runs and v0
//     behaves exactly as it did — localhost trust, self-asserted identity.
//     Enforcement is a deployment decision, and the day it becomes the default
//     is the day non-local binding ships (requirements §4).
//   * **A refusal never repeats the credential.** Not in the message, not in a
//     log line. A token that reaches a transcript is a token to rotate, and an
//     error message is the shortest path there. What a refusal *does* carry is
//     what is missing, where a token comes from, and which switch turned this
//     on — a refusal nobody can act on is a bug with better manners.

import type { IncomingMessage } from 'node:http';
import { TOKEN_PREFIX } from '../domain/identity.ts';
import { DEFAULT_SESSION_GRACE_MS } from '../domain/session.ts';
import type { Quorum } from '../domain/quorum.ts';

export const AUTH_ENV = 'QUORUM_AUTH';

/** What a session record says it was opened through (ADR-0001 §4.1). */
export const HTTP_SOURCE = 'http';

/** Whether credentials are enforced. Absent or `0` is v0 — nothing changes. */
export function authRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env[AUTH_ENV] ?? '').trim().toLowerCase();
  return value !== '' && value !== '0' && value !== 'off' && value !== 'false';
}

/** How long a session may be silent before another may take its grant (§4.2). */
export function sessionGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.QUORUM_SESSION_GRACE_MS);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : DEFAULT_SESSION_GRACE_MS;
}

/** The bearer token on a request, or null. The scheme is case-insensitive per RFC 7235. */
export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  // Linear-time on purpose (CodeQL): scheme test, then a plain slice — a
  // crafted header full of tabs must not make a backtracking regex crawl.
  const trimmed = header.trim();
  if (!/^bearer[ \t]/i.test(trimmed)) return null;
  const token = trimmed.slice('bearer'.length).trim();
  return token === '' ? null : token;
}

/** Who a request is, once its credential has been believed. */
export type Caller = {
  grantId: string;
  principalId: string;
  principalName: string;
  sessionId: string;
  /** The participant this principal identified as, or null before it has. */
  participantId: string | null;
};

export type Authorized = { caller: Caller };
export type Refusal = { refusal: string };

/**
 * How a refusal reads to whoever hits it: what is missing, where a token comes
 * from, and which switch turned the check on. The presented credential is
 * never part of it.
 */
function refuse(reason: string): Refusal {
  return {
    refusal:
      `${reason}. Send a quorum access token with the request as \`Authorization: Bearer ${TOKEN_PREFIX}…\` —` +
      ` the harness or script holds it, and it must never be pasted into a conversation or a tool argument.` +
      ` The operator mints one on this machine with \`npm run mint-token -- --name <agent>\`.` +
      ` This check is on because ${AUTH_ENV} is set; unset it to go back to localhost trust.`,
  };
}

/**
 * Authorize a request and give it a session.
 *
 * `resume` continues a session the credential already opened — the MCP session
 * id is credential *material*, not a credential (design §4.1), so it is only
 * ever checked against the grant that opened it, never trusted on its own.
 * `establish` mints a new session node and is where the one-live-session rule
 * bites (§4.2). Neither given, the request rides the session this transport
 * already has for the grant, minting one on the first authenticated call — the
 * PAT-over-HTTP path (§3.2).
 */
export function authorize(
  req: IncomingMessage,
  quorum: Quorum,
  options: { source: string; establish?: boolean; resume?: { sessionId: string; grantId: string } },
): Authorized | Refusal {
  const identity = quorum.identity;
  const verified = identity.verify(bearerToken(req));
  if (!verified.ok) return refuse(verified.refusal);

  const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null;
  const of = (sessionId: string): Authorized => ({
    caller: {
      grantId: verified.grant.id,
      principalId: verified.principal.id,
      principalName: verified.principal.name,
      sessionId,
      participantId: identity.participantFor(verified.principal.id),
    },
  });

  if (options.resume) {
    if (options.resume.grantId !== verified.grant.id) {
      return refuse('that session belongs to another credential');
    }
    // Any authenticated call keeps the session alive; a session that is gone —
    // superseded or revoked out from under this connection — cannot be spoken
    // through, which is what makes a revocation bite mid-session.
    if (!identity.touch(options.resume.sessionId)) {
      return refuse('that session has ended — it was superseded by a newer one, or its grant was revoked');
    }
    return of(options.resume.sessionId);
  }

  const graceMs = sessionGraceMs();
  const opened = options.establish
    ? identity.establish({ grantId: verified.grant.id, source: options.source, userAgent, graceMs })
    : identity.attach({ grantId: verified.grant.id, source: options.source, userAgent, graceMs });
  if (!opened.ok) return refuse(opened.refusal);
  return of(opened.session.id);
}

/**
 * Whether a caller may act as the participant a request names — the `?as=`
 * read seams and the self-asserted `participantId` in every write body.
 *
 * This is the v0 hole closed: those values were assertions, and an assertion
 * is only as good as who is allowed to make it. Now a credentialed request may
 * name exactly the participant its own principal identified as.
 */
export function refuseAs(caller: Caller, participantId: string | null | undefined): string | null {
  if (participantId === null || participantId === undefined || participantId === '') return null;
  if (caller.participantId === null) {
    return 'your agent identity has no participant yet — call identify first, then name the participant it created';
  }
  if (caller.participantId !== participantId) {
    return 'that participant is not the one your credential identified as; a token speaks only for its own identity';
  }
  return null;
}

/**
 * The `?as=` read seams, in one call: authorize the request, then insist the
 * view it asks for is its own. Returns the refusal to send, or null when the
 * read may proceed — including when enforcement is off, which is what keeps
 * every v0 reader working untouched.
 */
export function refuseView(req: IncomingMessage, quorum: Quorum, as: string | null): string | null {
  if (!authRequired()) return null;
  const check = authorize(req, quorum, { source: HTTP_SOURCE });
  if ('refusal' in check) return check.refusal;
  return refuseAs(check.caller, as);
}
