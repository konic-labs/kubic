// The production runners of the analysis commands: cost, policy, audit,
// eval, benchmark, replay and export.

import { EXIT_FAILED } from '@kubic/core/cli/exit-codes';
import { runBenchmarkCommand, runEvalCommand } from '@kubic/eval/cli';
import { runExportCommand as runTrajectoryExportCommand } from '@kubic/eval/export-cli';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import { isGitWorktreeClean } from '@kubic/exec/git-clean';
import { readStdinText } from '@kubic/exec/stdin';
import { installedPolicyPosture } from '@kubic/host/approvals';
import {
  auditLedgerDirFor,
  loadProdAuditSecrets,
  readAuditLedger,
  runAuditCommand,
} from '@kubic/host/audit';
import { loadSessionCostRows, runCostCommand } from '@kubic/host/cost';
import {
  policyFromInstalledAllowlist,
  policyWithInstalledAllowlist,
  runPolicyCommand,
} from '@kubic/host/policy';
import type { ReplayRuntimeDeps } from '@kubic/host/replay';
import { runReplayCommand } from '@kubic/host/replay';
import { defaultSessionsRoot } from '@kubic/host/sessions';
import { projectTrustFor } from '../config/load.js';
import { runtimePolicy } from '../config/model-selection.js';
import {
  installedPolicyDeps,
  runtimeCompactionDeps,
  runtimeLaneDeps,
  runtimeRunDeps,
  runtimeSkillsDeps,
  runtimeSystemPromptSection,
} from '../config/projections.js';
import { createProdRunSuite } from '../eval-prod.js';
import { runProdReplay } from '../replay-run.js';
import { resolveSessionTrajectory } from '../run/trajectory.js';
import type { ProdRunnerIo, ProdRunners } from './shared.js';
import { analysisReport, usageError } from './shared.js';

export function costRunner(io: ProdRunnerIo): ProdRunners['cost'] {
  return (options) =>
    // Per-agent cost over real session usage (scoped
    // to the invoking project unless --all, grouped by --by); the task
    // total is Σ(rows) by construction.
    runCostCommand(options, {
      loadRows: (sessionId, query) =>
        loadSessionCostRows(undefined, sessionId, query),
      workspace: process.cwd(),
      ...analysisReport(io),
    });
}

export function policyRunner(io: ProdRunnerIo): ProdRunners['policy'] {
  const { debug } = io;
  return (options, cliConfig) => {
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
      ...analysisReport(io),
    });
  };
}

export function auditRunner(io: ProdRunnerIo): ProdRunners['audit'] {
  return (options) =>
    // Audit query over the repo-root ledger (one OrgAuditRecord per
    // line, <repo>/.kubic/audit/audit.jsonl): the approval layer writes
    // every decision there through emitAudit.
    // loadSecrets is the prod inventory hook: every printed record is
    // redacted against it, so a listed value never echoes via --json.
    runAuditCommand(options, {
      loadRecords: () => readAuditLedger(auditLedgerDirFor(process.cwd())),
      loadSecrets: loadProdAuditSecrets,
      ...analysisReport(io),
    });
}

export function evalRunner(io: ProdRunnerIo): ProdRunners['eval'] {
  return (options, cliConfig) =>
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
      ...analysisReport(io),
    });
}

export function benchmarkRunner(io: ProdRunnerIo): ProdRunners['benchmark'] {
  return (options, cliConfig) =>
    runBenchmarkCommand(options, {
      runSuite: createProdRunSuite(options, cliConfig),
      ensureCleanWorktree: (worktree: string) => isGitWorktreeClean(worktree),
      ...analysisReport(io),
    });
}

export function replayRunner(io: ProdRunnerIo): ProdRunners['replay'] {
  const { out } = io;
  return (options, cliConfig) => {
    const enterprisePolicy = runtimePolicy(cliConfig);
    // The live re-execution tiers boot the real lane,
    // so they compact under the configured policy like `kubic run`.
    const compaction = runtimeCompactionDeps(cliConfig);
    // The same prompt augmentation on the re-executed tiers.
    const systemPromptSection = runtimeSystemPromptSection(cliConfig);
    // `--session <id>`: the session's own trajectory file.
    const resolved = resolveSessionTrajectory(options, defaultSessionsRoot());
    if ('error' in resolved) return usageError(io, resolved.error);
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
        ...analysisReport(io),
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
  };
}

export function exportRunner(io: ProdRunnerIo): ProdRunners['export'] {
  return (options) => {
    const resolved = resolveSessionTrajectory(options, defaultSessionsRoot());
    if ('error' in resolved) return usageError(io, resolved.error);
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
      ...analysisReport(io),
    });
  };
}
