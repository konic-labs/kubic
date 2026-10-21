// Built-in benchmark suites: exact shape assertions, so a dropped or added
// suite, a flipped stub flag or a findSuite rewrite fails here.
import { describe, expect, it } from 'vitest';
import { EVAL_CATEGORIES } from './categories.js';
import { EVAL_SUITES, findSuite, resolveSuites } from './suites.js';

describe('eval suites exact shape', () => {
  it('covers all eight required categories, in order', () => {
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

  it('runs every suite but the live-PTY one', () => {
    // The faux fixture suites execute through the real lane; terminal-live
    // still needs a live PTY the binary does not ship, so it stays a stub.
    expect(
      EVAL_SUITES.filter((suite) => !suite.stub).map((suite) => suite.id),
    ).toEqual([
      'swe-bench-mini',
      'repo-mod-rename',
      'bugfix-repro',
      'refactor-extract',
      'testgen-cover',
      'review-diff',
      'agentic-live',
    ]);
    expect(
      EVAL_SUITES.filter((suite) => suite.stub).map((suite) => suite.id),
    ).toEqual(['terminal-live']);
  });

  it('gives every executable suite a task, a faux script, files and a gate command', () => {
    for (const suite of EVAL_SUITES) {
      if (suite.stub) {
        expect(suite.fixture, suite.id).toBeUndefined();
        continue;
      }
      // A real model reads the plain-language task; the faux provider runs
      // the script.
      expect(suite.fixture?.task, suite.id).not.toMatch(/faux:/);
      expect(suite.fixture?.task.length ?? 0, suite.id).toBeGreaterThan(20);
      expect(suite.fixture?.fauxPrompt, suite.id).toMatch(/faux:tool /);
      expect(suite.fixture?.files, suite.id).toBeDefined();
      expect(
        Object.values(suite.fixture?.verify ?? {}).some(
          (command) => (command ?? '').trim() !== '',
        ),
        suite.id,
      ).toBe(true);
    }
  });

  it('resolves a category alias to its suites, and an unknown selector to undefined', () => {
    expect(resolveSuites('swe')?.map((suite) => suite.id)).toEqual([
      'swe-bench-mini',
    ]);
    expect(resolveSuites('review')?.map((suite) => suite.id)).toEqual([
      'review-diff',
    ]);
    expect(resolveSuites('swe-bench-mini')?.map((suite) => suite.id)).toEqual([
      'swe-bench-mini',
    ]);
    expect(resolveSuites(undefined)).toHaveLength(EVAL_SUITES.length);
    expect(resolveSuites('all')).toHaveLength(EVAL_SUITES.length);
    expect(resolveSuites('nope')).toBeUndefined();
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

describe('findSuite', () => {
  it('returns the exact suite record for a known id', () => {
    expect(findSuite('swe-bench-mini')).toEqual({
      id: 'swe-bench-mini',
      category: 'swe',
      title: 'SWE mini',
      stub: false,
      description:
        'Minimal coding-task signal: the fix file lands and the gate passes.',
      fixture: {
        task: 'Create the file src/fix.ts exporting a constant named `fixed` set to `true`.',
        fauxPrompt:
          'faux:tool write {"path":"src/fix.ts","content":"export const fixed = true;\\n"}',
        files: {},
        verify: { tests: 'test -f src/fix.ts' },
      },
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
