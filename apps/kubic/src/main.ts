#!/usr/bin/env node
// kubic CLI composition root: argv in, exit code out. All logic lives in
// the packages; this file only wires.

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HELP_EXIT_OK,
  HELP_FLAGS,
} from '../../../packages/core/src/cli-help.js';
import { formatVersionLine } from '../../../packages/core/src/license.js';
import {
  runBenchmarkCommand,
  runEvalCommand,
} from '../../../packages/eval/src/cli.js';
import { runExportCommand as runTrajectoryExportCommand } from '../../../packages/eval/src/export-cli.js';
import { NodeExecutionEnv } from '../../../packages/exec/src/env.js';
import { createNodeFileBridge } from '../../../packages/exec/src/file-bridge.js';
import { isGitWorktreeClean } from '../../../packages/exec/src/git-clean.js';
import { ensureRuntimeExcludeRules } from '../../../packages/exec/src/runtime-exclude.js';
import { ExtensionStartupError } from '../../../packages/extensions/src/startup.js';
import { installedPolicyPosture } from '../../../packages/host/src/approvals.js';
import { runConfigCommand } from '../../../packages/host/src/config/config-cli.js';
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
import { runSessionsCommand } from '../../../packages/host/src/sessions-cli.js';
import { runWorkersCommand } from '../../../packages/host/src/workers-cli.js';
import { WorkerRegistry } from '../../../packages/worker/src/lifecycle/registry.js';
import { workersListFromRepo } from '../../../packages/worker/src/lifecycle/rows.js';
import {
  approvalSnapshotFrom,
  configRefusalExit,
  doctorConfigProbe,
  doctorPolicyLoader,
  installedPolicyClasses,
  installedPolicyDeps,
  kubicConfigLoader,
  loadCliConfig,
  runtimeModelPin,
  runtimeRunDeps,
} from './config-runtime.js';
import {
  extensionPostureForDoctor,
  loadExtensionStartup,
} from './extension-startup.js';
import { runHeadlessPrompt } from './headless-run.js';
import { orchestrateDepsWithDefaults } from './orchestrate-run.js';
import { runProdReplay } from './replay-run.js';
import { runTuiCommand, tuiDepsWithDefaults } from './tui-run.js';

// License identity (issue #59): version comes from this app's own
// package.json; the license half of the line is owned by core/license.ts.
// Walk up from this module: the src layout finds apps/kubic/package.json
// at once, while the dist layout (dist/apps/kubic/src/main.js, issue #74)
// has no sibling manifest, so the walk continues to the repo-root
// package.json — both declare the same 0.0.0 version.
function cliVersion(): string {
  // File access goes through the exec FileBridge (I/O confinement, §9):
  // the composition root never imports node:fs directly.
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let level = 0; level < 6; level++) {
      try {
        const pkg = JSON.parse(
          createNodeFileBridge(dir).readTextFile('package.json'),
        ) as { name?: unknown; version?: unknown };
        if (pkg.name === 'kubic' && typeof pkg.version === 'string') {
          return pkg.version;
        }
      } catch {
        // No (or unreadable) manifest here — keep walking up.
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Fall through to the default below.
  }
  return '0.0.0';
}

// The root dispatcher's usage line (issue #128): one string, printed by
// `--help`/`-h` (exit 0 — a help request is a successful invocation) and by
// the bare/unknown-command fallthrough (exit 1 — usage-on-no-args is the
// deliberate POSIX posture). Both exits are pinned by
// scripts/binary-contract.mjs; the two paths must never drift apart.
const ROOT_USAGE =
  'usage: kubic <sessions | git | models | diff | undo | log | status | run | orchestrate | clean | tui | doctor | config | workers | eval | benchmark | replay | export | cost | perf | policy | audit>';

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  // Issue #90 (design §35.1): one config load for the whole process — paths
  // per §35.1, the project layer behind the trust gate, documented env
  // overrides, fail-closed on unknown/unsupported keys, budget keys and
  // secret refs. Commands below consume it through the seams in
  // ./config-runtime.js; nothing here re-derives a default by hand.
  const cliConfig = loadCliConfig();
  // A refused config stops the agent-executing modes: they may not run on
  // built-in defaults while the user believes their config file is in force.
  // `config` and `doctor` still run so the named reason can be reported.
  const refusalExit = configRefusalExit(cliConfig, command);
  if (refusalExit !== undefined) {
    console.log(`error: ${cliConfig.error ?? 'config refused'}`);
    return refusalExit;
  }
  // Issue #91 (design §35, D34/D35): `.kubic/` runtime state must never
  // reach a user repo's commit path. Before either mode that creates it,
  // ship the runtime ignore rules into the repo-local exclude file
  // (idempotent, fail-open, never dirties a committed .gitignore) — so the
  // first run/orchestrate leaves `git status` clean while `.kubic/roles`
  // and `config.toml` stay trackable. Skipped outside a git repo.
  if (command === 'run' || command === 'orchestrate' || command === 'tui') {
    ensureRuntimeExcludeRules({ cwd: process.cwd() });
  }
  // Root-level help (issue #128): the #100 convention — one implementation in
  // core/cli-help.ts, applied before argv validation — reaches the dispatcher
  // too. Same line as the bare fallthrough below; only the exit code differs.
  if (HELP_FLAGS.includes(command ?? '')) {
    console.log(ROOT_USAGE);
    return HELP_EXIT_OK;
  }
  if (command === '--version' || command === '-V') {
    console.log(formatVersionLine(cliVersion()));
    return 0;
  }
  // Deliberate failure seam for the shipped-artifact contract (issue #128):
  // `kubic __crash-probe` throws a plain Error so the top-level catch-all's
  // `error: <message>` / KUBIC_DEBUG behavior is asserted end to end against
  // the real binary by scripts/binary-contract.mjs. Internal — not a
  // supported command and deliberately absent from ROOT_USAGE.
  if (command === '__crash-probe') {
    throw new Error('injected probe failure');
  }
  if (command === 'sessions') {
    return runSessionsCommand(rest, { out: (line) => console.log(line) });
  }
  if (command === 'git') {
    return runGitCommand(rest, {
      env: new NodeExecutionEnv(process.cwd()),
      out: (line) => console.log(line),
    });
  }
  if (
    command === 'diff' ||
    command === 'undo' ||
    command === 'log' ||
    command === 'status'
  ) {
    return runJournalCommand([command, ...rest], {
      out: (line) => console.log(line),
    });
  }
  if (command === 'models') {
    const assembled = assembleModels(process.cwd());
    if (assembled.note !== null) console.log(assembled.note);
    return runModelsCommand(rest, {
      models: assembled.models,
      out: (line) => console.log(line),
    });
  }
  if (command === 'run') {
    return runRunCommand(rest, {
      out: (line: string) => console.log(line),
      run: (
        prompt: string,
        options: { sessionId?: string; timeoutMs?: number; maxTurns?: number },
      ) =>
        runHeadlessPrompt(prompt, options, {
          model: runtimeModelPin(cliConfig),
          ...runtimeRunDeps(cliConfig),
        }),
    });
  }
  if (command === 'tui') {
    // Extension startup (issue #93): the TUI lane loads the first-party
    // bundle set at dispatch, through the same gates — a degraded load
    // throws here (named ExtensionStartupError) instead of opening the
    // alt-screen on a run whose extensions never loaded.
    await loadExtensionStartup('tui', process.cwd(), {
      receipt: (line) => console.error(line),
    });
    return runTuiCommand(
      rest,
      tuiDepsWithDefaults({
        out: (line: string) => console.log(line),
        // Same policy install as `kubic run` (issue #86; #90 classes): the
        // TUI drives the same solo lane, so a config that names classes
        // must reach it here too.
        ...installedPolicyClasses(cliConfig),
        policySource: installedPolicyDeps(cliConfig).source,
        // Issue #113 (§42.4): the same journal retention projection `kubic
        // run` threads — a TUI session's journal age-prunes under config.
        journalRetention: runtimeRunDeps(cliConfig).journalRetention,
      }),
    );
  }
  if (command === 'doctor') {
    // Default probes are faux-only: providers are listed (never dialed),
    // deps check the live node runtime, policy falls back to host
    // defaults until config-sourced policy lands.
    const assembled = assembleModels(process.cwd());
    if (assembled.note !== null) console.log(assembled.note);
    const [major = 0, minor = 0] = process.versions.node
      .split('.')
      .map((part) => Number(part));
    // The extension startup load happens ONCE here (issue #93): the object
    // every lane also loads, taken as data so the checks below can print a
    // named failure instead of the process dying before it reports.
    const extensionPosture = await extensionPostureForDoctor();
    return runDoctorCommand(rest, {
      out: (line: string) => console.log(line),
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
      // shared loader (packages/extensions/src/startup.ts), projected to the
      // posture shape. No second probe exists, so the counts cannot drift
      // from what actually loaded; a degraded load reports the named failure.
      probeExtensions: () => extensionPosture,
      // §40.3 role-document posture (issue #99): the SAME probe `kubic run
      // --role <name>` uses to select and validate a role, run over this
      // cwd's `.kubic/roles/*.md`. A contradictory document (declared classes
      // vs tool set) or a parse refusal is reported here with the resolver's
      // named reason, so a role the lane would refuse is visible before the
      // run instead of at boot. Absent or empty directory reports clean.
      probeRoles: () =>
        rolesDoctorProbe({
          cwd: process.cwd(),
          bridge: createNodeFileBridge(process.cwd()),
        }),
    });
  }
  if (command === 'orchestrate') {
    // Opt-in orchestrator mode (issue #76): the EPIC E stack (manager lane,
    // worker lifecycle, merge queue, approvals, worktrees) executes for
    // real. Solo stays the default — `run` never enters this path.
    // Issue #106 (§45.2): the manager's own approval snapshot travels into
    // the run so a delegated conflict resolver is spawned under exactly the
    // policy the manager holds — the same config load this process already
    // consumed, never a second default.
    return runOrchestrateCommand(
      rest,
      await orchestrateDepsWithDefaults({
        out: (line: string) => console.log(line),
        debug: (line: string) => console.error(line),
        ...(cliConfig.runtime === undefined
          ? {}
          : { approvalPolicy: approvalSnapshotFrom(cliConfig.runtime) }),
      }),
    );
  }
  if (command === 'clean') {
    // Explicit-only disposer for retained orchestrator worktrees/branches
    // (issue #92, §42.4/§44.1/§78): the library path owns planning and git.
    return runCleanCommand(
      rest,
      cleanDepsWithDefaults({
        env: new NodeExecutionEnv(process.cwd()),
        out: (line: string) => console.log(line),
      }),
    );
  }
  if (command === 'cost') {
    // Per-agent cost over real session stats (one aggregate row per
    // session); the task total is Σ(rows) by construction (issue #79).
    return runCostCommand(rest, {
      loadRows: (sessionId) => loadSessionCostRows(undefined, sessionId),
      out: (line: string) => console.log(line),
    });
  }
  if (command === 'perf') {
    // Perf-budget evaluation over argv samples (faux-only, issue #79).
    return runPerfCommand(rest, {
      out: (line: string) => console.log(line),
    });
  }
  if (command === 'policy') {
    // Routing offer over the enterprise default (deny-by-default): the
    // enterprise policy engine is its own surface — the config-sourced
    // APPROVAL policy (route/autoApprove) is reported by `kubic config`.
    return runPolicyCommand(rest, {
      resolvePolicy: () => resolveEffectivePolicy([]).policy,
      out: (line: string) => console.log(line),
    });
  }
  if (command === 'config') {
    // Effective configuration with the layer each value came from (issue
    // #90): human lines, or --json for machines. Fails closed on a broken
    // config instead of printing defaults.
    return runConfigCommand(rest, {
      load: kubicConfigLoader(cliConfig),
      out: (line: string) => console.log(line),
    });
  }
  if (command === 'audit') {
    // Audit query over the record source (no audit persistence is wired
    // yet, so the one-shot CLI reads zero rows — filters and the
    // sentinel-only redaction are live, issue #79). loadSecrets is the
    // prod inventory hook (empty until persistence lands): wired
    // end-to-end now so persistence cannot forget it — without it a
    // non-shaped listed value would echo unredacted through --json.
    return runAuditCommand(rest, {
      loadRecords: () => [],
      loadSecrets: loadProdAuditSecrets,
      out: (line: string) => console.log(line),
    });
  }
  if (command === 'workers') {
    // Issue #94: the rows come from the SHARED durable record the
    // orchestration writes (`<repo>/.kubic/orchestrator/workers.json`),
    // not from a fresh empty `WorkerRegistry()` — that could only ever
    // list zero rows while a run was live, which is the defect. The
    // registry still backs the orchestrator's own in-process view.
    const registry = new WorkerRegistry();
    const code = await runWorkersCommand(rest, {
      list: () => {
        const live = registry.list();
        return live.length > 0 ? live : workersListFromRepo(process.cwd());
      },
      out: (line: string) => console.log(line),
      debug: (line: string) => console.error(line),
    });
    // runWorkersCommand reports usage as 1; the binary surfaces §78
    // usage errors as 2 (issue #77).
    return code === 1 ? 2 : code;
  }
  if (command === 'eval' || command === 'benchmark') {
    // Analysis surfaces (issue #78): the eval/benchmark presentation
    // layer is library-owned (packages/eval/src/cli.ts, read-only); the
    // root only supplies prod deps. Suite execution is injected: the
    // binary scores recorded trajectories (--trajectory path, fully
    // live); live task execution has no model-backed suite runner here,
    // so --task refuses fail-closed instead of scoring fiction.
    // Worktree cleanliness is a real git probe (packages/exec).
    const run = command === 'eval' ? runEvalCommand : runBenchmarkCommand;
    return run(rest, {
      runSuite: async () => {
        throw new Error(
          'live suite execution is not available in this binary: score a recorded trajectory with --trajectory (see packages/eval/COMMUNITY.md)',
        );
      },
      ensureCleanWorktree: (worktree: string) => isGitWorktreeClean(worktree),
      out: (line: string) => console.log(line),
    });
  }
  if (command === 'replay') {
    // Replay at a declared tier (issue #78): recorded/compare are
    // log-only; deterministic/live re-execute the recorded objective
    // through the real solo lane at the declared model pin.
    return runReplayCommand(
      rest,
      {
        out: (line: string) => console.log(line),
        run: (request, runtime) => runProdReplay(request, runtime),
      },
      // Issue #114: the re-execution tiers consume the effective config
      // like `kubic run` — same runtime projections, same lane policy.
      runtimeRunDeps(cliConfig),
    );
  }
  if (command === 'export') {
    // Trajectory inspection + RL dataset export (issue #78): reads
    // trajectory export file(s) through the exec FileBridge.
    return runTrajectoryExportCommand(rest, {
      readFile: (path: string) => createNodeFileBridge('/').readTextFile(path),
      out: (line: string) => console.log(line),
    });
  }
  console.log(ROOT_USAGE);
  return 1;
}

// Extension startup failures are named one-liners, not stack traces (issue
// #93): the lane boots above refuse to run bare, and the CLI reports that
// refusal as `error: …` with the failure exit code. That named path is
// unchanged.
//
// Every other unexpected failure (issue #128) gets the same operator-facing
// shape — one `error: <message>` line, exit 1 — instead of a raw stack dump;
// the full stack stays behind the KUBIC_DEBUG=1 opt-in. Both modes are
// pinned end to end by scripts/binary-contract.mjs (the `__crash-probe`
// seam above).
try {
  const code = await main(process.argv.slice(2));
  process.exit(code);
} catch (error) {
  if (error instanceof ExtensionStartupError) {
    console.error(`error: ${error.message}`);
    process.exit(1);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (process.env.KUBIC_DEBUG === '1') {
    console.error(error);
  }
  console.error(`error: ${message}`);
  process.exit(1);
}
