// Built-in benchmark suites (issue #53; design §48, §76.1) — issue #70
// mutation hardening: exact shape assertions so dropped/added suites,
// flipped stub flags, or a findSuite rewrite cannot survive.
import { describe, expect, it } from 'vitest';
import { EVAL_SUITES, findSuite } from './suites.js';

describe('eval suites exact shape (issue #53, §48)', () => {
  it('ships exactly eight suites, one per category', () => {
    expect(EVAL_SUITES.map((suite) => suite.id)).toEqual([
      'swe-bench-mini',
      'repo-mod-rename',
      'bugfix-repro',
      'refactor-extract',
      'testgen-cover',
      'review-diff',
      'terminal-live',
      'agentic-live',
    ]);
  });

  it('marks the six faux suites live and the two live-only suites stub', () => {
    expect(
      EVAL_SUITES.filter((suite) => !suite.stub).map((suite) => suite.id),
    ).toEqual([
      'swe-bench-mini',
      'repo-mod-rename',
      'bugfix-repro',
      'refactor-extract',
      'testgen-cover',
      'review-diff',
    ]);
    expect(
      EVAL_SUITES.filter((suite) => suite.stub).map((suite) => suite.id),
    ).toEqual(['terminal-live', 'agentic-live']);
  });

  it('pairs each suite with its own category', () => {
    expect(EVAL_SUITES.map((suite) => `${suite.id}:${suite.category}`)).toEqual(
      [
        'swe-bench-mini:swe',
        'repo-mod-rename:repo-mod',
        'bugfix-repro:bugfix',
        'refactor-extract:refactor',
        'testgen-cover:testgen',
        'review-diff:review',
        'terminal-live:terminal',
        'agentic-live:agentic',
      ],
    );
  });

  it('gives every suite a non-empty title and description', () => {
    for (const suite of EVAL_SUITES) {
      expect(suite.title.trim().length).toBeGreaterThan(0);
      expect(suite.description.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('findSuite (issue #53)', () => {
  it('returns the exact suite record for a known id', () => {
    expect(findSuite('swe-bench-mini')).toEqual({
      id: 'swe-bench-mini',
      category: 'swe',
      title: 'SWE mini (faux)',
      stub: false,
      description: 'Minimal coding-task signal: faux run must complete.',
    });
  });

  it('returns undefined for an unknown id — never a fallback suite', () => {
    expect(findSuite('nope')).toBeUndefined();
    expect(findSuite('')).toBeUndefined();
  });

  it('is case-sensitive: a differently-cased id misses', () => {
    expect(findSuite('SWE-BENCH-MINI')).toBeUndefined();
  });
});
