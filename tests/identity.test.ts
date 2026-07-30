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
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  assert.match(after.ok === false ? after.refusal : '', /revoked/);
  assert.equal(quorum.identity.verify(second.token).ok, true, 'the other credential is untouched, so far');

  const cascade = quorum.identity.revokePrincipal('ada:revoke');
  assert.ok(cascade.grants.includes(second.grant.id), 'revoking the principal reaches down the tree');
  const done = quorum.identity.verify(second.token);
  assert.equal(done.ok, false);
  assert.match(done.ok === false ? done.refusal : '', /identity has been revoked/);
  quorum.close();
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
  tick(2_000);
  const swept = quorum.readEvents({ afterSeq: mine[mine.length - 1]!.seq });
  const expiry = swept.find((event) => event.kind === 'claim_expired');
  assert.ok(expiry, 'the sweep announced it');
  assert.equal(expiry?.actorId, null);
  assert.equal(expiry?.sessionId, null, 'an unauthored event belongs to no session');
  quorum.close();
});
