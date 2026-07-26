// The human read API.
//
// Deliberately small and deliberately read-only in this pass. The screens need
// a first paint before the event stream can keep them current — everything
// after that arrives on `/api/events`, which is why there is no polling
// endpoint here and must never be one. A refresh button is the failure mode
// this whole design exists to avoid (requirements §1.3).
//
// Every route reads through the same domain the MCP tools call. There is no
// second query path, so a human and an agent cannot be shown different
// answers to the same question — the layering rule in AGENTS.md, applied to
// the transport that came second.
//
// Every response carries `seq`, the feed position **before** the read ran. A
// page opens its stream at that seq and has no gap between first paint and
// live: an event that lands between the stamp and the read is delivered
// twice, never zero times. Stamping after the read would close the duplicate
// and open the gap, which is the worse trade — a duplicate is visible and a
// gap is not. The domain's durable cursor makes the same call for the same
// reason.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { QuorumError } from '../domain/errors.ts';
import type { Quorum } from '../domain/quorum.ts';

export const API_PREFIX = '/api/';

function send(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

function positiveInt(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

/**
 * The most recent `limit` messages, not the oldest.
 *
 * The domain reads forward from an id, so asking it once for 100 in a room
 * with 300 gives you messages 1–100 — and the stream then tails from the head,
 * so 101–300 are never painted and never replayed. A permanent, silent hole in
 * the middle of the room, which is the worst shape a bug can have here.
 *
 * Paging forward to the tail is O(messages) and honest. The efficient fix is a
 * tail query in the domain, which is another lane's file (docs/deliberation.md
 * §8 seams); a claim is a coordination signal, so this stays on our side of it
 * and the cost is a note rather than a reach across.
 */
function recentMessages(quorum: Quorum, room: string, limit: number): unknown[] {
  const page = Math.max(limit, 200);
  let all: any[] = [];
  for (;;) {
    const batch = quorum.readMessages({ room, afterId: all.at(-1)?.id, limit: page });
    if (batch.length === 0) break;
    all = all.concat(batch);
    if (batch.length < page) break;
  }
  return all.slice(-limit);
}

/**
 * Handle a read request. Returns false when the path is not ours, so the
 * caller keeps ownership of what a 404 means.
 */
export function serveApi(req: IncomingMessage, res: ServerResponse, url: URL, quorum: Quorum): boolean {
  if (!url.pathname.startsWith(API_PREFIX)) return false;

  if (req.method !== 'GET') {
    // Unreachable in the server, which routes every non-GET to write.ts before
    // this. Kept because it is what makes "this file only reads" true of the
    // file rather than of the wiring around it.
    send(res, 405, { error: 'this route reads only; writes are POSTs handled elsewhere' });
    return true;
  }

  const route = url.pathname.slice(API_PREFIX.length);

  // Before the read, deliberately. See the note at the top of this file.
  const seq = quorum.latestSeq();

  try {
    if (route === 'rooms') {
      send(res, 200, { seq, rooms: quorum.listRooms() });
      return true;
    }

    if (route === 'participants') {
      send(res, 200, { seq, participants: quorum.listParticipants() });
      return true;
    }

    if (route === 'claims') {
      const repo = url.searchParams.get('repo') ?? undefined;
      send(res, 200, { seq, claims: quorum.listClaims({ repo }) });
      return true;
    }

    if (route === 'decisions') {
      send(res, 200, { seq, decisions: quorum.listDecisions({ room: url.searchParams.get('room') ?? undefined }) });
      return true;
    }

    const messages = /^rooms\/([^/]+)\/messages$/.exec(route);
    if (messages) {
      const room = decodeURIComponent(messages[1]!);
      // With `after`, the caller is walking forward and knows where it is.
      // Without it, this is a first paint and wants the end of the room.
      const after = positiveInt(url.searchParams.get('after'), 0) || undefined;
      const limit = positiveInt(url.searchParams.get('limit'), 100);
      send(res, 200, {
        seq,
        room,
        messages: after
          ? quorum.readMessages({ room, afterId: after, limit })
          : recentMessages(quorum, room, limit),
      });
      return true;
    }

    send(res, 404, { error: `no such route: ${route}` });
    return true;
  } catch (error) {
    // A domain error is the caller asking for something that does not exist —
    // a room name nobody created. It is a 404-shaped answer, not a crash, and
    // the message is server-authored so it is safe to return as it stands.
    if (error instanceof QuorumError) {
      send(res, 404, { error: error.message });
      return true;
    }
    throw error;
  }
}
