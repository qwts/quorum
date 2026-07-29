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
import { serveApi } from '../http/api.ts';
import { serveWrites } from '../http/write.ts';
import { refuseOrigin } from '../http/origin.ts';
import { loadTls, type TlsMaterial } from '../http/tls.ts';
import { closeEventStreams, serveEvents } from '../http/events.ts';
import { serveUi } from '../ui/serve.ts';
import { PARTICIPANT_CONTRACT } from './contract.ts';
import { callTool, TOOLS, type Session } from './tools.ts';

export const MCP_PATH = '/mcp';

function mcpServerFor(quorum: Quorum): Server {
  const session: Session = { participantId: null, cursor: 0 };
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
      const { guidance, data } = await callTool(quorum, session, request.params.name, args);
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

export async function startServer(options: {
  quorum: Quorum;
  port?: number;
  host?: string;
  /** TLS material, or undefined to read it from the environment. Null forces plain HTTP. */
  tls?: TlsMaterial | null;
}): Promise<QuorumHttpServer> {
  const transports = new Map<string, StreamableHTTPServerTransport>();

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

    // A tool call is a write wearing JSON-RPC — post_message, vote, and the
    // rest all land here — so the same Host/Origin allowlist that guards
    // /api/ guards this endpoint too (#32). Checked before the session even
    // exists, so a rebound hostname cannot open one in the first place.
    const originRefusal = refuseOrigin(req);
    if (originRefusal) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: originRefusal }));
      return;
    }

    const sessionId = req.headers['mcp-session-id'];
    const existing = typeof sessionId === 'string' ? transports.get(sessionId) : undefined;
    if (existing) {
      await existing.handleRequest(req, res);
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unknown or missing session' }));
      return;
    }

    // A POST with no session is an initialize: stand up a transport and a
    // Server for this agent, and let the SDK negotiate.
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string): void => {
        transports.set(id, transport);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) transports.delete(transport.sessionId);
    };
    await mcpServerFor(options.quorum).connect(transport);
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
