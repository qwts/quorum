// Convening from the room composer.
//
// The component already has a designed `propose` action, but the design system
// has no multi-field form or dialog for a question plus two-to-ten options.
// Native prompts keep that missing surface as platform chrome (the same ruling
// as identity in me.js) while the protocol and every refusal remain the
// server's. Q14 records the visual design debt that remains.

/** @typedef {{id: string, name: string}} Who */

/**
 * Collect the proposal fields without knowing about the DOM or transport.
 * Cancel on the question abandons the action. Once two options exist, cancel
 * or an empty answer opens the deliberation; before then it is incomplete.
 *
 * @param {(message: string) => string|null} ask
 * @returns {{question: string, options: string[]}|null}
 */
export function collectProposal(ask) {
  const question = ask('Question for this deliberation.')?.trim();
  if (!question) return null;

  const options = [];
  while (options.length < 10) {
    const number = options.length + 1;
    const answer = ask(
      number <= 2
        ? `Option ${number} of at least 2.`
        : `Option ${number} (leave blank or Cancel to open the deliberation).`,
    );
    if (!answer?.trim()) break;
    options.push(answer.trim());
  }
  if (options.length < 2) throw new Error('A deliberation needs at least two options. Choose propose to try again.');
  return { question, options };
}

/**
 * @param {object} ports
 * @param {() => string} ports.room
 * @param {() => Who|null} ports.me
 * @param {(who: Who|null) => void} ports.setMe
 * @param {(message: string|null) => void} ports.setNotice
 * @param {() => void} ports.settled
 * @param {() => Promise<Who|null>} ports.identify
 * @param {(room: string, participantId: string) => Promise<unknown>} ports.join
 * @param {(room: string, participantId: string, question: string, options: string[]) => Promise<unknown>} ports.propose
 * @param {(message: string) => string|null} ports.ask
 * @param {(message: string) => boolean} ports.isStaleIdentity
 * @param {() => void} ports.forget
 */
export function createProposer(ports) {
  let proposing = false;

  /** @param {string} room @param {{question: string, options: string[]}} proposal @param {boolean} [retried] */
  async function deliver(room, proposal, retried = false) {
    const who = ports.me();
    if (!who) throw new Error('not identified');
    try {
      await ports.join(room, who.id);
      return await ports.propose(room, who.id, proposal.question, proposal.options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (retried || !ports.isStaleIdentity(message)) throw error;
      ports.forget();
      ports.setMe(null);
      const renamed = await ports.identify();
      if (!renamed) throw error;
      ports.setMe(renamed);
      return await deliver(room, proposal, true);
    }
  }

  return async function propose() {
    if (proposing) return;
    proposing = true;
    ports.setNotice(null);
    /** The room this attempt belongs to; null until synchronous collection finishes. @type {string|null} */
    let room = null;
    try {
      const proposal = collectProposal(ports.ask);
      if (!proposal) return;
      // Freeze the destination before identity or network awaits. A room
      // switch while either is in flight must not move the proposal elsewhere.
      room = ports.room();

      let who = ports.me();
      if (!who) {
        who = await ports.identify();
        ports.setMe(who);
      }
      if (!who) {
        if (ports.room() === room) {
          ports.setNotice('Convening needs a name — agents attribute every proposal. Choose propose again to be asked.');
        }
        return;
      }
      await deliver(room, proposal);
    } catch (error) {
      // A late refusal belongs to the room where the action began. `show()`
      // clears that room's notice on navigation; do not recreate it beneath a
      // different room when the old request finally settles.
      if (room === null || ports.room() === room) {
        ports.setNotice(error instanceof Error ? error.message : String(error));
      }
    } finally {
      proposing = false;
      ports.settled();
    }
  };
}
