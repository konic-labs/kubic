// `kubic perf` handler tests (issue #79; §61). Faux-only — samples are
// injected options, no clock. Argv syntax (unknown flags, missing values,
// the required --budget, --help) is commander's and is pinned in
// apps/kubic/src/commands/analysis.test.ts; this file drives the handler
// over parsed options and asserts stdout and stderr separately.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateBudget } from '../../../../../packages/host/src/ops/perf/budgets.js';
import { MeasureError } from '../../../../../packages/host/src/ops/perf/measure.js';
import {
  type PerfCommandDeps,
  runPerfCommand,
} from '../../../../../packages/host/src/ops/perf/perf-cli.js';
import { REDACTED_SECRET } from '../../../../../packages/host/src/policy/secret-shapes.js';

function capture(extra: Partial<PerfCommandDeps> = {}) {
  const lines: string[] = [];
  const errs: string[] = [];
  const deps: PerfCommandDeps = {
    out: (line: string): void => {
      lines.push(line);
    },
    err: (line: string): void => {
      errs.push(line);
    },
    ...extra,
  };
  return { lines, errs, deps };
}

const BREACH = '10,20,30,40,500';
const PASS = '5,10,12,20,40';

describe('kubic perf breach (issue #79)', () => {
  it('prints the evaluation table, then the exact filed regression string', async () => {
    const expected = evaluateBudget('spawn', [10, 20, 30, 40, 500]);
    expect(expected.within).toBe(false);
    const cap = capture();
    const code = await runPerfCommand(
      { budget: 'spawn', samples: BREACH },
      cap.deps,
    );
    expect(code).toBe(1);
    expect(cap.lines).toEqual([
      [
        'BUDGET  LIMIT  SAMPLES   P50    P95  STATUS',
        `spawn   ${expected.budgetMs}ms        5  ${expected.p50}ms  ${expected.p95}ms  BREACH`,
      ].join('\n'),
      expected.regression,
    ]);
    expect(cap.errs).toEqual([]);
  });

  it('files the breach naming kind, p95, and budget', async () => {
    const cap = capture();
    await runPerfCommand({ budget: 'spawn', samples: BREACH }, cap.deps);
    const regression = cap.lines.at(-1) ?? '';
    expect(regression).toMatch(/spawn/);
    expect(regression).toMatch(/500/);
    expect(regression).toMatch(/200/);
  });
});

describe('kubic perf pass (issue #79)', () => {
  it('prints the table and no regression line on a pass', async () => {
    const cap = capture();
    const code = await runPerfCommand(
      { budget: 'attach', samples: PASS },
      cap.deps,
    );
    expect(code).toBe(0);
    expect(cap.lines).toHaveLength(1);
    expect(cap.lines[0]).toMatch(/^BUDGET/);
    expect(cap.lines[0]).toMatch(/attach .* within$/);
    expect(cap.lines.join('\n')).not.toMatch(/regression/);
  });

  it('draws a box table only when fancy', async () => {
    const cap = capture({ fancy: true });
    await runPerfCommand({ budget: 'attach', samples: PASS }, cap.deps);
    expect(cap.lines[0]).toContain('┌');
  });
});

describe('kubic perf --json (issue #79)', () => {
  it('emits the full evaluation on a breach, nothing else on stdout', async () => {
    const cap = capture();
    const code = await runPerfCommand(
      { budget: 'spawn', samples: BREACH, json: true },
      cap.deps,
    );
    expect(code).toBe(1);
    expect(cap.lines).toHaveLength(1);
    const parsed = JSON.parse(cap.lines[0] ?? '') as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual([
      'budgetMs',
      'count',
      'kind',
      'p50',
      'p95',
      'regression',
      'within',
    ]);
    expect(parsed.kind).toBe('spawn');
    expect(parsed.within).toBe(false);
    expect(parsed.regression).toBe(
      evaluateBudget('spawn', [10, 20, 30, 40, 500]).regression,
    );
    expect(cap.errs).toEqual([]);
  });

  it('emits the full evaluation on a pass', async () => {
    const cap = capture();
    const code = await runPerfCommand(
      { budget: 'attach', samples: PASS, json: true },
      cap.deps,
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
  it('exits 2 without --budget (direct callers; commander requires it)', async () => {
    const cap = capture();
    const code = await runPerfCommand({ samples: '1,2,3' }, cap.deps);
    expect(code).toBe(2);
    expect(cap.lines).toEqual([]);
    expect(cap.errs).toEqual([
      "error: required option '--budget <kind>' not specified",
    ]);
  });

  it('exits 2 on an unknown budget kind, naming the valid kinds', async () => {
    const cap = capture();
    const code = await runPerfCommand(
      { budget: 'warp', samples: '1,2,3' },
      cap.deps,
    );
    expect(code).toBe(2);
    expect(cap.errs).toEqual([
      'error: unknown budget "warp" (want worktree|spawn|attach|teardown)',
    ]);
  });

  it('exits 2 on non-numeric samples', async () => {
    const cap = capture();
    const code = await runPerfCommand(
      { budget: 'spawn', samples: '10,fast,30' },
      cap.deps,
    );
    expect(code).toBe(2);
    expect(cap.errs).toEqual([
      'error: --samples needs a comma-separated list of ms numbers',
    ]);
  });

  it('exits 2 on empty samples instead of a vacuous pass', async () => {
    const cap = capture();
    const code = await runPerfCommand(
      { budget: 'spawn', samples: '' },
      cap.deps,
    );
    expect(code).toBe(2);
    expect(cap.lines).toEqual([]);
  });

  it('keeps usage errors off stdout under --json', async () => {
    const cap = capture();
    const code = await runPerfCommand(
      { budget: 'warp', samples: '1', json: true },
      cap.deps,
    );
    expect(code).toBe(2);
    expect(cap.lines).toEqual([]);
    expect(cap.errs).toHaveLength(1);
  });
});

describe('kubic perf secret backstop (issue #79 fix cycle 1)', () => {
  it('redacts secret-shaped material in the unknown-budget error', async () => {
    const shaped = 'SK-FAUX-TEST-KEY-0001';
    const cap = capture();
    const code = await runPerfCommand(
      { budget: shaped, samples: '1,2,3' },
      cap.deps,
    );
    expect(code).toBe(2);
    const text = [...cap.lines, ...cap.errs].join('\n');
    expect(text).not.toContain(shaped);
    expect(text).toContain(REDACTED_SECRET);
  });
});

describe('kubic perf measured mode (issue #98, criterion 2)', () => {
  it('evaluates REAL measurements when --measure is passed, not argv samples', async () => {
    const measured: string[] = [];
    const cap = capture({
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
    const code = await runPerfCommand(
      { budget: 'spawn', measure: true },
      cap.deps,
    );
    expect(code).toBe(0);
    expect(measured).toEqual(['spawn']);
    // The measured note is reported first so the operator can tell which
    // samples were evaluated.
    expect(cap.lines[0]).toBe('perf: measured 3 real spawn cycle(s)');
  });

  it('files the breach from measured samples with the filed string intact', async () => {
    const expected = evaluateBudget('spawn', [10, 20, 30, 40, 500]);
    const cap = capture({
      measure: async (request) => ({
        kind: request.kind,
        source: 'measured',
        samplesMs: [10, 20, 30, 40, 500],
        note: 'measured 5 real spawn cycle(s)',
      }),
    });
    const code = await runPerfCommand(
      { budget: 'spawn', measure: true },
      cap.deps,
    );
    expect(code).toBe(1);
    expect(expected.within).toBe(false);
    expect(cap.lines).toContain(expected.regression);
  });

  it('emits the measured evaluation under --json with the source and note', async () => {
    const cap = capture({
      measure: async (request) => ({
        kind: request.kind,
        source: 'measured',
        samplesMs: [5, 6, 7],
        note: 'measured 3 real git worktree cycles',
      }),
    });
    const code = await runPerfCommand(
      { budget: 'worktree', measure: true, json: true },
      cap.deps,
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
    let measured = false;
    const cap = capture({
      measure: async (request) => {
        measured = true;
        return {
          kind: request.kind,
          source: 'measured',
          samplesMs: [5],
          note: 'should not run',
        };
      },
    });
    const code = await runPerfCommand(
      { budget: 'attach', samples: PASS },
      cap.deps,
    );
    expect(code).toBe(0);
    expect(measured).toBe(false);
  });

  it('still exits 2 when neither --measure nor --samples is given', async () => {
    const cap = capture();
    const code = await runPerfCommand({ budget: 'spawn' }, cap.deps);
    expect(code).toBe(2);
    expect(cap.errs).toEqual([
      'error: one sample source is required: --measure or --samples',
    ]);
  });

  it('defaults to real measurement in prod without an injected dep', async () => {
    // A live `kubic perf --measure` must not depend on the composition root
    // passing a source: the CLI binds the real measurement module by
    // default. teardown has no live source yet, so the default is exercised
    // and the kind is refused by name — proving the default is the measured
    // path, not a fabricated pass.
    const cap = capture();
    const code = await runPerfCommand(
      { budget: 'teardown', measure: true },
      cap.deps,
    );
    expect(code).toBe(2);
    expect(cap.errs.join('\n')).toMatch(/no live measurement source/);
  });

  it('measures the §61 attach row against a real sessions root (issue #158)', async () => {
    // The default measurement path, with the sessions root pointed at a temp
    // dir: real session create/attach cycles, no fabricated numbers.
    const root = mkdtempSync(join(tmpdir(), 'perf-attach-cli-'));
    try {
      const cap = capture({ measureSessionsRoot: root });
      const code = await runPerfCommand(
        { budget: 'attach', measure: true, json: true },
        cap.deps,
      );
      expect(code).toBe(0);
      const report = JSON.parse(cap.lines.join('\n')) as {
        kind: string;
        source: string;
        count: number;
      };
      expect(report).toMatchObject({
        kind: 'attach',
        source: 'measured',
        count: 5,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('maps an unmeasurable kind to a named failure, never a fabricated pass', async () => {
    const cap = capture({
      measure: async (request) => {
        throw new MeasureError(
          `perf budget '${request.kind}' has no live measurement source yet — pass --samples (the documented fallback)`,
        );
      },
    });
    const code = await runPerfCommand(
      { budget: 'attach', measure: true },
      cap.deps,
    );
    expect(code).toBe(2);
    expect(cap.lines).toEqual([]);
    expect(cap.errs.join('\n')).toMatch(/no live measurement source/);
    expect(cap.errs.join('\n')).toMatch(/--samples/);
  });

  it('refuses --measure together with --samples instead of silently picking one', async () => {
    const cap = capture();
    const code = await runPerfCommand(
      { budget: 'spawn', measure: true, samples: '1,2,3' },
      cap.deps,
    );
    expect(code).toBe(2);
    expect(cap.errs).toEqual([
      'error: --measure and --samples are mutually exclusive',
    ]);
  });
});
