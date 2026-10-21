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
import type { ModelSelection } from '@kubic/agent/model-select';
import type { ExitCode } from '@kubic/core/cli/exit-codes';
import { EXIT_FAILED } from '@kubic/core/cli/exit-codes';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import { gitSync } from '@kubic/exec/runtime-exclude';
import { findProjectRoot } from '@kubic/host/cli';
import type {
  ProjectTrustCheck,
  ProjectTrustReport,
  RuntimeConfig,
} from '@kubic/host/config';
import {
  buildConfigDoctorInput,
  checkWorkspaceIgnoreSplit,
  compactionSummaryLine,
  configDoctorProbe,
  effectiveConfigView,
  loadRuntimeConfig,
  NO_PROJECT_TRUST,
  ProjectTrustStore,
  projectTrustCheck,
  projectTrustReport,
  projectTrustStorePath,
} from '@kubic/host/config';
import type { DepProbe } from '@kubic/host/doctor';

export interface CliConfigResult {
  // Present only when the load succeeded. A refusal leaves it undefined:
  // callers never run on invented values.
  runtime: RuntimeConfig | undefined;
  // Named reason the config was refused (unknown/unsupported key, a
  // distrusted project layer, a secret ref in config).
  error: string | undefined;
  // The repo's committed-vs-ignored split, reported by
  // `kubic config` and by doctor: the runtime prefixes must be ignored
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
      projectTrustChanged: stored.changed,
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
type TrustAnswer = 'yes' | 'not-now' | 'view';

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
  // names all of it: the config.toml — whose `[verify]` commands run as
  // shell after every run —, the project
  // models.json — whose provider URL receives the key of ANY `*_API_KEY` or
  // `KUBIC_*` variable it names (`KUBIC_API_KEY` when it names none), so a
  // "yes" lets the repository choose where a key you have set is sent — and
  // the project skills the model is told to follow.
  // A grant covers the content it was given for: a project whose files
  // changed since is asked again, and the question says why.
  const lead = report.changed
    ? `Project ${report.key} changed since you trusted it. Trust it again?`
    : `Trust project ${report.key}?`;
  const message = `${lead} This lets the project's own files take effect for runs here: ${report.configPath} (sets the model, approvals, permissions, journal retention and which paths the journal records; its [verify] commands run as shell commands after each run), its models.json (provider URLs, sent the key of any *_API_KEY or KUBIC_* variable it names — KUBIC_API_KEY by default), its project skills, its project role documents, its AGENTS.md and its [agent] systemPromptFile (instructions the model follows).`;
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
/** @internal */
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
/** @internal */
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
// the caller prints `result.error` and returns this code (EXIT_FAILED, the
// same code doctor uses for a config-shaped failure).
export function configRefusalExit(
  result: CliConfigResult,
  command: string | undefined,
): ExitCode | undefined {
  if (result.runtime !== undefined) return undefined;
  if (command === undefined) return undefined;
  if (CONFIG_REPORTING_COMMANDS.has(command)) return undefined;
  return CONFIG_CONSUMING_COMMANDS.has(command) ? EXIT_FAILED : undefined;
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

// `kubic doctor` config probe: the same load the rest of the process uses,
// projected onto doctor's dependency-probe shape (doctor.ts has no generic
// section hook, so the check rides the
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
