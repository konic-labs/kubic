// Real perf measurements for `kubic perf` (issue #98, criterion 2).
//
// Before this module, `kubic perf --budget <kind> --samples …` evaluated
// operator-supplied argv numbers — "real measurements" were unreachable.
// This module supplies the measured half for the two budgets with a live
// substrate, so the budget is evaluated over samples the tool took itself:
//
//   - spawn   — repeated spawn+readiness cycles through the exec Shell seam
//               (the §42 path: one OS process per subagent). Hermetic with
//               FakeExecutionEnv in tests, real with NodeExecutionEnv.
//   - worktree — repeated `git worktree add` + `git worktree remove` cycles
//               through an injected ExecutionEnv, in a caller-provided repo.
//
// The argv-sample mode stays as the explicit fallback (`--samples`), for
// budgets with no live substrate yet (attach/teardown, §94) and for CI
// where a wall-clock measurement is not available. Nothing here invents a
// number: an unmeasurable kind is refused by name, never sampled.
//
// Every measurement is bounded and cleaned up (each created worktree is
// removed in a finally), and the clock is injected so tests are
// deterministic.

import type { ExecutionEnv } from '../../../../exec/src/env.js';
import type { PerfBudgetKind } from './budgets.js';

// Budget kinds this module can actually measure. attach/teardown stay
// argv-sample-only until the worker lifecycle (issue #94) exposes the live
// attach/teardown seams.
export const MEASURED_BUDGET_KINDS = ['spawn', 'worktree'] as const;

export type MeasuredBudgetKind = (typeof MEASURED_BUDGET_KINDS)[number];

export function isMeasuredBudgetKind(kind: string): kind is MeasuredBudgetKind {
  return (MEASURED_BUDGET_KINDS as readonly string[]).includes(kind);
}

export interface MeasureRequest {
  kind: PerfBudgetKind;
  // How many samples to take. Each sample is one full cycle; a count of 0 is
  // refused (a vacuous pass is worse than a refusal, same rule as the
  // argv-sample mode).
  samples: number;
  env: ExecutionEnv;
  // Worktree source only: the repo whose worktrees are measured. Defaults to
  // the env's cwd.
  repoRoot?: string;
  clock?: () => number;
  // Spawn source only: the argv to run per sample. Defaults to a trivial
  // node one-liner, so the measured latency is process-start latency.
  spawnCommand?: { cmd: string; args: string[] };
}

export interface MeasureResult {
  kind: PerfBudgetKind;
  source: 'measured';
  samplesMs: number[];
  // Human-readable note naming exactly what was measured, for the CLI line
  // and the --json record. Never a claim the samples do not support.
  note: string;
}

export class MeasureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MeasureError';
  }
}

function assertSampleCount(samples: number): void {
  if (!Number.isInteger(samples) || samples <= 0) {
    throw new MeasureError(
      `perf measurement needs at least one sample (got ${JSON.stringify(samples)})`,
    );
  }
}

// One spawn sample: start the child and wait for it to exit. This is the
// same shell seam the worker spawn path uses, so the measured ms is that
// path's real cost, not a synthetic sleep.
async function measureSpawnOnce(
  env: ExecutionEnv,
  clock: () => number,
  command: { cmd: string; args: string[] },
): Promise<number> {
  const started = clock();
  const handle = env.shell.spawn(command.cmd, command.args, {
    provenance: {
      sessionId: 'perf',
      agentId: 'perf',
      toolCallId: 'perf-spawn',
      turnId: 0,
      operation: 'perf_measure_spawn',
    },
  });
  await handle.wait();
  return clock() - started;
}

// One worktree sample: add then remove, so the samples measure the same
// cycle the §61 worktree budget governs and leave nothing behind.
async function measureWorktreeOnce(
  env: ExecutionEnv,
  clock: () => number,
  repoRoot: string,
  index: number,
): Promise<number> {
  const agentId = `perf-${index}-${process.pid}`;
  const path = `${repoRoot}/.kubic/wt/${agentId}`;
  const branch = `kubic/${agentId}`;
  const started = clock();
  // Explicit argv, never shell-interpolated (same rule as worktree/add.ts).
  const add = env.shell.spawn('git', ['worktree', 'add', path, '-b', branch], {
    provenance: {
      sessionId: 'perf',
      agentId,
      toolCallId: 'perf-worktree-add',
      turnId: 0,
      operation: 'perf_measure_worktree_add',
    },
  });
  const added = await add.wait();
  if (added.exitCode !== 0) {
    throw new MeasureError(
      `git worktree add failed while measuring (exit ${added.exitCode}): ${added.stderr.trim().slice(0, 200)}`,
    );
  }
  const elapsed = clock() - started;
  try {
    const remove = env.shell.spawn(
      'git',
      ['worktree', 'remove', '--force', path],
      {
        provenance: {
          sessionId: 'perf',
          agentId,
          toolCallId: 'perf-worktree-remove',
          turnId: 0,
          operation: 'perf_measure_worktree_remove',
        },
      },
    );
    await remove.wait();
  } finally {
    // The measured ms is the add side alone (§61 budgets the cold add); the
    // remove is cleanup and must run even if it fails.
  }
  return elapsed;
}

export async function measureSamples(
  request: MeasureRequest,
): Promise<MeasureResult> {
  assertSampleCount(request.samples);
  const clock = request.clock ?? Date.now;
  if (request.kind === 'spawn') {
    const command = request.spawnCommand ?? {
      cmd: process.execPath,
      args: ['-e', '0'],
    };
    const samplesMs: number[] = [];
    for (let i = 0; i < request.samples; i += 1) {
      samplesMs.push(await measureSpawnOnce(request.env, clock, command));
    }
    return {
      kind: 'spawn',
      source: 'measured',
      samplesMs,
      note: `measured ${samplesMs.length} real ${command.cmd} spawn cycle(s) through the exec shell seam`,
    };
  }
  if (request.kind === 'worktree') {
    const repoRoot = request.repoRoot ?? request.env.cwd;
    const samplesMs: number[] = [];
    for (let i = 0; i < request.samples; i += 1) {
      samplesMs.push(
        await measureWorktreeOnce(request.env, clock, repoRoot, i),
      );
    }
    return {
      kind: 'worktree',
      source: 'measured',
      samplesMs,
      note: `measured ${samplesMs.length} real git worktree add/remove cycle(s) in ${repoRoot}`,
    };
  }
  // attach/teardown have no live substrate yet: refuse by name instead of
  // returning a fabricated sample (issue #94 owns those seams).
  throw new MeasureError(
    `perf budget '${request.kind}' has no live measurement source yet — pass --samples (the documented fallback); measurement for attach/teardown lands with the worker lifecycle (issue #94)`,
  );
}
