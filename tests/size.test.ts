// A tripwire against the file that quietly becomes four thousand lines.
//
// Nobody writes that file. It accrues, one reasonable addition at a time, and
// every individual commit is defensible — which is exactly why review does not
// catch it and a check has to.
//
// Three rules, and the third is the one that does the work:
//
//   1. A default ceiling every source file must stay under.
//   2. Exceptions are **data with a reason**, not a raised constant. Raising
//      the ceiling for everyone to accommodate one file is how the ceiling
//      stops meaning anything.
//   3. Exceptions **ratchet**. If a file drops well under its exception, the
//      exception is stale and the test says so. Budgets that only ever go up
//      are budgets in name only — this is the same lesson as the docs-gov
//      token budget I raised three times before splitting the file instead.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Lines. Chosen because it is unarguable, not because it is subtle. */
const CEILING = 260;

/**
 * Tests get their own, higher ceiling. A test file is a catalogue — a long one
 * is a long list, which reads fine top to bottom; a long *source* file is
 * usually a control-flow structure that stopped fitting in one head. Same
 * number for both would either strangle the catalogues or excuse the modules.
 */
const TEST_CEILING = 520;

/** Slack before a granted exception counts as stale. */
const RATCHET = 40;

/**
 * Files allowed past the ceiling, with why. A new entry is a deliberate
 * decision someone can disagree with in review, which is the point.
 */
const EXCEPTIONS: Record<string, { limit: number; why: string }> = {
  'src/domain/command-set.ts': {
    limit: 285,
    why: 'The command registry (#52): one entry per command is the design — adding a command touches only this file — so it grows with the vocabulary. Split when a category earns its own file, not before.',
  },
  'src/domain/quorum.ts': {
    limit: 880,
    why: 'The domain surface — one transaction boundary per operation, and splitting it would put the event append in a different file from the mutation it must accompany. Grew the audience filter (#42), participant status and command composition (#52), the occupants read (#56), the shared claim-refusal record (#15), and identity (#50) — whose tables live in identity.ts, session.ts, and tree.ts, so what lands here is the composition plus the one line of appendEvent that stamps a session on an action, then delivery guidance (#51) — which must resolve recipients through the same requireParticipant. Held flat by #96, which moved the schema history to migrate.ts and room resolution to authority.ts as it added the visible-set scoping. Presence (#17) is the same shape: the projection is presence.ts, and what lands here is the roster view, which has to be composed beside listParticipants to stay one read.',
  },
  'src/mcp/server.ts': {
    limit: 285,
    why: 'The endpoint\'s wiring: routing, TLS, the UI and HTTP surfaces, and — with identity (#50) — the credential check at connect and on every later message. The check itself is one shared seam in src/http/auth.ts; what is here is which requests reach it, and that reads as one list on purpose.',
  },
  'src/domain/deliberation.ts': {
    limit: 580,
    why: 'The protocol state machine. Its phases only make sense read together; the seams it does have are documented in docs/deliberation.md §8. Issue #73 adds the ballot-session write and close-time immutable-record annotation at those two phase boundaries; extracting either would hide the D6/D9 transaction it must share.',
  },
  'src/mcp/tools.ts': {
    limit: 855,
    why: 'Hand-written JSON Schema, which is verbose by choice — the wire contract is the product (AGENTS.md), so it reads as the contract it is rather than being generated. Ratcheted down when the DM family moved to dms.ts (#42); grew list_open_deliberations (#35), then identify\'s asserted provenance inputs (#50) — the contract for an input belongs beside the tool it is an input to, then the delivery footers (#51), then the two presence clauses (#17), which belong beside the guidance they qualify: a file of their own would separate a sentence from the reply it is a sentence in.',
  },
};

// fileURLToPath, not .pathname: a repo checked out under a path with a
// space arrives percent-encoded and every read fails.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SEARCH = ['src', 'tests'];
const EXTENSIONS = ['.ts', '.js'];

function sources(): string[] {
  const found: string[] = [];
  for (const dir of SEARCH) {
    for (const name of readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' })) {
      if (EXTENSIONS.some((ext) => name.endsWith(ext))) found.push(relative(ROOT, join(ROOT, dir, name)));
    }
  }
  return found.sort();
}

const lines = (path: string) => readFileSync(join(ROOT, path), 'utf8').split('\n').length;

test('no source file grows past the ceiling without a recorded reason', () => {
  const over: string[] = [];
  for (const path of sources()) {
    const limit = EXCEPTIONS[path]?.limit ?? (path.startsWith('tests/') ? TEST_CEILING : CEILING);
    const actual = lines(path);
    if (actual > limit) {
      over.push(
        `${path}: ${actual} lines, over ${limit}. Split it along a seam that exists — or, if it genuinely has none, add it to EXCEPTIONS with the reason.`,
      );
    }
  }
  assert.deepEqual(over, [], over.join('\n'));
});

test('every exception says why, and none of them is stale', () => {
  for (const [path, exception] of Object.entries(EXCEPTIONS)) {
    assert.ok(exception.why.length > 40, `${path}: an exception without a real reason is just a higher ceiling`);
    const ceiling = path.startsWith('tests/') ? TEST_CEILING : CEILING;
    assert.ok(exception.limit > ceiling, `${path}: this file is under the ceiling and needs no exception`);

    const actual = lines(path);
    // The ratchet. A file that shrank keeps the headroom it no longer needs
    // unless something makes us take it back, and "someone will notice" has
    // never once been true.
    assert.ok(
      actual > exception.limit - RATCHET,
      `${path}: now ${actual} lines against a limit of ${exception.limit}. It shrank — lower the limit to about ${actual + 10}, or drop the exception if it is under ${ceiling}.`,
    );
  }
});

test('the exception list has no entries for files that no longer exist', () => {
  const present = new Set(sources());
  for (const path of Object.keys(EXCEPTIONS)) {
    assert.ok(present.has(path), `${path} is in EXCEPTIONS but not in the tree — delete the entry`);
  }
});
