// Presence (#17): what the server observed about who is still listening, and
// — just as much — what it refuses to claim it observed.
//
// Behavioural where it can be. Two of these are structural on purpose, because
// the properties they hold are the kind that decay silently: D10 (presence
// informs guidance, never outcomes) and contract rule 4 (no busy-polling) are
// both invisible in any single passing test, and both are one plausible import
// away from being gone.
//
// The clock is driven, never slept through: every "went quiet" below is a
// number moving, so the suite takes no wall-clock time and says exactly which
// threshold it is standing on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { goneQuiet, PRESENCE_WINDOW_MS } from '../src/domain/presence.ts';
import { DEFAULT_SESSION_GRACE_MS } from '../src/domain/session.ts';
import { openQuorum, type Quorum } from '../src/domain/quorum.ts';
import { MCP_PATH, startServer } from '../src/mcp/server.ts';
import { callTool, type Session } from '../src/mcp/tools.ts';

const ROOT = new URL('..', import.meta.url);
const source = (path: string) => readFileSync(fileURLToPath(new URL(path, ROOT)), 'utf8');

function fresh() {
  let clock = 1_700_000_000_000;
  const quorum = openQuorum({ now: () => clock });
  return { quorum, tick: (ms: number) => (clock += ms) };
}

/** A participant with an identity behind it — the only kind that can be observed. */
function credentialed(quorum: Quorum, name: string) {
  const { participant } = quorum.identify({ name, harness: 'test' });
  const { grant, principal } = quorum.identity.mint({ name: `${name}-principal` });
  quorum.identity.bindParticipant({ participantId: participant.id, principalId: principal.id });
  const opened = quorum.identity.establish({ grantId: grant.id, source: 'test' });
  assert.ok(opened.ok, 'the fixture must open a session');
  return { participant, grant, sessionId: opened.ok ? opened.session.id : '' };
}

const session = (participantId: string | null): Session => ({
  participantId,
  cursor: 0,
  principalId: null,
  identitySession: null,
});

test('a name with no identity behind it is unknown, never offline', () => {
  const { quorum } = fresh();
  const { participant } = quorum.identify({ name: 'ada', harness: 'test' });

  // QUORUM_AUTH is off by default, so this is the ordinary v0 roster. There is
  // no session to observe, which is not the same as having observed an absence
  // — and saying "offline" here would be the server asserting what it cannot
  // see, which is the one thing this feature must not do.
  assert.deepEqual(quorum.presenceOf(participant.id), {
    liveness: 'unknown',
    lastSeenAt: null,
    quietForMs: null,
  });
  assert.equal(goneQuiet(quorum.presenceOf(participant.id)), null, 'and guidance says nothing about it');
  quorum.close();
});

test('a session that called in a moment ago is online, and its silence is measured', () => {
  const { quorum, tick } = fresh();
  const { participant, sessionId } = credentialed(quorum, 'ada');

  const online = quorum.presenceOf(participant.id);
  assert.equal(online.liveness, 'online');
  assert.equal(online.quietForMs, 0);
  assert.equal(goneQuiet(online), null, 'nothing to report about someone who is here');

  tick(PRESENCE_WINDOW_MS + 1_000);
  const quiet = quorum.presenceOf(participant.id);
  assert.equal(quiet.liveness, 'offline');
  assert.equal(quiet.lastSeenAt, online.lastSeenAt, 'going quiet does not erase when it was last seen');
  assert.equal(quiet.quietForMs, PRESENCE_WINDOW_MS + 1_000);
  assert.equal(goneQuiet(quiet), 'has been quiet for 3m');

  // The heartbeat is the traffic that already exists: any authenticated call
  // refreshes the session (src/http/auth.ts calls this on every request), and
  // nothing anywhere polls to make it happen.
  quorum.identity.touch(sessionId);
  assert.equal(quorum.presenceOf(participant.id).liveness, 'online');
  quorum.close();
});

test('a session that ended is offline at once — leaving is something the server saw', () => {
  const { quorum } = fresh();
  const { participant, sessionId } = credentialed(quorum, 'ada');
  quorum.identity.endSession(sessionId, 'closed');

  // No window to wait out. A clean disconnect, a supersession, and a
  // revocation are all the server watching someone go, which is a stronger
  // observation than silence.
  const gone = quorum.presenceOf(participant.id);
  assert.equal(gone.liveness, 'offline');
  assert.equal(gone.quietForMs, 0, 'and the last thing it said was a moment ago');
  assert.equal(goneQuiet(gone), 'has been quiet for under a minute');
  quorum.close();
});

test('presence follows the session that supersedes, and dies with a revoked grant', () => {
  const { quorum, tick } = fresh();
  const { participant, grant } = credentialed(quorum, 'ada');

  // The crashed-harness path (design §4.2): silent past the grace window, so a
  // second establishment supersedes rather than being refused.
  tick(DEFAULT_SESSION_GRACE_MS + 1);
  const resumed = quorum.identity.establish({ grantId: grant.id, source: 'test-resumed' });
  assert.ok(resumed.ok, 'a silent grant frees for the harness that comes back');
  assert.equal(quorum.presenceOf(participant.id).liveness, 'online', 'the new session is the live one');

  quorum.identity.revokeGrant(grant.id);
  assert.equal(quorum.presenceOf(participant.id).liveness, 'offline', 'a revoked credential is nobody listening');
  quorum.close();
});

test('the presence window is its own number, not the session grace window', () => {
  const { quorum, tick } = fresh();
  const { participant } = credentialed(quorum, 'ada');

  // These answer different questions and must be tunable apart: the grace
  // window is how long before another harness may take a silent grant, and
  // moving a security parameter to change what a roster says would be the
  // wrong lever entirely.
  assert.ok(PRESENCE_WINDOW_MS > DEFAULT_SESSION_GRACE_MS);
  // The floor that matters: wait_for_events clamps to 120s and refreshes the
  // session when the call arrives, not while it blocks. A window at or under
  // that ceiling reports an agent doing exactly what the contract asks as gone.
  assert.ok(PRESENCE_WINDOW_MS > 120_000, 'the long poll must never make a participant look absent');

  tick(DEFAULT_SESSION_GRACE_MS + 1_000);
  assert.equal(
    quorum.presenceOf(participant.id).liveness,
    'online',
    'past the grace window is not past the presence window',
  );
  quorum.close();
});

test('the roster carries presence, and the stored feed does not', () => {
  const { quorum } = fresh();
  const { participant } = credentialed(quorum, 'ada');

  const row = quorum.roster().find((person) => person.id === participant.id);
  assert.equal(row?.presence.liveness, 'online');
  assert.equal(row?.status, null, 'the two axes are independent: liveness observed, status self-declared');

  // Participants are embedded in event payloads, and the feed is the product's
  // memory. A projection that was true for three minutes must not be frozen
  // into a row that is read for months.
  const identified = quorum.readEvents().find((event) => event.kind === 'participant_identified');
  assert.ok(identified, 'the identify event is on the feed');
  assert.equal('presence' in (identified.payload.participant as object), false);
  quorum.close();
});

test('both axes coexist: an agent can be blocked and offline at the same time', async () => {
  const { quorum, tick } = fresh();
  const { participant } = credentialed(quorum, 'ada');
  quorum.createRoom({ name: 'work', by: participant.id });
  await quorum.post({ room: 'work', participantId: participant.id, body: '/blocked waiting on review' });

  tick(PRESENCE_WINDOW_MS + 1);
  const row = quorum.roster().find((person) => person.id === participant.id);
  // The state a single combined enum cannot express, and the one someone
  // debugging most needs: it said it was stuck, and then it stopped answering.
  assert.equal(row?.presence.liveness, 'offline');
  assert.equal(row?.status?.kind, 'blocked');
  quorum.close();
});

test('list_participants reports the quiet without naming them in the guidance', async () => {
  const { quorum, tick } = fresh();
  const { participant } = credentialed(quorum, 'ada');
  tick(PRESENCE_WINDOW_MS + 1);

  const reply = await callTool(quorum, session(participant.id), 'list_participants', {});
  const roster = reply.data.participants as { presence: { liveness: string } }[];
  assert.equal(roster[0]?.presence.liveness, 'offline');
  assert.match(reply.guidance, /1 of whom this server has not heard from lately/);
  assert.match(reply.guidance, /not a prediction/, 'the reply says what presence is worth');
  quorum.close();
});

test('presence reaches a stock MCP client as part of the roster', async () => {
  // The wire shape, through the SDK's own client (AGENTS.md). Real server, real
  // clock, and QUORUM_AUTH off — which is the honest case to assert: with no
  // credential there is no session to observe, so an agent that is demonstrably
  // right here reads `unknown` rather than `offline`.
  const quorum = openQuorum();
  const server = await startServer({ quorum });
  const client = new Client({ name: 'test-agent', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}${MCP_PATH}`)));

  await client.callTool({ name: 'identify', arguments: { name: 'ada', harness: 'test' } });
  const roster = (await client.callTool({ name: 'list_participants', arguments: {} })) as {
    structuredContent?: { participants?: { presence: { liveness: string } }[]; guidance?: string };
  };
  assert.deepEqual(
    roster.structuredContent?.participants?.map((person) => person.presence.liveness),
    ['unknown'],
  );
  assert.doesNotMatch(String(roster.structuredContent?.guidance), /not heard from/);

  await client.close();
  await server.close();
  quorum.close();
});

test('a refusal says whether the holder it sends you to is still there', async () => {
  const { quorum, tick } = fresh();
  const { participant: holder } = credentialed(quorum, 'ada');
  const { participant: waiter } = credentialed(quorum, 'grace');
  quorum.claimScope({ participantId: holder.id, repo: 'app', purpose: 'refactor', patterns: ['src/**'] });

  const present = await callTool(quorum, session(waiter.id), 'claim_scope', {
    repo: 'app',
    purpose: 'the same files',
    patterns: ['src/**'],
  });
  assert.equal(present.data.granted, false);
  assert.doesNotMatch(present.guidance, /quiet/, 'nothing to say while the holder is listening');

  tick(PRESENCE_WINDOW_MS + 1);
  const absent = await callTool(quorum, session(waiter.id), 'claim_scope', {
    repo: 'app',
    purpose: 'the same files',
    patterns: ['src/**'],
  });
  // The advice changes; the answer does not. Both refuse, both name the same
  // lease, and neither offers a way around it.
  assert.equal(absent.data.granted, false);
  assert.deepEqual(absent.data.conflicts, present.data.conflicts);
  assert.match(absent.guidance, /"ada" has been quiet for/);
  assert.match(absent.guidance, /the lease still expires on its own/);
  assert.match(absent.guidance, /Do not route around it/);
  quorum.close();
});

test('a vote in progress names the eligible voters who have gone quiet', async () => {
  const { quorum, tick } = fresh();
  const { participant: convener } = credentialed(quorum, 'ada');
  const { participant: absentee } = credentialed(quorum, 'grace');
  quorum.createRoom({ name: 'work', by: convener.id });
  quorum.joinRoom({ room: 'work', participantId: absentee.id });
  const opened = quorum.propose({
    participantId: convener.id,
    room: 'work',
    question: 'ship it?',
    options: ['yes', 'no'],
  });
  quorum.closeChallenges({ participantId: convener.id, deliberationId: opened.id });
  quorum.vote({ participantId: convener.id, deliberationId: opened.id, choice: 0 });

  // Both go quiet; only one of them is a ballot anyone is still waiting on.
  tick(PRESENCE_WINDOW_MS + 1);
  const reply = await callTool(quorum, session(convener.id), 'get_deliberation', {
    deliberation_id: opened.id,
  });
  assert.match(reply.guidance, /has not heard from "grace" lately/);
  assert.doesNotMatch(reply.guidance, /"ada"/, 'a voter who already cast is not a voter to wait for');
  assert.match(reply.guidance, /an observation, not a rule/);
  quorum.close();
});

test('D10: the record is identical whether the absent voter is observed or not', () => {
  // Same ballots, same deadlines, same clock — one run where the absentee's
  // session is alive and one where it went quiet an hour ago. If presence ever
  // reaches the rule engine, these two stop matching.
  const run = (silenceMs: number) => {
    const { quorum, tick } = fresh();
    const { participant: convener } = credentialed(quorum, 'ada');
    const { participant: absentee } = credentialed(quorum, 'grace');
    const room = quorum.createRoom({ name: 'work', decisionRule: 'unanimity', by: convener.id });
    quorum.joinRoom({ room: room.id, participantId: absentee.id });
    const opened = quorum.propose({
      participantId: convener.id,
      room: room.id,
      question: 'ship it?',
      options: ['yes', 'no'],
      voteTtlSeconds: 60,
    });
    quorum.closeChallenges({ participantId: convener.id, deliberationId: opened.id });
    quorum.vote({ participantId: convener.id, deliberationId: opened.id, choice: 0 });

    tick(silenceMs);
    const liveness = quorum.presenceOf(absentee.id).liveness;
    tick(61_000); // past the voting deadline: the phase closes on the clock (D2)
    const decision = quorum.getDecision({ deliberationId: opened.id });
    quorum.close();
    return { liveness, outcome: decision.outcome, kind: decision.failureKind, reason: decision.reason };
  };

  const watched = run(0);
  const vanished = run(60 * 60_000);
  assert.equal(watched.liveness, 'online');
  assert.equal(vanished.liveness, 'offline', 'the two runs really do differ in what was observed');
  assert.equal(vanished.outcome, 'failed');
  assert.equal(vanished.kind, 'quorum_absent');
  assert.equal(watched.reason, vanished.reason, 'the record names the same non-voter for the same reason');
  assert.equal(watched.outcome, vanished.outcome);
  assert.equal(watched.kind, vanished.kind);
});

test('D10 and contract rule 4 hold structurally, not by discipline', () => {
  // The rule engine must not be able to read presence at all. Checked at the
  // import line rather than anywhere in the text, because the file talks about
  // presence on purpose — D10 is written into the comment above computeOutcome,
  // and a check that forbade the word would push out the explanation.
  const imports = source('src/domain/deliberation.ts').match(/^import .*$/gmu) ?? [];
  assert.equal(
    imports.some((line) => /presence/i.test(line)),
    false,
    'the deliberation rule engine must not be able to reach presence at all',
  );

  // And presence adds no loop. Everything it reports is refreshed by traffic
  // that was already happening, so there is nothing here to schedule.
  const presence = source('src/domain/presence.ts');
  assert.doesNotMatch(presence, /setInterval|setTimeout|setImmediate/);
  assert.doesNotMatch(presence, /INSERT|UPDATE|DELETE/, 'a projection writes nothing');
});
