#!/bin/sh
# Run quorum over TLS, reachable by its development hostname.
#
#   npm run dev:tls
#
# Everything here is convention over configuration: the certificate material
# lives in ~/.quorum/certs and is never in this repository. Override any of it
# by exporting the variable before running.
#
# Loopback (`npm start`) needs none of this — 127.0.0.1 is already a secure
# context. This exists for reaching the server by a name, which over plain HTTP
# would not be.
set -eu

CERTS="${QUORUM_CERTS:-$HOME/.quorum/certs}"
HOSTNAME_="${QUORUM_DEV_HOST:-}"

# Trusting a shared public hostname by default would let whoever controls its
# DNS rebind a browser origin to this unauthenticated loopback server. Require
# each operator to choose a name they control (or map locally) instead.
[ -n "$HOSTNAME_" ] || { echo "dev-tls: QUORUM_DEV_HOST is required; set it to a hostname you control or map locally" >&2; exit 1; }

QUORUM_TLS_CERT="${QUORUM_TLS_CERT:-$CERTS/fullchain.pem}"
QUORUM_TLS_KEY="${QUORUM_TLS_KEY:-$CERTS/key.pem}"
QUORUM_TLS_PASSPHRASE_FILE="${QUORUM_TLS_PASSPHRASE_FILE:-$CERTS/key.passphrase}"

# A certificate does not make a name trusted: the browser write guard still
# refuses any hostname it was not told about, so the name goes on the allowlist
# explicitly. PUBLIC_HOST only changes what the startup lines print.
QUORUM_HOSTS="${QUORUM_HOSTS:-$HOSTNAME_}"
QUORUM_PUBLIC_HOST="${QUORUM_PUBLIC_HOST:-$HOSTNAME_}"

export QUORUM_TLS_CERT QUORUM_TLS_KEY QUORUM_HOSTS QUORUM_PUBLIC_HOST

for f in "$QUORUM_TLS_CERT" "$QUORUM_TLS_KEY"; do
  [ -r "$f" ] || { echo "dev-tls: cannot read $f — put the certificate material in $CERTS, or set QUORUM_CERTS" >&2; exit 1; }
done

# The passphrase file is optional: a key that is not encrypted needs none, and
# passing a path to a file that is not there fails less clearly than not
# passing one at all.
if [ -r "$QUORUM_TLS_PASSPHRASE_FILE" ]; then
  export QUORUM_TLS_PASSPHRASE_FILE
else
  unset QUORUM_TLS_PASSPHRASE_FILE
fi

# A name that does not resolve is the most common way this looks broken while
# being fine, so say so once rather than letting the browser say it.
if command -v ping >/dev/null 2>&1 && ! ping -c1 -W1 "$HOSTNAME_" >/dev/null 2>&1; then
  echo "dev-tls: note — $HOSTNAME_ does not resolve here yet; it needs an A record pointing at 127.0.0.1" >&2
fi

exec node src/index.ts
