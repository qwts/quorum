// Identity in the domain: what a credential is, what it opens, and what
// revoking one takes with it (ADR-0001; docs/design/agent-identity.md §3–§4).
//
// Behavioural, not structural: every assertion here is something an operator
// or an agent would notice — a token that stops working, a session that is
// refused, a line on the feed naming both sides of a supersession.
//
// The enforcement these answers feed is tested over the wire in
// tests/mcp-auth.test.ts. That nothing changes when enforcement is *off* is
// proven by the rest of this suite, which never mentions a credential.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

import { actingSession } from '../src/domain/acting.ts';
import { TOKEN_PREFIX } from '../src/domain/identity.ts';
import { openQuorum } from '../src/domain/quorum.ts';

/** A quorum with a clock the test drives, so expiry and silence are not sleeps. */
function fresh(path?: string) {
  let clock = 1_700_000_000_000;
  const quorum = openQuorum({ path, now: () => clock });
  return { quorum, tick: (ms: number) => (clock += ms), at: () => clock };
}

function boundIdentity(quorum: ReturnType<typeof openQuorum>, name: string) {
  const minted = quorum.identity.mint({ name: `${name}:principal` });
  const participant = quorum.identify({ name, harness: 'test' }).participant;
  quorum.identity.bindParticipant({ participantId: participant.id, principalId: minted.principal.id });
  return { ...minted, participant };
}

test('the minted secret is handed back once, and the database keeps only its hash', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'quorum-identity-')), 'quorum.db');
  const { quorum } = fresh(path);
  const { token, grant, principal } = quorum.identity.mint({ name: 'ada:mint' });
  quorum.close();

  assert.ok(token.startsWith(TOKEN_PREFIX), 'a quorum token says what it is');
  assert.equal(Buffer.from(token.slice(TOKEN_PREFIX.length), 'base64url').length, 32, '32 bytes of randomness');

  // Read the file the way an attacker with the disk would.
  const db = new DatabaseSync(path);
  const row = db.prepare('SELECT * FROM grants WHERE id = ?').get(grant.id) as Record<string, unknown>;
  db.close();
  assert.equal(row.token_hash, createHash('sha256').update(token).digest('hex'));
  assert.doesNotMatch(JSON.stringify(row), /qpat_/, 'nothing in the row can be replayed');
  assert.equal(row.principal_id, principal.id, 'and the grant hangs off its principal');
});

test('a token verifies to its own principal, and everything else is refused without being echoed', () => {
  const { quorum } = fresh();
  const { token, principal } = quorum.identity.mint({ name: 'ada:verify' });

  const good = quorum.identity.verify(token);
  assert.equal(good.ok, true);
  assert.equal(good.ok && good.principal.name, 'ada:verify');

  const forged = `${TOKEN_PREFIX}${'a'.repeat(43)}`;
  const bad = quorum.identity.verify(forged);
  assert.equal(bad.ok, false);
  assert.match(bad.ok === false ? bad.refusal : '', /not one this server issued/);
  assert.doesNotMatch(bad.ok === false ? bad.refusal : '', /aaaa/, 'the refusal never repeats what was presented');

  const missing = quorum.identity.verify(null);
  assert.match(missing.ok === false ? missing.refusal : '', /no access token was presented/);
  const wrongShape = quorum.identity.verify('sk-live-something-else');
  assert.match(wrongShape.ok === false ? wrongShape.refusal : '', /not a quorum access token/);

  // The principal is a node on the tree, sponsored by an account — never a
  // free-floating name (design §5).
  assert.ok(principal.accountId.length > 0, 'sponsored by a human root');
  quorum.close();
});

test('a token stops working the moment it expires', () => {
  const { quorum, tick } = fresh();
  const { token } = quorum.identity.mint({ name: 'ada:expiry', ttlMs: 60_000 });
  assert.equal(quorum.identity.verify(token).ok, true);

  tick(60_001);
  const expired = quorum.identity.verify(token);
  assert.equal(expired.ok, false);
  assert.match(expired.ok === false ? expired.refusal : '', /expired/);
  quorum.close();
});

test('revoking a grant ends the session on it, and revoking a principal takes every grant with it', () => {
  const { quorum } = fresh();
  const first = quorum.identity.mint({ name: 'ada:revoke' });
  const second = quorum.identity.mint({ name: 'ada:revoke' }); // same agent, second pairing
  assert.equal(second.principal.id, first.principal.id, 'a name is one identity, however many credentials it holds');

  const opened = quorum.identity.establish({ grantId: first.grant.id, source: 'mcp' });
  assert.equal(opened.ok, true);
  const sessionId = opened.ok ? opened.session.id : '';

  const killed = quorum.identity.revokeGrant(first.grant.id);
  assert.deepEqual(killed.sessions, [sessionId], 'the live session went with the credential');
  assert.equal(quorum.identity.touch(sessionId), false, 'and cannot be spoken through afterwards');
  const after = quorum.identity.verify(first.token);
  assert.match(after.ok === false ? after.refusal : '', /token has been revoked/);
  assert.equal(quorum.identity.verify(second.token).ok, true, 'the other credential is untouched, so far');

  const cascade = quorum.identity.revokePrincipal('ada:revoke');
  assert.ok(cascade.grants.includes(second.grant.id), 'revoking the principal reaches down the tree');
  const done = quorum.identity.verify(second.token);
  assert.equal(done.ok, false);
  assert.match(
    done.ok === false ? done.refusal : '',
    /identity has been revoked/,
    'the refusal names the highest revoked node, not the leaf — "token revoked" would invite minting a replacement that cannot exist',
  );
  // The identity itself is gone, not just its credentials: a revoked agent
  // cannot be handed a fresh token under the same name (design §5.1).
  assert.throws(() => quorum.identity.mint({ name: 'ada:revoke' }), /revoked/);
  quorum.close();
});

test('grant revocation frees only live claims once and preserves every other close reason', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quorum-revoke-claims-'));
  const path = join(dir, 'quorum.db');
  const { quorum, tick } = fresh(path);
  const ada = boundIdentity(quorum, 'ada');
  const opened = quorum.identity.establish({ grantId: ada.grant.id, source: 'test' });
  assert.equal(opened.ok, true);

  const claim = (path: string, ttlSeconds = 60) =>
    quorum.claimScope({ participantId: ada.participant.id, repo: 'quorum', patterns: [path], purpose: path, ttlSeconds });
  const live = claim('src/live/**');
  const released = claim('src/released/**');
  const expired = claim('src/expired/**', 1);
  assert.ok(live.ok && released.ok && expired.ok);
  if (!live.ok || !released.ok || !expired.ok) assert.fail('non-overlapping fixture claims must be granted');
  quorum.releaseClaim({ claimId: released.claim.id, participantId: ada.participant.id });
  tick(2_000);

  const before = quorum.latestSeq();
  const killed = quorum.identity.revokeGrant(ada.grant.id);
  assert.deepEqual(killed.claims, [live.claim.id]);
  assert.deepEqual(killed.sessions, opened.ok ? [opened.session.id] : []);

  const events = quorum.readEvents({ afterSeq: before });
  const revoked = events.filter((event) => event.kind === 'claim_revoked');
  assert.equal(revoked.length, 1);
  assert.equal(revoked[0]?.actorId, null);
  assert.deepEqual(revoked[0]?.payload, { claim: live.claim });
  assert.doesNotMatch(
    JSON.stringify(revoked.map((event) => event.payload)),
    /qpat_|"(?:token|token_hash|sessionId|grantId)"/,
  );

  const again = quorum.identity.revokeGrant(ada.grant.id);
  assert.deepEqual(again.claims, [], 'a repeated revocation cannot close anything twice');
  assert.equal(quorum.readEvents({ afterSeq: before }).filter((event) => event.kind === 'claim_revoked').length, 1);

  quorum.listClaims(); // the elapsed lease keeps its own expiry path
  const grace = quorum.identify({ name: 'grace', harness: 'test' }).participant;
  const reclaimed = quorum.claimScope({
    participantId: grace.id,
    repo: 'quorum',
    patterns: ['src/live/**'],
    purpose: 'the revoked scope is free',
  });
  assert.equal(reclaimed.ok, true);
  quorum.close();

  const db = new DatabaseSync(path);
  const reasons = db.prepare('SELECT id, closed_reason FROM claims WHERE id IN (?, ?, ?)').all(
    live.claim.id,
    released.claim.id,
    expired.claim.id,
  ) as { id: string; closed_reason: string }[];
  assert.deepEqual(
    Object.fromEntries(reasons.map((row) => [row.id, row.closed_reason])),
    { [live.claim.id]: 'revoked', [released.claim.id]: 'released', [expired.claim.id]: 'expired' },
  );
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('principal and account cascades close each bound participant claim exactly once', () => {
  const { quorum } = fresh();
  const ada = boundIdentity(quorum, 'ada');
  const secondAda = quorum.identity.mint({ name: 'ada:principal' });
  const adaClaim = quorum.claimScope({
    participantId: ada.participant.id,
    repo: 'quorum',
    patterns: ['src/ada/**'],
    purpose: 'ada work',
  });
  assert.equal(adaClaim.ok, true);
  const principal = quorum.identity.revokePrincipal('ada:principal');
  assert.equal(principal.grants.length, 2);
  assert.deepEqual(principal.claims, adaClaim.ok ? [adaClaim.claim.id] : []);
  assert.ok(principal.grants.includes(secondAda.grant.id));

  const grace = boundIdentity(quorum, 'grace');
  const linus = boundIdentity(quorum, 'linus');
  const graceClaim = quorum.claimScope({
    participantId: grace.participant.id,
    repo: 'quorum',
    patterns: ['src/grace/**'],
    purpose: 'grace work',
  });
  const linusClaim = quorum.claimScope({
    participantId: linus.participant.id,
    repo: 'quorum',
    patterns: ['src/linus/**'],
    purpose: 'linus work',
  });
  assert.ok(graceClaim.ok && linusClaim.ok);
  const before = quorum.latestSeq();
  const account = quorum.identity.revokeAccount('operator');
  assert.deepEqual(
    new Set(account.claims),
    new Set([graceClaim.ok ? graceClaim.claim.id : '', linusClaim.ok ? linusClaim.claim.id : '']),
  );
  assert.equal(quorum.readEvents({ afterSeq: before }).filter((event) => event.kind === 'claim_revoked').length, 2);
  quorum.close();
});

test('revocation closes claims for every participant row bound to the principal', () => {
  const { quorum } = fresh();
  const ada = boundIdentity(quorum, 'ada-mcp');
  const browser = quorum.identify({ name: 'ada-ui', harness: 'web' }).participant;
  quorum.identity.bindParticipant({ participantId: browser.id, principalId: ada.principal.id });
  const mcpClaim = quorum.claimScope({ participantId: ada.participant.id, repo: 'quorum', patterns: ['src/mcp/**'], purpose: 'mcp' });
  const uiClaim = quorum.claimScope({ participantId: browser.id, repo: 'quorum', patterns: ['src/ui/**'], purpose: 'ui' });
  assert.ok(mcpClaim.ok && uiClaim.ok);

  const killed = quorum.identity.revokeGrant(ada.grant.id);
  assert.deepEqual(
    new Set(killed.claims),
    new Set([mcpClaim.ok ? mcpClaim.claim.id : '', uiClaim.ok ? uiClaim.claim.id : '']),
  );
  assert.equal(quorum.listClaims().length, 0);
  quorum.close();
});

test('repeating a pre-upgrade revocation repairs a claim stranded behind it', () => {
  const { quorum } = fresh();
  const ada = boundIdentity(quorum, 'ada-history');
  quorum.identity.revokeGrant(ada.grant.id);
  const stranded = quorum.claimScope({
    participantId: ada.participant.id,
    repo: 'quorum',
    patterns: ['src/history/**'],
    purpose: 'fixture for a claim left live by the old cascade',
  });
  assert.equal(stranded.ok, true);

  const before = quorum.latestSeq();
  const repaired = quorum.identity.revokeGrant(ada.grant.id);
  assert.deepEqual(repaired.claims, stranded.ok ? [stranded.claim.id] : []);
  assert.equal(repaired.sessions.length, 0, 'the already-revoked grant is not revoked twice');
  assert.equal(quorum.readEvents({ afterSeq: before }).filter((event) => event.kind === 'claim_revoked').length, 1);
  assert.equal(quorum.listClaims().length, 0);
  quorum.close();
});

test('a grant with no bound participant closes no claim', () => {
  const { quorum } = fresh();
  const { grant } = quorum.identity.mint({ name: 'unused' });
  assert.deepEqual(quorum.identity.revokeGrant(grant.id).claims, []);
  assert.equal(quorum.readEvents().filter((event) => event.kind === 'claim_revoked').length, 0);
  quorum.close();
});

test('a failed revocation event rolls the credential and its claim back together', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quorum-revoke-rollback-'));
  const path = join(dir, 'quorum.db');
  try {
    const quorum = openQuorum({ path });
    const ada = boundIdentity(quorum, 'ada');
    const claim = quorum.claimScope({
      participantId: ada.participant.id,
      repo: 'quorum',
      patterns: ['src/**'],
      purpose: 'must roll back',
    });
    assert.equal(claim.ok, true);
    const raw = new DatabaseSync(path);
    raw.exec(`
      CREATE TRIGGER fail_revocation BEFORE INSERT ON events
      WHEN NEW.kind = 'grant_revoked'
      BEGIN SELECT RAISE(ABORT, 'forced revocation failure'); END;
    `);
    raw.close();

    assert.throws(() => quorum.identity.revokeGrant(ada.grant.id), /forced revocation failure/);
    assert.equal(quorum.identity.verify(ada.token).ok, true, 'the grant mutation rolled back');
    assert.deepEqual(quorum.listClaims().map((held) => held.id), claim.ok ? [claim.claim.id] : []);
    assert.equal(quorum.readEvents().filter((event) => event.kind === 'claim_revoked').length, 0);
    quorum.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mint-token reports how many claims a principal revocation freed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quorum-revoke-cli-'));
  const path = join(dir, 'quorum.db');
  try {
    const quorum = openQuorum({ path });
    const ada = boundIdentity(quorum, 'cli-agent');
    quorum.claimScope({
      participantId: ada.participant.id,
      repo: 'quorum',
      patterns: ['src/**'],
      purpose: 'visible operator consequence',
    });
    quorum.close();

    const run = spawnSync(process.execPath, ['scripts/mint-token.ts', '--revoke', 'cli-agent:principal'], {
      cwd: join(import.meta.dirname, '..'),
      env: { ...process.env, QUORUM_DB: path },
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /1 claim\(s\) freed/);
    const reopened = openQuorum({ path });
    assert.deepEqual(reopened.listClaims(), []);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('one live session per grant: a second establishment is refused while the first is alive', () => {
  const { quorum } = fresh();
  const { grant } = quorum.identity.mint({ name: 'ada:one-session' });
  const before = quorum.latestSeq();

  const live = quorum.identity.establish({ grantId: grant.id, source: 'mcp', graceMs: 60_000 });
  assert.equal(live.ok, true);

  const second = quorum.identity.establish({ grantId: grant.id, source: 'mcp', graceMs: 60_000 });
  assert.equal(second.ok, false);
  const refusal = second.ok === false ? second.refusal : '';
  assert.match(refusal, /already holds a live session/);
  assert.match(refusal, /one session at a time/, 'the refusal says what the rule is');
  assert.match(refusal, /revoke the grant/, 'and what the human can do about it');

  const events = quorum.readEvents({ afterSeq: before });
  const refused = events.find((event) => event.kind === 'session_refused');
  assert.ok(refused, 'a refused fork is loud, not silent');
  assert.equal(refused?.actorId, null, 'the server refused it; no participant did');
  assert.equal(refused?.payload.grantId, grant.id);
  assert.equal(refused?.payload.liveSessionId, live.ok ? live.session.id : null, 'and it names the session that held it');
  quorum.close();
});

test('past the grace window the silent session is superseded, and the feed names both', () => {
  const { quorum, tick } = fresh();
  const { grant } = quorum.identity.mint({ name: 'ada:supersede' });
  const first = quorum.identity.establish({ grantId: grant.id, source: 'mcp', graceMs: 60_000 });
  const firstId = first.ok ? first.session.id : '';
  const before = quorum.latestSeq();

  // The harness went away without saying goodbye, and stayed away.
  tick(60_001);
  const second = quorum.identity.establish({ grantId: grant.id, source: 'mcp', graceMs: 60_000 });
  assert.equal(second.ok, true);
  assert.deepEqual(second.ok ? second.superseded : [], [firstId]);

  const superseded = quorum.readEvents({ afterSeq: before }).find((event) => event.kind === 'session_superseded');
  assert.ok(superseded, 'supersession is on the feed, where the sponsoring human reads it');
  assert.equal(superseded?.payload.grantId, grant.id);
  assert.equal(superseded?.payload.endedSessionId, firstId);
  assert.equal(superseded?.payload.sessionId, second.ok ? second.session.id : null);

  const history = quorum.identity.sessionsOf(grant.id);
  assert.equal(history.length, 2, 'both sessions stay on the record — that is the forensic point');
  assert.equal(history[0]?.endedReason, 'superseded');
  assert.equal(history[1]?.endedAt, null);
  assert.equal(quorum.identity.touch(firstId), false, 'and the old session can no longer act');
  quorum.close();
});

test('the http path mints one session and then rides it, rather than forking on every request', () => {
  const { quorum, tick } = fresh();
  const { grant } = quorum.identity.mint({ name: 'skill:script' });

  const first = quorum.identity.attach({ grantId: grant.id, source: 'http', graceMs: 60_000 });
  tick(1_000);
  const again = quorum.identity.attach({ grantId: grant.id, source: 'http', graceMs: 60_000 });
  assert.equal(first.ok && again.ok && first.session.id === again.session.id, true, 'the same session continues');
  assert.equal(quorum.identity.sessionsOf(grant.id).length, 1, 'one session, not one per request');

  const record = quorum.identity.sessionsOf(grant.id)[0];
  assert.ok((record?.lastSeenAt ?? 0) > (record?.startedAt ?? 0), 'and last seen advances with the calls');
  quorum.close();
});

test('asserted provenance is recorded as data and decides nothing', () => {
  const { quorum } = fresh();
  const { grant } = quorum.identity.mint({ name: 'ada:asserted' });
  const opened = quorum.identity.establish({ grantId: grant.id, source: 'mcp' });
  const sessionId = opened.ok ? opened.session.id : '';

  quorum.identity.recordAssertion({
    sessionId,
    conversationId: 'not-a-real-conversation',
    startTime: '2026-07-29T00:00:00.000Z',
  });
  const record = quorum.identity.sessionsOf(grant.id)[0];
  assert.equal(record?.assertedConversation, 'not-a-real-conversation');
  assert.equal(record?.assertedStart, '2026-07-29T00:00:00.000Z');

  // A lie cannot reach authority: the credential is still the only thing that
  // decided anything, and the assertion changed no verification.
  assert.equal(quorum.identity.verify(null).ok, false);
  quorum.close();
});

test('a participant belongs to one agent identity, and a second cannot claim it', () => {
  const { quorum } = fresh();
  const mine = quorum.identity.mint({ name: 'ada:bound' });
  const theirs = quorum.identity.mint({ name: 'grace:bound' });
  const { participant } = quorum.identify({ name: 'ada', harness: 'claude-code' });

  quorum.identity.bindParticipant({ participantId: participant.id, principalId: mine.principal.id });
  assert.equal(quorum.identity.participantFor(mine.principal.id), participant.id);
  // Idempotent for the same identity — a reconnect rebinds the same row.
  quorum.identity.bindParticipant({ participantId: participant.id, principalId: mine.principal.id });

  assert.throws(
    () => quorum.identity.bindParticipant({ participantId: participant.id, principalId: theirs.principal.id }),
    /another agent identity/,
    'wearing another agent\'s name is the hole this closes',
  );
  quorum.close();
});

test('an action carries the session that took it, and the clock\'s events carry none', async () => {
  const { quorum, tick } = fresh();
  const { grant } = quorum.identity.mint({ name: 'ada:attributed' });
  const opened = quorum.identity.establish({ grantId: grant.id, source: 'mcp' });
  const sessionId = opened.ok ? opened.session.id : '';
  const { participant } = quorum.identify({ name: 'ada:attributed', harness: 'claude-code' });
  quorum.identity.bindParticipant({ participantId: participant.id, principalId: grant.principalId });

  const before = quorum.latestSeq();
  await actingSession(sessionId, async () => {
    quorum.createRoom({ name: 'attributed', by: participant.id });
    await quorum.post({ room: 'attributed', participantId: participant.id, body: 'said in a known session' });
    quorum.claimScope({
      participantId: participant.id,
      repo: 'attributed',
      purpose: 'a lease that ends itself',
      ttlSeconds: 1,
    });
  });

  const mine = quorum.readEvents({ afterSeq: before });
  assert.ok(mine.length >= 3);
  for (const event of mine) {
    assert.equal(event.sessionId, sessionId, `${event.kind} attributes to (principal, session)`);
  }

  // The lease expires on its own: nobody acted, so no session did either.
  // Expiry is read-time (quorum.ts sweepExpired), so asking what is live is
  // what makes the clock's event exist.
  tick(2_000);
  quorum.listClaims();
  const swept = quorum.readEvents({ afterSeq: mine[mine.length - 1]!.seq });
  const expiry = swept.find((event) => event.kind === 'claim_expired');
  assert.ok(expiry, 'the sweep announced it');
  assert.equal(expiry?.actorId, null);
  assert.equal(expiry?.sessionId, null, 'an unauthored event belongs to no session');
  quorum.close();
});
