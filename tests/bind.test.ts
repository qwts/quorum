// The bind guard, at the unit seam.
//
// Split from write.test.ts along the module boundary it tests: src/http/bind.ts
// is the startup precondition for widening the bind (#53), pure by design so
// it can be proven without binding a public interface. The wire-level proof
// that an unauthenticated wide deployment refuses requests lives with the
// auth tests; this file proves the server never starts into that state.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { guardBind } from '../src/http/bind.ts';

test('binding beyond loopback is a checked precondition, not a flag (#53)', () => {
  // v0 unchanged: loopback binds with nothing configured, under every name
  // loopback goes by — the whole 127/8 block is this machine.
  assert.equal(guardBind({} as NodeJS.ProcessEnv), '127.0.0.1');
  for (const host of ['localhost', '::1', '127.0.0.9']) {
    assert.equal(guardBind({ QUORUM_HOST: host } as NodeJS.ProcessEnv), host, host);
  }

  // A wide bind with no credential gate is a startup error in words — the
  // loadTls posture, because a server that starts and then refuses every
  // request fails when the operator is somewhere else. The message carries
  // what was asked, what is missing, and the remedy.
  assert.throws(
    () => guardBind({ QUORUM_HOST: '0.0.0.0' } as NodeJS.ProcessEnv),
    (error: Error) => {
      assert.match(error.message, /beyond loopback/, 'what was asked');
      assert.match(error.message, /QUORUM_AUTH/, 'what is missing');
      assert.match(error.message, /mint-token/, 'and the remedy');
      return true;
    },
  );

  // Every spelling of "off" is off; the precondition reads the same switch
  // the enforcement does, so the two can never disagree about it.
  assert.throws(
    () => guardBind({ QUORUM_HOST: '0.0.0.0', QUORUM_AUTH: '0' } as NodeJS.ProcessEnv),
    /QUORUM_AUTH/,
  );

  // The gate alone is not enough. The origin allowlist (#32) refuses every
  // hostname it was not told, so a wide bind with nothing non-loopback in
  // QUORUM_HOSTS would accept the connection and 403 everything on it —
  // loopback entries do not count, because remote agents cannot use them.
  assert.throws(
    () => guardBind({ QUORUM_HOST: '0.0.0.0', QUORUM_AUTH: '1' } as NodeJS.ProcessEnv),
    /QUORUM_HOSTS/,
  );
  assert.throws(
    () =>
      guardBind({ QUORUM_HOST: '0.0.0.0', QUORUM_AUTH: '1', QUORUM_HOSTS: 'localhost, 127.0.0.2' } as NodeJS.ProcessEnv),
    /QUORUM_HOSTS/,
  );

  // Fully configured, it starts. No public interface is bound here: the
  // precondition is the pure function index.ts runs before listen, exactly
  // as the TLS material is proven before the server constructor touches it.
  const env = { QUORUM_HOST: '0.0.0.0', QUORUM_AUTH: '1', QUORUM_HOSTS: 'quorum.tail1234.ts.net' };
  assert.equal(guardBind(env as NodeJS.ProcessEnv), '0.0.0.0');

  // A QUORUM_HOSTS entry spelled with scheme and port counts once normalized
  // (origin.ts) — the guard and the request-side check must agree on what an
  // entry means, or the guard approves a deployment the allowlist refuses.
  assert.equal(
    guardBind({ QUORUM_HOST: '0.0.0.0', QUORUM_AUTH: '1', QUORUM_HOSTS: 'https://quorum.example.com:8443' } as NodeJS.ProcessEnv),
    '0.0.0.0',
  );

  // An IPv6 literal in URL brackets is loopback *and* must be unwrapped —
  // `server.listen('[::1]')` fails after the guard said yes.
  assert.equal(guardBind({ QUORUM_HOST: '[::1]' } as NodeJS.ProcessEnv), '::1');

  // A value the rule cannot recognise fails closed into the checked path
  // rather than being trusted as local.
  assert.throws(() => guardBind({ QUORUM_HOST: 'quorum.internal' } as NodeJS.ProcessEnv), /beyond loopback/);
});
