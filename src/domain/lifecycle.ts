// Lifecycle verbs (#80): the ways an object changes or leaves after it was
// created. Rooms are renamed, retopiced, and left; a status is cleared. Each
// verb is one row mutation and one event, because a rename or a departure is
// a thing that happened and the feed is where things that happened go
// (#80 requirement 4) — never a silent edit.
//
// Transport-free like the rest of src/domain/, and composed over the host
// domain through `Deps` the way dm.ts is. What is deliberately *not* here:
// archive (its own pass, with a column), anything on a decision record (D9:
// immutable, a correction is a new deliberation), and any verb on a closed
// claim (a lease that ended is history).
//
// Who may: the capability matrix is #82's. Until it lands, a room's shape is
// its creator's to change and a membership is its holder's to end. The
// refusals say so, so the rule reads as the placeholder it is.

import type { DatabaseSync } from 'node:sqlite';
import { visibleNameTaken } from './authority.ts';
import { QuorumError } from './errors.ts';
import type { Participant, Room } from './quorum.ts';

/**
 * A verb's result, and whether it was a change. A no-op — renaming a room to
 * its own name, setting the topic it has — mutates nothing and appends no
 * event, and a caller told to expect the event would wait for one that never
 * comes (Codex on #139), so the answer says which it was.
 */
export type Changed<T> = { room: T; changed: boolean };

/** Everything lifecycle verbs need from the host domain, and nothing more. */
export type Deps = {
  db: DatabaseSync;
  now: () => number;
  appendEvent: (kind: string, roomId: string | null, payload: Record<string, unknown>, actorId: string | null) => void;
  requireParticipant: (id: string) => Participant;
  requireRoom: (ref: string, viewer?: string | null) => Room;
  isMember: (roomId: string, participantId: string) => boolean;
};

export function openLifecycle(deps: Deps) {
  const { db, now, appendEvent, requireParticipant, requireRoom, isMember } = deps;

  // The interim ownership rule, in one place so #82 replaces one function.
  function requireCreator(room: Room, participant: Participant, verb: string): void {
    if (room.createdBy !== participant.id) {
      throw new QuorumError(
        `only the creator of ${JSON.stringify(room.name)} can ${verb} it until room roles land (#82)`,
      );
    }
  }

  return {
    /**
     * Leave a room you are in. The membership row goes; the room, its
     * messages, and its records stay. Leaving is the holder's alone —
     * removing someone else is /kick, and stays god-mod (#54).
     */
    leaveRoom(input: { room: string; participantId: string }): Room {
      const participant = requireParticipant(input.participantId);
      const room = requireRoom(input.room, participant.id);
      if (!isMember(room.id, participant.id)) {
        throw new QuorumError(`you are not in ${JSON.stringify(room.name)}`);
      }
      db.prepare('DELETE FROM room_members WHERE room_id = ? AND participant_id = ?').run(room.id, participant.id);
      appendEvent('room_left', room.id, { room, participant }, participant.id);
      return room;
    },

    /**
     * Rename a room. Uniqueness is the same caller-scoped rule createRoom
     * applies (ADR-0002 §6): a collision the caller cannot see is never
     * reported, and the partial index still refuses the write.
     */
    renameRoom(input: { room: string; participantId: string; name: string }): Changed<Room> {
      const participant = requireParticipant(input.participantId);
      const room = requireRoom(input.room, participant.id);
      requireCreator(room, participant, 'rename');
      const name = input.name?.trim();
      if (!name) throw new QuorumError('a room needs a name');
      if (name === room.name) return { room, changed: false };
      if (visibleNameTaken(db, name, participant.id)) {
        throw new QuorumError(`room already exists: ${JSON.stringify(name)}`);
      }
      db.prepare('UPDATE rooms SET name = ? WHERE id = ?').run(name, room.id);
      const renamed = requireRoom(room.id, participant.id);
      appendEvent('room_renamed', room.id, { room: renamed, previousName: room.name }, participant.id);
      return { room: renamed, changed: true };
    },

    /**
     * Set or clear a room's topic. An empty topic clears it — the topic is
     * the one field on a room that is optional at creation, so it is the one
     * that can be taken away.
     */
    setTopic(input: { room: string; participantId: string; topic: string | null | undefined }): Changed<Room> {
      const participant = requireParticipant(input.participantId);
      const room = requireRoom(input.room, participant.id);
      requireCreator(room, participant, 'change the topic of');
      const topic = input.topic?.trim() || null;
      if (topic === room.topic) return { room, changed: false };
      db.prepare('UPDATE rooms SET topic = ? WHERE id = ?').run(topic, room.id);
      const retopiced = requireRoom(room.id, participant.id);
      appendEvent('room_topic_set', room.id, { room: retopiced, previousTopic: room.topic }, participant.id);
      return { room: retopiced, changed: true };
    },

    /**
     * Clear your own status or blocked line. The roster shows nothing for
     * you again, and the feed says so with the same status_changed the
     * setting emitted — a reader folds both the same way. Idempotent: a
     * status that was already clear emits nothing, like releasing a claim
     * twice.
     */
    clearStatus(input: { participantId: string }): Participant {
      const participant = requireParticipant(input.participantId);
      if (participant.status === null) return participant;
      db.prepare('UPDATE participants SET status = NULL, status_kind = NULL, status_at = ? WHERE id = ?').run(
        now(),
        participant.id,
      );
      const cleared = requireParticipant(participant.id);
      appendEvent('status_changed', null, { participant: cleared }, participant.id);
      return cleared;
    },
  };
}
