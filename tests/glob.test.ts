import { test } from 'node:test';
import assert from 'node:assert/strict';

import { globsOverlap, normalizePatterns, scopesOverlap } from '../src/domain/glob.ts';

test('identical and nested literal paths overlap', () => {
  assert.equal(globsOverlap('src/index.ts', 'src/index.ts'), true);
  assert.equal(globsOverlap('src/index.ts', 'src/other.ts'), false);
  assert.equal(globsOverlap('src/a/b.ts', 'src/a'), false, 'a file is not its own directory');
});

test('a star matches within one segment only', () => {
  assert.equal(globsOverlap('src/*.ts', 'src/index.ts'), true);
  assert.equal(globsOverlap('src/*.ts', 'src/deep/index.ts'), false);
  assert.equal(globsOverlap('src/*.ts', 'src/*.js'), false);
  assert.equal(globsOverlap('src/a*.ts', 'src/*b.ts'), true, 'ab.ts satisfies both');
});

test('a double star spans any number of segments', () => {
  assert.equal(globsOverlap('**', 'anything/at/all.ts'), true);
  assert.equal(globsOverlap('src/**', 'src/deep/nested/file.ts'), true);
  assert.equal(globsOverlap('src/**', 'docs/readme.md'), false);
  assert.equal(globsOverlap('**/*.ts', 'src/domain/quorum.ts'), true);
  assert.equal(globsOverlap('**/tests/**', 'src/tests/unit/a.ts'), true);
  assert.equal(globsOverlap('src/**/*.ts', 'src/a.ts'), true, '** may match zero segments');
});

test('question marks match exactly one character', () => {
  assert.equal(globsOverlap('src/a?.ts', 'src/ab.ts'), true);
  assert.equal(globsOverlap('src/a?.ts', 'src/a.ts'), false);
});

test('two patterns overlap when any file could satisfy both', () => {
  assert.equal(globsOverlap('tools/**/*.mjs', '**/agent-bot/**'), true);
  assert.equal(globsOverlap('docs/**/*.md', 'src/**/*.ts'), false);
});

test('scopes overlap when any pair of their patterns does', () => {
  assert.equal(scopesOverlap(['docs/**'], ['src/**', 'docs/sop/*.md']), true);
  assert.equal(scopesOverlap(['docs/**'], ['src/**', 'tests/**']), false);
});

test('claiming nothing in particular claims the whole repository', () => {
  assert.deepEqual(normalizePatterns(undefined), ['**']);
  assert.deepEqual(normalizePatterns([]), ['**']);
  assert.deepEqual(normalizePatterns([' src/** ', '']), ['src/**']);
  assert.equal(scopesOverlap(normalizePatterns([]), ['anything/here.ts']), true);
});
