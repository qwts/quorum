// <q-decision-card> — the immutable record a deliberation writes at close.
//
// The one light surface in Quorum. Ink is the live present; paper is the
// permanent past, and the contrast is the whole visual argument — a record
// should look like a document you could print and hand to someone who was not
// in the room.
//
// A failed deliberation writes a record too (protocol D8). Failure is an
// outcome with a typed reason, not an error state, so it gets the same paper,
// the same permanence, and the names of everyone who never cast.
//
// There is no edit affordance in this component, and adding one would be a
// protocol violation rather than a feature: a correction is a new
// deliberation, never an edit (D9).
//
// One adaptation: the design's `id` prop is `record-id` here. `id` is the
// host element's own HTML id, so a screen that reached for its card by id
// would silently overwrite the record's citation number — and a record whose
// printed id is `specimen-record` is worse than one with no id at all.

import { QuorumElement, define, h } from '../lib/element.js';

export class DecisionCard extends QuorumElement {
  static props = ['recordId', 'question', 'outcome', 'result', 'failureKind', 'decidedAt', 'room', 'decisionRule', 'reason', 'summary', 'variant', 'openable'];

  /** `options: [{option, count, voters?: ({name, grantRevokedBeforeClose?}|string)[]}]`, `silent: string[]`, `dissents: [{name, harness?, note}]`, `challengeRefs: (string|number)[]`. */
  static data = ['options', 'silent', 'dissents', 'challengeRefs'];

  static styles = `
    :host {
      display: flex; flex-direction: column; gap: var(--sp-5); max-width: 780px;
      background: var(--surface-record); color: var(--paper-ink);
      border-radius: var(--radius-sm); box-shadow: var(--shadow-paper);
      border-left: var(--border-width-accent) solid var(--phase-converged);
      padding: var(--sp-7);
    }
    :host([result="failed"]) { border-left-color: var(--phase-failed); }
    :host([variant="summary"]) { padding: var(--sp-5) var(--sp-6); }
    :host([openable]) { cursor: pointer; }
    .top { display: flex; align-items: center; gap: var(--sp-5); flex-wrap: wrap; }
    .kind {
      font: var(--type-label); letter-spacing: var(--ls-caps); text-transform: uppercase;
      color: color-mix(in oklab, var(--phase-converged) 72%, var(--paper-ink));
    }
    :host([result="failed"]) .kind { color: var(--phase-failed); }
    .mono { font: var(--type-mono); color: var(--paper-ink-2); }
    .spacer { flex: 1 1 auto; }
    h3 { margin: 0; font: var(--type-record-title); color: var(--paper-ink); max-width: var(--measure-record); }
    .outcome {
      display: flex; gap: var(--sp-4); align-items: baseline; flex-wrap: wrap;
      padding: var(--sp-4) var(--sp-5); background: var(--paper-200); border-radius: var(--radius-xs);
    }
    .outcome .lead {
      font: var(--type-label); letter-spacing: var(--ls-caps);
      text-transform: uppercase; color: var(--paper-ink-2);
    }
    .outcome .chosen { font: var(--fw-semibold) var(--fs-15)/var(--lh-snug) var(--font-serif); color: var(--paper-ink); }
    .outcome .why { margin-left: auto; font: var(--type-mono-strong); color: var(--phase-failed); }
    p { margin: 0; font: var(--type-record-body); color: var(--paper-ink); max-width: var(--measure-record); }
    table { border-collapse: collapse; width: 100%; font: var(--type-mono); }
    tr { border-top: 1px solid var(--paper-300); }
    td { padding: var(--sp-3) 0; }
    td.option { color: var(--paper-ink); font: var(--type-record-body); }
    td.voters { text-align: right; color: var(--paper-ink-2); white-space: nowrap; }
    td.count { text-align: right; padding-left: var(--sp-5); color: var(--paper-ink); font: var(--type-mono-strong); }
    .silent { border-top: 1px solid var(--paper-300); padding-top: var(--sp-4); }
    .silent .lead {
      font: var(--type-label); letter-spacing: var(--ls-caps);
      text-transform: uppercase; color: var(--paper-ink-2);
    }
    .silent .names { font: var(--type-mono); color: var(--paper-ink); margin-top: var(--sp-2); }
    .dissents { display: flex; flex-direction: column; gap: var(--sp-3); }
    .foot { display: flex; gap: var(--sp-5); flex-wrap: wrap; font: var(--type-mono); color: var(--paper-ink-2); }
  `;

  render() {
    const failed = this.attr('result') === 'failed';
    const summary = this.attr('variant') === 'summary';
    const outcome = this.attr('outcome');
    const failureKind = this.attr('failure-kind');
    const silent = this.list('silent');
    const dissents = this.list('dissents');

    // Both branches, always. A card reused for a different record — a history
    // list re-rendering in place — would otherwise keep the role and the tab
    // stop it had last time, and a static record that a screen reader still
    // announces as a button is a promise the card cannot keep.
    if (this.bool('openable')) {
      this.tabIndex = 0;
      this.setAttribute('role', 'button');
    } else {
      this.removeAttribute('tabindex');
      this.removeAttribute('role');
    }

    const tally = h('table', {});
    if (!summary) {
      const body = h('tbody', {});
      for (const row of this.list('options')) {
        const voters = (row.voters ?? []).map((/** @type {any} */ voter) => {
          // String voters remain supported for standalone design specimens.
          // Product records use the structured form so the immutable
          // revoked-before-close context cannot disappear at the UI boundary.
          if (typeof voter === 'string') return voter;
          return voter.grantRevokedBeforeClose
            ? `${voter.name} (grant revoked before close)`
            : voter.name;
        });
        body.append(
          h(
            'tr',
            {},
            h('td', { class: 'option' }, row.option),
            // Voters are named only after close — during voting there is nothing to name.
            h('td', { class: 'voters' }, voters.join(', ')),
            h('td', { class: 'count' }, String(row.count ?? 0)),
          ),
        );
      }
      tally.append(body);
    }

    const dissentBlock = h('div', { class: 'dissents' });
    if (dissents.length) {
      if (summary) {
        dissentBlock.append(h('q-dissent-badge', { variant: 'count', count: dissents.length }));
      } else {
        for (const dissent of dissents) {
          dissentBlock.append(
            h('q-dissent-badge', {
              variant: 'paper',
              name: dissent.name,
              harness: dissent.harness,
              note: dissent.note,
            }),
          );
        }
      }
    }

    return h(
      'div',
      { style: 'display:contents' },
      h(
        'div',
        { class: 'top' },
        h('span', { class: 'kind' }, failed ? 'failure record' : 'decision record'),
        this.attr('recordId') && h('span', { class: 'mono' }, this.attr('recordId')),
        h('span', { class: 'spacer' }),
        this.attr('decided-at') && h('span', { class: 'mono' }, this.attr('decided-at')),
      ),
      h('h3', {}, this.attr('question') ?? ''),
      (outcome || failed) &&
        h(
          'div',
          { class: 'outcome' },
          h('span', { class: 'lead' }, failed ? 'no decision' : 'decided'),
          outcome && h('span', { class: 'chosen' }, outcome),
          // The typed reason, so the card never has to parse prose to know why.
          failed && failureKind && h('span', { class: 'why' }, `failure_kind: ${failureKind}`),
        ),
      // `reason` is the current name; `summary` is the deprecated alias the
      // design still accepts, so a screen written against either keeps working.
      (this.attr('reason') ?? this.attr('summary')) && h('p', {}, this.attr('reason') ?? this.attr('summary')),
      !summary && this.list('options').length ? tally : null,
      // "2 of 6 ballots" without the four names is not a record of what happened.
      !summary && silent.length
        ? h(
            'div',
            { class: 'silent' },
            h('span', { class: 'lead' }, `no ballot cast · ${silent.length}`),
            h('div', { class: 'names' }, silent.join(', ')),
          )
        : null,
      dissents.length ? dissentBlock : null,
      h(
        'div',
        { class: 'foot' },
        this.attr('room') && h('span', {}, `#${this.attr('room')}`),
        this.attr('decision-rule') && h('span', {}, `rule: ${this.attr('decision-rule')}`),
        // The challenges the record cites, by message seq (D4): the record
        // references messages, never copies them. Full records only — a
        // summary row is a headline, not a citation trail.
        !summary && this.list('challengeRefs').length
          ? h('span', {}, `challenges cited: seq ${this.list('challengeRefs').join(' · ')}`)
          : null,
        h('span', {}, 'immutable'),
      ),
    );
  }
}

define('q-decision-card', DecisionCard);
