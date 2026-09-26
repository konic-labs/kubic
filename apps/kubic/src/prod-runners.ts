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
import { runGitCommand } from '../../../packages/host/src/git-cli.js';
import { runJournalCommand } from '../../../packages/host/src/journal-cli.js';
import {
  assembleModels,
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
import { resolveEffectivePolicy } from '../../../packages/host/src/policy/enterprise.js';
import { runPolicyCommand } from '../../../packages/host/src/policy/policy-cli.js';
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

export function createProdRunners(io: ProdRunnerIo): DispatchRunners {
  const { out, debug } = io;
  return {
    sessions: (rest, cliConfig) => {
      // Issue #119: `sessions prune`'s default keep-window comes from config
      // when it sets one; with none, prune demands an explicit --keep-days
      // rather than inventing a window.
      const retentionDays = sessionRetentionDays(cliConfig);
      return runSessionsCommand([...rest], {
        out,
        ...(retentionDays === undefined ? {} : { retentionDays }),
      });
    },
    git: (rest) =>
      runGitCommand([...rest], {
        env: new NodeExecutionEnv(process.cwd()),
        out,
      }),
    journal: (args, cliConfig) => {
      // Issue #119: the same `session.retentionDays` projection `sessions
      // prune` reads — `log` self-heals aged entries of a session journal at
      // read time under it. Unset (or a refused config) leaves the read path
      // without a window: it then writes nothing.
      const retentionDays = sessionRetentionDays(cliConfig);
      return runJournalCommand([...args], {
        out,
        ...(retentionDays === undefined ? {} : { retentionDays }),
      });
    },
    models: (rest) => {
      const assembled = assembleModels(process.cwd());
      if (assembled.note !== null) out(assembled.note);
      return runModelsCommand([...rest], {
        models: assembled.models,
        out,
      });
    },
    run: (rest, cliConfig) =>
      runRunCommand([...rest], {
        out,
        run: (prompt, options) =>
          runHeadlessPrompt(prompt, options, {
            model: runtimeModelPin(cliConfig),
            ...runtimeRunDeps(cliConfig),
          }),
      }),
    tui: async (rest, cliConfig) => {
      // Extension startup (issue #93): the TUI lane loads the first-party
      // bundle set at dispatch, through the same gates — a degraded load
      // throws here (named ExtensionStartupError) instead of opening the
      // alt-screen on a run whose extensions never loaded.
      await loadExtensionStartup('tui', process.cwd(), {
        receipt: debug,
      });
      return runTuiCommand(
        [...rest],
        tuiDepsWithDefaults({
          out,
          // Same policy install as `kubic run` (issue #86; #90 classes): the
          // TUI drives the same solo lane, so a config that names classes
          // must reach it here too.
          ...installedPolicyClasses(cliConfig),
          policySource: installedPolicyDeps(cliConfig).source,
          // Issue #113 (§42.4): the same journal retention projection `kubic
          // run` threads — a TUI session's journal age-prunes under config.
          journalRetention: runtimeRunDeps(cliConfig).journalRetention,
          // Issue #115 (§35/§42.5): the same out-of-scope projection — the
          // interactive lane's baseline and sweep exclude what `kubic run`
          // excludes.
          reconcileOutOfScope: runtimeRunDeps(cliConfig).reconcileOutOfScope,
        }),
      );
    },
    doctor: async (rest, cliConfig) => {
      // Default probes are faux-only: providers are listed (never dialed),
      // deps check the live node runtime, policy falls back to host
      // defaults until config-sourced policy lands.
      const assembled = assembleModels(process.cwd());
      if (assembled.note !== null) out(assembled.note);
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
      return runDoctorCommand([...rest], {
        out,
        probeProviders: () =>
          assembled.models.getProviders().map((provider) => ({
            id: provider.id,
            reachable: true,
            models: assembled.models
              .getModels(provider.id)
              .map((model) => model.id),
          })),
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
    orchestrate: async (rest, cliConfig) => {
      // Opt-in orchestrator mode (issue #76): the EPIC E stack (manager
      // lane, worker lifecycle, merge queue, approvals, worktrees) executes
      // for real. Solo stays the default — `run` never enters this path.
      // Issue #106 (§45.2): the manager's own approval snapshot travels into
      // the run so a delegated conflict resolver is spawned under exactly
      // the policy the manager holds — the same config load this process
      // already consumed, never a second default.
      return runOrchestrateCommand(
        [...rest],
        await orchestrateDepsWithDefaults({
          out,
          debug,
          ...(cliConfig.runtime === undefined
            ? {}
            : { approvalPolicy: approvalSnapshotFrom(cliConfig.runtime) }),
        }),
      );
    },
    clean: (rest) =>
      // Explicit-only disposer for retained orchestrator worktrees/branches
      // (issue #92, §42.4/§44.1/§78): the library path owns planning and
      // git.
      runCleanCommand(
        [...rest],
        cleanDepsWithDefaults({
          env: new NodeExecutionEnv(process.cwd()),
          out,
        }),
      ),
    cost: (rest) =>
      // Per-agent cost over real session stats (one aggregate row per
      // session); the task total is Σ(rows) by construction (issue #79).
      runCostCommand([...rest], {
        loadRows: (sessionId) => loadSessionCostRows(undefined, sessionId),
        out,
      }),
    perf: (rest) =>
      // Perf-budget evaluation over argv samples (faux-only, issue #79).
      runPerfCommand([...rest], { out }),
    policy: (rest) =>
      // Routing offer over the enterprise default (deny-by-default): the
      // enterprise policy engine is its own surface — the config-sourced
      // APPROVAL policy (route/autoApprove) is reported by `kubic config`.
      runPolicyCommand([...rest], {
        resolvePolicy: () => resolveEffectivePolicy([]).policy,
        out,
      }),
    config: (rest, cliConfig) =>
      // Effective configuration with the layer each value came from (issue
      // #90): human lines, or --json for machines. Fails closed on a broken
      // config instead of printing defaults.
      runConfigCommand([...rest], {
        load: kubicConfigLoader(cliConfig),
        out,
      }),
    audit: (rest) =>
      // Audit query over the record source (no audit persistence is wired
      // yet, so the one-shot CLI reads zero rows — filters and the
      // sentinel-only redaction are live, issue #79). loadSecrets is the
      // prod inventory hook (empty until persistence lands): wired
      // end-to-end now so persistence cannot forget it — without it a
      // non-shaped listed value would echo unredacted through --json.
      runAuditCommand([...rest], {
        loadRecords: () => [],
        loadSecrets: loadProdAuditSecrets,
        out,
      }),
    workers: async (rest) => {
      // Issue #94: the rows come from the SHARED durable record the
      // orchestration writes (`<repo>/.kubic/orchestrator/workers.json`).
      // The in-process WorkerRegistry is the orchestrator run's own view —
      // a fresh CLI process's registry is always empty, so a registry
      // branch here could only ever be dead (issue #94's finding, finished
      // in #132): the CLI reads the durable record directly. The §78 usage
      // remap (1 → 2) lives in the dispatch, after this runner returns.
      return runWorkersCommand([...rest], {
        list: () => workersListFromRepo(process.cwd()),
        out,
        debug,
      });
    },
    eval: (rest) =>
      // Analysis surfaces (issue #78): the eval/benchmark presentation
      // layer is library-owned (packages/eval/src/cli.ts, read-only); the
      // root only supplies prod deps. Worktree cleanliness is a real git
      // probe (packages/exec).
      runEvalCommand([...rest], {
        runSuite: refuseLiveSuite,
        ensureCleanWorktree: (worktree: string) => isGitWorktreeClean(worktree),
        out,
      }),
    benchmark: (rest) =>
      runBenchmarkCommand([...rest], {
        runSuite: refuseLiveSuite,
        ensureCleanWorktree: (worktree: string) => isGitWorktreeClean(worktree),
        out,
      }),
    replay: (rest, cliConfig) =>
      // Replay at a declared tier (issue #78): recorded/compare are
      // log-only; deterministic/live re-execute the recorded objective
      // through the real solo lane at the declared model pin.
      runReplayCommand(
        [...rest],
        {
          out,
          run: (request, runtime) => runProdReplay(request, runtime),
        },
        // Issue #114: the re-execution tiers consume the effective config
        // like `kubic run` — same runtime projections, same lane policy.
        runtimeRunDeps(cliConfig),
      ),
    export: (rest) =>
      // Trajectory inspection + RL dataset export (issue #78): reads
      // trajectory export file(s) through the exec FileBridge.
      runTrajectoryExportCommand([...rest], {
        readFile: (path: string) =>
          createNodeFileBridge('/').readTextFile(path),
        out,
      }),
  };
}
