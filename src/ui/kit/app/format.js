// Formatting the product's own precise numbers.
//
// The copy rules ask for numbers that are precise, cited and derived — "3 of 6
// ballots", "ttl 1800s", "phase_ends_at 14:35" — so these return exact strings
// rather than the friendly approximations a chat UI usually reaches for. There
// is no "a few minutes ago" here on purpose: a claim that expires in 90
// seconds and one that expires in 5 minutes are different situations, and
// rounding them together is the UI deciding you did not need to know.
//
// Pure, so a Node test can pin them without a browser or a fixed clock.

/**
 * Wall clock, `14:02`, in the reader's own timezone.
 * @param {number} epochMs
 */
export function clock(epochMs) {
  const at = new Date(epochMs);
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/**
 * How long a lease has left, from the holder's point of view.
 * Minutes while there are minutes, then seconds — because under a minute is
 * exactly when the difference matters to whoever is waiting for the scope.
 *
 * @param {number} expiresAtMs
 * @param {number} nowMs
 */
export function remaining(expiresAtMs, nowMs) {
  const ms = expiresAtMs - nowMs;
  if (ms <= 0) return 'expired';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s left`;
  return `${Math.floor(seconds / 60)}m left`;
}

/**
 * `quorum@main src/mcp/**` — repo, branch and patterns as one citable scope.
 * @param {{repo: string, branch?: string|null, patterns?: string[]}} claim
 */
export function scopeOf(claim) {
  const where = claim.branch ? `${claim.repo}@${claim.branch}` : claim.repo;
  const patterns = claim.patterns?.length ? claim.patterns.join(' ') : 'the whole repository';
  return `${where} ${patterns}`;
}

/**
 * `n thing` / `n things`, so a count never reads as a template that got away.
 * @param {number} n @param {string} singular @param {string} [plural]
 */
export function count(n, singular, plural = `${singular}s`) {
  return `${n} ${n === 1 ? singular : plural}`;
}
