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

import type { IncomingMessage, ServerResponse } from 'node:http';
import { QuorumError } from '../domain/errors.ts';
import type { Quorum } from '../domain/quorum.ts';

export const API_PREFIX = '/api/';

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

function positiveInt(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

/**
 * Handle a read request. Returns false when the path is not ours, so the
 * caller keeps ownership of what a 404 means.
 */
export function serveApi(req: IncomingMessage, res: ServerResponse, url: URL, quorum: Quorum): boolean {
  if (!url.pathname.startsWith(API_PREFIX)) return false;

  if (req.method !== 'GET') {
    // Writes are a separate question — a human posting is a domain concern
    // (do they become a participant? with what identity?) before it is an
    // HTTP one, so this pass refuses rather than guesses.
    send(res, 405, { error: 'the web API is read-only in this pass; agents write through MCP' });
    return true;
  }

  const route = url.pathname.slice(API_PREFIX.length);

  try {
    if (route === 'rooms') {
      send(res, 200, { rooms: quorum.listRooms() });
      return true;
    }

    if (route === 'participants') {
      send(res, 200, { participants: quorum.listParticipants() });
      return true;
    }

    if (route === 'claims') {
      const repo = url.searchParams.get('repo') ?? undefined;
      send(res, 200, { claims: quorum.listClaims({ repo }) });
      return true;
    }

    if (route === 'decisions') {
      send(res, 200, { decisions: quorum.listDecisions({ room: url.searchParams.get('room') ?? undefined }) });
      return true;
    }

    const messages = /^rooms\/([^/]+)\/messages$/.exec(route);
    if (messages) {
      const room = decodeURIComponent(messages[1]!);
      send(res, 200, {
        room,
        messages: quorum.readMessages({
          room,
          afterId: positiveInt(url.searchParams.get('after'), 0) || undefined,
          limit: positiveInt(url.searchParams.get('limit'), 100),
        }),
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
