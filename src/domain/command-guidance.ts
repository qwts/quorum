// Delivery-time slash commands (#51): the registry that turns a message
// beginning with /name into recipient-scoped guidance, derived at read time.
//
// This is the *other* command mechanism, and the two must not be confused:
//
//   * Room commands (commands.ts, #52) EXECUTE at post time. post_message
//     routes every chat body through their dispatch first: an answer-class
//     command (/help, /who) is answered to the asker and never posted, an
//     action-class one (/invite, /kick) runs and posts its typed line.
//   * These commands expand at DELIVERY time. The typed line is stored and
//     shown unmodified — the web UI sees "/smack tom" as typed — and each
//     recipient's MCP delivery grows guidance resolved from a prompt file.
//     Nothing executes, nothing is stored (req 7): editing a file changes
//     the next delivery with no migration.
//
// Coexistence rule: a name the executed registry owns never expands here,
// whatever files a deployment adds. Answer-class commands are never posted,
// so there is nothing to deliver; action-class ones post their typed line,
// and that line must keep arriving as the plain record #52 promised, not
// grow a footer it never had. The reserved list below is that rule.
//
// Prompt files are deployment-authored — trusted the way server guidance is
// trusted. Placeholder VALUES ({from}, {target}, {args}, {room}) are
// participant-authored and are interpolated only through the `quote`
// function the caller provides — the MCP passes quoted() from
// src/mcp/reply.ts — so a hostile body cannot pose as the deployment's
// directive. Transport-free: files and strings, no MCP or HTTP types.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type GuidanceInput = {
  /** The message body as typed — participant data, parsed but never altered. */
  body: string;
  /** Sender's display name. */
  from: string;
  /** Room name, or null when the message is a DM. */
  room: string | null;
  /** Who this delivery is for. The harness selects the command dialect (req 4). */
  recipient: { name: string; harness: string };
  /**
   * Makes participant-authored text safe inside the deployment's prompt:
   * one line, bounded, visibly quoted. Callers pass quoted() from
   * src/mcp/reply.ts — never identity.
   */
  quote: (text: string, max?: number) => string;
};

// Same command syntax as the executed registry (commands.ts), so "/word" means
// one thing in chat regardless of which mechanism ends up answering for it.
const COMMAND_SYNTAX = /^\/([a-z][a-z-]*)\s*([\s\S]*)$/;

export function openCommandGuidance(options: { reserved?: string[]; deploymentDir?: string } = {}) {
  const reserved = new Set(options.reserved ?? []);
  const deploymentDir =
    options.deploymentDir ?? process.env.QUORUM_COMMANDS_DIR ?? join(homedir(), '.quorum', 'commands');
  // The built-in defaults ship with the repository (req 5).
  const builtinDir = fileURLToPath(new URL('../../commands', import.meta.url));

  // Reread on every resolution — no cache, so an edited file is the next
  // delivery (req 7). The deployment layer wins outright: a person who writes
  // ~/.quorum/commands/goal.md has changed /goal for every harness, without
  // touching quorum's code (req 5). Within each layer the recipient's harness
  // dialect wins over the shared file (req 4).
  function template(harness: string, name: string): string | null {
    // The harness is participant-authored and becomes a path component here,
    // so it enters the filesystem only as a single plain segment — anything
    // else (separators, a leading dot) skips the dialect lookup and falls
    // back to the shared file rather than walking out of the directory.
    const dialect = /^[a-z0-9][a-z0-9._-]*$/i.test(harness) ? harness : null;
    const candidates = [
      dialect === null ? null : join(deploymentDir, dialect, `${name}.md`),
      join(deploymentDir, `${name}.md`),
      dialect === null ? null : join(builtinDir, dialect, `${name}.md`),
      join(builtinDir, `${name}.md`),
    ];
    for (const path of candidates) {
      if (path === null) continue;
      try {
        return readFileSync(path, 'utf8');
      } catch {
        // A missing file is the next fallback, not an error (req 6).
      }
    }
    return null;
  }

  return {
    /**
     * The guidance a delivery of `body` carries for this recipient, or null
     * when it carries none: a plain message, an unknown /command (req 6 —
     * chat must not grow a syntax that can fail), a name the executed
     * registry owns, or a targeted command aimed at someone else (req 3).
     */
    guidanceFor(input: GuidanceInput): string | null {
      const match = COMMAND_SYNTAX.exec(input.body.trim());
      if (!match) return null;
      const name = match[1]!.toLowerCase();
      if (reserved.has(name)) return null;
      const raw = template(input.recipient.harness, name);
      if (raw === null) return null;

      // A template that names {target} is a targeted command: the first word
      // of the args says who it is for, and only that participant's delivery
      // grows the footer (req 3) — matched by name, so every harness wearing
      // the name is addressed, each in its own dialect. The rest of the line
      // is {args}; an untargeted command keeps the whole tail.
      const tail = (match[2] ?? '').trim();
      const targeted = raw.includes('{target}');
      const [target = '', ...rest] = targeted ? tail.split(/\s+/) : [];
      if (targeted && (target === '' || target !== input.recipient.name)) return null;
      const args = targeted ? rest.join(' ') : tail;

      // One pass, so a participant value that itself contains "{args}" is
      // quoted once and never re-expanded as a placeholder.
      const { quote } = input;
      const values: Record<string, string> = {
        from: quote(input.from),
        target: quote(target),
        args: quote(args, 200),
        room: input.room === null ? 'this direct thread' : quote(input.room),
      };
      return raw.replace(/\{(from|target|args|room)\}/g, (_, key: string) => values[key]!).trim();
    },
  };
}

export type CommandGuidance = ReturnType<typeof openCommandGuidance>;
