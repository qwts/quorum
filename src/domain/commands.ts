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
import type { Message, PostedMessage } from './quorum.ts';

export type { CommandOutcome } from './command-set.ts';

export function openCommands(deps: Deps) {
  const { requireParticipant, requireRoom, isMember } = deps;
  const registry = buildRegistry(deps);

  return {
    /**
     * The names this registry owns. The delivery-time registry (#51,
     * command-guidance.ts) must never expand them: what executes at post
     * keeps its #52 behavior, whatever prompt files a deployment adds.
     */
    names: registry.map((command) => command.name),

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
      // Scoped to the sender: a command naming a room they cannot see is
      // refused in the words a room that does not exist gets (ADR-0002 §6).
      const room = () => requireRoom(input.room, sender.id);
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
      message?: PostedMessage;
      command?: CommandOutcome;
    }> {
      // A challenge is an argument, not an order: a deliberation-tagged body
      // never dispatches as a command, so no action can run before the tag's
      // phase gate has its say in postMessage — a closed challenge window
      // must refuse the whole post, not half of it.
      const command = input.deliberationId ? null : await this.dispatch(input);
      if (!command) return { message: deps.postMessage(input) };
      if (command.recorded) return { message: deps.postMessage(input), command };
      return { command };
    },
  };
}
