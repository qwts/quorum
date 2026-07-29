// The human write path, over the wire — and the guard that decides who may use it.
//
// Split from web.test.ts because it is a different surface with a different
// question. That file asks whether a human and an agent are shown the same
// answers; this one asks who is allowed to change them, which is where the
// security properties live: a hostname allowlist that a rebinding attack
// cannot satisfy, a content type that cannot be downgraded past a preflight,
// and TLS material that fails at startup in words rather than at first use in
// OpenSSL error codes.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';

import { openQuorum } from '../src/domain/quorum.ts';
import { MCP_PATH, startServer } from '../src/mcp/server.ts';
import { allowedHosts, refuseWrite } from '../src/http/origin.ts';
import { certificateHost, explainTlsFailure, loadTls, readPassphrase } from '../src/http/tls.ts';

const quorum = openQuorum();
const server = await startServer({ quorum, tls: null });
const origin = `http://127.0.0.1:${server.port}`;

after(async () => {
  await server.close();
  quorum.close();
});

const dana = quorum.identify({ name: 'Dana', harness: 'human' }).participant;
const codex = quorum.identify({ name: 'codex:api', harness: 'codex' }).participant;
quorum.createRoom({ name: 'protocol', topic: 'the wire contract', by: dana.id });
quorum.joinRoom({ room: 'protocol', participantId: codex.id });

async function get(path: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${origin}${path}`);
  return { status: response.status, body: await response.json() };
}

async function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

// A self-signed certificate for a name that does not exist, used only to read
// a hostname back out of it. Public by nature; there is no key here.
const FIXTURE_CERT = `-----BEGIN CERTIFICATE-----
MIIC4TCCAcmgAwIBAgIJAOjcN3lIUI7nMA0GCSqGSIb3DQEBCwUAMB4xHDAaBgNV
BAMME3F1b3J1bS50ZXN0LmV4YW1wbGUwHhcNMjYwNzI2MTgzMjQ4WhcNMzYwNzIz
MTgzMjQ4WjAeMRwwGgYDVQQDDBNxdW9ydW0udGVzdC5leGFtcGxlMIIBIjANBgkq
hkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA4bYAQfFGRgUwBKcZCWL3yZSlxfqeKSz6
rR4q4hd71K2aNkmGTuzmNDauXOP8rav1k+m23yd4WZRLgqBjsFpUtlZ+d6KRQTOo
kKmlxpjF6WactNPtI4EXH57LDwFMZa9BfUXwAtKqzGJamWyYSkAUr48h5/qwltlr
LPXnzDv3TjGGxwi6RJyf3ghDIXyb/9mDwq/n2hmwUpTnJQD5JBLVwE9hefluBaaY
a6l6ZxfW1bZg/9Yo65GolX8cw2Lzao+PYDPWK1uXy4s71cCUfepElElFBsceDhBm
mzaTh7ipfehNqJF903PGJ9ilIq5RR/JvOOA6g0yIKUUA+C9wzbq+1QIDAQABoyIw
IDAeBgNVHREEFzAVghNxdW9ydW0udGVzdC5leGFtcGxlMA0GCSqGSIb3DQEBCwUA
A4IBAQAbH+d/mewhEc5UsGff36jscD488ZlNh/KQAxXw7N7h8Ejjep5WDi6dVtEI
0Q28T1/DxqQEw8mswXPP6Ncp69YF/g7jp5Q4E572pMi5Z0mDwr3sAMA5Rsk9h2hE
wh/VEZfU3QbPEGB8Pkvk5tAYASHS5cEEY+u7JIjC8Ww8Cj/vutpVTTBkxHhblqV7
xUp7Tpx0t9GO5AlUHeguae/SvKtS0ocO8F/WDMwq46AdubJTLJJ4mleoQ1yidber
WGUocI0FbuNfWn3Y2kyg0s/OboUXMlDcteqJLkHcy1WJfySemt5W/OGx4zzfYYe2
ZUsYypgzOb+8urayt9YBlkMQAW30
-----END CERTIFICATE-----
`;

test('a route that only reads refuses a write rather than half-accepting one', async () => {
  // `/api/rooms` reads; there is no write behind it. A POST is routed to the
  // write surface, finds nothing, and 404s — it never reaches the read
  // handler, which is what keeps "this file only reads" true of the file.
  const response = await fetch(`${origin}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.status, 404);
  assert.match(((await response.json()) as { error: string }).error, /no such route/);

  // And a write with no content type is refused before any parsing happens.
  const bare = await fetch(`${origin}/api/rooms`, { method: 'POST' });
  assert.equal(bare.status, 403);
});

test('a human joins, posts, and an agent reads it from the same domain', () => {
  // The claim this transport exists to make, exercised in the direction that
  // was missing: a browser writes, and the write is a first-class domain event
  // the agents see — not a parallel record kept for humans.
  return (async () => {
    const identified = await post('/api/identify', { name: 'Rowan' });
    assert.equal(identified.status, 200);
    assert.equal(identified.body.participant.harness, 'human');

    const id = identified.body.participant.id;
    // Idempotent on (name, harness): a reload must rejoin, never mint a twin.
    const again = await post('/api/identify', { name: 'Rowan' });
    assert.equal(again.body.participant.id, id);

    assert.equal((await post('/api/rooms/protocol/join', { participantId: id })).status, 200);

    const posted = await post('/api/rooms/protocol/messages', {
      participantId: id,
      body: 'Reviewed the wire contract — the seq stamp is the part I would keep.',
    });
    assert.equal(posted.status, 200);

    // The domain, asked the way an agent asks it.
    const seen = quorum.readMessages({ room: 'protocol', limit: 200 }).at(-1);
    assert.equal(seen!.body, 'Reviewed the wire contract — the seq stamp is the part I would keep.');
    assert.equal(seen!.participantId, id);
    assert.ok(posted.body.seq >= seen!.id, 'the response stamps the feed after the write');
  })();
});

test('a human who has not joined is refused in the words an agent gets', async () => {
  const { body } = await post('/api/identify', { name: 'Ari' });
  const refused = await post('/api/rooms/protocol/messages', {
    participantId: body.participant.id,
    body: 'posting without joining',
  });

  // One protocol, not two: the human transport does not get a softer rule, and
  // the refusal is the domain's own sentence — actionable, ending in what to do.
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /join .*protocol.* before posting/);
});

test('a page on another site cannot write to this server', async () => {
  // The threat this file exists for: the server listens on 127.0.0.1 with no
  // auth, so once it writes, every page the human visits can reach it. A
  // browser always sends Origin on a POST and a page cannot forge it.
  const { body } = await post('/api/identify', { name: 'Nico' });
  await post('/api/rooms/protocol/join', { participantId: body.participant.id });

  const attacked = await post(
    '/api/rooms/protocol/messages',
    { participantId: body.participant.id, body: 'posted by evil.example' },
    { origin: 'http://evil.example' },
  );
  assert.equal(attacked.status, 403);
  assert.match(attacked.body.error, /cross-origin/);

  // A host that merely *ends* with ours is not ours.
  const suffix = await post(
    '/api/identify',
    { name: 'Nico' },
    { origin: `http://127.0.0.1:${server.port}.evil.example` },
  );
  assert.equal(suffix.status, 403);

  // The UI this server serves is same-origin, and works.
  const allowed = await post('/api/identify', { name: 'Nico' }, { origin: `http://127.0.0.1:${server.port}` });
  assert.equal(allowed.status, 200);

  assert.ok(
    !quorum.readMessages({ room: 'protocol', limit: 200 }).some((m) => m.body.includes('evil.example')),
    'nothing the cross-origin request asked for reached the room',
  );
});

test('a form post cannot slip past the preflight', async () => {
  // application/json is not a "simple request", so a cross-origin attempt is
  // preflighted and we answer no preflight. Without this check an attacker
  // drops to text/plain — which is simple, needs no preflight, and would
  // otherwise arrive with a JSON body the parser is perfectly happy with.
  const smuggled = await post('/api/identify', JSON.stringify({ name: 'Smuggled' }), {
    'content-type': 'text/plain;charset=UTF-8',
  });
  assert.equal(smuggled.status, 403);
  assert.match(smuggled.body.error, /application\/json/);

  assert.ok(
    !quorum.listParticipants().some((p) => p.name === 'Smuggled'),
    'the participant was never created',
  );
});

test('a human votes through the browser, and the domain counts it', async () => {
  const room = quorum.createRoom({ name: 'ballots', topic: 'voting over http', by: dana.id });
  quorum.joinRoom({ room: 'ballots', participantId: codex.id });
  const proposed = quorum.propose({
    participantId: dana.id,
    room: 'ballots',
    question: 'Do we ship the write path before presence?',
    options: ['Yes', 'No'],
  });
  assert.equal(room.name, 'ballots');
  quorum.closeChallenges({ deliberationId: proposed.id, participantId: dana.id });

  const cast = await post(`/api/deliberations/${proposed.id}/vote`, { participantId: dana.id, choice: 0 });
  assert.equal(cast.status, 200);
  assert.equal(cast.body.cast, 1);

  // A ballot index has to be an integer — "0" from a form field is not one,
  // and silently coercing it is how a vote lands on the wrong option.
  const fuzzy = await post(`/api/deliberations/${proposed.id}/vote`, { participantId: codex.id, choice: '0' });
  assert.equal(fuzzy.status, 409);
  assert.match(fuzzy.body.error, /option index/);
});

test('a malformed or unknown write is refused, not half-accepted', async () => {
  assert.equal((await post('/api/identify', 'not json at all')).status, 409);
  assert.equal((await post('/api/identify', ['an', 'array'])).status, 409);
  assert.equal((await post('/api/identify', {})).status, 409, 'name is required');
  assert.equal((await post('/api/nope', {})).status, 404);

  const put = await fetch(`${origin}/api/rooms`, { method: 'PUT', headers: { 'content-type': 'application/json' } });
  assert.equal(put.status, 405);
});

test('a rebound hostname is refused however well its headers agree', () => {
  // The attack the previous check could not see. An attacker whose domain
  // resolves to 127.0.0.1 controls *both* headers, so they agree perfectly —
  // and agreement was the whole test. Only a name the server was told to
  // answer to is accepted.
  const hosts = allowedHosts({} as NodeJS.ProcessEnv);
  const headers = (h: Record<string, string>) => ({ headers: h }) as any;

  const rebound = refuseWrite(
    headers({ host: 'evil.example:4242', origin: 'http://evil.example:4242', 'content-type': 'application/json' }),
    hosts,
  );
  assert.match(rebound!, /does not answer to that hostname/);

  // Loopback still works, by name and by address, with and without a port.
  for (const host of ['127.0.0.1:4242', 'localhost:4242', '[::1]:4242', 'localhost']) {
    assert.equal(refuseWrite(headers({ host, 'content-type': 'application/json' }), hosts), null, host);
  }

  // A page on an allowed host cannot reach it from a disallowed origin.
  assert.match(
    refuseWrite(
      headers({ host: '127.0.0.1:4242', origin: 'https://evil.example', 'content-type': 'application/json' }),
      hosts,
    )!,
    /cross-origin/,
  );

  // A local dev hostname is added by configuration, never inferred.
  const configured = allowedHosts({ QUORUM_HOSTS: 'quorum.local.example.com' } as NodeJS.ProcessEnv);
  const dev = { host: 'quorum.local.example.com', origin: 'https://quorum.local.example.com', 'content-type': 'application/json' };
  assert.match(refuseWrite(headers(dev), hosts)!, /does not answer/);
  assert.equal(refuseWrite(headers(dev), configured), null);
});

test('a rebound hostname is refused on the MCP endpoint too — a tool call is a write (#32)', async () => {
  // post_message, vote, and claim_scope all arrive as MCP tool calls, over
  // this same server, on /mcp rather than /api/. The guard above means
  // nothing if that surface answers a rebound Host regardless. Node's
  // http.request, connecting by IP with an explicit Host header, reproduces
  // what a rebinding attacker's browser actually sends — unlike fetch, which
  // derives Host from the URL and cannot be made to lie about it.
  const rebound = await new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: server.port,
        path: MCP_PATH,
        method: 'POST',
        headers: { host: 'evil.example', origin: 'http://evil.example', 'content-type': 'application/json' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
  });
  assert.equal(rebound.status, 403);
  assert.match(rebound.body.error, /does not answer to that hostname/);
});

test('a text/plain tool call cannot skip the preflight on /mcp (#32)', async () => {
  // refuseOrigin lets a literal `Origin: null` through (sandboxed iframes
  // send it), and /mcp adds no content-type check of its own — the
  // transport's insistence on application/json is what forces a cross-origin
  // attempt into a preflight this server never answers. That insistence
  // lives in the SDK, not in this repo, so pin it: if an upgrade ever
  // relaxes it, this is the test that says the quiet assumption broke.
  //
  // The Accept header is the valid MCP one on purpose: the transport checks
  // Accept before Content-Type, so without it the request dies a 406 and the
  // content-type path this test exists to pin goes unexercised (#69 review).
  const simple = await new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: server.port,
        path: MCP_PATH,
        method: 'POST',
        headers: {
          host: `127.0.0.1:${server.port}`,
          origin: 'null',
          accept: 'application/json, text/event-stream',
          'content-type': 'text/plain',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString()) }),
        );
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
  });
  assert.equal(simple.status, 415, 'the refusal is the content-type check, not some earlier gate');
  assert.match(String(simple.body.error?.message), /Content-Type/i);
});

test('a malformed path is a bad request, not a server fault', async () => {
  // `decodeURIComponent('%')` throws URIError, which is not a domain error, so
  // it escaped as a 500 carrying an internal message. The server survived it —
  // the top-level handler catches — but answering a bad request with "500: URI
  // malformed" tells the caller the server broke when the caller did.
  const bad = await post('/api/rooms/%/join', { participantId: 'whoever' });
  assert.equal(bad.status, 409);
  assert.match(bad.body.error, /not a valid name/);
  assert.ok(!/URI malformed/.test(bad.body.error), 'no internal error text reaches the caller');

  // Still serving afterwards.
  assert.equal((await get('/api/rooms')).status, 200);
});

test('TLS is off unless configured, and half-configured is a startup error', () => {
  assert.equal(loadTls({} as NodeJS.ProcessEnv), null, 'loopback is already a secure context');

  // Half-configured is worse than none: it would fail at the first request,
  // by which time whoever set it is somewhere else.
  assert.throws(
    () => loadTls({ QUORUM_TLS_CERT: '/nowhere/cert.pem' } as NodeJS.ProcessEnv),
    /must be set together/,
  );
});

test('an encrypted key without its passphrase fails at startup, in words', () => {
  // Node says `error:1C800064:Provider routines::bad decrypt` and prints a
  // stack. That names nothing an operator can act on, and it arrives from
  // inside the server constructor rather than from the thing that read the
  // file — so the material is proven usable at load, where it can be
  // explained.
  const dir = mkdtempSync(joinPath(tmpdir(), 'quorum-tls-'));
  const cert = joinPath(dir, 'cert.pem');
  const key = joinPath(dir, 'key.pem');
  writeFileSync(cert, '-----BEGIN CERTIFICATE-----\nnot a certificate\n-----END CERTIFICATE-----\n');
  writeFileSync(key, '-----BEGIN ENCRYPTED PRIVATE KEY-----\nnot a key\n-----END ENCRYPTED PRIVATE KEY-----\n');

  assert.throws(() => loadTls({ QUORUM_TLS_CERT: cert, QUORUM_TLS_KEY: key } as NodeJS.ProcessEnv));

  const explained = explainTlsFailure(new Error('error:1C800064:Provider routines::bad decrypt'));
  assert.match(explained, /passphrase/);
  assert.match(explained, /QUORUM_TLS_PASSPHRASE_FILE/, 'the message names the fix, not the symptom');

  assert.match(explainTlsFailure(new Error("ENOENT: no such file, open '/nope'")), /missing/);
});

test('a passphrase file is read exactly, minus one line ending', () => {
  // `.trim()` here silently changes the secret. The resulting failure says
  // "wrong passphrase", so the operator retypes something that was right all
  // along and the retyping never helps.
  const dir = mkdtempSync(joinPath(tmpdir(), 'quorum-pass-'));
  const write = (name: string, content: string) => {
    const file = joinPath(dir, name);
    writeFileSync(file, content);
    return file;
  };

  assert.equal(readPassphrase(write('spaces', ' a b ')), ' a b ', 'surrounding spaces are part of it');
  assert.equal(readPassphrase(write('nl', 'secret\n')), 'secret', 'one trailing newline is the editor, not the secret');
  assert.equal(readPassphrase(write('crlf', 'secret\r\n')), 'secret');
  assert.equal(readPassphrase(write('bare', 'secret')), 'secret', 'a file with no newline still works');
  assert.equal(readPassphrase(write('two', 'secret\n\n')), 'secret\n', 'only one line ending comes off');
});

test('the printed URLs come from the certificate, not from the bind address', () => {
  // Printing https://127.0.0.1 while serving a certificate issued for a name
  // produces URLs that fail verification — in exactly the lines someone
  // copies. The certificate knows its own name, so it is read rather than
  // asked for.
  assert.equal(certificateHost(Buffer.from(FIXTURE_CERT)), 'quorum.test.example');

  // Nothing usable in it: the caller keeps whatever it was going to print.
  assert.equal(certificateHost(Buffer.from('not a certificate')), null);
});

test('an unexpected failure tells the operator, not the caller', async () => {
  // Reaching the last-resort catch takes a *bug*, not a bad request: every
  // expected refusal is answered in words by the handler that recognised it.
  // So the failure is injected — a read that throws something the API does not
  // recognise, which is exactly the shape whose message would name a path, a
  // SQL fragment, or a stack.
  //
  // Flagged by CodeQL as js/stack-trace-exposure once code scanning was turned
  // on, in the one repo of the fleet that had it off.
  const broken = new Proxy(quorum, {
    get(target, prop, receiver) {
      if (prop === 'listRooms') {
        return () => {
          throw new Error('ENOENT: no such file, open /Users/secret/.quorum/quorum.db');
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  const sabotaged = await startServer({ quorum: broken as typeof quorum, tls: null });
  const logged: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    logged.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    const response = await fetch(`http://127.0.0.1:${sabotaged.port}/api/rooms`);
    const body = (await response.json()) as { error: string };

    assert.equal(response.status, 500, 'a bug is a server fault, and says so');
    assert.match(body.error, /the server failed to handle that request/);
    assert.ok(!body.error.includes('ENOENT'), 'the internal message does not reach the caller');
    assert.ok(!body.error.includes('/Users/secret'), 'nor the path inside it');
    assert.ok(!/\.ts:\d+|node:internal/.test(body.error), 'nor a stack');

    // The detail is not discarded — it goes where someone can act on it.
    const written = logged.join('');
    assert.match(written, /ENOENT/, 'the operator gets the real error');
    assert.match(written, /\/Users\/secret/, 'including the part the caller must not see');
  } finally {
    process.stderr.write = realWrite;
    await sabotaged.close();
  }
});
