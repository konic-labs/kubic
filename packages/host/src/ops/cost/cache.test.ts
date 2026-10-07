// (2) cache preservation check + prefix hit-rate.
import { describe, expect, it } from 'vitest';
import {
  checkCachePreservation,
  prefixHitRate,
  transparentCachingNote,
} from './cache.js';

describe('cache preservation', () => {
  it('preserves the prefix when nothing breaks it', () => {
    const verdict = checkCachePreservation({ breaksPrefix: [] });
    expect(verdict.preserved).toBe(true);
  });

  it('reports a broken prefix with a named reason', () => {
    const verdict = checkCachePreservation({
      breaksPrefix: ['system-prompt-rewrite'],
    });
    expect(verdict.preserved).toBe(false);
    expect(verdict.reason).toMatch(/system-prompt-rewrite/);
  });

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
