// Enforcement over the wire, through the SDK's own client — the same stock
// client every harness uses (requirement 8), with QUORUM_AUTH on.
//
// The other half of the proof lives in the rest of this suite: with the switch
// off, none of these refusals exist and every existing test passes untouched.
// Both halves matter, because "auth is available" and "auth is mandatory" are
// different products, and v0 has to keep working while v1 is built.
//
// One rule runs through every assertion below: a refusal says what is missing
// and what to do about it, and never repeats the credential it was handed.

process.env.QUORUM_AUTH = '1';
process.env.QUORUM_SESSION_GRACE_MS = '60000';

import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { openQuorum } from '../src/domain/quorum.ts';
import { TOKEN_PREFIX } from '../src/domain/identity.ts';
import { MCP_PATH, startServer } from '../src/mcp/server.ts';

const quorum = openQuorum();
const server = await startServer({ quorum });
const origin = `http://127.0.0.1:${server.port}`;
const url = new URL(`${origin}${MCP_PATH}`);
const clients: Client[] = [];

after(async () => {
  // A client whose credential was revoked mid-test cannot say goodbye, and
  // that is the feature working rather than a failure to clean up.
  for (const client of clients) await client.close().catch(() => {});
  await server.close();
  quorum.close();
});

const mint = (name: string, ttlMs?: number | null) => quorum.identity.mint({ name, ttlMs });

async function connect(token: string | null): Promise<Client> {
  const client = new Client({ name: 'test-agent', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(url),
      token === null ? undefined : { requestInit: { headers: { authorization: `Bearer ${token}` } } },
    ),
  );
  clients.push(client);
  return client;
}

type ToolResult = { structuredContent?: Record<string, unknown>; isError?: boolean; content?: unknown };

const call = async (client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> =>
  (await client.callTool({ name, arguments: args })) as ToolResult;

/** What the server said when it said no. Fails the test if it said yes. */
async function refusalOf(action: () => Promise<unknown>): Promise<string> {
  let refusal: string | null = null;
  try {
    await action();
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error);
  }
  assert.ok(refusal !== null, 'that should have been refused');
  return refusal;
}

const participantOf = (result: ToolResult): string => (result.structuredContent?.participant as { id: string }).id;

test('without a credential there is no mcp session, and the refusal says how to get one', async () => {
  const refusal = await refusalOf(() => connect(null));
  assert.match(refusal, /no access token was presented/, 'it says what was missing');
  assert.match(refusal, new RegExp(`Authorization: Bearer ${TOKEN_PREFIX}`), 'and where the token goes');
  assert.match(refusal, /mint-token/, 'and how the operator makes one');
  assert.match(refusal, /QUORUM_AUTH/, 'and which switch turned this on');
});

test('a token this server never issued is refused, and is not repeated back', async () => {
  const forged = `${TOKEN_PREFIX}${'z'.repeat(43)}`;
  const refusal = await refusalOf(() => connect(forged));
  assert.match(refusal, /not one this server issued/);
  assert.ok(!refusal.includes(forged), 'the presented credential never appears in the answer');
  assert.doesNotMatch(refusal, /zzzz/);
});

test('an expired token and a revoked one are both dead on arrival', async () => {
  const stale = mint('agent:expired', 1);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.match(await refusalOf(() => connect(stale.token)), /expired/);

  const killed = mint('agent:revoked-before-use');
  quorum.identity.revokeGrant(killed.grant.id);
  const refusal = await refusalOf(() => connect(killed.token));
  assert.match(refusal, /revoked/);
  assert.ok(!refusal.includes(killed.token));
});

test('a valid token identifies and acts, and every event it causes carries its session', async () => {
  const { token, grant, principal } = mint('agent:acting');
  const client = await connect(token);

  const identified = await call(client, 'identify', {
    name: 'acting-agent',
    harness: 'cursor',
    conversation_id: 'conv-42',
    start_time: '2026-07-29T12:00:00.000Z',
  });
  assert.equal(identified.isError, undefined);
  assert.ok(!JSON.stringify(identified).includes(token), 'a reply never carries the credential');

  const before = quorum.latestSeq();
  await call(client, 'create_room', { name: 'authed-room' });
  await call(client, 'post_message', { room: 'authed-room', body: 'said by a credentialed agent' });

  const sessions = quorum.identity.sessionsOf(grant.id);
  assert.equal(sessions.length, 1, 'initialize minted exactly one session');
  const events = quorum.readEvents({ afterSeq: before });
  assert.ok(events.length >= 2, 'the room and the message both landed');
  for (const event of events) {
    assert.equal(event.sessionId, sessions[0]?.id, `${event.kind} attributes to (principal, session)`);
  }

  // Asserted provenance rides along as data — recorded, never checked (§4.1).
  assert.equal(sessions[0]?.assertedConversation, 'conv-42');
  assert.equal(sessions[0]?.assertedStart, '2026-07-29T12:00:00.000Z');
  // And the roster row now belongs to the identity that authenticated.
  assert.equal(quorum.identity.participantFor(principal.id), participantOf(identified));
});

test('a second session on a live grant is refused, and the feed records the attempt', async () => {
  const { token, grant } = mint('agent:one-at-a-time');
  const first = await connect(token);
  await call(first, 'identify', { name: 'one-at-a-time', harness: 'cursor' });

  const before = quorum.latestSeq();
  const refusal = await refusalOf(() => connect(token));
  assert.match(refusal, /already holds a live session/, 'the credential is in use');
  assert.match(refusal, /revoke the grant/, 'and the human is told what they can do');
  assert.ok(!refusal.includes(token));

  const refused = quorum.readEvents({ afterSeq: before }).find((event) => event.kind === 'session_refused');
  assert.ok(refused, 'the sponsoring human sees the attempt');
  assert.equal(refused?.actorId, null, 'the server refused it; no participant did');
  assert.equal(refused?.payload.grantId, grant.id);
  assert.equal(refused?.payload.liveSessionId, quorum.identity.sessionsOf(grant.id)[0]?.id);
});

test('past the grace window a new session supersedes the old, which can no longer act', async () => {
  process.env.QUORUM_SESSION_GRACE_MS = '1';
  try {
    const { token, grant } = mint('agent:superseded');
    const crashed = await connect(token);
    await call(crashed, 'identify', { name: 'superseded-agent', harness: 'cursor' });
    const before = quorum.latestSeq();

    // The harness went quiet — longer than the window a crash is given.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const resumed = await connect(token);
    const listed = await call(resumed, 'list_rooms');
    assert.equal(listed.isError, undefined, 'the new session works');

    const sessions = quorum.identity.sessionsOf(grant.id);
    assert.equal(sessions.length, 2, 'both sessions are on the record');
    assert.equal(sessions[0]?.endedReason, 'superseded');

    const superseded = quorum.readEvents({ afterSeq: before }).find((event) => event.kind === 'session_superseded');
    assert.ok(superseded, 'and the supersession is loud');
    assert.equal(superseded?.payload.endedSessionId, sessions[0]?.id);
    assert.equal(superseded?.payload.sessionId, sessions[1]?.id);

    // The old connection still holds a token and a session id, and neither is
    // enough: the session it names is over.
    assert.match(await refusalOf(() => call(crashed, 'list_rooms')), /session has ended/);
  } finally {
    process.env.QUORUM_SESSION_GRACE_MS = '60000';
  }
});

test('revoking a grant ends access on the very next call', async () => {
  const { token, grant } = mint('agent:mid-session');
  const client = await connect(token);
  await call(client, 'identify', { name: 'mid-session-agent', harness: 'cursor' });
  assert.equal((await call(client, 'list_rooms')).isError, undefined);

  quorum.identity.revokeGrant(grant.id);
  const refusal = await refusalOf(() => call(client, 'list_rooms'));
  assert.match(refusal, /revoked/, 'the credential is checked on every message, not once at connect');
  assert.ok(!refusal.includes(token));
});

test('the ?as= read seams answer only to the participant whose token asked', async () => {
  // A skill calling the HTTP API is its own pairing: a grant carries one
  // session at a time (§4.2), so a script gets its own credential rather than
  // sharing the one an MCP session already holds.
  const mine = mint('skill:as-seam');
  const theirs = mint('skill:as-other');
  const headers = (token: string | null) => ({
    'content-type': 'application/json',
    ...(token === null ? {} : { authorization: `Bearer ${token}` }),
  });
  const identify = async (token: string, name: string): Promise<string> => {
    const response = await fetch(`${origin}/api/identify`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ name }),
    });
    assert.equal(response.status, 200, 'the first authenticated request mints the session');
    return ((await response.json()) as { participant: { id: string } }).participant.id;
  };

  const me = await identify(mine.token, 'as-seam-skill');
  const them = await identify(theirs.token, 'as-other-skill');

  const mismatched = await fetch(`${origin}/api/dms?as=${them}`, { headers: headers(mine.token) });
  assert.equal(mismatched.status, 401);
  const refusal = JSON.stringify(await mismatched.json());
  assert.match(refusal, /not the one your credential identified as/);
  assert.ok(!refusal.includes(mine.token), 'not even the seam that refuses echoes the token');

  const uncredentialed = await fetch(`${origin}/api/dms?as=${me}`);
  assert.equal(uncredentialed.status, 401, 'the seam is closed to anyone without a token');

  const own = await fetch(`${origin}/api/dms?as=${me}`, { headers: headers(mine.token) });
  assert.equal(own.status, 200, 'and open to the participant it belongs to');

  // A write body names a participant the same way, and is checked the same way.
  const impersonation = await fetch(`${origin}/api/rooms/authed-room/messages`, {
    method: 'POST',
    headers: headers(mine.token),
    body: JSON.stringify({ participantId: them, body: 'not mine to send' }),
  });
  assert.equal(impersonation.status, 403);
  assert.match(JSON.stringify(await impersonation.json()), /speaks only for its own identity/);

  // The live event stream is the same seam, refused before a frame is written.
  const watching = new AbortController();
  const stream = await fetch(`${origin}/api/events?as=${them}`, {
    headers: headers(mine.token),
    signal: watching.signal,
  });
  assert.equal(stream.status, 401);
  await stream.body?.cancel();
  watching.abort();
});

test('nothing the server records or answers with carries a token', () => {
  const feed = JSON.stringify(quorum.readEvents({ afterSeq: 0, limit: 500 }));
  assert.doesNotMatch(feed, /qpat_/, 'the feed names grants and sessions, never secrets');
  const grants = JSON.stringify(quorum.identity.listGrants());
  assert.doesNotMatch(grants, /qpat_/, 'and neither does the operator listing');
});
