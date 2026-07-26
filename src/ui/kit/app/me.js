// Who this browser is.
//
// v0 has no accounts (requirements §3): the machine boundary is the trust
// boundary, so naming yourself is a claim, not an authentication. That is
// exactly what `identify` is for agents too — one protocol, both transports.
//
// The name is asked for once and the participant id kept in `localStorage`,
// which is scoped to the *origin* including the port. Two tools sharing a
// development hostname on different ports therefore cannot see each other's
// identity, which matters here because the certificate is reused by port.
//
// Nothing is invented visually. The name is collected with the browser's own
// prompt rather than a dialog this library does not have — the design system
// ships no input but the composer, and a screen inventing one would be the
// thing the library exists to prevent. The designed identity step is the
// connect screen (#20); see QUESTIONS.md Q12.

const KEY = 'quorum.participant';

/**
 * The remembered participant, or null.
 *
 * Storage can throw — private browsing, or a policy that blocks it — and a
 * page that cannot remember who you are should still let you post. So a
 * failure here is "not known yet", never an error.
 *
 * @returns {{id: string, name: string}|null}
 */
export function remembered() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed?.id === 'string' && typeof parsed?.name === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Forget the remembered participant.
 *
 * The id is only meaningful to the database that issued it. Point the server
 * at a different (or freshly deleted) one and this browser still holds a UUID
 * that no longer names anybody — every write then fails identically, forever,
 * with no way out of it short of clearing site data by hand.
 */
export function forget() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to forget if we could not remember */
  }
}

/**
 * Whether a refusal means the id we hold is not one the server knows.
 * @param {string} message
 */
export function isStaleIdentity(message) {
  return /unknown participant/i.test(message);
}

/** @param {{id: string, name: string}} who */
function remember(who) {
  try {
    localStorage.setItem(KEY, JSON.stringify(who));
  } catch {
    // Not fatal: the session keeps working, the next reload asks again.
  }
}

/**
 * Make sure this browser has a participant, asking for a name if it must.
 *
 * Returns null when the person declines to be named — a cancelled prompt is an
 * answer, not a failure, and the caller says so rather than retrying.
 *
 * `ask` is passed in rather than defaulted to `window.prompt`, so this module
 * names no browser global and the one browser dependency it has lives in the
 * composition root with the other wiring.
 *
 * @param {{ ask: (message: string) => string|null, identify: (name: string) => Promise<any> }} ports
 * @returns {Promise<{id: string, name: string}|null>}
 */
export async function ensureIdentified({ ask, identify }) {
  const known = remembered();
  if (known) return known;

  const name = ask('Your name in this room — agents will see it on everything you post.')?.trim();
  if (!name) return null;

  const { participant } = await identify(name);
  const who = { id: participant.id, name: participant.name };
  remember(who);
  return who;
}
