// The bind guard: which addresses this server may listen on, and on what terms.
//
// v0's rule was a sentence — "widening this needs the auth that v1 brings" —
// and this module is where the sentence becomes mechanical (requirements §4,
// #53): a bind that reaches beyond loopback is refused at startup unless the
// credential gate is on, because the moment the socket leaves the machine,
// the machine boundary stops being the trust boundary.
//
// Same posture as loadTls (tls.ts): half-configured is worse than none,
// because it fails at the first request rather than at startup, and the
// operator is by then somewhere else. A wide bind cannot work without two
// things, so both are checked here, in words:
//
//   * **The credential gate.** With QUORUM_AUTH off the server believes every
//     request, which was only ever safe of requests that had already crossed
//     the machine boundary.
//   * **A hostname it answers to.** The Host/Origin allowlist (origin.ts, #32)
//     refuses every name it was not told, and remote clients reach a server
//     by name — so a wide bind with nothing non-loopback in QUORUM_HOSTS is a
//     server that accepts the connection and then 403s everything on it.

import { AUTH_ENV, authRequired } from './auth.ts';
import { allowedHosts } from './origin.ts';

/**
 * Whether a bind address stays on this machine.
 *
 * The whole 127/8 block is loopback, not just `.0.0.1`. Anything this cannot
 * recognise — a hostname, `0.0.0.0`, `::` — is treated as wide, so an exotic
 * value fails closed into the checked path rather than quietly binding
 * something the rule never saw.
 */
export function isLoopback(host: string): boolean {
  const name = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return name === 'localhost' || name === '::1' || /^127(\.\d{1,3}){3}$/.test(name);
}

/**
 * The address to bind, once its preconditions hold.
 *
 * Returns the host to hand `listen`, or throws the startup error to print:
 * what was asked, what is missing, and the one line that fixes it. The values
 * embedded are operator-set environment, not participant text — and they are
 * JSON-quoted anyway, the same rule domain errors follow.
 */
export function guardBind(env: NodeJS.ProcessEnv = process.env): string {
  const host = env.QUORUM_HOST ?? '127.0.0.1';
  if (isLoopback(host)) return host;

  if (!authRequired(env)) {
    throw new Error(
      `QUORUM_HOST=${JSON.stringify(host)} reaches beyond loopback, and ${AUTH_ENV} is not set —` +
        ' a server anyone on the network can reach must not believe everyone on the network.' +
        ` Set ${AUTH_ENV}=1 and mint each agent a token with \`npm run mint-token -- --name <agent>\`` +
        ' (docs/deploy.md is the recipe), or unset QUORUM_HOST to stay on 127.0.0.1.',
    );
  }

  if (![...allowedHosts(env)].some((name) => !isLoopback(name))) {
    throw new Error(
      `QUORUM_HOST=${JSON.stringify(host)} reaches beyond loopback, and QUORUM_HOSTS names no` +
        ' non-loopback hostname — the Host/Origin allowlist refuses every name it was not told (#32),' +
        ' so every remote call would be a 403. Set QUORUM_HOSTS to the hostname agents will reach' +
        ' this server by (docs/deploy.md), or unset QUORUM_HOST to stay on 127.0.0.1.',
    );
  }

  return host;
}
