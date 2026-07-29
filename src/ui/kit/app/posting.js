// Sending a draft: the part with a lifecycle.
//
// Split out of the composition root and given explicit ports, because every
// bug this logic has had is a *timing* bug — a room switched mid-flight, a
// second Enter, a draft cleared that had moved on, an identity the server
// stopped recognising. None of those need a DOM to reproduce, and none of them
// had a test while this lived inline.
//
// The composer stays editable while a post is in flight, deliberately: it is
// the only way a failed post keeps the words someone typed. Everything awkward
// here follows from that one decision.

/**
 * @typedef {{id: string, name: string}} Who
 *
 * @param {object} ports
 * @param {() => string} ports.room            the room open right now
 * @param {() => Who|null} ports.me            who this browser is, if it has said
 * @param {(who: Who|null) => void} ports.setMe
 * @param {() => string} ports.draft           what is in the field right now
 * @param {(value: string) => void} ports.setDraft
 * @param {(message: string|null) => void} ports.setNotice
 * @param {() => void} ports.settled           called once, after every outcome
 * @param {(name: string) => Promise<Who|null>} ports.identify
 * @param {(room: string, participantId: string) => Promise<unknown>} ports.join
 * @param {(room: string, participantId: string, body: string) => Promise<unknown>} ports.post
 * @param {(message: string) => boolean} ports.isStaleIdentity
 * @param {() => void} ports.forget
 */
export function createSender(ports) {
  let sending = false;

  /**
   * Join and post, re-identifying once if the id we hold is stale.
   *
   * A participant id means nothing to a database that did not issue it, so
   * pointing the server at a different or recreated one leaves this browser
   * holding a UUID that names nobody. Without this, every send fails the same
   * way forever and the only fix is clearing site data by hand.
   *
   * @param {string} room
   * @param {string} body
   * @param {boolean} [retried]
   */
  async function deliver(room, body, retried = false) {
    const who = ports.me();
    if (!who) throw new Error('not identified');
    try {
      // Membership is the protocol's rule, not this screen's; joining is
      // idempotent, so asking every time is cheaper than tracking it wrongly.
      // A slash body is the one exception to join-or-fail: /room must work on
      // a fresh server where the room in the URL does not exist yet (#52),
      // and the domain gates commands itself — so the post gets its say, and
      // a command that does need membership is refused in the domain's words.
      try {
        await ports.join(room, who.id);
      } catch (error) {
        if (!body.startsWith('/')) throw error;
      }
      return await ports.post(room, who.id, body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (retried || !ports.isStaleIdentity(message)) throw error;
      ports.forget();
      ports.setMe(null);
      const renamed = await ports.identify('');
      if (!renamed) throw error;
      ports.setMe(renamed);
      return await deliver(room, body, true);
    }
  }

  /** @param {string} body */
  return async function send(body) {
    // A second Enter while the first is in flight would post the same text
    // twice — joining is idempotent, posting is not, so the duplicate is two
    // permanent messages. This guards the submission, not the typing.
    if (sending) return;

    // The destination is fixed here, before the first await. `room()` is
    // mutable and a switch mid-send would otherwise join one room and post to
    // another — and if you were already a member of the second, the message
    // would land in the wrong room with nothing on screen to say so.
    const room = ports.room();

    sending = true;
    ports.setNotice(null);
    try {
      let who = ports.me();
      if (!who) {
        who = await ports.identify('');
        ports.setMe(who);
      }
      if (!who) {
        // Declining to be named is an answer, not an error. Say what it means
        // and what would change it.
        ports.setNotice('Posting needs a name — agents attribute everything in the record. Send again to be asked.');
        return;
      }

      const response = /** @type {any} */ (await deliver(room, body));

      // A command's answer (#52) is for this sender alone — the notice slot,
      // never the stream. /help in a busy room reaches exactly one person.
      if (response?.command) ports.setNotice(response.command.text);

      // Only the submitted text is cleared, and only if it is still the text
      // in the field. The composer stays editable while a post is in flight,
      // so the next draft may already have been started — blanking the field
      // would delete it.
      if (ports.draft() === body) ports.setDraft('');
    } catch (error) {
      // The server's refusals are written to be read. Surfaced as they stand,
      // as a private row, because it was returned to this person alone.
      ports.setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      sending = false;
      ports.settled();
    }
  };
}
