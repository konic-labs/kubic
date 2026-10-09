// The shapes of a replay: tiers, invocations, the run request the composition
// root serves, and the --json envelope.

import type { LaneCompactionOptions } from '@kubic/agent/lane/boot';
import type { PermissionClasses } from '@kubic/agent/permissions';
import type { ExitCode } from '@kubic/core/cli/exit-codes';
import type { CliLogger } from '@kubic/core/cli/logger';
import type { CliTheme } from '@kubic/core/cli/theme';
import type { JournalRetention } from '@kubic/exec/journal';
import type { ApprovalConfig } from '../approvals/index.js';
import type { EffectivePolicy } from '../policy/index.js';
import type { RoleLayerInput } from '../roles/index.js';

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

export interface ReplayOptions {
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

export interface ReplayRefusal {
  code: string;
  message: string;
  exit: ExitCode;
}
