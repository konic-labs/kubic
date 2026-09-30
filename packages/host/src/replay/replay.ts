// `kubic replay` at a declared determinism tier (issue #52; §47,
// §47.1 tiers, §72 pins, §78 exit codes).
//
// The four §47 invocations (repo has no design-doc copy of §47 — the
// mapping below follows the issue's Design ref flags --model,
// --workspace/--worktree, --diff-against and the
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
// Tiers (§47.1 honesty rule — tier inflation is a bug, never a fallback):
//   recorded      trajectory alone; log-only, never calls the runner
//                 (no network, no model)
//   deterministic re-executes via the injected runner; requires a pinned
//                 --model plus a --lockfile (§72 pin artifact)
//   live          re-executes via the injected runner; requires a pinned
//                 --role-config (pins come from the role, so --model and
//                 --lockfile are refused under live)
// The published tier (§72) is printed and present in --json for every
// result, including refusals and parse errors. Exit codes are the §78
// subset 0/1/2/5/6: runner termini pass through a local allowlist that
// fail-closes to exit 2 (run-cli's exit-code constants are reused, not
// its wider terminus mapping).
//
// Faux-only: re-execution is injected by the composition root (faux in
// tests); this module never touches the network or a model. File reads
// go through the exec FileBridge (I/O confinement).

import type { PermissionClasses } from '../../../agents/src/policy.js';
import {
  type CliLogger,
  createLineLogger,
} from '../../../core/src/cli/logger.js';
import { formatJson } from '../../../core/src/cli/output.js';
import { type CliTheme, createCliTheme } from '../../../core/src/cli/theme.js';
import { createNodeFileBridge } from '../../../exec/src/file-bridge.js';
import type { JournalRetention } from '../../../exec/src/journal.js';
import {
  parseTrajectoryExportJSON,
  type TrajectoryExport,
  TrajectorySchemaError,
} from '../../../trajectory/src/schema.js';
import type { SoloApprovalConfig } from '../approvals.js';
import {
  RUN_EXIT_FAILED,
  RUN_EXIT_OK,
  RUN_EXIT_PROVIDER_PROBE_FAILED,
  RUN_EXIT_USAGE,
  RUN_EXIT_WORKSPACE_UNAVAILABLE,
} from '../run-cli.js';

export type ReplayTier = 'recorded' | 'deterministic' | 'live';

export type ReplayInvocation =
  | 'exact'
  | 'live-exact'
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

// Runtime config projections (issue #114): the SAME surface `kubic run`
// threads into its lane (runtimeRunDeps) — the permission classes plus
// their source record (issue #86) and the journal retention bound (§42.4).
// Absent fields mean the documented defaults, exactly as on the run path;
// the composition root passes the effective config's projections so a
// replay re-execution is governed by the config, not by the binary's
// defaults.
export interface ReplayRuntimeDeps {
  policyClasses?: PermissionClasses;
  policySource: 'config' | 'default';
  journalRetention?: JournalRetention;
  // Issue #230: the config `[approvals]` policy, as `kubic run` installs it.
  approvals?: SoloApprovalConfig;
  // Issue #228 (§35.1): the per-path trust check (store resolved-root +
  // env), from the same config load the re-execution tier runs under — it
  // gates the project models.json of the assembled catalog. Absent falls
  // back to the env opt-in inside assembleModels.
  trustProject?: (path: string) => boolean;
}

export interface ReplayCommandDeps {
  // stdout: the report or the one `--json` envelope.
  out: (line: string) => void;
  // stderr: diagnostics — `error: [code] message` refusals and the
  // experimental-override warning (core/cli/logger). Under --json the
  // envelope on stdout carries the error instead.
  err: (line: string) => void;
  // Colours the diagnostic prefixes; absent means plain.
  theme?: CliTheme;
  // Colour of the stderr diagnostics, from stderr's own TTY state (never
  // stdout's); absent means plain.
  errTheme?: CliTheme;
  run: (
    request: ReplayRunRequest,
    runtime: ReplayRuntimeDeps,
  ) => Promise<ReplayRunResult>;
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

// The parsed `kubic replay` operand and options (commander's positional
// argument plus `opts()`). Values stay raw strings: the tier vocabulary
// and the pin rules are this module's semantics, reported in the tiered
// envelope — commander only owns argv syntax (unknown flags, missing
// values, excess operands, `--help`).
export interface ReplayCommandOptions {
  readonly trajectory?: string;
  readonly tier?: string;
  readonly model?: string;
  readonly lockfile?: string;
  readonly roleConfig?: string;
  readonly worktree?: string;
  readonly diffAgainst?: string;
  readonly json?: boolean;
}

interface ReplayOptions {
  trajectory: string;
  tier: ReplayTier | 'unknown';
  tierRaw: string | undefined;
  model: string | undefined;
  lockfile: string | undefined;
  roleConfig: string | undefined;
  worktree: string | undefined;
  diffAgainst: string | undefined;
  json: boolean;
  log: CliLogger;
}

function parseTier(raw: string): ReplayTier | null {
  if (raw === 'recorded' || raw === 'deterministic' || raw === 'live') {
    return raw;
  }
  return null;
}

// Every result publishes a tier (§72): the declared --tier when one was
// given (unknown when it names no known tier), else the recorded default.
function resolveTier(raw: string | undefined): ReplayTier | 'unknown' {
  if (raw === undefined) return 'recorded';
  return parseTier(raw) ?? 'unknown';
}

const PLAIN = createCliTheme('none');

function fail(
  deps: ReplayCommandDeps,
  options: { json: boolean; tier: ReplayTier | 'unknown'; log: CliLogger },
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
  if (options.json) deps.out(formatJson(envelope));
  else options.log.error(`[${code}] ${message}`);
  return exitCode;
}

// Paths the user typed resolve against the working directory (a bridge
// rooted at '/' turned `kubic replay t.json` into `/t.json`); absolute
// paths are unaffected.
function readFile(path: string): string {
  return createNodeFileBridge(process.cwd()).readTextFile(path);
}

function loadTrajectory(
  path: string,
):
  | { trajectory: TrajectoryExport }
  | { code: string; message: string; exit: number } {
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
    if (
      error instanceof TrajectorySchemaError &&
      error.code === 'unknown-major'
    ) {
      // Replay's §78 subset (0/1/2/5/6) has no schema slot (exit 3 stays
      // inside the trajectory package): an unsupported major is a caller
      // usage error here, with the code preserved machine-readably.
      return {
        code: 'unknown-major',
        message: error.message,
        exit: RUN_EXIT_USAGE,
      };
    }
    return {
      code: 'trajectory-malformed',
      message: error instanceof Error ? error.message : String(error),
      exit: RUN_EXIT_USAGE,
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isModelPin(value: string): boolean {
  const slash = value.indexOf('/');
  return slash > 0 && slash < value.length - 1;
}

// §72 pin artifact for the Deterministic tier: a JSON file pinning the
// exact models the re-execution may use. Minimal but fail-closed: it
// must parse as an object with a non-empty `models` record.
function checkLockfile(
  path: string,
): { ok: true } | { code: string; message: string; exit: number } {
  let raw: string;
  try {
    raw = readFile(path);
  } catch (error) {
    return {
      code: 'lockfile-unreadable',
      message: `cannot read lockfile ${JSON.stringify(path)}: ${error instanceof Error ? error.message : String(error)}`,
      exit: RUN_EXIT_WORKSPACE_UNAVAILABLE,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return {
      code: 'lockfile-invalid',
      message: `lockfile ${JSON.stringify(path)} is not valid JSON — deterministic replay needs a pinned models record`,
      exit: RUN_EXIT_USAGE,
    };
  }
  if (
    !isRecord(parsed) ||
    !isRecord(parsed.models) ||
    Object.keys(parsed.models).length === 0
  ) {
    return {
      code: 'lockfile-invalid',
      message: `lockfile ${JSON.stringify(path)} must be a JSON object with a non-empty "models" record — deterministic replay needs pinned models`,
      exit: RUN_EXIT_USAGE,
    };
  }
  return { ok: true };
}

function checkWorktreeOverride(
  path: string,
): { ok: true } | { code: string; message: string; exit: number } {
  let exists = false;
  try {
    exists = createNodeFileBridge(process.cwd()).exists(path);
  } catch {
    exists = false;
  }
  if (!exists) {
    return {
      code: 'worktree-unavailable',
      message: `worktree override ${JSON.stringify(path)} does not exist — refusing a replay against a missing worktree`,
      exit: RUN_EXIT_WORKSPACE_UNAVAILABLE,
    };
  }
  return { ok: true };
}

// Replay's §78 subset (0/1/2/5/6) as a runtime allowlist over the
// injected runner's terminus: a contract-violating runner (a run-cli
// terminus outside replay's subset, or garbage) fail-closes to exit 2 —
// never 3/4/undefined.
function replayTerminusToExitCode(terminus: unknown): number {
  switch (terminus) {
    case 'completed':
      return RUN_EXIT_OK;
    case 'failed':
      return RUN_EXIT_FAILED;
    case 'workspace_unavailable':
      return RUN_EXIT_WORKSPACE_UNAVAILABLE;
    case 'provider_probe_failed':
      return RUN_EXIT_PROVIDER_PROBE_FAILED;
    default:
      return RUN_EXIT_USAGE;
  }
}

async function executeTierRun(
  deps: ReplayCommandDeps,
  runtime: ReplayRuntimeDeps,
  options: ReplayOptions,
  params: {
    tier: 'deterministic' | 'live';
    invocation: ReplayInvocation;
    model: string;
    worktree: string;
    lockfile: string | null;
    roleConfig: string | null;
    changed: string[];
    experimental: string[];
  },
): Promise<number> {
  const rerun = await deps.run(
    {
      tier: params.tier,
      trajectory: options.trajectory,
      model: params.model,
      worktree: params.worktree,
      lockfile: params.lockfile,
      roleConfig: params.roleConfig,
    },
    runtime,
  );
  const terminus: unknown = (rerun as { terminus: unknown }).terminus;
  const status = typeof terminus === 'string' ? terminus : 'unknown';
  const exitCode = replayTerminusToExitCode(terminus);
  const envelope: ReplayEnvelope = {
    ok: exitCode === RUN_EXIT_OK,
    exitCode,
    tier: params.tier,
    invocation: params.invocation,
    trajectory: options.trajectory,
    changed: params.changed,
    result: { status, summary: rerun.summary },
    ...(params.experimental.length === 0
      ? {}
      : { experimental: params.experimental }),
  };
  if (options.json) {
    deps.out(formatJson(envelope));
    return exitCode;
  }
  if (params.experimental.length > 0) {
    options.log.warn('--worktree is experimental');
  }
  deps.out(`tier: ${params.tier}`);
  deps.out(`invocation: ${params.invocation}`);
  deps.out(`model: ${params.model}`);
  deps.out(`worktree: ${params.worktree}`);
  deps.out(`result: ${status} — ${rerun.summary}`);
  return exitCode;
}

function resolveWorktreeOverride(
  deps: ReplayCommandDeps,
  options: ReplayOptions,
  recordedPath: string,
):
  | { worktree: string; changed: string[]; experimental: string[] }
  | { exit: number } {
  if (options.worktree === undefined) {
    return { worktree: recordedPath, changed: [], experimental: [] };
  }
  const checked = checkWorktreeOverride(options.worktree);
  if ('exit' in checked) {
    fail(
      deps,
      options,
      options.trajectory,
      checked.exit,
      checked.code,
      checked.message,
    );
    return { exit: checked.exit };
  }
  return {
    worktree: options.worktree,
    changed: ['worktree'],
    experimental: ['worktree'],
  };
}

function checkRoleConfig(
  path: string,
): { ok: true } | { code: string; message: string; exit: number } {
  let raw: string;
  try {
    raw = readFile(path);
  } catch (error) {
    return {
      code: 'role-config-unreadable',
      message: `cannot read role config ${JSON.stringify(path)}: ${error instanceof Error ? error.message : String(error)}`,
      exit: RUN_EXIT_WORKSPACE_UNAVAILABLE,
    };
  }
  if (raw.trim() === '') {
    return {
      code: 'role-config-invalid',
      message: `role config ${JSON.stringify(path)} is empty — live replay needs a pinned role`,
      exit: RUN_EXIT_USAGE,
    };
  }
  return { ok: true };
}

function modelIdOf(trajectory: TrajectoryExport): string {
  return `${trajectory.model.provider}/${trajectory.model.model}`;
}

function diffFingerprint(trajectory: TrajectoryExport): string {
  return [...trajectory.diff.filesChanged].sort().join('\n');
}

// Compare invocation (§47 compare/regression): log-only diff of two
// versioned trajectories at the Recorded tier. The envelope names every
// changed var (model, worktree, diff); any difference exits 1 as the
// regression signal, identity exits 0.
function compareTrajectories(
  base: TrajectoryExport,
  other: TrajectoryExport,
): string[] {
  const changed: string[] = [];
  if (modelIdOf(other) !== modelIdOf(base)) changed.push('model');
  if (other.worktree.path !== base.worktree.path) changed.push('worktree');
  if (diffFingerprint(other) !== diffFingerprint(base)) changed.push('diff');
  return changed;
}

function loadOtherTrajectory(
  path: string,
):
  | { trajectory: TrajectoryExport }
  | { code: string; message: string; exit: number } {
  let raw: string;
  try {
    raw = readFile(path);
  } catch (error) {
    return {
      code: 'diff-against-unreadable',
      message: `cannot read --diff-against ${JSON.stringify(path)}: ${error instanceof Error ? error.message : String(error)}`,
      exit: RUN_EXIT_WORKSPACE_UNAVAILABLE,
    };
  }
  try {
    return { trajectory: parseTrajectoryExportJSON(raw) };
  } catch (error) {
    if (
      error instanceof TrajectorySchemaError &&
      error.code === 'unknown-major'
    ) {
      return {
        code: 'unknown-major',
        message: error.message,
        exit: RUN_EXIT_USAGE,
      };
    }
    return {
      code: 'diff-against-malformed',
      message: error instanceof Error ? error.message : String(error),
      exit: RUN_EXIT_USAGE,
    };
  }
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
  parsed: ReplayCommandOptions,
  deps: ReplayCommandDeps,
  // The effective config's projections (issue #114): handed straight to
  // the run seam so re-execution consumes the config like `kubic run`.
  // Absent means the documented defaults (runtimeRunDeps' own empty
  // answer) — never an invented policy.
  runtime: ReplayRuntimeDeps = { policySource: 'default' },
): Promise<number> {
  const json = parsed.json === true;
  const log = createLineLogger(deps.err, {
    theme: json ? PLAIN : (deps.errTheme ?? PLAIN),
  });
  const tier = resolveTier(parsed.tier);
  if (parsed.trajectory === undefined) {
    return fail(
      deps,
      { json, tier, log },
      null,
      RUN_EXIT_USAGE,
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
    return fail(
      deps,
      options,
      null,
      RUN_EXIT_USAGE,
      'invalid-tier',
      `invalid --tier ${JSON.stringify(options.tierRaw)} (want recorded|deterministic|live)`,
    );
  }

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
      deps.out(formatJson(envelope));
      return RUN_EXIT_OK;
    }
    for (const line of describeRecorded(trajectory)) deps.out(line);
    return RUN_EXIT_OK;
  }

  if (options.tier === 'deterministic') {
    if (options.model === undefined || options.lockfile === undefined) {
      return fail(
        deps,
        options,
        options.trajectory,
        RUN_EXIT_USAGE,
        'deterministic-needs-pins',
        'tier deterministic needs a pinned --model <provider/id> plus a --lockfile — refusing to re-execute unpinned',
      );
    }
    if (options.roleConfig !== undefined) {
      return fail(
        deps,
        options,
        options.trajectory,
        RUN_EXIT_USAGE,
        'unexpected-flag-for-tier',
        'tier deterministic takes pins from --model/--lockfile — --role-config belongs to --tier live',
      );
    }
    if (options.diffAgainst !== undefined) {
      return fail(
        deps,
        options,
        options.trajectory,
        RUN_EXIT_USAGE,
        'unexpected-flag-for-tier',
        '--diff-against compare is a recorded-tier invocation — re-execution tiers replay one trajectory',
      );
    }
    if (!isModelPin(options.model)) {
      return fail(
        deps,
        options,
        options.trajectory,
        RUN_EXIT_USAGE,
        'invalid-model-pin',
        `invalid-model-pin ${JSON.stringify(options.model)} (want 'provider/id') — deterministic replay needs an exact model pin`,
      );
    }
    const lock = checkLockfile(options.lockfile);
    if ('exit' in lock) {
      return fail(
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
      if ('exit' in resolved) return resolved.exit;
      worktree = resolved.worktree;
      changed.push(...resolved.changed);
      experimental.push(...resolved.experimental);
    }
    const invocation: ReplayInvocation =
      options.worktree !== undefined ? 'different-worktree' : 'different-model';
    return executeTierRun(deps, runtime, options, {
      tier: 'deterministic',
      invocation,
      model: options.model,
      worktree,
      lockfile: options.lockfile,
      roleConfig: null,
      changed,
      experimental,
    });
  }

  if (options.tier === 'live') {
    if (options.roleConfig === undefined) {
      return fail(
        deps,
        options,
        options.trajectory,
        RUN_EXIT_USAGE,
        'live-needs-role-config',
        'tier live needs a pinned --role-config — refusing to re-execute without the role that owns the run',
      );
    }
    if (options.model !== undefined || options.lockfile !== undefined) {
      return fail(
        deps,
        options,
        options.trajectory,
        RUN_EXIT_USAGE,
        'unexpected-flag-for-tier',
        'tier live takes pins from --role-config — --model/--lockfile belong to --tier deterministic',
      );
    }
    if (options.diffAgainst !== undefined) {
      return fail(
        deps,
        options,
        options.trajectory,
        RUN_EXIT_USAGE,
        'unexpected-flag-for-tier',
        '--diff-against compare is a recorded-tier invocation — re-execution tiers replay one trajectory',
      );
    }
    const role = checkRoleConfig(options.roleConfig);
    if ('exit' in role) {
      return fail(
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
    if ('exit' in resolved) return resolved.exit;
    return executeTierRun(deps, runtime, options, {
      tier: 'live',
      invocation:
        options.worktree !== undefined ? 'different-worktree' : 'live-exact',
      // The role config is the pin artifact: the model re-executes at the
      // trajectory's recorded model under the role's pinned config.
      model: modelIdOf(trajectory),
      worktree: resolved.worktree,
      lockfile: null,
      roleConfig: options.roleConfig,
      changed: resolved.changed,
      experimental: resolved.experimental,
    });
  }

  // Later slices: none — every tier is implemented. Compare closes the
  // four §47 invocations.
  const other = loadOtherTrajectory(options.diffAgainst as string);
  if ('exit' in other) {
    return fail(
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
  const exitCode = regression ? RUN_EXIT_FAILED : RUN_EXIT_OK;
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
    return exitCode;
  }
  deps.out('tier: recorded');
  deps.out('invocation: compare');
  deps.out(`changed: ${regression ? changed.join(', ') : 'none (identical)'}`);
  deps.out(`regression: ${regression}`);
  return exitCode;
}
