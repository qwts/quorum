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


/**
 * Read SSE frames until `want` of them have a real event name, or the deadline
 * passes. Returns the parsed frames so a test can assert on seq and payload.
 */
async function stream(
  path: string,
  want: number,
  act?: () => void,
  headers?: Record<string, string>,
): Promise<{ event: string; id: string; data: any }[]> {
  const controller = new AbortController();
  const response = await fetch(`${origin}${path}`, { headers, signal: controller.signal });
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

test('a stale anonymous Last-Event-ID resets to replay-safe history', async () => {
  const stale = quorum.latestSeq() + 10_000;
  const frames = await stream('/api/events', 2, undefined, { 'last-event-id': String(stale) });

  assert.equal(frames[0]!.event, 'cursor');
  assert.equal(frames[0]!.data.after, 0, 'the transport publishes the repaired cursor to EventSource');
  assert.notEqual(frames[1]!.event, 'stream_error');
  assert.equal(typeof frames[1]!.data.kind, 'string', 'the restored feed is replayed instead of reconnect-looping');
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

test('a DM crosses the wire only inside its pair — stream, reads, and writes (#42)', async () => {
  const before = quorum.latestSeq();
  quorum.sendDm({ participantId: dana.id, to: codex.id, body: 'rotate the deploy key tonight' });

  // The anonymous stream replays everything after `before` — except the DM,
  // which it must not know exists. The public post gives the stream something
  // to return so the assertion is about filtering, not about an empty stream.
  const anonymous = await stream(`/api/events?after=${before}`, 2, () => {
    quorum.postMessage({ room: 'protocol', participantId: dana.id, body: 'public, sent after the DM' });
  });
  assert.ok(!anonymous.some((f) => f.data.kind === 'dm_message'), 'no dm_message frame without ?as=');
  assert.ok(!JSON.stringify(anonymous).includes('deploy key'), 'no DM content either');

  // The same replay as the counterpart carries it — this is the DM screen's
  // live half.
  const scoped = await stream(`/api/events?after=${before}&as=${codex.id}`, 2);
  const dm = scoped.find((f) => f.data.kind === 'dm_message');
  assert.ok(dm, 'the counterpart stream delivers the DM');
  assert.equal(dm.data.payload.message.body, 'rotate the deploy key tonight');

  // A third party asking as themselves gets the shared feed, not the pair's.
  const mallory = quorum.identify({ name: 'mallory-web', harness: 'human' }).participant;
  const bystander = await stream(`/api/events?after=${before}&as=${mallory.id}`, 2);
  assert.ok(!JSON.stringify(bystander).includes('deploy key'), 'naming yourself widens nothing that is not yours');

  // First paint: the inbox and the thread, seq-stamped like every read.
  const inbox = await get(`/api/dms?as=${codex.id}`);
  assert.equal(inbox.status, 200);
  assert.equal(typeof inbox.body.seq, 'number');
  assert.equal(inbox.body.threads.length, 1);
  assert.equal(inbox.body.threads[0].counterpart.name, 'Dana');

  const thread = await get(`/api/dms?as=${codex.id}&with=${dana.id}`);
  assert.deepEqual(
    thread.body.messages.map((m: any) => m.body),
    ['rotate the deploy key tonight'],
  );

  // A third party reading "their thread with Dana" reads exactly that — an
  // empty conversation of their own, never the pair's.
  const other = await get(`/api/dms?as=${mallory.id}&with=${dana.id}`);
  assert.deepEqual(other.body.messages, []);

  // The human write path sends through the same domain call the tool uses.
  const reply = await fetch(`${origin}/api/dms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ participantId: codex.id, to: dana.id, body: 'done — key rotated' }),
  });
  assert.equal(reply.status, 200);
  const echoed = await get(`/api/dms?as=${dana.id}&with=${codex.id}`);
  assert.deepEqual(
    echoed.body.messages.map((m: any) => m.body),
    ['rotate the deploy key tonight', 'done — key rotated'],
  );
});

test('an explicit after=0 on the DM route reads forward from the beginning, not the tail', async () => {
  quorum.identify({ name: 'walker', harness: 'human' });
  const walker = quorum.listParticipants().find((p) => p.name === 'walker')!;
  for (let i = 1; i <= 4; i += 1) {
    quorum.sendDm({ participantId: walker.id, to: codex.id, body: `walk ${i}` });
  }

  // Presence decides the path: after=0 is a cursor, and a client that
  // initializes at zero must get the head of the thread, not skip it.
  const fromZero = await get(`/api/dms?as=${walker.id}&with=${codex.id}&after=0&limit=2`);
  assert.deepEqual(
    fromZero.body.messages.map((m: any) => m.body),
    ['walk 1', 'walk 2'],
  );

  // No parameter is still the first paint, which wants the tail.
  const tail = await get(`/api/dms?as=${walker.id}&with=${codex.id}&limit=2`);
  assert.deepEqual(
    tail.body.messages.map((m: any) => m.body),
    ['walk 3', 'walk 4'],
  );
});

test('a page opened mid-deliberation gets it in the first paint — options and turnout, never a ballot (#35)', async () => {
  const deliberating = quorum.createRoom({ name: 'mid-vote', by: dana.id });
  quorum.joinRoom({ room: 'mid-vote', participantId: codex.id });
  const deliberation = quorum.propose({
    participantId: dana.id,
    room: deliberating.id,
    question: 'ship the alpha?',
    options: ['now', 'after the beta'],
  });
  quorum.closeChallenges({ participantId: dana.id, deliberationId: deliberation.id });
  quorum.vote({ participantId: codex.id, deliberationId: deliberation.id, choice: 0, dissent: 'noted' });

  // The page loads *now*, mid-vote. Before this route, its fold started empty
  // and the open deliberation was invisible until the next event on it.
  const painted = await get('/api/rooms/mid-vote/deliberations');
  assert.equal(painted.status, 200);
  assert.equal(typeof painted.body.seq, 'number', 'stamped before the read, like every other paint');
  assert.ok(painted.body.seq <= quorum.latestSeq());

  const open = painted.body.deliberations;
  assert.equal(open.length, 1);
  assert.equal(open[0].id, deliberation.id);
  assert.equal(open[0].phase, 'voting');
  assert.deepEqual(open[0].options, ['now', 'after the beta'], 'the ballot is castable from the paint alone');
  assert.deepEqual(open[0].cast, [codex.id], 'turnout says who has cast (D6), never what');
  const raw = JSON.stringify(painted.body);
  assert.ok(!raw.includes('"choice"'), 'no choice leaks through the paint');
  assert.ok(!raw.includes('noted'), 'no dissent either');
});

test('the convener closes challenges over the wire; anyone else is refused in the protocol\'s words (#20)', async () => {
  const room = quorum.createRoom({ name: 'overlay-room', by: dana.id });
  quorum.joinRoom({ room: room.id, participantId: codex.id });
  const deliberation = quorum.propose({
    participantId: dana.id,
    room: room.id,
    question: 'close the window from the overlay?',
    options: ['yes', 'no'],
  });

  const refused = await fetch(`${origin}/api/deliberations/${deliberation.id}/close-challenges`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ participantId: codex.id }),
  });
  assert.equal(refused.status, 409);
  assert.match(((await refused.json()) as any).error, /only the convener/);

  const closed = await fetch(`${origin}/api/deliberations/${deliberation.id}/close-challenges`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ participantId: dana.id }),
  });
  assert.equal(closed.status, 200);
  const { deliberation: after } = (await closed.json()) as any;
  assert.equal(after.phase, 'voting');
});

test('the UI front door is the room view, not the parts catalogue (#48)', async () => {
  const response = await fetch(`${origin}/ui/`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/ui/kit/room.html');
});
