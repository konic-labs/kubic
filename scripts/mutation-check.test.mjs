import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { belowThreshold, fileScores } from './mutation-check.mjs';

const CLI = join(import.meta.dirname, 'mutation-check.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'mutation-check-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

function runCli(name, report, extra = []) {
  const path = join(scratch, name);
  if (report !== undefined) writeFileSync(path, JSON.stringify(report));
  return spawnSync(process.execPath, [CLI, '--report', path, ...extra], {
    encoding: 'utf8',
  });
}

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

describe('mutation-check baseline ratchet (issue #72)', () => {
  const at = (file, killed, survived) =>
    fileScores(
      report({
        [file]: {
          mutants: [
            ...Array(killed).fill({ status: 'Killed' }),
            ...Array(survived).fill({ status: 'Survived' }),
          ],
        },
      }),
    );

  it('passes a file below --min that did not drop below its baseline', () => {
    const baseline = new Map([['old.ts', 55]]);
    assert.deepEqual(belowThreshold(at('old.ts', 6, 4), 80, baseline), []);
  });

  it('fails a file that dropped below its baseline', () => {
    const baseline = new Map([['old.ts', 70]]);
    assert.deepEqual(
      belowThreshold(at('old.ts', 6, 4), 80, baseline).map((s) => s.bar),
      [70],
    );
  });

  it('caps the bar at --min for files already above it', () => {
    const baseline = new Map([['good.ts', 95]]);
    assert.deepEqual(belowThreshold(at('good.ts', 4, 1), 80, baseline), []);
    assert.equal(belowThreshold(at('good.ts', 3, 1), 80, baseline)[0].bar, 80);
  });

  it('holds new files (absent from the baseline) to --min', () => {
    const baseline = new Map([['old.ts', 10]]);
    assert.equal(belowThreshold(at('new.ts', 7, 3), 80, baseline)[0].bar, 80);
  });
});

describe('mutation-check CLI (the npm run test:mutation gate)', () => {
  it('exits 1 naming each file below --min', () => {
    const result = runCli('below.json', {
      files: {
        'a.ts': { mutants: [{ status: 'Killed' }] },
        'b.ts': { mutants: [{ status: 'Killed' }, { status: 'Survived' }] },
      },
    });
    assert.equal(result.status, 1, 'a file under the bar must fail the gate');
    assert.match(result.stderr, /mutation-check: b\.ts at 50% < 80%/);
    assert.doesNotMatch(result.stderr, /a\.ts/);
  });

  it('honours --min', () => {
    const report = {
      files: {
        'b.ts': { mutants: [{ status: 'Killed' }, { status: 'Survived' }] },
      },
    };
    assert.equal(runCli('min.json', report, ['--min', '50']).status, 0);
    assert.equal(runCli('min.json', report, ['--min', '51']).status, 1);
  });

  it('exits 1 when the report cannot be read', () => {
    const result = runCli('missing.json', undefined);
    assert.equal(result.status, 1, 'a missing report must not pass the gate');
    assert.match(result.stderr, /cannot read .*missing\.json/);
  });

  it('--baseline ratchets each file against a previous report', () => {
    runCli('base.json', {
      files: {
        'old.ts': { mutants: [{ status: 'Killed' }, { status: 'Survived' }] },
      },
    });
    const now = {
      files: {
        'old.ts': {
          mutants: [
            { status: 'Killed' },
            { status: 'Killed' },
            { status: 'Survived' },
          ],
        },
        'new.ts': { mutants: [{ status: 'Killed' }, { status: 'Survived' }] },
      },
    };
    const result = runCli('now.json', now, [
      '--baseline',
      join(scratch, 'base.json'),
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /new\.ts at 50% < 80%/);
    assert.doesNotMatch(result.stderr, /old\.ts/);
  });

  it('exits 1 when --baseline cannot be read', () => {
    const result = runCli('ok2.json', { files: {} }, [
      '--baseline',
      join(scratch, 'nope.json'),
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cannot read .*nope\.json/);
  });

  it('exits 0 when every file meets the bar', () => {
    const result = runCli('ok.json', {
      files: {
        'a.ts': { mutants: [{ status: 'Killed' }] },
        'c.ts': { mutants: [] },
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /100% \(1\/1\)\ta\.ts/);
    assert.match(result.stdout, /no mutants\tc\.ts/);
  });
});
