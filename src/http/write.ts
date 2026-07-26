// The human write API — the half of the transport that makes a participant.
//
// Everything under `/api/` that is not a GET lands here, and nothing else in
// this process mutates on behalf of a browser. Keeping it in one file is the
// point: the read path stays provably read-only, and the whole surface an
// attacker can reach is one screenful.
//
// Writes go through the same domain operations the MCP tools call — no second
// write path, so a human and an agent are held to the same protocol. A human
// who posts without joining is refused in exactly the words an agent gets.
//
// The browser guard that lets any of this be safe lives beside it, in
// origin.ts — the reasoning is long enough to deserve reading on its own.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { QuorumError } from '../domain/errors.ts';
import { refuseWrite } from './origin.ts';
import type { Quorum } from '../domain/quorum.ts';

const API_PREFIX = '/api/';

/** A message body is prose, not an upload. Enough for a long argument, not a payload. */
const MAX_BODY_BYTES = 64 * 1024;

/** The harness a browser participant identifies under. Humans are first-class (§1.2). */
const HUMAN = 'human';

function send(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body, null, 2));
}

/** Read a JSON body, bounded. Rejects rather than buffering whatever arrives. */
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new QuorumError('request body is too large');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new QuorumError('request body must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof QuorumError) throw error;
    throw new QuorumError('request body is not valid JSON');
  }
}

/**
 * Decode a path segment, refusing a malformed escape instead of throwing.
 *
 * `decodeURIComponent` throws `URIError` on something like `/api/rooms/%/join`.
 * That is not a domain error, so it escaped the handler here and surfaced as a
 * 500 carrying an internal message — a bad request answered as a server fault.
 */
function segment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new QuorumError('that path is not a valid name');
  }
}

function str(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new QuorumError(`${key} is required`);
  }
  return value;
}

/**
 * Route a write. Returns false for a GET so the read API keeps it.
 *
 * Async because a body has to be read; the caller does not await the boolean,
 * it awaits the promise and stops if it resolves true.
 */
export async function serveWrites(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  quorum: Quorum,
): Promise<boolean> {
  if (!url.pathname.startsWith(API_PREFIX)) return false;
  if (req.method === 'GET' || req.method === 'HEAD') return false;

  if (req.method !== 'POST') {
    send(res, 405, { error: `${req.method} is not a method this API answers` });
    return true;
  }

  const refusal = refuseWrite(req);
  if (refusal) {
    send(res, 403, { error: refusal });
    return true;
  }

  const route = url.pathname.slice(API_PREFIX.length);

  try {
    const body = await readJson(req);
    const result = dispatch(route, body, quorum);
    if (!result) {
      send(res, 404, { error: `no such route: ${route}` });
      return true;
    }
    // Stamped after the write, so a page that reloads from this seq sees its
    // own message. The read path stamps *before* for the opposite reason.
    send(res, 200, { seq: quorum.latestSeq(), ...result });
    return true;
  } catch (error) {
    // Every domain refusal is the protocol saying no, and its message is
    // server-authored and actionable — "join #protocol before posting to it",
    // not "400". One status for all of them beats sorting them by guessing at
    // the prose; the body is the part a caller acts on.
    if (error instanceof QuorumError) {
      send(res, 409, { error: error.message });
      return true;
    }
    throw error;
  }
}

/** The routes themselves. Returns null when nothing matched. */
function dispatch(
  route: string,
  body: Record<string, unknown>,
  quorum: Quorum,
): Record<string, unknown> | null {
  // A browser names itself once and keeps the id. `identify` is idempotent on
  // (name, harness), so a reload rejoins the same participant rather than
  // minting a second one with the same name.
  if (route === 'identify') {
    const { participant } = quorum.identify({ name: str(body, 'name'), harness: HUMAN });
    return { participant };
  }

  const join = /^rooms\/([^/]+)\/join$/.exec(route);
  if (join) {
    return {
      room: quorum.joinRoom({
        room: segment(join[1]!),
        participantId: str(body, 'participantId'),
      }),
    };
  }

  const post = /^rooms\/([^/]+)\/messages$/.exec(route);
  if (post) {
    return {
      message: quorum.postMessage({
        room: segment(post[1]!),
        participantId: str(body, 'participantId'),
        body: str(body, 'body'),
        deliberationId: typeof body.deliberationId === 'string' ? body.deliberationId : undefined,
      }),
    };
  }

  const propose = /^rooms\/([^/]+)\/deliberations$/.exec(route);
  if (propose) {
    const options = body.options;
    if (!Array.isArray(options) || !options.every((o) => typeof o === 'string')) {
      throw new QuorumError('options must be an array of strings');
    }
    return {
      deliberation: quorum.propose({
        room: segment(propose[1]!),
        participantId: str(body, 'participantId'),
        question: str(body, 'question'),
        options: options as string[],
      }),
    };
  }

  const vote = /^deliberations\/([^/]+)\/vote$/.exec(route);
  if (vote) {
    const choice = body.choice;
    if (typeof choice !== 'number' || !Number.isInteger(choice)) {
      throw new QuorumError('choice is the option index, as an integer');
    }
    return quorum.vote({
      deliberationId: segment(vote[1]!),
      participantId: str(body, 'participantId'),
      choice,
      dissent: typeof body.dissent === 'string' ? body.dissent : undefined,
    });
  }

  return null;
}
