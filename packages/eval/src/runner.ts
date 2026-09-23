// Eval runner (issue #53; design §48, §73, §82).
// Two entry paths, one record shape:
// - runEvalTask: execute a suite against a task prompt (suite execution is
//   injected — faux in tests/CI, the real lane in prod) and score it.
// - runEvalTrajectory: score an existing trajectory export (parsed with
//   parseTrajectoryExport, read-only) without re-running anything.
// Both paths are pure: worktree cleanliness is checked through the
// injected ensureCleanWorktree hook (this package never touches node:fs,
// per dep-lint I/O confinement). Missing worktree/generation/tier is a
// fail-closed EvalRunnerError (exit 2), never a stored record.

import type { TrajectoryExport } from '../../trajectory/src/schema.js';
import { parseTrajectoryExport } from '../../trajectory/src/schema.js';
import {
  type EvalRecord,
  type EvalTier,
  isEvalTier,
  reconcileUsage,
  type UsageRowLike,
  validateEvalRecord,
} from './records.js';
import { computeSignals, type EvalSignals, gatesPass } from './signals.js';
import { findSuite } from './suites.js';

export type EvalRunnerErrorCode =
  | 'unknown-suite'
  | 'stub-suite'
  | 'missing-worktree'
  | 'missing-generation'
  | 'missing-tier'
  | 'invalid-tier'
  | 'dirty-worktree'
  | 'usage-mismatch'
  | 'missing-usage-rows'
  | 'invalid-trajectory';

export class EvalRunnerError extends Error {
  readonly code: EvalRunnerErrorCode;
  readonly exitCode = 2;

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
  task: string;
  model: string;
  thinking: string | null;
  worktree: string;
  generation: number;
  tier: string;
  workspace: EvalWorkspace;
}

export interface EvalTaskDeps {
  runSuite: (suiteId: string, task: string) => Promise<SuiteRunOutcome>;
  ensureCleanWorktree?: (worktree: string) => boolean;
}

export interface EvalTrajectoryOptions {
  suite: string;
  trajectory: unknown;
  model: string;
  thinking: string | null;
  worktree: string;
  generation: number;
  tier: string;
}

function requireProvenance(options: {
  worktree: string;
  generation: number;
  tier: string;
}): EvalTier {
  if (typeof options.worktree !== 'string' || options.worktree.trim() === '') {
    throw new EvalRunnerError(
      'missing-worktree',
      'worktree is required: eval records how it ran (§73) — refusing to store a worktree-less result',
    );
  }
  if (
    typeof options.generation !== 'number' ||
    !Number.isInteger(options.generation) ||
    !(options.generation >= 0)
  ) {
    throw new EvalRunnerError(
      'missing-generation',
      'generation is required: eval records which worker generation ran (§73)',
    );
  }
  if (typeof options.tier !== 'string' || options.tier.trim() === '') {
    throw new EvalRunnerError(
      'missing-tier',
      'tier is required (smoke|standard|extended, §72) — refusing to store an untiered record',
    );
  }
  if (!isEvalTier(options.tier)) {
    throw new EvalRunnerError(
      'invalid-tier',
      `unknown tier ${JSON.stringify(options.tier)}: one of smoke, standard, extended`,
    );
  }
  return options.tier;
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
    generation: number;
    tier: EvalTier;
    success: boolean;
    signals: EvalSignals;
  },
  categoryOf: string,
): EvalRecord {
  const validated = validateEvalRecord({
    suite: options.suite,
    caseId: `${options.suite}:${options.generation}`,
    category: categoryOf,
    success: options.success,
    costUsd: options.signals.costUsd,
    tokens: options.signals.tokens,
    latencyMs: options.signals.latencyMs,
    toolCalls: options.signals.toolCalls,
    model: options.model,
    thinking: options.thinking,
    worktree: options.worktree,
    generation: options.generation,
    tier: options.tier,
    signals: options.signals,
  });
  if (!validated.valid) {
    throw new EvalRunnerError(
      'missing-worktree',
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
  const tier = requireProvenance(options);
  requireCleanWorktree(
    options.workspace,
    options.worktree,
    deps.ensureCleanWorktree,
  );
  const outcome = await deps.runSuite(options.suite, options.task);
  // Fail closed (§39): a task-path record without usage rows cannot be
  // reconciled, so it is refused rather than stored unreconciled.
  if (outcome.usageRows === undefined) {
    throw new EvalRunnerError(
      'missing-usage-rows',
      'usage rows are required: task-path signals must reconcile against §39 usage rows — refusing to store an unreconciled record',
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
      `signals do not reconcile with §39 usage rows: ${reconciled.errors.join('; ')}`,
    );
  }
  // Gate success on the signals: a run that completed with a red
  // tests/build/lint/typecheck gate stores success=false.
  const success = outcome.success && gatesPass(outcome.signals);
  return toRecord({ ...options, tier, ...outcome, success }, suite.category);
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
  const tier = requireProvenance(options);
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
  const signals = computeSignals(parsed);
  return toRecord(
    {
      suite: options.suite,
      model: options.model,
      thinking: options.thinking,
      worktree: options.worktree,
      generation: options.generation,
      tier,
      success: signals.completion && gatesPass(signals),
      signals,
    },
    suite.category,
  );
}
