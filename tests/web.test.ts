// The human transport, over the wire — the same server, the same domain, the
// same event feed the agents read.
//
// The property worth testing is not "the endpoint returns JSON". It is that a
// human and an agent cannot be shown different answers: one domain, two
// transports. So the assertions run an agent-side write through the domain and
// check that the human side sees exactly it, at the same seq.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import { openQuorum } from '../src/domain/quorum.ts';
import { startServer } from '../src/mcp/server.ts';
import { allowedHosts, refuseWrite } from '../src/http/origin.ts';

const quorum = openQuorum();
const server = await startServer({ quorum });
const origin = `http://127.0.0.1:${server.port}`;

after(async () => {
  await server.close();
  quorum.close();
});

const dana = quorum.identify({ name: 'Dana', harness: 'human' }).participant;
const codex = quorum.identify({ name: 'codex:api', harness: 'codex' }).participant;
const room = quorum.createRoom({ name: 'protocol', topic: 'the wire contract', by: dana.id });
quorum.joinRoom({ room: 'protocol', participantId: codex.id });

async function get(path: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${origin}${path}`);
  return { status: response.status, body: await response.json() };
}

async function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

/**
 * Read SSE frames until `want` of them have a real event name, or the deadline
 * passes. Returns the parsed frames so a test can assert on seq and payload.
 */
async function stream(path: string, want: number, act?: () => void): Promise<{ event: string; id: string; data: any }[]> {
  const controller = new AbortController();
  const response = await fetch(`${origin}${path}`, { signal: controller.signal });
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: { event: string; id: string; data: any }[] = [];
  let buffer = '';
  let acted = false;

  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    while (frames.length < want) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let split;
      while ((split = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        if (raw.startsWith(':')) continue; // keep-alive comment
        const fields = Object.fromEntries(
          raw.split('\n').map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]),
        );
        const data = JSON.parse(fields.data!);
        // Domain events arrive unnamed so one listener catches every kind,
        // including ones a page has not been taught; the kind is in the body.
        frames.push({ event: fields.event ?? data.kind, id: fields.id!, data });
      }

      // Act only once the stream is established, so the event we are waiting
      // for cannot land before anyone is listening.
      if (!acted && act) {
        acted = true;
        act();
      }
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return frames;
}

test('the read API answers from the same domain the tools call', async () => {
  const rooms = await get('/api/rooms');
  assert.equal(rooms.status, 200);
  assert.deepEqual(
    rooms.body.rooms.map((r: any) => [r.name, r.members]),
    [['protocol', 2]],
  );

  const participants = await get('/api/participants');
  assert.deepEqual(
    participants.body.participants.map((p: any) => `${p.name}/${p.harness}`).sort(),
    ['Dana/human', 'codex:api/codex'],
  );

  quorum.postMessage({ room: 'protocol', participantId: codex.id, body: 'Claiming src/mcp/** for the schema pass.' });
  const messages = await get('/api/rooms/protocol/messages');
  assert.equal(messages.body.messages.at(-1).body, 'Claiming src/mcp/** for the schema pass.');
});

test('a fresh stream tails from the head; only ?after= replays', async () => {
  // `Number(null)` is 0 and passes `Number.isFinite`, so parsing before
  // checking presence made every fresh stream replay all of history and left
  // the head fallback as dead code. Absent and zero are different answers.
  const head = quorum.latestSeq();
  assert.ok(head > 0, 'there is history to replay if the default is wrong');

  const fresh = await stream('/api/events', 1);
  assert.equal(fresh[0]!.event, 'cursor');
  assert.equal(fresh[0]!.data.after, head, 'no parameter means "from now", not "from the beginning"');

  const replay = await stream('/api/events?after=0', 2);
  assert.equal(replay[0]!.data.after, 0, '?after=0 is an explicit ask for everything, and is honoured');
  assert.ok(replay.slice(1).some((f) => f.data.kind), 'history actually arrives');
});

test('a page can open its stream where its first paint ended, with no gap', async () => {
  // Every read is stamped with the feed position *before* it ran, so a page
  // that opens the stream at that seq cannot miss an event that landed while
  // it was painting. The cost is that such an event arrives twice — which is
  // the trade the durable cursor already makes: a duplicate is visible and a
  // gap is not.
  const painted = await get('/api/rooms/protocol/messages');
  assert.equal(typeof painted.body.seq, 'number');
  assert.ok(painted.body.seq <= quorum.latestSeq());

  const arrived = await stream(`/api/events?after=${painted.body.seq}`, 2, () => {
    quorum.postMessage({ room: 'protocol', participantId: dana.id, body: 'posted while the page was painting' });
  });
  const posted = arrived.find((f) => f.data.kind === 'message');
  assert.equal(posted?.data.payload.message.body, 'posted while the page was painting');
});

test('a room nobody created is a 404, not a crash', async () => {
  const missing = await get('/api/rooms/no-such-room/messages');
  assert.equal(missing.status, 404);
  assert.match(missing.body.error, /no-such-room/);
});

test('a route that only reads refuses a write rather than half-accepting one', async () => {
  // `/api/rooms` reads; there is no write behind it. A POST is routed to the
  // write surface, finds nothing, and 404s — it never reaches the read
  // handler, which is what keeps "this file only reads" true of the file.
  const response = await fetch(`${origin}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.status, 404);
  assert.match(((await response.json()) as { error: string }).error, /no such route/);

  // And a write with no content type is refused before any parsing happens.
  const bare = await fetch(`${origin}/api/rooms`, { method: 'POST' });
  assert.equal(bare.status, 403);
});

test('a human watching sees an agent post at the same seq the agent wrote it', async () => {
  const before = quorum.latestSeq();
  let written: number | undefined;

  const frames = await stream(`/api/events?after=${before}`, 2, () => {
    const message = quorum.postMessage({
      room: 'protocol',
      participantId: codex.id,
      body: 'Cost, measured: the schema pass touches 31 fixtures.',
    });
    written = message.id;
  });

  // The first frame states where the reader is, so a page that opened mid-
  // history knows what it has not seen.
  assert.equal(frames[0]!.event, 'cursor');
  assert.equal(frames[0]!.data.after, before);

  const posted = frames.find((f) => f.data.kind === 'message');
  assert.ok(posted, 'the message the agent wrote arrived on the human stream');
  assert.equal(posted.data.payload.message.id, written);
  assert.equal(posted.data.payload.from, 'codex:api');

  // The frame id is the event seq — which is what makes SSE's own reconnect a
  // working cursor, with no bookkeeping in the page.
  assert.equal(Number(posted.id), posted.data.seq);
  assert.ok(posted.data.seq > before);
});

test('reconnecting with Last-Event-ID resumes after exactly that event', async () => {
  const mark = quorum.latestSeq();
  quorum.postMessage({ room: 'protocol', participantId: codex.id, body: 'first' });
  const second = quorum.postMessage({ room: 'protocol', participantId: dana.id, body: 'second' });

  const controller = new AbortController();
  const response = await fetch(`${origin}/api/events`, {
    headers: { 'last-event-id': String(mark + 1) },
    signal: controller.signal,
  });
  const reader = response.body!.getReader();
  const text = new TextDecoder().decode((await reader.read()).value);
  controller.abort();

  // The header wins over ?after=, because the browser knows what it actually
  // received and the query string is only what the page asked for at open.
  assert.match(text, /event: cursor/);
  assert.match(text, new RegExp(`"after":${mark + 1}`));
  assert.ok(!text.includes('"body":"first"'), 'the acknowledged event is not replayed');
  assert.equal(typeof second.id, 'number');
});

test('watching a room advances nobody else\'s cursor', async () => {
  // An observer is not a participant. A human reading over someone's shoulder
  // must not mark that agent's events as delivered — the durable cursor is the
  // agent's proof of what reached it, and this transport has no business
  // touching it.
  const beforeDana = quorum.cursorFor(dana.id);
  const beforeCodex = quorum.cursorFor(codex.id);

  await stream(`/api/events?after=0`, 1);

  assert.deepEqual(quorum.cursorFor(dana.id), beforeDana);
  assert.deepEqual(quorum.cursorFor(codex.id), beforeCodex);
});

test('a first paint gets the end of a long room, not the beginning', async () => {
  // The domain reads forward from an id, so one call with limit 100 in a room
  // of 300 returns messages 1-100 — and the stream then tails from the head,
  // so 101-300 are never painted and never replayed. A silent hole in the
  // middle of the room, which is the worst shape this bug could have.
  const long = quorum.createRoom({ name: 'long', topic: 'history', by: dana.id });
  for (let i = 1; i <= 250; i += 1) {
    quorum.postMessage({ room: 'long', participantId: dana.id, body: `message ${i}` });
  }

  const painted = await get('/api/rooms/long/messages');
  const bodies = painted.body.messages.map((m: any) => m.body);
  assert.equal(bodies.length, 100, 'still a bounded window');
  assert.equal(bodies.at(-1), 'message 250', 'the newest message is on screen');
  assert.equal(bodies[0], 'message 151', 'and the window is the tail, not the head');
  assert.equal(long.name, 'long');

  // Walking forward explicitly still works, for a caller that knows where it
  // is. Message ids are global rather than per-room, so the cursor has to come
  // from a message, never from counting.
  const first = painted.body.messages[0].id;
  const walked = await get(`/api/rooms/long/messages?after=${first}&limit=2`);
  assert.deepEqual(
    walked.body.messages.map((m: any) => m.body),
    ['message 152', 'message 153'],
  );
});

test('a human joins, posts, and an agent reads it from the same domain', () => {
  // The claim this transport exists to make, exercised in the direction that
  // was missing: a browser writes, and the write is a first-class domain event
  // the agents see — not a parallel record kept for humans.
  return (async () => {
    const identified = await post('/api/identify', { name: 'Rowan' });
    assert.equal(identified.status, 200);
    assert.equal(identified.body.participant.harness, 'human');

    const id = identified.body.participant.id;
    // Idempotent on (name, harness): a reload must rejoin, never mint a twin.
    const again = await post('/api/identify', { name: 'Rowan' });
    assert.equal(again.body.participant.id, id);

    assert.equal((await post('/api/rooms/protocol/join', { participantId: id })).status, 200);

    const posted = await post('/api/rooms/protocol/messages', {
      participantId: id,
      body: 'Reviewed the wire contract — the seq stamp is the part I would keep.',
    });
    assert.equal(posted.status, 200);

    // The domain, asked the way an agent asks it.
    const seen = quorum.readMessages({ room: 'protocol', limit: 200 }).at(-1);
    assert.equal(seen!.body, 'Reviewed the wire contract — the seq stamp is the part I would keep.');
    assert.equal(seen!.participantId, id);
    assert.ok(posted.body.seq >= seen!.id, 'the response stamps the feed after the write');
  })();
});

test('a human who has not joined is refused in the words an agent gets', async () => {
  const { body } = await post('/api/identify', { name: 'Ari' });
  const refused = await post('/api/rooms/protocol/messages', {
    participantId: body.participant.id,
    body: 'posting without joining',
  });

  // One protocol, not two: the human transport does not get a softer rule, and
  // the refusal is the domain's own sentence — actionable, ending in what to do.
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /join .*protocol.* before posting/);
});

test('a page on another site cannot write to this server', async () => {
  // The threat this file exists for: the server listens on 127.0.0.1 with no
  // auth, so once it writes, every page the human visits can reach it. A
  // browser always sends Origin on a POST and a page cannot forge it.
  const { body } = await post('/api/identify', { name: 'Nico' });
  await post('/api/rooms/protocol/join', { participantId: body.participant.id });

  const attacked = await post(
    '/api/rooms/protocol/messages',
    { participantId: body.participant.id, body: 'posted by evil.example' },
    { origin: 'http://evil.example' },
  );
  assert.equal(attacked.status, 403);
  assert.match(attacked.body.error, /cross-origin/);

  // A host that merely *ends* with ours is not ours.
  const suffix = await post(
    '/api/identify',
    { name: 'Nico' },
    { origin: `http://127.0.0.1:${server.port}.evil.example` },
  );
  assert.equal(suffix.status, 403);

  // The UI this server serves is same-origin, and works.
  const allowed = await post('/api/identify', { name: 'Nico' }, { origin: `http://127.0.0.1:${server.port}` });
  assert.equal(allowed.status, 200);

  assert.ok(
    !quorum.readMessages({ room: 'protocol', limit: 200 }).some((m) => m.body.includes('evil.example')),
    'nothing the cross-origin request asked for reached the room',
  );
});

test('a form post cannot slip past the preflight', async () => {
  // application/json is not a "simple request", so a cross-origin attempt is
  // preflighted and we answer no preflight. Without this check an attacker
  // drops to text/plain — which is simple, needs no preflight, and would
  // otherwise arrive with a JSON body the parser is perfectly happy with.
  const smuggled = await post('/api/identify', JSON.stringify({ name: 'Smuggled' }), {
    'content-type': 'text/plain;charset=UTF-8',
  });
  assert.equal(smuggled.status, 403);
  assert.match(smuggled.body.error, /application\/json/);

  assert.ok(
    !quorum.listParticipants().some((p) => p.name === 'Smuggled'),
    'the participant was never created',
  );
});

test('a human votes through the browser, and the domain counts it', async () => {
  const room = quorum.createRoom({ name: 'ballots', topic: 'voting over http', by: dana.id });
  quorum.joinRoom({ room: 'ballots', participantId: codex.id });
  const proposed = quorum.propose({
    participantId: dana.id,
    room: 'ballots',
    question: 'Do we ship the write path before presence?',
    options: ['Yes', 'No'],
  });
  assert.equal(room.name, 'ballots');
  quorum.closeChallenges({ deliberationId: proposed.id, participantId: dana.id });

  const cast = await post(`/api/deliberations/${proposed.id}/vote`, { participantId: dana.id, choice: 0 });
  assert.equal(cast.status, 200);
  assert.equal(cast.body.cast, 1);

  // A ballot index has to be an integer — "0" from a form field is not one,
  // and silently coercing it is how a vote lands on the wrong option.
  const fuzzy = await post(`/api/deliberations/${proposed.id}/vote`, { participantId: codex.id, choice: '0' });
  assert.equal(fuzzy.status, 409);
  assert.match(fuzzy.body.error, /option index/);
});

test('a malformed or unknown write is refused, not half-accepted', async () => {
  assert.equal((await post('/api/identify', 'not json at all')).status, 409);
  assert.equal((await post('/api/identify', ['an', 'array'])).status, 409);
  assert.equal((await post('/api/identify', {})).status, 409, 'name is required');
  assert.equal((await post('/api/nope', {})).status, 404);

  const put = await fetch(`${origin}/api/rooms`, { method: 'PUT', headers: { 'content-type': 'application/json' } });
  assert.equal(put.status, 405);
});

test('a rebound hostname is refused however well its headers agree', () => {
  // The attack the previous check could not see. An attacker whose domain
  // resolves to 127.0.0.1 controls *both* headers, so they agree perfectly —
  // and agreement was the whole test. Only a name the server was told to
  // answer to is accepted.
  const hosts = allowedHosts({} as NodeJS.ProcessEnv);
  const headers = (h: Record<string, string>) => ({ headers: h }) as any;

  const rebound = refuseWrite(
    headers({ host: 'evil.example:4242', origin: 'http://evil.example:4242', 'content-type': 'application/json' }),
    hosts,
  );
  assert.match(rebound!, /does not answer to that hostname/);

  // Loopback still works, by name and by address, with and without a port.
  for (const host of ['127.0.0.1:4242', 'localhost:4242', '[::1]:4242', 'localhost']) {
    assert.equal(refuseWrite(headers({ host, 'content-type': 'application/json' }), hosts), null, host);
  }

  // A page on an allowed host cannot reach it from a disallowed origin.
  assert.match(
    refuseWrite(
      headers({ host: '127.0.0.1:4242', origin: 'https://evil.example', 'content-type': 'application/json' }),
      hosts,
    )!,
    /cross-origin/,
  );

  // A local dev hostname is added by configuration, never inferred.
  const configured = allowedHosts({ QUORUM_HOSTS: 'quorum.local.example.com' } as NodeJS.ProcessEnv);
  const dev = { host: 'quorum.local.example.com', origin: 'https://quorum.local.example.com', 'content-type': 'application/json' };
  assert.match(refuseWrite(headers(dev), hosts)!, /does not answer/);
  assert.equal(refuseWrite(headers(dev), configured), null);
});

test('a malformed path is a bad request, not a server fault', async () => {
  // `decodeURIComponent('%')` throws URIError, which is not a domain error, so
  // it escaped as a 500 carrying an internal message. The server survived it —
  // the top-level handler catches — but answering a bad request with "500: URI
  // malformed" tells the caller the server broke when the caller did.
  const bad = await post('/api/rooms/%/join', { participantId: 'whoever' });
  assert.equal(bad.status, 409);
  assert.match(bad.body.error, /not a valid name/);
  assert.ok(!/URI malformed/.test(bad.body.error), 'no internal error text reaches the caller');

  // Still serving afterwards.
  assert.equal((await get('/api/rooms')).status, 200);
});
