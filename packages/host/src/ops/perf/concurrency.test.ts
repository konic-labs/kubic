// Aggregate concurrency limits RED slice 4 (issue #55; §45, §71): when
// aggregate caps are configured they gate spawn; when absent the spawn
// path admits. Fails until concurrency.js lands.
import { describe, expect, it } from 'vitest';
import {
  checkPerfAggregateAdmission,
  isPerfAggregateEnforced,
} from './concurrency.js';

describe('perf aggregate admission', () => {
  it('admits everything when no caps are configured', () => {
    expect(isPerfAggregateEnforced(undefined)).toBe(false);
    expect(
      checkPerfAggregateAdmission([{ memMb: 900 }], { memMb: 100 }, undefined),
    ).toEqual({ admitted: true });
  });

  it('denies a candidate that blows a configured mem cap', () => {
    expect(isPerfAggregateEnforced({ maxMemMb: 1000 })).toBe(true);
    const verdict = checkPerfAggregateAdmission(
      [{ memMb: 900 }],
      { memMb: 200 },
      { maxMemMb: 1000 },
    );
    expect(verdict.admitted).toBe(false);
  });

  it('admits a candidate that fits under the caps', () => {
    const verdict = checkPerfAggregateAdmission(
      [{ memMb: 400 }],
      { memMb: 200 },
      { maxMemMb: 1000 },
    );
    expect(verdict).toEqual({ admitted: true });
  });
});
