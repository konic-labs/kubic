// The config projections `kubic tui` consumes, as the boot options and the
// command deps.
import type { LaneCompactionOptions } from '@kubic/agent/lane/boot';
import type { ModelSelection } from '@kubic/agent/model-select';
import type { PermissionClasses } from '@kubic/agent/permissions';
import { NodeExecutionEnv } from '@kubic/exec/env';
import type { JournalRetention } from '@kubic/exec/journal';
import type { ApprovalConfig, InstalledPolicy } from '@kubic/host/approvals';
import type { EffectivePolicy } from '@kubic/host/policy';
import { ProcessTerminal } from '@kubic/tui/tui-boundary';
import type { runtimeLaneDeps } from '../config/projections.js';
import { readTuiWorkspace } from '../tui-workspace.js';
import { bootTuiLane } from './boot.js';
import type { TuiBootFlags, TuiRunDeps, TuiRunOptions } from './options.js';
import type { TuiApprovalSeat } from './types.js';

// The channels `tuiDepsWithDefaults` adds to, plus every config projection;
// `tuiBootOptions` projects the pair into the boot options.
export type TuiDepsInput = {
  out: (line: string) => void;
  err?: (line: string) => void;
  // The first screen's version and the project layer's trust
  // state — invocation facts, forwarded by name below.
  version?: string;
  projectTrust?: 'loaded' | 'untrusted';
} & TuiConfigProjection;

// The config projections `kubic tui` consumes. The lane half is
// `runtimeLaneDeps`' own return type BY NAME: a key that projection gains can
// never be silently dropped here, because the forwarding table in
// tuiBootOptions must name every key of this type.
type TuiConfigProjection = {
  // Config projections: the TUI installs the same policy
  // the headless runner does. Absent means the documented safe default.
  classes?: PermissionClasses;
  policySource?: 'config' | 'default';
  approvals?: ApprovalConfig;
  policy?: InstalledPolicy;
  // Config journal retention, threaded from the same
  // runtimeRunDeps projection `kubic run` uses.
  journalRetention?: JournalRetention;
  // Config out-of-scope paths, from that same
  // projection — the interactive lane's baseline and sweep honour them too.
  reconcileOutOfScope?: string[];
  // With: the runtime model pin the config load projected
  // (cli `--model` > `KUBIC_MODEL` > `[model]`), from the SAME runtimeModelPin
  // projection `kubic run` consumes, so the interactive boot selects what the
  // headless one selects.
  model?: ModelSelection;
  // Enterprise policy: the SAME resolved EffectivePolicy
  // `kubic run` gates with (`HeadlessRunDeps.modelPolicy`). It is the only
  // Dep the run path threads — the role-grant check, the model gate and
  // the lane tool intersection all derive from it — so a projection that
  // drops it leaves every enterprise gate inert on the
  // interactive lane.
  modelPolicy?: EffectivePolicy;
  // The pin above is a frozen enterprise `[model]`, so the
  // live `/model` switch is bound by it too (see TuiRunOptions.modelPinFrozen).
  modelPinFrozen?: boolean;
  // The `[session]` compaction policy, from the same
  // projection `kubic run` consumes — the interactive lane compacts under
  // the configured policy, not the lane defaults. Absent means the own
  // defaults.
  compaction?: LaneCompactionOptions;
  // The file text the runtime read
  // at load, from the same projection `kubic run` consumes — the
  // interactive lane assembles the same prompt. Absent means the lane
  // assembles its prompt unchanged.
  systemPromptSection?: string;
  // The `[ui] theme` reference (a built-in name or a
  // JSON theme path), threaded from the same config load `kubic run`
  // consumes. Absent means the shipped brand palette.
  theme?: string;
  // The project-trust check for skills discovery,
  // threaded from the same config report `kubic run` consumes — a store
  // grant checked per ancestor on the interactive lane.
  skills?: {
    homeDir?: string;
    cwd?: string;
    trusted?: boolean;
    trustProject?: (dir: string) => boolean;
    // The config `skills` projection.
    settingsSkills?: string[];
  };
  // The same check gates the project models.json on
  // this lane's assembled catalog.
  trustProject?: (path: string) => boolean;
} & ReturnType<typeof runtimeLaneDeps>;

function definedOnly<T extends object>(
  table: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const out: { [K in keyof T]?: Exclude<T[K], undefined> } = {};
  for (const key of Object.keys(table) as Array<keyof T>) {
    const value = table[key];
    if (value !== undefined) out[key] = value as Exclude<T[keyof T], undefined>;
  }
  return out;
}

// The boot options `tuiDepsWithDefaults` hands `bootTuiLane`, projected from
// the config deps plus the parsed parity flags. Pure and exported so the prod
// wiring — including the model pin — is testable without opening a terminal.
// The forwarding table lives here: every TuiConfigProjection key must appear
// (possibly undefined), so omitting one is a compile error.
/** @internal */
export function tuiBootOptions(
  provided: TuiDepsInput,
  flags: TuiBootFlags | undefined,
  answer: TuiApprovalSeat | undefined,
): TuiRunOptions {
  const forwarded = {
    classes: provided.classes,
    approvals: provided.approvals,
    policySource: provided.policySource,
    policy: provided.policy,
    journalRetention: provided.journalRetention,
    reconcileOutOfScope: provided.reconcileOutOfScope,
    // The `[session]` compaction policy `kubic run` threads.
    compaction: provided.compaction,
    // The `[agent] systemPromptFile` text `kubic run` threads.
    systemPromptSection: provided.systemPromptSection,
    // `[agent].name` (journal and reconciliation attribution)
    // and the `[roles.<name>]` layers `--role` merges under the document.
    agentId: provided.agentId,
    roles: provided.roles,
    // The effective thinking level with its source
    // (`--thinking` > `KUBIC_MODEL_THINKING` > file layers) — the lane
    // resolves it against the session's stored level and the role default.
    thinking: provided.thinking,
    // The merged `[model]` ladder — the lane climbs
    // the role's own rungs first.
    escalate: provided.escalate,
    model: provided.model,
    // Enterprise policy: the role-grant, model and tool
    // gates of the interactive boot all read this one object.
    modelPolicy: provided.modelPolicy,
    modelPinFrozen: provided.modelPinFrozen,
    // The `[ui] theme` reference (resolved by runTuiCommand
    // before the alt-screen opens).
    theme: provided.theme,
    // The per-path trust check and the skills roots it gates.
    skills: provided.skills,
    trustProject: provided.trustProject,
  } satisfies Record<keyof TuiConfigProjection, unknown>;
  const projection = definedOnly(forwarded);
  return {
    ...projection,
    ...(answer === undefined ? {} : { answer }),
    ...(flags?.role === undefined ? {} : { role: flags.role }),
    ...(flags?.noSkills === undefined ? {} : { noSkills: flags.noSkills }),
    ...(flags?.skillsList === undefined || flags.skillsList.length === 0
      ? {}
      : { skillsList: flags.skillsList }),
    ...(flags?.dangerouslySkipApprovals === true
      ? { dangerouslySkipApprovals: true }
      : {}),
    ...(flags?.tools === undefined || flags.tools.length === 0
      ? {}
      : { toolSelection: flags.tools }),
    ...(flags?.noTools === true ? { noTools: true } : {}),
  };
}

export function tuiDepsWithDefaults(
  provided: TuiDepsInput,
  // The boot the deps drive. Absent means the prod bootTuiLane; tests pass a
  // wrapper to observe (or re-root) exactly what the projection forwards.
  boot: typeof bootTuiLane = bootTuiLane,
): TuiRunDeps {
  return {
    out: provided.out,
    ...(provided.err === undefined ? {} : { err: provided.err }),
    createTerminal: () => new ProcessTerminal(),
    // The `[ui] theme` reference, resolved by
    // runTuiCommand before the alt-screen opens (a named error and exit 2
    // when the file is missing or invalid).
    ...(provided.theme === undefined ? {} : { theme: provided.theme }),
    // The first screen's version and trust row.
    ...(provided.version === undefined ? {} : { version: provided.version }),
    ...(provided.projectTrust === undefined
      ? {}
      : { projectTrust: provided.projectTrust }),
    // The header's workspace facts and clock.
    readWorkspace: () =>
      readTuiWorkspace(
        new NodeExecutionEnv(process.cwd()).shell,
        process.cwd(),
      ),
    clock: () => new Date(),
    // The seat arrives as an argument from runTuiCommand — see TuiRunDeps.
    bootLane: (
      sessionId?: string,
      answer?: TuiApprovalSeat,
      flags?: TuiBootFlags,
    ) => boot(sessionId, tuiBootOptions(provided, flags, answer)),
  };
}
