// The Quorum UI library — one import, eight components, no build step.
//
//   <link rel="stylesheet" href="/ui/styles.css">
//   <script type="module" src="/ui/index.js"></script>
//
// Importing this module registers every component. After that a screen is
// plain HTML: `<q-message-row name="…" body="…">`. Nothing here needs a
// bundler, a transpiler, or a framework — see README.md for why that was a
// decision rather than an omission.

import './components/identity-chip.js';
import './components/message-row.js';
import './components/phase-stepper.js';
import './components/vote-chip.js';
import './components/dissent-badge.js';
import './components/proposal-card.js';
import './components/decision-card.js';
import './components/composer.js';

export { h, meta, QuorumElement } from './lib/element.js';
export { HUMAN_HUE, identityHue, participantHue, resetIdentityHues } from './lib/identity.js';
export { sendsOnEnter } from './lib/keys.js';
export { FAILED, LIVE_PHASES, PHASES, composerHint, isTerminal, optionChipProps, phaseColor, phaseStep, phaseTint } from './lib/phase.js';

export { IdentityChip } from './components/identity-chip.js';
export { MessageRow } from './components/message-row.js';
export { PhaseStepper } from './components/phase-stepper.js';
export { VoteChip } from './components/vote-chip.js';
export { DissentBadge } from './components/dissent-badge.js';
export { ProposalCard } from './components/proposal-card.js';
export { DecisionCard } from './components/decision-card.js';
export { Composer } from './components/composer.js';
