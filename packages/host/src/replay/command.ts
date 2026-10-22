// `kubic replay` at a declared determinism tier (tiers, pins, exit codes).
//
// The four invocations (the mapping below follows the flags
// --model, --workspace/--worktree, --diff-against and the
// exact/different-model/different-worktree/compare/regression list):
//   exact               `kubic replay traj.json` (Recorded, log-only —
//                       never re-executes, so it never collides with the
//                       live re-execution label below)
//   live-exact          `... --tier live --role-config r` (Live
//                       re-execution at the recorded model/worktree; the
//                       invocation alone tells it apart from log-only exact)
//   different-model     `... --model p/id --tier deterministic --lockfile f`
//   different-worktree  `... --worktree <path>` (experimental var) with
//                       deterministic/live re-execution
//   compare/regression  `... --diff-against other.json` (Recorded, log-only;
//                       exit 1 names the changed vars = regression signal)
//
// Tiers (honesty rule — tier inflation is a bug, never a fallback):
//   recorded      trajectory alone; log-only, never calls the runner
//                 (no network, no model)
//   deterministic re-executes via the injected runner; requires a pinned
//                 --model plus a --lockfile (pin artifact)
//   live          re-executes via the injected runner; requires a pinned
//                 --role-config (pins come from the role, so --model and
//                 --lockfile are refused under live)
// The published tier is printed and present in --json for every
// result, including refusals and parse errors. Exit codes are the
// subset 0/1/2/5/6: runner termini pass through a local allowlist that
// fail-closes to exit 2 (run-cli's exit-code constants are reused, not
// its wider terminus mapping).
//
// Faux-only: re-execution is injected by the composition root (faux in
// tests); this module never touches the network or a model. File reads
// go through the exec FileBridge (I/O confinement).

import type { CommandResult } from '@kubic/core/cli/exit-codes';
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from '@kubic/core/cli/exit-codes';
import { createLineLogger } from '@kubic/core/cli/logger';
import { formatJson } from '@kubic/core/cli/output';
import type { TrajectoryExport } from '@kubic/trajectory/schema';
import { compareTrajectories } from './compare.js';
import { fail, PLAIN } from './envelope.js';
import {
  checkLockfile,
  checkRoleConfig,
  isModelPin,
  resolveWorktreeOverride,
} from './pins.js';
import {
  describeRecorded,
  loadOtherTrajectory,
  loadTrajectory,
  modelIdOf,
} from './recorded.js';
import { executeTierRun, resolveTier } from './tiers.js';
import type {
  ReplayCommandDeps,
  ReplayCommandOptions,
  ReplayEnvelope,
  ReplayInvocation,
  ReplayOptions,
  ReplayRuntimeDeps,
} from './types.js';

export async function runReplayCommand(
  parsed: ReplayCommandOptions,
  deps: ReplayCommandDeps,
  // The effective config's projections: handed straight to
  // the run seam so re-execution consumes the config like `kubic run`.
  // Absent means the documented defaults (runtimeRunDeps' own empty
  // answer) — never an invented policy.
  runtime: ReplayRuntimeDeps = { policySource: 'default' },
): Promise<CommandResult> {
  const json = parsed.json === true;
  const log = createLineLogger(deps.err, {
    theme: json ? PLAIN : (deps.errTheme ?? PLAIN),
  });
  const tier = resolveTier(parsed.tier);
  if (parsed.trajectory === undefined) {
    return refused(
      deps,
      { json, tier, log },
      null,
      EXIT_USAGE,
      'missing-trajectory',
      'missing required argument <trajectory.json>',
    );
  }
  const options: ReplayOptions = {
    trajectory: parsed.trajectory,
    tier,
    tierRaw: parsed.tier,
    model: parsed.model,
    lockfile: parsed.lockfile,
    roleConfig: parsed.roleConfig,
    worktree: parsed.worktree,
    diffAgainst: parsed.diffAgainst,
    json,
    log,
  };

  if (options.tier === 'unknown') {
    return refused(
      deps,
      options,
      null,
      EXIT_USAGE,
      'invalid-tier',
      `invalid --tier ${JSON.stringify(options.tierRaw)} (want recorded|deterministic|live)`,
    );
  }

  // Honesty gates: a tier that needs pins refuses without them
  // (exit 2) — it never silently falls back to a lower tier.
  if (options.tier === 'recorded') {
    const extras: string[] = [];
    if (options.model !== undefined) extras.push('--model');
    if (options.lockfile !== undefined) extras.push('--lockfile');
    if (options.roleConfig !== undefined) extras.push('--role-config');
    if (options.worktree !== undefined) extras.push('--worktree');
    if (extras.length > 0) {
      return refused(
        deps,
        options,
        options.trajectory,
        EXIT_USAGE,
        'recorded-takes-trajectory-alone',
        `tier recorded replays the trajectory alone — remove ${extras.join(', ')} or declare --tier deterministic|live`,
      );
    }
  }

  const loaded = loadTrajectory(options.trajectory);
  if ('exit' in loaded) {
    return refused(
      deps,
      options,
      options.trajectory,
      loaded.exit,
      loaded.code,
      loaded.message,
    );
  }
  const trajectory = loaded.trajectory;
  if (options.tier === 'recorded' && options.diffAgainst === undefined) {
    return replayRecorded(deps, options, trajectory);
  }
  if (options.tier === 'deterministic') {
    return replayDeterministic(deps, runtime, options, trajectory);
  }
  if (options.tier === 'live') {
    return replayLive(deps, runtime, options, trajectory);
  }
  // Every tier is implemented. Compare closes the
  // four invocations.
  return replayCompare(deps, options, trajectory);
}

// A refusal as the command's result.
function refused(...args: Parameters<typeof fail>): CommandResult {
  return { exitCode: fail(...args) };
}

// `kubic replay traj.json`: the recorded run described, never re-executed.
function replayRecorded(
  deps: ReplayCommandDeps,
  options: ReplayOptions,
  trajectory: TrajectoryExport,
): CommandResult {
  const envelope: ReplayEnvelope = {
    ok: true,
    exitCode: EXIT_OK,
    tier: 'recorded',
    invocation: 'exact',
    trajectory: options.trajectory,
    changed: [],
    result: {
      status: trajectory.result.status,
      summary: trajectory.result.summary,
    },
  };
  if (options.json) {
    deps.out(formatJson(envelope));
    return { exitCode: EXIT_OK };
  }
  for (const line of describeRecorded(trajectory)) deps.out(line);
  return { exitCode: EXIT_OK };
}

async function replayDeterministic(
  deps: ReplayCommandDeps,
  runtime: ReplayRuntimeDeps,
  options: ReplayOptions,
  trajectory: TrajectoryExport,
): Promise<CommandResult> {
  if (options.model === undefined || options.lockfile === undefined) {
    return refused(
      deps,
      options,
      options.trajectory,
      EXIT_USAGE,
      'deterministic-needs-pins',
      'tier deterministic needs a pinned --model <provider/id> plus a --lockfile — refusing to re-execute unpinned',
    );
  }
  if (options.roleConfig !== undefined) {
    return refused(
      deps,
      options,
      options.trajectory,
      EXIT_USAGE,
      'unexpected-flag-for-tier',
      'tier deterministic takes pins from --model/--lockfile — --role-config belongs to --tier live',
    );
  }
  if (options.diffAgainst !== undefined) {
    return refused(
      deps,
      options,
      options.trajectory,
      EXIT_USAGE,
      'unexpected-flag-for-tier',
      '--diff-against compare is a recorded-tier invocation — re-execution tiers replay one trajectory',
    );
  }
  if (!isModelPin(options.model)) {
    return refused(
      deps,
      options,
      options.trajectory,
      EXIT_USAGE,
      'invalid-model-pin',
      `invalid-model-pin ${JSON.stringify(options.model)} (want 'provider/id') — deterministic replay needs an exact model pin`,
    );
  }
  const lock = checkLockfile(options.lockfile, options.model, trajectory);
  if ('exit' in lock) {
    return refused(
      deps,
      options,
      options.trajectory,
      lock.exit,
      lock.code,
      lock.message,
    );
  }
  let worktree = trajectory.worktree.path;
  const changed: string[] = [];
  const experimental: string[] = [];
  if (options.worktree !== undefined) {
    const resolved = resolveWorktreeOverride(
      deps,
      options,
      trajectory.worktree.path,
    );
    if ('exit' in resolved) return { exitCode: resolved.exit };
    worktree = resolved.worktree;
    changed.push(...resolved.changed);
    experimental.push(...resolved.experimental);
  }
  const invocation: ReplayInvocation =
    options.worktree !== undefined ? 'different-worktree' : 'different-model';
  return {
    exitCode: await executeTierRun(deps, runtime, options, {
      tier: 'deterministic',
      invocation,
      model: options.model,
      worktree,
      lockfile: options.lockfile,
      roleConfig: null,
      role: null,
      changed,
      experimental,
    }),
  };
}

async function replayLive(
  deps: ReplayCommandDeps,
  runtime: ReplayRuntimeDeps,
  options: ReplayOptions,
  trajectory: TrajectoryExport,
): Promise<CommandResult> {
  if (options.roleConfig === undefined) {
    return refused(
      deps,
      options,
      options.trajectory,
      EXIT_USAGE,
      'live-needs-role-config',
      'tier live needs a pinned --role-config — refusing to re-execute without the role that owns the run',
    );
  }
  if (options.model !== undefined || options.lockfile !== undefined) {
    return refused(
      deps,
      options,
      options.trajectory,
      EXIT_USAGE,
      'unexpected-flag-for-tier',
      'tier live takes pins from --role-config — --model/--lockfile belong to --tier deterministic',
    );
  }
  if (options.diffAgainst !== undefined) {
    return refused(
      deps,
      options,
      options.trajectory,
      EXIT_USAGE,
      'unexpected-flag-for-tier',
      '--diff-against compare is a recorded-tier invocation — re-execution tiers replay one trajectory',
    );
  }
  const role = checkRoleConfig(options.roleConfig);
  if ('exit' in role) {
    return refused(
      deps,
      options,
      options.trajectory,
      role.exit,
      role.code,
      role.message,
    );
  }
  const resolved = resolveWorktreeOverride(
    deps,
    options,
    trajectory.worktree.path,
  );
  if ('exit' in resolved) return { exitCode: resolved.exit };
  return {
    exitCode: await executeTierRun(deps, runtime, options, {
      tier: 'live',
      invocation:
        options.worktree !== undefined ? 'different-worktree' : 'live-exact',
      // The role config is the pin artifact: the model re-executes at the
      // trajectory's recorded model under the role's pinned config.
      model: modelIdOf(trajectory),
      worktree: resolved.worktree,
      lockfile: null,
      roleConfig: options.roleConfig,
      role: role.role,
      changed: resolved.changed,
      experimental: resolved.experimental,
    }),
  };
}

// `--diff-against other.json`: what changed between two recorded runs; any
// change is a regression (exit 1).
function replayCompare(
  deps: ReplayCommandDeps,
  options: ReplayOptions,
  trajectory: TrajectoryExport,
): CommandResult {
  const other = loadOtherTrajectory(options.diffAgainst as string);
  if ('exit' in other) {
    return refused(
      deps,
      options,
      options.trajectory,
      other.exit,
      other.code,
      other.message,
    );
  }
  const changed = compareTrajectories(trajectory, other.trajectory);
  const regression = changed.length > 0;
  const exitCode = regression ? EXIT_FAILED : EXIT_OK;
  const envelope: ReplayEnvelope = {
    ok: !regression,
    exitCode,
    tier: 'recorded',
    invocation: 'compare',
    trajectory: options.trajectory,
    changed,
    result: {
      status: trajectory.result.status,
      summary: trajectory.result.summary,
    },
    regression,
  };
  if (options.json) {
    deps.out(formatJson(envelope));
    return { exitCode };
  }
  deps.out('tier: recorded');
  deps.out('invocation: compare');
  deps.out(`changed: ${regression ? changed.join(', ') : 'none (identical)'}`);
  deps.out(`regression: ${regression}`);
  return { exitCode };
}
