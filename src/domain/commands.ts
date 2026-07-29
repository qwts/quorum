// Room commands (#52): the parser and the dispatch rule. The vocabulary
// itself lives in command-set.ts — this file decides *whether* a body is a
// command and what running one means.
//
// Three dispatch classes, ruled in the issue:
//
//   * **actions** — execute at post time and are recorded: the typed line is
//     posted to the room, so the order given is on the record, and the
//     mutation's own event follows it.
//   * **answers** — /help, /version, /list, bare /status: answered to the
//     asker alone and never recorded. Asking what the tools are is not a room
//     fact, and a busy room would drown in it.
//   * everything else is **just a message** — an unknown /command posts as
//     typed. Chat must not grow a syntax that can fail.
//
// Both transports land here through `post` (one domain core, two transports),
// so a human's /kick and an agent's /kick are the same fact, refused in the
// same words.

import { buildRegistry, type CommandOutcome, type Deps } from './command-set.ts';
import { QuorumError } from './errors.ts';
import type { Message } from './quorum.ts';

export type { CommandOutcome } from './command-set.ts';

export function openCommands(deps: Deps) {
  const { requireParticipant, requireRoom, isMember } = deps;
  const registry = buildRegistry(deps);

  return {
    /**
     * Parse and run a command, or return null when the body is not one —
     * including an unknown /word, which posts as the message it is.
     */
    async dispatch(input: { room: string; participantId: string; body: string }): Promise<CommandOutcome | null> {
      const match = /^\/([a-z][a-z-]*)\s*([\s\S]*)$/.exec(input.body.trim());
      const command = match && registry.find((c) => c.name === match[1]!.toLowerCase());
      if (!command) return null;
      const sender = requireParticipant(input.participantId);
      const args = (match![2] ?? '').trim();
      const recorded = typeof command.recorded === 'function' ? command.recorded(args) : command.recorded;
      const room = () => requireRoom(input.room);
      // An action is recorded, and recording requires membership — checked
      // before the action runs, so a refusal leaves nothing half-done.
      if (recorded && !isMember(room().id, sender.id)) {
        throw new QuorumError(`join ${JSON.stringify(room().name)} before posting to it`);
      }
      const text = await command.run({ sender, args, room });
      return { command: command.name, text, recorded };
    },

    /**
     * The one write path for chat: commands execute, everything else posts.
     * An action's typed line is posted after it succeeds — a refusal leaves
     * no trace, an order that ran is on the record.
     */
    async post(input: { room: string; participantId: string; body: string; deliberationId?: string }): Promise<{
      message?: Message;
      command?: CommandOutcome;
    }> {
      const command = await this.dispatch(input);
      if (!command) return { message: deps.postMessage(input) };
      if (command.recorded) return { message: deps.postMessage(input), command };
      return { command };
    },
  };
}
