// What the room commands are (#52). The other half — how a command is
// parsed, gated and run — lives in commands.ts; this file is the vocabulary,
// so adding a command is an entry here and nothing else.
//
// Every entry carries its category and a one-line summary because /help is
// generated from these definitions: a command that exists but is missing
// from /help is impossible by construction.

import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { QuorumError } from './errors.ts';
import type { Message, Participant, Room } from './quorum.ts';

const VERSION: string = createRequire(import.meta.url)('../../package.json').version;
const RELEASES = 'https://api.github.com/repos/qwts/quorum/releases/latest';

export type CommandOutcome = {
  /** Canonical command name, e.g. 'help'. */
  command: string;
  /** The answer or confirmation — written to be read, by human or agent. */
  text: string;
  /** True when the typed line was posted to the room (actions on the record). */
  recorded: boolean;
};

/** Everything commands need from the host domain, and nothing more. */
export type Deps = {
  db: DatabaseSync;
  now: () => number;
  appendEvent: (
    kind: string,
    roomId: string | null,
    payload: Record<string, unknown>,
    actorId: string | null,
    audience?: string[] | null,
  ) => void;
  requireParticipant: (id: string) => Participant;
  requireRoom: (name: string) => Room;
  isMember: (roomId: string, participantId: string) => boolean;
  resolveParticipant: (ref: string) => Participant;
  createRoom: (input: { name: string; topic?: string; by: string }) => Room;
  listRooms: () => (Room & { members: number })[];
  listMembers: (input: { room: string }) => Participant[];
  postMessage: (input: { room: string; participantId: string; body: string; deliberationId?: string }) => Message;
};

export type Ctx = {
  sender: Participant;
  args: string;
  /** Lazy: only commands that act on the room require it to exist. */
  room: () => Room;
};

export type Command = {
  name: string;
  category: 'rooms' | 'presence' | 'meta';
  summary: string;
  usage: string;
  /** Static for most; /status is an action with args and an answer without. */
  recorded: boolean | ((args: string) => boolean);
  run: (ctx: Ctx) => string | Promise<string>;
};

// God-mod (#54): the server operator, named in config as "name--harness" —
// deliberately never grantable from chat.
export function god(): { name: string; harness: string } | null {
  const raw = process.env.QUORUM_GOD?.trim();
  const split = raw ? raw.lastIndexOf('--') : -1;
  return raw && split > 0 ? { name: raw.slice(0, split), harness: raw.slice(split + 2) } : null;
}

export function buildRegistry(deps: Deps): Command[] {
  const { db, now, appendEvent, requireParticipant, isMember } = deps;

  const isGod = (p: Participant): boolean => {
    const g = god();
    return g !== null && p.name === g.name && p.harness === g.harness;
  };

  function setStatus(sender: Participant, text: string, kind: 'status' | 'blocked'): string {
    db.prepare('UPDATE participants SET status = ?, status_kind = ?, status_at = ? WHERE id = ?').run(
      text,
      kind,
      now(),
      sender.id,
    );
    appendEvent('status_changed', null, { participant: requireParticipant(sender.id) }, sender.id);
    return kind === 'blocked' ? `Marked blocked: ${text}` : `Status set: ${text}`;
  }

  const REGISTRY: Command[] = [
    {
      name: 'help',
      category: 'meta',
      summary: 'list every command; /help <command|category> for detail',
      usage: '/help [command|category]',
      recorded: false,
      run: ({ args }) => {
        const topic = args.replace(/^\//, '').toLowerCase();
        if (topic) {
          const one = REGISTRY.find((c) => c.name === topic);
          if (one) {
            const trace = one.recorded === false ? 'to you alone — nothing is posted' : 'and recorded: the typed line is posted to the room';
            return `${one.usage}\n${one.summary}\nAnswered ${trace}.`;
          }
          const group = REGISTRY.filter((c) => c.category === topic);
          if (group.length) return group.map((c) => `${c.usage} — ${c.summary}`).join('\n');
          return `No command or category named ${JSON.stringify(topic)}. Bare /help lists everything.`;
        }
        const categories = [...new Set(REGISTRY.map((c) => c.category))];
        return categories
          .map((cat) => `${cat}:\n${REGISTRY.filter((c) => c.category === cat)
            .map((c) => `  /${c.name} — ${c.summary}`)
            .join('\n')}`)
          .join('\n');
      },
    },
    {
      name: 'version',
      category: 'meta',
      summary: 'what this server runs, checked against the latest release',
      usage: '/version',
      recorded: false,
      run: async () => {
        const running = `v${VERSION}`;
        let latest: string | null = null;
        try {
          // On-demand only — quorum's one outbound call, never a background
          // phone-home. Offline is a normal answer, not an error.
          const res = await fetch(RELEASES, {
            signal: AbortSignal.timeout(2500),
            headers: { accept: 'application/vnd.github+json', 'user-agent': 'quorum' },
          });
          if (res.ok) latest = ((await res.json()) as { tag_name?: string }).tag_name ?? null;
        } catch {
          latest = null;
        }
        if (!latest) return `Running ${running} — could not reach GitHub to compare. Releases: github.com/qwts/quorum/releases`;
        if (latest.replace(/^v/, '') === VERSION) return `Running ${running} — up to date with the latest release (${latest}).`;
        // Running is what was *started*, not what is on disk: a pull without a
        // restart must not report itself current.
        return `Running ${running}; latest release is ${latest} — git pull && npm start to pick it up. A pull without a restart keeps running ${running}.`;
      },
    },
    {
      name: 'list',
      category: 'rooms',
      summary: 'every room, its topic, size and rule',
      usage: '/list',
      recorded: false,
      run: () => {
        const rooms = deps.listRooms();
        if (rooms.length === 0) return 'No rooms yet — /room <name> creates one.';
        return rooms
          .map((r) => `#${r.name}${r.topic ? ` — ${r.topic}` : ''} · ${r.members} member${r.members === 1 ? '' : 's'} · rule: ${r.decisionRule}`)
          .join('\n');
      },
    },
    {
      name: 'room',
      category: 'rooms',
      summary: 'create a room: /room <name> [topic]',
      usage: '/room <name> [topic]',
      // Answer-class on purpose: creation announces itself (room_created),
      // and an action gate would demand membership in the room you typed in —
      // which on a fresh server does not exist. /list says "/room creates
      // one", and that has to be true with zero rooms (#55 review).
      recorded: false,
      run: ({ sender, args }) => {
        const [name, ...rest] = args.split(/\s+/);
        if (!name) throw new QuorumError('a room needs a name: /room <name> [topic]');
        const room = deps.createRoom({ name, topic: rest.join(' ') || undefined, by: sender.id });
        return `Room #${room.name} created — you are in it.`;
      },
    },
    {
      name: 'invite',
      category: 'rooms',
      summary: 'invite a participant here; they are woken with instructions to join',
      usage: '/invite <name|id>',
      recorded: true,
      run: ({ sender, args, room }) => {
        const where = room();
        const invitee = deps.resolveParticipant(args);
        if (invitee.id === sender.id) throw new QuorumError('that invitation is to yourself — you are already here');
        if (isMember(where.id, invitee.id)) throw new QuorumError(`${invitee.name} is already in #${where.name}`);
        // Rooms are joined, never assigned: the invite is an audience-scoped
        // event, and joining stays the invitee's own act. The guidance rides
        // in the payload so the delivery is self-describing (#51's shape).
        appendEvent(
          'invited',
          where.id,
          {
            room: where,
            by: sender,
            invitee,
            guidance: `${sender.name} invited you to #${where.name} — call join_room with room ${JSON.stringify(where.name)} to accept.`,
          },
          sender.id,
          [invitee.id],
        );
        return `Invited ${invitee.name} to #${where.name} — they will be woken with instructions to join.`;
      },
    },
    {
      name: 'kick',
      category: 'rooms',
      summary: 'remove a participant from this room (room owner or god-mod)',
      usage: '/kick <name|id>',
      recorded: true,
      run: ({ sender, args, room }) => {
        const where = room();
        if (sender.id !== where.createdBy && !isGod(sender)) {
          const owner = requireParticipant(where.createdBy);
          throw new QuorumError(
            `only the room owner may /kick here — #${where.name} belongs to ${owner.name}${god() ? ', and the god-mod outranks the room' : ''}`,
          );
        }
        const target = deps.resolveParticipant(args);
        if (target.id === sender.id) throw new QuorumError('you cannot kick yourself');
        if (!isMember(where.id, target.id)) throw new QuorumError(`${target.name} is not in #${where.name}`);
        db.prepare('DELETE FROM room_members WHERE room_id = ? AND participant_id = ?').run(where.id, target.id);
        appendEvent('participant_kicked', where.id, { room: where, participant: target, by: sender }, sender.id);
        return `Kicked ${target.name} from #${where.name}. They can rejoin unless banned (#54).`;
      },
    },
    {
      name: 'who',
      category: 'rooms',
      summary: 'who is in this room, in join order',
      usage: '/who',
      recorded: false,
      run: ({ room }) => {
        const where = room();
        const members = deps.listMembers({ room: where.name });
        const lines = members.map(
          (p) =>
            `${p.name} (${p.harness})${p.status ? ` — ${p.status.kind === 'blocked' ? 'BLOCKED: ' : ''}${p.status.text}` : ''}`,
        );
        return [`#${where.name} · ${members.length} member${members.length === 1 ? '' : 's'}:`, ...lines].join('\n');
      },
    },
    {
      name: 'status',
      category: 'presence',
      summary: 'set what you are doing, or bare /status to see everyone',
      usage: '/status [message]',
      recorded: (args) => args.length > 0,
      run: ({ sender, args }) => {
        if (args) return setStatus(sender, args, 'status');
        const rows = db
          .prepare('SELECT name, harness, status, status_kind FROM participants WHERE status IS NOT NULL ORDER BY status_at DESC')
          .all() as { name: string; harness: string; status: string; status_kind: string }[];
        const silent = (db.prepare('SELECT COUNT(*) AS n FROM participants WHERE status IS NULL').get() as { n: number }).n;
        const lines = rows.map((r) => `${r.name} (${r.harness}) — ${r.status_kind === 'blocked' ? 'BLOCKED: ' : ''}${r.status}`);
        if (silent > 0) lines.push(`${silent} participant${silent === 1 ? ' has' : 's have'} no status.`);
        return lines.join('\n') || 'Nobody has a status yet — /status <message> sets yours.';
      },
    },
    {
      name: 'blocked',
      category: 'presence',
      summary: 'say you are stuck and on what — shown distinctly on the roster',
      usage: '/blocked <by what>',
      recorded: true,
      run: ({ sender, args }) => {
        if (!args) throw new QuorumError('say what you are blocked by: /blocked <reason>');
        return setStatus(sender, args, 'blocked');
      },
    },
  ];

  return REGISTRY;
}
