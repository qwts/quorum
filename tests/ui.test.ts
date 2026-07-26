// The library's own guardrails.
//
// These do not check that the components look right — a screenshot does that,
// and a human does it better. They check the four things that go wrong
// silently: a design that moved without the library noticing, a screen that
// hardcodes a value, a component that names a token nobody defined, and a
// render path that could turn a participant's message into markup. Every one
// of those still renders something plausible, which is exactly why they need
// a test rather than an eye.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { IncomingMessage, ServerResponse } from 'node:http';
import { checkDesignDrift, designVersion } from '../src/ui/drift.ts';
// A browser module, imported in Node on purpose: the phase rules are pure, so
// they are testable without a browser, and the one below is worth testing.
import { optionChipProps } from '../src/ui/lib/phase.js';
import { serveUi } from '../src/ui/serve.ts';

// fileURLToPath, not .pathname: a percent-encoded path breaks every read.
const UI = fileURLToPath(new URL('../src/ui/', import.meta.url));

function read(...parts: string[]): string {
  return readFileSync(join(UI, ...parts), 'utf8');
}

function filesIn(dir: string, extension: string): string[] {
  return readdirSync(join(UI, dir), { recursive: true, encoding: 'utf8' }).filter((name) =>
    name.endsWith(extension),
  );
}

test('the library records which design version it implements, and says so out loud when it drifts', () => {
  const drift = checkDesignDrift();
  assert.equal(drift.ok, true, drift.ok ? '' : drift.message);

  // The failure path is the one that matters — a drift check that cannot
  // report drift is a green light with the bulb removed.
  assert.equal(designVersion('design_system: quorum\ndesign_version: 9.9.9\n'), '9.9.9');
  assert.throws(() => designVersion('no version here'), /carries no `design_version:` line/);
});

test('every delta from the shipped design carries a reason', () => {
  const record = JSON.parse(read('design-version.json'));
  assert.ok(record.deltas.length > 0, 'a library that matched the design exactly would have none — say so explicitly');
  for (const delta of record.deltas) {
    assert.match(delta.id, /^D-\d+$/);
    assert.ok(delta.what && delta.why, `${delta.id} states what changed and why`);
    assert.ok(
      ['adaptation', 'conflict', 'upstream-answered'].includes(delta.kind),
      `${delta.id}: an extension is not a kind of delta — the library may not extend the design`,
    );
  }

  // Every delta is answerable by our human, so every delta is a question too.
  const questions = read('QUESTIONS.md');
  assert.match(questions, /## Open, from the implementation/);
  assert.ok(
    questions.split('### Q').length > 5,
    'an empty QUESTIONS.md next to an invented value is the failure this file exists to prevent',
  );
});

test('a hidden option hides its tally and never its label', () => {
  // You cannot cast a ballot for a choice you cannot read. Two options that
  // both render as "hidden" are not a ballot, they are a coin toss — and the
  // failure looks deliberate, because concealment during voting *is* the
  // design. Screenshot 04 is the arbiter: both options named, no counts.
  const options = [
    { option: 'Add version field now', count: 3, total: 4, hidden: true },
    { option: 'Defer to v1', count: 1, total: 4 },
  ];

  for (const phase of ['challenging', 'voting', 'converged', 'failed']) {
    for (const option of options) {
      assert.equal(
        optionChipProps(option, phase).option,
        option.option,
        `the label disappeared in ${phase} — no phase conceals which option you are voting for`,
      );
    }
  }

  // Voting conceals every tally, whatever the option says.
  for (const option of options) {
    assert.deepEqual(optionChipProps(option, 'voting'), { option: option.option, count: null, total: null });
  }

  // After close the tally is the record; `hidden` still suppresses its own.
  assert.deepEqual(optionChipProps(options[1]!, 'converged'), {
    option: 'Defer to v1',
    count: 1,
    total: 4,
  });
  assert.equal(optionChipProps(options[0]!, 'converged').count, null, '`hidden` suppresses this option`s tally');
});

test('screen code contains no literal colour, size or duration', () => {
  // The acceptance criterion, mechanised: an agent building a screen should
  // never have had to choose a value, so a literal is evidence it did.
  //
  // Only the CSS in a screen is scanned, not its prose. A claim really does
  // have a `ttl 1800s` and a deadline really is `phase_ends_at 14:35` — those
  // are the product's own precise numbers, which the copy rules ask for. A
  // check that failed on them would teach whoever hit it to vague the copy.
  const literals = [
    { name: 'a hex colour', pattern: /#[0-9a-fA-F]{3,8}\b/g },
    { name: 'a pixel size', pattern: /\b\d+(\.\d+)?px\b/g },
    { name: 'a duration', pattern: /\b\d+(\.\d+)?m?s\b/g },
  ];
  for (const file of filesIn('kit', '.html')) {
    const text = read('kit', file);
    const css = [
      ...[...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]!),
      ...[...text.matchAll(/\sstyle="([^"]*)"/g)].map((m) => m[1]!),
    ].join('\n');
    for (const { name, pattern } of literals) {
      const hits = css.match(pattern) ?? [];
      assert.deepEqual(
        hits,
        [],
        `kit/${file} hardcodes ${name} (${hits.join(', ')}) in its CSS. Every value has a token; if the one you need does not exist, that is a question for QUESTIONS.md.`,
      );
    }
  }
});

test('every token a component names is a token the design defines', () => {
  // CSS swallows an undefined custom property: `color: var(--phase-votng)`
  // renders as inherited text and nothing anywhere says why.
  const declared = new Set<string>();
  for (const file of filesIn('tokens', '.css')) {
    for (const match of read('tokens', file).matchAll(/(--[a-z0-9-]+)\s*:/g)) declared.add(match[1]!);
  }
  assert.ok(declared.size > 100, 'the token files loaded');

  // Set by the components themselves on their own host, per instance.
  const local = new Set(['--hue', '--tone', '--step-hue', '--step-tint', '--share']);

  for (const file of [...filesIn('components', '.js'), ...filesIn('lib', '.js')]) {
    const where = file.includes('/') ? file : file;
    const text = read(readdirSync(join(UI, 'components')).includes(file) ? 'components' : 'lib', file);
    for (const match of text.matchAll(/var\((--[a-z0-9-]+)/g)) {
      const token = match[1]!;
      assert.ok(
        declared.has(token) || local.has(token),
        `${where} names ${token}, which no token file declares. Adding it here would be extending the design system, not implementing it.`,
      );
    }
  }
});

test('no component can render a participant message as markup', () => {
  // Message bodies are untrusted input (AGENTS.md). `h()` sets textContent and
  // there is no other path, so the guarantee is structural — this test keeps
  // it that way when somebody adds the eighth component.
  for (const file of [...filesIn('components', '.js'), ...filesIn('lib', '.js')]) {
    const text = read(readdirSync(join(UI, 'components')).includes(file) ? 'components' : 'lib', file);
    for (const forbidden of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
      assert.ok(
        !text.includes(forbidden),
        `${file} uses ${forbidden}; a message body reaching it is a cross-site scripting hole wearing a design system`,
      );
    }
  }
});

test('the UI is served from src/ui and nowhere else', async () => {
  const asked = async (pathname: string, method = 'GET') => {
    const req = { method, headers: {} } as IncomingMessage;
    let status = 0;
    let body = '';
    const res = {
      writeHead(code: number) {
        status = code;
        return this;
      },
      end(chunk?: string) {
        body = chunk ?? '';
      },
      pipe() {},
    } as unknown as ServerResponse;
    const handled = await serveUi(req, res, pathname);
    return { handled, status, body };
  };

  assert.equal((await asked('/mcp')).handled, false, 'a non-UI path is not this handler to answer');
  assert.equal((await asked('/ui/')).status, 302, 'the root redirects rather than serving a page from the wrong depth');

  // Traversal, and the extension allowlist. v0 binds to loopback and trusts
  // the machine boundary; that is a reason to keep this narrow, not to skip it.
  assert.equal((await asked('/ui/../package.json')).status, 404);
  assert.equal((await asked('/ui/%2e%2e%2fpackage.json')).status, 404);
  assert.equal((await asked('/ui/../../../etc/passwd')).status, 404);
  assert.equal((await asked('/ui/drift.ts')).status, 404, 'server-side sources are not part of the UI');
  assert.equal((await asked('/ui/styles.css', 'POST')).status, 405);
});
