// What every tool surface shares: the session, the reply shape, and the
// discipline for participant-authored text inside server guidance.
//
// Split from tools.ts so a tool family (DMs in src/mcp/dms.ts) can live in
// its own file without importing the whole surface — the rules travel, the
// catalogue does not.

import { QuorumError } from '../domain/quorum.ts';

// A session carries the caller's own cursor. Guidance must never point an
// agent at the global feed head: an event another participant appended since
// the caller last read would be skipped forever by following it.
export type Session = { participantId: string | null; cursor: number };

export type Json = Record<string, unknown>;

// Every tool answers with the values *and* the next move. An agent's loop is
// driven by what its tools hand back, so a bare value leaves it to improvise
// the next step; a reply that names the step keeps the loop closed without a
// skill file trying to remember it.
//
// The steering text is written by this server. Participant-authored content —
// names, purposes, message bodies — is data, and never becomes part of the
// instruction. Where a holder's name has to appear in guidance so the caller
// knows who to talk to, it goes through `quoted`, which strips anything that
// could pose as a new directive.
export type ToolReply = { guidance: string; data: Json };

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Json;
};

// Participant-authored text, made safe to appear inside server guidance:
// one line, bounded, and visibly quoted so it reads as a value.
//
// Control characters are not enough. Unicode *format* characters (Cf) survive
// JSON.stringify untouched, and they attack the eye rather than the parser:
// U+202E reverses the rendering of everything after it, so a purpose can flip
// the guidance line it sits inside, and zero-widths let a name display as a
// name it is not. Visibly quoted is the property this function exists to
// provide, so both classes go.
export function quoted(text: string, max = 80): string {
  const flattened = text.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
  const clipped = flattened.length > max ? `${flattened.slice(0, max - 1)}…` : flattened;
  return JSON.stringify(clipped);
}

// A room command's reply (#52). The answer can carry participant-authored
// text — statuses, topics, names — so it rides in data as the value it is,
// never in guidance: participant content must not read as server instruction.
export function commandReply(
  command: { command: string; recorded: boolean; text: string },
  message: unknown,
): ToolReply {
  return {
    guidance: command.recorded
      ? `The /${command.command} command ran — data.answer carries its result, and the typed line is on the room's record.`
      : `The /${command.command} command was answered to you alone — data.answer carries it; nothing was posted.`,
    data: { answer: command.text, ...(message ? { message } : {}) },
  };
}

export function requireIdentity(session: Session): string {
  if (!session.participantId) {
    throw new QuorumError('identify yourself first: call identify with a name and harness');
  }
  return session.participantId;
}

export function str(args: Json, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

export function num(args: Json, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' ? value : undefined;
}
