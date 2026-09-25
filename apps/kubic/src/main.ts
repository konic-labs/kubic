#!/usr/bin/env node
// kubic CLI composition root: argv in, exit code out. All logic lives in
// the packages; this file only wires.

import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { probeFirstPartyPosture } from '../../../packages/extensions/src/startup.js';
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
import { runRunCommand } from '../../../packages/host/src/run-cli.js';
import { runSessionsCommand } from '../../../packages/host/src/sessions-cli.js';
import { runWorkersCommand } from '../../../packages/host/src/workers-cli.js';
import { WorkerRegistry } from '../../../packages/worker/src/lifecycle/registry.js';
import {
  doctorPolicyLoader,
  kubicConfigLoader,
  loadCliConfig,
  runtimeModelPin,
} from './config-runtime.js';
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

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  // Issue #90 (design §35.1): one config load for the whole process — paths
  // per §35.1, the project layer behind the trust gate, documented env
  // overrides, fail-closed on unknown/unsupported keys, budget keys and
  // secret refs. Commands below consume it through the seams in
  // ./config-runtime.js; nothing here re-derives a default by hand.
  const cliConfig = loadCliConfig();
  // Issue #91 (design §35, D34/D35): `.kubic/` runtime state must never
  // reach a user repo's commit path. Before either mode that creates it,
  // ship the runtime ignore rules into the repo-local exclude file
  // (idempotent, fail-open, never dirties a committed .gitignore) — so the
  // first run/orchestrate leaves `git status` clean while `.kubic/roles`
  // and `config.toml` stay trackable. Skipped outside a git repo.
  if (command === 'run' || command === 'orchestrate') {
    ensureRuntimeExcludeRules({ cwd: process.cwd() });
  }
  if (command === '--version' || command === '-V') {
    console.log(formatVersionLine(cliVersion()));
    return 0;
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
        }),
    });
  }
  if (command === 'tui') {
    return runTuiCommand(
      rest,
      tuiDepsWithDefaults({ out: (line: string) => console.log(line) }),
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
      ],
      loadPolicy: doctorPolicyLoader(cliConfig),
      // First-party extensions (issue #80): the startup probe loads the
      // on-disk bundle through the trust gates and reports loaded/refused
      // counts on the same checks — doctor fails closed when the bundle
      // dir is gone.
      probeExtensions: () => {
        const posture = probeFirstPartyPosture({
          anchorDir: dirname(fileURLToPath(import.meta.url)),
          files: createNodeFileBridge('/'),
          trust: { homeDir: homedir(), cwd: process.cwd(), allowlist: [] },
        });
        return {
          ok: posture.ok,
          loaded: posture.loaded,
          refusedCount: posture.refused.length,
          detail: posture.detail,
        };
      },
    });
  }
  if (command === 'orchestrate') {
    // Opt-in orchestrator mode (issue #76): the EPIC E stack (manager lane,
    // worker lifecycle, merge queue, approvals, worktrees) executes for
    // real. Solo stays the default — `run` never enters this path.
    return runOrchestrateCommand(
      rest,
      await orchestrateDepsWithDefaults({
        out: (line: string) => console.log(line),
        debug: (line: string) => console.error(line),
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
    // The one-shot CLI owns a fresh process registry: no orchestrator
    // runs in this process, so a live invocation lists zero rows (both
    // views agree, exit 0). Spawn/reap stay orchestrator-internal.
    const registry = new WorkerRegistry();
    const code = await runWorkersCommand(rest, {
      list: () => registry.list(),
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
    return runReplayCommand(rest, {
      out: (line: string) => console.log(line),
      run: (request) => runProdReplay(request),
    });
  }
  if (command === 'export') {
    // Trajectory inspection + RL dataset export (issue #78): reads
    // trajectory export file(s) through the exec FileBridge.
    return runTrajectoryExportCommand(rest, {
      readFile: (path: string) => createNodeFileBridge('/').readTextFile(path),
      out: (line: string) => console.log(line),
    });
  }
  console.log(
    'usage: kubic <sessions | git | models | diff | undo | log | status | run | orchestrate | clean | tui | doctor | config | workers | eval | benchmark | replay | export | cost | perf | policy | audit>',
  );
  return 1;
}

const code = await main(process.argv.slice(2));
process.exit(code);
