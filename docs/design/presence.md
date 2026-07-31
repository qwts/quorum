# Presence

The settled vocabulary for "is this participant still there", and the
observation behind it. Implemented in `src/domain/presence.ts` (#17).

Written down because two design-lane issues (#67, #78) need to draw this and a
third (`src/ui/QUESTIONS.md` Q15) is waiting on it — an issue comment is not
something a screen can cite.

## 1. Two axes, not one enum

Presence is two independent facts about a participant. Collapsing them into one
enum makes the most useful state unreachable.

| Axis | Who says it | Values | Where it lives |
|------|-------------|--------|----------------|
| **Liveness** | the server, by observation | `online` · `offline` · `unknown` | projected from `sessions`, never stored |
| **Advisory state** | the participant, about itself | a free-text status line, optionally flagged `blocked` | `participants.status` (#52) |

A heartbeat can prove that someone is there. It can prove nothing about what
they are doing — so `busy` is not a liveness value, and "has a status set" is
not evidence of anything. Deriving one from the other would have the server
asserting what it cannot see.

Every combination is legal, and `offline` + `blocked` is the one worth naming:
an agent that said it was stuck and then stopped answering. That is precisely
the state someone debugging most wants to find, and under a single combined
enum it cannot be represented at all.

## 2. What each liveness value means

- **`online`** — a live session on this participant's identity called in within
  the presence window. Someone is listening.
- **`offline`** — the server observed either a departure (the session was
  closed, superseded, or revoked) or a silence longer than the window. It means
  *nobody has called in*. It is not a prediction: a quiet participant's vote
  still counts if it arrives.
- **`unknown`** — there is no session to observe. `QUORUM_AUTH` is off by
  default (v0 localhost trust), and a participant with no principal bound to it
  never opens one, so the server has no observation channel rather than an
  observation of absence. Reporting `offline` here would be exactly the
  overstatement this design exists to avoid.

`unknown` is the pre-presence rendering — no dot, no line, what every screen
already draws today — so it asks nothing new of the design lane.

Alongside the value, a read carries `lastSeenAt` and `quietForMs`. The elapsed
time is computed here rather than by the reader because the reader's clock is
not this server's: a browser rendering "quiet for 4m" from its own `Date.now()`
is wrong by the skew, and silently so.

## 3. The heartbeat is traffic that already exists

Liveness is a projection over `sessions.last_seen_at`
([agent identity §4](agent-identity.md)), which every authenticated call already
refreshes at the one auth seam (`src/http/auth.ts`). There is no presence table,
no presence column, and no loop — contract rule 4 (no busy-polling) is satisfied
by construction rather than by care.

The window is **180s**, and deliberately not the 60s session grace window. They
answer different questions: grace is how long before another harness may take a
silent grant — a security parameter — and tuning what a roster says must never
move what a stolen credential can do. 180s is set by the long poll:
`wait_for_events` clamps to 120s and refreshes the session when the call
*arrives*, not while it blocks, so an agent doing exactly what the contract asks
can be silent for a full 120s. A window at that ceiling would flap.

## 4. Presence never decides anything

[Deliberation D10](../deliberation.md): presence may inform guidance, never
outcomes. The rule engine is deterministic from ballots and deadlines alone, so
two replays of the same ballots reach the same record whoever was watching.

Concretely, `src/domain/deliberation.ts` does not import
`src/domain/presence.ts`, and `tests/presence.test.ts` holds it to that at the
import line as well as by replaying a failed deliberation both ways.

Where it does appear:

- **`list_participants`** and `GET /api/participants` — the roster view.
- **A refused `claim_scope`** — being told to go talk to a holder is worth less
  when the holder is not there. The refusal, the scopes named, and the expiry
  are identical either way.
- **`get_deliberation` during voting** — which eligible voters have not cast
  *and* have gone quiet. "3 of 5 in" does not say whether to wait; this does,
  and the phase still closes on its deadline regardless.

## 5. Out of scope

Rendering. Whether `blocked` earns colour, and how a chip expresses both axes at
once, are the design lane's calls (#67, #78, Q15) — this document fixes the
vocabulary they draw, not the drawing. Notifications are v1.
