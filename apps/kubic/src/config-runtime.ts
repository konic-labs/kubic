// Composition-root config wiring: `main.ts` calls
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
import { gitSync } from '../../../packages/exec/src/runtime-exclude.js';
import type { SoloApprovalConfig } from '../../../packages/host/src/approvals.js';
import type { RoleModelEntry } from '../../../packages/host/src/config/config.js';
import {
  CONFIG_LAYERS,
  checkModelStreamTuning,
} from '../../../packages/host/src/config/config.js';
import {
  buildConfigDoctorInput,
  configDoctorProbe,
} from '../../../packages/host/src/config/config-doctor.js';
import type { RuntimeEscalation } from '../../../packages/host/src/config/runtime.js';
import {
  checkWorkspaceIgnoreSplit,
  compactionSummaryLine,
  effectiveConfigView,
  loadRuntimeConfig,
  type RuntimeConfig,
  type RuntimeThinking,
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
  roleModelAllowed,
  roleModelEntry,
} from '../../../packages/host/src/roles/resolver.js';
import type { SoloCompactionOptions } from '../../../packages/worker/src/lane/solo.js';
import {
  ModelSelectError,
  type ModelSelection,
  selectModel,
} from '../../../packages/worker/src/model-select.js';
import type { MutableModels } from '../../../packages/worker/src/pi-boundary.js';
import type {
  ModelStreamTuning,
  StreamTuningTables,
} from '../../../packages/worker/src/stream-options.js';
import { selectionOrigin, withSelectionOrigin } from './model-projection.js';

export interface CliConfigResult {
  // Present only when the load succeeded. A refusal leaves it undefined:
  // callers never run on invented values.
  runtime: RuntimeConfig | undefined;
  // Named reason the config was refused (unknown/unsupported key, a
  // distrusted project layer, a secret ref in config).
  error: string | undefined;
  // The repo's committed-vs-ignored split, reported by
  // `kubic config` and by doctor: the five runtime prefixes must be ignored
  // and config.toml + roles/*.md must stay committable.
  ignoreSplit: { missing: string[]; checked: string[]; applicable: boolean };
  // The project root every consumer resolves from —
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
  // The project trust state the load above was gated on — the
  // same report `kubic doctor` renders, `kubic config` counts and the TUI
  // prompt resolves, so they can never disagree about who accepted what.
  // Keyed to the project root: a grant for the root covers
  // runs from its subdirectories, exactly like the models and skills roots.
  trust: ProjectTrustReport;
}

export interface CliConfigOptions {
  cwd?: string;
  home?: string;
  env?: Record<string, string | undefined>;
  projectTrusted?: boolean;
  /**
   * The `--model` session override: the `cli` layer of
   * the ONE runtime load, above `env` and the file layers. A frozen
   * enterprise `model.provider`/`model.id` still wins — `loadRuntimeConfig`
   * owns that rule, so the flag is an input to the load, never a post-load
   * mutation that could bypass the freeze.
   */
  model?: ModelSelection;
  /**
   * The `--thinking` session override: the `cli` layer
   * of the same ONE load, above `KUBIC_MODEL_THINKING` and the file
   * layers. Same freeze rule as `--model` — an input to the load, never a
   * post-load patch.
   */
  thinking?: string;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// One load for the whole process: paths, the project layer behind
// the trust gate, the documented env overrides above the file layers.
//
// Trust is resolved from the persistent store under
// `~/.kubic/trust.json` for this cwd, with the env opt-in still honoured
// above it and an explicit caller decision (the accepted TUI prompt) above
// both. The same report reaches the result so every consumer — doctor, the
// models assembly, the skills loader — reads one derivation.
export function loadCliConfig(options: CliConfigOptions = {}): CliConfigResult {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const bridge = createNodeFileBridge(cwd);
  // Resolve the project root before anything is keyed — the
  // trust report, the project layer and the ignore-split check all read
  // the same root, so a subdirectory run honours the committed project.
  const projectRoot = findProjectRoot(bridge, cwd, home);
  // The checker resolves the toplevel and the exclude the way
  // the writer does (`git rev-parse`), so linked worktrees (whose `.git`
  // is a file) and subdirectories check the right files. The sync probe
  // lives in exec behind the I/O seam; a missing git binary just makes
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
    const cli =
      options.model === undefined && options.thinking === undefined
        ? undefined
        : {
            ...(options.model === undefined ? {} : { model: options.model }),
            ...(options.thinking === undefined
              ? {}
              : { thinking: options.thinking }),
          };
    const runtime = loadRuntimeConfig({
      bridge,
      home,
      cwd,
      projectRoot,
      env,
      ...(cli === undefined ? {} : { cli }),
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

// The per-path trust check for consumers that resolve
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

// The interactive half of the trust gate: `kubic tui` and the
// bare `kubic` on a TTY ask once about a present, undecided project config
// before the config load, persist the answer and hand it back — so the
// current invocation boots on the accepted decision and the next one never
// asks again. No question is asked when the config is absent or a decision
// is already recorded (including a recorded decline: the operator answered).
// A cancelled prompt is not an answer: nothing is persisted, and the
// invocation fails closed into the refusal path.
// The restyled question's answers.
export type TrustAnswer = 'yes' | 'not-now' | 'view';

export interface TrustQuestion {
  /** The canonical project root the decision is keyed to. */
  readonly root: string;
  readonly configPath: string;
  /** The full disclosure on one line (what `confirm` asks). */
  readonly message: string;
}

export interface InteractiveTrustDeps {
  home?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  // The question channel: production passes core's `promptConfirm` bound to
  // `interactive: true`; a test passes a collector. `null` means cancelled.
  confirm?: (message: string) => Promise<boolean | null>;
  // The restyled one-key question — `y` yes, `n` not now, `v`
  // view the file (`show` prints it, then it asks again). Present, it is
  // asked instead of `confirm`.
  ask?: (question: TrustQuestion) => Promise<TrustAnswer | null>;
  show?: (path: string) => void;
  store?: ProjectTrustStore;
}

export async function resolveInteractiveProjectTrust(
  deps: InteractiveTrustDeps,
): Promise<boolean | undefined> {
  const home = deps.home ?? homedir();
  const cwd = deps.cwd ?? process.cwd();
  const store =
    deps.store ?? new ProjectTrustStore(projectTrustStorePath(home));
  // Ask about (and record) the project root, not the
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
  // names all of it: the config.toml, the project
  // models.json — whose provider URL receives the key of ANY `*_API_KEY` or
  // `KUBIC_*` variable it names (`KUBIC_API_KEY` when it names none), so a
  // "yes" lets the repository choose where a key you have set is sent — and
  // the project skills the model is told to follow.
  const message = `Trust project ${report.key}? This lets the project's own files take effect for runs here: ${report.configPath} (sets the model, approvals, permissions and journal retention), its models.json (provider URLs, sent the key of any *_API_KEY or KUBIC_* variable it names — KUBIC_API_KEY by default), its project skills and its project role documents (instructions the model follows).`;
  if (deps.ask !== undefined) {
    for (;;) {
      const answer = await deps.ask({
        root: report.key,
        configPath: report.configPath,
        message,
      });
      if (answer === 'view') {
        deps.show?.(report.configPath);
        continue;
      }
      if (answer === 'yes') {
        store.set(root, true);
        return true;
      }
      // `not now` and a cancel record nothing: the load refuses the project
      // layer by name (exit 1), and the next launch asks again.
      return false;
    }
  }
  const answer = (await deps.confirm?.(message)) ?? null;
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
// configuration (or about a refusal) must still run when the load was refused —
// otherwise the named reason has nowhere to surface. `trust` is the repair path
// for a refusal: it must run in exactly the repository whose project layer is
// refused, or the durable grant could never be recorded.
const CONFIG_REPORTING_COMMANDS = new Set([
  'config',
  'doctor',
  'skills',
  'trust',
]);

// The modes that execute an agent under the configuration. They may not
// proceed on defaults once the load was refused: silently running on
// built-in values while the user believes their .kubic/config.toml is in
// force is precisely the defect exists to fix (fail-closed).
// `replay` joins them: its re-execution tiers run the agent
// under the effective config exactly like `kubic run`, so a refused config
// must stop them the same way.
// Exported so the dispatch gate-membership test pins it: a command whose
// runner reads `result.runtime` must be listed here. `policy`
// reports the posture a run would enforce, `attach`/`resume` boot the same lane as `tui`, and
// `eval`/`benchmark` run agent lanes under the same projections — all fail
// closed on a refused config instead of proceeding on built-in defaults.
// The reporting commands (`config`, `doctor`, `trust`) must still run so
// the named reason can surface; sessions/journal read only
// `session.retentionDays` (undefined-safe: no invented window).
export const CONFIG_CONSUMING_COMMANDS: ReadonlySet<string> = new Set([
  'run',
  'tui',
  'attach',
  'resume',
  'replay',
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
  // The pin carries the input it came from, so a refusal of an
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

// Whether a frozen enterprise `[model]` is the effective pin: every cli/env pin
// is dropped — so the consumers that reason about which model runs (the TUI
// `/model` switch) follow the pin, never a raw KUBIC_MODEL.
export function runtimeModelFrozen(result: CliConfigResult): boolean {
  return result.runtime?.modelSource === 'enterprise';
}

// One stderr line per cli/env model pin a frozen enterprise `[model]`
// overrode — the composition root prints them once at the
// boot of run/tui, so `kubic run --model x` against an enterprise
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

// Enterprise policy: the EffectivePolicy resolved once at
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
// `(config default)`; when the selection carries its real origin
// (model-projection's withSelectionOrigin) the suffix names that instead. Only
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

// The named refusal both solo entry points share: one text, so
// the headless terminus and the TUI's exit-6 report cannot drift apart.
function modelPolicyRefusal(provider: string, id: string): string {
  return `model '${provider}/${id}' refused by enterprise policy (allowed_models/allowed_providers): no provider call was made`;
}

// Model selection under the enterprise gate, shared by
// `kubic run` and `kubic tui`: an explicit/role/config selection outside
// `allowed_models`/`allowed_providers` is refused with a named
// ModelSelectError BEFORE the registry is probed or any provider is called,
// and the implicit fallback pick only considers allowed providers. With no
// model policy configured this is exactly `selectModel` — the selection
// behaviour is byte-identical to before.
// The role's allowed set as a selection gate: the
// resolved role's name plus its set. Built once per boot/switch from
// the resolved role; undefined (or an empty set) means unconstrained.
export interface RoleModelScope {
  role: string;
  models: RoleModelEntry[] | undefined;
}

export function roleModelScope(
  resolved: { name: string; models: RoleModelEntry[] | undefined } | undefined,
): RoleModelScope | undefined {
  if (
    resolved === undefined ||
    resolved.models === undefined ||
    resolved.models.length === 0
  ) {
    return undefined;
  }
  return { role: resolved.name, models: resolved.models };
}

// The out-of-set refusal: names the requested model, the
// role, and the set — the operator pins an allowed model or widens the
// set, never guesses which boundary fired.
export function roleModelRefusal(
  role: string,
  provider: string,
  id: string,
  models: readonly RoleModelEntry[],
): string {
  const entries = models.map((entry) => entry.id).join(', ');
  return `model '${provider}/${id}' refused: role '${role}' allows ${entries} only`;
}

// The role's thinking default for the SELECTED model: a matching set entry's
// thinking wins over the flat role default (specific beats general — otherwise
// per-entry thinking would be dead config whenever the flat default is set);
// without a matching entry the flat default stands, and without either there is
// none.
export function resolveRoleThinking(
  resolved:
    | {
        thinking: string | undefined;
        models: readonly RoleModelEntry[] | undefined;
      }
    | undefined,
  provider: string,
  id: string,
): string | undefined {
  if (resolved === undefined) return undefined;
  return (
    roleModelEntry(resolved.models, provider, id)?.thinking ?? resolved.thinking
  );
}

export function selectModelUnderPolicy(
  models: MutableModels,
  explicit: ModelSelection | undefined,
  configDefault: ModelSelection | undefined,
  fallbackProviders: readonly string[] | undefined,
  policy: EffectivePolicy | undefined,
  // The role's allowed set: gates the explicit/role
  // selection AND the final pick, exactly like the enterprise gate above
  // — a run that would boot (or switch) outside its role's set refuses
  // by name instead of silently running out-of-set.
  roleScope?: RoleModelScope,
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
  const scopeModels = roleScope?.models;
  const scope =
    roleScope === undefined ||
    scopeModels === undefined ||
    scopeModels.length === 0
      ? undefined
      : { role: roleScope.role, models: scopeModels };
  if (scope !== undefined) {
    for (const selection of [explicit, configDefault]) {
      if (
        selection !== undefined &&
        !roleModelAllowed(scope.models, selection.provider, selection.id)
      ) {
        throw new ModelSelectError(
          roleModelRefusal(
            scope.role,
            selection.provider,
            selection.id,
            scope.models,
          ),
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
  if (
    scope !== undefined &&
    !roleModelAllowed(scope.models, picked.provider, picked.id)
  ) {
    throw new ModelSelectError(
      roleModelRefusal(scope.role, picked.provider, picked.id, scope.models),
    );
  }
  return picked;
}

// The config `[approvals]` policy as the solo install consumes it: route,
// maxPendingMs, autoApprove, requireJustification and sessionScoped, projected
// ONCE here and spread into installSoloPolicy by `kubic run`, `kubic tui`,
// replay and doctor's installed-policy line — so what doctor prints and what
// every solo lane enforces are one derivation. A refused config contributes
// nothing (the command fails closed first); absent means the documented
// defaults.
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

// The remaining `kubic run` projections: the permission classes
// the lane derives its tool allowlist from and the journal retention
// bound enforced on every append. A refused config contributes
// nothing here — the run itself fails closed before this matters.
export function runtimeRunDeps(result: CliConfigResult): {
  policyClasses?: PermissionClasses;
  journalRetention?: JournalRetention;
  // The declared out-of-scope paths, threaded to the
  // run/TUI lane's reconciliation. Undefined when config declares none — the
  // walk still skips `.git/`, `.kubic/` and `.gitignore` hits on its own.
  reconcileOutOfScope?: string[];
  // Where the classes came from, per the config layer's own
  // record. Threaded to the run path so the posture the lane installs and
  // the posture `doctor` prints carry the SAME source — a config
  // that sets only, say, `[journal]` still runs the documented defaults and
  // must not be reported as operator-configured classes.
  policySource: 'config' | 'default';
  // The config `[approvals]` policy the lane installs.
  approvals?: SoloApprovalConfig;
  // The `[verify]` gate commands the run executes in its
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

// The shared solo-lane projections: the agent id the lane and
// its journal attribution carry, and the config-sourced role layers the
// `--role` resolution merges under the role document. ONE projection with
// two one-line consumers — `kubic run` (headless-run.ts) and `kubic tui`
// (tui-run.ts) — so both entry points name the lane and layer the roles
// identically. Absent means the shipped behaviour: agent id 'root', no
// layers. adds the effective thinking level with its source, which
// the lane resolves against the session's record and the role default.
export function runtimeLaneDeps(result: CliConfigResult): {
  agentId?: string;
  roles?: {
    layers: RoleLayerInput[];
    trustProject: ProjectTrustCheck;
    homeDir?: string;
  };
  thinking?: RuntimeThinking;
  /** The merged `[model]` ladder — the lane climbs
   * the role's own rungs first when the role names any. */
  escalate?: RuntimeEscalation;
} {
  const runtime = result.runtime;
  if (runtime === undefined) return {};
  const agentId = runtime.config.agent?.name;
  const layers = roleLayersFromConfig(runtime);
  // The repo role documents resolve under the
  // same per-path trust check as the project models.json and skills — so
  // `kubic run --role` and `kubic tui --role` load an untrusted root's
  // documents never. The check folds the KUBIC_TRUST_PROJECT opt-in in.
  const trustProject = projectTrustFor(result);
  return {
    ...(agentId === undefined ? {} : { agentId }),
    // Always present (even with no layers): the trust check travels on `roles`
    // so callers never default to an untrusted load. The home directory
    // travels with it, so both lanes layer the global `~/.kubic/roles` under
    // the project documents — absent (an empty home, tests and embeddings)
    // means no global source.
    roles: {
      layers,
      trustProject,
      ...(result.trust.home === '' ? {} : { homeDir: result.trust.home }),
    },
    ...(runtime.thinking === undefined
      ? {}
      : { thinking: { ...runtime.thinking } }),
    // No ladder, no field: escalation stays opt-in — the
    // lane climbs nothing it was never configured with.
    ...(runtime.escalate === undefined
      ? {}
      : {
          escalate: {
            steps: [...runtime.escalate.steps],
            maxEscalations: runtime.escalate.maxEscalations,
          },
        }),
  };
}

// The settings `skills` projection: the merged
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

// The lane's escalation ladder: the role's own rungs
// win outright when the role names any — even [] (the role opts out of
// climbing) — and the `[model]` bound still caps the role's climbs. No
// rungs anywhere means no ladder: escalation stays opt-in.
export function resolveLaneLadder(
  model: RuntimeEscalation | undefined,
  role: readonly string[] | undefined,
): RuntimeEscalation | undefined {
  if (role !== undefined) {
    return {
      steps: [...role],
      maxEscalations: model?.maxEscalations ?? role.length,
    };
  }
  if (model === undefined) return undefined;
  return { steps: [...model.steps], maxEscalations: model.maxEscalations };
}

// The effective thinking level with its source — the
// per-run override the run/tui lane boots with, resolved once at load
// (`--thinking` > `KUBIC_MODEL_THINKING` > file layers, enterprise-frozen).
// Undefined when nothing set a level: the lane then boots at the session's
// persisted level, a role default, or Pi's 'off'.
export function runtimeThinking(
  result: CliConfigResult,
): RuntimeThinking | undefined {
  const thinking = result.runtime?.thinking;
  return thinking === undefined ? undefined : { ...thinking };
}

// The config `[roles.<name>]` table as resolver layer inputs:
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
      // The layer's approval obligations travel like
      // `tools` — the resolver unions them with the document's list.
      if (
        entry.requires !== undefined &&
        runtime.sources[`roles.${name}.requires`] === layer
      ) {
        spec.requires = [...entry.requires];
      }
      if (
        entry.model !== undefined &&
        runtime.sources[`roles.${name}.model`] === layer
      ) {
        spec.model = entry.model;
      }
      // The allowed set rides the same provenance:
      // the winning list travels on the layer that set it, copied so
      // the resolver owns its merge input.
      if (
        entry.models !== undefined &&
        runtime.sources[`roles.${name}.models`] === layer
      ) {
        spec.models = entry.models.map((modelEntry) => ({ ...modelEntry }));
      }
      // The ladder rides the same provenance: the
      // winning rungs travel on the layer that set them, copied so the
      // resolver owns its merge input.
      if (
        entry.escalate !== undefined &&
        runtime.sources[`roles.${name}.escalate`] === layer
      ) {
        spec.escalate = [...entry.escalate];
      }
      if (
        entry.thinking !== undefined &&
        runtime.sources[`roles.${name}.thinking`] === layer
      ) {
        spec.thinking = entry.thinking;
      }
      if (Object.keys(spec).length > 0) specs[name] = spec;
    }
    if (Object.keys(specs).length > 0) layers.push({ layer, roles: specs });
  }
  return layers;
}

// Request options: the merged `[model]` tuning plus
// every `[roles.<name>]` table that sets a key, re-checked here so the
// programmatic session/agent layers (which bypass the TOML parser) cannot
// hand the lane a malformed value. Undefined when nothing is tuned — the
// run sites then omit `settings.stream` and the provider defaults stand.
// The run sites resolve the tables against the run's role with
// `resolveStreamOptions`, so each lane (solo or worker) carries its own
// role's tuning on its own harness.
export function runtimeStreamTuning(
  result: CliConfigResult,
): StreamTuningTables | undefined {
  const runtime = result.runtime;
  if (runtime === undefined) return undefined;
  const toTuning = (
    record: Record<string, unknown>,
    keyPath: string,
  ): ModelStreamTuning => {
    const { cacheRetention, ...rest } = checkModelStreamTuning(record, keyPath);
    return {
      ...rest,
      // Validated one line above against the same three literals Pi
      // names, so the narrowing is exact, never a guess.
      ...(cacheRetention === undefined
        ? {}
        : {
            cacheRetention:
              cacheRetention as ModelStreamTuning['cacheRetention'],
          }),
    };
  };
  const model = toTuning({ ...runtime.config.model }, 'model');
  const roles: Record<string, ModelStreamTuning> = {};
  for (const [name, spec] of Object.entries(runtime.config.roles ?? {})) {
    const tuning = toTuning({ ...spec }, `roles.${name}`);
    if (Object.keys(tuning).length > 0) roles[name] = tuning;
  }
  if (Object.keys(model).length === 0 && Object.keys(roles).length === 0) {
    return undefined;
  }
  return {
    ...(Object.keys(model).length === 0 ? {} : { model }),
    ...(Object.keys(roles).length === 0 ? {} : { roles }),
  };
}

// `kubic sessions prune`'s default keep-window: the parsed
// `session.retentionDays` leaf — undefined when config sets none (or the
// load was refused), so prune demands an explicit --keep-days instead of
// inventing a window (fail-closed; deletion stays explicit). 0 is a
// real value here: it means retention off, and prune reports it as such.
export function sessionRetentionDays(
  result: CliConfigResult,
): number | undefined {
  return result.runtime?.config.session?.retentionDays;
}

// The `[agent] systemPromptFile` contents `kubic run` boots with: the file text
// the runtime read at load. Undefined when no layer declares the key (or the
// load was refused) — the lane assembles its prompt unchanged.
export function runtimeSystemPromptSection(
  result: CliConfigResult,
): string | undefined {
  return result.runtime?.systemPromptFile?.contents;
}

// The lane compaction options `kubic run` boots with: the
// configured `[session]` compaction keys over the SAME load every other
// consumer uses. Undefined when config sets none (or the load was refused),
// so the lane defaults apply — never an invented value.
export function runtimeCompactionDeps(
  result: CliConfigResult,
): SoloCompactionOptions | undefined {
  const compaction = result.runtime?.compaction;
  if (compaction === undefined) return undefined;
  const { enabled, reserveTokens, keepRecentTokens } = compaction;
  if (
    enabled === undefined &&
    reserveTokens === undefined &&
    keepRecentTokens === undefined
  ) {
    return undefined;
  }
  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(reserveTokens === undefined ? {} : { reserveTokens }),
    ...(keepRecentTokens === undefined ? {} : { keepRecentTokens }),
  };
}

// Installed-policy projection: what `doctor` reports and what the
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
    // The approval half of the same projection, so doctor's
    // `policy:installed` line and the lane read one derivation.
    ...runtimeApprovalDeps(result),
  };
}

// The projection `doctor` and the `tui` path read, over the SAME config load
// `kubic run` uses. Absent config → absent classes → installSoloPolicy's
// documented SOLO_DEFAULTS, which is exactly what a config-less run installs,
// so doctor's line and the lane's posture are the same object.
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
      // The effective reserve, from the same getter `kubic config` prints —
      // doctor and the command cannot disagree.
      compactionSummary: compactionSummaryLine(view.compaction),
      ignoreSplitMissing: missing,
      ignoreSplitApplicable: applicable,
      projectTrust: result.trust,
    }),
  );
}
