// The decision history, as a list of records.
//
// State in, DOM out, like every other view. It picks no colour and no size:
// a failed decision is not styled as an error here, it is an outcome with a
// typed reason, and `q-decision-card` already knows how to draw both.

import { h } from '../../lib/element.js';
import { clock } from './format.js';
import { recordProps } from './record.js';

/**
 * One record: a summary until it is opened, the whole thing after.
 *
 * The derivations live in `record.js` — this only puts them on an element.
 *
 * @param {any} summary
 * @param {any} [record]
 */
export function recordView(summary, record) {
  const props = recordProps(summary, record);
  const card = /** @type {any} */ (
    h('q-decision-card', {
      // Which record this card is, so opening one reaches the right endpoint.
      'data-decision': summary.deliberationId,
      'record-id': props.recordId,
      question: props.question,
      result: props.result,
      'failure-kind': props.failureKind,
      'decided-at': clock(record ? record.closedAt : summary.closedAt),
      'decision-rule': props.decisionRule,
      summary: props.summary,
      outcome: props.outcome,
      variant: props.variant,
      openable: true,
    })
  );
  if (record) {
    card.options = props.options;
    card.silent = props.silent;
    card.dissents = props.dissents;
  }
  return card;
}

/**
 * @param {any[]} decisions
 * @param {Map<string, any>} opened
 * @param {string|null} notice
 */
export function historyView(decisions, opened, notice) {
  const list = h('div', { class: 'records' });

  if (notice) {
    list.append(h('div', { class: 'notice' }, notice));
  }

  if (decisions.length === 0) {
    // What is true and what happens next — never an illustration, and never
    // "no results" for a history that simply has not started.
    list.append(
      h('div', { class: 'empty' }, 'No decisions yet. One appears here the moment a deliberation closes, without a refresh.'),
    );
    return list;
  }

  for (const summary of decisions) {
    list.append(recordView(summary, opened.get(summary.deliberationId)));
  }
  return list;
}
