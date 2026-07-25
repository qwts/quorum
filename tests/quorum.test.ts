import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

  assert.throws(() => quorum.postMessage({ room: 'platform', participantId: grace.id, body: 'hi' }), /join platform/);

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

test('acting without identifying is refused by name', () => {
  const quorum = openQuorum();
  assert.throws(
    () => quorum.createRoom({ name: 'platform', by: 'nobody' }),
    (error: unknown) => error instanceof QuorumError && /call identify first/.test(error.message),
  );
  quorum.close();
});
