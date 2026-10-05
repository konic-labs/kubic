// Composition-root config wiring (issue #90): `main.ts` calls
// `loadCliConfig(...)` once and hands the result to the commands that need
// it. Everything else lives in the host package — this file only maps the
// process's real environment, cwd and trust posture onto `loadRuntimeConfig`
// and exposes the small seams the CLI consumes:
//
//   kubicConfigLoader(result)   → `kubic config` (human + --json view)
//   doctorPolicyLoader(result)  → `kubic doctor`'s policy check
//   runtimeModelPin(result)     → provider/model selection for `kubic run`
//
// Every seam fails closed on a refused config: they throw (or return
// undefined) with the named reason rather than falling back to a default,
// because a silent default is how a config file stops configuring anything.
//
// File access goes through the exec FileBridge (I/O confinement): this
// module never imports node:fs.

import { homedir } from 'node:os';
import type { PermissionClasses } from '../../../packages/agents/src/policy.js';
import { createNodeFileBridge } from '../../../packages/exec/src/file-bridge.js';
import type { JournalRetention } from '../../../packages/exec/src/journal.js';
import {
  gitSync,
  hasGitignoreMetacharacters,
  hasUnsafeCharacters,
  RUNTIME_EXCLUDE_ENTRIES,
} from '../../../packages/exec/src/runtime-exclude.js';
import type { SoloApprovalConfig } from '../../../packages/host/src/approvals.js';
import {
  CONFIG_LAYERS,
  ConfigError,
  checkCommittedConfigHalfRoot,
  checkOrchestratorRootNoOp,
  checkOrchestratorRootShape,
} from '../../../packages/host/src/config/config.js';
import {
  buildConfigDoctorInput,
  configDoctorProbe,
} from '../../../packages/host/src/config/config-doctor.js';
import {
  checkWorkspaceIgnoreSplit,
  effectiveConfigView,
  loadRuntimeConfig,
  type RuntimeConfig,
  type RuntimeVerify,
} from '../../../packages/host/src/config/runtime.js';
import {
  NO_PROJECT_TRUST,
  type ProjectTrustCheck,
  type ProjectTrustReport,
  ProjectTrustStore,
  projectTrustCheck,
  projectTrustReport,
  projectTrustStorePath,
} from '../../../packages/host/src/config/trust-store.js';
import type { DepProbe } from '../../../packages/host/src/doctor.js';
import type { ApprovalSnapshot } from '../../../packages/host/src/orchestrator/merge/conflicts.js';
import { DEFAULT_WORKTREE_ROOT } from '../../../packages/host/src/orchestrator/worktree/naming.js';
import {
  type EffectivePolicy,
  hasModelPolicy,
  isModelAllowed,
  isProviderAllowed,
} from '../../../packages/host/src/policy/enterprise.js';
import { findProjectRoot } from '../../../packages/host/src/project-root.js';
import type {
  RoleLayerInput,
  RoleLayerSpec,
} from '../../../packages/host/src/roles/resolver.js';
import {
  ModelSelectError,
  type ModelSelection,
  selectModel,
} from '../../../packages/worker/src/model-select.js';
import type { MutableModels } from '../../../packages/worker/src/pi-boundary.js';
import { selectionOrigin, withSelectionOrigin } from './model-projection.js';

export interface CliConfigResult {
  // Present only when the load succeeded. A refusal leaves it undefined:
  // callers never run on invented values.
  runtime: RuntimeConfig | undefined;
  // Named reason the config was refused (unknown/unsupported key, a
  // distrusted project layer, a budget key, a secret ref in config).
  error: string | undefined;
  // The repo's committed-vs-ignored split (§35/D35), reported by
  // `kubic config` and by doctor: the five runtime prefixes must be ignored
  // and config.toml + roles/*.md must stay committable.
  ignoreSplit: { missing: string[]; checked: string[]; applicable: boolean };
  // Issue #229 (§35.1): the project root every consumer resolves from —
  // the nearest ancestor holding `.kubic/` (or the git top level), the cwd
  // itself outside a repository. The trust report, the project layer and
  // the ignore-split check below are all keyed to it, so a run from a
  // subdirectory honours the same committed project as one from the root.
  // Falls back to the cwd when the home cannot hold the store (the load is
  // refused there anyway).
  // Optional so hand-built fixtures (tests pinning a runtime without a
  // load) keep compiling: `loadCliConfig` always sets it, and consumers
  // fall back to their own cwd when it is absent.
  projectRoot?: string;
  // Issue #228: the project trust state the load above was gated on — the
  // same report `kubic doctor` renders, `kubic config` counts and the TUI
  // prompt resolves, so they can never disagree about who accepted what.
  // Keyed to the project root (issue #229): a grant for the root covers
  // runs from its subdirectories, exactly like the models and skills roots.
  trust: ProjectTrustReport;
}

export interface CliConfigOptions {
  cwd?: string;
  home?: string;
  env?: Record<string, string | undefined>;
  projectTrusted?: boolean;
  /**
   * The `--model` session override (issue #227; §38.1): the `cli` layer of
   * the ONE runtime load, above `env` and the file layers. A frozen
   * enterprise `model.provider`/`model.id` still wins — `loadRuntimeConfig`
   * owns that rule, so the flag is an input to the load, never a post-load
   * mutation that could bypass the freeze.
   */
  model?: ModelSelection;
}

// The §35/§91 runtime exclude entries for a worktree parent (issue #133):
// the shipped five prefixes, plus the configured `[orchestrator].root` when
// it names a parent other than the default. An untracked worktree directory
// would make the pre-merge clean-tree guard refuse every merge, so the
// configured root is shipped to the repo's exclude file exactly like
// `.kubic/wt/` is. One derivation, every consumer (dispatch's run/orchestrate/
// tui write, and orchestrate's own startup write) — the list cannot drift.
export function runtimeExcludeEntriesFor(
  worktreeRoot: string | undefined,
): readonly string[] {
  if (worktreeRoot === undefined || worktreeRoot === DEFAULT_WORKTREE_ROOT) {
    return RUNTIME_EXCLUDE_ENTRIES;
  }
  // Path shape re-checked at the derivation too (issue #133 fix-cycle-3): the
  // config load refuses these first, but a programmatic caller that bypassed
  // it must not hand the writer an empty or escaping value — same rule, same
  // named refusal.
  checkOrchestratorRootShape(worktreeRoot, 'orchestrator');
  // The derived entry is anchored to the repository root (issue #133
  // fix-cycle-3): a pattern whose only slash is trailing (`worktrees/`) is
  // NOT anchored — git matches it at any depth, hiding `deep/worktrees/…`
  // and `src/worktrees/…` from `git add -A` and the pre-merge clean-tree
  // guard. The leading slash makes the entry relative to the repository
  // root, so exactly the named directory (and everything under it) matches.
  // The shipped five entries already carry a middle slash, so git anchors
  // them as they are — they stay byte-identical.
  const entry = `/${worktreeRoot}/`;
  // Defense in depth (issue #133 review): the config load refuses control
  // characters in the root by name (checkOrchestratorRoot). If a hostile
  // value ever reached this seam, the derivation refuses to hand the entry
  // to the writer — no entry with control characters can be written to
  // `.git/info/exclude`, where a newline would inject gitignore lines.
  // The ROOT is what ships (the entry only wraps it in slashes), so the rule
  // reads the root: a `#`-leading root stays refused here even though the
  // anchored entry no longer sits at the start of the gitignore line.
  if (hasUnsafeCharacters(worktreeRoot)) {
    throw new ConfigError(
      "'orchestrator': 'root' must not contain control characters — the value is shipped to git's exclude file verbatim",
    );
  }
  // Same rule for the gitignore metacharacters (issue #133 re-review): git
  // reads the entry as a pattern, so `*`/`?`/`[`/`]` would hide paths other
  // than the named directory (from `git add -A` and the pre-merge
  // clean-tree guard), a leading `#` would comment the line out, and a
  // backslash would escape the next character. Refused, never escaped into
  // a different rule.
  if (hasGitignoreMetacharacters(worktreeRoot)) {
    throw new ConfigError(
      "'orchestrator': 'root' must not contain gitignore metacharacters — the value is shipped to git's exclude file verbatim",
    );
  }
  // D35 re-checked at the derivation too (issue #133 re-review): the entry
  // must never ignore the committed half (`.kubic/config.toml`,
  // `.kubic/roles/*.md`), even when a programmatic caller bypassed the
  // config load. Same rule, same message as checkOrchestratorRoot's — the
  // compare is case-insensitive, like git's own pattern folding on a
  // case-insensitive filesystem (issue #133 fix-cycle-3).
  checkCommittedConfigHalfRoot(worktreeRoot, 'orchestrator');
  // No-op roots re-checked here as well (issue #133 fix-cycle-3): a `.`
  // segment means the derived entry would match nothing, leaving the
  // worktree set unignored. Same rule, same message as the load's.
  checkOrchestratorRootNoOp(worktreeRoot, 'orchestrator');
  return [...RUNTIME_EXCLUDE_ENTRIES, entry];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// One load for the whole process: paths per §35.1, the project layer behind
// the trust gate, the documented env overrides above the file layers.
//
// Trust (issue #228) is resolved from the persistent store under
// `~/.kubic/trust.json` for this cwd, with the env opt-in still honoured
// above it and an explicit caller decision (the accepted TUI prompt) above
// both. The same report reaches the result so every consumer — doctor, the
// models assembly, the skills loader — reads one derivation.
export function loadCliConfig(options: CliConfigOptions = {}): CliConfigResult {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const bridge = createNodeFileBridge(cwd);
  // Issue #229: resolve the project root before anything is keyed — the
  // trust report, the project layer and the ignore-split check all read
  // the same root, so a subdirectory run honours the committed project.
  const projectRoot = findProjectRoot(bridge, cwd, home);
  // Issue #292: the checker resolves the toplevel and the exclude the way
  // the writer does (`git rev-parse`), so linked worktrees (whose `.git`
  // is a file) and subdirectories check the right files. The sync probe
  // lives in exec behind the §9 I/O seam; a missing git binary just makes
  // the check inapplicable.
  const ignoreSplit = checkWorkspaceIgnoreSplit(bridge, projectRoot, gitSync);
  let stored: ProjectTrustReport;
  try {
    stored = projectTrustReport({ home, cwd: projectRoot, env });
  } catch (error) {
    // A home that cannot hold the store (empty or relative) is a named
    // refusal, not a crash: the trust boundary cannot be established, so no
    // project-local file may load.
    return {
      runtime: undefined,
      error: message(error),
      ignoreSplit,
      projectRoot: cwd,
      trust: NO_PROJECT_TRUST,
    };
  }
  const trusted = options.projectTrusted === true || stored.trusted;
  const trust = trusted === stored.trusted ? stored : { ...stored, trusted };
  try {
    const runtime = loadRuntimeConfig({
      bridge,
      home,
      cwd,
      projectRoot,
      env,
      ...(options.model === undefined ? {} : { cli: { model: options.model } }),
      projectTrusted: trusted,
    });
    return { runtime, error: undefined, ignoreSplit, projectRoot, trust };
  } catch (error) {
    return {
      runtime: undefined,
      error: message(error),
      ignoreSplit,
      projectRoot,
      trust,
    };
  }
}

// Issue #228 review: the per-path trust check for consumers that resolve
// the file they load by walking ancestors (the project models.json root,
// each skills ancestor). Built from the same report the config load
// consumed, so the store/env decision can never disagree with the config
// gate. An unusable home yields an env-only check (fail closed).
export function projectTrustFor(result: CliConfigResult): ProjectTrustCheck {
  return projectTrustCheck({
    home: result.trust.home,
    envTrust: result.trust.envTrust,
  });
}

// The interactive half of the trust gate (issue #228): `kubic tui` and the
// bare `kubic` on a TTY ask once about a present, undecided project config
// before the config load, persist the answer and hand it back — so the
// current invocation boots on the accepted decision and the next one never
// asks again. No question is asked when the config is absent or a decision
// is already recorded (including a recorded decline: the operator answered).
// A cancelled prompt is not an answer: nothing is persisted, and the
// invocation fails closed into the refusal path.
export interface InteractiveTrustDeps {
  home?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  // The question channel: production passes core's `promptConfirm` bound to
  // `interactive: true`; a test passes a collector. `null` means cancelled.
  confirm: (message: string) => Promise<boolean | null>;
  store?: ProjectTrustStore;
}

export async function resolveInteractiveProjectTrust(
  deps: InteractiveTrustDeps,
): Promise<boolean | undefined> {
  const home = deps.home ?? homedir();
  const cwd = deps.cwd ?? process.cwd();
  const store =
    deps.store ?? new ProjectTrustStore(projectTrustStorePath(home));
  // Issue #229: ask about (and record) the project root, not the
  // subdirectory — the config load keys its trust report there, so a grant
  // recorded here is one the loader honours from any cwd under the root.
  const root = findProjectRoot(createNodeFileBridge(cwd), cwd, home);
  const report = projectTrustReport({
    home,
    cwd: root,
    env: deps.env ?? process.env,
    store,
  });
  if (!report.present) return undefined;
  if (report.trusted) return true;
  // A recorded decline is an answer: the refusal stands silently, and the
  // remedies are named by the refusal itself.
  if (report.decision === false) return false;
  // The grant is one decision for the whole project tree, so the question
  // names all of it (issue #228 review): the config.toml, the project
  // models.json — whose provider URL receives the key of ANY `*_API_KEY` or
  // `KUBIC_*` variable it names (`KUBIC_API_KEY` when it names none), so a
  // "yes" lets the repository choose where a key you have set is sent — and
  // the project skills the model is told to follow.
  const answer = await deps.confirm(
    `Trust project ${report.key}? This lets the project's own files take effect for runs here: ${report.configPath} (sets the model, approvals, permissions and journal retention), its models.json (provider URLs, sent the key of any *_API_KEY or KUBIC_* variable it names — KUBIC_API_KEY by default) and its project skills (instructions the model follows).`,
  );
  if (answer === null) return false;
  store.set(root, answer);
  return answer;
}

// The config the rest of the process runs on; a refusal throws with its
// named reason instead of returning defaults.
export function requireRuntimeConfig(result: CliConfigResult): RuntimeConfig {
  if (result.runtime === undefined) {
    throw new Error(result.error ?? 'config refused');
  }
  return result.runtime;
}

// Commands whose whole job is to tell the operator about the effective
// configuration (or about a refusal) must still run when the load was
// refused — otherwise the named reason has nowhere to surface. `trust`
// (issue #228) is the repair path for a refusal: it must run in exactly the
// repository whose project layer is refused, or the durable grant could
// never be recorded.
const CONFIG_REPORTING_COMMANDS = new Set(['config', 'doctor', 'trust']);

// The modes that execute an agent under the configuration. They may not
// proceed on defaults once the load was refused: silently running on
// built-in values while the user believes their .kubic/config.toml is in
// force is precisely the defect issue #90 exists to fix (§35.1 fail-closed).
// `replay` joins them (issue #114): its re-execution tiers run the agent
// under the effective config exactly like `kubic run`, so a refused config
// must stop them the same way.
// Exported so the dispatch gate-membership test pins it: a command whose
// runner reads `result.runtime` must be listed here (issue #242). `clean`
// reads the orchestrator root, `policy` reports the posture a run would
// enforce, `attach`/`resume` boot the same lane as `tui`, and
// `eval`/`benchmark` run agent lanes under the same projections — all fail
// closed on a refused config instead of proceeding on built-in defaults.
// The reporting commands (`config`, `doctor`, `trust`) must still run so
// the named reason can surface; sessions/journal read only
// `session.retentionDays` (undefined-safe: no invented window).
export const CONFIG_CONSUMING_COMMANDS: ReadonlySet<string> = new Set([
  'run',
  'orchestrate',
  'tui',
  'attach',
  'resume',
  'replay',
  'clean',
  'policy',
  'eval',
  'benchmark',
]);

// Exit code for a refused config on the given command, or undefined when the
// command may proceed. Kept beside the load so the policy lives in one place:
// the caller prints `result.error` and returns this code (1 = `failed`, the
// same code doctor uses for a config-shaped failure).
export function configRefusalExit(
  result: CliConfigResult,
  command: string | undefined,
): number | undefined {
  if (result.runtime !== undefined) return undefined;
  if (command === undefined) return undefined;
  if (CONFIG_REPORTING_COMMANDS.has(command)) return undefined;
  return CONFIG_CONSUMING_COMMANDS.has(command) ? 1 : undefined;
}

// `kubic config` loader: the command renders exactly what this returns.
export function kubicConfigLoader(
  result: CliConfigResult,
): () => RuntimeConfig {
  return () => requireRuntimeConfig(result);
}

// `kubic doctor` policy source: the config-sourced approval policy. A
// refused config throws here, which doctor renders as a failing
// `policy:approvals (policy-mismatch)` check naming the reason — the
// operator sees a broken key, never a green run on ignored config.
export function doctorPolicyLoader(result: CliConfigResult): () => unknown {
  return () => requireRuntimeConfig(result).approvals.policy;
}

// Provider/model selection for `kubic run`: the configured pin when one is
// set, otherwise undefined (first-registered provider, the existing
// behaviour). Validated against the live catalog by the lane's own
// selectModel, which fails the run by name on an unknown provider/model.
export function runtimeModelPin(
  result: CliConfigResult,
): ModelSelection | undefined {
  const runtime = result.runtime;
  const selection = runtime?.model;
  if (runtime === undefined || selection === undefined) return undefined;
  // The pin carries the input it came from (issue #295), so a refusal of an
  // unknown model says `KUBIC_MODEL`/`--model`/the config layer — not `--model`
  // for every explicit selection.
  return withSelectionOrigin(
    { provider: selection.provider, id: selection.id },
    modelPinOrigin(runtime),
  );
}

// The label the named model refusal shows for the runtime pin: the flag, the
// env variable, or the config layer whose `[model]` carried it.
function modelPinOrigin(runtime: RuntimeConfig): string {
  switch (runtime.modelSource) {
    case 'cli':
      return '--model';
    case 'env':
      return 'KUBIC_MODEL';
    default:
      return `[model] in ${runtime.modelSource} config`;
  }
}

// Whether a frozen enterprise `[model]` is the effective pin (issue #295;
// §35.1): every cli/env pin is dropped, in this process and in every worker
// child it starts — so the consumers that reason about which model runs
// (the worker credential preflight, the orchestrate child env, the TUI
// `/model` switch) follow the pin, never a raw KUBIC_MODEL.
export function runtimeModelFrozen(result: CliConfigResult): boolean {
  return result.runtime?.modelSource === 'enterprise';
}

// One stderr line per cli/env model pin a frozen enterprise `[model]`
// overrode (issue #295; §35.1) — the composition root prints them once at the
// boot of run/tui/orchestrate, so `kubic run --model x` against an enterprise
// pin says it ran the pin instead of dropping `x` silently. Empty when
// nothing was overridden (no freeze, no cli/env pin, or the same pin).
export function runtimeModelPinNotes(result: CliConfigResult): string[] {
  return (result.runtime?.modelPinOverrides ?? []).map((entry) => {
    const input =
      entry.source === 'cli'
        ? `--model ${entry.requested}`
        : `KUBIC_MODEL=${entry.requested}`;
    return `note: ${input} ignored: model pinned by enterprise policy (${entry.pinned})`;
  });
}

// §58 enterprise policy (issue #288): the EffectivePolicy resolved once at
// load — `kubic run` and `kubic tui` gate role grants, model selection and
// the lane tool set with it. Undefined when the config was refused: the
// agent-executing commands fail closed on their own before this matters, and
// an absent [policy] section leaves the object empty (hasModelPolicy /
// hasToolPolicy decide whether any gate applies).
export function runtimePolicy(
  result: CliConfigResult,
): EffectivePolicy | undefined {
  return result.runtime?.policy;
}

// selectModel words every explicit pin `(--model)` and every config default
// `(config default)`; when the selection carries its real origin (issue #295;
// model-projection's withSelectionOrigin) the suffix names that instead. Only
// the pick that was actually attempted can have failed: an explicit pin is
// tried first and alone.
function relabelRefusal(
  error: ModelSelectError,
  explicit: ModelSelection | undefined,
  configDefault: ModelSelection | undefined,
): ModelSelectError {
  const attempted =
    explicit !== undefined
      ? { selection: explicit, wording: '--model' }
      : configDefault !== undefined
        ? { selection: configDefault, wording: 'config default' }
        : undefined;
  if (attempted === undefined) return error;
  const origin = selectionOrigin(attempted.selection);
  const suffix = ` (${attempted.wording})`;
  if (origin === undefined || !error.message.endsWith(suffix)) return error;
  return new ModelSelectError(
    `${error.message.slice(0, -suffix.length)} (${origin})`,
  );
}

// The named refusal both solo entry points share (issue #288): one text, so
// the headless terminus and the TUI's exit-6 report cannot drift apart.
function modelPolicyRefusal(provider: string, id: string): string {
  return `model '${provider}/${id}' refused by enterprise policy (allowed_models/allowed_providers): no provider call was made`;
}

// Model selection under the §58 enterprise gate (issue #288), shared by
// `kubic run` and `kubic tui`: an explicit/role/config selection outside
// `allowed_models`/`allowed_providers` is refused with a named
// ModelSelectError BEFORE the registry is probed or any provider is called,
// and the implicit fallback pick only considers allowed providers. With no
// model policy configured this is exactly `selectModel` — the selection
// behaviour is byte-identical to before.
export function selectModelUnderPolicy(
  models: MutableModels,
  explicit: ModelSelection | undefined,
  configDefault: ModelSelection | undefined,
  fallbackProviders: readonly string[] | undefined,
  policy: EffectivePolicy | undefined,
): ReturnType<typeof selectModel> {
  const gate =
    policy !== undefined && hasModelPolicy(policy) ? policy : undefined;
  if (gate !== undefined) {
    for (const selection of [explicit, configDefault]) {
      if (
        selection !== undefined &&
        !isModelAllowed(gate, selection.provider, selection.id)
      ) {
        throw new ModelSelectError(
          modelPolicyRefusal(selection.provider, selection.id),
        );
      }
    }
  }
  const candidates =
    gate === undefined
      ? fallbackProviders
      : (
          fallbackProviders ??
          models.getProviders().map((provider) => provider.id)
        ).filter((provider) => isProviderAllowed(gate, provider));
  let picked: ReturnType<typeof selectModel>;
  try {
    picked = selectModel(models, explicit, configDefault, candidates);
  } catch (error) {
    throw error instanceof ModelSelectError
      ? relabelRefusal(error, explicit, configDefault)
      : error;
  }
  if (gate !== undefined && !isModelAllowed(gate, picked.provider, picked.id)) {
    throw new ModelSelectError(modelPolicyRefusal(picked.provider, picked.id));
  }
  return picked;
}

// The config `[approvals]` policy as the solo install consumes it (issue
// #230; §41.2): route, maxPendingMs, autoApprove, requireJustification and
// sessionScoped, projected ONCE here and spread into installSoloPolicy by
// `kubic run`, `kubic tui`, replay and doctor's installed-policy line — so
// what doctor prints and what every solo lane enforces are one derivation
// (§40.3). A refused config contributes nothing (the command fails closed
// first); absent means the documented defaults.
export function runtimeApprovalDeps(
  result: CliConfigResult,
): SoloApprovalConfig {
  const policy = result.runtime?.approvals.policy;
  if (policy === undefined) return {};
  return {
    route: policy.route,
    maxPendingMs: policy.maxPendingMs,
    autoApprove: [...policy.autoApprove],
    requireJustification: policy.requireJustification,
    sessionScoped: policy.sessionScoped,
  };
}

// The remaining `kubic run` projections (issue #90): the permission classes
// the lane derives its tool allowlist from (§40) and the journal retention
// bound enforced on every append (§42.4). A refused config contributes
// nothing here — the run itself fails closed before this matters.
export function runtimeRunDeps(result: CliConfigResult): {
  policyClasses?: PermissionClasses;
  journalRetention?: JournalRetention;
  // Issue #115 (§35/§42.5): the declared out-of-scope paths, threaded to the
  // run/TUI lane's reconciliation. Undefined when config declares none — the
  // walk still skips `.git/`, `.kubic/` and `.gitignore` hits on its own.
  reconcileOutOfScope?: string[];
  // Issue #86: where the classes came from, per the config layer's own
  // record. Threaded to the run path so the posture the lane installs and
  // the posture `doctor` prints carry the SAME source (§40.3) — a config
  // that sets only, say, `[journal]` still runs the documented defaults and
  // must not be reported as operator-configured classes.
  policySource: 'config' | 'default';
  // Issue #230: the config `[approvals]` policy the lane installs.
  approvals?: SoloApprovalConfig;
  // Issue #267 (§48): the `[verify]` gate commands the run executes in its
  // worktree after it settles. Undefined when none is configured — every
  // gate then stays unknown.
  verify?: RuntimeVerify;
} {
  const runtime = result.runtime;
  if (runtime === undefined) return { policySource: 'default' };
  const verifying = Object.keys(runtime.verify.commands).length > 0;
  return {
    ...(verifying
      ? {
          verify: {
            commands: { ...runtime.verify.commands },
            ...(runtime.verify.timeoutMs === undefined
              ? {}
              : { timeoutMs: runtime.verify.timeoutMs }),
          },
        }
      : {}),
    approvals: runtimeApprovalDeps(result),
    policyClasses: { ...runtime.permissions.classes },
    policySource:
      runtime.permissions.source === 'defaults' ? 'default' : 'config',
    journalRetention:
      runtime.journal.maxAgeMs === undefined &&
      runtime.journal.maxBytes === undefined
        ? {}
        : {
            ...(runtime.journal.maxAgeMs === undefined
              ? {}
              : { maxAgeMs: runtime.journal.maxAgeMs }),
            ...(runtime.journal.maxBytes === undefined
              ? {}
              : { maxBytes: runtime.journal.maxBytes }),
          },
    ...(runtime.journal.outOfScope === undefined
      ? {}
      : { reconcileOutOfScope: [...runtime.journal.outOfScope] }),
  };
}

// The shared solo-lane projections (issue #133): the agent id the lane and
// its journal attribution carry, and the config-sourced role layers the
// `--role` resolution merges under the role document. ONE projection with
// two one-line consumers — `kubic run` (headless-run.ts) and `kubic tui`
// (tui-run.ts) — so both entry points name the lane and layer the roles
// identically. Absent means the shipped behaviour: agent id 'root', no
// layers.
export function runtimeLaneDeps(result: CliConfigResult): {
  agentId?: string;
  roles?: { layers: RoleLayerInput[]; trustProject: ProjectTrustCheck };
} {
  const runtime = result.runtime;
  if (runtime === undefined) return {};
  const agentId = runtime.config.agent?.name;
  const layers = roleLayersFromConfig(runtime);
  // Issue #430 (§33, L-D27): the repo role documents resolve under the
  // same per-path trust check as the project models.json and skills — so
  // `kubic run --role` and `kubic tui --role` load an untrusted root's
  // documents never. The check folds the KUBIC_TRUST_PROJECT opt-in in.
  const trustProject = projectTrustFor(result);
  return {
    ...(agentId === undefined ? {} : { agentId }),
    // Always present (even with no layers): the trust check travels on
    // `roles` so callers never default to an untrusted load.
    roles: { layers, trustProject },
  };
}

// The settings `skills` projection (issue #237, §29.2): the merged
// top-level `skills` array, entries already resolved against their
// declaring file's directory at load. Project-layer entries apply only
// when the project root is trusted — the load refuses an untrusted
// project file before reading, so a project-sourced list reaching here
// is trusted by construction; the check is re-applied all the same, so a
// hand-built runtime (tests, embeddings) never sneaks one past. Always
// returns the key (possibly empty) so callers spread unconditionally.
export function runtimeSkillsDeps(result: CliConfigResult): {
  settingsSkills: string[];
} {
  const runtime = result.runtime;
  const skills = runtime?.config.skills ?? [];
  if (skills.length === 0) return { settingsSkills: [] };
  if (runtime?.sources.skills === 'project') {
    const root = result.projectRoot;
    if (root === undefined || !projectTrustFor(result)(root)) {
      return { settingsSkills: [] };
    }
  }
  return { settingsSkills: [...skills] };
}

// The config `[roles.<name>]` table as resolver layer inputs (issue #133):
// one input per config layer that actually set a leaf, so the resolver's
// first-layer-wins merge sees exactly the provenance the config load
// recorded — `roles.implementer.model` from the project layer never
// masquerades as an enterprise value. The layer order is CONFIG_LAYERS'.
export function roleLayersFromConfig(runtime: RuntimeConfig): RoleLayerInput[] {
  const roles = runtime.config.roles;
  if (roles === undefined) return [];
  const layers: RoleLayerInput[] = [];
  for (const layer of CONFIG_LAYERS) {
    const specs: Record<string, RoleLayerSpec> = {};
    for (const [name, entry] of Object.entries(roles)) {
      const spec: RoleLayerSpec = {};
      if (
        entry.tools !== undefined &&
        runtime.sources[`roles.${name}.tools`] === layer
      ) {
        spec.tools = [...entry.tools];
      }
      if (
        entry.model !== undefined &&
        runtime.sources[`roles.${name}.model`] === layer
      ) {
        spec.model = entry.model;
      }
      if (Object.keys(spec).length > 0) specs[name] = spec;
    }
    if (Object.keys(specs).length > 0) layers.push({ layer, roles: specs });
  }
  return layers;
}

// `kubic sessions prune`'s default keep-window (issue #119): the parsed
// `session.retentionDays` leaf — undefined when config sets none (or the
// load was refused), so prune demands an explicit --keep-days instead of
// inventing a window (§35.1 fail-closed; deletion stays explicit). 0 is a
// real value here: it means retention off, and prune reports it as such.
export function sessionRetentionDays(
  result: CliConfigResult,
): number | undefined {
  return result.runtime?.config.session?.retentionDays;
}

// The manager lane's approval snapshot for the orchestrator path (issue #106,
// §45.2), over the SAME config load every other consumer uses: a delegated
// conflict resolver is spawned under exactly this policy, so the `route`,
// `autoApprove` and `maxPendingMs` here must be the ones in force — never a
// second default invented at the spawn site. `sessionScoped` and
// `requireJustification` are lane-local concerns (§41) and are not part of the
// snapshot the resolver carries.
export function approvalSnapshotFrom(runtime: RuntimeConfig): ApprovalSnapshot {
  const policy = runtime.approvals.policy;
  return {
    route: policy.route,
    autoApprove: [...policy.autoApprove],
    maxPendingMs: policy.maxPendingMs,
  };
}

// Installed-policy projection (issue #86): what `doctor` reports and what the
// `run`/`tui` installs read, over the SAME config load the run path uses.
//
// `source` is the honesty switch, taken from the config layer's own record
// (runtime.permissions.source) rather than from the shape of the object: a
// config-less install yields SOLO_DEFAULTS through validateClasses, so
// "classes are present" does NOT mean "the operator configured them". Only a
// real layer (file/env/cli) makes it 'config'.
export function installedPolicyDeps(result: CliConfigResult): {
  classes?: PermissionClasses;
  source: 'config' | 'default';
} & SoloApprovalConfig {
  const { policyClasses, policySource } = runtimeRunDeps(result);
  return {
    ...(policySource === 'config' && policyClasses !== undefined
      ? { classes: policyClasses }
      : {}),
    source: policySource,
    // Issue #230: the approval half of the same projection, so doctor's
    // `policy:installed` line and the lane read one derivation.
    ...runtimeApprovalDeps(result),
  };
}

// The projection `doctor` and the `tui` path read, over the SAME config load
// `kubic run` uses. Absent config → absent classes → installSoloPolicy's
// documented SOLO_DEFAULTS, which is exactly what a config-less run installs,
// so doctor's line and the lane's posture are the same object (§40.3).
export function installedPolicyClasses(result: CliConfigResult): {
  classes?: PermissionClasses;
} {
  const { classes } = installedPolicyDeps(result);
  return classes === undefined ? {} : { classes };
}

// `kubic doctor` config probe: the same load the rest of the process uses,
// projected onto doctor's dependency-probe shape (doctor.ts is not this
// issue's file and has no generic section hook, so the check rides the
// `checkDeps` channel and renders in both the human and --json output).
export function doctorConfigProbe(result: CliConfigResult): DepProbe {
  const { missing, applicable } = result.ignoreSplit;
  if (result.runtime === undefined) {
    return configDoctorProbe(
      buildConfigDoctorInput({
        error: result.error ?? 'config refused',
        ignoreSplitMissing: missing,
        ignoreSplitApplicable: applicable,
        projectTrust: result.trust,
      }),
    );
  }
  const view = effectiveConfigView(result.runtime);
  return configDoctorProbe(
    buildConfigDoctorInput({
      values: view.values,
      projectTrusted: view.projectTrusted,
      budgetsConfigured: view.budgets.configured,
      ignoreSplitMissing: missing,
      ignoreSplitApplicable: applicable,
      projectTrust: result.trust,
    }),
  );
}
