// The inputs of `kubic tui`: the parsed command options, the parity flags
// every boot gets, the boot options the config load projects, and the
// command's deps.

import type { LaneCompactionOptions } from '@kubic/agent/lane/boot';
import type { ModelSelection } from '@kubic/agent/model-select';
import type { PermissionClasses } from '@kubic/agent/permissions';
import type { MutableModels } from '@kubic/agent/pi-boundary';
import type { StreamTuningTables } from '@kubic/agent/stream-options';
import type { NodeExecutionEnv } from '@kubic/exec/env';
import type { JournalRetention } from '@kubic/exec/journal';
import type {
  ApprovalConfig,
  ApprovalRequest,
  ApprovalVerdict,
  InstalledPolicy,
} from '@kubic/host/approvals';
import type {
  AdminHook,
  RuntimeEscalation,
  RuntimeThinking,
  SpendCaps,
} from '@kubic/host/config';
import type { RuntimeOidc } from '@kubic/host/credentials';
import type { EffectivePolicy } from '@kubic/host/policy';
import type { RoleLayerInput } from '@kubic/host/roles';
import type { DebugSink } from '@kubic/host/run';
import type { TelemetryTarget } from '@kubic/host/telemetry';
import type { ColorLevel } from '@kubic/tui/theme';
import type { TuiWorkspace } from '@kubic/tui/tui-app';
import type { Terminal } from '@kubic/tui/tui-boundary';
import type { TuiLaneBoot } from './types.js';

export interface TuiRunDeps {
  out: (line: string) => void;
  // stderr: the `error: …` lines of a refused id or a failed lane boot.
  // Absent means stdout (library callers with one channel).
  err?: (line: string) => void;
  createTerminal: () => Terminal;
  // `answer` is the seat the boot's installed policy must consult. It is an
  // ARGUMENT rather than a deps field because the seat and the rendered surface
  // are one object created by runTuiCommand: a boot that closed over the deps
  // would never see it, which is exactly the bug the end-to-end test caught
  // (the overlay never appeared, the call was refused with
  // NO_ANSWER_SURFACE_REASON). The prod boot forwards it to installPolicy;
  // a boot may ignore it (the viewer shell does).
  bootLane: (
    sessionId?: string,
    answer?: (
      request: ApprovalRequest,
      // The installed service's bound reaches the seat as an
      // AbortSignal, so the seat can withdraw the ask it is showing.
      signal?: AbortSignal,
    ) => Promise<ApprovalVerdict | undefined>,
    // The parsed parity flags travel with the boot call —
    // the command shell owns parsing, the boot owner owns the defaults.
    options?: TuiBootFlags,
  ) => Promise<TuiLaneBoot>;
  // Observes a failed journal-panel read or apply (tests; the
  // loop itself swallows it — the journal is observed, never a gate).
  journalFeedError?: (error: unknown) => void;
  // The `[policy]` spend caps the process is held to, and the sessions root
  // the day's spend is read from. Absent: no caps.
  spend?: { caps: SpendCaps; sessionsRoot?: string };
  // The bound on the quit-time drain (a turn still running when
  // the operator quits is aborted, its kills run, and the loop waits at most
  // this long for it to settle before the sweep and session close). Absent
  // means TUI_DRAIN_TIMEOUT_MS; the timer is injectable so tests are
  // deterministic. It returns a canceller.
  drainTimeoutMs?: number;
  setDrainTimer?: (ms: number, fire: () => void) => () => void;
  // The process-level event source — SIGINT/SIGTERM/SIGHUP and
  // uncaughtException/unhandledRejection. Absent means the real process;
  // tests inject an emitter so the runner itself is never signalled.
  signals?: TuiProcessEvents;
  // How a fatal error (an exception in input or render, an
  // unhandled rejection) ends the process once the terminal is restored.
  // Absent means process.exit; tests inject a recorder.
  exit?: (code: number) => void;
  // The approval overlay's arming delay and the clock it runs
  // on. Absent means APPROVAL_ARMING_MS on the real clock; tests inject 0
  // (or a manual clock) instead of sleeping.
  approvalArmingMs?: number;
  approvalClock?: () => number;
  // The colour depth. Absent means detectColorLevel over
  // process.env and stdout's TTY flag (the shipped behaviour); tests pass
  // 'none' so the shell's NO_COLOR / FORCE_COLOR never reach them.
  colorLevel?: ColorLevel;
  // The config `[ui] theme` reference — a built-in name
  // (`default`, `dark`, `light`, `terminal`) or a path to a JSON theme file, resolved
  // and validated before the alt-screen opens.
  theme?: string;
  // The keybindings file; default
  // `~/.kubic/keybindings.json`. Absent means the shipped bindings.
  keybindingsFile?: string;
  // The header's project / branch / dirty count, read after the
  // screen opens and again after every settled turn. Absent leaves the
  // header without them (injected fakes).
  readWorkspace?: () => Promise<TuiWorkspace>;
  // The header clock's time source; absent hides the clock.
  clock?: () => Date;
  // The version the first screen names, and the project
  // layer's trust state (absent: the project has no layer).
  version?: string;
  projectTrust?: 'loaded' | 'untrusted';
}

export type TuiSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP';
type TuiProcessEvent = TuiSignal | 'uncaughtException' | 'unhandledRejection';

export interface TuiProcessEvents {
  on(event: TuiProcessEvent, listener: (value: unknown) => void): unknown;
  off(event: TuiProcessEvent, listener: (value: unknown) => void): unknown;
}

// The `kubic tui` parity flags: same names and semantics as
// the `kubic run` counterparts.
export interface TuiBootFlags {
  role?: string;
  noSkills?: boolean;
  skillsList?: string[];
  // `--dangerously-skip-approvals` for the booted session.
  dangerouslySkipApprovals?: boolean;
  // `--tools <a,b>` / `--no-tools`.
  tools?: string[];
  noTools?: boolean;
  // `--model` is deliberately NOT a boot flag: dispatch
  // pre-scans it from the raw argv into the ONE config load as the `cli`
  // layer, so `TuiConfigProjection.model` already carries cli > env > file
  // precedence and the enterprise freeze. A flag patched over that
  // projection afterwards would bypass the freeze `kubic run` honours.
}

export interface TuiRunOptions {
  sessionsRoot?: string;
  env?: NodeExecutionEnv;
  // Config-sourced permission classes: the TUI is a
  // config-consuming command, so it takes the same projection `kubic run`
  // does. Absent means the documented DEFAULT_PERMISSIONS.
  classes?: PermissionClasses;
  // `--tools <a,b>` / `--no-tools` —
  // intersected with the classes/role/enterprise sets, never widening.
  toolSelection?: string[];
  noTools?: boolean;
  // The config layer's own record of where the classes came from
  // ('default' when nothing configured them). Absent means 'default'.
  policySource?: 'config' | 'default';
  // The debug sink for the boot's session/role lines
  // (threaded to the runner for its fault and token lines). A test seam:
  // prod `kubic tui` passes none (`tui` has no --debug flag yet), so the
  // lines are dropped there — the fault notice still renders (it does not
  // need the sink).
  debug?: DebugSink;
  // The config `[approvals]` policy — the same projection
  // `kubic run` installs. Absent means the documented defaults.
  approvals?: ApprovalConfig;
  // The installed-policy seat: the same derivation the headless
  // runner installs. Absent means the shipped default (classes above +
  // destructive/network/confine guards + the approval ask); tests inject a
  // variant. `kubic tui` drives the same lane, so it takes the same policy.
  policy?: InstalledPolicy;
  // Model registry injection: the same seam `runHeadlessPrompt`
  // takes as `models`, so the reconciliation tests can boot the REAL path
  // hermetically with faux models. Absent means the assembled prod catalog.
  models?: MutableModels;
  // The answer seat: the interactive path's approval surface.
  // Attached by runTuiCommand; absent means the no-surface refusal.
  answer?: (
    request: ApprovalRequest,
    signal?: AbortSignal,
  ) => Promise<ApprovalVerdict | undefined>;
  // Skills discovery, `--role`
  // documents, and journal retention reach the interactive lane exactly
  // as they reach the headless one — same options, same semantics.
  skills?: {
    homeDir?: string;
    cwd?: string;
    trusted?: boolean;
    trustProject?: (dir: string) => boolean;
    // The config `skills` projection — resolved at
    // load, loaded with source 'settings'. Absent means none configured.
    settingsSkills?: string[];
  };
  noSkills?: boolean;
  skillsList?: string[];
  role?: string;
  roles?: {
    cwd?: string;
    layers?: RoleLayerInput[];
    // Project trust for the repo documents —
    // same projection as `kubic run`. Absent both means untrusted.
    trusted?: boolean;
    trustProject?: (dir: string) => boolean;
    // The home directory whose `.kubic/roles` layer
    // under the project documents — same projection as `kubic run`.
    // Absent means no global source.
    homeDir?: string;
  };
  journalRetention?: JournalRetention;
  // [agent] systemPromptFile contents: the same projection
  // `kubic run` threads, so the interactive lane assembles the same
  // prompt. Absent means the lane assembles its prompt unchanged.
  systemPromptSection?: string;
  // `[agent] projectInstructions = false`, as `kubic run` reads it.
  projectInstructions?: boolean;
  // The project models.json refusal, as `kubic run` reads it.
  projectProvidersRefusal?: string;
  // `[cost] team`, as `kubic run` records it.
  sessionTeam?: string;
  // The `[[hooks]]`, as `kubic run` runs them; a settled turn is a run end.
  hooks?: readonly AdminHook[];
  // `[providers.<id>] region` and `[model] fallback`, as `kubic run` reads
  // them (the fallback applies when the boot's model is unavailable).
  providerRegions?: Readonly<Record<string, string>>;
  modelFallback?: readonly string[];
  // `[oidc]`, as `kubic run` reads it.
  oidc?: RuntimeOidc;
  // `[telemetry]`: where each settled turn's spans and metrics go.
  telemetry?: TelemetryTarget;
  // The `[session]` compaction policy — the same
  // projection `kubic run` threads, so the interactive lane compacts under
  // config, not the lane defaults. Absent means the own defaults.
  compaction?: LaneCompactionOptions;
  // Out-of-scope paths: the same projection `kubic run`
  // threads, so a declared directory is excluded from this lane's
  // baseline and sweep too. Absent means the mechanism's own skips only.
  reconcileOutOfScope?: string[];
  // The per-path trust check (the store's
  // resolved-root decision plus the env opt-in), from the composition
  // root's config load — gates the project models.json and the ancestor
  // project skills on the interactive lane exactly as `kubic run` gates
  // them. Absent falls back to the env.
  trustProject?: (path: string) => boolean;
  // The lane's agent id: the configured `[agent].name`, from
  // the SAME runtimeLaneDeps projection `kubic run` consumes. Absent means
  // 'root' — the shipped attribution, unchanged.
  agentId?: string;
  // Enable full access for the booted session through
  // the one host enable path before the policy is installed.
  dangerouslySkipApprovals?: boolean;
  // With: the runtime pin the config load projected
  // (cli `--model` > `KUBIC_MODEL` > `[model]`), from the SAME runtimeModelPin
  // seam `kubic run` consumes. It beats the role layer's model, which beats
  // first-available; an explicit pin selects the model and makes a resumed
  // session switch, absent means the default pick.
  model?: ModelSelection;
  // Request options: the merged `[model]` tuning plus
  // every `[roles.<name>]` table that sets a key (runtimeStreamTuning) —
  // the same projection `kubic run` consumes. The boot resolves them
  // against `--role` into `settings.stream`. Absent means untuned.
  streamTuning?: StreamTuningTables;
  // Enterprise policy: the same EffectivePolicy the
  // headless runner gates with — the interactive lane is not the
  // unprotected one.
  modelPolicy?: EffectivePolicy;
  // The runtime pin above is a frozen enterprise `[model]`
  // — the session override (`/model`, the same level as `--model`)
  // cannot leave it, exactly as the flag cannot.
  modelPinFrozen?: boolean;
  // Thinking level: the effective level with its source
  // (`--thinking` > `KUBIC_MODEL_THINKING` > file layers), from the SAME
  // `RuntimeThinking` projection `kubic run` consumes. The boot resolves it
  // against the session's stored level and the role default and clamps it
  // to the effective model — a clamp is never silent.
  thinking?: RuntimeThinking;
  // The merged `[model]` ladder, from the same
  // projection. The boot climbs the role's own rungs first
  // (`resolveLaneLadder`); absent means escalation is unconfigured.
  escalate?: RuntimeEscalation;
  // The `[ui] theme` reference. Not a lane option — it
  // travels on the boot options object because that is the one projection
  // `tuiBootOptions` builds, and `runTuiCommand` reads it from the deps
  // before the alt-screen opens.
  theme?: string;
}

// The parsed `kubic tui` invocation (commander owns the argv:
// ./commands/session.ts). The parity flags carry the same names
// and value rules as their `kubic run` counterparts.
export interface TuiCommandOptions {
  readonly session?: string;
  readonly role?: string;
  readonly skills?: readonly string[];
  readonly noSkills?: boolean;
  // Session-scoped full access (bare `kubic` and `tui`).
  readonly dangerouslySkipApprovals?: boolean;
  // `--model <provider/id>`, parsed by the registrar for help and
  // validation only — dispatch already fed it to the config load as the `cli`
  // layer, so the boot reads it from the projected pin, never from here.
  readonly model?: ModelSelection;
  // `--tools <a,b>` narrows the booted
  // lane's tool set; `--no-tools` is the empty set. Mutually exclusive.
  readonly tools?: readonly string[];
  readonly noTools?: boolean;
}
