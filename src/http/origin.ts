// The browser request guard: which requests may reach this loopback server.
//
// This process listens on 127.0.0.1 with no auth, so every page the human
// visits can try to reach it. Writes could post messages or cast ballots in
// their name; confidential reads could disclose their direct messages through
// a rebound hostname. The guard therefore applies to both directions —
// including the MCP endpoint, where a tool call is a write wearing JSON-RPC.
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
    .map((name) => name.trim())
    .filter(Boolean)
    // Normalized through the same parser the request side uses (hostname
    // below), so an entry spelled with a scheme or port — `https://q.example`,
    // `q.example:4242` — means the hostname it names instead of silently
    // matching nothing and refusing every request the startup guard approved.
    .map((name) => hostname(name) ?? name.toLowerCase());
  return new Set(['127.0.0.1', 'localhost', '::1', '[::1]', ...extra]);
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
 * Whether this request may reach the browser API.
 *
 * Returns the refusal to send, or null when it is allowed. Stated as data so
 * the reason reaches the caller instead of becoming a bare 403. Write-only
 * content-type enforcement remains in `refuseWrite` below.
 *
 * Both Host and Origin are checked against the allowlist, and neither is
 * checked against the other. Comparing them to each other only proves the
 * request is self-consistent, which a **DNS rebinding** attack trivially is:
 * an attacker whose domain resolves to 127.0.0.1 sends their own hostname in
 * both headers, they agree, and the write lands as the human. A hostname the
 * server was never told to answer to is refused whatever else agrees with it.
 *
 * Shared by every surface that mutates state on a browser's behalf — the
 * `/api/` write routes and the MCP endpoint's tool calls alike (#32). A tool
 * call is a write wearing JSON-RPC, and the rebinding attack does not care
 * which wire format carries it.
 */
function refuseRequest(
  req: IncomingMessage,
  action: 'requests' | 'reads' | 'writes',
  hosts: Set<string>,
): string | null {
  const host = typeof req.headers.host === 'string' ? hostname(req.headers.host) : null;
  if (host === null || !hosts.has(host)) {
    return 'this server does not answer to that hostname';
  }

  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    const from = hostname(origin);
    if (from === null || !hosts.has(from)) {
      return `cross-origin ${action} are refused; open the UI this server serves`;
    }
  }
  return null;
}

/** Guard the MCP write surface while preserving its transport-specific wording. */
export function refuseOrigin(req: IncomingMessage, hosts: Set<string> = allowedHosts()): string | null {
  return refuseRequest(req, 'requests', hosts);
}

/**
 * Whether this request may write.
 *
 * Everything {@link refuseOrigin} checks, plus content type: `application/json`
 * is not a "simple request", so a cross-origin attempt is preflighted — and
 * this server answers no preflight, so it never happens. Without this check
 * an attacker drops to `text/plain`, which *is* simple, and skips the
 * preflight entirely. GET has no body to type, so this is on top of, not
 * instead of, the origin check — never a substitute for it.
 */
export function refuseWrite(req: IncomingMessage, hosts: Set<string> = allowedHosts()): string | null {
  const refused = refuseRequest(req, 'writes', hosts);
  if (refused) return refused;

  const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') {
    return 'writes must be application/json';
  }
  return null;
}

/** Refuse a read reached through an untrusted Host or browser Origin. */
export function refuseRead(req: IncomingMessage, hosts: Set<string> = allowedHosts()): string | null {
  return refuseRequest(req, 'reads', hosts);
}
