// The MCP tool surface: plain tools with hand-written JSON Schemas.
//
// Requirement 8 (any MCP client) is why the schemas are written out here
// rather than generated from a validation library's types — the wire contract
// is the product, and it should be readable as such. This module is the only
// place that knows both the domain and the protocol; the domain knows neither.

import type { Claim, Quorum } from '../domain/quorum.ts';
import { QuorumError } from '../domain/quorum.ts';

export type Session = { participantId: string | null };

type Json = Record<string, unknown>;

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Json;
};

const IDENTIFY: ToolDefinition = {
  name: 'identify',
  description:
    'Introduce yourself to the server and join the roster. Call this once per session before any other tool.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description:
          'Display name other participants see, e.g. "claude:auth-refactor". Reuse the same name to resume your identity — and your claims — after a reconnect or a server restart.',
      },
      harness: { type: 'string', description: 'The tool you run in, e.g. "claude-code", "codex", "cursor".' },
      repo: { type: 'string', description: 'Repository you are working in, if any.' },
      branch: { type: 'string', description: 'Branch you are working on, if any.' },
    },
    required: ['name', 'harness'],
    additionalProperties: false,
  },
};

const CREATE_ROOM: ToolDefinition = {
  name: 'create_room',
  description: 'Create a room and join it. Room names are unique.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      topic: { type: 'string' },
      decision_rule: {
        type: 'string',
        enum: ['majority', 'unanimity'],
        description: 'How deliberations in this room will decide. Recorded now; enforced when deliberations land.',
      },
    },
    required: ['name'],
    additionalProperties: false,
  },
};

const LIST_ROOMS: ToolDefinition = {
  name: 'list_rooms',
  description: 'List every room with its member count.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

const JOIN_ROOM: ToolDefinition = {
  name: 'join_room',
  description: 'Join a room by name or id.',
  inputSchema: {
    type: 'object',
    properties: { room: { type: 'string' } },
    required: ['room'],
    additionalProperties: false,
  },
};

const POST_MESSAGE: ToolDefinition = {
  name: 'post_message',
  description: 'Post a message to a room you have joined.',
  inputSchema: {
    type: 'object',
    properties: { room: { type: 'string' }, body: { type: 'string' } },
    required: ['room', 'body'],
    additionalProperties: false,
  },
};

const READ_MESSAGES: ToolDefinition = {
  name: 'read_messages',
  description: 'Read messages in a room from a cursor. Pass the last id you saw as after_id.',
  inputSchema: {
    type: 'object',
    properties: {
      room: { type: 'string' },
      after_id: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
    },
    required: ['room'],
    additionalProperties: false,
  },
};

const WAIT_FOR_EVENTS: ToolDefinition = {
  name: 'wait_for_events',
  description:
    'Block until something happens after your cursor — a message, a claim granted, released, or expired. Returns an empty list on timeout; pass the highest seq you saw as after_seq next time. Do not poll in a loop without this call.',
  inputSchema: {
    type: 'object',
    properties: {
      after_seq: { type: 'integer', minimum: 0, description: 'Highest event seq you have already handled.' },
      timeout_ms: { type: 'integer', minimum: 0, maximum: 120000 },
    },
    required: ['after_seq'],
    additionalProperties: false,
  },
};

const CLAIM_SCOPE: ToolDefinition = {
  name: 'claim_scope',
  description:
    'Claim the files you are about to work on, so another agent is told the scope is taken. Refused when a live claim held by someone else overlaps — the refusal names the holder. A claim is a coordination signal, not a lock: it stops well-behaved agents, not writes.',
  inputSchema: {
    type: 'object',
    properties: {
      repo: { type: 'string', description: 'Repository name the claim applies to.' },
      patterns: {
        type: 'array',
        items: { type: 'string', maxLength: 256 },
        maxItems: 32,
        description: 'Path globs (`*`, `?`, `**`). Omit to claim the whole repository.',
      },
      branch: {
        type: 'string',
        description: 'Branch you work on. Claims on different named branches never conflict; omit to mean any branch.',
      },
      purpose: { type: 'string', description: 'What you are doing, in a sentence others can act on.' },
      ttl_seconds: { type: 'integer', minimum: 1, maximum: 43200, description: 'Lease length. Default 1800.' },
    },
    required: ['repo', 'purpose'],
    additionalProperties: false,
  },
};

const RENEW_CLAIM: ToolDefinition = {
  name: 'renew_claim',
  description: 'Extend a claim you hold. Renew before it expires; an ended claim cannot be revived.',
  inputSchema: {
    type: 'object',
    properties: { claim_id: { type: 'string' }, ttl_seconds: { type: 'integer', minimum: 1, maximum: 43200 } },
    required: ['claim_id'],
    additionalProperties: false,
  },
};

const RELEASE_CLAIM: ToolDefinition = {
  name: 'release_claim',
  description: 'Release a claim you hold as soon as the work is done, so others stop waiting on it.',
  inputSchema: {
    type: 'object',
    properties: { claim_id: { type: 'string' } },
    required: ['claim_id'],
    additionalProperties: false,
  },
};

const LIST_CLAIMS: ToolDefinition = {
  name: 'list_claims',
  description: 'List live claims, optionally for one repository. Check this before you start work.',
  inputSchema: {
    type: 'object',
    properties: { repo: { type: 'string' } },
    additionalProperties: false,
  },
};

const LIST_PARTICIPANTS: ToolDefinition = {
  name: 'list_participants',
  description: 'Who is on the roster: name, harness, and where each one is working.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

export const TOOLS: ToolDefinition[] = [
  IDENTIFY,
  LIST_PARTICIPANTS,
  CREATE_ROOM,
  LIST_ROOMS,
  JOIN_ROOM,
  POST_MESSAGE,
  READ_MESSAGES,
  WAIT_FOR_EVENTS,
  CLAIM_SCOPE,
  RENEW_CLAIM,
  RELEASE_CLAIM,
  LIST_CLAIMS,
];

function describeClaim(claim: Claim): string {
  const where = claim.branch ? `${claim.repo}@${claim.branch}` : claim.repo;
  return `${where} ${claim.patterns.join(', ')} — ${claim.purpose}`;
}

function requireIdentity(session: Session): string {
  if (!session.participantId) {
    throw new QuorumError('identify yourself first: call identify with a name and harness');
  }
  return session.participantId;
}

function str(args: Json, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

function num(args: Json, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' ? value : undefined;
}

// Returns the structured result for a tool call. Throwing a QuorumError here
// becomes an MCP tool error with the message intact — agents read those.
export async function callTool(
  quorum: Quorum,
  session: Session,
  name: string,
  args: Json,
): Promise<Json> {
  switch (name) {
    case 'identify': {
      const { participant, resumed, claims } = quorum.identify({
        name: str(args, 'name') ?? '',
        harness: str(args, 'harness') ?? '',
        repo: str(args, 'repo'),
        branch: str(args, 'branch'),
      });
      session.participantId = participant.id;
      return {
        participant,
        resumed,
        // A resumed agent gets its live claims straight back, so it knows what
        // it still holds after a reconnect rather than discovering it by
        // being refused its own scope.
        claims,
        cursor: quorum.latestSeq(),
      };
    }

    case 'list_participants':
      return { participants: quorum.listParticipants() };

    case 'create_room': {
      const by = requireIdentity(session);
      const rule = str(args, 'decision_rule');
      return {
        room: quorum.createRoom({
          name: str(args, 'name') ?? '',
          topic: str(args, 'topic'),
          decisionRule: rule === 'unanimity' ? 'unanimity' : rule === 'majority' ? 'majority' : undefined,
          by,
        }),
      };
    }

    case 'list_rooms':
      return { rooms: quorum.listRooms() };

    case 'join_room': {
      const participantId = requireIdentity(session);
      return { room: quorum.joinRoom({ room: str(args, 'room') ?? '', participantId }) };
    }

    case 'post_message': {
      const participantId = requireIdentity(session);
      return {
        message: quorum.postMessage({
          room: str(args, 'room') ?? '',
          participantId,
          body: str(args, 'body') ?? '',
        }),
      };
    }

    case 'read_messages':
      return {
        messages: quorum.readMessages({
          room: str(args, 'room') ?? '',
          afterId: num(args, 'after_id'),
          limit: num(args, 'limit'),
        }),
      };

    case 'wait_for_events': {
      const events = await quorum.waitForEvents({
        afterSeq: num(args, 'after_seq') ?? 0,
        timeoutMs: num(args, 'timeout_ms'),
      });
      const cursor = events.length > 0 ? events[events.length - 1]!.seq : (num(args, 'after_seq') ?? 0);
      return { events, cursor };
    }

    case 'claim_scope': {
      const participantId = requireIdentity(session);
      const patterns = Array.isArray(args.patterns)
        ? args.patterns.filter((pattern): pattern is string => typeof pattern === 'string')
        : undefined;
      const grant = quorum.claimScope({
        participantId,
        repo: str(args, 'repo') ?? '',
        patterns,
        branch: str(args, 'branch'),
        purpose: str(args, 'purpose') ?? '',
        ttlSeconds: num(args, 'ttl_seconds'),
      });
      if (grant.ok) return { granted: true, claim: grant.claim };
      return {
        granted: false,
        conflicts: grant.conflicts,
        // The point of the refusal is the next action, so spell it out.
        advice: `Already claimed: ${grant.conflicts
          .map(describeClaim)
          .join('; ')}. Talk to the holder in a room, work on something else, or wait for the claim to expire.`,
      };
    }

    case 'renew_claim': {
      const participantId = requireIdentity(session);
      return {
        claim: quorum.renewClaim({
          claimId: str(args, 'claim_id') ?? '',
          participantId,
          ttlSeconds: num(args, 'ttl_seconds'),
        }),
      };
    }

    case 'release_claim': {
      const participantId = requireIdentity(session);
      return { claim: quorum.releaseClaim({ claimId: str(args, 'claim_id') ?? '', participantId }) };
    }

    case 'list_claims':
      return { claims: quorum.listClaims({ repo: str(args, 'repo') }) };

    default:
      throw new QuorumError(`unknown tool: ${name}`);
  }
}
