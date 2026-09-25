// `kubic perf` CLI tests (issue #79; §61). RED first: perf-cli.ts lands
// after this file. Faux-only — samples are injected argv, no clock.
import { describe, expect, it } from 'vitest';
import { REDACTED_SECRET } from '../../policy/secret-shapes.js';
import { evaluateBudget } from './budgets.js';
import { MeasureError } from './measure.js';
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
  it('prints the exact filed regression string', async () => {
    const expected = evaluateBudget('spawn', [10, 20, 30, 40, 500]);
    expect(expected.within).toBe(false);
    const cap = capture();
    const code = await runPerfCommand(
      ['--budget', 'spawn', '--samples', '10,20,30,40,500'],
      { out: cap.out },
    );
    expect(code).toBe(1);
    expect(cap.lines).toHaveLength(1);
    expect(cap.lines[0]).toBe(expected.regression);
  });

  it('files the breach naming kind, p95, and budget', async () => {
    const cap = capture();
    await runPerfCommand(
      ['--budget', 'spawn', '--samples', '10,20,30,40,500'],
      {
        out: cap.out,
      },
    );
    expect(cap.lines[0]).toMatch(/spawn/);
    expect(cap.lines[0]).toMatch(/500/);
    expect(cap.lines[0]).toMatch(/200/);
  });
});

describe('kubic perf pass (issue #79)', () => {
  it('prints nothing gated on a pass', async () => {
    const cap = capture();
    const code = await runPerfCommand(
      ['--budget', 'attach', '--samples', '5,10,12,20,40'],
      { out: cap.out },
    );
    expect(code).toBe(0);
    expect(cap.lines).toEqual([]);
  });
});

describe('kubic perf --json (issue #79)', () => {
  it('emits the full evaluation on a breach', async () => {
    const cap = capture();
    const code = await runPerfCommand(
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

  it('emits the full evaluation on a pass', async () => {
    const cap = capture();
    const code = await runPerfCommand(
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
  it('exits 2 without --budget', async () => {
    const cap = capture();
    const code = await runPerfCommand(['--samples', '1,2,3'], { out: cap.out });
    expect(code).toBe(2);
    expect(cap.lines[0]).toMatch(/^usage: kubic perf/);
  });

  it('exits 2 on an unknown budget kind', async () => {
    const cap = capture();
    const code = await runPerfCommand(
      ['--budget', 'warp', '--samples', '1,2,3'],
      {
        out: cap.out,
      },
    );
    expect(code).toBe(2);
  });

  it('exits 2 on non-numeric samples', async () => {
    const cap = capture();
    const code = await runPerfCommand(
      ['--budget', 'spawn', '--samples', '10,fast,30'],
      { out: cap.out },
    );
    expect(code).toBe(2);
  });

  it('exits 2 on empty samples instead of a vacuous pass', async () => {
    const cap = capture();
    const code = await runPerfCommand(['--budget', 'spawn', '--samples', ''], {
      out: cap.out,
    });
    expect(code).toBe(2);
    expect(cap.lines.some((line) => line.startsWith('usage: kubic perf'))).toBe(
      true,
    );
  });

  it('exits 2 on an unknown flag', async () => {
    const cap = capture();
    const code = await runPerfCommand(
      ['--budget', 'spawn', '--samples', '1,2,3', '--bogus'],
      { out: cap.out },
    );
    expect(code).toBe(2);
  });
});

describe('kubic perf secret backstop (issue #79 fix cycle 1)', () => {
  it('redacts secret-shaped material in the unknown-budget error', async () => {
    const shaped = 'SK-FAUX-TEST-KEY-0001';
    const cap = capture();
    const code = await runPerfCommand(
      ['--budget', shaped, '--samples', '1,2,3'],
      {
        out: cap.out,
      },
    );
    expect(code).toBe(2);
    const text = cap.lines.join('\n');
    expect(text).not.toContain(shaped);
    expect(text).toContain(REDACTED_SECRET);
  });
});

describe('kubic perf measured mode (issue #98, criterion 2)', () => {
  it('evaluates REAL measurements when --measure is passed, not argv samples', async () => {
    const measured: string[] = [];
    const cap = capture();
    const code = await runPerfCommand(['--budget', 'spawn', '--measure'], {
      out: cap.out,
      measure: async (request) => {
        measured.push(request.kind);
        return {
          kind: request.kind,
          source: 'measured',
          samplesMs: [10, 20, 30],
          note: 'measured 3 real spawn cycle(s)',
        };
      },
    });
    expect(code).toBe(0);
    expect(measured).toEqual(['spawn']);
    // The measured note is reported so the operator can tell which samples
    // were evaluated.
    expect(cap.lines.join('\n')).toMatch(/measured 3 real spawn cycle/);
  });

  it('files the breach from measured samples with the filed string intact', async () => {
    const expected = evaluateBudget('spawn', [10, 20, 30, 40, 500]);
    const cap = capture();
    const code = await runPerfCommand(['--budget', 'spawn', '--measure'], {
      out: cap.out,
      measure: async (request) => ({
        kind: request.kind,
        source: 'measured',
        samplesMs: [10, 20, 30, 40, 500],
        note: 'measured 5 real spawn cycle(s)',
      }),
    });
    expect(code).toBe(1);
    expect(expected.within).toBe(false);
    expect(cap.lines).toContain(expected.regression);
  });

  it('emits the measured evaluation under --json with the source and note', async () => {
    const cap = capture();
    const code = await runPerfCommand(
      ['--budget', 'worktree', '--measure', '--json'],
      {
        out: cap.out,
        measure: async (request) => ({
          kind: request.kind,
          source: 'measured',
          samplesMs: [5, 6, 7],
          note: 'measured 3 real git worktree cycles',
        }),
      },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.lines.join('\n')) as {
      kind: string;
      within: boolean;
      source: string;
      note: string;
    };
    expect(parsed.kind).toBe('worktree');
    expect(parsed.within).toBe(true);
    expect(parsed.source).toBe('measured');
    expect(parsed.note).toMatch(/worktree/);
  });

  it('keeps --samples working as the documented fallback', async () => {
    const cap = capture();
    let measured = false;
    const code = await runPerfCommand(
      ['--budget', 'attach', '--samples', '5,10,12,20,40'],
      {
        out: cap.out,
        measure: async (request) => {
          measured = true;
          return {
            kind: request.kind,
            source: 'measured',
            samplesMs: [5],
            note: 'should not run',
          };
        },
      },
    );
    expect(code).toBe(0);
    expect(measured).toBe(false);
  });

  it('still exits 2 when neither --measure nor --samples is given', async () => {
    const cap = capture();
    const code = await runPerfCommand(['--budget', 'spawn'], { out: cap.out });
    expect(code).toBe(2);
    expect(cap.lines.join('\n')).toMatch(/--measure|--samples/);
  });

  it('defaults to real measurement in prod without an injected dep', async () => {
    // A live `kubic perf --measure` must not depend on the composition root
    // passing a source (main.ts is owned by another issue): the CLI binds
    // the real measurement module by default. attach has no live source yet,
    // so the default is exercised and the kind is refused by name — proving
    // the default is the measured path, not a fabricated pass.
    const cap = capture();
    const code = await runPerfCommand(['--budget', 'attach', '--measure'], {
      out: cap.out,
    });
    expect(code).toBe(2);
    expect(cap.lines.join('\n')).toMatch(/no live measurement source/);
  });

  it('maps an unmeasurable kind to a named failure, never a fabricated pass', async () => {
    const cap = capture();
    const code = await runPerfCommand(['--budget', 'attach', '--measure'], {
      out: cap.out,
      measure: async (request) => {
        throw new MeasureError(
          `perf budget '${request.kind}' has no live measurement source yet — pass --samples (the documented fallback)`,
        );
      },
    });
    expect(code).toBe(2);
    expect(cap.lines.join('\n')).toMatch(/no live measurement source/);
    expect(cap.lines.join('\n')).toMatch(/--samples/);
  });

  it('refuses --measure together with --samples instead of silently picking one', async () => {
    const cap = capture();
    const code = await runPerfCommand(
      ['--budget', 'spawn', '--measure', '--samples', '1,2,3'],
      { out: cap.out },
    );
    expect(code).toBe(2);
    expect(cap.lines.join('\n')).toMatch(/--measure|--samples/);
  });
});
