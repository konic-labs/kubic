// `kubic perf --budget <kind> --samples <csv> [--json]` (issue #79; §61).
// Presentation only over the perf-budget evaluator: a breach prints the
// exact filed regression string (exit 1); a pass prints nothing gated
// (exit 0); --json emits the full BudgetEvaluation either way. Samples
// arrive as argv (faux-only: no clock, no I/O, no network).

import {
  type BudgetEvaluation,
  evaluateBudget,
  PERF_BUDGETS_MS,
  type PerfBudgetKind,
} from './budgets.js';

export const PERF_EXIT_OK = 0;
export const PERF_EXIT_BREACH = 1;
export const PERF_EXIT_USAGE = 2;

const BUDGET_KINDS = Object.keys(PERF_BUDGETS_MS) as PerfBudgetKind[];

export interface PerfCommandDeps {
  out: (line: string) => void;
}

function usage(out: (line: string) => void): number {
  out(
    'usage: kubic perf --budget <worktree|spawn|attach|teardown> --samples <ms,ms,…> [--json]',
  );
  return PERF_EXIT_USAGE;
}

function isBudgetKind(value: string): value is PerfBudgetKind {
  return (BUDGET_KINDS as readonly string[]).includes(value);
}

function parseSamples(raw: string): number[] | null {
  if (raw.trim() === '') return null;
  const samples: number[] = [];
  for (const part of raw.split(',')) {
    const text = part.trim();
    if (text === '') return null;
    const value = Number(text);
    if (!Number.isFinite(value) || value < 0) return null;
    samples.push(value);
  }
  return samples.length > 0 ? samples : null;
}

export function runPerfCommand(args: string[], deps: PerfCommandDeps): number {
  let json = false;
  let kind: string | undefined;
  let samplesRaw: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--budget') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        deps.out('error: --budget needs a value');
        return usage(deps.out);
      }
      kind = value;
      i++;
    } else if (arg === '--samples') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        deps.out('error: --samples needs a value');
        return usage(deps.out);
      }
      samplesRaw = value;
      i++;
    } else {
      return usage(deps.out);
    }
  }
  if (kind === undefined || samplesRaw === undefined) return usage(deps.out);
  if (!isBudgetKind(kind)) {
    deps.out(`error: unknown budget ${JSON.stringify(kind)}`);
    return usage(deps.out);
  }
  const samples = parseSamples(samplesRaw);
  if (samples === null) {
    deps.out('error: --samples needs a comma-separated list of ms numbers');
    return usage(deps.out);
  }
  // The filed record is the contract: the breach line prints exactly what
  // the onRegression sink receives, never a rewording.
  const filed: BudgetEvaluation[] = [];
  const evaluation = evaluateBudget(kind, samples, (record) => {
    filed.push(record);
  });
  if (json) {
    deps.out(JSON.stringify(evaluation, null, 2));
    return evaluation.within ? PERF_EXIT_OK : PERF_EXIT_BREACH;
  }
  if (!evaluation.within) {
    const record = filed[0] ?? evaluation;
    deps.out(record.regression ?? 'perf regression');
    return PERF_EXIT_BREACH;
  }
  return PERF_EXIT_OK;
}
