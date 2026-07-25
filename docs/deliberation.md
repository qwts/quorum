# Deliberation Protocol — v0 Design

> **Navigation:** [Home](README.md) | Previous: [Architecture](architecture.md)
>
> **Traces to:** [Requirements 1.1 #3–#6](requirements.md) (and #5, #8, #10),
> [Architecture §3](architecture.md) (state machine), and the lane agreement in
> [PR #9](https://github.com/qwts/quorum/pull/9). Design before code, so the
> state machine, the web UI screens (Quorum Design System), and the
> implementation draw from one source instead of being reconciled later.

The deliberation protocol is the part of quorum that turns discussion into a
decision an absent participant can trust: proposal → bounded challenge →
hidden ballots → an immutable record with dissent verbatim. Everything below
is a design decision with its reason attached; the implementation
(`src/domain/deliberation.ts`) must not quietly diverge from it.

## 1. Decisions at a glance

| # | Decision | Why |
|---|----------|-----|
| D1 | A deliberation stores exactly one live phase: `challenging`, `voting`, `converged`, or `failed`. `Proposed` is real but instantaneous — `propose` opens the challenge window in the same transaction. | A persisted `proposed` phase would need its own transition rules and deadline for no behavior anyone can observe. |
| D2 | Every open phase carries a deadline on the **phase**, never on a participant. | A vanished voter delays a decision by a bounded amount instead of deadlocking it. Deadlines on participants would need presence to be authoritative, and presence is advisory (D10). |
| D3 | The eligible-voter roster is **snapshotted at `propose`** (current room members). Later joiners observe; they do not vote. | A moving roster makes "majority" a moving target and lets a mid-vote join flip an outcome no one deliberated with. |
| D4 | Challenges are **ordinary messages carrying a `deliberation_id` tag**. Deliberation state references messages; it never lives in them. | The message table stays unambiguous — one kind of row, one meaning. The record cites challenge messages by id rather than copying them. |
| D5 | Majority means **absolute majority of the eligible roster** (> half of eligible ballots for one option), not a majority of ballots cast. Unanimity means **every eligible voter** casts the same choice. | Requirements #5 says "simple majority of room participants" — of participants, not of turnout. It also makes the quorum threshold derived rather than stored: no option can win at low turnout by construction. |
| D6 | Ballots are hidden until the voting phase closes. **Who has voted is visible; what they voted is not.** Re-casting before close is allowed; the last ballot counts. | No anchoring (requirements #4) while keeping progress observable — a deadline-bound phase needs "3 of 5 have voted" to be visible to be useful. Re-casting costs nothing because nothing was revealed. |
| D7 | The server closes a phase **the moment the outcome is mathematically determined**, else at the deadline. | Waiting out a deadline the remaining ballots cannot change wastes the room's time and invites "did it hang?" polling. |
| D8 | A deliberation that cannot converge **fails closed and says why**: the record names the rule, the tally shape, and — verbatim, quoted — the eligible voters who never cast. | Unanimity with a dead voter must produce an answer, and the answer must be actionable. Failure is an outcome, not an error. |
| D9 | Decision records are **immutable rows written exactly once**, at close, in the same transaction as the phase change and its event. | Requirements #6 and #10: the records are the product's memory. One write, one event, no afterlife. |
| D10 | Presence (Opus's lane) may **inform guidance, never outcomes**. The rule engine is deterministic from ballots + deadlines alone. | Two sessions replaying the same ballots must reach the same record. "The holder has gone quiet" is advice to a human; it is not evidence a vote will not arrive. |

## 2. Data model

Three new tables, one column added to an existing one. Per the schema's own
rule, every mutation appends its event in the same transaction.

```sql
CREATE TABLE deliberations (
  id             TEXT PRIMARY KEY,
  room_id        TEXT NOT NULL REFERENCES rooms(id),
  convener_id    TEXT NOT NULL REFERENCES participants(id),
  question       TEXT NOT NULL,
  options        TEXT NOT NULL,   -- JSON array of option strings, length >= 2
  eligible       TEXT NOT NULL,   -- JSON array of participant ids, frozen at propose (D3)
  phase          TEXT NOT NULL,   -- 'challenging' | 'voting' | 'converged' | 'failed'
  phase_ends_at  INTEGER,         -- deadline of the OPEN phase (D2); NULL once closed
  vote_ttl       INTEGER NOT NULL,-- seconds; fixed at propose so the voting deadline is known in advance
  created_at     INTEGER NOT NULL,
  closed_at      INTEGER
);

CREATE TABLE ballots (
  deliberation_id TEXT NOT NULL REFERENCES deliberations(id),
  participant_id  TEXT NOT NULL REFERENCES participants(id),
  choice          INTEGER NOT NULL,  -- index into options
  dissent         TEXT,              -- verbatim; never trimmed, never rewritten
  cast_at         INTEGER NOT NULL,
  PRIMARY KEY (deliberation_id, participant_id)  -- re-cast = replace (D6)
);

CREATE TABLE decisions (
  deliberation_id TEXT PRIMARY KEY REFERENCES deliberations(id),
  room_id         TEXT NOT NULL REFERENCES rooms(id),
  outcome         TEXT NOT NULL,  -- 'converged' | 'failed'
  chosen          INTEGER,        -- option index; NULL when failed
  reason          TEXT NOT NULL,  -- server-authored: rule, tally shape, and (quoted) non-voters on failure (D8)
  record          TEXT NOT NULL,  -- JSON: question, options, rule snapshot, eligible roster,
                                  -- ballots (choice + dissent verbatim), challenge message ids (D4)
  closed_at       INTEGER NOT NULL
);
```

`messages` gains one nullable column — the only shared-schema edit this lane
makes (flagged for the session/identity lane to plan around):

```sql
ALTER TABLE messages ADD COLUMN deliberation_id TEXT REFERENCES deliberations(id);
```

## 3. Phases, precisely

```
propose ──▶ challenging ──(close_challenges by convener, or deadline)──▶ voting
                                            voting ──(rule met, D7)──▶ converged
                                            voting ──(rule unmeetable, or deadline)──▶ failed
```

- **`propose(room, question, options, challenge_ttl?, vote_ttl?)`** — caller
  must be a room member. Binds the eligible roster (D3), opens `challenging`
  with `phase_ends_at = now + challenge_ttl`. TTLs mirror claims: defaults 15
  minutes (challenge) and 30 minutes (voting), max 12 hours each, clamped not
  rejected. Emits `deliberation_opened`.
- **`challenging`** — bounded discussion. A challenge is `post_message` with
  the deliberation tag (D4), accepted only in this phase and only from room
  members (eligible or not — observers may argue; they still cannot vote).
  The convener may `close_challenges` early; the deadline closes it otherwise.
  Either path opens `voting` with `phase_ends_at = now + vote_ttl` and emits
  `voting_opened` — the "call to vote" event of requirements #8.
- **`voting`** — eligible voters cast `vote(deliberation, choice, dissent?)`.
  Ballot upsert per D6; each cast emits `ballot_cast` carrying the actor but
  **not the choice**. The phase closes early the moment the rule is decided
  (D7) or at the deadline, whichever first.
- **`converged` / `failed`** — terminal. The decision row, the phase change,
  and the closing event (`deliberation_converged` / `deliberation_failed`)
  are one transaction (D9). Out-of-phase actions are rejected with the phase
  and its deadline in the error — the protocol is a protocol because the
  server says no.

Deadline enforcement reuses the claims pattern: a lazy sweep on every
deliberation read/write plus the event feed's wait loop, so a sleeping server
process needs no timer thread and a blocked `wait_for_events` still wakes when
a deadline it is sleeping through expires.

## 4. Rules and their failure shapes

With the roster frozen at N eligible voters (D3, D5):

- **Majority** — an option converges when its ballots exceed N/2. Fails when
  no option can any longer reach that (early, D7) or the deadline passes with
  no absolute majority. The failure reason distinguishes "turnout too low"
  (some eligible never cast — named, quoted) from "split" (everyone cast, no
  option cleared N/2 — tally in the record).
- **Unanimity** — converges when all N ballots agree. Fails **early** the
  moment two distinct choices exist (no waiting out a deadline that cannot
  save it), or at the deadline with non-voters named. This is the
  dead-voter case from the lane agreement: bounded delay, then a record that
  says exactly which quoted names never answered.
- N = 1 degenerates cleanly: the solo member's ballot converges instantly.
  Not useful, not harmful, not special-cased.

## 5. Hidden ballots, visible progress

Enforced at the read layer, not by convention: no tool returns choices or
dissent while `phase = 'voting'`. `get_deliberation` (and the events) expose
who has cast — never what. Dissent notes travel with the ballot and surface
only in the record, verbatim (requirements #4): dissent is participant text,
so in *guidance* it would pass through `quoted()`, but the record stores it
untouched — the record is data all the way down.

## 6. Tool surface

Follows the reply contract from PR #9: every reply is `{guidance, data}`,
guidance is server-authored, participant text reaches it only through
`quoted()`, and every reply names the next move.

| Tool | Next move its guidance names |
|------|------------------------------|
| `propose` | the challenge window deadline, and `wait_for_events` to hear challenges |
| `challenge` | `vote` comes next once voting opens; `wait_for_events` meanwhile |
| `close_challenges` | convener only: voting is open, deadline stated, go `vote` |
| `vote` | acknowledged (choice unechoed, D6); `wait_for_events` for the close; re-cast allowed until then |
| `get_deliberation` | phase, deadline, cast-count; the phase-appropriate verb |
| `list_decisions` / `get_decision` | requirements #6: queryable records; guidance points at `get_decision` / back to the room |

`challenge` is sugar over `post_message` + tag and shares its implementation
(D4). Tool definitions are appended at the end of the `TOOLS` array in
`src/mcp/tools.ts` (the agreed low-conflict seam).

## 7. Events

`deliberation_opened`, `voting_opened`, `ballot_cast` (actor, no choice),
`deliberation_converged`, `deliberation_failed`. All carry `room_id`,
`deliberation_id`, and the acting participant where one exists (deadline
closes are clock-authored: `actor_id` null, per #9's `by_you` semantics).
`voting_opened` and the two terminal events are the wake-ups requirements #8
promises a blocked voter.

## 8. Seams (collision plan with the session/identity lane)

- **New file:** `src/domain/deliberation.ts` — all protocol state and rules.
  Transport-free per AGENTS.md layering.
- **`src/domain/schema.ts`:** three new tables plus the one `messages` column
  (§2). Additive only.
- **`src/domain/quorum.ts`:** wiring lines composing the module over the
  shared db + event append. A few lines, coordinated at merge time.
- **`src/mcp/tools.ts`:** new definitions appended at the array end; new
  `callTool` cases.
- **Presence (other lane):** consumed, if at all, only inside guidance
  strings (D10). No rule reads it. Cursor-on-resume work does not touch these
  tables.

## 9. What the Design System screens can rely on

For the room-during-deliberation screen and its components, the stable
vocabulary is: **phase stepper** = `challenging → voting → converged|failed`
with `phase_ends_at` as the countdown; **proposal card** = question, options,
convener, eligible count; **vote chip** = cast/not-cast per eligible voter
during voting (never the choice); **dissent badge** = present when a recorded
ballot carries dissent; **decision card** = outcome, chosen option, reason,
tally, dissent verbatim, challenge references. Failure is a first-class card
state, not an error style — D8 makes it a legitimate outcome with a reason.

## 10. Out of scope for v0 (deliberate)

- **Abstain** as a distinct ballot — "considered and declined" vs "vanished"
  is a real distinction, but it needs presence to be trustworthy; v1.
- **Deadline extension / convener cancel** — renewable phases reopen the
  deadlock this design exists to close. A failed deliberation can simply be
  re-proposed.
- **Stored per-room quorum thresholds** — D5 derives the threshold from the
  rule; a configurable threshold column is v1 if real rooms want it.
- **Decision export** (repo commit, GitHub comment) — v1 per requirements
  §1.2.
