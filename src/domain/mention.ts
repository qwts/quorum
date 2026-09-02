// Mentions (#84): what `@name` in a room message means, and where it goes.
//
// A mention is lexical — ruled 2026-07-29 on #84: it resolves against the
// roster of the room the message is posted in, whatever that room is. A name
// that matches nobody in *that* room stays text; there is no cross-room
// lookup and no fallback. The property this buys is stated in the issue and
// worth restating here because it is why the rule is shaped this way: a
// mention can never surface a room message to someone who may not read the
// room it was posted in. The broken state is unreachable by construction.
//
// A resolved mention forks the message into the DM thread between author and
// mentioned participant — one message, two delivery contexts. The room row
// is the message; the thread gets a *reference* to it (a dm_messages row
// whose message_id points at the room message and whose own body is empty),
// never a copy, so there is exactly one record for anyone to edit, react to,
// or attribute. No second feed event is appended: the mentioned participant
// is a room member and already receives the room event, which the directed
// lane (#61) treats as addressed to them — so unseen counts stay single.
//
// Two adas in one room (same name, different harness) are both mentioned by
// `@ada`: over-delivery to two people who each match is not the misdelivery
// the DM resolver refuses, and a mention is not a place to guess between
// them. Mentioning yourself forks nothing — there is no thread with yourself.

import type { DatabaseSync } from 'node:sqlite';

import type { DmThread } from './dm.ts';
import type { Message, Participant } from './quorum.ts';

// A mention is `@` followed by the whole name, standing alone: not a
// fragment of a longer token on either side (`email@ada`, `@ada2`). The name
// class mirrors what names on this server look like — `claude:auth-refactor`
// — so a mention can carry a colon or a dot without ending early.
const NAME_CHAR = '[\\p{L}\\p{N}_:./-]';

export function mentions(body: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<!${NAME_CHAR})@${escaped}(?!${NAME_CHAR})`, 'u').test(body);
}

/** One delivery context a mention opened: whose thread, and the row in it. */
export type MentionFork = {
  participantId: string;
  name: string;
  threadId: string;
  /** The dm_messages id of the reference row — the thread's cursor unit. */
  dmId: number;
};

export type Deps = {
  db: DatabaseSync;
  /** Members of a room in join order — the roster a mention resolves against. */
  membersOf: (roomId: string) => Participant[];
  /** The one DM thread between two participants, created on first use. */
  threadFor: (aId: string, bId: string) => DmThread;
};

export function openMentions(deps: Deps) {
  const { db } = deps;

  /**
   * Resolve the mentions in a room message and fork it into each mentioned
   * member's thread with the author. Runs inside postMessage's transaction,
   * so a message and its delivery contexts land together or not at all.
   */
  function fork(message: Message, author: Participant): MentionFork[] {
    if (!message.body.includes('@')) return [];
    const forks: MentionFork[] = [];
    for (const member of deps.membersOf(message.roomId)) {
      if (member.id === author.id || !mentions(message.body, member.name)) continue;
      const thread = deps.threadFor(author.id, member.id);
      const row = db
        .prepare('INSERT INTO dm_messages (thread_id, participant_id, body, message_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(thread.id, author.id, '', message.id, message.createdAt);
      forks.push({ participantId: member.id, name: member.name, threadId: thread.id, dmId: Number(row.lastInsertRowid) });
    }
    return forks;
  }

  return { fork };
}

export type Mentions = ReturnType<typeof openMentions>;
