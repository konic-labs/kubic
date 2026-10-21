// Eval runner.
// Two entry paths, one record shape:
// - runEvalTask: execute a suite against a task prompt (suite execution is
//   injected — faux in tests/CI, the real lane in prod) and score it.
// - runEvalTrajectory: score an existing trajectory export (parsed with
//   parseTrajectoryExport, read-only) without re-running anything.
// Both paths are pure: worktree cleanliness is checked through the
// injected ensureCleanWorktree hook (this package never touches node:fs,
// per dep-lint I/O confinement). Missing worktree/size (and, for the
// trajectory path, an invalid determinism tier) is a fail-closed
// EvalRunnerError (exit 2), never a stored record.

import { EXIT_USAGE, type ExitCode } from '@kubic/core/cli/exit-codes';
import type { TrajectoryExport } from '@kubic/trajectory/schema';
import { parseTrajectoryExport } from '@kubic/trajectory/schema';
import {
  type EvalDeterminism,
  type EvalRecord,
  type EvalSize,
  isEvalSize,
  reconcileUsage,
  type UsageRowLike,
  validateEvalRecord,
} from './records.js';
import { computeSignals, type EvalSignals, gatesPass } from './signals.js';
import { findSuite } from './suites.js';

export type EvalRunnerErrorCode =
  | 'unknown-suite'
  | 'stub-suite'
  | 'no-executable-suites'
  | 'ambiguous-suite'
  | 'missing-worktree'
  | 'missing-size'
  | 'invalid-size'
  | 'dirty-worktree'
  | 'usage-mismatch'
  | 'missing-usage-rows'
  | 'invalid-trajectory'
  | 'invalid-record'
  | 'trajectory-unreadable'
  | 'trajectory-malformed'
  | 'provenance-mismatch'
  | 'suite-file-invalid'
  | 'suite-file-untrusted';

export class EvalRunnerError extends Error {
  readonly code: EvalRunnerErrorCode;
  readonly exitCode: ExitCode = EXIT_USAGE;

  constructor(code: EvalRunnerErrorCode, message: string) {
    super(message);
    this.name = 'EvalRunnerError';
    this.code = code;
  }

  toJSON(): { error: { code: string; message: string; exitCode: number } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        exitCode: this.exitCode,
      },
    };
  }
}

export type EvalWorkspace = 'inline' | 'worktree';

export interface SuiteRunOutcome {
  success: boolean;
  signals: EvalSignals;
  usageRows?: UsageRowLike[];
}

export interface EvalTaskOptions {
  suite: string;
  // The prompt to run against the suite's fixture; absent, the suite's own
  // task runs.
  task?: string;
  model: string;
  thinking: string | null;
  worktree: string;
  size: string;
  workspace: EvalWorkspace;
}

export interface EvalTaskDeps {
  runSuite: (
    suiteId: string,
    task: string | undefined,
  ) => Promise<SuiteRunOutcome>;
  ensureCleanWorktree?: (worktree: string) => boolean;
}

// The trajectory path takes model/thinking/worktree from the export itself:
// the flags are optional cross-checks, and a flag that disagrees with the
// export is refused (provenance-mismatch) rather than silently stamped over
// it. The record size is not recorded in an export, so it stays required; the
// determinism tier is DERIVED from the path (`recorded` here) rather than
// asked of the caller.
export interface EvalTrajectoryOptions {
  suite: string;
  trajectory: unknown;
  model?: string;
  thinking?: string | null;
  worktree?: string;
  size?: string;
}

function requireSize(size: string | undefined): EvalSize {
  if (typeof size !== 'string' || size.trim() === '') {
    throw new EvalRunnerError(
      'missing-size',
      'size is required (smoke|standard|extended) — refusing to store an unsized record',
    );
  }
  if (!isEvalSize(size)) {
    throw new EvalRunnerError(
      'invalid-size',
      `unknown size ${JSON.stringify(size)}: one of smoke, standard, extended`,
    );
  }
  return size;
}

// Exported for the benchmark path: the matrix validates
// provenance once before it runs anything, so a stub-only selection — which
// never reaches runEvalTask — cannot skip the check and report `ok`.
export function checkEvalProvenance(options: {
  worktree: string;
  size: string;
}): EvalSize {
  if (typeof options.worktree !== 'string' || options.worktree.trim() === '') {
    throw new EvalRunnerError(
      'missing-worktree',
      'worktree is required: eval records how it ran — refusing to store a worktree-less result',
    );
  }
  return requireSize(options.size);
}

// One flag checked against the export's own value: absent means "take the
// export's", present-and-different is a refusal.
function crossCheck<T>(field: string, flag: T | undefined, recorded: T): void {
  if (flag === undefined || flag === recorded) return;
  throw new EvalRunnerError(
    'provenance-mismatch',
    `--${field} ${JSON.stringify(flag)} disagrees with the trajectory's recorded ${field} ${JSON.stringify(recorded)} — refusing to misattribute the record`,
  );
}

function requireCleanWorktree(
  workspace: EvalWorkspace,
  worktree: string,
  ensureCleanWorktree: ((worktree: string) => boolean) | undefined,
): void {
  if (workspace !== 'worktree') return;
  // Fail closed: without a checker there is no evidence the tree is
  // clean, so a worktree-scoped run is refused rather than scored.
  if (ensureCleanWorktree === undefined) {
    throw new EvalRunnerError(
      'dirty-worktree',
      `worktree ${JSON.stringify(worktree)} has no cleanliness checker — refusing to benchmark without one`,
    );
  }
  const clean = ensureCleanWorktree(worktree);
  if (!clean) {
    throw new EvalRunnerError(
      'dirty-worktree',
      `worktree ${JSON.stringify(worktree)} is not clean — refusing to benchmark against a dirty tree`,
    );
  }
}

function toRecord(
  options: {
    suite: string;
    model: string;
    thinking: string | null;
    worktree: string;
    size: EvalSize;
    determinism: EvalDeterminism;
    success: boolean;
    signals: EvalSignals;
  },
  categoryOf: string,
): EvalRecord {
  const validated = validateEvalRecord({
    suite: options.suite,
    // A suite is one case: its id is the suite's own name.
    caseId: options.suite,
    category: categoryOf,
    success: options.success,
    costUsd: options.signals.costUsd,
    tokens: options.signals.tokens,
    latencyMs: options.signals.latencyMs,
    toolCalls: options.signals.toolCalls,
    model: options.model,
    thinking: options.thinking,
    worktree: options.worktree,
    size: options.size,
    determinism: options.determinism,
    signals: options.signals,
  });
  if (!validated.valid) {
    // The code names the real cause (a validation failure is
    // `invalid-record`, not `missing-worktree`).
    throw new EvalRunnerError(
      'invalid-record',
      `record rejected: ${validated.errors.join('; ')}`,
    );
  }
  return validated.record;
}

export async function runEvalTask(
  options: EvalTaskOptions,
  deps: EvalTaskDeps,
): Promise<EvalRecord> {
  const suite = findSuite(options.suite);
  if (suite === undefined) {
    throw new EvalRunnerError(
      'unknown-suite',
      `unknown suite ${JSON.stringify(options.suite)}`,
    );
  }
  if (suite.stub) {
    throw new EvalRunnerError(
      'stub-suite',
      `suite ${JSON.stringify(options.suite)} is a stub — refusing to score unimplemented work`,
    );
  }
  const size = checkEvalProvenance(options);
  requireCleanWorktree(
    options.workspace,
    options.worktree,
    deps.ensureCleanWorktree,
  );
  const outcome = await deps.runSuite(options.suite, options.task);
  // Fail closed: a task-path record without usage rows cannot be
  // reconciled, so it is refused rather than stored unreconciled.
  if (outcome.usageRows === undefined) {
    throw new EvalRunnerError(
      'missing-usage-rows',
      'usage rows are required: task-path signals must reconcile against usage rows — refusing to store an unreconciled record',
    );
  }
  const reconciled = reconcileUsage(
    {
      tokens: outcome.signals.tokens,
      costUsd: outcome.signals.costUsd,
      latencyMs: outcome.signals.latencyMs,
    },
    outcome.usageRows,
  );
  if (!reconciled.ok) {
    throw new EvalRunnerError(
      'usage-mismatch',
      `signals do not reconcile with usage rows: ${reconciled.errors.join('; ')}`,
    );
  }
  // Gate success on the signals: a run that completed with a red
  // tests/build/lint/typecheck gate stores success=false.
  const success = outcome.success && gatesPass(outcome.signals);
  return toRecord(
    { ...options, size, determinism: 'live', ...outcome, success },
    suite.category,
  );
}

export async function runEvalTrajectory(
  options: EvalTrajectoryOptions,
): Promise<EvalRecord> {
  const suite = findSuite(options.suite);
  if (suite === undefined) {
    throw new EvalRunnerError(
      'unknown-suite',
      `unknown suite ${JSON.stringify(options.suite)}`,
    );
  }
  if (suite.stub) {
    throw new EvalRunnerError(
      'stub-suite',
      `suite ${JSON.stringify(options.suite)} is a stub — refusing to score unimplemented work`,
    );
  }
  const size = requireSize(options.size);
  let parsed: TrajectoryExport;
  try {
    parsed = parseTrajectoryExport(options.trajectory);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new EvalRunnerError(
      'invalid-trajectory',
      `invalid trajectory export: ${message}`,
    );
  }
  const model = parsed.provenance.model;
  const thinking = parsed.model.thinking ?? null;
  const worktree = parsed.provenance.worktree;
  crossCheck('model', options.model, model);
  crossCheck('thinking', options.thinking, thinking);
  crossCheck('worktree', options.worktree, worktree);
  checkEvalProvenance({ worktree, size });
  const signals = computeSignals(parsed);
  return toRecord(
    {
      suite: options.suite,
      model,
      thinking,
      worktree,
      size,
      determinism: 'recorded',
      success: signals.completion && gatesPass(signals),
      signals,
    },
    suite.category,
  );
}
