// The deliberation protocol: propose → challenge → vote → converge/fail
// (docs/deliberation.md, D1–D10; requirements 1.1 #3–#6).
//
// Transport-free like the rest of src/domain/. This module owns every
// protocol rule; quorum.ts composes it over the shared database and event
// feed, so the seam between the two is the `Deps` object below and nothing
// else. Phase transitions are server-enforced — out-of-phase actions are
// rejected naming the phase and its deadline, which is what makes the
// protocol a protocol rather than a convention.

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { QuorumError } from './errors.ts';
import type { DecisionRule, Participant, Room } from './quorum.ts';

export type DeliberationPhase = 'challenging' | 'voting' | 'converged' | 'failed';
export type FailureKind = 'rule_unmet' | 'quorum_absent';

export type Deliberation = {
  id: string;
  roomId: string;
  convenerId: string;
  question: string;
  options: string[];
  eligible: string[];
  phase: DeliberationPhase;
  phaseEndsAt: number | null;
  createdAt: number;
  closedAt: number | null;
};

// The public view while a deliberation is open: who has cast is visible,
// what they cast is not (D6). Choices and dissent exist nowhere in it.
export type DeliberationView = Deliberation & {
  rule: DecisionRule;
  cast: string[]; // participant ids that have a ballot in
};

export type DecisionSummary = {
  deliberationId: string;
  roomId: string;
  outcome: 'converged' | 'failed';
  chosen: number | null;
  failureKind: FailureKind | null;
  reason: string;
  question: string;
  closedAt: number;
};

export type DecisionRecord = DecisionSummary & {
  options: string[];
  rule: DecisionRule;
  eligible: { id: string; name: string }[];
  ballots: { participantId: string; name: string; choice: number; dissent: string | null }[];
  tally: number[];
  challengeMessageIds: number[];
};

// Everything the protocol needs from the host domain, and nothing more.
export type Deps = {
  db: DatabaseSync;
  now: () => number;
  appendEvent: (
    kind: string,
    roomId: string | null,
    payload: Record<string, unknown>,
    actorId: string | null,
  ) => void;
  requireParticipant: (id: string) => Participant;
  /** A caller's reference, resolved inside that caller's visible set (ADR-0002 §6). */
  requireRoom: (ref: string, viewer?: string | null) => Room;
  /** An id this server stored — a deliberation's own room — resolved unscoped. */
  roomById: (id: string) => Room;
  isMember: (roomId: string, participantId: string) => boolean;
};

const DEFAULT_CHALLENGE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_VOTE_TTL_MS = 30 * 60 * 1000;
const MAX_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_OPTIONS = 10;
const MAX_OPTION_LENGTH = 200;
const MAX_QUESTION_LENGTH = 500;

// Clamped, not rejected (docs/deliberation.md §3): a bad TTL becomes the
// default, an oversized one becomes the maximum. A deliberation should not
// fail to open over a malformed knob.
function clampTtl(seconds: number | undefined, defaultMs: number): number {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return defaultMs;
  return Math.min(Math.round(seconds * 1000), MAX_TTL_MS);
}

type DeliberationRow = {
  id: string;
  room_id: string;
  convener_id: string;
  question: string;
  options: string;
  eligible: string;
  phase: DeliberationPhase;
  phase_ends_at: number | null;
  vote_ttl: number;
  created_at: number;
  closed_at: number | null;
};

type BallotRow = {
  deliberation_id: string;
  participant_id: string;
  choice: number;
  dissent: string | null;
  cast_at: number;
};

export function openDeliberations(deps: Deps) {
  const { db, now, appendEvent, requireParticipant, requireRoom, roomById, isMember } = deps;

  function toDeliberation(row: DeliberationRow): Deliberation {
    return {
      id: row.id,
      roomId: row.room_id,
      convenerId: row.convener_id,
      question: row.question,
      options: JSON.parse(row.options) as string[],
      eligible: JSON.parse(row.eligible) as string[],
      phase: row.phase,
      phaseEndsAt: row.phase_ends_at,
      createdAt: row.created_at,
      closedAt: row.closed_at,
    };
  }

  function requireDeliberation(id: string): DeliberationRow {
    const row = db.prepare('SELECT * FROM deliberations WHERE id = ?').get(id) as DeliberationRow | undefined;
    if (!row) throw new QuorumError(`unknown deliberation: ${JSON.stringify(id)}`);
    return row;
  }

  function ballotsFor(deliberationId: string): BallotRow[] {
    return db
      .prepare('SELECT * FROM ballots WHERE deliberation_id = ? ORDER BY cast_at')
      .all(deliberationId) as BallotRow[];
  }

  function participantName(id: string): string {
    const row = db.prepare('SELECT name FROM participants WHERE id = ?').get(id) as { name: string } | undefined;
    return row?.name ?? id;
  }

  function tallyOf(options: string[], ballots: BallotRow[]): number[] {
    const tally = options.map(() => 0);
    for (const ballot of ballots) tally[ballot.choice] = (tally[ballot.choice] ?? 0) + 1;
    return tally;
  }

  // The rule engine (D5, D7, D8): outcome from ballots and the frozen roster
  // alone — presence, timing, and everything else advisory never reaches it
  // (D10). `quorum_absent` iff the absentees were decisive: some completion
  // of the missing ballots could have satisfied the rule.
  function computeOutcome(
    rule: DecisionRule,
    options: string[],
    eligible: string[],
    ballots: BallotRow[],
  ): { outcome: 'converged'; chosen: number } | { outcome: 'failed'; failureKind: FailureKind } {
    const n = eligible.length;
    const missing = n - ballots.length;
    const tally = tallyOf(options, ballots);

    if (rule === 'majority') {
      const best = Math.max(...tally);
      if (best > n / 2) return { outcome: 'converged', chosen: tally.indexOf(best) };
      // Could the missing ballots, all landing on the strongest option, have
      // produced an absolute majority?
      if (missing > 0 && best + missing > n / 2) return { outcome: 'failed', failureKind: 'quorum_absent' };
      return { outcome: 'failed', failureKind: 'rule_unmet' };
    }

    // Unanimity: every eligible ballot exists and agrees. A disagreement is
    // never final before close — a voter may re-cast (D6) — but at close it
    // is rule_unmet, because no completion of *missing* ballots repairs a
    // split among the cast ones.
    const distinct = new Set(ballots.map((ballot) => ballot.choice));
    if (distinct.size === 1 && missing === 0) return { outcome: 'converged', chosen: ballots[0]!.choice };
    if (distinct.size <= 1 && missing > 0) return { outcome: 'failed', failureKind: 'quorum_absent' };
    return { outcome: 'failed', failureKind: 'rule_unmet' };
  }

  // Server-authored failure prose (D8). Non-voter names are participant text,
  // so they are JSON-quoted at this throw-... write-site, same discipline as
  // every other interpolation of participant values into server output.
  function failureReason(
    kind: FailureKind,
    rule: DecisionRule,
    eligible: string[],
    ballots: BallotRow[],
    tally: number[],
  ): string {
    if (kind === 'quorum_absent') {
      const cast = new Set(ballots.map((ballot) => ballot.participant_id));
      const absent = eligible.filter((id) => !cast.has(id)).map((id) => JSON.stringify(participantName(id)));
      return (
        `Quorum absent at close — ${ballots.length} of ${eligible.length} ballots, and the missing ` +
        `ballots could have met the ${rule} rule. Never cast: ${absent.join(', ')}.`
      );
    }
    return (
      `Rule unmet at close — the ${rule} rule could not be satisfied by any completion of the ` +
      `ballots. Tally: [${tally.join(', ')}] of ${eligible.length} eligible.`
    );
  }

  // Close is the single write moment (D9): phase change, decision row, and
  // closing event commit together or not at all.
  function close(row: DeliberationRow, actorId: string | null): void {
    const options = JSON.parse(row.options) as string[];
    const eligible = JSON.parse(row.eligible) as string[];
    const room = roomById(row.room_id);
    const ballots = ballotsFor(row.id);
    const tally = tallyOf(options, ballots);
    const result = computeOutcome(room.decisionRule, options, eligible, ballots);
    const at = now();

    const reason =
      result.outcome === 'converged'
        ? `Converged on option ${result.chosen} by ${room.decisionRule} — ${tally[result.chosen]} of ${eligible.length}.`
        : failureReason(result.failureKind, room.decisionRule, eligible, ballots, tally);

    const record: DecisionRecord = {
      deliberationId: row.id,
      roomId: row.room_id,
      outcome: result.outcome,
      chosen: result.outcome === 'converged' ? result.chosen : null,
      failureKind: result.outcome === 'failed' ? result.failureKind : null,
      reason,
      question: row.question,
      options,
      rule: room.decisionRule,
      eligible: eligible.map((id) => ({ id, name: participantName(id) })),
      ballots: ballots.map((ballot) => ({
        participantId: ballot.participant_id,
        name: participantName(ballot.participant_id),
        choice: ballot.choice,
        dissent: ballot.dissent,
      })),
      tally,
      challengeMessageIds: (
        db.prepare('SELECT id FROM messages WHERE deliberation_id = ? ORDER BY id').all(row.id) as {
          id: number;
        }[]
      ).map((message) => message.id),
      closedAt: at,
    };

    const phase: DeliberationPhase = result.outcome;
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE deliberations SET phase = ?, phase_ends_at = NULL, closed_at = ? WHERE id = ?').run(
        phase,
        at,
        row.id,
      );
      db.prepare(
        `INSERT INTO decisions (deliberation_id, room_id, outcome, chosen, failure_kind, reason, record, closed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(row.id, row.room_id, record.outcome, record.chosen, record.failureKind, reason, JSON.stringify(record), at);
      appendEvent(
        result.outcome === 'converged' ? 'deliberation_converged' : 'deliberation_failed',
        row.room_id,
        { deliberationId: row.id, outcome: record.outcome, chosen: record.chosen, failureKind: record.failureKind, reason },
        actorId,
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function openVoting(row: DeliberationRow, actorId: string | null): void {
    // The voting window opens when the transition actually happens, not when
    // it was scheduled: a server asleep through the challenge deadline must
    // not eat the voters' window (deliberation.md §3).
    const endsAt = now() + row.vote_ttl;
    // Same discipline as close(): the phase change and the call-to-vote event
    // commit together or not at all — a voting phase nobody was told about is
    // a lost 1.1 #8 promise.
    db.exec('BEGIN');
    try {
      db.prepare("UPDATE deliberations SET phase = 'voting', phase_ends_at = ? WHERE id = ?").run(endsAt, row.id);
      appendEvent(
        'voting_opened',
        row.room_id,
        { deliberationId: row.id, question: row.question, phaseEndsAt: endsAt },
        actorId,
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  // Lazy deadline sweep, same pattern as claims: deadlines are computed at
  // read time, and the transition each one owes — voting opening, a close —
  // happens on the next touch. wait_for_events wakes on the nearest deadline
  // (nextDeadline below), so a blocked voter is woken by the call to vote
  // (requirements 1.1 #8) without a timer thread existing.
  function sweep(): void {
    const at = now();
    const dueChallenge = db
      .prepare("SELECT * FROM deliberations WHERE phase = 'challenging' AND phase_ends_at <= ?")
      .all(at) as DeliberationRow[];
    for (const row of dueChallenge) openVoting(row, null); // the clock did it
    const dueVoting = db
      .prepare("SELECT * FROM deliberations WHERE phase = 'voting' AND phase_ends_at <= ?")
      .all(at) as DeliberationRow[];
    for (const row of dueVoting) close(row, null);
  }

  function nextDeadline(): number | null {
    const row = db
      .prepare("SELECT MIN(phase_ends_at) AS next FROM deliberations WHERE phase IN ('challenging','voting')")
      .get() as { next: number | null } | undefined;
    return row?.next ?? null;
  }

  function phaseError(row: DeliberationRow, wanted: string): QuorumError {
    const deadline = row.phase_ends_at === null ? '' : ` until ${new Date(row.phase_ends_at).toISOString()}`;
    return new QuorumError(
      `deliberation ${JSON.stringify(row.id)} is in phase '${row.phase}'${deadline} — ${wanted}`,
    );
  }

  return {
    sweep,
    nextDeadline,

    propose(input: {
      participantId: string;
      room: string;
      question: string;
      options: string[];
      challengeTtlSeconds?: number;
      voteTtlSeconds?: number;
    }): Deliberation {
      sweep();
      const convener = requireParticipant(input.participantId);
      const room = requireRoom(input.room, convener.id);
      if (!isMember(room.id, convener.id)) {
        throw new QuorumError(`join ${JSON.stringify(room.name)} before proposing in it`);
      }
      const question = input.question?.trim();
      if (!question) throw new QuorumError('question is required');
      if (question.length > MAX_QUESTION_LENGTH) {
        throw new QuorumError(`question must not exceed ${MAX_QUESTION_LENGTH} characters`);
      }
      const options = (input.options ?? []).map((option) => option?.trim()).filter(Boolean) as string[];
      if (options.length < 2) throw new QuorumError('at least two distinct options are required');
      if (options.length > MAX_OPTIONS) throw new QuorumError(`at most ${MAX_OPTIONS} options are allowed`);
      if (options.some((option) => option.length > MAX_OPTION_LENGTH)) {
        throw new QuorumError(`options must not exceed ${MAX_OPTION_LENGTH} characters`);
      }
      if (new Set(options).size !== options.length) throw new QuorumError('options must be distinct');

      // The roster freezes now (D3): current room members deliberate; later
      // joiners observe. A moving roster would make the rule a moving target.
      const eligible = (
        db.prepare('SELECT participant_id FROM room_members WHERE room_id = ? ORDER BY joined_at').all(room.id) as {
          participant_id: string;
        }[]
      ).map((member) => member.participant_id);

      const at = now();
      const deliberation: Deliberation = {
        id: randomUUID(),
        roomId: room.id,
        convenerId: convener.id,
        question,
        options,
        eligible,
        phase: 'challenging',
        phaseEndsAt: at + clampTtl(input.challengeTtlSeconds, DEFAULT_CHALLENGE_TTL_MS),
        createdAt: at,
        closedAt: null,
      };
      db.prepare(
        `INSERT INTO deliberations (id, room_id, convener_id, question, options, eligible, phase, phase_ends_at, vote_ttl, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        deliberation.id,
        deliberation.roomId,
        deliberation.convenerId,
        deliberation.question,
        JSON.stringify(deliberation.options),
        JSON.stringify(deliberation.eligible),
        deliberation.phase,
        deliberation.phaseEndsAt,
        clampTtl(input.voteTtlSeconds, DEFAULT_VOTE_TTL_MS),
        deliberation.createdAt,
      );
      appendEvent(
        'deliberation_opened',
        room.id,
        // deliberationId at the top level: §7 promises the common field on
        // every deliberation event, so feed consumers correlate without
        // knowing each payload's inner shape.
        { deliberationId: deliberation.id, deliberation, by: convener.name },
        convener.id,
      );
      return deliberation;
    },

    // Challenges are ordinary messages tagged to the deliberation (D4); the
    // message insert itself lives in postMessage. This assertion is the only
    // protocol involvement: right room, right phase.
    assertChallengeOpen(deliberationId: string, roomId: string): void {
      sweep();
      const row = requireDeliberation(deliberationId);
      if (row.room_id !== roomId) {
        throw new QuorumError("challenge must be posted in the deliberation's own room");
      }
      if (row.phase !== 'challenging') throw phaseError(row, 'challenges are closed');
    },

    closeChallenges(input: { participantId: string; deliberationId: string }): Deliberation {
      sweep();
      requireParticipant(input.participantId);
      const row = requireDeliberation(input.deliberationId);
      if (row.phase !== 'challenging') throw phaseError(row, 'there is no challenge window to close');
      if (row.convener_id !== input.participantId) {
        throw new QuorumError('only the convener can close challenges early — the deadline closes them otherwise');
      }
      openVoting(row, input.participantId);
      return toDeliberation(requireDeliberation(row.id));
    },

    // A ballot upserts until close (D6). Every cast — first or re-cast —
    // announces the actor and never the choice. The final eligible ballot
    // closes the phase (D7): everyone has spoken, so the deadline has nothing
    // left to wait for.
    vote(input: { participantId: string; deliberationId: string; choice: number; dissent?: string }): {
      deliberation: Deliberation;
      cast: number;
      eligible: number;
    } {
      sweep();
      const voter = requireParticipant(input.participantId);
      let row = requireDeliberation(input.deliberationId);
      if (row.phase === 'challenging') throw phaseError(row, 'voting has not opened yet');
      if (row.phase !== 'voting') throw phaseError(row, 'voting has closed');
      const eligible = JSON.parse(row.eligible) as string[];
      if (!eligible.includes(voter.id)) {
        throw new QuorumError(
          'only participants who were in the room at propose may vote — later joiners observe (D3)',
        );
      }
      const options = JSON.parse(row.options) as string[];
      if (!Number.isInteger(input.choice) || input.choice < 0 || input.choice >= options.length) {
        throw new QuorumError(`choice must be an option index between 0 and ${options.length - 1}`);
      }
      db.prepare(
        `INSERT INTO ballots (deliberation_id, participant_id, choice, dissent, cast_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (deliberation_id, participant_id)
         DO UPDATE SET choice = excluded.choice, dissent = excluded.dissent, cast_at = excluded.cast_at`,
      ).run(row.id, voter.id, input.choice, input.dissent ?? null, now());

      const cast = ballotsFor(row.id).length;
      appendEvent(
        'ballot_cast',
        row.room_id,
        { deliberationId: row.id, by: voter.name, cast, eligible: eligible.length },
        voter.id,
      );
      if (cast === eligible.length) close(row, voter.id);
      row = requireDeliberation(input.deliberationId);
      return { deliberation: toDeliberation(row), cast, eligible: eligible.length };
    },

    // Who has cast is visible; what they cast is not (D6). Choices and
    // dissent are unreachable through this view while the phase is open —
    // they surface only in the record.
    getDeliberation(input: { deliberationId: string }): DeliberationView {
      sweep();
      const row = requireDeliberation(input.deliberationId);
      const room = roomById(row.room_id);
      return {
        ...toDeliberation(row),
        rule: room.decisionRule,
        cast: ballotsFor(row.id).map((ballot) => ballot.participant_id),
      };
    },

    // The room's open deliberations, in the same view getDeliberation gives:
    // who has cast is visible, choices and dissent are not (D6). Plural
    // because propose refuses many things but not a second live deliberation
    // in a room; soonest deadline first, because that is the phase a late
    // arrival has the least time left to meet.
    listOpenDeliberations(input: { room: string; viewerId?: string | null }): DeliberationView[] {
      sweep();
      const room = requireRoom(input.room, input.viewerId ?? null);
      const rows = db
        .prepare(
          "SELECT * FROM deliberations WHERE room_id = ? AND phase IN ('challenging','voting') ORDER BY phase_ends_at",
        )
        .all(room.id) as DeliberationRow[];
      return rows.map((row) => ({
        ...toDeliberation(row),
        rule: room.decisionRule,
        cast: ballotsFor(row.id).map((ballot) => ballot.participant_id),
      }));
    },

    listDecisions(input: { room?: string; viewerId?: string | null } = {}): DecisionSummary[] {
      sweep();
      const roomId = input.room ? requireRoom(input.room, input.viewerId ?? null).id : null;
      const rows = (
        roomId
          ? db.prepare('SELECT * FROM decisions WHERE room_id = ? ORDER BY closed_at DESC').all(roomId)
          : db.prepare('SELECT * FROM decisions ORDER BY closed_at DESC').all()
      ) as {
        deliberation_id: string;
        room_id: string;
        outcome: 'converged' | 'failed';
        chosen: number | null;
        failure_kind: FailureKind | null;
        reason: string;
        record: string;
        closed_at: number;
      }[];
      return rows.map((row) => ({
        deliberationId: row.deliberation_id,
        roomId: row.room_id,
        outcome: row.outcome,
        chosen: row.chosen,
        failureKind: row.failure_kind,
        reason: row.reason,
        question: (JSON.parse(row.record) as DecisionRecord).question,
        closedAt: row.closed_at,
      }));
    },

    getDecision(input: { deliberationId: string }): DecisionRecord {
      sweep();
      const row = db.prepare('SELECT record FROM decisions WHERE deliberation_id = ?').get(input.deliberationId) as
        | { record: string }
        | undefined;
      if (!row) {
        throw new QuorumError(
          `no decision record for ${JSON.stringify(input.deliberationId)} — it has not closed, or never existed`,
        );
      }
      return JSON.parse(row.record) as DecisionRecord;
    },
  };
}

export type Deliberations = ReturnType<typeof openDeliberations>;
