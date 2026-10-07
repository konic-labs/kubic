import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  changedRanges,
  MAX_VITEST_FILES,
  MAX_VITEST_LINES,
  tapScope,
  vitestScope,
} from './mutation-scope.mjs';

// `git diff -U0 --no-prefix` shaped input.
const diff = (...files) =>
  files
    .map(
      ([path, hunks]) =>
        `diff --git ${path} ${path}\n--- ${path}\n+++ ${path}\n${hunks.join('\n')}`,
    )
    .join('\n');

describe('changedRanges', () => {
  it('reads added/changed line ranges from -U0 hunk headers', () => {
    const ranges = changedRanges(
      diff([
        'packages/host/src/a.ts',
        ['@@ -3,0 +4,2 @@', '+x', '+y', '@@ -10 +12 @@', '-old', '+new'],
      ]),
    );
    assert.deepEqual(ranges.get('packages/host/src/a.ts'), [
      [4, 5],
      [12, 12],
    ]);
  });

  it('skips pure deletions and deleted files', () => {
    const ranges = changedRanges(
      [
        diff(['packages/host/src/a.ts', ['@@ -7,3 +6,0 @@', '-a', '-b', '-c']]),
        'diff --git gone.ts gone.ts\n--- packages/core/src/gone.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@',
      ].join('\n'),
    );
    assert.equal(ranges.size, 0);
  });
});

describe('vitestScope', () => {
  it('mutates only the changed lines of source files', () => {
    const scope = vitestScope(
      new Map([
        [
          'packages/host/src/a.ts',
          [
            [4, 5],
            [12, 12],
          ],
        ],
        ['apps/kubic/src/main.ts', [[1, 3]]],
      ]),
    );
    assert.deepEqual(scope.mutate, [
      'apps/kubic/src/main.ts:1-3',
      'packages/host/src/a.ts:4-5',
      'packages/host/src/a.ts:12-12',
    ]);
    assert.equal(scope.dropped, 0);
  });

  it('ignores tests, declarations and non-source paths', () => {
    const scope = vitestScope(
      new Map([
        ['packages/host/src/a.test.ts', [[1, 9]]],
        ['packages/host/src/types.d.ts', [[1, 9]]],
        ['packages/host/package.json', [[1, 9]]],
        ['scripts/dep-lint.mjs', [[1, 9]]],
        ['docs/cli/commands.md', [[1, 9]]],
      ]),
    );
    assert.deepEqual(scope, { mutate: [], dropped: 0 });
  });

  it('caps the number of files and reports how many were dropped', () => {
    const ranges = new Map(
      Array.from({ length: MAX_VITEST_FILES + 5 }, (_, i) => [
        `packages/core/src/f${String(i).padStart(3, '0')}.ts`,
        [[1, 2]],
      ]),
    );
    const scope = vitestScope(ranges);
    assert.equal(
      new Set(scope.mutate.map((m) => m.split(':')[0])).size,
      MAX_VITEST_FILES,
    );
    assert.equal(scope.mutate[0], 'packages/core/src/f000.ts:1-2');
    assert.equal(scope.dropped, 5);
  });

  // A mutant costs about a second on a hosted runner, so the per-push job is
  // bounded by changed LINES (a core file alone can hold ~1k mutants), not
  // just by file count: a wave-sized push used to run into the 30-minute job
  // limit and end 'cancelled' instead of scored.
  it('caps the total changed lines: a file that does not fit is dropped, later ones that do fit stay', () => {
    const scope = vitestScope(
      new Map([
        ['packages/host/src/a.ts', [[1, MAX_VITEST_LINES - 500]]],
        ['packages/host/src/b.ts', [[1, 1000]]],
        ['packages/host/src/c.ts', [[1, 500]]],
      ]),
    );
    assert.deepEqual(scope.mutate, [
      `packages/host/src/a.ts:1-${MAX_VITEST_LINES - 500}`,
      'packages/host/src/c.ts:1-500',
    ]);
    assert.equal(scope.dropped, 1);
  });

  it('keeps a file that fills the budget exactly and drops the next one', () => {
    const scope = vitestScope(
      new Map([
        ['packages/host/src/a.ts', [[1, MAX_VITEST_LINES]]],
        ['packages/host/src/b.ts', [[1, 1]]],
      ]),
    );
    assert.deepEqual(scope.mutate, [
      `packages/host/src/a.ts:1-${MAX_VITEST_LINES}`,
    ]);
    assert.equal(scope.dropped, 1);
  });

  it('trims a lone oversized first file to the budget instead of running unbounded', () => {
    const scope = vitestScope(
      new Map([
        [
          'packages/host/src/a.ts',
          [
            [1, MAX_VITEST_LINES - 500],
            [5000, 6999],
          ],
        ],
      ]),
    );
    assert.deepEqual(scope.mutate, [
      `packages/host/src/a.ts:1-${MAX_VITEST_LINES - 500}`,
      'packages/host/src/a.ts:5000-5499',
    ]);
    assert.equal(scope.dropped, 0);
  });

  it('counts ranges by lines, inclusive of both ends', () => {
    const scope = vitestScope(
      new Map([
        ['packages/host/src/a.ts', [[10, 10]]],
        ['packages/host/src/b.ts', [[1, MAX_VITEST_LINES - 1]]],
        ['packages/host/src/c.ts', [[1, 1]]],
      ]),
    );
    // a (1 line) + b (LIMIT-1 lines) fill the budget exactly; c does not fit.
    assert.deepEqual(scope.mutate, [
      'packages/host/src/a.ts:10-10',
      `packages/host/src/b.ts:1-${MAX_VITEST_LINES - 1}`,
    ]);
    assert.equal(scope.dropped, 1);
  });
});

describe('tapScope', () => {
  it('maps a changed script SUT and its test to the tap mutate file', () => {
    assert.deepEqual(tapScope(['scripts/dep-lint.mjs']), [
      'scripts/dep-lint.mjs',
    ]);
    assert.deepEqual(tapScope(['scripts/dep-lint.test.mjs']), [
      'scripts/dep-lint.mjs',
    ]);
  });

  it('maps the same-named pin test to its SUT', () => {
    assert.deepEqual(tapScope(['scripts/check-pinned-deps.test.mjs']), [
      'scripts/check-pinned-deps.mjs',
    ]);
  });

  it('maps a config-wide script test to every tap SUT', () => {
    assert.deepEqual(tapScope(['scripts/pi-boundary.test.mjs']), [
      'scripts/dep-lint.mjs',
      'scripts/check-pinned-deps.mjs',
    ]);
  });

  it('is empty when no script changed (the step is skipped, not widened)', () => {
    assert.deepEqual(tapScope(['README.md', 'packages/host/src/a.ts']), []);
  });
});
