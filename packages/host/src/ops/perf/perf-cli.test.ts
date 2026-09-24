// `kubic perf` CLI tests (issue #79; §61). RED first: perf-cli.ts lands
// after this file. Faux-only — samples are injected argv, no clock.
import { describe, expect, it } from 'vitest';
import { evaluateBudget } from './budgets.js';
import { runPerfCommand } from './perf-cli.js';

function capture() {
  const lines: string[] = [];
  return {
    lines,
    out: (line: string): void => {
      lines.push(line);
    },
  };
}

describe('kubic perf breach (issue #79)', () => {
  it('prints the exact filed regression string', () => {
    const expected = evaluateBudget('spawn', [10, 20, 30, 40, 500]);
    expect(expected.within).toBe(false);
    const cap = capture();
    const code = runPerfCommand(
      ['--budget', 'spawn', '--samples', '10,20,30,40,500'],
      { out: cap.out },
    );
    expect(code).toBe(1);
    expect(cap.lines).toHaveLength(1);
    expect(cap.lines[0]).toBe(expected.regression);
  });

  it('files the breach naming kind, p95, and budget', () => {
    const cap = capture();
    runPerfCommand(['--budget', 'spawn', '--samples', '10,20,30,40,500'], {
      out: cap.out,
    });
    expect(cap.lines[0]).toMatch(/spawn/);
    expect(cap.lines[0]).toMatch(/500/);
    expect(cap.lines[0]).toMatch(/200/);
  });
});

describe('kubic perf pass (issue #79)', () => {
  it('prints nothing gated on a pass', () => {
    const cap = capture();
    const code = runPerfCommand(
      ['--budget', 'attach', '--samples', '5,10,12,20,40'],
      { out: cap.out },
    );
    expect(code).toBe(0);
    expect(cap.lines).toEqual([]);
  });
});

describe('kubic perf --json (issue #79)', () => {
  it('emits the full evaluation on a breach', () => {
    const cap = capture();
    const code = runPerfCommand(
      ['--budget', 'spawn', '--samples', '10,20,30,40,500', '--json'],
      { out: cap.out },
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(cap.lines.join('\n')) as {
      kind: string;
      within: boolean;
      regression: string | null;
    };
    expect(parsed.kind).toBe('spawn');
    expect(parsed.within).toBe(false);
    expect(parsed.regression).toBe(
      evaluateBudget('spawn', [10, 20, 30, 40, 500]).regression,
    );
  });

  it('emits the full evaluation on a pass', () => {
    const cap = capture();
    const code = runPerfCommand(
      ['--budget', 'attach', '--samples', '5,10,12,20,40', '--json'],
      { out: cap.out },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.lines.join('\n')) as {
      within: boolean;
      regression: string | null;
    };
    expect(parsed.within).toBe(true);
    expect(parsed.regression).toBeNull();
  });
});

describe('kubic perf usage (issue #79, §78)', () => {
  it('exits 2 without --budget', () => {
    const cap = capture();
    const code = runPerfCommand(['--samples', '1,2,3'], { out: cap.out });
    expect(code).toBe(2);
    expect(cap.lines[0]).toMatch(/^usage: kubic perf/);
  });

  it('exits 2 on an unknown budget kind', () => {
    const cap = capture();
    const code = runPerfCommand(['--budget', 'warp', '--samples', '1,2,3'], {
      out: cap.out,
    });
    expect(code).toBe(2);
  });

  it('exits 2 on non-numeric samples', () => {
    const cap = capture();
    const code = runPerfCommand(
      ['--budget', 'spawn', '--samples', '10,fast,30'],
      { out: cap.out },
    );
    expect(code).toBe(2);
  });

  it('exits 2 on empty samples instead of a vacuous pass', () => {
    const cap = capture();
    const code = runPerfCommand(['--budget', 'spawn', '--samples', ''], {
      out: cap.out,
    });
    expect(code).toBe(2);
    expect(cap.lines.some((line) => line.startsWith('usage: kubic perf'))).toBe(
      true,
    );
  });

  it('exits 2 on an unknown flag', () => {
    const cap = capture();
    const code = runPerfCommand(
      ['--budget', 'spawn', '--samples', '1,2,3', '--bogus'],
      { out: cap.out },
    );
    expect(code).toBe(2);
  });
});
