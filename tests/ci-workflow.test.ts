import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const codeql = readFileSync(new URL('../.github/workflows/codeql.yml', import.meta.url), 'utf8');
const contributing = readFileSync(new URL('../CONTRIBUTING.md', import.meta.url), 'utf8');

test('CI exposes only the governed lifecycle triggers', () => {
  assert.match(ci, /^  pull_request:$/m);
  assert.match(ci, /types: \[opened, synchronize, reopened, ready_for_review\]/);
  assert.match(ci, /^  push:$/m);
  assert.match(ci, /^  workflow_dispatch:$/m);
  assert.doesNotMatch(ci, /^  (?:merge_group|pull_request_target|repository_dispatch|schedule):$/m);
});

test('drafts skip all jobs and ready updates cancel by PR', () => {
  assert.match(ci, /github\.event\.pull_request\.draft == false/);
  assert.match(ci, /format\('pr-\{0\}', github\.event\.pull_request\.number\)/);
  assert.match(ci, /cancel-in-progress: \$\{\{ github\.event_name != 'push' \}\}/);
  assert.doesNotMatch(ci, /name: Draft checks/);
});

test('actor and fork enforcement is loaded from a trusted immutable commit', () => {
  assert.match(
    ci,
    /uses: qwts\/playbook-engineering\/\.github\/actions\/ci-policy@19d88d7ecdc7b1d842194cd5be3a398cb1211fde/,
  );
  assert.doesNotMatch(ci, /uses: \.\/\.github\/actions\/ci-policy/);
});

test('exact-SHA evidence selects the complete or post-merge lane', () => {
  assert.match(ci, /event=workflow_dispatch&head_sha=\$TARGET_SHA/);
  assert.match(ci, /actions\/runs\?head_sha=\$GITHUB_SHA/);
  assert.match(ci, /\.path == "\.github\/workflows\/ci\.yml"/);
  assert.match(ci, /\.event == "pull_request" and \.conclusion == "success"/);
  assert.match(ci, /\.name == "CI" and \.conclusion == "success"/);
  assert.match(ci, /needs\.preflight-evidence\.outputs\.validated != 'true'/);
  assert.match(ci, /needs\.merge-evidence\.outputs\.validated != 'true'/);
});

test('the existing complete suite remains intact behind the stable CI gate', () => {
  assert.match(ci, /^  test:$/m);
  assert.match(ci, /node-version: 24/);
  assert.match(ci, /run: npm ci/);
  assert.match(ci, /run: npm run typecheck/);
  assert.match(ci, /run: npm test/);
  assert.match(ci, /^  gate:\n    name: CI$/m);
});

test('post-merge work is a focused integration smoke', () => {
  assert.match(ci, /name: Post-merge smoke/);
  assert.match(ci, /node --test tests\/mcp\.test\.ts tests\/web\.test\.ts/);
});

test('post-merge reuses exact-SHA CodeQL evidence and the fallback reruns it', () => {
  const codeqlJob = ci.slice(ci.indexOf('  codeql:'), ci.indexOf('\n  post-merge:'));
  const postMergeGate = ci.slice(ci.indexOf('            post-merge)'), ci.indexOf('\n            *)'));

  assert.match(codeqlJob, /run_post_merge == 'true' && needs\.merge-evidence\.outputs\.validated != 'true'/);
  assert.doesNotMatch(codeqlJob, /run_post_merge == 'true' \|\|/);
  assert.match(
    postMergeGate,
    /if \[ "\$MERGE_VALIDATED" = true \]; then[\s\S]*test "\$POST_MERGE" = success[\s\S]*else[\s\S]*test "\$TEST" = success[\s\S]*test "\$CODEQL" = success/,
  );
  assert.match(contributing, /Dependabot pull requests must use GitHub's \*\*Create a merge commit\*\*/);
});

test('CodeQL remains advanced, reusable, pinned, and covers both existing languages', () => {
  assert.match(codeql, /^  workflow_call:$/m);
  assert.doesNotMatch(codeql, /^  (?:pull_request|push|workflow_dispatch|schedule):$/m);
  assert.match(codeql, /language: \[actions, javascript-typescript\]/);
  assert.match(codeql, /security-events: write/);
  assert.match(codeql, /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/);
  assert.match(codeql, /github\/codeql-action\/init@f205ea1c3313d32999d8d6a48b4f6530d4437b38/);
  assert.match(codeql, /github\/codeql-action\/analyze@f205ea1c3313d32999d8d6a48b4f6530d4437b38/);
});
