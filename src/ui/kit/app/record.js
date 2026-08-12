// What a decision card shows, given a summary and (once opened) the record.
//
// Pure, and away from the DOM so it can be tested in Node. What it derives is
// protocol-significant rather than cosmetic: who never cast is part of the
// record, and an option nobody chose is still part of what was decided.

/**
 * @param {any} summary   what the list endpoint carries
 * @param {any} [record]  the full record, once fetched
 */
export function recordProps(summary, record) {
  const source = record ?? summary;
  const props = {
    recordId: summary.deliberationId.slice(0, 8),
    question: source.question,
    result: source.outcome,
    failureKind: source.failureKind ?? null,
    decisionRule: record?.rule ?? null,
    summary: source.reason,
    // The option that won, by index into the ballot paper. A failure has none,
    // and saying so is different from saying nothing.
    outcome: record && record.chosen != null ? (record.options?.[record.chosen] ?? null) : null,
    variant: record ? 'full' : 'summary',
    options: /** @type {any[]} */ ([]),
    silent: /** @type {string[]} */ ([]),
    dissents: /** @type {any[]} */ ([]),
    // The challenges the record cites, by message seq (D4). The record
    // references messages, never copies them — the citation is the relation.
    challengeRefs: /** @type {(string|number)[]} */ ([]),
  };
  if (!record) return props;
  props.challengeRefs = record.challengeMessageIds ?? [];

  // Every option is named even at zero: "the ones nobody chose" is part of
  // what was decided, and a tally that lists only winners is an advert.
  props.options = (record.options ?? []).map((/** @type {string} */ option, /** @type {number} */ index) => ({
    option,
    count: record.tally?.[index] ?? 0,
    voters: (record.ballots ?? [])
      .filter((/** @type {any} */ ballot) => ballot.choice === index)
      .map((/** @type {any} */ ballot) => ({
        name: ballot.name,
        ...(ballot.grantRevokedBeforeClose === true ? { grantRevokedBeforeClose: true } : {}),
      })),
  }));

  // Everyone in the roster frozen at propose who never cast. "3 of 6 ballots"
  // is a number; who the other three were is the record — and it is the part
  // that says whether a decision was made by the room or by whoever was awake.
  const cast = new Set((record.ballots ?? []).map((/** @type {any} */ ballot) => ballot.participantId));
  props.silent = (record.eligible ?? [])
    .filter((/** @type {any} */ person) => !cast.has(person.id))
    .map((/** @type {any} */ person) => person.name);

  props.dissents = (record.ballots ?? [])
    .filter((/** @type {any} */ ballot) => ballot.dissent)
    .map((/** @type {any} */ ballot) => ({ name: ballot.name, note: ballot.dissent }));

  return props;
}
