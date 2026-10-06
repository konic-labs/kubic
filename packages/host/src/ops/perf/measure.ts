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
//   - attach   — repeated session create + attach + release cycles against a
//               caller-provided sessions root (issue #158): the §61 attach
//               row the orchestrate path now also samples per worker.
//
// The argv-sample mode stays as the explicit fallback (`--samples`), for
// budgets with no live substrate yet (teardown, §94) and for CI where a
// wall-clock measurement is not available. Nothing here invents a number:
// an unmeasurable kind is refused by name, never sampled.
//
// Every measurement is bounded and cleaned up (each created worktree is
// removed and its branch deleted, both exit codes checked), and the clock
// is injected so tests are deterministic.

import { join } from 'node:path';
import type { ExecutionEnv } from '../../../../exec/src/env.js';
import {
  attachSession,
  createSession,
  type SessionStore,
} from '../../../../worker/src/lane/session-store.js';
import { BACKGROUND_CONTEXT } from '../../../../worker/src/pi-boundary.js';
import type { PerfBudgetKind } from './budgets.js';

// Budget kinds this module can actually measure. teardown stays
// argv-sample-only until the worker lifecycle (issue #94) exposes its live
// seam; attach gained its substrate with issue #158.
export const MEASURED_BUDGET_KINDS = ['spawn', 'worktree', 'attach'] as const;

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
  // `git rev-parse --show-toplevel` from the env's cwd (issue #252), so a
  // subdirectory run measures under the repo root; outside a repo the env's
  // cwd is kept.
  repoRoot?: string;
  clock?: () => number;
  // Spawn source only: the argv to run per sample. Defaults to a trivial
  // node one-liner, so the measured latency is process-start latency.
  spawnCommand?: { cmd: string; args: string[] };
  // Attach source only (issue #158): the session store the create/attach
  // cycles run against. Each sample creates its own session and releases it,
  // so nothing is left locked or behind.
  sessionStore?: SessionStore;
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

// Issue #252: the repo a subdirectory run measures — `git rev-parse
// --show-toplevel` through the injected shell (never the env cwd
// directly). Undefined outside a repo (or when the seam cannot run git),
// so the caller keeps the old env-cwd fallback there.
async function gitToplevel(env: ExecutionEnv): Promise<string | undefined> {
  try {
    const probe = await env.shell
      .spawn('git', ['rev-parse', '--show-toplevel'], {
        provenance: {
          sessionId: 'perf',
          agentId: 'perf',
          toolCallId: 'perf-toplevel',
          turnId: 0,
          operation: 'perf_measure_toplevel',
        },
      })
      .wait();
    const top = probe.stdout.trim();
    return probe.exitCode === 0 && top !== '' ? top : undefined;
  } catch {
    return undefined;
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
  // Issue #252: a failed spawn is a measurement error, not a timing — a
  // sample of a command that never ran measures nothing.
  const done = await handle.wait();
  if (done.exitCode !== 0) {
    throw new MeasureError(
      `perf spawn command failed while measuring (exit ${done.exitCode}): ${done.stderr.trim().slice(0, 200)}`,
    );
  }
  return clock() - started;
}

// One worktree sample: add then remove then delete the branch, so the
// samples measure the same cycle the §61 worktree budget governs and leave
// nothing behind (issue #252: `worktree remove` keeps the branch — without
// the delete every sample leaked `kubic/perf-*` into the user's repo, where
// `kubic clean` then listed it). The measured ms is the add side alone (§61
// budgets the cold add); the remove and the delete are cleanup — both are
// attempted and both exit codes are checked, so a failed cleanup is a
// named measurement error instead of a silent leak.
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
    // A failed add can still leave the branch behind (branch created,
    // checkout failed): best-effort delete, result ignored — the add
    // error below is the report.
    try {
      await env.shell
        .spawn('git', ['branch', '-D', branch], {
          provenance: {
            sessionId: 'perf',
            agentId,
            toolCallId: 'perf-worktree-cleanup',
            turnId: 0,
            operation: 'perf_measure_worktree_cleanup',
          },
        })
        .wait();
    } catch {
      // Best-effort only: the add failure is the error that matters.
    }
    throw new MeasureError(
      `git worktree add failed while measuring (exit ${added.exitCode}): ${added.stderr.trim().slice(0, 200)}`,
    );
  }
  const elapsed = clock() - started;
  let removeFailed: string | undefined;
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
    const removed = await remove.wait();
    if (removed.exitCode !== 0) {
      removeFailed = `git worktree remove --force failed while measuring (exit ${removed.exitCode}): ${removed.stderr.trim().slice(0, 200)}`;
    }
  } catch (error) {
    removeFailed = `git worktree remove --force failed while measuring: ${error instanceof Error ? error.message : String(error)}`;
  }
  // The branch delete is attempted even when the remove failed (cleanup
  // attempted, per the contract) and its exit code is checked too.
  let deleteFailed: string | undefined;
  try {
    const deleted = await env.shell
      .spawn('git', ['branch', '-D', branch], {
        provenance: {
          sessionId: 'perf',
          agentId,
          toolCallId: 'perf-worktree-branch-delete',
          turnId: 0,
          operation: 'perf_measure_worktree_branch_delete',
        },
      })
      .wait();
    if (deleted.exitCode !== 0) {
      deleteFailed = `git branch -D failed while measuring (exit ${deleted.exitCode}): ${deleted.stderr.trim().slice(0, 200)}`;
    }
  } catch (error) {
    deleteFailed = `git branch -D failed while measuring: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (removeFailed !== undefined) throw new MeasureError(removeFailed);
  if (deleteFailed !== undefined) throw new MeasureError(deleteFailed);
  return elapsed;
}

// One attach sample (issue #158): create a session, attach it, release — the
// measured ms is the ATTACH leg alone (§61 budgets the attach), and the
// session is removed afterwards so a measurement leaves nothing behind.
async function measureAttachOnce(
  store: SessionStore,
  clock: () => number,
  index: number,
): Promise<number> {
  const id = `perf-attach-${process.pid}-${index}`;
  const created = await createSession(
    store,
    { id, cwd: store.root },
    BACKGROUND_CONTEXT,
  );
  try {
    await created.release(BACKGROUND_CONTEXT);
    const started = clock();
    const attached = await attachSession(store, id, BACKGROUND_CONTEXT);
    try {
      return clock() - started;
    } finally {
      await attached.release(BACKGROUND_CONTEXT);
    }
  } finally {
    // Cleanup outside the measurement: the session directory is this
    // measurement's own, never a user's session.
    try {
      // Recursive + forced: the measurement's own session dir, never a
      // user's (the id carries this process's pid).
      store.bridge.remove(join(store.root, id), true, true);
    } catch {
      // Best-effort: a leftover measurement session is inert (no lock held).
    }
  }
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
    // Issue #252: a subdirectory run measures the REPO's worktrees
    // (`<toplevel>/.kubic/wt`), not `<subdir>/.kubic/wt` — resolved the way
    // the writer resolves it, through the injected shell so tests stay
    // hermetic. An explicit repoRoot still wins; outside a repo the env
    // cwd is kept (same as before — nothing else could name the repo).
    const repoRoot =
      request.repoRoot ?? (await gitToplevel(request.env)) ?? request.env.cwd;
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
  if (request.kind === 'attach') {
    const store = request.sessionStore;
    if (store === undefined) {
      throw new MeasureError(
        "perf budget 'attach' needs a sessions root to measure — pass --samples (the documented fallback) or run through the CLI, which supplies the default one",
      );
    }
    const samplesMs: number[] = [];
    for (let i = 0; i < request.samples; i += 1) {
      samplesMs.push(await measureAttachOnce(store, clock, i));
    }
    return {
      kind: 'attach',
      source: 'measured',
      samplesMs,
      note: `measured ${samplesMs.length} real session create/attach cycle(s) in ${store.root}`,
    };
  }
  // teardown has no live substrate yet: refuse by name instead of returning a
  // fabricated sample (issue #94 owns that seam).
  throw new MeasureError(
    `perf budget '${request.kind}' has no live measurement source yet — pass --samples (the documented fallback); measurement for teardown lands with the worker lifecycle (issue #94)`,
  );
}
