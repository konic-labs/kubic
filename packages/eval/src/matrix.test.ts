import { describe, expect, it } from 'vitest';
import { EVAL_CATEGORIES } from './categories.js';
import { EVAL_SUITES } from './suites.js';

describe('eval categories (issue #53)', () => {
  it('covers all eight required categories', () => {
    expect([...EVAL_CATEGORIES]).toEqual([
      'swe',
      'repo-mod',
      'bugfix',
      'refactor',
      'testgen',
      'review',
      'terminal',
      'agentic',
    ]);
  });

  it('ships at least one suite per category with stubs marked', () => {
    for (const category of EVAL_CATEGORIES) {
      const suites = EVAL_SUITES.filter((s) => s.category === category);
      expect(
        suites.length,
        `category ${category} must have >=1 suite`,
      ).toBeGreaterThan(0);
      for (const suite of suites) {
        expect(typeof suite.stub).toBe('boolean');
      }
    }
  });
});
