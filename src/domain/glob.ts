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

// Can two single-segment patterns match a common string? The recursion is the
// classic wildcard product automaton: at each step either side may consume a
// character, and `*` may consume nothing at all.
function segmentsIntersect(a: string, b: string): boolean {
  const seen = new Set<string>();

  const walk = (i: number, j: number): boolean => {
    const key = `${i}:${j}`;
    if (seen.has(key)) return false; // this pair is already being explored
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
    if (left === '*' || right === '*') return false; // handled above; no literal match left
    if (left === '?' || right === '?' || left === right) return walk(i + 1, j + 1);
    return false;
  };

  return walk(0, 0);
}

function segments(pattern: string): string[] {
  return pattern.split('/').filter((segment) => segment !== '');
}

function walkSegments(a: string[], b: string[]): boolean {
  if (a.length === 0 && b.length === 0) return true;

  // `**` matches any number of segments, including none — so it either steps
  // aside or swallows one segment from the other side and tries again.
  if (a[0] === '**') {
    if (walkSegments(a.slice(1), b)) return true;
    return b.length > 0 && walkSegments(a, b.slice(1));
  }
  if (b[0] === '**') {
    if (walkSegments(a, b.slice(1))) return true;
    return a.length > 0 && walkSegments(a.slice(1), b);
  }

  if (a.length === 0 || b.length === 0) return false;
  return segmentsIntersect(a[0] ?? '', b[0] ?? '') && walkSegments(a.slice(1), b.slice(1));
}

export function globsOverlap(a: string, b: string): boolean {
  return walkSegments(segments(a), segments(b));
}

// A claim carries a set of patterns; two claims overlap when any pair does.
export function scopesOverlap(a: readonly string[], b: readonly string[]): boolean {
  return a.some((left) => b.some((right) => globsOverlap(left, right)));
}

// An empty pattern list means the whole repository, which is what an agent
// that names no paths is really asking for.
export function normalizePatterns(patterns: readonly string[] | undefined): string[] {
  const cleaned = (patterns ?? []).map((pattern) => pattern.trim()).filter((pattern) => pattern !== '');
  return cleaned.length > 0 ? cleaned : ['**'];
}
