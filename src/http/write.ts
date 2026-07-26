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
// ## Why a localhost server needs to care about the origin
//
// This process listens on 127.0.0.1 with no auth, which is fine while it only
// reads. The moment it writes, every page the human visits can reach it: a
// script on any site can `fetch('http://127.0.0.1:4242/api/…', {method:'POST'})`
// and post messages, cast ballots, or convene deliberations in their name. The
// response is opaque to the attacker, but the write has already happened, and
// this transport's whole product is a record of who said what.
//
// Two checks close it, and both are needed:
//
//   * **Origin.** Browsers always send it on a POST and a page cannot forge
//     it. An origin that is present and not ours is refused. Absent means a
//     non-browser client (curl, the tests), which is not the threat.
//   * **Content type.** `application/json` is not a "simple request", so a
//     cross-origin attempt is preflighted — and we answer no preflight, so it
//     never happens. Without this check an attacker drops to `text/plain`,
//     which *is* simple, and skips the preflight entirely.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { QuorumError } from '../domain/errors.ts';
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

/**
 * Whether this request may write.
 *
 * Returns the refusal to send, or null when it is allowed. Stated as data so
 * the reason reaches the caller instead of becoming a bare 403.
 */
export function refuseWrite(req: IncomingMessage): string | null {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    const host = req.headers.host;
    // Compare the whole origin, not a suffix: `http://127.0.0.1:4242.evil.com`
    // ends with our host and is not us.
    if (!host || (origin !== `http://${host}` && origin !== `https://${host}`)) {
      return 'cross-origin writes are refused; open the UI this server serves';
    }
  }

  const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') {
    return 'writes must be application/json';
  }
  return null;
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
        room: decodeURIComponent(join[1]!),
        participantId: str(body, 'participantId'),
      }),
    };
  }

  const post = /^rooms\/([^/]+)\/messages$/.exec(route);
  if (post) {
    return {
      message: quorum.postMessage({
        room: decodeURIComponent(post[1]!),
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
        room: decodeURIComponent(propose[1]!),
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
      deliberationId: decodeURIComponent(vote[1]!),
      participantId: str(body, 'participantId'),
      choice,
      dissent: typeof body.dissent === 'string' ? body.dissent : undefined,
    });
  }

  return null;
}
