// The inputs of `kubic run -p`: the parsed command options and the
// composition root's deps (the loaded configuration's projections plus the
// seams tests inject).
import type { LaneCompactionOptions } from '@kubic/agent/lane/boot';
import type { ModelSelection } from '@kubic/agent/model-select';
import type { PermissionClasses } from '@kubic/agent/permissions';
import type { Context, MutableModels } from '@kubic/agent/pi-boundary';
import type { StreamTuningTables } from '@kubic/agent/stream-options';
import type { ExecutionEnv } from '@kubic/exec/env';
import type { JournalRetention } from '@kubic/exec/journal';
import type { ApprovalConfig, InstalledPolicy } from '@kubic/host/approvals';
import type {
  RuntimeThinking,
  RuntimeVerify,
  SpendCaps,
} from '@kubic/host/config';
import type { EffectivePolicy } from '@kubic/host/policy';
import type { RoleLayerInput } from '@kubic/host/roles';
import type { DebugSink, RunProgressSink } from '@kubic/host/run';

export interface HeadlessRunOptions {
  sessionId?: string;
  timeoutMs?: number;
  maxTurns?: number;
  // Skills surface: `--no-skills` disables layered
  // discovery and `--skill <path>` adds one explicitly (repeatable —
  // explicit intent applies even under --no-skills).
  noSkills?: boolean;
  skills?: string[];
  // `--invoke-skill <name>` — one explicit skill
  // (hidden included) whose content runs as the turn prompt, with the
  // run's prompt as instructions. Unknown names fail the run closed.
  invokeSkill?: string;
  // Role selection: `--role <name>` boots the lane as
  // the role document `.kubic/roles/<name>.md` defines — its prompt text
  // replaces the constant and its resolved tool set becomes the
  // lane's allowlist. Absent means the default, unchanged.
  role?: string;
  // Debug channel: when set, the run emits its lane/tool
  // debug lines to the injected sink (stderr in prod). The span artifact is
  // written either way — spans are the durable half.
  debug?: boolean;
  // `--dangerously-skip-approvals` — full access for the
  // session this run creates or resumes, recorded in its posture.json and
  // the audit ledger, never in config.
  dangerouslySkipApprovals?: boolean;
  // `--tools <a,b>` narrows the run's tool
  // set (intersected with the classes/role/enterprise sets — never widened);
  // `--no-tools` is the empty set. Mutually exclusive, validated before the
  // lane boots.
  tools?: readonly string[];
  noTools?: boolean;
  // Explicit autonomous mode, recorded on the run's
  // session. Absent means off (interactive), never assumed.
  autonomous?: boolean;
  // Live progress on an interactive terminal (heading, compact
  // no-isolation notice, one line per tool call). Absent: the full stderr
  // warning block and no progress output.
  progress?: RunProgressSink;
}

export interface HeadlessRunDeps {
  sessionsRoot?: string;
  models?: MutableModels;
  model?: ModelSelection;
  // Request options: the merged `[model]` tuning plus
  // every `[roles.<name>]` table that sets a key (runtimeStreamTuning).
  // The boot resolves them against the run's role into `settings.stream`.
  // Absent means untuned — the provider defaults stand.
  streamTuning?: StreamTuningTables;
  // The lane's agent id: the configured `[agent].name`, threaded
  // from runtimeLaneDeps. Absent means 'root' — the shipped behaviour, byte
  // for byte (journal attribution follows it).
  agentId?: string;
  env?: ExecutionEnv;
  context?: Context;
  /** Diagnostics sink (reconcile and overlap notices, skill-load reports). */
  debug?: (line: string) => void;
  // Runtime config projections: the permission classes and the
  // journal retention bound the loaded configuration produced. Absent means
  // the lane's own defaults and an unbounded journal (never an invented
  // limit).
  policyClasses?: PermissionClasses;
  // The config layer's own record of where the classes came from
  // ('default' when nothing configured them). Absent means 'default' — the
  // documented safe default, never an assumed operator choice.
  policySource?: 'config' | 'default';
  // The config `[approvals]` policy (route, maxPendingMs,
  // autoApprove, requireJustification, sessionScoped). Absent means the
  // documented defaults.
  approvals?: ApprovalConfig;
  // Enterprise policy: the composition root resolves it
  // once (`runtimePolicy` in config/model-selection.ts) and threads it here. A run only
  // gates its tool set and model selection when the layer actually
  // configured those halves — an absent [policy] section never narrows
  // anything.
  modelPolicy?: EffectivePolicy;
  journalRetention?: JournalRetention;
  // Gate commands, from `[verify]` via runtimeRunDeps. Run
  // in the worktree after the run settles; their verdicts become the
  // trajectory's `signal:*` labels. Absent means nothing is verified.
  verify?: RuntimeVerify;
  // Thinking level, from `runtimeLaneDeps` via
  // prodRunDeps: the effective level with its source. A per-run source
  // (`cli` `--thinking` / `env` `KUBIC_MODEL_THINKING`, enterprise-frozen
  // included) is the lane's override; a file-layer source is the lane's
  // config default. Absent means the lane boots at the session's stored
  // level, a role default, or Pi's 'off'.
  thinking?: RuntimeThinking;
  // The installed-policy seat. Absent means the shipped
  // DEFAULT: the documented DEFAULT_PERMISSIONS classes plus the destructive/
  // network/confine guards and the approval ask, all derived by
  // installPolicy. Tests inject a variant here; nothing else may skip
  // the install, which is why the default is not an opt-in.
  policy?: InstalledPolicy;
  // Declared out-of-scope paths for the baseline.
  // Populated by `[journal] outOfScope` through runtimeRunDeps;
  // absent means the mechanism's own skips only — `.git/`, `.kubic/` and
  // `.gitignore` hits.
  reconcileOutOfScope?: string[];
  // [agent] systemPromptFile contents, from the same config
  // load — the boot composes them ahead of the skills block. Absent means
  // the lane assembles its prompt unchanged.
  systemPromptSection?: string;
  // `[agent] projectInstructions = false` turns the AGENTS.md search off.
  // Absent means on.
  projectInstructions?: boolean;
  // Why the project models.json stays out of the catalog (an enterprise
  // `[policy] project_policy = "restricted"`). Absent: it loads once trusted.
  projectProvidersRefusal?: string;
  // The `[policy]` spend caps the run is held to. Absent: none.
  spend?: SpendCaps;
  // `[cost] team`: recorded on the session this run creates.
  sessionTeam?: string;
  // The `[session]` compaction policy from the same
  // config load — the boot hands it to the settings. Absent means the
  // lane defaults (automatic, the default reserve, the default recent
  // window).
  compaction?: LaneCompactionOptions;
  // Debug sink for the debug lines. Defaults to stderr so a live
  // `kubic run --debug` emits without the composition root wiring anything;
  // tests inject an array collector instead.
  debugSink?: DebugSink;
  // Operator notices: the line naming what happened to a
  // pending operation a crashed run left open. Defaults to stderr; tests
  // inject a collector.
  notice?: (line: string) => void;
  // Skills inputs. Absent means the prod defaults: the
  // real home directory, this process's cwd, and the documented trust
  // opt-in (`KUBIC_TRUST_PROJECT`, the same switch the config layer reads).
  // Tests inject a home/cwd/trust triple to drive discovery over a fixture.
  skills?: {
    homeDir?: string;
    cwd?: string;
    trusted?: boolean;
    trustProject?: (dir: string) => boolean;
    // The config `skills` projection — resolved at
    // load, loaded with source 'settings'. Absent means none configured.
    settingsSkills?: string[];
  };
  // The per-path trust check (the store's resolved-root
  // decision plus the env opt-in), threaded from the composition root's
  // config load. It gates the project models.json and the ancestor project
  // skills on the path each resolves to. Absent falls back to the env flag.
  trustProject?: (path: string) => boolean;
  // Role-document inputs. Absent means the prod defaults:
  // this process's cwd (so `.kubic/roles/*.md` is read from the workspace)
  // through the real FileBridge. Tests inject a fixture cwd.
  roles?: {
    cwd?: string;
    layers?: RoleLayerInput[];
    // Project trust for the repo documents.
    // The composition root threads the config load's per-path check here
    // (`runtimeLaneDeps`); absent both means the root is untrusted.
    trusted?: boolean;
    trustProject?: (dir: string) => boolean;
    // The home directory whose `.kubic/roles` layer
    // under the project documents. Absent means no global source — the
    // composition root passes the real home; tests inject a fixture.
    homeDir?: string;
  };
  // Interrupt source (Ctrl-C, a supervisor SIGTERM, a closed terminal SIGHUP). Absent means the
  // real process. Tool children run in detached process groups, so a
  // terminal SIGINT never reaches them: without this seam the run died on
  // the default handler and orphaned them, skipping the drain, the sweep and
  // the session close. Tests inject an emitter.
  signals?: SignalSource;
  // Where models.json is read from (tests); absent means process.cwd().
  modelsCwd?: string;
  // User-facing warnings that must show without --debug (a refused
  // models.json). Absent means stderr — stdout stays consumable.
  warn?: (line: string) => void;
}

// Where interrupts come from: the process in prod, an emitter in tests.
export interface SignalSource {
  on(event: InterruptSignal, listener: (signal: string) => void): unknown;
  off(event: InterruptSignal, listener: (signal: string) => void): unknown;
}

export type InterruptSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP';
