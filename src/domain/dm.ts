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
  // Set when this row is a delivery context for a room message (#84): an
  // @mention surfaced the room message here. The body above is read through
  // the reference — the room row is the one record — and the origin says
  // where a reply in public would go.
  origin: { messageId: number; roomId: string; roomName: string } | null;
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
type MessageRow = {
  id: number;
  thread_id: string;
  participant_id: string;
  body: string;
  created_at: number;
  message_id: number | null;
  room_id: string | null;
  room_name: string | null;
};

// Every read of a thread goes through this join, so a forked room message
// (#84) is delivered with the body it has *now* and never with a copy.
const THREAD_READ = `
  SELECT d.id, d.thread_id, d.participant_id, d.created_at, d.message_id,
         COALESCE(m.body, d.body) AS body, m.room_id, r.name AS room_name
    FROM dm_messages d
    LEFT JOIN messages m ON m.id = d.message_id
    LEFT JOIN rooms r ON r.id = m.room_id`;

// A participant by id, or by name when exactly one participant has it.
// Identity is (name, harness), so two harnesses can share a name; an
// ambiguous name is refused rather than guessed — a DM sent to the wrong
// one of two participants is not an error the sender can see. Exported as a
// factory because commands (#52) resolve /invite and /kick targets by the
// same rule — one answer to "who is that", not two.
export function participantResolver(db: DatabaseSync, requireParticipant: (id: string) => Participant) {
  return function resolveParticipant(ref: string): Participant {
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
  };
}

export function openDms(deps: Deps) {
  const { db, now, appendEvent, requireParticipant } = deps;

  const resolveParticipant = participantResolver(db, requireParticipant);

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
      origin:
        row.message_id === null
          ? null
          : { messageId: row.message_id, roomId: row.room_id ?? '', roomName: row.room_name ?? '' },
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

  // The thread is created by the first use and found again by the pair, so
  // it survives reconnects and restarts the same way identity does (1.1 #10).
  // Shared with mentions (#84): a fork lands in the same thread a DM would.
  function threadFor(aId: string, bId: string): DmThread {
    const found = threadBetween(aId, bId);
    if (found) return found;
    const [low, high] = aId < bId ? [aId, bId] : [bId, aId];
    const thread: DmThread = { id: randomUUID(), participants: [low, high], createdAt: now() };
    db.prepare('INSERT INTO dm_threads (id, low_id, high_id, created_at) VALUES (?, ?, ?, ?)').run(
      thread.id,
      low,
      high,
      thread.createdAt,
    );
    return thread;
  }

  return {
    threadFor,

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

      const thread = threadFor(sender.id, counterpart.id);
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
        origin: null,
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
        .prepare(`${THREAD_READ} WHERE d.thread_id = ? AND d.id > ? ORDER BY d.id LIMIT ?`)
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
        const last = db.prepare(`${THREAD_READ} WHERE d.thread_id = ? ORDER BY d.id DESC LIMIT 1`).get(row.id) as
          | MessageRow
          | undefined;
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
