import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DatabaseSync } from 'node:sqlite';

import { openQuorum, QuorumError } from '../src/domain/quorum.ts';

function withClock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

function agent(quorum: ReturnType<typeof openQuorum>, name: string) {
  return quorum.identify({ name, harness: 'test' }).participant;
}

test('rooms carry their decision rule and messages read forward from a cursor', () => {
  const quorum = openQuorum();
  const ada = agent(quorum, 'ada');
  const grace = agent(quorum, 'grace');

  const room = quorum.createRoom({ name: 'platform', topic: 'infra', decisionRule: 'unanimity', by: ada.id });
  assert.equal(room.decisionRule, 'unanimity');
  assert.equal(quorum.listRooms()[0]?.members, 1, 'the creator is a member');

  // The room name is quoted at the throw site: participant text never reads
  // as an instruction downstream.
  assert.throws(() => quorum.postMessage({ room: 'platform', participantId: grace.id, body: 'hi' }), /join "platform"/);

  quorum.joinRoom({ room: 'platform', participantId: grace.id });
  const first = quorum.postMessage({ room: 'platform', participantId: ada.id, body: 'starting on the parser' });
  quorum.postMessage({ room: 'platform', participantId: grace.id, body: 'ack' });

  assert.equal(quorum.readMessages({ room: 'platform' }).length, 2);
  const after = quorum.readMessages({ room: 'platform', afterId: first.id });
  assert.deepEqual(
    after.map((message) => message.body),
    ['ack'],
  );
  quorum.close();
});

test('a claim blocks an overlapping one and names the holder', () => {
  const quorum = openQuorum();
  const ada = agent(quorum, 'ada');
  const grace = agent(quorum, 'grace');

  const granted = quorum.claimScope({
    participantId: ada.id,
    repo: 'playbook-engineering',
    patterns: ['tools/agent-bot/**'],
    purpose: 'rewriting the credential helper',
  });
  assert.equal(granted.ok, true);

  const blocked = quorum.claimScope({
    participantId: grace.id,
    repo: 'playbook-engineering',
    patterns: ['**/*.mjs'],
    purpose: 'sweeping lint fixes',
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.ok === false && blocked.conflicts[0]?.participantId, ada.id);

  const elsewhere = quorum.claimScope({
    participantId: grace.id,
    repo: 'playbook-engineering',
    patterns: ['docs/**'],
    purpose: 'documentation pass',
  });
  assert.equal(elsewhere.ok, true, 'non-overlapping scopes in the same repo both stand');

  const otherRepo = quorum.claimScope({
    participantId: grace.id,
    repo: 'quorum',
    patterns: ['tools/agent-bot/**'],
    purpose: 'same paths, different repo',
  });
  assert.equal(otherRepo.ok, true);
  quorum.close();
});

test('claims on different named branches do not collide, but an unbranched claim covers all', () => {
  const quorum = openQuorum();
  const ada = agent(quorum, 'ada');
  const grace = agent(quorum, 'grace');
  const linus = agent(quorum, 'linus');

  quorum.claimScope({
    participantId: ada.id,
    repo: 'quorum',
    patterns: ['src/**'],
    branch: 'claude/spine',
    purpose: 'the spine',
  });
  const otherBranch = quorum.claimScope({
    participantId: grace.id,
    repo: 'quorum',
    patterns: ['src/**'],
    branch: 'codex/protocol',
    purpose: 'the protocol',
  });
  assert.equal(otherBranch.ok, true, 'separate worktrees, separate branches, no collision');

  const anyBranch = quorum.claimScope({
    participantId: linus.id,
    repo: 'quorum',
    patterns: ['src/**'],
    purpose: 'a sweep across every branch',
  });
  assert.equal(anyBranch.ok, false);
  assert.equal(anyBranch.ok === false && anyBranch.conflicts.length, 2);
  quorum.close();
});

test('every refused claim attempt leaves a minimal shared event without changing the reply', () => {
  const quorum = openQuorum();
  const holder = agent(quorum, 'holder');
  const blocked = agent(quorum, 'blocked');
  const granted = quorum.claimScope({
    participantId: holder.id,
    repo: 'quorum',
    patterns: ['src/domain/**'],
    branch: 'main',
    purpose: 'the domain',
  });
  assert.equal(granted.ok, true);
  const claimId = granted.ok ? granted.claim.id : '';

  const attempt = () =>
    quorum.claimScope({
      participantId: blocked.id,
      repo: 'quorum',
      patterns: ['src/**/*.ts'],
      branch: 'main',
      purpose: 'a refactor',
    });

  const first = attempt();
  assert.deepEqual(first, { ok: false, conflicts: granted.ok ? [granted.claim] : [] });
  attempt();

  const refused = quorum.readEvents().filter((event) => event.kind === 'claim_refused');
  assert.equal(refused.length, 2, 'each refused attempt is visible once');
  assert.equal(refused[0]?.actorId, blocked.id, 'the event actor is the refused participant');
  assert.equal(refused[0]?.roomId, null, 'claims live on the shared feed, not in one room');
  assert.deepEqual(refused[0]?.payload, {
    scope: { repo: 'quorum', branch: 'main', patterns: ['src/**/*.ts'] },
    conflictingClaimIds: [claimId],
  });
  quorum.close();
});

test('a lease expires on its own, frees the scope, and says so on the feed', () => {
  const clock = withClock();
  const quorum = openQuorum({ now: clock.now });
  const ada = agent(quorum, 'ada');
  const grace = agent(quorum, 'grace');

  quorum.claimScope({
    participantId: ada.id,
    repo: 'quorum',
    patterns: ['src/**'],
    purpose: 'short lease',
    ttlSeconds: 60,
  });
  assert.equal(quorum.listClaims({ repo: 'quorum' }).length, 1);

  clock.advance(61_000);

  assert.deepEqual(quorum.listClaims({ repo: 'quorum' }), [], 'no timer ran; expiry is computed');
  const taken = quorum.claimScope({
    participantId: grace.id,
    repo: 'quorum',
    patterns: ['src/**'],
    purpose: 'picking up the freed scope',
  });
  assert.equal(taken.ok, true);
  assert.ok(
    quorum.readEvents().some((event) => event.kind === 'claim_expired'),
    'expiry is announced once, at the next read',
  );
  quorum.close();
});

test('only the holder renews or releases, and an ended lease cannot be revived', () => {
  const clock = withClock();
  const quorum = openQuorum({ now: clock.now });
  const ada = agent(quorum, 'ada');
  const grace = agent(quorum, 'grace');

  const granted = quorum.claimScope({
    participantId: ada.id,
    repo: 'quorum',
    patterns: ['src/**'],
    purpose: 'holding',
    ttlSeconds: 60,
  });
  assert.equal(granted.ok, true);
  const claimId = granted.ok ? granted.claim.id : '';

  assert.throws(() => quorum.renewClaim({ claimId, participantId: grace.id }), /only the holder/);
  assert.throws(() => quorum.releaseClaim({ claimId, participantId: grace.id }), /only the holder/);

  const renewed = quorum.renewClaim({ claimId, participantId: ada.id, ttlSeconds: 600 });
  assert.equal(renewed.expiresAt, clock.now() + 600_000);

  clock.advance(601_000);
  assert.throws(() => quorum.renewClaim({ claimId, participantId: ada.id }), /already ended/);

  const again = quorum.claimScope({
    participantId: ada.id,
    repo: 'quorum',
    patterns: ['src/**'],
    purpose: 'a fresh lease',
  });
  assert.equal(again.ok, true);
  quorum.releaseClaim({ claimId: again.ok ? again.claim.id : '', participantId: ada.id });
  assert.deepEqual(quorum.listClaims(), []);
  quorum.close();
});

test('a blocked waiter is woken by the next event, and returns empty on timeout', async () => {
  const quorum = openQuorum();
  const ada = agent(quorum, 'ada');
  quorum.createRoom({ name: 'platform', by: ada.id });
  const cursor = quorum.latestSeq();

  const waiting = quorum.waitForEvents({ afterSeq: cursor, timeoutMs: 5_000 });
  setTimeout(() => quorum.postMessage({ room: 'platform', participantId: ada.id, body: 'wake up' }), 20);

  const events = await waiting;
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, 'message');

  const timedOut = await quorum.waitForEvents({ afterSeq: quorum.latestSeq(), timeoutMs: 30 });
  assert.deepEqual(timedOut, [], 'a quiet feed returns empty rather than hanging');
  quorum.close();
});

test('rooms, messages, and live claims survive a restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quorum-restart-'));
  const path = join(dir, 'quorum.db');
  try {
    const first = openQuorum({ path });
    const { participant: ada } = first.identify({ name: 'ada', harness: 'test' });
    first.createRoom({ name: 'platform', by: ada.id });
    first.postMessage({ room: 'platform', participantId: ada.id, body: 'persisted' });
    first.claimScope({ participantId: ada.id, repo: 'quorum', patterns: ['src/**'], purpose: 'held across restart' });
    first.close();

    const second = openQuorum({ path });
    assert.equal(second.listRooms().length, 1);
    assert.equal(second.readMessages({ room: 'platform' })[0]?.body, 'persisted');
    assert.equal(second.listClaims()[0]?.purpose, 'held across restart');
    assert.equal(second.listParticipants().length, 1);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a reconnecting agent resumes its identity and keeps its claims', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quorum-resume-'));
  const path = join(dir, 'quorum.db');
  try {
    const first = openQuorum({ path });
    const before = first.identify({ name: 'ada', harness: 'claude-code', branch: 'claude/one' });
    assert.equal(before.resumed, false);
    const granted = first.claimScope({
      participantId: before.participant.id,
      repo: 'quorum',
      patterns: ['src/**'],
      purpose: 'work in progress',
    });
    const claimId = granted.ok ? granted.claim.id : '';
    first.close();

    // Same agent, new connection, new process — the claim is still its own.
    const second = openQuorum({ path });
    const after = second.identify({ name: 'ada', harness: 'claude-code', branch: 'claude/two' });
    assert.equal(after.resumed, true);
    assert.equal(after.participant.id, before.participant.id, 'identity is (name, harness), not a fresh uuid');
    assert.equal(after.participant.branch, 'claude/two', 'where it works may change; who it is does not');
    assert.deepEqual(
      after.claims.map((claim) => claim.id),
      [claimId],
      'a resumed agent is handed back what it still holds',
    );
    second.releaseClaim({ claimId, participantId: after.participant.id });
    assert.deepEqual(second.listClaims(), [], 'and can release it — no stranding behind the TTL');

    const other = second.identify({ name: 'ada', harness: 'codex' });
    assert.notEqual(other.participant.id, before.participant.id, 'same name in another harness is another agent');
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('releasing twice closes once and announces once', () => {
  const quorum = openQuorum();
  const ada = agent(quorum, 'ada');
  const granted = quorum.claimScope({
    participantId: ada.id,
    repo: 'quorum',
    patterns: ['src/**'],
    purpose: 'retried release',
  });
  const claimId = granted.ok ? granted.claim.id : '';

  quorum.releaseClaim({ claimId, participantId: ada.id });
  quorum.releaseClaim({ claimId, participantId: ada.id }); // the retry after a lost response

  const released = quorum.readEvents().filter((event) => event.kind === 'claim_released');
  assert.equal(released.length, 1, 'a lease closes once, so the feed says so once');
  quorum.close();
});

test('a claim cannot carry an unbounded scope', () => {
  const quorum = openQuorum();
  const ada = agent(quorum, 'ada');
  const claim = (patterns: string[]) =>
    quorum.claimScope({ participantId: ada.id, repo: 'quorum', patterns, purpose: 'bounds' });

  assert.throws(() => claim(Array.from({ length: 33 }, (_, index) => `src/${index}/**`)), /at most 32 patterns/);
  assert.throws(() => claim([`src/${'a'.repeat(300)}.ts`]), /longer than 256 characters/);
  quorum.close();
});

test('a cursor outlives the connection that made it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quorum-cursor-'));
  const path = join(dir, 'quorum.db');
  try {
    const first = openQuorum({ path });
    const ada = first.identify({ name: 'ada', harness: 'test' });
    const grace = first.identify({ name: 'grace', harness: 'test' });
    assert.equal(ada.cursor, 0, 'the very first participant has nothing behind it');
    assert.equal(grace.cursor >= ada.cursor, true, 'a newcomer starts at the head, not at zero');
    assert.equal(grace.unseen, 0, 'arriving is not the same as having missed everything');

    first.createRoom({ name: 'platform', by: ada.participant.id });
    first.joinRoom({ room: 'platform', participantId: grace.participant.id });

    // Ada reads a batch. Nothing durable moves yet — a batch that was sent is
    // not a batch that arrived.
    const consumed = await first.waitForEvents({
      afterSeq: ada.cursor,
      timeoutMs: 0,
      participantId: ada.participant.id,
    });
    const stopped = consumed.at(-1)!.seq;
    assert.equal(first.cursorFor(ada.participant.id).cursor, ada.cursor, 'sending is not delivering');

    // Coming back for what follows is the acknowledgement that it did arrive.
    await first.waitForEvents({ afterSeq: stopped, timeoutMs: 0, participantId: ada.participant.id });
    assert.equal(first.cursorFor(ada.participant.id).cursor, stopped);

    // Ada posts (does not advance her), then Grace says something Ada never reads.
    first.postMessage({ room: 'platform', participantId: ada.participant.id, body: 'heading out' });
    first.postMessage({ room: 'platform', participantId: grace.participant.id, body: 'the one ada missed' });
    assert.equal(first.cursorFor(ada.participant.id).cursor, stopped, 'posting is not consuming');
    first.close();

    const second = openQuorum({ path });
    const back = second.identify({ name: 'ada', harness: 'test' });
    assert.equal(back.cursor, stopped, 'resumed where consumption stopped, not at the head');
    assert.equal(back.unseen, 2, 'and is told how much waits, not handed it');

    const missed = await second.waitForEvents({
      afterSeq: back.cursor,
      timeoutMs: 0,
      participantId: back.participant.id,
    });
    const bodies = missed
      .map((event) => (event.payload as { message?: { body: string } }).message?.body)
      .filter(Boolean);
    assert.ok(bodies.includes('the one ada missed'), 'the normal call recovers them — no catch-up API');
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a batch that never arrived is not recorded as delivered', async () => {
  // The dropped response: the server reads the rows, the connection dies before
  // the reply lands, and the agent reconnects. If the cursor advanced on send,
  // those events are gone forever — the exact skip a durable cursor exists to
  // prevent.
  const dir = mkdtempSync(join(tmpdir(), 'quorum-ack-'));
  const path = join(dir, 'quorum.db');
  try {
    const first = openQuorum({ path });
    const ada = first.identify({ name: 'ada', harness: 'test' });
    const grace = first.identify({ name: 'grace', harness: 'test' });
    first.createRoom({ name: 'platform', by: grace.participant.id });
    first.postMessage({ room: 'platform', participantId: grace.participant.id, body: 'lost in flight' });

    const sent = await first.waitForEvents({
      afterSeq: ada.cursor,
      timeoutMs: 0,
      participantId: ada.participant.id,
    });
    assert.ok(sent.length > 0, 'the server did read a batch');
    first.close(); // the reply never reached Ada

    const second = openQuorum({ path });
    const back = second.identify({ name: 'ada', harness: 'test' });
    assert.equal(back.cursor, ada.cursor, 'the undelivered batch is still ahead of her');
    assert.equal(back.unseen, sent.length);
    const replayed = await second.waitForEvents({
      afterSeq: back.cursor,
      timeoutMs: 0,
      participantId: back.participant.id,
    });
    const bodies = replayed
      .map((event) => (event.payload as { message?: { body: string } }).message?.body)
      .filter(Boolean);
    assert.ok(bodies.includes('lost in flight'), 'replayed rather than skipped');
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unknown participant is a caller bug, not an empty cursor', () => {
  const quorum = openQuorum();
  assert.throws(() => quorum.cursorFor('nobody'), /unknown participant/);
  quorum.close();
});

test('an unidentified observer consumes without owning a cursor', async () => {
  const quorum = openQuorum();
  const ada = agent(quorum, 'ada');
  quorum.createRoom({ name: 'platform', by: ada.id });
  const seen = await quorum.waitForEvents({ afterSeq: 0, timeoutMs: 0, participantId: null });
  assert.ok(seen.length > 0, 'an observer still reads the feed');
  assert.equal(quorum.cursorFor(ada.id).cursor, 0, 'and moves nobody else\'s cursor doing it');
  quorum.close();
});

test('a database made before a column existed still opens', () => {
  // The upgrade path someone actually hits: they ran quorum, we shipped a new
  // column, they pulled and restarted. CREATE TABLE IF NOT EXISTS will not add
  // it, so without a migration the next write fails.
  const dir = mkdtempSync(join(tmpdir(), 'quorum-upgrade-'));
  const path = join(dir, 'quorum.db');
  try {
    const before = openQuorum({ path });
    const { participant } = before.identify({ name: 'early-adopter', harness: 'test' });
    before.createRoom({ name: 'made-before-the-upgrade', by: participant.id });
    before.close();

    const raw = new DatabaseSync(path);
    // Rewind to the older shape — and to the older *ledger*, because a
    // database from before the column is also a database from before the
    // migration that added it. Dropping only the column would describe a
    // database nobody has: one whose record says applied and whose schema
    // says otherwise.
    raw.exec('ALTER TABLE events DROP COLUMN actor_id');
    raw.exec('DELETE FROM schema_migrations WHERE id = 1');
    raw.close();

    const after = openQuorum({ path });
    const resumed = after.identify({ name: 'early-adopter', harness: 'test' });
    assert.equal(resumed.resumed, true, 'the old rows are still there');
    assert.equal(after.listRooms()[0]?.name, 'made-before-the-upgrade');
    const event = after.readEvents().at(-1);
    assert.equal(event?.actorId, resumed.participant.id, 'and new writes carry the added column');
    after.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('acting without identifying is refused by name', () => {
  const quorum = openQuorum();
  assert.throws(
    () => quorum.createRoom({ name: 'platform', by: 'nobody' }),
    (error: unknown) => error instanceof QuorumError && /call identify first/.test(error.message),
  );
  quorum.close();
});
