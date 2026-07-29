// Focused over-the-wire proof for issue #15. The larger MCP catalogue is
// already at its intentional ceiling; this outcome owns a separate test
// because its contract spans both the private reply and the shared feed.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { openQuorum } from '../src/domain/quorum.ts';
import { MCP_PATH, startServer } from '../src/mcp/server.ts';

type ToolResult = { structuredContent?: Record<string, unknown>; content?: unknown };

test('a refusal keeps its caller reply and appears once on the shared feed', async () => {
  const quorum = openQuorum();
  const server = await startServer({ quorum });
  const url = new URL(`http://127.0.0.1:${server.port}${MCP_PATH}`);
  const clients: Client[] = [];

  const connect = async () => {
    const client = new Client({ name: 'claim-refused-test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    clients.push(client);
    return client;
  };
  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as ToolResult;

  try {
    const holder = await connect();
    const blocked = await connect();
    await call(holder, 'identify', { name: 'holder', harness: 'test' });
    const identified = await call(blocked, 'identify', { name: 'blocked', harness: 'test' });
    const blockedId = (identified.structuredContent?.participant as { id: string }).id;

    const granted = await call(holder, 'claim_scope', {
      repo: 'quorum',
      patterns: ['src/domain/**'],
      purpose: 'the domain',
    });
    const claimId = (granted.structuredContent?.claim as { id: string }).id;
    const refused = await call(blocked, 'claim_scope', {
      repo: 'quorum',
      patterns: ['src/**/*.ts'],
      purpose: 'a refactor',
    });

    assert.equal(refused.structuredContent?.granted, false, 'the private reply shape is unchanged');
    assert.match(String(refused.structuredContent?.guidance), /Refused.*Do not route around it/);

    const holderFeed = await call(holder, 'wait_for_events', { after_seq: 0, timeout_ms: 0 });
    const events = holderFeed.structuredContent?.events as {
      kind: string;
      actorId: string | null;
      by_you: boolean;
      payload: Record<string, unknown>;
    }[];
    const visible = events.filter((event) => event.kind === 'claim_refused');
    assert.equal(visible.length, 1, 'one refused attempt produces one shared event');
    assert.equal(visible[0]?.actorId, blockedId);
    assert.equal(visible[0]?.by_you, false, 'the holder sees another participant was blocked');
    assert.deepEqual(visible[0]?.payload, {
      scope: { repo: 'quorum', branch: null, patterns: ['src/**/*.ts'] },
      conflictingClaimIds: [claimId],
    });
  } finally {
    for (const client of clients) await client.close();
    await server.close();
    quorum.close();
  }
});
