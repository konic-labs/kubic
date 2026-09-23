// `kubic replay` at a declared determinism tier (issue #52; §47,
// §47.1 tiers, §72 pins, §78 exit codes).
//
// The four §47 invocations (repo has no design-doc copy of §47 — the
// mapping below follows the issue's Design ref flags --model,
// --workspace/--worktree, --diff-against and the
// exact/different-model/different-worktree/compare/regression list):
//   exact               `kubic replay traj.json` (Recorded, log-only)
//   different-model     `... --model p/id --tier deterministic --lockfile f`
//   different-worktree  `... --worktree <path>` (experimental var) with
//                       deterministic/live re-execution
//   compare/regression  `... --diff-against other.json` (Recorded, log-only;
//                       exit 1 names the changed vars = regression signal)
//
// Tiers (§47.1 honesty rule — tier inflation is a bug, never a fallback):
//   recorded      trajectory alone; log-only, never calls the runner
//                 (no network, no model)
//   deterministic re-executes via the injected runner; requires a pinned
//                 --model plus a --lockfile (§72 pin artifact)
//   live          re-executes via the injected runner; requires a pinned
//                 --role-config (pins come from the role, so --model and
//                 --lockfile are refused under live)
// The published tier (§72) is printed and present in --json for every
// result, including refusals. Exit codes are the §78 subset 0/1/2/5/6,
// reusing run-cli's mapping read-only for runner termini.
//
// Faux-only: re-execution is injected by the composition root (faux in
// tests); this module never touches the network or a model. File reads
// go through the exec FileBridge (I/O confinement).

import { createNodeFileBridge } from '../../../exec/src/file-bridge.js';
import {
  parseTrajectoryExportJSON,
  type TrajectoryExport,
  TrajectorySchemaError,
} from '../../../trajectory/src/schema.js';
import {
  RUN_EXIT_OK,
  RUN_EXIT_USAGE,
  RUN_EXIT_WORKSPACE_UNAVAILABLE,
} from '../run-cli.js';

export type ReplayTier = 'recorded' | 'deterministic' | 'live';

export type ReplayInvocation =
  | 'exact'
  | 'different-model'
  | 'different-worktree'
  | 'compare';

export type ReplayRunTerminus =
  | 'completed'
  | 'failed'
  | 'workspace_unavailable'
  | 'provider_probe_failed';

export interface ReplayRunRequest {
  tier: 'deterministic' | 'live';
  trajectory: string;
  model: string;
  worktree: string;
  lockfile: string | null;
  roleConfig: string | null;
}

export interface ReplayRunResult {
  terminus: ReplayRunTerminus;
  summary: string;
}

export interface ReplayCommandDeps {
  out: (line: string) => void;
  run: (request: ReplayRunRequest) => Promise<ReplayRunResult>;
}

export interface ReplayError {
  code: string;
  message: string;
}

export interface ReplayEnvelope {
  ok: boolean;
  exitCode: number;
  tier: ReplayTier | 'unknown';
  invocation: ReplayInvocation | null;
  trajectory: string | null;
  changed: string[];
  result?: { status: string; summary: string };
  experimental?: string[];
  regression?: boolean;
  error?: ReplayError;
}

function usage(out: (line: string) => void): number {
  out(
    'usage: kubic replay <trajectory.json> [--tier recorded|deterministic|live] [--model <provider/id>] [--lockfile <path>] [--role-config <path>] [--worktree <path>] [--diff-against <other.json>] [--json]',
  );
  return RUN_EXIT_USAGE;
}

interface ReplayOptions {
  trajectory: string;
  tier: ReplayTier;
  model: string | undefined;
  lockfile: string | undefined;
  roleConfig: string | undefined;
  worktree: string | undefined;
  diffAgainst: string | undefined;
  json: boolean;
}

function parseTier(raw: string): ReplayTier | null {
  if (raw === 'recorded' || raw === 'deterministic' || raw === 'live') {
    return raw;
  }
  return null;
}

function parseArgs(
  args: string[],
  out: (line: string) => void,
): { options: ReplayOptions } | { exit: number } {
  let trajectory: string | undefined;
  let tier: ReplayTier = 'recorded';
  let tierRaw: string | undefined;
  let model: string | undefined;
  let lockfile: string | undefined;
  let roleConfig: string | undefined;
  let worktree: string | undefined;
  let diffAgainst: string | undefined;
  let json = false;
  const takeValue = (
    flag: string,
    index: number,
  ): { value: string; next: number } | { exit: number } => {
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      out(`error: ${flag} needs a value`);
      return { exit: RUN_EXIT_USAGE };
    }
    return { value, next: index + 1 };
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '--tier') {
      const taken = takeValue('--tier', i);
      if ('exit' in taken) return taken;
      tierRaw = taken.value;
      i = taken.next;
    } else if (arg === '--model') {
      const taken = takeValue('--model', i);
      if ('exit' in taken) return taken;
      model = taken.value;
      i = taken.next;
    } else if (arg === '--lockfile') {
      const taken = takeValue('--lockfile', i);
      if ('exit' in taken) return taken;
      lockfile = taken.value;
      i = taken.next;
    } else if (arg === '--role-config') {
      const taken = takeValue('--role-config', i);
      if ('exit' in taken) return taken;
      roleConfig = taken.value;
      i = taken.next;
    } else if (arg === '--worktree') {
      const taken = takeValue('--worktree', i);
      if ('exit' in taken) return taken;
      worktree = taken.value;
      i = taken.next;
    } else if (arg === '--diff-against') {
      const taken = takeValue('--diff-against', i);
      if ('exit' in taken) return taken;
      diffAgainst = taken.value;
      i = taken.next;
    } else if (arg === '--json') {
      json = true;
    } else if (arg.startsWith('--')) {
      out(`error: unknown flag ${arg}`);
      return { exit: RUN_EXIT_USAGE };
    } else if (trajectory === undefined) {
      trajectory = arg;
    } else {
      out(`error: unexpected argument ${arg}`);
      return { exit: RUN_EXIT_USAGE };
    }
  }
  if (trajectory === undefined) {
    usage(out);
    return { exit: RUN_EXIT_USAGE };
  }
  if (tierRaw !== undefined) {
    const parsed = parseTier(tierRaw);
    if (parsed === null) {
      out(
        `error: invalid --tier ${JSON.stringify(tierRaw)} (want recorded|deterministic|live)`,
      );
      return { exit: RUN_EXIT_USAGE };
    }
    tier = parsed;
  }
  return {
    options: {
      trajectory,
      tier,
      model,
      lockfile,
      roleConfig,
      worktree,
      diffAgainst,
      json,
    },
  };
}

function fail(
  deps: ReplayCommandDeps,
  options: { json: boolean; tier: ReplayTier | 'unknown' },
  trajectory: string | null,
  exitCode: number,
  code: string,
  message: string,
): number {
  const envelope: ReplayEnvelope = {
    ok: false,
    exitCode,
    tier: options.tier,
    invocation: null,
    trajectory,
    changed: [],
    error: { code, message },
  };
  if (options.json) deps.out(JSON.stringify(envelope));
  else deps.out(`error: ${message}`);
  return exitCode;
}

function readFile(path: string): string {
  return createNodeFileBridge('/').readTextFile(path);
}

function loadTrajectory(
  path: string,
): { trajectory: TrajectoryExport } | { code: string; message: string; exit: number } {
  let raw: string;
  try {
    raw = readFile(path);
  } catch (error) {
    return {
      code: 'trajectory-unreadable',
      message: `cannot read trajectory ${JSON.stringify(path)}: ${error instanceof Error ? error.message : String(error)}`,
      exit: RUN_EXIT_WORKSPACE_UNAVAILABLE,
    };
  }
  try {
    return { trajectory: parseTrajectoryExportJSON(raw) };
  } catch (error) {
    if (error instanceof TrajectorySchemaError && error.code === 'unknown-major') {
      // Replay's §78 subset (0/1/2/5/6) has no schema slot (exit 3 stays
      // inside the trajectory package): an unsupported major is a caller
      // usage error here, with the code preserved machine-readably.
      return { code: 'unknown-major', message: error.message, exit: RUN_EXIT_USAGE };
    }
    return {
      code: 'trajectory-malformed',
      message: error instanceof Error ? error.message : String(error),
      exit: RUN_EXIT_USAGE,
    };
  }
}

function modelIdOf(trajectory: TrajectoryExport): string {
  return `${trajectory.model.provider}/${trajectory.model.model}`;
}

function describeRecorded(trajectory: TrajectoryExport): string[] {
  const actions = trajectory.actions.length;
  const observations = trajectory.observations.length;
  const files = trajectory.diff.filesChanged;
  return [
    'tier: recorded',
    `model: ${modelIdOf(trajectory)}`,
    `worktree: ${trajectory.worktree.path}`,
    `actions: ${actions}`,
    `observations: ${observations}`,
    `result: ${trajectory.result.status} — ${trajectory.result.summary}`,
    `diff: ${files.length} files${files.length > 0 ? ` (${files.join(', ')})` : ''}`,
  ];
}

export async function runReplayCommand(
  args: string[],
  deps: ReplayCommandDeps,
): Promise<number> {
  const parsed = parseArgs(args, deps.out);
  if ('exit' in parsed) return parsed.exit;
  const options = parsed.options;

  // §47.1 honesty gates: a tier that needs pins refuses without them
  // (exit 2) — it never silently falls back to a lower tier.
  if (options.tier === 'recorded') {
    const extras: string[] = [];
    if (options.model !== undefined) extras.push('--model');
    if (options.lockfile !== undefined) extras.push('--lockfile');
    if (options.roleConfig !== undefined) extras.push('--role-config');
    if (options.worktree !== undefined) extras.push('--worktree');
    if (extras.length > 0) {
      return fail(
        deps,
        options,
        options.trajectory,
        RUN_EXIT_USAGE,
        'recorded-takes-trajectory-alone',
        `tier recorded replays the trajectory alone — remove ${extras.join(', ')} or declare --tier deterministic|live`,
      );
    }
  }

  const loaded = loadTrajectory(options.trajectory);
  if ('exit' in loaded) {
    return fail(
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
    const envelope: ReplayEnvelope = {
      ok: true,
      exitCode: RUN_EXIT_OK,
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
      deps.out(JSON.stringify(envelope));
      return RUN_EXIT_OK;
    }
    for (const line of describeRecorded(trajectory)) deps.out(line);
    return RUN_EXIT_OK;
  }

  // Later slices: deterministic/live re-execution, compare. Fail closed
  // until they land rather than claiming an unrun tier.
  if (options.tier !== 'recorded') {
    return fail(
      deps,
      options,
      options.trajectory,
      RUN_EXIT_USAGE,
      'tier-not-implemented',
      `tier ${options.tier} is not implemented yet — refusing instead of running a lower tier`,
    );
  }
  return fail(
    deps,
    options,
    options.trajectory,
    RUN_EXIT_USAGE,
    'diff-against-not-implemented',
    '--diff-against compare is not implemented yet',
  );
}
