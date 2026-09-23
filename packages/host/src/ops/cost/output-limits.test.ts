// (6) output limits (issue #56): RED first.
import { describe, expect, it } from 'vitest';
import { applyOutputLimit, validateOutputLimit } from './output-limits.js';

describe('output limits (issue #56)', () => {
  it('passes short output through untouched', () => {
    expect(applyOutputLimit('hello', 100)).toBe('hello');
  });

  it('truncates long output with an explicit marker', () => {
    const out = applyOutputLimit('x'.repeat(200), 100);
    expect(out.length).toBeLessThan(200);
    expect(out).toMatch(/truncated/);
  });

  it('rejects non-positive limits instead of silently disabling them', () => {
    expect(() => validateOutputLimit(0)).toThrow(/positive/);
    expect(validateOutputLimit(100)).toBe(100);
  });
});
