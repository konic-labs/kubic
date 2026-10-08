// (2) cache preservation check + prefix hit-rate.
import { describe, expect, it } from 'vitest';
import { prefixHitRate, transparentCachingNote } from './cache.js';

describe('cache preservation', () => {
  it('measures the prefix hit-rate from usage rows', () => {
    const rate = prefixHitRate([
      { cacheRead: 100, cacheWrite: 0 },
      { cacheRead: 0, cacheWrite: 50 },
      { cacheRead: 30, cacheWrite: 0 },
    ]);
    expect(rate.hits).toBe(2);
    expect(rate.total).toBe(3);
    expect(rate.rate).toBeCloseTo(2 / 3);
  });

  it('publishes a transparent caching note', () => {
    expect(transparentCachingNote()).toMatch(/cache/i);
  });
});
