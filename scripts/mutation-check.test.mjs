import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { belowThreshold, fileScores } from './mutation-check.mjs';

const report = (files) => ({ files });

describe('mutation-check (issue #66)', () => {
  it('scores a file from killed vs survived mutants', () => {
    const scores = fileScores(
      report({
        'packages/trajectory/src/schema.ts': {
          mutants: [
            { status: 'Killed' },
            { status: 'Killed' },
            { status: 'Survived' },
            { status: 'Timeout' },
          ],
        },
      }),
    );
    assert.equal(scores[0].score, 75);
  });

  it('excludes ignored and error mutants from the score', () => {
    const scores = fileScores(
      report({
        'scripts/dep-lint.mjs': {
          mutants: [
            { status: 'Killed' },
            { status: 'Ignored' },
            { status: 'RuntimeError' },
            { status: 'CompileError' },
            { status: 'Pending' },
          ],
        },
      }),
    );
    assert.equal(scores[0].score, 100);
    assert.equal(scores[0].total, 1);
  });

  it('reports null score for files with no scored mutants', () => {
    const scores = fileScores(report({ 'empty.ts': { mutants: [] } }));
    assert.equal(scores[0].score, null);
  });

  it('lists only files below the threshold', () => {
    const scores = fileScores(
      report({
        'a.ts': { mutants: [{ status: 'Killed' }] },
        'b.ts': { mutants: [{ status: 'Survived' }] },
        'c.ts': { mutants: [] },
      }),
    );
    assert.deepEqual(
      belowThreshold(scores, 80).map((s) => s.file),
      ['b.ts'],
    );
  });

  it('keeps a file exactly at the threshold', () => {
    const scores = fileScores(
      report({
        'edge.ts': {
          mutants: [
            { status: 'Killed' },
            { status: 'Killed' },
            { status: 'Killed' },
            { status: 'Killed' },
            { status: 'Survived' },
          ],
        },
      }),
    );
    assert.equal(scores[0].score, 80);
    assert.deepEqual(belowThreshold(scores, 80), []);
  });
});
