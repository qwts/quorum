import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('dev TLS requires the operator to choose the trusted hostname', () => {
  const env = { ...process.env };
  delete env.QUORUM_DEV_HOST;

  const result = spawnSync('sh', ['scripts/dev-tls.sh'], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /QUORUM_DEV_HOST is required/);
  assert.doesNotMatch(result.stderr, /local\.dev\.zts1\.com/);
});
