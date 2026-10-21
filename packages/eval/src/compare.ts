// `kubic benchmark --suite-file`: the team's own suites run against several
// models, each a set number of times, and reported side by side — pass rate,
// cost, latency and tokens per model, and each suite's passes per model —
// so a model is judged on the team's work before it joins `allowed_models`.

import {
  type CommandResult,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
} from '@kubic/core/cli/exit-codes';
import { formatJson } from '@kubic/core/cli/output';
import { renderTable } from '@kubic/core/cli/table';
import { type CliTheme, createCliTheme } from '@kubic/core/cli/theme';
import type { SuiteRunOutcome } from './runner.js';
import { gatesPass } from './signals.js';
import type { FileSuite } from './suite-files.js';

const MAX_REPEAT = 20;
const PLAIN = createCliTheme('none');

interface CompareRun {
  readonly suite: string;
  readonly model: string;
  readonly repetition: number;
  readonly success: boolean;
  readonly costUsd: number;
  readonly tokens: number;
  readonly latencyMs: number;
  // Why the run could not be scored.
  readonly error?: string;
}

interface ModelSummary {
  readonly model: string;
  readonly runs: number;
  readonly passed: number;
  readonly passRate: number;
  readonly costUsd: { readonly total: number; readonly mean: number };
  readonly latencyMs: { readonly mean: number; readonly p50: number };
  readonly tokens: { readonly mean: number };
}

export interface CompareDeps {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly theme?: CliTheme;
  readonly fancy?: boolean;
  // The suites the paths name (files, or directories of *.toml), trust
  // checked; throws a named refusal.
  readonly loadSuiteFiles: (paths: readonly string[]) => FileSuite[];
  readonly runFileSuite: (
    suite: FileSuite,
    model: string,
  ) => Promise<SuiteRunOutcome>;
}

export interface CompareOptions {
  readonly suiteFile: readonly string[];
  readonly models: readonly string[];
  readonly repeat: number;
  readonly json: boolean;
}

function mean(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * Each model's totals over its runs.
 * @internal
 */
export function summarizeRuns(
  runs: readonly CompareRun[],
  models: readonly string[],
): ModelSummary[] {
  return models.map((model) => {
    const mine = runs.filter((run) => run.model === model);
    const passed = mine.filter((run) => run.success).length;
    const cost = mine.map((run) => run.costUsd);
    const latency = mine.map((run) => run.latencyMs);
    return {
      model,
      runs: mine.length,
      passed,
      passRate: mine.length === 0 ? 0 : passed / mine.length,
      costUsd: {
        total: cost.reduce((sum, value) => sum + value, 0),
        mean: mean(cost),
      },
      latencyMs: { mean: mean(latency), p50: median(latency) },
      tokens: { mean: mean(mine.map((run) => run.tokens)) },
    };
  });
}

/** Runs every suite against every model, `repeat` times each. */
async function runComparison(
  suites: readonly FileSuite[],
  options: Pick<CompareOptions, 'models' | 'repeat'>,
  runFileSuite: CompareDeps['runFileSuite'],
): Promise<CompareRun[]> {
  const runs: CompareRun[] = [];
  for (const suite of suites) {
    for (const model of options.models) {
      for (let repetition = 1; repetition <= options.repeat; repetition += 1) {
        try {
          const outcome = await runFileSuite(suite, model);
          runs.push({
            suite: suite.id,
            model,
            repetition,
            success: outcome.success && gatesPass(outcome.signals),
            costUsd: outcome.signals.costUsd,
            tokens: outcome.signals.tokens,
            latencyMs: outcome.signals.latencyMs,
          });
        } catch (error) {
          runs.push({
            suite: suite.id,
            model,
            repetition,
            success: false,
            costUsd: 0,
            tokens: 0,
            latencyMs: 0,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }
  return runs;
}

function percent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** The side-by-side report: per model, then each suite's passes per model. */
function renderComparison(
  suites: readonly FileSuite[],
  runs: readonly CompareRun[],
  summaries: readonly ModelSummary[],
  view: { readonly theme?: CliTheme; readonly fancy?: boolean },
): string[] {
  const theme = view.theme ?? PLAIN;
  const fancy = view.fancy === true;
  const models = renderTable(
    summaries.map((summary) => [
      summary.model,
      String(summary.runs),
      String(summary.passed),
      percent(summary.passRate),
      `$${summary.costUsd.mean.toFixed(4)}`,
      seconds(summary.latencyMs.p50),
      Math.round(summary.tokens.mean).toLocaleString('en-US'),
    ]),
    [
      { header: 'MODEL' },
      { header: 'RUNS' },
      { header: 'PASSED' },
      { header: 'PASS RATE' },
      { header: 'COST/RUN' },
      { header: 'P50 LATENCY' },
      { header: 'TOKENS/RUN' },
    ],
    { fancy, theme },
  );
  const bySuite = renderTable(
    suites.map((suite) => [
      suite.id,
      ...summaries.map((summary) => {
        const mine = runs.filter(
          (run) => run.suite === suite.id && run.model === summary.model,
        );
        return `${mine.filter((run) => run.success).length}/${mine.length}`;
      }),
    ]),
    [
      { header: 'SUITE' },
      ...summaries.map((summary) => ({ header: summary.model.toUpperCase() })),
    ],
    { fancy, theme },
  );
  return [models, '', bySuite];
}

/** The compare mode of `kubic benchmark`. */
export async function runCompareCommand(
  options: CompareOptions,
  deps: CompareDeps,
): Promise<CommandResult> {
  if (
    !Number.isInteger(options.repeat) ||
    options.repeat < 1 ||
    options.repeat > MAX_REPEAT
  ) {
    deps.err(`error: --repeat must be an integer from 1 to ${MAX_REPEAT}`);
    return { exitCode: EXIT_USAGE };
  }
  let suites: FileSuite[];
  try {
    suites = deps.loadSuiteFiles(options.suiteFile);
  } catch (error) {
    deps.err(
      `error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { exitCode: EXIT_USAGE };
  }
  if (suites.length === 0) {
    deps.err('error: the suite files name no suite');
    return { exitCode: EXIT_USAGE };
  }
  const runs = await runComparison(suites, options, deps.runFileSuite);
  const summaries = summarizeRuns(runs, options.models);
  const failed = runs.filter((run) => run.error !== undefined);
  const exitCode = failed.length === 0 ? EXIT_OK : EXIT_FAILED;
  if (options.json) {
    deps.out(
      formatJson({
        ok: exitCode === EXIT_OK,
        exitCode,
        models: summaries,
        suites: suites.map((suite) => ({ id: suite.id, title: suite.title })),
        runs,
      }),
    );
    return { exitCode };
  }
  for (const line of renderComparison(suites, runs, summaries, deps)) {
    deps.out(line);
  }
  for (const run of failed) {
    deps.err(
      `error: ${run.suite} on ${run.model} (run ${run.repetition}) could not run: ${run.error}`,
    );
  }
  deps.out(
    `compare: ${suites.length} suite(s) × ${options.models.length} model(s) × ${options.repeat} run(s) each`,
  );
  return { exitCode };
}
