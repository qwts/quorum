# Deployment

> **Navigation:** [Home](README.md) | Previous: [Architecture](architecture.md)
>
> **Prerequisites:** A quorum that runs locally (the repository README), and
> [Agent identity §3](design/agent-identity.md) for what a token is and where
> it is allowed to live
>
> **Related Documents:**
> - [Requirements §4](requirements.md) - The rule this recipe satisfies: participant authentication before any non-local binding ships
> - [Agent identity](design/agent-identity.md) - The credential design ([ADR-0001](decisions/ADR-0001-agent-identity.md)); this recipe uses its Phase-1 PATs

---

The recipe for [#53](https://github.com/qwts/quorum/issues/53): quorum leaves
the laptop and lands on an always-on host, credential-gated from the first
remote request. It is written to be followed in under an hour, and every step
that can be checked mechanically *is* — the server refuses to start
half-configured rather than starting into a state that refuses everyone.

Two things make this short. The stack deploys as-is: Node 24+ runs the
TypeScript directly (no build step), SQLite is Node's built-in `node:sqlite`
(no native module to compile), and there is one runtime npm dependency — a
`git clone` and `npm ci --omit=dev` is a deployment. And the security
posture is already in the code: the credential gate ([#50](https://github.com/qwts/quorum/issues/50)),
the Host/Origin allowlist ([#32](https://github.com/qwts/quorum/issues/32)),
and the bind precondition that ties them together (requirements §4) shipped
before this document did.

## 1. Prerequisites

- A host that stays on: a small VPS (Hetzner/DO class — the cheapest tier is
  plenty; quorum's volume is a handful of agents at chat rates) or a Fly.io
  app with a volume. §4 covers both.
- Node 24 or newer on that host (the Fly path gets it from the image).
- A persistent path for the SQLite file. The decision records are the
  product's memory (requirements §3); a redeploy or a dead host must not be
  how they end. On a VPS that is any directory that survives; on Fly it is a
  volume, because a machine's root filesystem does not survive a deploy.
- One decision, made before touching a server: which network posture (§2).

## 2. Choose a network posture

### 2.1 Tailscale — the default recommendation

The tailnet becomes the trust boundary, which is the smallest possible change
from v0's "the machine is the trust boundary": nothing is exposed publicly,
the port is reachable only from machines you enrolled, and TLS is moot
because the tailnet encrypts everything in transit. Every participant's
agents connect outbound to the host's MagicDNS name — no inbound access to
anyone's dev machine, which is requirement 1 of the issue.

On the host: install Tailscale, `tailscale up`, note the MagicDNS name
(`quorum.<tailnet>.ts.net`). Keep the VPS firewall closed to the public
internet — the only listener that matters is reachable over the tailnet.
Then follow §3 with that name as the hostname.

The credential gate is **still required**. Tailscale narrows who can reach
the port; it says nothing about which *agent* is speaking, and attribution to
a `(principal, session)` is the point of the identity design. The bind
precondition (§3.3) enforces this — a wide bind without `QUORUM_AUTH` does
not start, tailnet or not.

### 2.2 Public VPS behind TLS

For a team that cannot share a tailnet. The server is reachable from the
internet, so two things stand between it and the noise: TLS for the
transport, and the token gate for every request. Two ways to terminate TLS:

- **Quorum's own TLS support.** Point `QUORUM_TLS_CERT` and `QUORUM_TLS_KEY`
  at the material (Let's Encrypt via certbot works; renewals need a restart
  to pick up the new certificate). Half-configured TLS is a startup error in
  words — same posture as everything else here.
- **A reverse proxy** (Caddy is the least ceremony — automatic certificates)
  terminating TLS on 443 and proxying to `127.0.0.1:4242`. Quorum then binds
  loopback and the bind precondition never fires — so the one check it would
  have done for you, you must do yourself: **set `QUORUM_AUTH=1` anyway.**
  The server cannot tell a proxied internet request from a local one, and a
  public proxy in front of an ungated quorum is the exact deployment this
  document exists to prevent. `QUORUM_HOSTS` must still name the public
  hostname: the proxied requests carry it in `Host`, and the allowlist
  refuses names it was not told.

## 3. Configure the server

The steps every posture shares. Each one exists for a reason the server will
recite if you skip it.

### 3.1 `QUORUM_AUTH=1` — the credential gate, on from day one

Every `/mcp` call and every `/api` write now requires
`Authorization: Bearer qpat_…`; requests without a valid token get a 401
that says what is missing and where a token comes from, and never echoes
the credential. This is the day-one bar from the issue's re-scope: no
shared stopgap token — per-agent PATs ([ADR-0001](decisions/ADR-0001-agent-identity.md)
Phase 1) so every remote actor is attributable from the first deployment.

### 3.2 `QUORUM_HOSTS=<hostname>` — the name the server answers to

The Host/Origin allowlist guards the MCP endpoint as well as `/api/`
([#32](https://github.com/qwts/quorum/issues/32)), and it accepts only names
it was explicitly told — a name is never inferred from the request, because
the request is what a DNS-rebinding attack controls. Remote clients reach
the server by its hostname, so **without this variable every non-loopback
call is a 403**, however good its token. Set it to the MagicDNS name, the
VPS hostname, or the Fly app hostname — whatever agents will put in their
MCP URL.

### 3.3 `QUORUM_HOST=0.0.0.0` — and the precondition behind it

Widening the bind beyond loopback is a checked precondition, not a flag
(requirements §4). At startup, a non-loopback bind is refused in words
unless `QUORUM_AUTH` is on **and** `QUORUM_HOSTS` names a non-loopback
hostname — because a wide bind without the gate trusts everyone on the
network, and a wide bind without a hostname 403s everyone on it. Both are
the half-configured state that would otherwise fail at the first request,
when you are somewhere else. If the server starts, this page's security
steps are done; if it does not, the error names the missing step and the
line that fixes it.

### 3.4 Mint a token per agent, into the harness's secret storage

On the host, against the server's database file:

```bash
npm run mint-token -- --name codex:alice --ttl-hours 720
```

One token per agent, named for it — attribution is the reason PATs replaced
the shared-token idea. The secret prints once; only its hash is stored, so a
lost token is re-minted, never recovered. Give it to each agent through the
**harness's secret storage** (an environment variable or keychain entry the
harness reads when attaching headers), so the harness sends it as
`Authorization: Bearer …` on every request. The credential is
transport-held: it must never appear in a conversation, a skill file, or a
tool argument — anything the model can read, a prompt injection can
exfiltrate ([design §1.1, §3](design/agent-identity.md)).

Revoke with `npm run mint-token -- --revoke codex:alice`; revocation ends
the principal's grants and any live session mid-connection.

## 4. Host setup

### 4.1 A small VPS, under systemd

```bash
sudo useradd --system --home-dir /var/lib/quorum --create-home quorum
sudo git clone https://github.com/qwts/quorum /opt/quorum
cd /opt/quorum && sudo npm ci --omit=dev
```

`/etc/systemd/system/quorum.service`:

```ini
[Unit]
Description=quorum — deliberation server for coding agents
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=quorum
Group=quorum
WorkingDirectory=/opt/quorum
ExecStart=/usr/bin/node src/index.ts
Environment=QUORUM_DB=/var/lib/quorum/quorum.db
Environment=QUORUM_HOST=0.0.0.0
Environment=QUORUM_AUTH=1
Environment=QUORUM_HOSTS=quorum.your-tailnet.ts.net
Restart=on-failure
RestartSec=2
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/quorum

[Install]
WantedBy=multi-user.target
```

Swap the `QUORUM_HOSTS` value for your posture's hostname; on the public-TLS
posture add the `QUORUM_TLS_*` lines or bind loopback behind the proxy
(§2.2). Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now quorum
journalctl -u quorum -f     # the startup line, or the precondition refusing in words
```

Minting on this host runs as the service user so the file stays its:

```bash
cd /opt/quorum && sudo -u quorum QUORUM_DB=/var/lib/quorum/quorum.db \
  npm run mint-token -- --name codex:alice
```

Agents connect to `http://quorum.your-tailnet.ts.net:4242/mcp` (or the
`https://` hostname on the public posture), each with its own token in its
harness's header configuration.

### 4.2 Fly.io, with a volume

Fly terminates TLS at its edge and gives the app a public hostname, so this
is the public posture with the certificate handled for you. The SQLite file
means **exactly one machine** — do not scale this app horizontally.

`Dockerfile` (the whole point of the stack surviving unchanged — nothing to
build):

```dockerfile
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY commands ./commands
CMD ["node", "src/index.ts"]
```

`fly.toml`:

```toml
app = "your-quorum"
primary_region = "iad"

[env]
  QUORUM_DB = "/data/quorum.db"
  QUORUM_HOST = "0.0.0.0"
  QUORUM_AUTH = "1"
  QUORUM_HOSTS = "your-quorum.fly.dev"

[mounts]
  source = "quorum_data"
  destination = "/data"

[http_service]
  internal_port = 4242
  force_https = true
  auto_stop_machines = "off"
  min_machines_running = 1
```

`auto_stop_machines = "off"` because quorum's whole rhythm is long-lived
quiet connections — agents blocked on `wait_for_events` — and a stopped
machine is an agent that misses its turn. Then:

```bash
fly launch --no-deploy          # accept the existing fly.toml
fly volumes create quorum_data --size 1
fly deploy
fly scale count 1               # one machine; SQLite is not a cluster
fly ssh console -C "npm run mint-token -- --name codex:alice"
```

Agents connect to `https://your-quorum.fly.dev/mcp`.

## 5. Back up the SQLite file

The database runs in WAL mode, so a naive copy of a live file can catch a
torn state across the `.db`/`-wal` pair. Take backups through SQLite itself,
which snapshots consistently while the server keeps running:

```bash
sqlite3 /var/lib/quorum/quorum.db ".backup '/var/backups/quorum-$(date +%F).db'"
```

Put that in a cron entry and ship the copies off the host — the host dying
is inside this recipe's threat model (requirements 1.1 #10, extended). On
Fly, run the same command over `fly ssh console` and fetch the copy with
`fly ssh sftp get`, or snapshot the volume.

## 6. What is deliberately not here

- **The Cloudflare Workers / Durable Objects port.** Architecturally
  attractive — quorum's tiny-bursts-long-silences shape is nearly the ideal
  free-tier tenant, and the cost analysis is recorded honestly on the issue
  ([the trade](https://github.com/qwts/quorum/issues/53#issuecomment-5112427041),
  [the numbers](https://github.com/qwts/quorum/issues/53#issuecomment-5112472340)) —
  but it is a persistence-layer rewrite, and the decision point is real usage
  on this recipe's deployment, not before. The layering rule is what keeps
  that door open at no cost: only the storage seam and the transports would
  move.
- **Phase 2 OAuth.** PATs are the Phase-1 credential
  ([design §3.2](design/agent-identity.md)); the OAuth 2.1 consent flow
  (§3.1) lands on the same gate later and lets spec-conformant harnesses
  discover the token source themselves instead of being handed a PAT.
- **Multi-tenancy and horizontal scale.** One process, one SQLite file, one
  team. That is the product at this stage, not a limitation to engineer
  around.
