// Mint a personal access token for an agent, on the machine that runs the
// server (ADR-0001 Phase 1; docs/design/agent-identity.md §3.2).
//
//   npm run mint-token -- --name claude:auth-refactor [--ttl-hours 720]
//   npm run mint-token -- --revoke claude:auth-refactor
//
// There is no HTTP endpoint for this in Phase 1, and that is the point:
// sponsoring an agent is a human act at a keyboard, not something any process
// that can reach the port may do for itself. Phase 2's OAuth consent screen is
// the same decision moved into a browser; Phase 3 gives the sponsoring human a
// real account behind it.
//
// The secret is printed once, here. Only its SHA-256 hash is stored, so this
// is the one moment it exists in readable form — which is also why it must go
// to the harness's secret storage and never into a conversation, a skill file,
// or a tool argument: anything the model can read, a prompt injection can
// exfiltrate (design §1.1).

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { openQuorum } from '../src/domain/quorum.ts';

/** 30 days. Long enough not to be a chore, short enough to be a rotation. */
const DEFAULT_TTL_HOURS = 720;

const USAGE =
  'usage: npm run mint-token -- --name <agent> [--ttl-hours <n>]\n' +
  '       npm run mint-token -- --revoke <agent>\n';

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  const value = at === -1 ? undefined : process.argv[at + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

const name = flag('name');
const revoking = flag('revoke');
if (name === undefined && revoking === undefined) {
  process.stderr.write(USAGE);
  process.exit(2);
}

const dbPath = process.env.QUORUM_DB ?? join(homedir(), '.quorum', 'quorum.db');
mkdirSync(dirname(dbPath), { recursive: true });
const quorum = openQuorum({ path: dbPath });

try {
  if (revoking !== undefined) {
    // Revocation cascades down the tree (design §2): the principal, every
    // grant beneath it, and any session those grants had open.
    const { grants, sessions } = quorum.identity.revokePrincipal(revoking);
    process.stdout.write(
      `revoked ${JSON.stringify(revoking)}: ${grants.length} grant(s) killed,` +
        ` ${sessions.length} live session(s) ended. The feed carries it, so anyone watching sees it happen.\n`,
    );
  } else {
    const hours = Number(flag('ttl-hours') ?? DEFAULT_TTL_HOURS);
    if (!Number.isFinite(hours) || hours <= 0) {
      process.stderr.write(`--ttl-hours must be a positive number of hours\n${USAGE}`);
      process.exit(2);
    }
    const { token, principal, grant } = quorum.identity.mint({
      name: name!,
      ttlMs: Math.round(hours * 3_600_000),
    });
    const expires = grant.expiresAt === null ? 'never' : new Date(grant.expiresAt).toISOString();
    process.stdout.write(
      `minted a token for ${JSON.stringify(principal.name)}\n` +
        `  principal ${principal.id}\n` +
        `  grant     ${grant.id}\n` +
        `  scopes    ${grant.scopes}\n` +
        `  expires   ${expires}\n\n` +
        `  ${token}\n\n` +
        'That is the only time it is shown — the server stores a hash, so a lost token is re-minted,\n' +
        'never recovered. Give it to the agent through whatever secret storage its harness has, and\n' +
        'have the harness send it as a header on every request:\n\n' +
        '  Authorization: Bearer <token>\n\n' +
        'Never paste it into a conversation, a skill file, or a tool argument: anything the model can\n' +
        'read, a prompt injection can exfiltrate. Start the server with QUORUM_AUTH=1 to require it —\n' +
        'without that the server still trusts localhost and this token sits inert.\n',
    );
  }
} finally {
  quorum.close();
}
