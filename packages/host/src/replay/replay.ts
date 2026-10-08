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

import { createHash } from 'node:crypto';
import type { LaneCompactionOptions } from '../../../agent/src/lane/boot.js';
import type { PermissionClasses } from '../../../agent/src/permissions.js';
import {
  type CommandResult,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_PROVIDER,
  EXIT_USAGE,
  EXIT_WORKSPACE,
  type ExitCode,
} from '../../../core/src/cli/exit-codes.js';
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
import type { ApprovalConfig } from '../approvals.js';
import type { EffectivePolicy } from '../policy/enterprise.js';
import type { RoleLayerInput } from '../roles/resolver.js';

type ReplayTier = 'recorded' | 'deterministic' | 'live';

type ReplayInvocation =
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
  // The role name the live tier's --role-config resolves to
  // (`{"role": "<name>"}`); the re-execution loads
  // `.kubic/roles/<name>.md` from the pinned worktree, so the role's tools
  // and prompt are applied instead of being a checked-then-ignored pin.
  // null on the deterministic tier (its pins are --model/--lockfile).
  role: string | null;
}

export interface ReplayRunResult {
  terminus: ReplayRunTerminus;
  summary: string;
}

// Runtime config projections: the SAME surface `kubic run`
// threads into its lane (runtimeRunDeps) — the permission classes plus
// their source record and the journal retention bound.
// Absent fields mean the documented defaults, exactly as on the run path;
// the composition root passes the effective config's projections so a
// replay re-execution is governed by the config, not by the binary's
// defaults.
export interface ReplayRuntimeDeps {
  policyClasses?: PermissionClasses;
  policySource: 'config' | 'default';
  journalRetention?: JournalRetention;
  // The config `[approvals]` policy, as `kubic run` installs it.
  approvals?: ApprovalConfig;
  // Enterprise policy: the same resolved EffectivePolicy
  // `kubic run` gates with — the model/provider gate, the role-grant check and
  // the lane tool intersection all derive from it inside the headless runner
  // the re-execution drives, so a live replay is not an ungated lane.
  modelPolicy?: EffectivePolicy;
  // The per-path trust check (store resolved-root +
  // env), from the same config load the re-execution tier runs under — it
  // gates the project models.json of the assembled catalog. Absent falls
  // back to the env opt-in inside assembleModels.
  trustProject?: (path: string) => boolean;
  // The shared lane projections `kubic run` threads
  // — the configured agent id, the config-sourced role layers the pinned
  // role merges under its document, and the declared out-of-scope paths.
  // Absent means the documented run defaults ('root', no layers, the
  // mechanism's own skips).
  agentId?: string;
  // The per-path trust check `kubic run`
  // threads on the same projection — the pinned worktree's role document
  // loads only for a trusted root. Absent means untrusted.
  roles?: { layers: RoleLayerInput[]; trustProject?: (dir: string) => boolean };
  reconcileOutOfScope?: string[];
  // The `[session]` compaction policy, from the same
  // projection `kubic run` threads — the live re-execution tiers compact
  // under the configured policy, not the lane defaults. Absent means the
  // lane defaults.
  compaction?: LaneCompactionOptions;
  // [agent] systemPromptFile contents, from the same
  // projection `kubic run` threads — the re-executed tiers assemble the
  // same prompt. Absent means the lane assembles its prompt unchanged.
  systemPromptSection?: string;
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

interface ReplayError {
  code: string;
  message: string;
}

export interface ReplayEnvelope {
  ok: boolean;
  exitCode: ExitCode;
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

// Every result publishes a tier: the declared --tier when one was
// given (unknown when it names no known tier), else the recorded default.
function resolveTier(raw: string | undefined): ReplayTier | 'unknown' {
  if (raw === undefined) return 'recorded';
  return parseTier(raw) ?? 'unknown';
}

const PLAIN = createCliTheme('none');

// The refused-config envelope: the same failure shape the tiered
// envelope uses, with no invocation to report, so a `--json` consumer still
// parses exactly one document. The reason is the config refusal's own.
export function refusedReplayEnvelope(message: string): ReplayEnvelope {
  return {
    ok: false,
    exitCode: EXIT_FAILED,
    tier: 'unknown',
    invocation: null,
    trajectory: null,
    changed: [],
    error: { code: 'config_refused', message },
  };
}

function fail(
  deps: ReplayCommandDeps,
  options: { json: boolean; tier: ReplayTier | 'unknown'; log: CliLogger },
  trajectory: string | null,
  exitCode: ExitCode,
  code: string,
  message: string,
): ExitCode {
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
  | { code: string; message: string; exit: ExitCode } {
  let raw: string;
  try {
    raw = readFile(path);
  } catch (error) {
    return {
      code: 'trajectory-unreadable',
      message: `cannot read trajectory ${JSON.stringify(path)}: ${error instanceof Error ? error.message : String(error)}`,
      exit: EXIT_WORKSPACE,
    };
  }
  try {
    return { trajectory: parseTrajectoryExportJSON(raw) };
  } catch (error) {
    if (
      error instanceof TrajectorySchemaError &&
      error.code === 'unknown-major'
    ) {
      // Replay's subset (0/1/2/5/6) has no schema slot (exit 3 stays
      // inside the trajectory package): an unsupported major is a caller
      // usage error here, with the code preserved machine-readably.
      return {
        code: 'unknown-major',
        message: error.message,
        exit: EXIT_USAGE,
      };
    }
    return {
      code: 'trajectory-malformed',
      message: error instanceof Error ? error.message : String(error),
      exit: EXIT_USAGE,
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

// Pin artifact for the Deterministic tier: a JSON file pinning the
// exact model the re-execution may use, plus optional prompt/tool digests.
// Fail-closed: the requested --model must be pinned, and a pinned digest
// must match what is about to be re-executed — the pins were
// required and then ignored before this.
//
// Format:
//   { "models": { "provider/id": {...} | "provider": ["id", ...] },
//     "prompt": { "digest": "sha256:<hex>" }?,   // the re-run prompt text
//     "tools":  { "digest": "sha256:<hex>" }? }  // sorted distinct tools
function sha256Digest(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function isPinnedModel(models: Record<string, unknown>, pin: string): boolean {
  if (pin in models) return true;
  const slash = pin.indexOf('/');
  const provider = pin.slice(0, slash);
  const id = pin.slice(slash + 1);
  const entry = models[provider];
  if (Array.isArray(entry)) return entry.includes(id);
  // A provider keyed to a record of its pinned ids.
  if (isRecord(entry)) return id in entry;
  return false;
}

function recordedToolsDigest(trajectory: TrajectoryExport): string {
  const tools = [...new Set(trajectory.actions.map((action) => action.tool))]
    .sort()
    .join('\n');
  return sha256Digest(tools);
}

interface ReplayRefusal {
  code: string;
  message: string;
  exit: ExitCode;
}

function checkDigestPin(
  parsed: Record<string, unknown>,
  path: string,
  key: 'prompt' | 'tools',
  actual: string,
): ReplayRefusal | null {
  const entry = parsed[key];
  if (entry === undefined) return null;
  if (!isRecord(entry) || typeof entry.digest !== 'string') {
    return {
      code: 'lockfile-invalid',
      message: `lockfile ${JSON.stringify(path)} ${key} pin must be an object with a "digest" string`,
      exit: EXIT_USAGE,
    };
  }
  if (entry.digest !== actual) {
    return {
      code: 'lockfile-mismatch',
      message: `lockfile ${JSON.stringify(path)} ${key} pin ${entry.digest} does not match the recorded ${key} (${actual}) — refusing a deterministic replay whose ${key} differs from its pin`,
      exit: EXIT_USAGE,
    };
  }
  return null;
}

function checkLockfile(
  path: string,
  model: string,
  trajectory: TrajectoryExport,
): { ok: true } | ReplayRefusal {
  let raw: string;
  try {
    raw = readFile(path);
  } catch (error) {
    return {
      code: 'lockfile-unreadable',
      message: `cannot read lockfile ${JSON.stringify(path)}: ${error instanceof Error ? error.message : String(error)}`,
      exit: EXIT_WORKSPACE,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return {
      code: 'lockfile-invalid',
      message: `lockfile ${JSON.stringify(path)} is not valid JSON — deterministic replay needs a pinned models record`,
      exit: EXIT_USAGE,
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
      exit: EXIT_USAGE,
    };
  }
  if (!isPinnedModel(parsed.models, model)) {
    return {
      code: 'lockfile-mismatch',
      message: `lockfile ${JSON.stringify(path)} does not pin model ${JSON.stringify(model)} — refusing a deterministic replay at an unpinned model`,
      exit: EXIT_USAGE,
    };
  }
  const promptPin = checkDigestPin(
    parsed,
    path,
    'prompt',
    sha256Digest(trajectory.task.objective),
  );
  if (promptPin !== null) return promptPin;
  const toolsPin = checkDigestPin(
    parsed,
    path,
    'tools',
    recordedToolsDigest(trajectory),
  );
  if (toolsPin !== null) return toolsPin;
  return { ok: true };
}

function checkWorktreeOverride(
  path: string,
): { ok: true } | { code: string; message: string; exit: ExitCode } {
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
      exit: EXIT_WORKSPACE,
    };
  }
  return { ok: true };
}

// Replay's subset (0/1/2/5/6) as a runtime allowlist over the
// injected runner's terminus: a contract-violating runner (a run-cli
// terminus outside replay's subset, or garbage) fail-closes to exit 2 —
// never 3/4/undefined.
function replayTerminusToExitCode(terminus: unknown): ExitCode {
  switch (terminus) {
    case 'completed':
      return EXIT_OK;
    case 'failed':
      return EXIT_FAILED;
    case 'workspace_unavailable':
      return EXIT_WORKSPACE;
    case 'provider_probe_failed':
      return EXIT_PROVIDER;
    default:
      return EXIT_USAGE;
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
    role: string | null;
    changed: string[];
    experimental: string[];
  },
): Promise<ExitCode> {
  const rerun = await deps.run(
    {
      tier: params.tier,
      trajectory: options.trajectory,
      model: params.model,
      worktree: params.worktree,
      lockfile: params.lockfile,
      roleConfig: params.roleConfig,
      role: params.role,
    },
    runtime,
  );
  const terminus: unknown = (rerun as { terminus: unknown }).terminus;
  const status = typeof terminus === 'string' ? terminus : 'unknown';
  const exitCode = replayTerminusToExitCode(terminus);
  const envelope: ReplayEnvelope = {
    ok: exitCode === EXIT_OK,
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
  | { exit: ExitCode } {
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

// The live tier's pin artifact: a JSON file naming the role
// the re-execution boots as — `{"role": "<name>"}`. The name is resolved
// from `.kubic/roles/<name>.md` in the pinned worktree, so the role's
// tools and prompt actually apply. Fail-closed: a role config that names
// no role is refused here (exit 2), never checked-then-ignored.
function checkRoleConfig(
  path: string,
): { ok: true; role: string } | ReplayRefusal {
  let raw: string;
  try {
    raw = readFile(path);
  } catch (error) {
    return {
      code: 'role-config-unreadable',
      message: `cannot read role config ${JSON.stringify(path)}: ${error instanceof Error ? error.message : String(error)}`,
      exit: EXIT_WORKSPACE,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return {
      code: 'role-config-invalid',
      message: `role config ${JSON.stringify(path)} is not valid JSON — live replay needs {"role": "<name>"}`,
      exit: EXIT_USAGE,
    };
  }
  const role = isRecord(parsed) ? parsed.role : undefined;
  if (typeof role !== 'string' || role.trim() === '') {
    return {
      code: 'role-config-invalid',
      message: `role config ${JSON.stringify(path)} must be a JSON object with a non-empty "role" name — live replay needs the pinned role`,
      exit: EXIT_USAGE,
    };
  }
  return { ok: true, role: role.trim() };
}

function modelIdOf(trajectory: TrajectoryExport): string {
  return `${trajectory.model.provider}/${trajectory.model.model}`;
}

function diffFingerprint(trajectory: TrajectoryExport): string {
  return [...trajectory.diff.filesChanged].sort().join('\n');
}

// Compare invocation (compare/regression): log-only diff of two
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
  | { code: string; message: string; exit: ExitCode } {
  let raw: string;
  try {
    raw = readFile(path);
  } catch (error) {
    return {
      code: 'diff-against-unreadable',
      message: `cannot read --diff-against ${JSON.stringify(path)}: ${error instanceof Error ? error.message : String(error)}`,
      exit: EXIT_WORKSPACE,
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
        exit: EXIT_USAGE,
      };
    }
    return {
      code: 'diff-against-malformed',
      message: error instanceof Error ? error.message : String(error),
      exit: EXIT_USAGE,
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
    return {
      exitCode: fail(
        deps,
        { json, tier, log },
        null,
        EXIT_USAGE,
        'missing-trajectory',
        'missing required argument <trajectory.json>',
      ),
    };
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
    return {
      exitCode: fail(
        deps,
        options,
        null,
        EXIT_USAGE,
        'invalid-tier',
        `invalid --tier ${JSON.stringify(options.tierRaw)} (want recorded|deterministic|live)`,
      ),
    };
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
      return {
        exitCode: fail(
          deps,
          options,
          options.trajectory,
          EXIT_USAGE,
          'recorded-takes-trajectory-alone',
          `tier recorded replays the trajectory alone — remove ${extras.join(', ')} or declare --tier deterministic|live`,
        ),
      };
    }
  }

  const loaded = loadTrajectory(options.trajectory);
  if ('exit' in loaded) {
    return {
      exitCode: fail(
        deps,
        options,
        options.trajectory,
        loaded.exit,
        loaded.code,
        loaded.message,
      ),
    };
  }
  const trajectory = loaded.trajectory;

  if (options.tier === 'recorded' && options.diffAgainst === undefined) {
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

  if (options.tier === 'deterministic') {
    if (options.model === undefined || options.lockfile === undefined) {
      return {
        exitCode: fail(
          deps,
          options,
          options.trajectory,
          EXIT_USAGE,
          'deterministic-needs-pins',
          'tier deterministic needs a pinned --model <provider/id> plus a --lockfile — refusing to re-execute unpinned',
        ),
      };
    }
    if (options.roleConfig !== undefined) {
      return {
        exitCode: fail(
          deps,
          options,
          options.trajectory,
          EXIT_USAGE,
          'unexpected-flag-for-tier',
          'tier deterministic takes pins from --model/--lockfile — --role-config belongs to --tier live',
        ),
      };
    }
    if (options.diffAgainst !== undefined) {
      return {
        exitCode: fail(
          deps,
          options,
          options.trajectory,
          EXIT_USAGE,
          'unexpected-flag-for-tier',
          '--diff-against compare is a recorded-tier invocation — re-execution tiers replay one trajectory',
        ),
      };
    }
    if (!isModelPin(options.model)) {
      return {
        exitCode: fail(
          deps,
          options,
          options.trajectory,
          EXIT_USAGE,
          'invalid-model-pin',
          `invalid-model-pin ${JSON.stringify(options.model)} (want 'provider/id') — deterministic replay needs an exact model pin`,
        ),
      };
    }
    const lock = checkLockfile(options.lockfile, options.model, trajectory);
    if ('exit' in lock) {
      return {
        exitCode: fail(
          deps,
          options,
          options.trajectory,
          lock.exit,
          lock.code,
          lock.message,
        ),
      };
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

  if (options.tier === 'live') {
    if (options.roleConfig === undefined) {
      return {
        exitCode: fail(
          deps,
          options,
          options.trajectory,
          EXIT_USAGE,
          'live-needs-role-config',
          'tier live needs a pinned --role-config — refusing to re-execute without the role that owns the run',
        ),
      };
    }
    if (options.model !== undefined || options.lockfile !== undefined) {
      return {
        exitCode: fail(
          deps,
          options,
          options.trajectory,
          EXIT_USAGE,
          'unexpected-flag-for-tier',
          'tier live takes pins from --role-config — --model/--lockfile belong to --tier deterministic',
        ),
      };
    }
    if (options.diffAgainst !== undefined) {
      return {
        exitCode: fail(
          deps,
          options,
          options.trajectory,
          EXIT_USAGE,
          'unexpected-flag-for-tier',
          '--diff-against compare is a recorded-tier invocation — re-execution tiers replay one trajectory',
        ),
      };
    }
    const role = checkRoleConfig(options.roleConfig);
    if ('exit' in role) {
      return {
        exitCode: fail(
          deps,
          options,
          options.trajectory,
          role.exit,
          role.code,
          role.message,
        ),
      };
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

  // Every tier is implemented. Compare closes the
  // four invocations.
  const other = loadOtherTrajectory(options.diffAgainst as string);
  if ('exit' in other) {
    return {
      exitCode: fail(
        deps,
        options,
        options.trajectory,
        other.exit,
        other.code,
        other.message,
      ),
    };
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
