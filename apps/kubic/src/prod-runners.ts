// Production wiring for the command dispatch (issue #135): one runner per
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

import { EXIT_USAGE } from '../../../packages/core/src/cli/exit-codes.js';
import {
  type CliLogger,
  createLineLogger,
  debugEnabled,
} from '../../../packages/core/src/cli/logger.js';
import { outputModeFor } from '../../../packages/core/src/cli/output.js';
import { promptConfirm } from '../../../packages/core/src/cli/prompt.js';
import {
  type CliTheme,
  createCliTheme,
  detectColorLevel,
  themeFor,
} from '../../../packages/core/src/cli/theme.js';
import {
  runBenchmarkCommand,
  runEvalCommand,
} from '../../../packages/eval/src/cli.js';
import { runExportCommand as runTrajectoryExportCommand } from '../../../packages/eval/src/export-cli.js';
import { NodeExecutionEnv } from '../../../packages/exec/src/env.js';
import { createNodeFileBridge } from '../../../packages/exec/src/file-bridge.js';
import { isGitWorktreeClean } from '../../../packages/exec/src/git-clean.js';
import { installedPolicyPosture } from '../../../packages/host/src/approvals.js';
import { runConfigCommand } from '../../../packages/host/src/config/config-cli.js';
import type { SessionOverlapProbe } from '../../../packages/host/src/doctor.js';
import { runDoctorCommand } from '../../../packages/host/src/doctor.js';
import {
  FAUX_NOTICE,
  fauxProviderActive,
} from '../../../packages/host/src/faux-provider.js';
import { runGitCommand } from '../../../packages/host/src/git-cli.js';
import { runJournalCommand } from '../../../packages/host/src/journal-cli.js';
import {
  assembleModels,
  modelsSourcesProbe,
  providerProbesOf,
  runModelsCommand,
} from '../../../packages/host/src/models-cli.js';
import {
  loadSessionCostRows,
  runCostCommand,
} from '../../../packages/host/src/ops/cost/cost-cli.js';
import { runPerfCommand } from '../../../packages/host/src/ops/perf/perf-cli.js';
import { runOrchestrateCommand } from '../../../packages/host/src/orchestrate-cli.js';
import {
  cleanDepsWithDefaults,
  runCleanCommand,
} from '../../../packages/host/src/orchestrator/worktree/clean.js';
import {
  loadProdAuditSecrets,
  runAuditCommand,
} from '../../../packages/host/src/policy/audit-cli.js';
import {
  auditLedgerDirFor,
  readAuditLedger,
} from '../../../packages/host/src/policy/audit-ledger.js';
import {
  policyFromInstalledAllowlist,
  runPolicyCommand,
} from '../../../packages/host/src/policy/policy-cli.js';
import { runReplayCommand } from '../../../packages/host/src/replay/replay.js';
import { rolesDoctorProbe } from '../../../packages/host/src/roles/roles-boot.js';
import { runRunCommand } from '../../../packages/host/src/run-cli.js';
import {
  defaultSessionsRoot,
  runSessionsCommand,
} from '../../../packages/host/src/sessions-cli.js';
import { runWorkersCommand } from '../../../packages/host/src/workers-cli.js';
import {
  openSessionStore,
  sessionsTouchingWorkspace,
} from '../../../packages/worker/src/lane/session-store.js';
import { workersListFromRepo } from '../../../packages/worker/src/lifecycle/rows.js';
import { BACKGROUND_CONTEXT } from '../../../packages/worker/src/pi-boundary.js';
import {
  approvalSnapshotFrom,
  doctorConfigProbe,
  doctorPolicyLoader,
  installedPolicyClasses,
  installedPolicyDeps,
  kubicConfigLoader,
  runtimeApprovalDeps,
  runtimeLaneDeps,
  runtimeModelPin,
  runtimeRunDeps,
  sessionRetentionDays,
} from './config-runtime.js';
import type { DispatchRunners } from './dispatch.js';
import {
  extensionPostureForDoctor,
  loadExtensionStartup,
} from './extension-startup.js';
import { runHeadlessPrompt } from './headless-run.js';
import { orchestrateDepsWithDefaults } from './orchestrate-run.js';
import { runProdReplay } from './replay-run.js';
import { resolveSessionTrajectory } from './run-trajectory.js';
import { runTuiCommand, tuiDepsWithDefaults } from './tui-run.js';

// The two channels the root wired: `kubic` output on stdout, diagnostics
// (workers/orchestrate debug lines, the TUI extension receipt) on stderr.
export interface ProdRunnerIo {
  readonly out: (line: string) => void;
  readonly debug: (line: string) => void;
}

// Suite execution is injected: the binary scores recorded trajectories
// (--trajectory path, fully live); live task execution has no model-backed
// suite runner here, so --task refuses fail-closed instead of scoring
// fiction. The message is the documented refusal, surfaced verbatim by the
// eval/benchmark CLI as `eval error: <message>`.
const LIVE_SUITE_REFUSAL =
  'live suite execution is not available in this binary: score a recorded trajectory with --trajectory (see packages/eval/COMMUNITY.md)';

async function refuseLiveSuite(): Promise<never> {
  throw new Error(LIVE_SUITE_REFUSAL);
}

// The presentation seams of one solo-command invocation, derived once from
// the real streams: colour for stdout data (none off a TTY, under NO_COLOR,
// or for --json), the stderr diagnostics logger (debug lines under
// KUBIC_DEBUG=1), box-drawn tables and prompts only on an interactive
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

// The report colours for stdout: NO_COLOR / FORCE_COLOR / TERM=dumb and a
// non-TTY stdout all turn them off (the handlers also drop them under
// --json).
function stdoutTheme(): CliTheme {
  return themeFor(process.stdout);
}

// The diagnostics colours for stderr, decided from stderr's own TTY state
// (the logger contract: colour only on a TTY) — never from stdout's.
function stderrTheme(): CliTheme {
  return themeFor(process.stderr);
}

const PLAIN = createCliTheme('none');

// Report colours and table style for a migrated command, decided once from
// the real stdout: colour only on a TTY that allows it (NO_COLOR,
// FORCE_COLOR, TERM=dumb honoured), box-drawn tables only there too, and
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

export function createProdRunners(io: ProdRunnerIo): DispatchRunners {
  const { out, debug } = io;
  // The analysis handlers' channels: the report on stdout, diagnostics on
  // stderr (the `debug` channel), report colour and box drawing from the
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
  return {
    sessions: (invocation, cliConfig) => {
      // Issue #119: `sessions prune`'s default keep-window comes from config
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
      // Issue #119: the same `session.retentionDays` projection `sessions
      // prune` reads — `log` self-heals aged entries of a session journal at
      // read time under it. Unset (or a refused config) leaves the read path
      // without a window: it then writes nothing.
      const retentionDays = sessionRetentionDays(cliConfig);
      return runJournalCommand(request, {
        out,
        err: debug,
        errTheme: request.json === true ? PLAIN : stderrTheme(),
        ...reportStyle(request.json === true),
        ...(retentionDays === undefined ? {} : { retentionDays }),
      });
    },
    models: async (options) => {
      const view = presentation(out, debug, options.json === true);
      const assembled = await assembleModels(process.cwd());
      for (const note of assembled.notes) view.logger.info(note);
      if (fauxProviderActive(process.env)) view.logger.warn(FAUX_NOTICE);
      return runModelsCommand(options, {
        ...view,
        models: assembled.models,
        providers: assembled.providers,
      });
    },
    run: (options, cliConfig) =>
      runRunCommand(options, {
        ...presentation(out, debug, options.json === true),
        run: (prompt, options) =>
          runHeadlessPrompt(prompt, options, {
            model: runtimeModelPin(cliConfig),
            ...runtimeRunDeps(cliConfig),
            // Issue #133: the shared lane projections — the configured agent
            // id (journal attribution, `kubic diff --agent`) and the
            // config-sourced role layers `--role` merges under the document.
            ...runtimeLaneDeps(cliConfig),
          }),
      }),
    tui: async (options, cliConfig) => {
      // Extension startup (issue #93): the TUI lane loads the first-party
      // bundle set at dispatch, through the same gates — a degraded load
      // throws here (named ExtensionStartupError) instead of opening the
      // alt-screen on a run whose extensions never loaded.
      await loadExtensionStartup('tui', process.cwd(), {
        receipt: debug,
      });
      return runTuiCommand(
        options,
        tuiDepsWithDefaults({
          out,
          // `error:` lines (unknown session, no models) are diagnostics.
          err: debug,
          // Same policy install as `kubic run` (issue #86; #90 classes): the
          // TUI drives the same solo lane, so a config that names classes
          // must reach it here too.
          ...installedPolicyClasses(cliConfig),
          policySource: installedPolicyDeps(cliConfig).source,
          // Issue #230: the config `[approvals]` policy, same as `kubic run`.
          approvals: runtimeApprovalDeps(cliConfig),
          // Issue #113 (§42.4): the same journal retention projection `kubic
          // run` threads — a TUI session's journal age-prunes under config.
          journalRetention: runtimeRunDeps(cliConfig).journalRetention,
          // Issue #115 (§35/§42.5): the same out-of-scope projection — the
          // interactive lane's baseline and sweep exclude what `kubic run`
          // excludes.
          reconcileOutOfScope: runtimeRunDeps(cliConfig).reconcileOutOfScope,
          // Issue #295 with #227 (§38.1): the SAME model projection `kubic
          // run` consumes — the cli `--model` (above `KUBIC_MODEL`/`[model]`)
          // included. Without it the TUI ignored those pins and ran the first
          // registered provider.
          model: runtimeModelPin(cliConfig),
          // Issue #133: the SAME lane projections `kubic run` consumes — the
          // interactive lane names itself and layers `--role` identically.
          ...runtimeLaneDeps(cliConfig),
        }),
      );
    },
    doctor: async (options, cliConfig) => {
      // Default probes are faux-only: providers are listed (never dialed),
      // deps check the live node runtime, policy falls back to host
      // defaults until config-sourced policy lands.
      const view = presentation(out, debug, options.json === true);
      const assembled = await assembleModels(process.cwd());
      for (const note of assembled.notes) view.logger.info(note);
      if (fauxProviderActive(process.env)) view.logger.warn(FAUX_NOTICE);
      const [major = 0, minor = 0] = process.versions.node
        .split('.')
        .map((part) => Number(part));
      // The extension startup load happens ONCE here (issue #93): the object
      // every lane also loads, taken as data so the checks below can print a
      // named failure instead of the process dying before it reports.
      const extensionPosture = await extensionPostureForDoctor();
      // Repo-level session overlap (issue #118; §42.5): the local session
      // store's view of the sessions recorded against this cwd. Best-effort:
      // an unlistable store makes NO claim (the probe stays un-injected)
      // rather than crashing doctor — the note is informational, so an
      // unreadable store must not turn into a failure of its own.
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
      return runDoctorCommand(options, {
        ...view,
        probeProviders: () => providerProbesOf(assembled),
        checkDeps: () => [
          {
            id: 'node',
            ok: major > 22 || (major === 22 && minor >= 19),
            detail: `node ${process.versions.node} (need >=22.19)`,
          },
          // Issue #90: the config load is reported here — a refused config
          // (unknown/unsupported key, distrusted project layer, [budgets],
          // secret ref) and an incomplete runtime ignore split both fail
          // closed with the named reason instead of being silently ignored.
          doctorConfigProbe(cliConfig),
          // Issue #322: which models.json files were found, their scope and
          // trust state; an invalid file fails by name.
          modelsSourcesProbe(assembled),
        ],
        // Config-sourced approval policy (issue #90): the route/autoApprove
        // come from the loaded layers, not a hardcoded default.
        loadPolicy: doctorPolicyLoader(cliConfig),
        // Installed policy (issue #86; §40.3): the classes, guards and source
        // a run from THIS cwd actually installs — the same derivation
        // (host/approvals.installedPolicyPosture) `kubic run` boots the lane
        // with, over the same config projection it uses. Doctor reports the
        // INSTALLED posture, so the line cannot describe a policy no run
        // enforces; the config-sourced route above stays its own check.
        installedPolicy: () =>
          installedPolicyPosture({
            workspace: process.cwd(),
            ...installedPolicyDeps(cliConfig),
          }),
        // First-party extensions (issues #80, #93): doctor reports the SAME
        // startup object the lanes boot with — the load below is the one
        // shared loader (packages/extensions/src/startup.ts), projected to
        // the posture shape. No second probe exists, so the counts cannot
        // drift from what actually loaded; a degraded load reports the
        // named failure.
        probeExtensions: () => extensionPosture,
        // §40.3 role-document posture (issue #99): the SAME probe `kubic run
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
          }),
        // Repo-level session overlap (issue #118): warning only — the check
        // reports warn (never exit-flipping) when 2+ sessions are recorded
        // against this cwd, stating the end-of-run sweep's blind spot.
        ...(sessionOverlapProbe === undefined
          ? {}
          : { probeSessionOverlap: sessionOverlapProbe }),
      });
    },
    orchestrate: async (options, cliConfig) => {
      // Opt-in orchestrator mode (issue #76): the EPIC E stack (manager
      // lane, worker lifecycle, merge queue, approvals, worktrees) executes
      // for real. Solo stays the default — `run` never enters this path.
      // Issue #106 (§45.2): the manager's own approval snapshot travels into
      // the run so a delegated conflict resolver is spawned under exactly
      // the policy the manager holds — the same config load this process
      // already consumed, never a second default.
      return runOrchestrateCommand(
        options,
        await orchestrateDepsWithDefaults({
          out,
          // Diagnostics (`error: … code=…`) share the stderr channel.
          err: debug,
          theme: stdoutTheme(),
          errTheme: stderrTheme(),
          debug,
          ...(cliConfig.runtime === undefined
            ? {}
            : { approvalPolicy: approvalSnapshotFrom(cliConfig.runtime) }),
          // Issue #133: the runtime `[orchestrator]` projection (worktree
          // parent + worker cap, validated at load) — the same values the
          // dispatch shipped to the repo's exclude rules above.
          ...(cliConfig.runtime === undefined
            ? {}
            : { orchestrator: cliConfig.runtime.orchestrator }),
        }),
      );
    },
    clean: (options, cliConfig) =>
      // Explicit-only disposer for retained orchestrator worktrees/branches
      // (issue #92, §42.4/§44.1/§78): the library path owns planning and
      // git. Issue #133: the spawned set's parent comes from the same
      // config load, so `kubic clean` finds what orchestrate created.
      runCleanCommand(
        options,
        cleanDepsWithDefaults({
          env: new NodeExecutionEnv(process.cwd()),
          out,
          err: debug,
          theme: stdoutTheme(),
          errTheme: stderrTheme(),
          ...(cliConfig.runtime?.orchestrator.root === undefined
            ? {}
            : { worktreeRoot: cliConfig.runtime.orchestrator.root }),
        }),
      ),
    cost: (options) =>
      // Per-agent cost over real session stats (one aggregate row per
      // session); the task total is Σ(rows) by construction (issue #79).
      runCostCommand(options, {
        loadRows: (sessionId) => loadSessionCostRows(undefined, sessionId),
        ...report(),
      }),
    perf: (options) =>
      // Perf-budget evaluation over measured or supplied samples (#79, #98).
      runPerfCommand(options, report()),
    policy: (options, cliConfig) =>
      // The tool policy a run from THIS cwd actually installs — the same
      // derivation (host/approvals.installedPolicyPosture) over the same
      // config load `kubic run` boots with and `kubic doctor` reports — so
      // the three surfaces cannot disagree. Deny-by-default still holds:
      // a tool outside the installed allowlist answers `deny`.
      runPolicyCommand(options, {
        resolvePolicy: () =>
          policyFromInstalledAllowlist(
            installedPolicyPosture({
              workspace: process.cwd(),
              ...installedPolicyDeps(cliConfig),
            }).allowlist,
          ),
        // Issue #166 (§40.2): the same posture's inexpressible levels, so
        // `kubic policy` and `kubic doctor` name the same unsupported set.
        unsupported: () =>
          installedPolicyPosture({
            workspace: process.cwd(),
            ...installedPolicyDeps(cliConfig),
          }).unsupported,
        ...report(),
      }),
    config: (options, cliConfig) =>
      // Effective configuration with the layer each value came from (issue
      // #90): human lines, or --json for machines. Fails closed on a broken
      // config instead of printing defaults.
      runConfigCommand(options, {
        ...presentation(out, debug, options.json === true),
        load: kubicConfigLoader(cliConfig),
      }),
    audit: (options) =>
      // Audit query over the repo-root §60 ledger (one OrgAuditRecord per
      // line, <repo>/.kubic/orchestrator/approvals/audit.jsonl): the
      // orchestrator approval layer writes every decision there through
      // emitAudit, and solo decisions share the file and the format.
      // loadSecrets is the prod inventory hook: every printed record is
      // redacted against it, so a listed value never echoes via --json.
      runAuditCommand(options, {
        loadRecords: () => readAuditLedger(auditLedgerDirFor(process.cwd())),
        loadSecrets: loadProdAuditSecrets,
        ...report(),
      }),
    workers: async (options) => {
      // Issue #94: the rows come from the SHARED durable record the
      // orchestration writes (`<repo>/.kubic/orchestrator/workers.json`).
      // The in-process WorkerRegistry is the orchestrator run's own view —
      // a fresh CLI process's registry is always empty, so a registry
      // branch here could only ever be dead (issue #94's finding, finished
      // in #132): the CLI reads the durable record directly. The table is
      // box-drawn only on an interactive, coloured stdout; `--debug` (or
      // KUBIC_DEBUG=1) adds the §50 spawn/exit lines on stderr.
      const theme = stdoutTheme();
      const mode = outputModeFor({
        json: options.json === true,
        stdinTTY: process.stdin.isTTY === true,
        stdoutTTY: process.stdout.isTTY === true,
        colorEnabled: theme.enabled,
      });
      return runWorkersCommand(
        { ...options, debug: debugEnabled(options) },
        {
          list: () => workersListFromRepo(process.cwd()),
          out,
          err: debug,
          debug,
          theme,
          errTheme: stderrTheme(),
          fancy: mode.fancy,
        },
      );
    },
    eval: (options) =>
      // Analysis surfaces (issue #78): the eval/benchmark presentation
      // layer is library-owned (packages/eval/src/cli.ts, read-only); the
      // root only supplies prod deps. Worktree cleanliness is a real git
      // probe (packages/exec).
      runEvalCommand(options, {
        runSuite: refuseLiveSuite,
        ensureCleanWorktree: (worktree: string) => isGitWorktreeClean(worktree),
        ...report(),
      }),
    benchmark: (options) =>
      runBenchmarkCommand(options, {
        runSuite: refuseLiveSuite,
        ensureCleanWorktree: (worktree: string) => isGitWorktreeClean(worktree),
        ...report(),
      }),
    replay: (options, cliConfig) => {
      // `--session <id>` (issue #383): the session's own trajectory file.
      const resolved = resolveSessionTrajectory(options, defaultSessionsRoot());
      if ('error' in resolved) return usageError(resolved.error);
      // Replay at a declared tier (issue #78): recorded/compare are
      // log-only; deterministic/live re-execute the recorded objective
      // through the real solo lane at the declared model pin.
      return runReplayCommand(
        resolved.options,
        {
          ...report(),
          run: (request, runtime) => runProdReplay(request, runtime),
        },
        // Issue #114: the re-execution tiers consume the effective config
        // like `kubic run` — same runtime projections, same lane policy.
        runtimeRunDeps(cliConfig),
      );
    },
    export: (options) => {
      const resolved = resolveSessionTrajectory(options, defaultSessionsRoot());
      if ('error' in resolved) return usageError(resolved.error);
      // Trajectory inspection + RL dataset export (issue #78): reads
      // trajectory export file(s) through the exec FileBridge.
      return runTrajectoryExportCommand(resolved.options, {
        // Relative to the user's working directory (a '/'-rooted bridge
        // turned `--trajectory t.json` into `/t.json`).
        readFile: (path: string) =>
          createNodeFileBridge(process.cwd()).readTextFile(path),
        ...report(),
      });
    },
  };

  // A usage refusal the handler never sees: one `error:` line, exit 2.
  function usageError(message: string): number {
    createLineLogger(debug, { theme: stderrTheme() }).error(message);
    return EXIT_USAGE;
  }
}
