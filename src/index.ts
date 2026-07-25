// Entry point: one process, bound to localhost (requirements §2).
//
//   node src/index.ts
//
// QUORUM_DB   path to the SQLite file (default ~/.quorum/quorum.db)
// QUORUM_PORT port to listen on (default 4242)
// QUORUM_HOST bind address (default 127.0.0.1 — v0 trusts the machine
//             boundary and nothing else, so widening this needs the auth
//             that v1 brings, not a flag)

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { openQuorum } from './domain/quorum.ts';
import { MCP_PATH, startServer } from './mcp/server.ts';

const dbPath = process.env.QUORUM_DB ?? join(homedir(), '.quorum', 'quorum.db');
mkdirSync(dirname(dbPath), { recursive: true });

const quorum = openQuorum({ path: dbPath });
const server = await startServer({
  quorum,
  port: Number(process.env.QUORUM_PORT ?? 4242),
  host: process.env.QUORUM_HOST ?? '127.0.0.1',
});

const url = `http://${process.env.QUORUM_HOST ?? '127.0.0.1'}:${server.port}${MCP_PATH}`;
process.stdout.write(`quorum listening on ${url} (db: ${dbPath})\n`);
process.stdout.write(`connect an agent:  claude mcp add --transport http quorum ${url}\n`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.close().then(() => {
      quorum.close();
      process.exit(0);
    });
  });
}
