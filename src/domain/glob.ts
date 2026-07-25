// Do two path globs describe any path in common?
//
// Claims are refused when their scopes overlap (issue #6, requirement 5), so
// the question is never "does this glob match this file" — no working tree is
// ever read — but "could these two patterns ever name the same path". That is
// pattern-versus-pattern intersection, which no matcher library answers, so it
// lives here as a pure function the domain can test exhaustively.
//
// Supported syntax is deliberately the subset a claim needs: `*` (within one
// segment), `?` (one character), and `**` (any number of segments).
//
// Both levels of the search memoize on index pairs rather than recursing over
// freshly sliced arrays. Without that, patterns with several `**` segments
// revisit the same suffix pairs exponentially — and since this runs on the
// server's only thread while a claim is granted, a slow answer is an outage.
// Indices also mean no array copying, so the walk allocates nothing.

// Can two single-segment patterns match a common string? The recursion is the
// classic wildcard product automaton: at each step either side may consume a
// character, and `*` may consume nothing at all.
function segmentsIntersect(a: string, b: string): boolean {
  const seen = new Set<number>();
  const width = b.length + 1;

  const walk = (i: number, j: number): boolean => {
    const key = i * width + j;
    if (seen.has(key)) return false; // already explored, and it did not accept
    seen.add(key);

    if (i === a.length && j === b.length) return true;
    if (i < a.length && a[i] === '*') {
      if (walk(i + 1, j)) return true; // `*` matched nothing
      if (j < b.length && walk(i, j + 1)) return true; // `*` swallowed b's char
    }
    if (j < b.length && b[j] === '*') {
      if (walk(i, j + 1)) return true;
      if (i < a.length && walk(i + 1, j)) return true;
    }
    if (i === a.length || j === b.length) return false;

    const left = a[i];
    const right = b[j];
    if (left === '*' || right === '*') return false; // handled above; nothing else can match
    if (left === '?' || right === '?' || left === right) return walk(i + 1, j + 1);
    return false;
  };

  return walk(0, 0);
}

function segments(pattern: string): string[] {
  return pattern.split('/').filter((segment) => segment !== '');
}

function walkSegments(a: string[], b: string[]): boolean {
  const seen = new Set<number>();
  const width = b.length + 1;

  const walk = (i: number, j: number): boolean => {
    const key = i * width + j;
    if (seen.has(key)) return false;
    seen.add(key);

    if (i === a.length && j === b.length) return true;

    // `**` matches any number of segments, including none — so it either steps
    // aside or swallows one segment from the other side and tries again.
    if (a[i] === '**') {
      if (walk(i + 1, j)) return true;
      return j < b.length && walk(i, j + 1);
    }
    if (b[j] === '**') {
      if (walk(i, j + 1)) return true;
      return i < a.length && walk(i + 1, j);
    }

    if (i === a.length || j === b.length) return false;
    return segmentsIntersect(a[i] ?? '', b[j] ?? '') && walk(i + 1, j + 1);
  };

  return walk(0, 0);
}

export function globsOverlap(a: string, b: string): boolean {
  return walkSegments(segments(a), segments(b));
}

// A claim carries a set of patterns; two claims overlap when any pair does.
export function scopesOverlap(a: readonly string[], b: readonly string[]): boolean {
  return a.some((left) => b.some((right) => globsOverlap(left, right)));
}

// Bounds, not because the walk is slow — it is memoized — but because a claim
// nobody can read is not coordination, and neither is a thousand-glob scope.
export const MAX_PATTERNS = 32;
export const MAX_PATTERN_LENGTH = 256;

export class PatternError extends Error {}

// An empty pattern list means the whole repository, which is what an agent
// that names no paths is really asking for.
export function normalizePatterns(patterns: readonly string[] | undefined): string[] {
  const cleaned = (patterns ?? []).map((pattern) => pattern.trim()).filter((pattern) => pattern !== '');
  if (cleaned.length > MAX_PATTERNS) {
    throw new PatternError(`a claim may carry at most ${MAX_PATTERNS} patterns (got ${cleaned.length})`);
  }
  for (const pattern of cleaned) {
    if (pattern.length > MAX_PATTERN_LENGTH) {
      throw new PatternError(`pattern longer than ${MAX_PATTERN_LENGTH} characters: ${pattern.slice(0, 40)}…`);
    }
  }
  return cleaned.length > 0 ? cleaned : ['**'];
}
