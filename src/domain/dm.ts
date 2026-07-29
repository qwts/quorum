// Direct messages (requirements 1.1 #7): two participants, no room.
//
// Transport-free like the rest of src/domain/, and composed over the shared
// database and event feed the same way the deliberation protocol is — the
// `Deps` object below is the entire seam. The one idea this module owns is
// the audience-scoped event: a dm_message rides the same bus as everything
// else, but names its two participants, so the counterpart's wait wakes
// (1.1 #8) while every other reader sees neither the message nor that one
// was sent. The filter itself lives in quorum.ts, where every read of the
// feed already goes; what lives here is the decision to address the pair.

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { QuorumError } from './errors.ts';
import type { Participant } from './quorum.ts';

// A thread is its participant pair — canonically ordered, so the same two
// people always resume the same thread, whichever of them speaks (1.1 #7).
export type DmThread = {
  id: string;
  participants: [string, string];
  createdAt: number;
};

export type DmMessage = {
  id: number;
  threadId: string;
  participantId: string;
  body: string;
  createdAt: number;
};

// What a DM inbox lists: the thread, who the other person is, and the last
// word said in it — enough to paint without fetching every conversation.
export type DmThreadSummary = {
  id: string;
  counterpart: Participant;
  createdAt: number;
  lastMessage: DmMessage | null;
};

// Everything DMs need from the host domain, and nothing more.
export type Deps = {
  db: DatabaseSync;
  now: () => number;
  appendEvent: (
    kind: string,
    roomId: string | null,
    payload: Record<string, unknown>,
    actorId: string | null,
    audience: string[] | null,
  ) => void;
  requireParticipant: (id: string) => Participant;
};

type ThreadRow = { id: string; low_id: string; high_id: string; created_at: number };
type MessageRow = { id: number; thread_id: string; participant_id: string; body: string; created_at: number };

export function openDms(deps: Deps) {
  const { db, now, appendEvent, requireParticipant } = deps;

  // A participant by id, or by name when exactly one participant has it.
  // Identity is (name, harness), so two harnesses can share a name; an
  // ambiguous name is refused rather than guessed — a DM sent to the wrong
  // one of two participants is not an error the sender can see.
  function resolveParticipant(ref: string): Participant {
    const trimmed = ref?.trim();
    if (!trimmed) throw new QuorumError('say who — a participant id or name');
    const byId = db.prepare('SELECT id FROM participants WHERE id = ?').get(trimmed) as { id: string } | undefined;
    if (byId) return requireParticipant(byId.id);
    const byName = db.prepare('SELECT id FROM participants WHERE name = ? ORDER BY identified_at').all(trimmed) as {
      id: string;
    }[];
    if (byName.length === 1) return requireParticipant(byName[0]!.id);
    if (byName.length > 1) {
      throw new QuorumError(
        `${JSON.stringify(trimmed)} is ${byName.length} participants (same name, different harness) — use an id from the roster`,
      );
    }
    throw new QuorumError(`unknown participant: ${JSON.stringify(trimmed)}`);
  }

  function toThread(row: ThreadRow): DmThread {
    return { id: row.id, participants: [row.low_id, row.high_id], createdAt: row.created_at };
  }

  function toMessage(row: MessageRow): DmMessage {
    return {
      id: row.id,
      threadId: row.thread_id,
      participantId: row.participant_id,
      body: row.body,
      createdAt: row.created_at,
    };
  }

  // The one thread two participants share. Pair order is canonical
  // (low < high), so (a, b) and (b, a) are the same key — a thread is
  // resumed, never duplicated, whichever side speaks.
  function threadBetween(aId: string, bId: string): DmThread | null {
    const [low, high] = aId < bId ? [aId, bId] : [bId, aId];
    const row = db.prepare('SELECT * FROM dm_threads WHERE low_id = ? AND high_id = ?').get(low, high) as
      | ThreadRow
      | undefined;
    return row ? toThread(row) : null;
  }

  return {
    // The thread is created by the first send and found again by the pair, so
    // it survives reconnects and restarts the same way identity does (1.1 #10).
    sendDm(input: { participantId: string; to: string; body: string }): {
      message: DmMessage;
      thread: DmThread;
      counterpart: Participant;
    } {
      const sender = requireParticipant(input.participantId);
      const counterpart = resolveParticipant(input.to);
      if (counterpart.id === sender.id) throw new QuorumError('a DM needs someone else — that recipient is you');
      const body = input.body?.trim();
      if (!body) throw new QuorumError('message body is required');

      let thread = threadBetween(sender.id, counterpart.id);
      if (!thread) {
        const [low, high] = sender.id < counterpart.id ? [sender.id, counterpart.id] : [counterpart.id, sender.id];
        thread = { id: randomUUID(), participants: [low, high], createdAt: now() };
        db.prepare('INSERT INTO dm_threads (id, low_id, high_id, created_at) VALUES (?, ?, ?, ?)').run(
          thread.id,
          low,
          high,
          thread.createdAt,
        );
      }

      const at = now();
      const result = db
        .prepare('INSERT INTO dm_messages (thread_id, participant_id, body, created_at) VALUES (?, ?, ?, ?)')
        .run(thread.id, sender.id, body, at);
      const message: DmMessage = {
        id: Number(result.lastInsertRowid),
        threadId: thread.id,
        participantId: sender.id,
        body,
        createdAt: at,
      };
      appendEvent('dm_message', null, { message, thread, from: sender.name, to: counterpart.name }, sender.id, [
        ...thread.participants,
      ]);
      return { message, thread, counterpart };
    },

    // The caller asserts which side of the pair it is, the way every v0 write
    // names its participant. The thread is looked up as (reader, counterpart),
    // so a reader reaches only conversations it is in — the seam v1 auth
    // will back with real credentials instead of assertion.
    readDms(input: { participantId: string; with: string; afterId?: number; limit?: number }): {
      messages: DmMessage[];
      thread: DmThread | null;
      counterpart: Participant;
    } {
      const reader = requireParticipant(input.participantId);
      const counterpart = resolveParticipant(input.with);
      if (counterpart.id === reader.id) {
        throw new QuorumError('a DM thread needs someone else — that participant is you');
      }
      const thread = threadBetween(reader.id, counterpart.id);
      // No thread is an empty conversation, not an error: reading before
      // either side has spoken is a reasonable first move.
      if (!thread) return { messages: [], thread: null, counterpart };
      const limit = Math.min(Math.max(input.limit ?? 50, 1), 500);
      const rows = db
        .prepare('SELECT * FROM dm_messages WHERE thread_id = ? AND id > ? ORDER BY id LIMIT ?')
        .all(thread.id, input.afterId ?? 0, limit) as MessageRow[];
      return { messages: rows.map(toMessage), thread, counterpart };
    },

    // The inbox: every thread this participant is in, most recently spoken-in
    // first, each with who the other person is and the last thing said.
    listDmThreads(input: { participantId: string }): DmThreadSummary[] {
      const me = requireParticipant(input.participantId);
      const rows = db
        .prepare('SELECT * FROM dm_threads WHERE low_id = ? OR high_id = ? ORDER BY created_at')
        .all(me.id, me.id) as ThreadRow[];
      const summaries = rows.map((row) => {
        const last = db
          .prepare('SELECT * FROM dm_messages WHERE thread_id = ? ORDER BY id DESC LIMIT 1')
          .get(row.id) as MessageRow | undefined;
        return {
          id: row.id,
          counterpart: requireParticipant(row.low_id === me.id ? row.high_id : row.low_id),
          createdAt: row.created_at,
          lastMessage: last ? toMessage(last) : null,
        };
      });
      return summaries.sort(
        (a, b) => (b.lastMessage?.createdAt ?? b.createdAt) - (a.lastMessage?.createdAt ?? a.createdAt),
      );
    },
  };
}

export type Dms = ReturnType<typeof openDms>;
