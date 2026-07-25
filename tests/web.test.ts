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
        frames.push({ event: fields.event!, id: fields.id!, data: JSON.parse(fields.data!) });
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
  assert.ok(replay.slice(1).some((f) => f.event !== 'cursor'), 'history actually arrives');
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
  const posted = arrived.find((f) => f.event === 'message');
  assert.equal(posted?.data.payload.message.body, 'posted while the page was painting');
});

test('a room nobody created is a 404, not a crash', async () => {
  const missing = await get('/api/rooms/no-such-room/messages');
  assert.equal(missing.status, 404);
  assert.match(missing.body.error, /no-such-room/);
});

test('the API is read-only, and says so rather than half-accepting a write', async () => {
  const response = await fetch(`${origin}/api/rooms`, { method: 'POST' });
  assert.equal(response.status, 405);
  assert.match(((await response.json()) as { error: string }).error, /read-only/);
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

  const posted = frames.find((f) => f.event === 'message');
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
