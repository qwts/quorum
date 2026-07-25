// MCP endpoint: streamable HTTP, one session per connected agent.
//
// Each session gets its own Server instance closing over its own identity, so
// "who is calling" is structural rather than a lookup table that could go
// stale. The HTTP layer here is node:http — no framework, one dependency.

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Quorum } from '../domain/quorum.ts';
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
}): Promise<QuorumHttpServer> {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sessions: transports.size }));
      return;
    }

    if (url.pathname !== MCP_PATH) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
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
      for (const transport of transports.values()) await transport.close();
      transports.clear();
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
