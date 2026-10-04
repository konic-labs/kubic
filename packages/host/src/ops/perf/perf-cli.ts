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

import {
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
} from '../../../../core/src/cli/exit-codes.js';
import { createLineLogger } from '../../../../core/src/cli/logger.js';
import { formatJson } from '../../../../core/src/cli/output.js';
import { renderTable } from '../../../../core/src/cli/table.js';
import {
  type CliTheme,
  createCliTheme,
} from '../../../../core/src/cli/theme.js';
import type { ExecutionEnv } from '../../../../exec/src/env.js';
import { NodeExecutionEnv } from '../../../../exec/src/env.js';
import { createNodeFileBridge } from '../../../../exec/src/file-bridge.js';
import { openSessionStore } from '../../../../worker/src/lane/session-store.js';
import { redactSecretShapes } from '../../policy/secret-shapes.js';
import { defaultSessionsRoot } from '../../sessions-cli.js';
import {
  type BudgetEvaluation,
  evaluateBudget,
  PERF_BUDGETS_MS,
  type PerfBudgetKind,
} from './budgets.js';
import { type MeasureResult, measureSamples } from './measure.js';

export const BUDGET_KINDS = Object.keys(PERF_BUDGETS_MS) as PerfBudgetKind[];

// The parsed `kubic perf` options (commander's `opts()`); `budget` is a
// required option there, still checked here for direct callers.
export interface PerfOptions {
  readonly budget?: string;
  readonly samples?: string;
  readonly measure?: boolean;
  readonly json?: boolean;
}

export interface PerfMeasureRequest {
  kind: PerfBudgetKind;
  samples?: number;
}

export interface PerfCommandDeps {
  // stdout: the report or the one `--json` document.
  out: (line: string) => void;
  // stderr: diagnostics, one `error: …` line each (core/cli/logger).
  err: (line: string) => void;
  // Colour and box drawing for the human report; absent means plain.
  theme?: CliTheme;
  // Colour of the stderr diagnostics, from stderr's own TTY state (never
  // stdout's); absent means plain.
  errTheme?: CliTheme;
  fancy?: boolean;
  // Real-measurement hook (issue #98). Defaults to the live measurement
  // module (ops/perf/measure.ts) inside this file, so a real
  // `kubic perf --measure` works without the composition root wiring
  // anything; tests inject a stub, and a kind with no live substrate is
  // refused by name rather than evaluated as fiction.
  measure?: (request: PerfMeasureRequest) => Promise<MeasureResult>;
  // Sessions root for the §61 attach measurement (issue #158); the default
  // is the user's real sessions root.
  measureSessionsRoot?: string;
  // Live measurement env. Defaults to the process cwd through the exec seam
  // (NodeExecutionEnv); tests inject FakeExecutionEnv.
  measureEnv?: ExecutionEnv;
  // Worktree measurements need a repo; defaults to the env cwd.
  measureRepoRoot?: string;
}

// The prod default: real spawn/worktree/attach cycles on this machine through
// the exec seam and a real sessions root. Imported eagerly (not dynamically)
// so the measured path is on the same module graph as the CLI — a dead
// `--measure` branch would be exactly the unreachable-implementation problem
// issue #98 exists to fix.
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
    // §61 attach (issue #158): the create/attach cycles run against a real
    // sessions root — the default one, or the caller's (tests).
    sessionStore: openSessionStore(
      deps.measureSessionsRoot ?? defaultSessionsRoot(),
      createNodeFileBridge(deps.measureSessionsRoot ?? defaultSessionsRoot()),
    ),
  });
}

// Five samples is the smallest count the p50/p95 gate can rank meaningfully
// (budgets.ts percentile) while staying a sub-second measurement for spawn.
export const DEFAULT_MEASURE_SAMPLES = 5;

const PLAIN = createCliTheme('none');

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

function evaluationTable(
  evaluation: BudgetEvaluation,
  deps: PerfCommandDeps,
  theme: CliTheme,
): string {
  const status = evaluation.within
    ? theme.success('within')
    : theme.error('BREACH');
  return renderTable(
    [
      [
        evaluation.kind,
        `${evaluation.budgetMs}ms`,
        String(evaluation.count),
        `${evaluation.p50}ms`,
        `${evaluation.p95}ms`,
        status,
      ],
    ],
    [
      { header: 'BUDGET' },
      { header: 'LIMIT', align: 'right' },
      { header: 'SAMPLES', align: 'right' },
      { header: 'P50', align: 'right' },
      { header: 'P95', align: 'right' },
      { header: 'STATUS' },
    ],
    { fancy: deps.fancy === true, theme },
  );
}

// `kubic perf` over parsed options: commander (apps/kubic/src/commands/
// analysis.ts) owns argv syntax — unknown flags, missing values, the
// required --budget, `--help`; this handler owns the semantics (budget
// kinds, the one-source rule, the sample list).
export async function runPerfCommand(
  options: PerfOptions,
  deps: PerfCommandDeps,
): Promise<number> {
  const json = options.json === true;
  const theme = json ? PLAIN : (deps.theme ?? PLAIN);
  const log = createLineLogger(deps.err, {
    theme: json ? PLAIN : (deps.errTheme ?? PLAIN),
  });
  const usageError = (message: string): number => {
    log.error(message);
    return EXIT_USAGE;
  };
  const kind = options.budget;
  const measure = options.measure === true;
  const samplesRaw = options.samples;
  if (kind === undefined) {
    return usageError("required option '--budget <kind>' not specified");
  }
  if (!isBudgetKind(kind)) {
    // Fail-closed echo: the budget kind is argv-controlled and may carry
    // secret-shaped material.
    return usageError(
      redactSecretShapes(
        `unknown budget ${JSON.stringify(kind)} (want ${BUDGET_KINDS.join('|')})`,
      ),
    );
  }
  // The two sample sources are mutually exclusive: silently preferring one
  // would make the reported provenance a guess.
  if (measure && samplesRaw !== undefined) {
    return usageError('--measure and --samples are mutually exclusive');
  }
  if (!measure && samplesRaw === undefined) {
    return usageError('one sample source is required: --measure or --samples');
  }

  let samples: number[];
  let measured: MeasureResult | null = null;
  if (measure) {
    const source = deps.measure ?? ((req) => defaultMeasure(req, deps));
    try {
      measured = await source({ kind });
    } catch (error) {
      return usageError(
        redactSecretShapes(
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
    samples = measured.samplesMs;
  } else {
    const parsed = parseSamples(samplesRaw as string);
    if (parsed === null) {
      return usageError('--samples needs a comma-separated list of ms numbers');
    }
    samples = parsed;
  }

  // The filed record is the contract: the breach line prints exactly what
  // the onRegression sink receives, never a rewording.
  const filed: BudgetEvaluation[] = [];
  const evaluation = evaluateBudget(kind, samples, (record) => {
    filed.push(record);
  });
  const exit = evaluation.within ? EXIT_OK : EXIT_FAILED;
  if (json) {
    deps.out(
      formatJson(
        measured === null
          ? evaluation
          : {
              ...evaluation,
              source: measured.source,
              note: measured.note,
            },
      ),
    );
    return exit;
  }
  // Provenance first: the operator must be able to tell measured samples
  // from argv ones (issue #98).
  if (measured !== null) deps.out(theme.muted(`perf: ${measured.note}`));
  deps.out(evaluationTable(evaluation, deps, theme));
  if (!evaluation.within) {
    const record = filed[0] ?? evaluation;
    deps.out(theme.warning(record.regression ?? 'perf regression'));
  }
  return exit;
}
