// The lifecycle tool surface (#80): schemas and handlers together, same as
// tools.ts and dms.ts, so the family reads as the contract it is.
//
// Each of these is a mutation that used to be impossible: a room could be
// created and never renamed, retopiced, or left; a status could be set and
// never cleared. Every one is recorded on the feed as its own event, and
// every reply carries the next call, because a tool that answers `ok` is
// incomplete (AGENTS.md: the reply is the loop).

import type { Quorum } from '../domain/quorum.ts';
import { quoted, requireIdentity, str, type Json, type Session, type ToolDefinition, type ToolReply } from './reply.ts';

const UNTIL_ROLES = 'Until room roles land (#82) only the room\'s creator may do this; the refusal says so.';

const LEAVE_ROOM: ToolDefinition = {
  name: 'leave_room',
  description:
    'Leave a room you are in. The room, its messages, and its decision records stay; your membership ends and ' +
    'the room sees a room_left event. join_room brings you back.',
  inputSchema: {
    type: 'object',
    properties: { room: { type: 'string', description: 'Room name or id.' } },
    required: ['room'],
    additionalProperties: false,
  },
};

const RENAME_ROOM: ToolDefinition = {
  name: 'rename_room',
  description:
    'Rename a room. The id is unchanged, so claims, deliberations, and cursors are untouched; the room sees a ' +
    'room_renamed event carrying the old name. ' +
    UNTIL_ROLES,
  inputSchema: {
    type: 'object',
    properties: { room: { type: 'string', description: 'Current room name or id.' }, name: { type: 'string' } },
    required: ['room', 'name'],
    additionalProperties: false,
  },
};

const SET_TOPIC: ToolDefinition = {
  name: 'set_topic',
  description:
    'Set a room\'s topic, or clear it by passing an empty topic. The room sees a room_topic_set event. ' + UNTIL_ROLES,
  inputSchema: {
    type: 'object',
    properties: {
      room: { type: 'string', description: 'Room name or id.' },
      topic: { type: 'string', description: 'The new topic; empty clears it.' },
    },
    required: ['room', 'topic'],
    additionalProperties: false,
  },
};

const CLEAR_STATUS: ToolDefinition = {
  name: 'clear_status',
  description:
    'Clear your own status or blocked line, set earlier with /status or /blocked. The roster shows nothing for you ' +
    'again and the feed carries a status_changed event. Clearing an already-clear status changes nothing.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

export const LIFECYCLE_TOOLS: ToolDefinition[] = [LEAVE_ROOM, RENAME_ROOM, SET_TOPIC, CLEAR_STATUS];

/** Handle a lifecycle tool call, or return null when the name is not one of ours. */
export function callLifecycleTool(quorum: Quorum, session: Session, name: string, args: Json): ToolReply | null {
  switch (name) {
    case 'leave_room': {
      const participantId = requireIdentity(session);
      const room = quorum.leaveRoom({ room: str(args, 'room') ?? '', participantId });
      return {
        guidance:
          `You left ${quoted(room.name)}. list_rooms shows where else you can go; join_room brings you back.` +
          ` Claims you hold are unaffected — release_claim when you are done with them.`,
        data: { room },
      };
    }

    case 'rename_room': {
      const participantId = requireIdentity(session);
      const { room, changed } = quorum.renameRoom({
        room: str(args, 'room') ?? '',
        participantId,
        name: str(args, 'name') ?? '',
      });
      return {
        guidance: changed
          ? `The room is now ${quoted(room.name)}; its id is unchanged, so keep using either.` +
            ` Members see room_renamed on the feed. post_message if the reason belongs on the record.`
          : `The room was already named ${quoted(room.name)}; nothing changed and no event was recorded.`,
        data: { room, changed },
      };
    }

    case 'set_topic': {
      const participantId = requireIdentity(session);
      const { room, changed } = quorum.setTopic({
        room: str(args, 'room') ?? '',
        participantId,
        topic: str(args, 'topic') ?? null,
      });
      const topic = room.topic === null ? 'no topic' : `the topic ${quoted(room.topic)}`;
      return {
        guidance: changed
          ? `${quoted(room.name)} now has ${topic}. Members see room_topic_set on the feed.` +
            ` wait_for_events to stay with the room.`
          : `${quoted(room.name)} already had ${topic}; nothing changed and no event was recorded.`,
        data: { room, changed },
      };
    }

    case 'clear_status': {
      const participantId = requireIdentity(session);
      const participant = quorum.clearStatus({ participantId });
      return {
        guidance:
          'Your status is clear; the roster shows nothing for you. post_message with /status or /blocked sets a new' +
          ' one, wait_for_events to get back to the room.',
        data: { participant },
      };
    }

    default:
      return null;
  }
}
