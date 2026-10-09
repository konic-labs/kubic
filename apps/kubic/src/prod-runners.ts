import { createSocket } from 'node:dgram';

// Production wiring for the command dispatch: one runner per
// command in the if-chain, built from the same objects `main()` built
// inline before the extraction. This module is the composition root's prod
// half — it is the only place here that reads process.cwd()/process.env or
// touches the lanes — while ./dispatch.js stays a pure seam, so the
// routing is testable with fakes (dispatch.test.ts).
//
// The eval/benchmark runner pair is the one deliberate stub: live suite
// execution has no model-backed runner in this binary, so `--task` refuses
// fail-closed instead of scoring fiction (the refusal is pinned verbatim
// by dispatch.test.ts).

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  openSessionStore,
  SESSION_ID_PATTERN,
  sessionsTouchingWorkspace,
} from '@kubic/agent/lane/session-store';
import { BACKGROUND_CONTEXT } from '@kubic/agent/pi-boundary';
import {
  type CommandResult,
  EXIT_FAILED,
  EXIT_USAGE,
} from '@kubic/core/cli/exit-codes';
import { isFancy } from '@kubic/core/cli/kit';
import {
  type CliLogger,
  createLineLogger,
  debugEnabled,
} from '@kubic/core/cli/logger';
import { outputModeFor } from '@kubic/core/cli/output';
import { promptConfirm } from '@kubic/core/cli/prompt';
import {
  type CliTheme,
  createCliTheme,
  detectColorLevel,
  themeFor,
} from '@kubic/core/cli/theme';
import { runBenchmarkCommand, runEvalCommand } from '@kubic/eval/cli';
import { runExportCommand as runTrajectoryExportCommand } from '@kubic/eval/export-cli';
import { NodeExecutionEnv } from '@kubic/exec/env';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import { isGitWorktreeClean } from '@kubic/exec/git-clean';
import { looseStateDirMode } from '@kubic/exec/lock-file';
import { readStdinText } from '@kubic/exec/stdin';
import { installedPolicyPosture } from '@kubic/host/approvals';
import {
  auditLedgerDirFor,
  auditSinkSnapshot,
  auditSinksDoctorChecks,
  buildConfiguredSinks,
  isSyslogTargetAvailable,
  loadProdAuditSecrets,
  readAuditLedger,
  runAuditCommand,
} from '@kubic/host/audit';
import { findProjectRoot } from '@kubic/host/cli';
import {
  ProjectTrustStore,
  projectTrustStorePath,
  runConfigCommand,
  runSetupCommand,
  runTrustCommand,
} from '@kubic/host/config';
import { loadSessionCostRows, runCostCommand } from '@kubic/host/cost';
import type { SessionOverlapProbe } from '@kubic/host/doctor';
import {
  describeFullAccessSession,
  type FullAccessSession,
  listFullAccessSessions,
  runDoctorCommand,
} from '@kubic/host/doctor';
import { runGitCommand } from '@kubic/host/git';
import { runJournalCommand } from '@kubic/host/journal';
import {
  assembleModels,
  contextRoomProbeOf,
  FAUX_NOTICE,
  fauxProviderActive,
  modelsSourcesProbe,
  providerProbesOf,
  runModelsCommand,
} from '@kubic/host/models';
import {
  enterpriseDoctorChecks,
  policyFromInstalledAllowlist,
  policyWithInstalledAllowlist,
  runPolicyCommand,
} from '@kubic/host/policy';
import { type ReplayRuntimeDeps, runReplayCommand } from '@kubic/host/replay';
import { rolesDoctorProbe, selectRole } from '@kubic/host/roles';
import { runRunCommand } from '@kubic/host/run';
import { defaultSessionsRoot, runSessionsCommand } from '@kubic/host/sessions';
import { runSkillsCommand, skillsDoctorProbe } from '@kubic/host/skills';
import type { CliConfigResult } from './config/load.js';
import {
  doctorConfigProbe,
  doctorPolicyLoader,
  kubicConfigLoader,
  projectTrustFor,
} from './config/load.js';
import {
  runtimeModelFrozen,
  runtimeModelPin,
  runtimeModelPinNotes,
  runtimePolicy,
} from './config/model-selection.js';
import {
  installedPolicyClasses,
  installedPolicyDeps,
  journalRetentionDays,
  runtimeApprovalDeps,
  runtimeCompactionDeps,
  runtimeLaneDeps,
  runtimeRunDeps,
  runtimeSkillsDeps,
  runtimeStreamTuning,
  runtimeSystemPromptSection,
  sessionRetentionDays,
} from './config/projections.js';
import type { DispatchRunners } from './dispatch.js';
import { createProdRunSuite } from './eval-prod.js';
import { runProdReplay } from './replay-run.js';
import { runHeadlessPrompt } from './run/command.js';
import type { HeadlessRunDeps } from './run/options.js';
import { createRunProgress } from './run/progress.js';
import { resolveSessionTrajectory } from './run/trajectory.js';
import { prodSetupDeps } from './setup-prod.js';
import type { TuiDepsInput } from './tui/deps.js';
import { tuiDepsWithDefaults } from './tui/deps.js';
import { runTuiCommand } from './tui/run.js';

// The two channels the root wired: `kubic` output on stdout, diagnostics
// (debug lines) on stderr.
export interface ProdRunnerIo {
  readonly out: (line: string) => void;
  readonly debug: (line: string) => void;
  // The version the TUI's first screen names.
  readonly version?: () => string;
}

export type ProdRunners = DispatchRunners;

// The presentation seams of one command invocation, derived once from
// the real streams: colour for stdout data (none off a TTY, under NO_COLOR,
// or for --json), the stderr diagnostics logger (debug lines under
// KUBIC_DEBUG=1), kit tables and prompts only on an interactive
// terminal. `--json` keeps stdout to exactly one document.
function presentation(
  out: (line: string) => void,
  diagnostics: (line: string) => void,
  json: boolean,
): {
  out: (line: string) => void;
  logger: CliLogger;
  theme: ReturnType<typeof createCliTheme>;
  fancy: boolean;
  interactive: boolean;
} {
  const stdoutTTY = process.stdout.isTTY === true;
  const stdinTTY = process.stdin.isTTY === true;
  const theme = createCliTheme(
    json ? 'none' : detectColorLevel(process.env, stdoutTTY),
  );
  const logTheme = json ? PLAIN : stderrTheme();
  const mode = outputModeFor({
    json,
    stdinTTY,
    stdoutTTY,
    colorEnabled: theme.enabled,
  });
  return {
    out,
    logger: createLineLogger(diagnostics, {
      theme: logTheme,
      debug: debugEnabled({}),
    }),
    theme,
    fancy: mode.fancy,
    interactive: mode.interactive,
  };
}

// The diagnostics colours for stderr, decided from stderr's own TTY state
// (the logger contract: colour only on a TTY) — never from stdout's.
function stderrTheme(): CliTheme {
  return themeFor(process.stderr);
}

const PLAIN = createCliTheme('none');

// Audit-sink reachability probes: the real platform — a
// unix syslog socket must exist; UDP needs a creatable dgram socket
// (connectionless, so delivery stays best-effort past this point).
const auditProbes = {
  socketExists: (path: string): boolean => {
    try {
      return createNodeFileBridge('/').exists(path);
    } catch {
      return false;
    }
  },
  udpAvailable: (): boolean => {
    try {
      createSocket('udp4').close();
      return true;
    } catch {
      return false;
    }
  },
};

// Report colours and table style for a migrated command, decided once from
// the real stdout: colour only on a TTY that allows it (NO_COLOR,
// FORCE_COLOR, TERM=dumb honoured), kit tables only there too, and
// neither under `--json`.
function reportStyle(json: boolean): { theme: CliTheme; fancy: boolean } {
  const theme = json ? PLAIN : themeFor(process.stdout);
  const mode = outputModeFor({
    json,
    stdinTTY: process.stdin.isTTY === true,
    stdoutTTY: process.stdout.isTTY === true,
    colorEnabled: theme.enabled,
  });
  return { theme, fancy: mode.fancy };
}

// The lane deps `kubic run` boots the headless runner with: every config
// projection the lane consumes, from the ONE config load. Exported so
// the wiring is tested through the same builder the runner calls — a test
// that hand-spreads these keys stays green when the production spread is
// dropped (the defect class of).
/** @internal */
export function prodRunDeps(cliConfig: CliConfigResult): HeadlessRunDeps {
  const enterprisePolicy = runtimePolicy(cliConfig);
  // The session compaction keys, threaded to the lane boot
  // below.
  const compaction = runtimeCompactionDeps(cliConfig);
  // The system prompt file section, read at load.
  const systemPromptSection = runtimeSystemPromptSection(cliConfig);
  // The `[model]` / `[roles.<name>]` request tuning
  // the headless boot resolves against the run's role. Undefined when
  // nothing is tuned — the lane then omits `settings.stream`.
  const streamTuning = runtimeStreamTuning(cliConfig);
  return {
    model: runtimeModelPin(cliConfig),
    ...(compaction === undefined ? {} : { compaction }),
    ...(systemPromptSection === undefined ? {} : { systemPromptSection }),
    ...(streamTuning === undefined ? {} : { streamTuning }),
    // Enterprise policy: the model gate, the role grant
    // check and the lane tool intersection all read this one resolved
    // object.
    ...(enterprisePolicy === undefined
      ? {}
      : { modelPolicy: enterprisePolicy }),
    ...runtimeRunDeps(cliConfig),
    // One per-path check gates the project models.json
    // and each ancestor skill root on the tree the files live in — never a
    // cwd boolean applied to ancestors.
    trustProject: projectTrustFor(cliConfig),
    // The shared lane projections — the configured agent id
    // (journal attribution) and the config-sourced role layers `--role`
    // merges under the document.
    ...runtimeLaneDeps(cliConfig),
    // The config `skills` projection — resolved at
    // load, loaded with source 'settings'. The lane falls back to the
    // prod home/cwd/trust around it (only this key is set).
    skills: { ...runtimeSkillsDeps(cliConfig) },
  };
}

// The deps `kubic tui` (and the bare interactive `kubic`) hands
// `tuiDepsWithDefaults`: the SAME projections `prodRunDeps` threads, from the
// same config load, plus the interactive-only ones. Exported for the same
// reason as `prodRunDeps`.
/** @internal */
export function prodTuiDeps(
  io: ProdRunnerIo,
  cliConfig: CliConfigResult,
): TuiDepsInput {
  const enterprisePolicy = runtimePolicy(cliConfig);
  // The session compaction projection, like `kubic run`.
  const compaction = runtimeCompactionDeps(cliConfig);
  // The system prompt file section, like `kubic run`.
  const systemPromptSection = runtimeSystemPromptSection(cliConfig);
  // The same request tuning `kubic run` threads — the
  // interactive boot resolves it against `--role` identically.
  const streamTuning = runtimeStreamTuning(cliConfig);
  return {
    out: io.out,
    // `error:` lines (unknown session, no models) are diagnostics.
    err: io.debug,
    // Same policy install as `kubic run`: the TUI
    // drives the same lane, so a config that names classes must reach
    // it here too.
    ...installedPolicyClasses(cliConfig),
    policySource: installedPolicyDeps(cliConfig).source,
    // The config `[approvals]` policy, same as `kubic run`.
    approvals: runtimeApprovalDeps(cliConfig),
    // The same journal retention projection `kubic run`
    // threads — a TUI session's journal age-prunes under config.
    journalRetention: runtimeRunDeps(cliConfig).journalRetention,
    // The same out-of-scope projection — the
    // interactive lane's baseline and sweep exclude what `kubic run`
    // excludes.
    reconcileOutOfScope: runtimeRunDeps(cliConfig).reconcileOutOfScope,
    // The same session compaction projection `kubic run`
    // threads — the interactive lane compacts under the configured
    // policy, not the lane defaults.
    ...(compaction === undefined ? {} : { compaction }),
    // The same system prompt file section — the interactive
    // lane assembles the same prompt.
    ...(systemPromptSection === undefined ? {} : { systemPromptSection }),
    // With: the SAME model projection `kubic run`
    // consumes — the cli `--model` (above `KUBIC_MODEL`/`[model]`) included.
    // Without it the TUI ignored those pins and ran the first registered
    // provider.
    model: runtimeModelPin(cliConfig),
    // Spread beside the model pin so the tuning can
    // never drift from the projection `kubic run` boots with.
    ...(streamTuning === undefined ? {} : { streamTuning }),
    // Enterprise policy: the interactive lane gates role
    // grants, model selection and its tool set identically.
    ...(enterprisePolicy === undefined
      ? {}
      : { modelPolicy: enterprisePolicy }),
    // A frozen enterprise `[model]` also binds `/model`.
    ...(runtimeModelFrozen(cliConfig) ? { modelPinFrozen: true } : {}),
    // The `[ui] theme` reference — a built-in name or a
    // JSON theme path, resolved and validated before the alt-screen opens.
    ...(cliConfig.runtime?.config.ui?.theme === undefined
      ? {}
      : { theme: cliConfig.runtime.config.ui.theme }),
    // The same per-path check gates the project models.json
    // and each ancestor skill root on the interactive lane.
    trustProject: projectTrustFor(cliConfig),
    // The first screen's version and trust row (the trust row
    // is omitted when the project has no layer).
    ...(io.version === undefined ? {} : { version: io.version() }),
    ...(cliConfig.trust?.present === true
      ? { projectTrust: cliConfig.trust.trusted ? 'loaded' : 'untrusted' }
      : {}),
    // The SAME lane projections `kubic run` consumes — the
    // interactive lane names itself and layers `--role` identically.
    ...runtimeLaneDeps(cliConfig),
    // The same settings-skills projection `kubic run`
    // threads — the interactive lane loads the config skills too.
    skills: { ...runtimeSkillsDeps(cliConfig) },
  };
}

export function createProdRunners(io: ProdRunnerIo): ProdRunners {
  const { out, debug } = io;
  // The analysis handlers' channels: the report on stdout, diagnostics on
  // stderr (the `debug` channel), report colour and the kit table from the
  // real stdout, diagnostics colour from the real stderr (each off on a
  // pipe and under NO_COLOR; each handler also drops them under --json).
  const report = () => {
    const theme = themeFor(process.stdout);
    return {
      out,
      err: debug,
      theme,
      errTheme: stderrTheme(),
      fancy: outputModeFor({
        json: false,
        stdinTTY: process.stdin.isTTY === true,
        stdoutTTY: process.stdout.isTTY === true,
        colorEnabled: theme.enabled,
      }).fancy,
    };
  };
  // A frozen enterprise `[model]` drops a cli/env pin; the
  // boot of every agent-running command says so once, on stderr — never on
  // stdout, so a `--json` envelope stays exactly one document.
  const noteOverriddenModelPins = (cliConfig: CliConfigResult): void => {
    for (const line of runtimeModelPinNotes(cliConfig)) debug(line);
  };
  return {
    sessions: (invocation, cliConfig) => {
      // `sessions prune`'s default keep-window comes from config
      // when it sets one; with none, prune demands an explicit --keep-days
      // rather than inventing a window.
      const retentionDays = sessionRetentionDays(cliConfig);
      const view = presentation(
        out,
        debug,
        invocation.command === 'list' && invocation.json === true,
      );
      return runSessionsCommand(invocation, {
        ...view,
        ...(retentionDays === undefined ? {} : { retentionDays }),
        // A prune with neither --yes nor --dry-run asks on a TTY; off a
        // TTY it stays the documented dry run.
        ...(view.interactive
          ? {
              confirm: (message: string) =>
                promptConfirm({
                  message,
                  interactive: true,
                  nonInteractive: false,
                }),
            }
          : {}),
      });
    },
    git: (request) =>
      runGitCommand(request, {
        env: new NodeExecutionEnv(process.cwd()),
        out,
        ...reportStyle(request.json === true),
      }),
    journal: (request, cliConfig) => {
      // The same `session.retentionDays` projection `sessions
      // prune` reads — `log` self-heals aged entries of a session journal at
      // read time under it. Unset (or a refused config) leaves the read path
      // without a window: it then writes nothing.
      const retentionDays = sessionRetentionDays(cliConfig);
      // `journal prune` takes its default keep window from the resolved
      // `journal.retentionDays`; unset, it demands --keep-days, and a config
      // that did not load is named in that refusal.
      const journalWindow = journalRetentionDays(cliConfig);
      return runJournalCommand(request, {
        out,
        err: debug,
        errTheme: request.json === true ? PLAIN : stderrTheme(),
        ...reportStyle(request.json === true),
        ...(retentionDays === undefined ? {} : { retentionDays }),
        ...(journalWindow === undefined
          ? {}
          : { journalRetentionDays: journalWindow }),
        ...(cliConfig.error === undefined
          ? {}
          : { journalConfigError: cliConfig.error }),
      });
    },
    models: async (options, cliConfig) => {
      const view = presentation(out, debug, options.json === true);
      // The store's decision gates the project
      // models.json exactly as the env opt-in does — the composition root
      // passes the one report the config load already consumed.
      const assembled = await assembleModels(process.cwd(), process.env, {
        home: cliConfig.trust.home,
        projectTrust: projectTrustFor(cliConfig),
      });
      for (const note of assembled.notes) view.logger.info(note);
      if (fauxProviderActive(process.env)) view.logger.warn(FAUX_NOTICE);
      const pin = runtimeModelPin(cliConfig);
      return runModelsCommand(options, {
        ...view,
        models: assembled.models,
        providers: assembled.providers,
        defaultedWindows: assembled.defaultedWindows,
        // The configured pin is the default the view marks.
        ...(pin === undefined
          ? {}
          : { defaultModel: `${pin.provider}/${pin.id}` }),
      });
    },
    // The interactive setup (provider, model, thinking, trust).
    setup: async (options, cliConfig) =>
      runSetupCommand(
        options,
        await prodSetupDeps({
          out,
          err: debug,
          errTheme: stderrTheme(),
          cliConfig,
        }),
      ),
    skills: (options, cliConfig) => {
      // The listing over the same discovery the lane boots.
      // The trust inputs mirror `kubic run`'s (the env opt-in plus the
      // per-path project check), the classes are the installed ones the
      // doctor judges, and `--role` resolves through the same `selectRole`
      // call — a refusal fails the listing closed with its named reason.
      const view = presentation(out, debug, options.json === true);
      const cwd = process.cwd();
      const rolesBridge = createNodeFileBridge(cwd);
      const enterprisePolicy = runtimePolicy(cliConfig);
      const layers = runtimeLaneDeps(cliConfig).roles?.layers;
      return runSkillsCommand(options, {
        ...view,
        base: {
          bridge: createNodeFileBridge(cwd),
          cwd,
          homeDir: cliConfig.trust.home,
          trusted:
            process.env.KUBIC_TRUST_PROJECT === '1' ||
            process.env.KUBIC_TRUST_PROJECT === 'true',
          trustProject: projectTrustFor(cliConfig),
          ...runtimeSkillsDeps(cliConfig),
          ...installedPolicyClasses(cliConfig),
        },
        resolveRole: (name: string) => {
          const selected = selectRole({
            bridge: rolesBridge,
            cwd,
            role: name,
            projectRoot: findProjectRoot(
              rolesBridge,
              cwd,
              cliConfig.trust.home,
            ),
            ...(layers === undefined ? {} : { layers }),
            trustProject: projectTrustFor(cliConfig),
            ...(enterprisePolicy === undefined
              ? {}
              : { toolPolicy: enterprisePolicy }),
          });
          return {
            name: selected.resolved.name,
            ...(selected.doc.skills === undefined
              ? {}
              : { skills: selected.doc.skills }),
            classes: selected.resolved.classes,
          };
        },
      });
    },
    trust: (options, cliConfig) => {
      // Grants are recorded at the project root — the same
      // root the config load keys its trust report to — so `kubic trust`
      // from a subdirectory records a grant the loader honours. An
      // explicit path resolves to its own root; the bare form reuses the
      // load's root (it was resolved from this same cwd).
      const target = options.path ?? process.cwd();
      const root =
        options.path === undefined
          ? cliConfig.projectRoot
          : findProjectRoot(
              createNodeFileBridge(target),
              target,
              cliConfig.trust.home,
            );
      return runTrustCommand(
        root === target ? options : { ...options, path: root },
        {
          ...presentation(out, debug, false),
          store: new ProjectTrustStore(
            projectTrustStorePath(cliConfig.trust.home),
          ),
          cwd: process.cwd(),
        },
      );
    },
    run: (options, cliConfig) => {
      noteOverriddenModelPins(cliConfig);
      return runRunCommand(options, {
        ...presentation(out, debug, options.json === true),
        run: (prompt, options) =>
          runHeadlessPrompt(prompt, options, prodRunDeps(cliConfig)),
        // Live progress only when the whole run is on an
        // interactive colour terminal (stdout AND stderr) and not --json;
        // a redirected stdout keeps the plain lines scripts read.
        ...(options.json !== true &&
        isFancy(process.stdout) &&
        isFancy(process.stderr)
          ? {
              progress: () =>
                createRunProgress(process.stderr, themeFor(process.stderr), {
                  cwd: process.cwd(),
                  home: homedir(),
                }),
            }
          : {}),
      });
    },
    tui: async (options, cliConfig) => {
      noteOverriddenModelPins(cliConfig);
      return runTuiCommand(
        options,
        tuiDepsWithDefaults(prodTuiDeps(io, cliConfig)),
      );
    },
    doctor: async (options, cliConfig) => {
      // `doctor --session <id>` checks one session — its
      // installed posture reads that session's posture.json. A value that
      // cannot name a session directory is refused before any path join.
      const doctorSession = options.session;
      if (
        doctorSession !== undefined &&
        !SESSION_ID_PATTERN.test(doctorSession)
      ) {
        debug(
          `error: invalid --session id ${JSON.stringify(doctorSession)} (use [A-Za-z0-9_-])`,
        );
        return { exitCode: EXIT_USAGE };
      }
      const sessionsRoot = defaultSessionsRoot();
      const doctorSessionDir =
        doctorSession === undefined
          ? undefined
          : join(sessionsRoot, doctorSession);
      const enterprisePolicy = runtimePolicy(cliConfig);
      // The enterprise checks run only when a `[policy]`
      // section is actually configured — the resolved policy is always
      // present (empty without one), and running the checks over an empty
      // policy would fail the default matrix for a config that never asked
      // for enterprise enforcement. `sources` carries one leaf per config
      // key, so a `policy.` prefix IS "a [policy] section exists".
      const policyConfigured = Object.keys(
        cliConfig.runtime?.sources ?? {},
      ).some((leaf) => leaf.startsWith('policy.'));
      const roleLayers = runtimeLaneDeps(cliConfig).roles?.layers;
      // Default probes are faux-only: providers are listed (never dialed),
      // deps check the live node runtime, policy falls back to host
      // defaults until config-sourced policy lands.
      const view = presentation(out, debug, options.json === true);
      const assembled = await assembleModels(process.cwd(), process.env, {
        home: cliConfig.trust.home,
        projectTrust: projectTrustFor(cliConfig),
      });
      for (const note of assembled.notes) view.logger.info(note);
      if (fauxProviderActive(process.env)) view.logger.warn(FAUX_NOTICE);
      const [major = 0, minor = 0] = process.versions.node
        .split('.')
        .map((part) => Number(part));
      // Repo-level session overlap: the local session
      // store's view of the sessions recorded against this cwd. Best-effort:
      // an unlistable store makes NO claim (the probe stays un-injected)
      // rather than crashing doctor — the note is informational, so an
      // unreadable store must not turn into a failure of its own.
      // The sessions root's mode, when it is group- or
      // world-accessible. Best-effort like the overlap probe: an unreadable
      // root makes no claim.
      const statePermissionProbe = () => {
        const root = defaultSessionsRoot();
        const mode = looseStateDirMode(root);
        return mode === undefined ? undefined : { path: root, mode };
      };
      let sessionOverlapProbe: (() => SessionOverlapProbe) | undefined;
      try {
        const overlapRoot = defaultSessionsRoot();
        const sessionIds = await sessionsTouchingWorkspace(
          openSessionStore(overlapRoot, createNodeFileBridge(overlapRoot)),
          process.cwd(),
          BACKGROUND_CONTEXT,
        );
        sessionOverlapProbe = () => ({
          workspace: process.cwd(),
          sessionIds,
        });
      } catch {
        sessionOverlapProbe = undefined;
      }
      // Full-access sessions: the workspace's live
      // sessions running with approvals off — enumerated eagerly like the
      // overlap probe, so the check cannot disagree with the store doctor
      // just listed. With --session exactly one session is checked (the
      // workspace filter is bypassed: the operator named it). Best-effort
      // like the overlap probe: an unlistable store makes no claim.
      let fullAccessProbe: (() => FullAccessSession[]) | undefined;
      try {
        const fullAccess =
          doctorSession === undefined
            ? await listFullAccessSessions({
                sessionsRoot,
                workspace: process.cwd(),
              })
            : await describeFullAccessSession(sessionsRoot, doctorSession).then(
                (session) => (session === undefined ? [] : [session]),
              );
        fullAccessProbe = () => fullAccess;
      } catch {
        fullAccessProbe = undefined;
      }
      return runDoctorCommand(options, {
        ...view,
        // The grouped summary packs into the terminal's width.
        ...(process.stdout.columns === undefined
          ? {}
          : { columns: process.stdout.columns }),
        probeProviders: () => providerProbesOf(assembled),
        // Models on the fallback window: one warning each, naming the key.
        probeModelWindows: () => assembled.defaultedWindows,
        // The room a compaction leaves for the models the user can configure,
        // from the configured keys the lane boots with (absent: the defaults)
        // and the default model the configuration pins.
        probeContextRoom: () => {
          const keys = runtimeCompactionDeps(cliConfig);
          const pin = runtimeModelPin(cliConfig);
          return contextRoomProbeOf(assembled, {
            ...(pin === undefined
              ? {}
              : { defaultModel: { provider: pin.provider, id: pin.id } }),
            ...(keys?.reserveTokens === undefined
              ? {}
              : { reserveTokens: keys.reserveTokens }),
            ...(keys?.keepRecentTokens === undefined
              ? {}
              : { keepRecentTokens: keys.keepRecentTokens }),
          });
        },
        checkDeps: () => [
          {
            id: 'node',
            ok: major > 22 || (major === 22 && minor >= 19),
            detail: `node ${process.versions.node} (need >=22.19)`,
          },
          // The config load is reported here — a refused config
          // (unknown/unsupported key, distrusted project layer, secret ref)
          // and an incomplete runtime ignore split both fail
          // closed with the named reason instead of being silently ignored.
          doctorConfigProbe(cliConfig),
          // Which models.json files were found, their scope and
          // trust state; an invalid file fails by name.
          modelsSourcesProbe(assembled),
        ],
        // Config-sourced approval policy: the route/autoApprove
        // come from the loaded layers, not a hardcoded default.
        loadPolicy: doctorPolicyLoader(cliConfig),
        // Installed policy: the classes, guards and source
        // a run from THIS cwd actually installs — the same derivation
        // (host/approvals.installedPolicyPosture) `kubic run` boots the lane
        // with, over the same config projection it uses. Doctor reports the
        // INSTALLED posture, so the line cannot describe a policy no run
        // enforces; the config-sourced route above stays its own check.
        installedPolicy: () =>
          installedPolicyPosture({
            workspace: process.cwd(),
            // With --session the installed posture reads that
            // session's posture.json, so a full-access session reports
            // FULL ACCESS instead of the workspace-level false.
            ...(doctorSessionDir === undefined
              ? {}
              : { sessionDir: doctorSessionDir }),
            ...installedPolicyDeps(cliConfig),
          }),
        // Enterprise policy: the SAME effective resolution
        // `kubic policy` reports, checked for enforceability. `syslogAvailable`
        // is probed for real now: every enterprise syslog target
        // must be reachable, or the check fails closed instead of claiming
        // an audit trail that does not exist. The probe is wired only for a
        // configured `[policy]`, so the default matrix is unchanged.
        ...(enterprisePolicy === undefined || !policyConfigured
          ? {}
          : {
              enterpriseChecks: () =>
                enterpriseDoctorChecks(enterprisePolicy, {
                  syslogAvailable: enterprisePolicy.audit.sinks.every(
                    (sink) =>
                      sink.kind !== 'syslog' ||
                      isSyslogTargetAvailable(sink.target, auditProbes),
                  ),
                }),
            }),
        // Configured `[[audit]]` sinks: the SAME tables
        // dispatch built this process's sinks from, probed for reachability
        // plus the runtime failures recorded so far. Wired only when tables
        // exist, so the default matrix is unchanged.
        ...(cliConfig.runtime?.config.audit === undefined ||
        cliConfig.runtime.config.audit.length === 0
          ? {}
          : {
              probeAuditSinks: () =>
                auditSinksDoctorChecks({
                  tables: cliConfig.runtime?.config.audit ?? [],
                  problems: buildConfiguredSinks(
                    cliConfig.runtime?.config.audit ?? [],
                  ).problems,
                  snapshot: auditSinkSnapshot(),
                  probes: auditProbes,
                }),
            }),
        // Role-document posture: the SAME probe `kubic run
        // --role <name>` uses to select and validate a role, run over this
        // cwd's `.kubic/roles/*.md`. A contradictory document (declared
        // classes vs tool set) or a parse refusal is reported here with the
        // resolver's named reason, so a role the lane would refuse is
        // visible before the run instead of at boot. Absent or empty
        // directory reports clean.
        probeRoles: () =>
          rolesDoctorProbe({
            cwd: process.cwd(),
            bridge: createNodeFileBridge(process.cwd()),
            // Judge the roles the run would resolve — the
            // project root's documents, not the subdir's (absent) ones.
            projectRoot: cliConfig.projectRoot,
            // A role declaring an enterprise-denied tool is
            // refused by `kubic run --role`, so it is red here too.
            ...(enterprisePolicy === undefined
              ? {}
              : { toolPolicy: enterprisePolicy }),
            // The config `[roles.<name>]` layers `kubic run --role` merges
            // under each document: a role is judged as it would run.
            ...(roleLayers === undefined ? {} : { layers: roleLayers }),
            // Judge the effective classes the lane
            // would install — the most restrictive merge with each role.
            ...installedPolicyClasses(cliConfig),
            // Judge the trust the run would see —
            // an untrusted root's withheld roles warn here, never green.
            trustProject: projectTrustFor(cliConfig),
            // Judge the global roles the run would see —
            // absent (tests and embeddings with no home) means no source.
            ...(cliConfig.trust.home === ''
              ? {}
              : { home: cliConfig.trust.home }),
          }),
        // Skills gate: the same boot the lane runs,
        // judged with the lane's classes and no role — a skill the lane
        // would not offer warns with the gate's reason, never green. The
        // trust inputs mirror `kubic run`'s (env opt-in + the per-path
        // project check), so doctor judges the tree the run would see.
        probeSkills: () =>
          skillsDoctorProbe({
            bridge: createNodeFileBridge(process.cwd()),
            cwd: process.cwd(),
            homeDir: homedir(),
            trusted:
              process.env.KUBIC_TRUST_PROJECT === '1' ||
              process.env.KUBIC_TRUST_PROJECT === 'true',
            trustProject: projectTrustFor(cliConfig),
            ...runtimeSkillsDeps(cliConfig),
            ...installedPolicyClasses(cliConfig),
          }),
        // Repo-level session overlap: warning only — the check
        // reports warn (never exit-flipping) when 2+ sessions are recorded
        // against this cwd, stating the end-of-run sweep's blind spot.
        ...(sessionOverlapProbe === undefined
          ? {}
          : { probeSessionOverlap: sessionOverlapProbe }),
        // Full-access sessions: one warning per live
        // session running with approvals off (named grant recorded). With
        // --session exactly the named session is checked.
        ...(fullAccessProbe === undefined
          ? {}
          : { probeFullAccessSessions: fullAccessProbe }),
        // Always injected — the check itself is a pass when the
        // state directories are private.
        probeStatePermissions: statePermissionProbe,
      });
    },
    cost: (options) =>
      // Per-agent cost over real session usage (scoped
      // to the invoking project unless --all, grouped by --by); the task
      // total is Σ(rows) by construction.
      runCostCommand(options, {
        loadRows: (sessionId, query) =>
          loadSessionCostRows(undefined, sessionId, query),
        workspace: process.cwd(),
        ...report(),
      }),
    policy: (options, cliConfig) => {
      // A refused config is never answered around: the
      // offer and the run must agree, so `kubic policy` reports the refusal
      // instead of printing a decision a run would never enforce.
      if (cliConfig.runtime === undefined && cliConfig.error !== undefined) {
        debug(`error: ${cliConfig.error}`);
        return { exitCode: EXIT_FAILED };
      }
      // The tool policy a run from THIS cwd actually installs:
      // the enterprise policy merged with the same installed class
      // allowlist `kubic run` boots with and `kubic doctor` reports — so the
      // three surfaces cannot disagree. Deny-by-default still holds once the
      // installed allowlist is supplied; the deciding layer is named.
      const posture = installedPolicyPosture({
        workspace: process.cwd(),
        ...installedPolicyDeps(cliConfig),
      });
      const enterprisePolicy = runtimePolicy(cliConfig);
      return runPolicyCommand(options, {
        resolvePolicy: () =>
          enterprisePolicy === undefined
            ? // No loaded config (a direct-call seam): the installed class
              // allowlist is the whole policy, exactly as before.
              policyFromInstalledAllowlist(posture.allowlist)
            : policyWithInstalledAllowlist(enterprisePolicy, posture.allowlist),
        // The same posture's inexpressible levels, so
        // `kubic policy` and `kubic doctor` name the same unsupported set.
        unsupported: () => posture.unsupported,
        ...report(),
      });
    },
    config: (options, cliConfig) =>
      // Effective configuration with the layer each value came from: human
      // lines, or --json for machines. Fails closed on a broken config instead
      // of printing defaults.
      runConfigCommand(options, {
        ...presentation(out, debug, options.json === true),
        load: kubicConfigLoader(cliConfig),
      }),
    audit: (options) =>
      // Audit query over the repo-root ledger (one OrgAuditRecord per
      // line, <repo>/.kubic/audit/audit.jsonl): the approval layer writes
      // every decision there through emitAudit.
      // loadSecrets is the prod inventory hook: every printed record is
      // redacted against it, so a listed value never echoes via --json.
      runAuditCommand(options, {
        loadRecords: () => readAuditLedger(auditLedgerDirFor(process.cwd())),
        loadSecrets: loadProdAuditSecrets,
        ...report(),
      }),
    eval: (options, cliConfig) =>
      // Analysis surfaces: the eval/benchmark presentation layer is
      // library-owned (packages/eval/src/cli.ts, read-only); the root only
      // supplies prod deps. Worktree cleanliness is a real git probe
      // (packages/exec); the suite runner is the live one — each built-in
      // suite's fixture runs through the lane and is scored from the
      // trajectory it writes.
      runEvalCommand(options, {
        runSuite: createProdRunSuite(options, cliConfig),
        ensureCleanWorktree: (worktree: string) => isGitWorktreeClean(worktree),
        // --trajectory takes a file path (or `-` for
        // stdin) like export/replay; relative to the user's cwd.
        readFile: (path: string) =>
          createNodeFileBridge(process.cwd()).readTextFile(path),
        readStdin: readStdinText,
        ...report(),
      }),
    benchmark: (options, cliConfig) =>
      runBenchmarkCommand(options, {
        runSuite: createProdRunSuite(options, cliConfig),
        ensureCleanWorktree: (worktree: string) => isGitWorktreeClean(worktree),
        ...report(),
      }),
    replay: (options, cliConfig) => {
      const enterprisePolicy = runtimePolicy(cliConfig);
      // The live re-execution tiers boot the real lane,
      // so they compact under the configured policy like `kubic run`.
      const compaction = runtimeCompactionDeps(cliConfig);
      // The same prompt augmentation on the re-executed tiers.
      const systemPromptSection = runtimeSystemPromptSection(cliConfig);
      // `--session <id>`: the session's own trajectory file.
      const resolved = resolveSessionTrajectory(options, defaultSessionsRoot());
      if ('error' in resolved) return usageError(resolved.error);
      // Replay at a declared tier: recorded/compare are
      // log-only; deterministic/live re-execute the recorded objective
      // through the real lane at the declared model pin.
      // The runtime object is built
      // against the named type, so a dropped or mistyped projection fails
      // compile — the spreads below are checked, not carried unchecked.
      const runtime: ReplayRuntimeDeps = {
        ...runtimeRunDeps(cliConfig),
        trustProject: projectTrustFor(cliConfig),
        ...(enterprisePolicy === undefined
          ? {}
          : { modelPolicy: enterprisePolicy }),
        // The shared lane projections `kubic run` threads
        // (agent id + config-sourced role layers + the out-of-scope
        // paths) — the pinned role merges under them identically.
        ...runtimeLaneDeps(cliConfig),
        ...(compaction === undefined ? {} : { compaction }),
        ...(systemPromptSection === undefined ? {} : { systemPromptSection }),
        skills: { ...runtimeSkillsDeps(cliConfig) },
      };
      return runReplayCommand(
        resolved.options,
        {
          ...report(),
          run: (request, runtime) => runProdReplay(request, runtime),
        },
        // The re-execution tiers consume the effective config
        // like `kubic run` — same runtime projections, same lane policy.
        // And the same per-path trust check, so the
        // assembled catalog gates the project models.json on its own root.
        // Enterprise policy: and the same model/tool/role
        // gates — a live re-execution is not an ungated lane.
        runtime,
      );
    },
    export: (options) => {
      const resolved = resolveSessionTrajectory(options, defaultSessionsRoot());
      if ('error' in resolved) return usageError(resolved.error);
      // Trajectory inspection + RL dataset export: reads
      // trajectory export file(s) through the exec FileBridge.
      return runTrajectoryExportCommand(resolved.options, {
        // Relative to the user's working directory (a '/'-rooted bridge
        // turned `--trajectory t.json` into `/t.json`).
        readFile: (path: string) =>
          createNodeFileBridge(process.cwd()).readTextFile(path),
        // The batch mode's filesystem seam — listing resolves
        // the --dataset directory/glob, the JSONL streams one line at a
        // time, and the manifest lands beside it.
        listDir: (path: string) =>
          createNodeFileBridge(process.cwd())
            .listDir(path)
            .map((entry) => ({
              name: entry.name,
              isDirectory: entry.isDirectory,
            })),
        writeFile: (path: string, content: string) =>
          createNodeFileBridge(process.cwd()).writeFile(path, content),
        appendFile: (path: string, content: string) =>
          createNodeFileBridge(process.cwd()).appendFile(path, content),
        ...report(),
      });
    },
  };

  // A usage refusal the handler never sees: one `error:` line, exit 2.
  function usageError(message: string): CommandResult {
    createLineLogger(debug, { theme: stderrTheme() }).error(message);
    return { exitCode: EXIT_USAGE };
  }
}
