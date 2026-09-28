import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_VITEST_FILES, scopeForChangedFiles } from './mutation-scope.mjs';

// Every path "exists" unless listed as missing.
const existsExcept =
  (...missing) =>
  (f) =>
    !missing.includes(f);
const all = existsExcept();

describe('mutation-scope (issues #66, #72)', () => {
  it('mutates exactly the changed source file, not its whole package', () => {
    assert.deepEqual(
      scopeForChangedFiles(['packages/host/src/dispatch.ts'], all).vitest,
      ['packages/host/src/dispatch.ts'],
    );
  });

  it('maps a changed test file to its sibling source file', () => {
    assert.deepEqual(
      scopeForChangedFiles(['packages/host/src/dispatch.test.ts'], all).vitest,
      ['packages/host/src/dispatch.ts'],
    );
  });

  it('drops a changed test with no sibling source and deleted source files', () => {
    const exists = existsExcept(
      'packages/host/src/orchestrate-prod.ts',
      'packages/core/src/gone.ts',
    );
    assert.deepEqual(
      scopeForChangedFiles(
        [
          'packages/host/src/orchestrate-prod.test.ts',
          'packages/core/src/gone.ts',
        ],
        exists,
      ).vitest,
      [],
    );
  });

  it('covers apps/*/src the same way and ignores non-source files', () => {
    assert.deepEqual(
      scopeForChangedFiles(
        [
          'apps/kubic/src/headless-run.ts',
          'packages/host/package.json',
          'packages/host/src/types.d.ts',
          'README.md',
        ],
        all,
      ).vitest,
      ['apps/kubic/src/headless-run.ts'],
    );
  });

  it('dedupes a source and its test changed together, sorted', () => {
    assert.deepEqual(
      scopeForChangedFiles(
        [
          'packages/trajectory/src/schema.ts',
          'packages/host/src/dispatch.test.ts',
          'packages/host/src/dispatch.ts',
        ],
        all,
      ).vitest,
      ['packages/host/src/dispatch.ts', 'packages/trajectory/src/schema.ts'],
    );
  });

  it('caps the vitest scope and reports how many files were dropped', () => {
    const files = Array.from(
      { length: MAX_VITEST_FILES + 5 },
      (_, i) => `packages/core/src/f${String(i).padStart(3, '0')}.ts`,
    );
    const scope = scopeForChangedFiles(files, all);
    assert.equal(scope.vitest.length, MAX_VITEST_FILES);
    assert.equal(scope.vitest[0], 'packages/core/src/f000.ts');
    assert.equal(scope.dropped, 5);
  });

  it('maps a changed script SUT and its test to the tap mutate file', () => {
    assert.deepEqual(scopeForChangedFiles(['scripts/dep-lint.mjs'], all).tap, [
      'scripts/dep-lint.mjs',
    ]);
    assert.deepEqual(
      scopeForChangedFiles(['scripts/dep-lint.test.mjs'], all).tap,
      ['scripts/dep-lint.mjs'],
    );
  });

  it('maps a config-wide script test to every tap SUT', () => {
    assert.deepEqual(
      scopeForChangedFiles(['scripts/pi-boundary.test.mjs'], all).tap,
      ['scripts/dep-lint.mjs', 'scripts/check-pinned-deps.mjs'],
    );
  });

  it('is empty when nothing mutable changed (the step is skipped, not widened)', () => {
    const scope = scopeForChangedFiles(['README.md', 'docs/plan.md'], all);
    assert.deepEqual(scope, { vitest: [], tap: [], dropped: 0 });
  });
});
