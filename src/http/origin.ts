// The browser request guard: which hostnames may read or mutate anything.
//
// This process listens on 127.0.0.1 with no auth. Reads expose participant
// messages and decision records to DNS rebinding unless Host is constrained.
// Writes need the same constraint: every page the human visits can reach it; a
// script on any site can `fetch('http://127.0.0.1:4242/api/…', {method:'POST'})`
// and post messages, cast ballots, or convene deliberations in their name. The
// response is opaque to the attacker, but the write has already happened, and
// this transport's whole product is a record of who said what.
//
// Two checks close it, and both are needed:
//
//   * **A hostname allowlist**, applied to Host and to Origin. Checking that
//     those two *agree* is not enough: a DNS rebinding attack agrees with
//     itself. Only names this server was told to answer to are accepted.
//     Origin absent means a non-browser client (curl, the tests), which is
//     not the threat — a page cannot suppress it.
//   * **Content type.** `application/json` is not a "simple request", so a
//     cross-origin attempt is preflighted — and we answer no preflight, so it
//     never happens. Without this check an attacker drops to `text/plain`,
//     which *is* simple, and skips the preflight entirely.

import type { IncomingMessage } from 'node:http';

/**
 * Hostnames this server answers to.
 *
 * An allowlist rather than anything derived from the request, because the
 * request is what the attack controls. `QUORUM_HOSTS` adds names for a local
 * dev hostname without loosening the rule.
 */
export function allowedHosts(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const extra = (env.QUORUM_HOSTS ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  return new Set(['127.0.0.1', 'localhost', '::1', '[::1]', ...extra]);
}

/** Refuse requests addressed to a hostname this local server does not trust. */
export function refuseRead(req: IncomingMessage, hosts: Set<string> = allowedHosts()): string | null {
  const host = typeof req.headers.host === 'string' ? hostname(req.headers.host) : null;
  return host === null || !hosts.has(host) ? 'this server does not answer to that hostname' : null;
}

/**
 * The hostname out of a Host header or an Origin, or null when it is neither.
 *
 * Parsed rather than split on the first colon. Hand-splitting reads
 * `127.0.0.1:4242.evil.example` as host `127.0.0.1` with a nonsense port, and
 * hands an allowlist a name that is not the one the client used.
 */
function hostname(value: string): string | null {
  try {
    return new URL(value.includes('://') ? value : `http://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Whether this request may write.
 *
 * Returns the refusal to send, or null when it is allowed. Stated as data so
 * the reason reaches the caller instead of becoming a bare 403.
 *
 * Both Host and Origin are checked against the allowlist, and neither is
 * checked against the other. Comparing them to each other only proves the
 * request is self-consistent, which a **DNS rebinding** attack trivially is:
 * an attacker whose domain resolves to 127.0.0.1 sends their own hostname in
 * both headers, they agree, and the write lands as the human. A hostname the
 * server was never told to answer to is refused whatever else agrees with it.
 */
export function refuseWrite(req: IncomingMessage, hosts: Set<string> = allowedHosts()): string | null {
  const hostRefusal = refuseRead(req, hosts);
  if (hostRefusal) return hostRefusal;

  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    const from = hostname(origin);
    if (from === null || !hosts.has(from)) {
      return 'cross-origin writes are refused; open the UI this server serves';
    }
  }

  const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') {
    return 'writes must be application/json';
  }
  return null;
}
