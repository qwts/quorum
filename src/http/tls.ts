// Optional TLS for local development.
//
// The server is HTTP on loopback by default and that is not a compromise:
// `127.0.0.1` is already a *secure context*, so the browser hands it the same
// capabilities it gives an HTTPS origin. TLS exists here for the case that
// gives that up — reaching the server by a real hostname, which is an
// insecure context over plain HTTP and quietly loses what the IP had for free.
//
// Nothing is generated, and no certificate lives in this repo. The paths point
// at material the operator put somewhere private, and the passphrase is read
// from a file rather than an argument so it never appears in `ps` output, a
// shell history, or a log line.

import { readFileSync } from 'node:fs';
import { createSecureContext } from 'node:tls';
import { X509Certificate } from 'node:crypto';

export interface TlsMaterial {
  cert: Buffer;
  key: Buffer;
  passphrase?: string;
}

/**
 * A passphrase from a file, with only a trailing line ending removed.
 *
 * Never trimmed. A passphrase may legitimately begin or end with a space, and
 * trimming corrupts the secret and then reports it as the *wrong* passphrase —
 * a failure that looks like the operator mistyped something they did not, and
 * that no amount of retyping fixes.
 */
export function readPassphrase(file: string): string {
  return readFileSync(file, 'utf8').replace(/\r?\n$/, '');
}

/**
 * Load TLS material from the environment, or null when none is configured.
 *
 * @param env
 *   QUORUM_TLS_CERT  path to the certificate, intermediates included
 *   QUORUM_TLS_KEY   path to the private key
 *   QUORUM_TLS_PASSPHRASE_FILE  path to a file holding the key's passphrase
 *   QUORUM_TLS_PASSPHRASE       the passphrase itself; the file is preferred
 */
export function loadTls(env: NodeJS.ProcessEnv = process.env): TlsMaterial | null {
  const certPath = env.QUORUM_TLS_CERT;
  const keyPath = env.QUORUM_TLS_KEY;
  if (!certPath && !keyPath) return null;
  if (!certPath || !keyPath) {
    // Half-configured TLS is worse than none: it fails at the first request
    // rather than at startup, and the operator is by then somewhere else.
    throw new Error('QUORUM_TLS_CERT and QUORUM_TLS_KEY must be set together');
  }

  const passphraseFile = env.QUORUM_TLS_PASSPHRASE_FILE;
  const passphrase = passphraseFile ? readPassphrase(passphraseFile) : env.QUORUM_TLS_PASSPHRASE;

  const material: TlsMaterial = {
    cert: readFileSync(certPath),
    key: readFileSync(keyPath),
  };
  if (passphrase) material.passphrase = passphrase;

  // Prove the material is usable *here*, where the error can be explained.
  // Otherwise the first thing to touch it is the server constructor, which
  // throws `bad decrypt` with a stack trace and no hint that a passphrase is
  // what is missing — the exact failure this module exists to translate.
  createSecureContext(material);
  return material;
}

/**
 * Turn a failure to load or use TLS into something an operator can act on.
 *
 * Node's own message for a wrong or missing passphrase is `error:1E08010C:
 * DECODER routines::unsupported`, which names nothing a person can fix.
 */
export function explainTlsFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/DECODER routines|bad decrypt|unsupported/i.test(message)) {
    return 'the private key could not be read — it is probably encrypted and the passphrase is missing or wrong. Set QUORUM_TLS_PASSPHRASE_FILE to a file holding it, or decrypt the key.';
  }
  if (/ENOENT/.test(message)) {
    return `a TLS file is missing: ${message}`;
  }
  return message;
}

/**
 * The hostname a certificate is actually for.
 *
 * Printing `https://127.0.0.1:4242` while serving a certificate issued for a
 * name produces URLs that fail verification — the one thing this whole feature
 * exists to avoid, in the copy the operator is most likely to paste. The
 * certificate already knows its own name, so it is read rather than asked for.
 *
 * Returns null when the certificate names nothing usable, in which case the
 * caller keeps whatever it was going to print.
 */
export function certificateHost(cert: Buffer): string | null {
  try {
    const san = new X509Certificate(cert).subjectAltName;
    const dns = san?.split(',').map((part) => part.trim()).find((part) => part.startsWith('DNS:'));
    return dns ? dns.slice('DNS:'.length) : null;
  } catch {
    return null;
  }
}
