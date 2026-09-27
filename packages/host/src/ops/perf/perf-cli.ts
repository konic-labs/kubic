// `kubic perf --budget <kind> (--samples <csv> | --measure) [--json]`
// (issue #79; §61; measured mode #98, criterion 2).
// Presentation only over the perf-budget evaluator: a breach prints the
// exact filed regression string (exit 1); a pass prints nothing gated
// (exit 0); --json emits the full BudgetEvaluation either way. Two sample
// sources, never both:
//   - `--measure` takes REAL measurements on this machine (ops/perf/
//     measure.ts — spawn cycles and git worktree cycles) and evaluates
//     those;
//   - `--samples` is the explicit, documented fallback: operator-supplied
//     numbers (faux-only: no clock, no I/O, no network), for budgets with
//     no live substrate yet and for CI.

import { answerHelp } from '../../../../core/src/cli-help.js';
import { type FlagSpec, parseFlagArgs } from '../../../../core/src/flags.js';
import type { ExecutionEnv } from '../../../../exec/src/env.js';
import { NodeExecutionEnv } from '../../../../exec/src/env.js';
import { redactSecretShapes } from '../../policy/secret-shapes.js';
import {
  type BudgetEvaluation,
  evaluateBudget,
  PERF_BUDGETS_MS,
  type PerfBudgetKind,
} from './budgets.js';
import { type MeasureResult, measureSamples } from './measure.js';

export const PERF_EXIT_OK = 0;
export const PERF_EXIT_BREACH = 1;
export const PERF_EXIT_USAGE = 2;

const BUDGET_KINDS = Object.keys(PERF_BUDGETS_MS) as PerfBudgetKind[];

export interface PerfMeasureRequest {
  kind: PerfBudgetKind;
  samples?: number;
}

export interface PerfCommandDeps {
  out: (line: string) => void;
  // Real-measurement hook (issue #98). Defaults to the live measurement
  // module (ops/perf/measure.ts) inside this file, so a real
  // `kubic perf --measure` works without the composition root wiring
  // anything; tests inject a stub, and a kind with no live substrate is
  // refused by name rather than evaluated as fiction.
  measure?: (request: PerfMeasureRequest) => Promise<MeasureResult>;
  // Live measurement env. Defaults to the process cwd through the exec seam
  // (NodeExecutionEnv); tests inject FakeExecutionEnv.
  measureEnv?: ExecutionEnv;
  // Worktree measurements need a repo; defaults to the env cwd.
  measureRepoRoot?: string;
}

// The prod default: real spawn/worktree cycles on this machine through the
// exec seam. Imported eagerly (not dynamically) so the measured path is on
// the same module graph as the CLI — a dead `--measure` branch would be
// exactly the unreachable-implementation problem issue #98 exists to fix.
function defaultMeasure(
  request: PerfMeasureRequest,
  deps: PerfCommandDeps,
): Promise<MeasureResult> {
  const env = deps.measureEnv ?? new NodeExecutionEnv(process.cwd());
  return measureSamples({
    kind: request.kind,
    samples: request.samples ?? DEFAULT_MEASURE_SAMPLES,
    env,
    ...(deps.measureRepoRoot === undefined
      ? {}
      : { repoRoot: deps.measureRepoRoot }),
  });
}

// Five samples is the smallest count the p50/p95 gate can rank meaningfully
// (budgets.ts percentile) while staying a sub-second measurement for spawn.
export const DEFAULT_MEASURE_SAMPLES = 5;

export const PERF_USAGE =
  'usage: kubic perf --budget <worktree|spawn|attach|teardown> (--measure | --samples <ms,ms,…>) [--json]';

function usage(out: (line: string) => void): number {
  out(PERF_USAGE);
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

// Issue #127: the shared parser replaces the hand-rolled loop. Missing
// values keep their lines; unknown flags and stray operands keep the bare
// usage exit; budget-kind and exclusivity checks stay this command's
// semantics.
const PERF_FLAG_SPEC: readonly FlagSpec[] = [
  { name: '--json', takes: 'boolean' },
  { name: '--measure', takes: 'boolean' },
  { name: '--budget', takes: 'value' },
  { name: '--samples', takes: 'value' },
];

export async function runPerfCommand(
  args: string[],
  deps: PerfCommandDeps,
): Promise<number> {
  // `--help`/`-h` prints the usage line and exits 0 (issue #100).
  const help = answerHelp(args, deps.out, PERF_USAGE);
  if (help !== null) return help;
  const flags = parseFlagArgs(args, PERF_FLAG_SPEC);
  for (const flag of flags.missing) {
    deps.out(`error: ${flag} needs a value`);
    return usage(deps.out);
  }
  if (flags.unknown.length > 0 || flags.positional.length > 0) {
    return usage(deps.out);
  }
  const json = flags.values['--json'] === true;
  const measure = flags.values['--measure'] === true;
  const kind = flags.values['--budget'] as string | undefined;
  const samplesRaw = flags.values['--samples'] as string | undefined;
  if (kind === undefined) return usage(deps.out);
  if (!isBudgetKind(kind)) {
    // Fail-closed echo: the budget kind is argv-controlled and may carry
    // secret-shaped material.
    deps.out(
      redactSecretShapes(`error: unknown budget ${JSON.stringify(kind)}`),
    );
    return usage(deps.out);
  }
  // The two sample sources are mutually exclusive: silently preferring one
  // would make the reported provenance a guess.
  if (measure && samplesRaw !== undefined) {
    deps.out('error: --measure and --samples are mutually exclusive');
    return usage(deps.out);
  }
  if (!measure && samplesRaw === undefined) return usage(deps.out);

  let samples: number[];
  let measured: MeasureResult | null = null;
  if (measure) {
    const source = deps.measure ?? ((req) => defaultMeasure(req, deps));
    try {
      measured = await source({ kind });
    } catch (error) {
      deps.out(
        redactSecretShapes(
          `error: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      return usage(deps.out);
    }
    samples = measured.samplesMs;
  } else {
    const parsed = parseSamples(samplesRaw as string);
    if (parsed === null) {
      deps.out('error: --samples needs a comma-separated list of ms numbers');
      return usage(deps.out);
    }
    samples = parsed;
  }

  // The filed record is the contract: the breach line prints exactly what
  // the onRegression sink receives, never a rewording.
  const filed: BudgetEvaluation[] = [];
  const evaluation = evaluateBudget(kind, samples, (record) => {
    filed.push(record);
  });
  if (json) {
    deps.out(
      JSON.stringify(
        measured === null
          ? evaluation
          : {
              ...evaluation,
              source: measured.source,
              note: measured.note,
            },
        null,
        2,
      ),
    );
    return evaluation.within ? PERF_EXIT_OK : PERF_EXIT_BREACH;
  }
  // Provenance first: a pass prints nothing gated, but the operator must
  // still be able to tell measured samples from argv ones (issue #98).
  if (measured !== null) deps.out(`perf: ${measured.note}`);
  if (!evaluation.within) {
    const record = filed[0] ?? evaluation;
    deps.out(record.regression ?? 'perf regression');
    return PERF_EXIT_BREACH;
  }
  return PERF_EXIT_OK;
}
