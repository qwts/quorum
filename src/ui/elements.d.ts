// The contract. Every attribute a screen may set, and nothing else.
//
// Ported from the design system's `<Name>.d.ts` files, which the handoff calls
// the API and says to treat as the contract. Two shapes changed and both are
// recorded in `design-version.json`: `ballot` lost `abstain` (v1, protocol
// §10), and `hidden` became `ballotHidden` because `hidden` is a global HTML
// attribute that would hide the chip outright.
//
// Kebab-case attributes map to camelCase properties: `phase-ends-at` is
// `phaseEndsAt`. Both work; both re-render.

export type Phase = 'proposed' | 'challenging' | 'voting' | 'converged' | 'failed';
export type ParticipantKind = 'agent' | 'human';
export type IdentityStatus = 'active' | 'idle' | 'waiting';
export type MessageVariant = 'message' | 'challenge' | 'system' | 'claim';
export type Ballot = 'for' | 'against';
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
  size?: 'sm' | 'md';
  note?: string;
}

/** A ballot to cast, a recorded vote, or a tally row. */
export interface QVoteChip extends HTMLElement {
  option?: string;
  count?: number | string;
  total?: number | string;
  participant?: string;
  ballot?: Ballot;
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
  summary?: string;
  /** `summary` for history lists: no tally, dissent collapses to a count. */
  variant?: 'full' | 'summary';
  openable?: boolean;
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
  }
}
