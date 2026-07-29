// The contract. Every attribute a screen may set, and nothing else.
//
// Ported from the design system's `<Name>.d.ts` files, which the handoff calls
// the API and says to treat as the contract. One shape differs, and it is
// recorded in `design-version.json`: `hidden` became `ballotHidden`, because
// `hidden` is a global HTML attribute that would hide the chip outright.
//
// The `ballot` union is gone rather than narrowed. A v0 ballot is an option
// index, never a stance (deliberation.md §6) — "add it now" versus "defer to
// v1" has no against — so `choice` replaces it upstream and the delta that
// used to record the difference is closed.
//
// Kebab-case attributes map to camelCase properties: `phase-ends-at` is
// `phaseEndsAt`. Both work; both re-render.

export type Phase = 'proposed' | 'challenging' | 'voting' | 'converged' | 'failed';
export type ParticipantKind = 'agent' | 'human';
export type IdentityStatus = 'active' | 'idle' | 'waiting';
export type MessageVariant = 'message' | 'challenge' | 'system' | 'claim';
export type FailureKind = 'rule_unmet' | 'quorum_absent';

/** Participant identity token — the `(name, harness)` pair, hue-stable across reconnects. */
export interface QIdentityChip extends HTMLElement {
  name: string;
  /** The tool the agent runs in, e.g. `claude-code`. Omit for humans. */
  harness?: string;
  /** Humans are first-class participants: square dot, neutral hue. */
  kind?: ParticipantKind;
  repo?: string;
  branch?: string;
  /** `sm` drops the harness label — use inside message headers and tallies. */
  size?: 'sm' | 'md';
  /** `waiting` pulses the dot: the agent is blocked in `wait_for_events`. */
  status?: IdentityStatus;
}

/** One row of a room stream or DM thread. Attach a card by slotting it as a child. */
export interface QMessageRow extends HTMLElement {
  name?: string;
  harness?: string;
  kind?: ParticipantKind;
  /** Participant-authored text. Rendered as text, always. */
  body: string;
  time?: string;
  /** Event seq from the bus. Absent on a private row, because no event carried it. */
  seq?: number | string;
  variant?: MessageVariant;
  /** Uppercase mono tag, e.g. `challenge`, `claim granted`. */
  label?: string;
  /** Consecutive message from the same participant: drops the header. */
  compact?: boolean;
  /** `private` marks a row only this caller can see. Never dress one as shared history. */
  visibility?: 'room' | 'private';
  unread?: boolean;
}

/** The four server-enforced phases as a rail. `Failed` replaces the terminal step. */
export interface QPhaseStepper extends HTMLElement {
  phase?: Phase;
  /** Typed failure kind, printed inside the Failed step — four states, no fifth box. */
  failureKind?: FailureKind;
  size?: 'sm' | 'md';
  note?: string;
}

/** A ballot to cast, a ballot already cast, or a tally row. */
export interface QVoteChip extends HTMLElement {
  /** Option index, as stored in the ballot. Drawn as a mono `[0]` prefix. */
  choice?: number;
  /** Voting: this eligible voter has not cast yet. Cast status is public; the choice is not. */
  pending?: boolean;
  option?: string;
  count?: number | string;
  total?: number | string;
  participant?: string;
  /** Voting phase: the ballot exists, its content does not show. */
  ballotHidden?: boolean;
  /** Override the tone, e.g. with `identityHue(name, harness)`. */
  hue?: string;
  selected?: boolean;
  /** Marks a ballot that carried dissent. Render the note with `<q-dissent-badge>`. */
  dissent?: boolean;
  /** Makes the chip a real button that dispatches `select`. */
  interactive?: boolean;
  size?: 'sm' | 'md';
}

/** Dissent recorded verbatim — violet, never red, never truncated. */
export interface QDissentBadge extends HTMLElement {
  name?: string;
  harness?: string;
  /** The note, verbatim. */
  note?: string;
  /** `inline` on dark UI, `paper` inside a record, `count` for the summary pill. */
  variant?: 'inline' | 'paper' | 'count';
  count?: number | string;
}

export interface ProposalOption {
  option: string;
  count?: number;
  total?: number;
  /** True during voting: the option is listed, the tally is not. */
  hidden?: boolean;
}

/** The head of a live deliberation. Dispatches `action` and `select`. */
export interface QProposalCard extends HTMLElement {
  question: string;
  detail?: string;
  options?: ProposalOption[];
  phase?: Phase;
  /** Size of the roster frozen at convene — what quorum is measured against (D3). */
  eligible?: number;
  /** Wall clock the roster froze at, e.g. `14:05`. */
  eligibleAt?: string;
  /** Live room membership. Pass when it differs: the card names both and says which binds. */
  roomMembers?: number;
  convener?: string;
  convenerHarness?: string;
  convenerKind?: ParticipantKind;
  /** Enforced, not advisory. */
  decisionRule?: string;
  /** Derived from the roster frozen at convene — never typed by hand. */
  quorum?: string;
  /** The open phase's deadline. Every phase carries one. */
  phaseEndsAt?: string;
  challengeCount?: number | string;
  votesCast?: number | string;
  totalVoters?: number | string;
  selectedOption?: string;
  /** Makes the option chips selectable. */
  selectable?: boolean;
  /** Set only for the action the current phase allows. */
  actionLabel?: string;
  compact?: boolean;
}

export interface DecisionOptionResult {
  option: string;
  count: number;
  /** Revealed only after close. */
  voters?: string[];
}

export interface RecordedDissent {
  name: string;
  harness?: string;
  note: string;
}

/** The immutable outcome snapshot. There is no edit affordance, by design. */
export interface QDecisionCard extends HTMLElement {
  /** The record's citation number, e.g. `dr_0f31`. Not the element's HTML id. */
  recordId?: string;
  question: string;
  /** The option that won. Omit for a failure record. */
  outcome?: string;
  result?: 'converged' | 'failed';
  /** Typed reason, so the card never parses prose. Expiry is not a kind. */
  failureKind?: FailureKind;
  decidedAt?: string;
  room?: string;
  decisionRule?: string;
  options?: DecisionOptionResult[];
  /** Everyone in the frozen roster who never cast. Named in the expanded record. */
  silent?: string[];
  dissents?: RecordedDissent[];
  /** Server-authored prose: the rule, the tally shape, and the non-voters on failure. */
  reason?: string;
  /** Deprecated alias for `reason`. */
  summary?: string;
  /** Message seqs of the challenges the record cites (D4) — references, never copies. */
  challengeRefs?: (string | number)[];
  /** `summary` for history lists: no tally, dissent collapses to a count. */
  variant?: 'full' | 'summary';
  openable?: boolean;
}

/** A labelled secondary action beside the field — `propose`, `claim`, `attach a record`. */
export interface ComposerAction {
  /** Always a word. An icon never appears alone here. */
  label: string;
  /** Optional already-rendered glyph — the design system ships no icon set. */
  icon?: Node;
  /** Brass label. At most one action per composer. */
  accent?: boolean;
  /** Called on click. A screen may listen for the `action` event instead. */
  onClick?: () => void;
}

/**
 * The participant's one input: room stream, DM thread and the challenge window
 * all use this and nothing else.
 *
 * It posts a **message** and never casts a ballot — that is `q-vote-chip`. A
 * stance typed here during the challenge phase would be public voting, after
 * which hidden ballots protect nothing (deliberation.md §6).
 *
 * Fires `send` (`detail.value`) and `action` (`detail.label`). The draft is the
 * `value` property, never an attribute; the screen clears it once the server
 * has the message, so a failed post does not eat what was typed.
 */
export interface QComposer extends HTMLElement {
  /** The draft. Read it on `send`; set it to `''` once the post lands. */
  value: string;
  /** Sentence case, names the destination: `Message #protocol`, `Message Dana`. */
  placeholder?: string;
  /** Mono footnote. Defaults to the keyboard hint, or the considerations rule when `phase` is `challenging`. */
  hint?: string;
  /** Set only while a deliberation is open. Draws the phase word in its hue and a hued top edge. */
  phase?: Phase;
  /** Deadline as the server reports it, e.g. `14:35`. */
  phaseEndsAt?: string;
  /** A response the room did not see — a claim refusal, a rejected post. Drawn as a private row. */
  notice?: string;
  /** No posting rights, or nothing to post into. */
  disabled?: boolean;
  /** Ship this whenever `disabled`: say the limit out loud, ending in the next action. */
  disabledReason?: string;
  /** Field height in rows. 2 in a stream, 3 in the challenge window. */
  rows?: number;
  actions?: ComposerAction[];
}

declare global {
  interface HTMLElementTagNameMap {
    'q-identity-chip': QIdentityChip;
    'q-message-row': QMessageRow;
    'q-phase-stepper': QPhaseStepper;
    'q-vote-chip': QVoteChip;
    'q-dissent-badge': QDissentBadge;
    'q-proposal-card': QProposalCard;
    'q-decision-card': QDecisionCard;
    'q-composer': QComposer;
  }
}
