// The human's event stream — server-sent events over the same bus the agents
// long-poll (architecture §1: one domain core, two transports).
//
// There is no new machinery here, and that is the point. `waitForEvents` is
// already a cursor long-poll that blocks until something happens and wakes on
// a lease expiry without a timer thread; an SSE stream is that call in a loop
// with a `write` instead of a `return`. A browser and an agent are reading the
// same feed, in the same order, by the same seq — so a human and an agent
// disagreeing about what happened is not a state this design can reach.
//
// SSE's own reconnect does the resume for free. Each frame carries `id: <seq>`,
// so when the connection drops the browser reconnects with `Last-Event-ID` and
// we start after exactly that seq. The cursor a reconnecting agent keeps in
// `identify` is the same idea; here the platform keeps it.
//
// An observer is not a participant. The stream passes `participantId: null`,
// so watching a room advances nobody's durable cursor — a human reading over
// someone's shoulder must not mark their messages as delivered.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Quorum } from '../domain/quorum.ts';

export const EVENTS_PATH = '/api/events';

// The domain's wait is not interruptible: once inside `waitForEvents`, we are
// there until it returns. So the stream asks for short slices and loops.
//
// This is not polling — a slice returns the instant an event is appended,
// because the domain wakes its waiters directly. The slice is only a ceiling
// on how long a shutdown, or a client that has gone away, has to wait for this
// loop to notice. A 25-second slice meant `server.close()` hung for 25
// seconds, which is the kind of thing you discover as "why is the test suite
// suddenly slow" rather than as a bug.
const SLICE_MS = 1_000;

/** Idle time before a comment frame proves the socket is still there. */
const KEEPALIVE_MS = 25_000;

/* Live streams, so shutdown can end them. Without this, `close()` waits on a
   response that will never finish on its own — a browser sitting on the page
   would keep the process up indefinitely. */
const LIVE = new Set<ServerResponse>();

/** End every open stream. Called by the server on the way down. */
export function closeEventStreams(): void {
  for (const res of LIVE) res.end();
  LIVE.clear();
}

function frame(id: number, event: string, data: unknown): string {
  // `data:` must not contain a raw newline, and JSON.stringify never emits one.
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A seq from a header or query value, or null when it is absent or not a number. */
function seqFrom(value: string | string[] | undefined | null): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : null;
}

/**
 * Stream events after a cursor. Returns false when the request is not ours.
 *
 * The cursor comes from `Last-Event-ID` when the browser is reconnecting, and
 * from `?after=` otherwise. The header wins: the browser knows what it
 * actually received, and the query string is only what the page asked for when
 * it first opened.
 *
 * With neither, the stream tails from the current head. A page that wants no
 * gap between its first paint and its stream passes the `seq` its read
 * returned — every `/api/` response carries one, stamped before the read, so
 * an event that lands in between is delivered twice rather than not at all.
 * That is the same call the domain's durable cursor makes: replay is the side
 * to err on, because a duplicate is visible and a gap is not.
 */
export function serveEvents(req: IncomingMessage, res: ServerResponse, url: URL, quorum: Quorum): boolean {
  if (url.pathname !== EVENTS_PATH) return false;

  if (req.method !== 'GET') {
    res.writeHead(405, { 'content-type': 'application/json', allow: 'GET' });
    res.end(JSON.stringify({ error: 'the event stream is read-only' }));
    return true;
  }

  // `Number(null)` is 0 and passes `Number.isFinite`, so parsing before
  // checking presence would make every fresh stream replay all of history and
  // leave the head fallback below as dead code. Absent and zero are different
  // answers; `?after=0` means "everything", no parameter means "from now".
  const start = seqFrom(req.headers['last-event-id']) ?? seqFrom(url.searchParams.get('after')) ?? quorum.latestSeq();

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // No buffering proxy exists on loopback, but say it anyway: a stream that
    // is silently buffered looks exactly like a stream with nothing to say.
    'x-accel-buffering': 'no',
  });

  let cursor = Math.max(0, Math.trunc(start));
  let open = true;
  const stop = () => {
    open = false;
    LIVE.delete(res);
  };
  LIVE.add(res);
  req.on('close', stop);
  res.on('close', stop);

  // The first frame states where the reader is, so a page that opened mid-
  // history knows what it has not seen rather than guessing from an empty
  // stream.
  res.write(frame(cursor, 'cursor', { after: cursor, latest: quorum.latestSeq() }));

  void (async () => {
    let idleMs = 0;
    while (open) {
      let batch;
      try {
        batch = await quorum.waitForEvents({ afterSeq: cursor, timeoutMs: SLICE_MS, participantId: null });
      } catch (error) {
        if (!open) return;
        res.write(frame(cursor, 'stream_error', { error: error instanceof Error ? error.message : String(error) }));
        break;
      }
      if (!open) return;

      if (batch.length === 0) {
        idleMs += SLICE_MS;
        if (idleMs >= KEEPALIVE_MS) {
          // A comment frame, not an event: it keeps the socket alive without
          // teaching the page that something happened.
          res.write(': keep-alive\n\n');
          idleMs = 0;
        }
        continue;
      }

      idleMs = 0;
      for (const event of batch) {
        cursor = event.seq;
        res.write(frame(event.seq, event.kind, event));
      }
    }
    stop();
    res.end();
  })();

  return true;
}
