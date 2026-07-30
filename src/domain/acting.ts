// Which session an action belongs to, carried beside the call rather than
// threaded through every domain signature (ADR-0001 §4.1). The session is a
// fact about the request, not an argument to postMessage.
//
// AsyncLocalStorage keeps it exact under concurrency: two agents' calls
// interleave at every await, and a module-level variable would file one
// agent's write under the other's session — which is the ghost-chasing this
// design exists to end.
//
// Alone in its own file because both layers touch it and neither owns it: the
// transport opens the scope (src/mcp/server.ts) and the domain reads it when
// it appends an event (src/domain/quorum.ts).

import { AsyncLocalStorage } from 'node:async_hooks';

const ACTING = new AsyncLocalStorage<string>();

/** Run `fn` attributed to `sessionId`. Null is v0: attributed to no session. */
export function actingSession<T>(sessionId: string | null, fn: () => T): T {
  return sessionId === null ? fn() : ACTING.run(sessionId, fn);
}

export function currentSession(): string | null {
  return ACTING.getStore() ?? null;
}
