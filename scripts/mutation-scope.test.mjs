import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_TAP_MUTATE,
  DEFAULT_VITEST_MUTATE,
  scopeForChangedFiles,
} from './mutation-scope.mjs';

describe('mutation-scope (issue #66)', () => {
  it('maps a changed package src file to that package mutate globs', () => {
    assert.deepEqual(
      scopeForChangedFiles(['packages/host/src/dispatch.ts']).vitest,
      ['packages/host/src/**/*.ts', '!packages/host/src/**/*.test.ts'],
    );
  });

  it('maps a changed script SUT to the tap mutate file', () => {
    assert.deepEqual(scopeForChangedFiles(['scripts/dep-lint.mjs']).tap, [
      'scripts/dep-lint.mjs',
    ]);
  });

  it('maps a changed script test to its SUT file', () => {
    assert.deepEqual(scopeForChangedFiles(['scripts/dep-lint.test.mjs']).tap, [
      'scripts/dep-lint.mjs',
    ]);
  });

  it('unions scopes across packages and dedupes repeats', () => {
    assert.deepEqual(
      scopeForChangedFiles([
        'packages/host/src/dispatch.ts',
        'packages/host/src/dispatch.test.ts',
        'packages/trajectory/src/schema.ts',
      ]).vitest,
      [
        'packages/host/src/**/*.ts',
        '!packages/host/src/**/*.test.ts',
        'packages/trajectory/src/**/*.ts',
        '!packages/trajectory/src/**/*.test.ts',
      ],
    );
  });

  it('falls back to the proof scope when nothing relevant changed', () => {
    const scope = scopeForChangedFiles(['README.md', 'docs/plan.md']);
    assert.deepEqual(scope.vitest, DEFAULT_VITEST_MUTATE);
    assert.deepEqual(scope.tap, DEFAULT_TAP_MUTATE);
  });

  it('falls back to the proof scope on empty input', () => {
    const scope = scopeForChangedFiles([]);
    assert.deepEqual(scope.vitest, DEFAULT_VITEST_MUTATE);
    assert.deepEqual(scope.tap, DEFAULT_TAP_MUTATE);
  });
});
