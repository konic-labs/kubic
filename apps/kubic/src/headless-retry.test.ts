// The overflow notice must tell the truth — it fires
// only when a retry actually follows, and the envelope record carries
// whether the retry happened.
import { describe, expect, it } from 'vitest';
import { retryRecord } from './run/outcome.js';
import { overflowRecoveryNotice } from './run/output.js';

const retryDecision = {
  decision: 'retry_with_new_context',
  reason: 'context_overflow',
} as const;

const abandonDecision = {
  decision: 'abandon',
  reason: 'retry budget exhausted after 1 attempt',
} as const;

describe('overflowRecoveryNotice', () => {
  it('announces the compact-and-retry only when a retry follows', () => {
    const text = overflowRecoveryNotice({ ...retryDecision });
    expect(text).toContain('compacting and retrying once');
    expect(text).toContain('context_overflow');
  });

  it('stays silent on abandon: no compaction or retry happens', () => {
    expect(overflowRecoveryNotice({ ...abandonDecision })).toBeUndefined();
  });
});

describe('retryRecord', () => {
  it('carries the retried flag so --json distinguishes retried-then-failed from abandoned', () => {
    expect(retryRecord({ ...retryDecision }, true)).toEqual({
      ...retryDecision,
      retried: true,
    });
    expect(retryRecord({ ...retryDecision }, false)).toEqual({
      ...retryDecision,
      retried: false,
    });
  });

  it('is absent when the lane made no decision', () => {
    expect(retryRecord(undefined, false)).toBeUndefined();
  });
});
