// (8) exact response cache now, semantic explicitly deferred (issue #56): RED first.
import { describe, expect, it } from 'vitest';
import {
  createExactCache,
  SEMANTIC_DEFERRED_NOTE,
  semanticLookup,
} from './response-cache.js';

describe('exact response cache (issue #56)', () => {
  it('hits on an exact key and misses otherwise', () => {
    const cache = createExactCache();
    expect(cache.get('prompt|model|res')).toBe(undefined);
    cache.set('prompt|model|res', 'answer');
    expect(cache.get('prompt|model|res')).toBe('answer');
    expect(cache.get('prompt|model|other')).toBe(undefined);
  });

  it('tracks exact hit-rate measurably', () => {
    const cache = createExactCache();
    cache.set('a', '1');
    cache.get('a');
    cache.get('missing');
    expect(cache.stats().hits).toBe(1);
    expect(cache.stats().total).toBe(2);
  });

  it('semantic lookup has no code path: it is deferred with a doc note', () => {
    expect(() => semanticLookup('anything')).toThrow(/deferred/);
    expect(SEMANTIC_DEFERRED_NOTE).toMatch(/semantic/i);
  });
});
