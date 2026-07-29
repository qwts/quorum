// MCP endpoint: streamable HTTP, one session per connected agent.
//
// Each session gets its own Server instance closing over its own identity, so
// "who is calling" is structural rather than a lookup table that could go
// stale. The HTTP layer here is node:http — no framework, one dependency.

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Quorum } from '../domain/quorum.ts';
import { actingSession } from '../domain/session.ts';
import { serveApi } from '../http/api.ts';
import { authRequired, authorize, type Caller } from '../http/auth.ts';
import { serveWrites } from '../http/write.ts';
import { loadTls, type TlsMaterial } from '../http/tls.ts';
import { closeEventStreams, serveEvents } from '../http/events.ts';
import { serveUi } from '../ui/serve.ts';
import { PARTICIPANT_CONTRACT } from './contract.ts';
import { callTool, TOOLS, type Session } from './tools.ts';

export const MCP_PATH = '/mcp';

/** What a session record says it was opened through (ADR-0001 §4.1). */
const MCP_SOURCE = 'mcp';

function mcpServerFor(quorum: Quorum, caller: Caller | null): Server {
  // The credential names the principal; `identify` still names the
  // participant, because a name on the roster is a thing an agent introduces
  // itself with. What changes under auth is that the introduction is bound to
  // the identity that authenticated instead of taken on trust.
  const session: Session = {
    participantId: null,
    cursor: 0,
    principalId: caller?.principalId ?? null,
    identitySession: caller?.sessionId ?? null,
  };
  const server = new Server(
    { name: 'quorum', version: '0.0.0' },
    // Delivered in the initialize result, so every client — any harness —
    // has the contract before it can call a single tool (#8).
    { capabilities: { tools: {} }, instructions: PARTICIPANT_CONTRACT },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      // Everything this call writes is attributed to the session the
      // credential opened (ADR-0001 §4.1) — the domain reads it from the
      // call's own async context rather than from an argument every operation
      // would have to pass along.
      const { guidance, data } = await actingSession(session.identitySession, () =>
        callTool(quorum, session, request.params.name, args),
      );
      return {
        // Guidance first, then the values it refers to. The reply is the
        // agent's program loop (#8): it always names the next call, and the
        // data below it is plainly data.
        content: [{ type: 'text' as const, text: `${guidance}\n\n${JSON.stringify(data, null, 2)}` }],
        structuredContent: { ...data, guidance },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        // Same shape as success: server-authored guidance, then data. An error
        // message can carry participant text (a room name, a purpose), so it
        // is a JSON *value* below the guidance rather than a line above it —
        // JSON escaping means a crafted name cannot break out and pose as the
        // next instruction.
        content: [
          {
            type: 'text' as const,
            text:
              'That call failed; the error is below as data. Fix the call and try again' +
              (session.participantId === null
                ? ' — start with identify, which every other tool needs.'
                : ' — if you are stuck, say so in a room with post_message rather than working around it.') +
              '\n\n' +
              JSON.stringify({ error: message }, null, 2),
          },
        ],
        structuredContent: { error: message },
        isError: true,
      };
    }
  });

  return server;
}

export type QuorumHttpServer = {
  http: HttpServer;
  port: number;
  close: () => Promise<void>;
};

/**
 * A missing or bad credential, answered in words.
 *
 * 401 with the standard challenge, so a spec-conformant client knows what kind
 * of failure this is — and so Phase 2 has somewhere to hang RFC 9728 discovery
 * metadata. The body is the part a human acts on, and it never repeats the
 * token that was presented.
 */
function refuseCredential(res: ServerResponse, refusal: string): void {
  res.writeHead(401, {
    'content-type': 'application/json',
    'www-authenticate': 'Bearer realm="quorum"',
  });
  res.end(JSON.stringify({ error: refusal }));
}

export async function startServer(options: {
  quorum: Quorum;
  port?: number;
  host?: string;
  /** TLS material, or undefined to read it from the environment. Null forces plain HTTP. */
  tls?: TlsMaterial | null;
}): Promise<QuorumHttpServer> {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  // Which credential opened each MCP session. The `mcp-session-id` header is
  // credential material, never a credential (design §4.1): it continues a
  // session, and every message on it is re-checked against the grant that
  // opened it, so quoting somebody else's session id buys nothing.
  const callers = new Map<string, Caller>();

  const onRequest = (req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch((error: unknown) => {
      // The last resort, reached only by a bug: every *expected* refusal is
      // answered in words by the handler that recognised it.
      //
      // So whatever lands here is internal — a message naming a file path, a
      // SQL fragment, or a stack. Returning it tells a caller about the inside
      // of this process in exchange for nothing, since a caller cannot act on
      // a bug anyway. It goes to the operator's log, where someone can, and
      // the response says only that it happened.
      process.stderr.write(`quorum: unhandled request error — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'the server failed to handle that request; see the server log' }));
    });
  };

  // TLS is for reaching this server by a hostname; loopback is already a
  // secure context without it. Configured or not, the request path is the same.
  const tls = options.tls === undefined ? loadTls() : options.tls;
  const http = tls ? createSecureServer(tls, onRequest) : createServer(onRequest);

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sessions: transports.size }));
      return;
    }

    // One process, two surfaces (architecture §1): the agent endpoint and the
    // human UI. The UI is static files with no build step, so serving it costs
    // this much.
    if (await serveUi(req, res, url.pathname)) return;

    // The human transport, over the same domain and the same event feed the
    // agents read. The stream comes first: it holds the connection open, so
    // it must never fall through to a handler that would answer it.
    if (serveEvents(req, res, url, options.quorum)) return;
    // Writes first: it owns every non-GET under /api/, so the read API below
    // only ever sees a GET and stays read-only by construction.
    if (await serveWrites(req, res, url, options.quorum)) return;
    if (serveApi(req, res, url, options.quorum)) return;

    if (url.pathname !== MCP_PATH) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    const sessionId = req.headers['mcp-session-id'];
    const existing = typeof sessionId === 'string' ? transports.get(sessionId) : undefined;
    if (existing) {
      if (authRequired()) {
        // Re-validated on every message rather than once at connect: a
        // revocation has to end access mid-session, and a session that was
        // superseded cannot still be spoken through.
        const bound = typeof sessionId === 'string' ? callers.get(sessionId) : undefined;
        const check = bound
          ? authorize(req, options.quorum, { source: MCP_SOURCE, resume: bound })
          : { refusal: 'that session was not opened with a credential' };
        if ('refusal' in check) return refuseCredential(res, check.refusal);
      }
      await existing.handleRequest(req, res);
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unknown or missing session' }));
      return;
    }

    // A POST with no session is an initialize: the moment a credential buys a
    // session node (ADR-0001 §4.1), and the moment the one-live-session rule
    // decides whether this agent may open one at all (§4.2).
    let caller: Caller | null = null;
    if (authRequired()) {
      const check = authorize(req, options.quorum, { source: MCP_SOURCE, establish: true });
      if ('refusal' in check) return refuseCredential(res, check.refusal);
      caller = check.caller;
    }

    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string): void => {
        transports.set(id, transport);
        if (caller) callers.set(id, caller);
      },
    });
    transport.onclose = () => {
      if (!transport.sessionId) return;
      transports.delete(transport.sessionId);
      const bound = callers.get(transport.sessionId);
      callers.delete(transport.sessionId);
      // A clean disconnect frees the grant immediately, so an agent whose
      // harness restarted can open its next session without waiting out the
      // grace window.
      if (bound) options.quorum.identity.endSession(bound.sessionId);
    };
    await mcpServerFor(options.quorum, caller).connect(transport);
    await transport.handleRequest(req, res);
  }

  const host = options.host ?? '127.0.0.1';
  await new Promise<void>((resolve) => http.listen(options.port ?? 0, host, resolve));
  const address = http.address();
  const port = typeof address === 'object' && address !== null ? address.port : (options.port ?? 0);

  return {
    http,
    port,
    async close(): Promise<void> {
      // Streams first: an open SSE response never ends on its own, so
      // http.close() would wait on it forever.
      closeEventStreams();
      for (const transport of transports.values()) await transport.close();
      transports.clear();
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
