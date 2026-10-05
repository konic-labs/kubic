// Prod `kubic orchestrate` deps (issue #76): the composition root drives the
// real EPIC E stack — git worktrees via addWorktree, worker runs as child
// `kubic run -p` processes inside their worktrees (one process per subagent),
// FIFO merge via `git merge` (a pre-merge guard aborts stale MERGE_HEAD
// and refuses dirty trees, plus abort-after-failure, so the tree is
// never half-merged), with a write-ahead merging intent per candidate
// (kill between merge and save reconciles via merge-base --is-ancestor
// instead of double-merging), and session state under
// <repo>/.kubic/orchestrator/<session>.json written atomically (tmp +
// rename, fail-closed) through the exec FileBridge. The manager authors nothing: worker commits run under
// worker provenance, merges are worker-branch merges, and every merge passes
// through the assertManagerZeroWrites gate in orchestrate-cli.ts.

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
// §67 (issue #191): the task and the capability grant travel together — the
// manager builds and validates the task it hands a worker child.
import {
  type AgentTask,
  buildAgentTask,
} from '../../../packages/agents/src/task.js';
import type { CliTheme } from '../../../packages/core/src/cli/theme.js';
import type { Shell, ShellResult } from '../../../packages/exec/src/env.js';
import {
  NodeExecutionEnv,
  ROOT_PROVENANCE,
} from '../../../packages/exec/src/env.js';
import {
  createNodeFileBridge,
  type FileBridge,
} from '../../../packages/exec/src/file-bridge.js';
import { snapshotGitGuard } from '../../../packages/exec/src/git-guard-snapshot.js';
import { ensureRuntimeExcludeRules } from '../../../packages/exec/src/runtime-exclude.js';
import type { PostureOptions } from '../../../packages/extensions/src/startup.js';
import { enableSessionFullAccess } from '../../../packages/host/src/approvals.js';
import {
  firstDeliverableProvider,
  type ProviderGrantResult,
  resolveProviderGrant,
  resolveWorkerProvider,
  type WorkerCredentialRefusal,
} from '../../../packages/host/src/config/role-credentials.js';
import type { RuntimeOrchestrator } from '../../../packages/host/src/config/runtime.js';
import { buildOrchestratorWorktreeNotice } from '../../../packages/host/src/limits/orchestrator-notice.js';
import {
  type AssembledModels,
  assembleModels,
  modelsProjectRootFor,
} from '../../../packages/host/src/models-cli.js';
import {
  RunSpans,
  serializeSpanArtifact,
} from '../../../packages/host/src/ops/perf/run-spans.js';
import type {
  MergeApprovalVerdict,
  OrchestrateCommandDeps,
  OrchestrateWorktree,
  OrchestratorRunState,
  ResolverOutcome,
  WorkerRunOutput,
  WorkerSpawnInfo,
  WorktreeRequest,
} from '../../../packages/host/src/orchestrate-cli.js';
import {
  MergeConflictError,
  ORCHESTRATE_APPROVAL_BOUND_MS,
  parseOrchestratorRunState,
  workerApprovalBoundMs,
  workerSessionFor,
} from '../../../packages/host/src/orchestrate-cli.js';
// The shared timeout-reason marker (issue #129): the elapse denial below
// interpolates THIS constant — never a copied literal — so the merge seat's
// wording cannot drift from the worker-ask convention.
import {
  BUDGET_EXHAUSTED,
  childBudgetOf,
  RUN_EXIT_BUDGET,
} from '../../../packages/host/src/orchestrator/approvals/budgets.js';
import { TIMEOUT_REASON_MARKER } from '../../../packages/host/src/orchestrator/approvals/timeout-reason.js';
import {
  createOrchestratorApprovalsRun,
  POSTURE_APPROVALS,
  POSTURE_FULL_ACCESS,
  type WorkerApprovalsRun,
  type WorkerAskRouterOptions,
  type WorkerAskSeat,
  type WorkerQuestionSeat,
  workerQuestionSeatForRun,
  workerSeatForRun,
} from '../../../packages/host/src/orchestrator/approvals/worker-asks.js';
import { QUESTION_UNANSWERED_CODE } from '../../../packages/host/src/orchestrator/approvals/worker-questions.js';
import type { MergedHunk } from '../../../packages/host/src/orchestrator/merge/attribution.js';
import type {
  ApprovalSnapshot,
  ResolverRequest,
} from '../../../packages/host/src/orchestrator/merge/conflicts.js';
import { hashApprovalPolicy } from '../../../packages/host/src/orchestrator/merge/conflicts.js';
import { sanitizeReasonField } from '../../../packages/host/src/orchestrator/parallel/limits.js';
import { ParallelScheduler } from '../../../packages/host/src/orchestrator/parallel/scheduler.js';
import type { ParallelTrajectoryEvent } from '../../../packages/host/src/orchestrator/parallel/visibility.js';
import { addWorktree } from '../../../packages/host/src/orchestrator/worktree/add.js';
import {
  isWorktreeError,
  WorktreeError,
  worktreeMissingError,
} from '../../../packages/host/src/orchestrator/worktree/errors.js';
import {
  diffGitGuardSnapshots,
  withHostGitCommitGuard,
  withHostGitGuard,
} from '../../../packages/host/src/orchestrator/worktree/git-guard.js';
import {
  branchForAgent,
  pathForAgent,
} from '../../../packages/host/src/orchestrator/worktree/naming.js';
import { getWorktreeStatus } from '../../../packages/host/src/orchestrator/worktree/status.js';
import {
  appendToLedger,
  auditLedgerDirFor,
  mergeDecisionAudit,
  resolveRepoRuntimeRoot,
  runStartAudit,
  workerSpawnAudit,
  workerTerminateAudit,
  worktreeCreateAudit,
} from '../../../packages/host/src/policy/audit-ledger.js';
import type { EffectivePolicy } from '../../../packages/host/src/policy/enterprise.js';
import { findProjectRoot } from '../../../packages/host/src/project-root.js';
import type { RoleLayerInput } from '../../../packages/host/src/roles/resolver.js';
import {
  planWorkerRoles,
  thinkingOverrideFromEnv,
} from '../../../packages/host/src/roles/worker-roles.js';
import { defaultSessionsRoot } from '../../../packages/host/src/sessions-cli.js';
import {
  errorKindForFailureCode,
  isFailureCode,
} from '../../../packages/worker/src/lane/failures.js';
import { inspectStoredWork } from '../../../packages/worker/src/lane/pending.js';
import {
  attachSession,
  createSession,
  openSessionStore,
  SessionAttachError,
  SessionLockError,
} from '../../../packages/worker/src/lane/session-store.js';
import type { WorkerFailure } from '../../../packages/worker/src/lifecycle/launch.js';
import { launchWorker } from '../../../packages/worker/src/lifecycle/launch.js';
import {
  killProcessGroup,
  pidAlive,
  reconcileWorkerRows,
} from '../../../packages/worker/src/lifecycle/orphans.js';
import { WorkerRegistry } from '../../../packages/worker/src/lifecycle/registry.js';
// §81 replacement (issue #175): the crash → terminate → reopen → resume
// protocol. Its generation allocation names the next number; the launcher's
// registry CAS (inside launchWorker) is what actually allocates it, so there
// is one allocator — the protocol's stale-generation check reads the number
// the relaunch will take.
import { replaceWorker } from '../../../packages/worker/src/lifecycle/replace.js';
import {
  readWorkerRows,
  updateWorkerRowsFile,
  WORKER_ROWS_FILE,
  workerRowsPath,
} from '../../../packages/worker/src/lifecycle/rows.js';
import { allowlistedShell } from '../../../packages/worker/src/lifecycle/shell.js';
import type { WorkerShell } from '../../../packages/worker/src/lifecycle/spawn.js';
import { isTerminalAgentStatus } from '../../../packages/worker/src/lifecycle/status.js';
import { callOperation } from '../../../packages/worker/src/ops/registry.js';
import { BACKGROUND_CONTEXT } from '../../../packages/worker/src/pi-boundary.js';
import type {
  AgentResult,
  AgentResultInput,
  ResultErrorKind,
  ResultStatus,
  WorkerProvenance,
  WorkspaceDiffRef,
} from '../../../packages/worker/src/result.js';
import {
  buildAgentResult,
  UNRESOLVED_MODEL,
} from '../../../packages/worker/src/result.js';
import { runtimeExcludeEntriesFor } from './config-runtime.js';
import { loadExtensionStartup } from './extension-startup.js';

export interface OrchestrateRunOptions {
  // stdout (the report or the --json envelope) and stderr (diagnostics).
  out: (line: string) => void;
  err: (line: string) => void;
  // Report colours; the command wires the stdout theme (none under --json).
  theme?: CliTheme;
  // Diagnostics colours; the command wires the stderr theme.
  errTheme?: CliTheme;
  debug?: (line: string) => void;
  cwd?: string;
  /** Worker sessions root; defaults to the user sessions root (~/.kubic/sessions). */
  sessionsRoot?: string;
  /** The one worker registry the orchestrator and `kubic workers` share
   *  (issue #94). Injectable so a test can read the live rows afterwards;
   *  omitted means this run owns its own. */
  registry?: WorkerRegistry;
  /** How long a worker may take to print its readiness marker before the
   *  launch is terminal SPAWN_FAILED (§13, §61). */
  readyTimeoutMs?: number;
  /** Wall-clock bound handed to each child `kubic run` (issue #94). */
  workerTimeoutMs?: number;
  /**
   * §51 cancellation grace (issue #249) handed to the lifecycle layer: how
   * long a worker's own cooperative shutdown gets after SIGTERM before the
   * group SIGKILL escalation. Absent uses the lifecycle default (10 s), which
   * is deliberately longer than the 2 s tool grace.
   */
  workerCancelGraceMs?: number;
  /**
   * §82 per-agent limits (issue #163): the RSS cap (MB) each worker runs
   * under and the worktree disk quota (MB) checked on an interval. Absent
   * means the corresponding limit is not enforced (and `kubic doctor` says
   * so). Memory is also handed to the child as `--max-old-space-size`.
   */
  workerMemoryLimitMb?: number;
  worktreeDiskQuotaMb?: number;
  /**
   * How the resolver child is reached (issue #106, §45.2). Defaults to
   * `workerEntry` — the resolver IS a `kubic run` child, so a test that
   * scripts a resolver fixture sets this; prod leaves it unset and the entry
   * is the same one every worker uses.
   */
  resolverEntry?: { cmd: string; args: string[] };
  /**
   * How the child `kubic run` is reached (issue #94). Defaults to the
   * built binary (`node bin/kubic.js`); a test that has no build output
   * injects an argv that runs the same composition root from source, so
   * the child on the path under test is a REAL process either way.
   */
  workerEntry?: { cmd: string; args: string[] };
  /** Prod inputs for the extension startup load — tests drive missing bundles here. */
  extensionOptions?: PostureOptions;
  /**
   * The manager lane's own approval policy (issue #106, §45.2). Threaded in
   * from the process's config load so a delegated conflict resolver runs
   * under exactly the snapshot the manager holds — same route, same
   * auto-approve set, same pending timeout, no second policy. Absent means
   * the run cannot delegate: a conflict terminates as it did before.
   */
  approvalPolicy?: ApprovalSnapshot;
  /**
   * The §58 enterprise policy (issue #288), the same resolved object `kubic
   * run` gates with. The manager judges each ASSIGNED role's declared tools
   * against it and refuses the run (`role_refused`, before any worktree or
   * process) for the assignment a worker's own `kubic run --role` would
   * refuse. Absent means no enterprise tool policy is applied.
   */
  toolPolicy?: EffectivePolicy;
  /**
   * The config `[roles.<name>]` layers (issue #133) `kubic run --role` merges
   * under each role document, so the manager's role plan resolves an assigned
   * role exactly as its worker will. Absent means the documents alone.
   */
  roleLayers?: RoleLayerInput[];
  /**
   * The config `skills` projection (issue #237, §29.2) — files or
   * directories, already resolved against their declaring file at load.
   * Every worker's child gets them the #170 way (task `resources.skills`
   * + `--skill <abs>` argv), merged ahead of the run's `--skill` values
   * so an explicit flag still wins a same-name conflict. Absent means the
   * workers load only what the run was launched with.
   */
  settingsSkills?: string[];
  /**
   * Where the §49.1 parallel trajectory records go (issue #106). Absent
   * defaults to `<repo>/.kubic/orchestrator/<session>.trajectory.jsonl`
   * (appended, best-effort — telemetry never fails a run).
   */
  trajectoryEvent?: (event: ParallelTrajectoryEvent) => void;
  /** Where the user's verdict on a worker ask is collected (issue #105).
   *  Absent means no surface is attached: every ask denies closed on its
   *  bound, which is what a non-interactive run keeps. */
  approvalsSeat?: WorkerAskSeat;
  // Issue #154: presents worker questions (free text); default: a readline
  // prompt on a TTY, none headless.
  questionSeat?: WorkerQuestionSeat;
  /**
   * Presents the MANAGER's `ask_user` questions (issue #431). A caller
   * that OWNS the terminal — the TUI, whose alt-screen and raw stdin a
   * readline would corrupt — supplies its own seat here, used verbatim
   * (the #327 merge-seat pattern). Absent keeps the shipped behaviour (a
   * TTY is asked per question, a headless run denies closed).
   */
  askUserSeat?: OrchestrateCommandDeps['askUserSeat'];
  /**
   * The merge gate's decider (issue #327). A caller that OWNS the terminal —
   * the TUI, whose alt-screen and raw stdin a readline would corrupt —
   * supplies its own seat here, and it is used verbatim: the stdio readline
   * below never runs when this is set. Absent keeps the shipped behaviour
   * (a TTY is asked per merge, a headless run denies closed).
   */
  mergeApproval?: OrchestrateCommandDeps['requestApproval'];
  /**
   * Whether a merge-gate refusal tells the operator to rerun with `--yes`
   * (default true). The TUI has no such flag — its merge asks go through the
   * approval overlay — so it passes false (issue #327).
   */
  yesHint?: boolean;
  /**
   * The runtime `[orchestrator]` projection (issue #133), validated at
   * config load: `root` is the worktree parent the spawned set lives under
   * (`.kubic/wt` when absent) and `maxWorkers` is the admission cap the run
   * scheduler resolves through resolveMaxConcurrency (the shipped four when
   * absent). One projection, two consumers — never a second config read.
   */
  orchestrator?: RuntimeOrchestrator;
  /**
   * Issue #228 (§35.1): the PER-ROOT project-trust check (the store's
   * decision for an exact directory plus the env opt-in — `projectTrustFor`).
   * It is evaluated for the models root the run actually loads
   * (`/repo/models.json` from `/repo/pkg`), never for the launch cwd: a grant
   * for `/repo/pkg` does not reach `/repo`. The manager loads the project
   * models.json only when that root is trusted, and only then are the
   * children handed the `KUBIC_TRUST_PROJECT=1` env opt-in (their worktree
   * path is not the key the decision is recorded under). Absent leaves the
   * env opt-in alone: nothing is granted on the store's behalf.
   */
  projectTrust?: (path: string) => boolean;
  /**
   * The process-signal seam the live-worker guard hangs off. Prod uses the
   * real process (SIGINT/SIGTERM/SIGHUP + 'exit'); tests inject a fake so
   * the test runner itself is never signalled.
   */
  signals?: OrchestrateSignals;
  /**
   * The manager's own effective model pin (config `[model]` / KUBIC_MODEL,
   * issue #200). A worker with no role/operator pin resolves this same
   * model, so it decides which provider's key the worker is granted.
   */
  model?: { provider: string; id: string };
  /**
   * The `--manager-lane` flag, forwarded by the headless composition root
   * (issue #431, L-D34). True opts this run into the model-driven manager
   * lane; absent/false leaves the opt-in to `[orchestrator] manager`. The
   * TUI never sets it (headless only until #439).
   */
  managerLane?: boolean;
  /**
   * A frozen enterprise `[model]` is the manager's effective pin (issue #295;
   * §35.1): every worker child runs the enterprise model whatever `KUBIC_MODEL`
   * says, so the manager injects no role-default pin (the child would drop it
   * and print a misleading "ignored" note), strips the operator's from the
   * child env, and resolves the credential preflight from `model` alone.
   */
  modelPinFrozen?: boolean;
  /**
   * The manager's assembled models (issue #200): the provider key-env index
   * and the first usable provider the workers fall back to. Tests inject;
   * prod leaves it unset and the run assembles over its own root/env.
   */
  models?: AssembledModels;
  /**
   * §58 `require_credential_broker`: worker grants carry `broker:<ref>`
   * sentinels instead of live values, so no secret material reaches a child
   * env. Absent means the shipped default (no broker configured).
   */
  requireCredentialBroker?: boolean;
}

export type OrchestrateSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP';

export interface OrchestrateSignals {
  /** Install `handler` for the termination signals and process 'exit';
   *  returns the remover. */
  install: (
    handler: (signal: OrchestrateSignal | 'exit') => void,
  ) => () => void;
  /** Re-deliver `signal` with its default disposition once our handler is
   *  gone, so the manager still terminates the way the user asked. */
  reraise: (signal: OrchestrateSignal) => void;
}

const TERMINATION_SIGNALS: readonly OrchestrateSignal[] = [
  'SIGINT',
  'SIGTERM',
  'SIGHUP',
];

export const processSignals: OrchestrateSignals = {
  install: (handler) => {
    const bySignal = TERMINATION_SIGNALS.map((signal) => {
      const listener = (): void => handler(signal);
      process.on(signal, listener);
      return [signal, listener] as const;
    });
    const onExit = (): void => handler('exit');
    process.on('exit', onExit);
    return () => {
      for (const [signal, listener] of bySignal) {
        process.removeListener(signal, listener);
      }
      process.removeListener('exit', onExit);
    };
  },
  reraise: (signal) => {
    // Another listener (e.g. a TUI) owns the signal: leave it to them.
    if (process.listenerCount(signal) > 0) return;
    process.kill(process.pid, signal);
  },
};

// Live-worker guard (§51, §61): every worker child runs in its OWN process
// group (exec's detached spawn, so a kill reaches grandchildren) — which
// also means a terminal Ctrl-C never reaches it. Without this guard a
// SIGINT/SIGTERM/SIGHUP to the manager orphaned every running child. The
// handlers are installed while at least one worker is live and removed
// when the last one settles, so an idle process carries no listeners.
function liveWorkerGuard(signals: OrchestrateSignals): {
  track: (kill: () => void) => () => void;
  cancelledBy: () => OrchestrateSignal | undefined;
} {
  let cancelled: OrchestrateSignal | undefined;
  const live = new Set<() => void>();
  let remove: (() => void) | undefined;
  const killAll = (): void => {
    for (const kill of [...live]) {
      try {
        kill();
      } catch {
        // Already gone — the next one still gets its signal.
      }
    }
    live.clear();
  };
  const handler = (signal: OrchestrateSignal | 'exit'): void => {
    // Recorded BEFORE the kill: the run stops on its own even when another
    // listener (a TUI) owns the signal and the re-raise is a no-op.
    if (signal !== 'exit') cancelled = signal;
    killAll();
    remove?.();
    remove = undefined;
    if (signal !== 'exit') signals.reraise(signal);
  };
  return {
    cancelledBy: () => cancelled,
    track: (kill) => {
      live.add(kill);
      if (remove === undefined) remove = signals.install(handler);
      return () => {
        live.delete(kill);
        if (live.size === 0 && remove !== undefined) {
          remove();
          remove = undefined;
        }
      };
    },
  };
}

export interface OrchestrateWorkerLaunches {
  /** Live rows of this run's workers, from the shared registry. */
  rows: () => ReturnType<WorkerRegistry['list']>;
  /** §78 code the orchestrator reported for a worker that failed. */
  failureOf: (agentId: string) => WorkerFailure | undefined;
  /** Launch samples (spawn/attach/teardown ms) against §61 budgets. */
  perf: () => { ok: boolean; breaches: string[] }[];
}

/** The `launches` view of a run, narrowed to the shape the host declares. */
function launchesView(
  registry: WorkerRegistry,
  launched: Map<string, ReturnType<typeof launchWorker>>,
): NonNullable<OrchestrateCommandDeps['launches']> {
  return {
    rows: () => registry.list(),
    failureOf: (agentId: string) => {
      const failure = launched.get(agentId)?.failure();
      return failure === undefined
        ? undefined
        : { code: failure.code, message: failure.message };
    },
    perf: () =>
      [...launched.values()].map((worker) => {
        const { ok, breaches, sample } = worker.perf();
        return { ok, breaches, sample };
      }),
  };
}

// §60 ledger provenance for one worker ask (issue #282): the registry row
// the spawn recorded — pid, generation — read at RECORD time, so a respawn
// between two asks records the new generation; the per-worker resolved
// thinking level (else the run's explicit level); the worktree base captured
// at creation. A worker the registry never saw (a forged key) resolves
// undefined, and the row keeps the honest 0/unknown fallback. Exported so
// the wiring itself is what the ledger test drives, not a copy of it.
export function askProvenanceForWorker(
  registry: WorkerRegistry,
  lookup: {
    thinkingByAgent: ReadonlyMap<string, string>;
    baseByAgent: ReadonlyMap<string, string>;
    thinkingFallback?: string;
  },
): NonNullable<WorkerAskRouterOptions['provenanceFor']> {
  return (request) => {
    const row = registry.get(request.agentId);
    if (row === undefined) return undefined;
    const thinking =
      lookup.thinkingByAgent.get(request.agentId) ?? lookup.thinkingFallback;
    const base = lookup.baseByAgent.get(request.agentId);
    return {
      ...(row.pid === undefined ? {} : { pid: row.pid }),
      generation: row.generation,
      ...(thinking === undefined ? {} : { thinking }),
      ...(base === undefined ? {} : { base }),
    };
  };
}

/**
 * §13 WAITING (issue #151): while the router holds an unanswered ask for a
 * worker, its row says WAITING; the answer (or the bound's denial) flips it
 * back to RUNNING. Only a LIVE agent flips — a worker that settled keeps its
 * own terminus — and only a change is written. Exported so the wiring itself
 * is what the approvals test drives, not a copy of it.
 */
export function workerAskStateObserver(
  registry: WorkerRegistry,
  persist: () => void,
): (agentId: string, pending: boolean) => void {
  return (agentId, pending) => {
    const row = registry.get(agentId);
    const next = pending ? 'waiting' : 'running';
    if (row === undefined || row.agentStatus === next) return;
    if (row.agentStatus !== 'running' && row.agentStatus !== 'waiting') {
      return;
    }
    registry.updateAgentStatus(agentId, next);
    persist();
  };
}

// §82 resource probes (issue #163): the manager's own readings, through the
// exec Shell seam (never /proc directly, and never inside the worker). Both
// return undefined when the reading is not available — an unenforceable limit
// is reported as such, never guessed.
export async function processMemoryMb(
  cwd: string,
  pid: number,
  shell: Shell = new NodeExecutionEnv(cwd).shell,
): Promise<number | undefined> {
  // The process GROUP first (a worker's tools are its children), then the
  // leader alone when the group query is unsupported.
  for (const args of [
    ['-o', 'rss=', '-g', String(pid)],
    ['-o', 'rss=', '-p', String(pid)],
  ]) {
    try {
      const done = await shell
        .spawn('ps', args, {
          provenance: ROOT_PROVENANCE,
        })
        .wait();
      if (done.exitCode !== 0) continue;
      const kb = done.stdout
        .split('\n')
        .map((line) => Number(line.trim()))
        .filter((value) => Number.isFinite(value) && value > 0)
        .reduce((sum, value) => sum + value, 0);
      if (kb > 0) return Math.round(kb / 1024);
    } catch {
      // Probe unavailable — try the next form.
    }
  }
  return undefined;
}

export async function worktreeDiskMb(
  cwd: string,
  path: string,
  shell: Shell = new NodeExecutionEnv(cwd).shell,
): Promise<number | undefined> {
  try {
    const done = await shell
      .spawn('du', ['-sk', path], {
        provenance: ROOT_PROVENANCE,
      })
      .wait();
    if (done.exitCode !== 0) return undefined;
    const kb = Number(done.stdout.trim().split(/\s+/)[0]);
    return Number.isFinite(kb) ? Math.round(kb / 1024) : undefined;
  } catch {
    return undefined;
  }
}

function provenanceFor(sessionId: string, agentId: string, tool: string) {
  return {
    sessionId,
    agentId,
    toolCallId: tool,
    turnId: 0,
    operation: 'orchestrate',
  };
}

/**
 * Route host-side git argv through the guard (issue #363, #428): every
 * invocation carries the hooksPath/fsmonitor overrides, and commits
 * additionally carry `--no-verify` via `withHostGitCommitGuard`. This is
 * the ONLY place host argv gains the commit flag — call sites pass plain
 * argv, so no commit path can hand-roll (and forget) it. The subcommand
 * is read past any leading global options (issue #435: `-c`/`-C` and the
 * value-taking longs skip their argument, every other `-`/`--` word
 * skips itself), so a `--no-pager` or `-C` commit keeps `--no-verify`.
 */
// Global options that take a separate value (issue #435): skipped with
// their argument when hunting the subcommand.
const HOST_GLOBAL_VALUE =
  /^(-c|-C|--git-dir|--work-tree|--namespace|--exec-path|--config-env)$/i;

export function hostGitArgs(args: readonly string[]): string[] {
  let index = 0;
  while (index < args.length) {
    const token = args[index] ?? '';
    if (HOST_GLOBAL_VALUE.test(token)) index += 2;
    else if (token.startsWith('-')) index += 1;
    else break;
  }
  if (args[index] === 'commit') return withHostGitCommitGuard(args);
  return withHostGitGuard(args);
}

async function runGit(
  cwd: string,
  args: string[],
  sessionId: string,
  agentId: string,
  tool: string,
): Promise<ShellResult> {
  // Issue #363: every host-side git invocation runs with repo hooks and
  // fsmonitor disabled — a hook planted in a worker tree never executes
  // during the orchestrator's own status/stage/commit/merge/abort reads.
  const env = new NodeExecutionEnv(cwd);
  return env.shell
    .spawn('git', hostGitArgs(args), {
      provenance: provenanceFor(sessionId, agentId, tool),
    })
    .wait();
}

// Worker entry resolution (issue #179): the child `kubic run` is spawned
// through the SAME bin wrapper that launched this manager. The wrapper is
// located from this module's own import.meta.url — node's default ESM
// resolution already follows symlinks to the real file, so argv[1] and the
// cwd are never consulted: through a bin symlink named `kubic`
// (node_modules/.bin, npm link, a global install) argv[1] has no .js
// suffix and the cwd is the user's project, where the old fallback spawned
// a nonexistent <cwd>/bin/kubic.js. Both shipped layouts carry
// bin/kubic.js above this module (the repo root, in source and in dist).
// The existence probe is injectable so unit tests pin the resolution
// without touching the filesystem, argv, or cwd.
export function resolveWorkerEntryScript(
  moduleFilePath: string,
  wrapperExists: (dir: string) => boolean = binWrapperExists,
): string | undefined {
  let dir = dirname(moduleFilePath);
  for (let level = 0; level < 6; level++) {
    if (wrapperExists(dir)) return join(dir, 'bin', 'kubic.js');
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

// Existence probe through the exec FileBridge (I/O confinement, §9) —
// the composition root never imports node:fs directly.
function binWrapperExists(dir: string): boolean {
  try {
    createNodeFileBridge(dir).readTextFile(join('bin', 'kubic.js'));
    return true;
  } catch {
    return false;
  }
}

let cachedEntryScript: string | undefined;
function entryScript(): string {
  // Last-resort fallback for an exotic layout with no bin wrapper above
  // the module: the old cwd guess. Unreachable in both shipped layouts.
  cachedEntryScript ??=
    resolveWorkerEntryScript(fileURLToPath(import.meta.url)) ??
    resolve(process.cwd(), 'bin', 'kubic.js');
  return cachedEntryScript;
}

// Wall-clock bound handed to each child `kubic run` (issue #94). A worker
// that never settles is the failure mode with no named code: the child's
// own guard turns it into exit 1 with status `timeout` (issue #280), which
// the lifecycle layer reports as that §68 status — never a hang, and never
// a budget breach the user did not configure.
const DEFAULT_WORKER_TIMEOUT_MS = 600_000;

// The readiness marker the child prints before its prompt is submitted
// (§13, issue #94) lives on the CHILD side (headless-run.ts) — a worker
// announces itself the moment its session is attached, so the launch
// handshake times the real startup instead of prompt construction.

// The file a worker child reads its §67 task from (issue #191): written into
// the worker's own session dir by the manager, named to the child through
// KUBIC_TASK_FILE.
export const AGENT_TASK_FILE = 'agent-task.json';

// The resolver shares the conflicted worker's session dir, so its task file
// is named apart from that worker's own (issue #191).
export const RESOLVER_TASK_FILE = 'resolver-task.json';

// §67 (issue #191): a task that fails validation refuses the spawn before the
// child exists. Named so the run's terminus says why.
export class AgentTaskRefusedError extends Error {
  readonly code = 'task_refused';
  constructor(agentId: string, errors: readonly string[]) {
    super(`worker '${agentId}' task refused: ${errors.join('; ')}`);
    this.name = 'AgentTaskRefusedError';
  }
}

// Write the task into the worker's session dir and return its absolute path —
// the value the child gets in KUBIC_TASK_FILE. The child reads it back from
// its own side of the session store, never from the manager's process.
function writeAgentTask(
  sessionBridge: Pick<FileBridge, 'writeFile' | 'absolutePath'>,
  sessionId: string,
  task: AgentTask,
): string {
  const relative = join(sessionId, AGENT_TASK_FILE);
  sessionBridge.writeFile(relative, `${JSON.stringify(task)}\n`);
  return sessionBridge.absolutePath(relative);
}

// `--skill` values (issue #170): relative paths resolve against the MANAGER's
// cwd — a child runs in its own worktree, where the same relative path would
// name something else — and every value travels twice: as `--skill <abs>` on
// the child's argv and as the §67 task's `resources.skills`, which is also
// what the registry row records for `kubic workers`. Order is kept, duplicates
// collapse.
function resolveSkillPaths(
  skills: readonly string[] | undefined,
  cwd: string,
): string[] {
  if (skills === undefined || skills.length === 0) return [];
  const out: string[] = [];
  for (const skill of skills) {
    const absolute = isAbsolute(skill) ? skill : resolve(cwd, skill);
    if (!out.includes(absolute)) out.push(absolute);
  }
  return out;
}

// `provider/id` → the task's model selection; a ref without a usable split
// names no model (the child's own pin still travels on KUBIC_MODEL).
function modelOfRef(
  ref: string | undefined,
): { provider: string; model: string } | undefined {
  if (ref === undefined) return undefined;
  const slash = ref.indexOf('/');
  if (slash <= 0 || slash === ref.length - 1) return undefined;
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
}

export class WorkerRunFailure extends Error {
  readonly code:
    | 'spawn_failed'
    | 'worker_failed'
    | 'result_invalid'
    | 'cancelled'
    // §82 resource enforcement (issue #163): a worker the manager stopped
    // because a configured limit was breached keeps that named code as the
    // run's terminus, so the envelope says WHY it stopped.
    | 'resource_memory_exceeded'
    | 'resource_disk_exceeded';
  /**
   * The approval-layer terminus the child declared for itself (issue #105).
   * A worker child denies closed on its own bounded wait or on a configured
   * budget, and reports that as its §78 terminus; the run must keep the
   * named code (exit 4 / exit 3) instead of flattening it to worker_failed,
   * or a user's refusal would look like a crash.
   */
  readonly approval?: { code: string; exitCode: number };
  /**
   * The §68 result for this terminus (issue #185): provenance and a named
   * error.kind, built from what the child reported before it stopped.
   * Attached by runWorker; the CLI reports and persists it.
   */
  result?: AgentResult;

  constructor(
    code:
      | 'spawn_failed'
      | 'worker_failed'
      | 'result_invalid'
      | 'cancelled'
      | 'resource_memory_exceeded'
      | 'resource_disk_exceeded',
    message: string,
    approval?: { code: string; exitCode: number },
  ) {
    super(message);
    this.name = 'WorkerRunFailure';
    this.code = code;
    if (approval !== undefined) this.approval = approval;
  }
}

// The approval terminus a child's own exit declares (issue #105): the child
// maps its denial/budget outcome to a §78 exit code and names it in its JSON
// status. Read from the child's own report — never invented here.
function approvalTerminusOf(
  exitCode: number,
  status: string | undefined,
): { code: string; exitCode: number } | undefined {
  if (exitCode === 4) {
    return {
      code:
        status === 'approval_timed_out'
          ? 'approval_timeout'
          : 'approval_denied',
      exitCode,
    };
  }
  if (exitCode === 3) return { code: 'BUDGET_EXHAUSTED', exitCode };
  return undefined;
}

// The §78 code a failed launch maps to. A launch that never became ready
// is `spawn_failed` (the worker never started); a worker that ran and
// reported a failure keeps `worker_failed`, with the §52 code named in
// the message so the taxonomy stays visible.
// What the orchestrator itself observed about a launch (issue #185): the
// files the worker changed, the §61 timings, and the provenance the
// lifecycle layer knows (pid, generation, worktree, role). The model comes
// from the child's own report when it names one.
export interface WorkerObservation {
  filesChanged: string[];
  wallMs: number;
  latencyMs: number;
  provenance: Omit<WorkerProvenance, 'workerId' | 'model'> & {
    model?: string;
  };
  diff?: WorkspaceDiffRef;
}

// The child's `kubic run --json` report (the LAST stdout line), read
// leniently: every field is untrusted and checked where it is used.
interface ChildReport {
  ok?: unknown;
  status?: unknown;
  sessionId?: unknown;
  result?: { summary?: unknown };
  model?: unknown;
  // Issue #155: the child's own §52 classification, when it printed one —
  // the precise half the exit code cannot carry. The envelope's `error.kind`
  // is the §78 terminus (never a §68 kind), so the manager derives the
  // domain from this code instead (review finding).
  failure?: { code?: unknown };
  usage?: {
    input?: unknown;
    output?: unknown;
    cacheRead?: unknown;
    costUsd?: unknown;
    toolCalls?: unknown;
  };
}

function childReportOf(stdout: string): ChildReport | undefined {
  const last = stdout.trim().split('\n').pop()?.trim() ?? '';
  if (last.length === 0) return undefined;
  try {
    const parsed = JSON.parse(last) as unknown;
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as ChildReport)
      : undefined;
  } catch {
    return undefined;
  }
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

// §39/§68 metrics from the child's own usage rollup (its session's rows,
// the same numbers `kubic cost` reads) — never invented zeros when the
// report carries them.
function reportMetrics(
  report: ChildReport | undefined,
  observed: { wallMs: number; latencyMs: number },
): AgentResultInput['metrics'] {
  const usage = report?.usage;
  const input = count(usage?.input);
  const output = count(usage?.output);
  const cached = count(usage?.cacheRead);
  const toolCalls = count(usage?.toolCalls);
  const costUsd = count(usage?.costUsd);
  return {
    wallMs: observed.wallMs,
    latencyMs: observed.latencyMs,
    ...(input === undefined ? {} : { inputTokens: input }),
    ...(output === undefined ? {} : { outputTokens: output }),
    ...(cached === undefined ? {} : { cachedTokens: cached }),
    ...(toolCalls === undefined ? {} : { toolCalls }),
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

function provenanceOf(
  agentId: string,
  report: ChildReport | undefined,
  observed: WorkerObservation['provenance'],
): WorkerProvenance {
  const reported =
    typeof report?.model === 'string' && report.model.trim().length > 0
      ? report.model
      : undefined;
  return {
    ...observed,
    workerId: agentId,
    model: reported ?? observed.model ?? UNRESOLVED_MODEL,
  };
}

// §68 on the prod path: a child that exited 0 is only a success once its
// own `--json` report is read and the AgentResult built from it passes the
// closed-world validator. The report must be the child's LAST stdout line,
// ok, completed, for THIS worker's session, with a non-empty summary —
// anything else is a typed `result_invalid`, never a silent success.
export function workerResultFromRun(
  agentId: string,
  workerSession: string,
  done: { exitCode: number; stdout: string; stderr: string },
  observed: WorkerObservation,
):
  | { ok: true; result: AgentResult }
  | { ok: false; error: { code: 'result_invalid'; message: string } } {
  const invalid = (why: string) => ({
    ok: false as const,
    error: {
      code: 'result_invalid' as const,
      message: `worker '${agentId}' result violates the §68 contract: ${why}`,
    },
  });
  const last = done.stdout.trim().split('\n').pop()?.trim() ?? '';
  if (last.length === 0) return invalid('the child printed no result report');
  const report = childReportOf(done.stdout);
  if (report === undefined)
    return invalid(
      `the last output line is not a JSON report object: ${drawableText(last).slice(0, 120)}`,
    );
  if (report.ok !== true || report.status !== 'completed')
    return invalid(
      `the report is not a completed run (status ${drawableText(String(report.status))})`,
    );
  if (report.sessionId !== workerSession)
    return invalid(
      `the report names session '${drawableText(String(report.sessionId))}', not '${workerSession}'`,
    );
  const summary = report.result?.summary;
  if (typeof summary !== 'string' || summary.trim().length === 0)
    return invalid('summary must be a non-empty string');
  try {
    return {
      ok: true,
      result: buildAgentResult({
        status: 'completed',
        summary,
        filesChanged: observed.filesChanged,
        provenance: provenanceOf(agentId, report, observed.provenance),
        metrics: reportMetrics(report, observed),
        ...(observed.diff === undefined ? {} : { diff: observed.diff }),
      }),
    };
  } catch (error) {
    return invalid(error instanceof Error ? error.message : String(error));
  }
}

// §68 on every terminus (issue #185): a worker that failed, timed out, was
// cancelled, ran out of budget or never spawned still yields a result — with
// full provenance and a named error.kind — so a failure can be diagnosed
// from the result alone. The child's report (when it printed one) supplies
// the model and the usage it spent before it stopped.
export function workerFailureResult(
  agentId: string,
  failure: WorkerRunFailure,
  done: { exitCode: number; stdout: string; stderr: string } | undefined,
  observed: Omit<WorkerObservation, 'filesChanged' | 'diff'>,
  launchFailure?: WorkerFailure,
): AgentResult {
  const report = done === undefined ? undefined : childReportOf(done.stdout);
  const approval = failure.approval?.code;
  // Issue #155: the manager reads the child's own §52 code (and the domain
  // it belongs to) instead of guessing from the exit code. The exit-code
  // mapping stays the fallback for a child that printed no report.
  const childCode =
    report?.failure !== undefined && isFailureCode(report.failure.code)
      ? report.failure.code
      : undefined;
  // Issue #280: a wall-clock timeout and a cancellation keep their own §68
  // status, read from the child's own report — only a configured budget
  // (exit 3 / approval terminus) is `budget_exhausted`.
  const status: ResultStatus =
    failure.code === 'spawn_failed'
      ? 'spawn_failed'
      : failure.code === 'cancelled'
        ? 'cancelled'
        : approval === 'BUDGET_EXHAUSTED'
          ? 'budget_exhausted'
          : report?.status === 'timeout'
            ? 'timeout'
            : report?.status === 'cancelled'
              ? 'cancelled'
              : 'failed';
  const kind: ResultErrorKind =
    approval === 'BUDGET_EXHAUSTED'
      ? 'budget'
      : approval !== undefined
        ? 'approval'
        : failure.code === 'worker_failed'
          ? ((childCode === undefined
              ? undefined
              : errorKindForFailureCode(childCode)) ??
            launchFailure?.kind ??
            'process')
          : 'process';
  return buildAgentResult({
    status,
    summary: failure.message,
    provenance: provenanceOf(agentId, report, observed.provenance),
    metrics: reportMetrics(report, observed),
    error: {
      kind,
      message: failure.message,
      details: {
        code: childCode ?? approval ?? launchFailure?.code ?? failure.code,
      },
    },
  });
}

// The named wall-clock budget end (issue #208, §71): the manager's watchdog
// fired because a worker outlived its maxRuntimeMs. The message names the
// exact limit= that tripped, so it is distinct from the child's own
// --timeout terminus (a single drive's bound inside the worker).
export function wallClockBudgetMessage(
  agentId: string,
  maxRuntimeMs: number,
): string {
  return `worker '${agentId}' exceeded maxRuntimeMs=${maxRuntimeMs}: budget ${BUDGET_EXHAUSTED} (limit=wallClock), exit ${RUN_EXIT_BUDGET}`;
}

// A child's own words are untrusted: this text reaches the operator's
// terminal (`error:` lines) and the stored failure result. Line breaks become
// spaces so a multi-line stderr stays one readable line; then ESC / CR / C0 /
// DEL / C1 / bidi controls are stripped (the strip set the scheduler's
// reasons and the worker summary line use), BEFORE the length cap so the cap
// counts what is drawn.
function drawableText(text: string): string {
  return sanitizeReasonField(text.replace(/\r?\n/g, ' '));
}

// The §60 `worker-terminate` reason (issue #284): how the child process
// ended. A wait that threw names the run failure (preferring the child's
// own terminus) or the lifecycle failure — never a bare 'error' when a
// code exists. A wait that settled is reasoned at the settle point.
function terminateReasonOf(
  error: unknown,
  failure: { code: string } | undefined,
): string {
  if (error instanceof WorkerRunFailure) {
    return error.approval?.code ?? error.code;
  }
  return failure?.code ?? 'error';
}

function workerRunError(
  agentId: string,
  done: { exitCode: number; stdout: string; stderr: string },
  failure: WorkerFailure | undefined,
): WorkerRunFailure {
  const last = done.stdout.trim().split('\n').pop() ?? '';
  let detail = done.stderr.trim() || done.stdout.trim();
  let status: string | undefined;
  try {
    const envelope = JSON.parse(last) as {
      error?: { message?: string };
      status?: string;
    };
    if (typeof envelope.error?.message === 'string')
      detail = envelope.error.message;
    if (typeof envelope.status === 'string') status = envelope.status;
  } catch {
    // Non-JSON output — keep the raw detail.
  }
  const approval = approvalTerminusOf(done.exitCode, status);
  if (failure?.code === 'process_spawn_failed') {
    return new WorkerRunFailure(
      'spawn_failed',
      `spawn failed for worker '${agentId}': ${failure.message}`,
    );
  }
  // A resource breach is the manager's own terminus (issue #163): the run
  // reports the named code, never a generic worker_failed.
  if (
    failure?.code === 'resource_memory_exceeded' ||
    failure?.code === 'resource_disk_exceeded'
  ) {
    return new WorkerRunFailure(
      failure.code,
      `worker '${agentId}' stopped: ${failure.message}`,
    );
  }
  const suffix = failure === undefined ? '' : ` [${failure.code}]`;
  return new WorkerRunFailure(
    'worker_failed',
    `worker run exited ${done.exitCode}: ${drawableText(detail).slice(0, 300)}${suffix}`,
    approval,
  );
}

// Kubic's own state dir must never dirty the tree it sits in (§35: `.kubic/`
// runtime state is ignored). A fresh `git init` scratch repo has no ignore
// entry, so the dir shows up as `?? .kubic/` and the pre-merge guard refuses
// every merge — no run can settle.
//
// The rules come from issue #91's single source of truth (the same mechanism
// `kubic run` uses at dispatch): the five runtime prefixes go into the
// repo-local, uncommitted exclude file, so `.kubic/roles/*.md` and
// `config.toml` stay committable. An earlier version of this helper wrote a
// `*` file into `.kubic/.gitignore`, which ignored the roles too — verified
// to break `git add .kubic/roles/new-role.md` — so it defers here instead.
// Best-effort: a repo we cannot write into fails later with its own named code.
// The outcome still reaches the debug channel — a skipped/unavailable write is
// otherwise indistinguishable from a successful one (issue #85 review).
function ensureStateIgnored(
  root: string,
  debug: (line: string) => void,
  entries?: readonly string[],
): void {
  const outcome = ensureRuntimeExcludeRules({
    cwd: root,
    ...(entries === undefined ? {} : { entries }),
  });
  if (outcome.skipped !== undefined) {
    debug(
      `state ignore: skipped (${outcome.skipped})${outcome.detail === undefined ? '' : `: ${outcome.detail}`}`,
    );
  }
}

// The readline-shaped seam `boundedAskUser` drives: `question` asks,
// `close` releases the interface, `onClose` fires when the interface closes
// with no answer (EOF — Ctrl-D, a closed stdin). Prod builds the real one
// over stdio; tests inject a double, so the contract is exercised without a
// terminal and without a real process.stdin.
export interface AskLine {
  question: (question: string, answer: (answer: string) => void) => void;
  close: () => void;
  onClose: (handler: () => void) => void;
}

export interface BoundedAskOptions {
  /** The bound in force — the run's approvalPolicy.maxPendingMs snapshot. */
  maxPendingMs: number;
  /** Who the ask is about; named in the elapse denial beside the bound. */
  candidate: string;
  /** Injectable seams; prod uses readline over stdio and the real clock. */
  open?: () => AskLine;
  notice?: (text: string) => void;
  setTimer?: (
    callback: () => void,
    ms: number,
  ) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

// The bounded-wait denial names itself in the reason, matching the worker-ask
// convention (worker-asks.ts interpolates the same shared marker): the BOUND
// (`after <ms>ms`) and the CANDIDATE (which merge was refused), so the
// operator can tell a walked-away user from a decided "no".
export function mergeApprovalTimeoutReason(
  maxPendingMs: number,
  candidate: string,
): string {
  return `approval ${TIMEOUT_REASON_MARKER} after ${maxPendingMs}ms — denied (merge of '${candidate}')`;
}

function openStdioAskLine(): AskLine {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return {
    question: (question, answer) => {
      rl.question(question, answer);
    },
    close: () => {
      rl.close();
    },
    onClose: (handler) => {
      rl.on('close', handler);
    },
  };
}

// The interactive merge ask, BOUNDED (§41.2 — nothing waits silently). An
// answer inside the bound decides it under the shipped rule (an explicit yes
// only — a mistyped Enter never grants); the bound elapsing closes the
// interface, leaves the dead prompt line cleanly (stderr newline) and settles
// the TIMEOUT verdict — never a bare deny, because the run must label a
// walked-away user as a timeout, not as a refusal nobody made. An interface
// that closes with no answer (EOF) denies too — and cleans its dead prompt
// line the same way: a closed terminal is not consent. Settles exactly once,
// either way — never hangs, never double-resolves.
export function boundedAskUser(
  question: string,
  options: BoundedAskOptions,
): Promise<MergeApprovalVerdict> {
  const open = options.open ?? openStdioAskLine;
  const notice =
    options.notice ??
    ((text: string): void => {
      process.stderr.write(text);
    });
  const setTimer =
    options.setTimer ??
    ((callback: () => void, ms: number): ReturnType<typeof setTimeout> =>
      setTimeout(callback, ms));
  const clearTimer =
    options.clearTimer ??
    ((timer: ReturnType<typeof setTimeout>): void => {
      clearTimeout(timer);
    });
  return new Promise<MergeApprovalVerdict>((resolve) => {
    let settled = false;
    const line = open();
    const timer = setTimer(() => {
      if (settled) return;
      settled = true;
      line.close();
      // Leave the dead prompt line cleanly, then name the denial.
      notice('\n');
      notice(
        `${mergeApprovalTimeoutReason(options.maxPendingMs, options.candidate)}\n`,
      );
      resolve({ verdict: 'timeout', maxPendingMs: options.maxPendingMs });
    }, options.maxPendingMs);
    line.onClose(() => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      // The dead prompt line is left cleanly on this path too (review: a
      // real pty glued the next output to the open prompt otherwise).
      notice('\n');
      resolve({ verdict: 'deny' });
    });
    line.question(question, (answer: string) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      line.close();
      resolve(
        /^y(es)?\s*$/i.test(answer.trim())
          ? { verdict: 'approve' }
          : { verdict: 'deny' },
      );
    });
  });
}

export async function orchestrateDepsWithDefaults(
  options: OrchestrateRunOptions,
): Promise<OrchestrateCommandDeps> {
  const cwd = options.cwd ?? process.cwd();
  const debug = options.debug ?? (() => undefined);
  // Issue #202 (§38.1): the run's explicit thinking level — one derivation
  // shared with doctor's posture, outranking each role's own thinking default
  // for that role's worker.
  const thinkingOverride = thinkingOverrideFromEnv();
  // Issue #133: the runtime `[orchestrator]` projection — the worktree
  // parent and the worker cap, both already validated at config load. The
  // shipped defaults apply when the config sets neither: `.kubic/wt` for
  // the spawned set, the scheduler's own cap of four for admissions.
  const worktreeRoot = options.orchestrator?.root;
  const maxWorkers = options.orchestrator?.maxWorkers;
  const excludeEntries = runtimeExcludeEntriesFor(worktreeRoot);
  const workerRegistry = options.registry ?? new WorkerRegistry();
  // §60 audit provenance (issue #282): the per-worker thinking level the
  // spawn resolved and the worktree base revision captured at creation.
  // Read at RECORD time through the approvals hook below, so the maps may
  // fill after the hook is built.
  const thinkingByAgent = new Map<string, string>();
  const baseByAgent = new Map<string, string>();
  // One registry for the whole invocation (issue #94): the orchestrator
  // writes rows here, `kubic workers` reads the same rows off disk, and a
  // caller can hand in a registry to observe a run from outside.
  // Every lifecycle-managed worker starts through this shell: it carries
  // the §3.8 allowlisted env to the OS (`env -i …`), which the exec Shell
  // seam alone cannot do. It is rooted at the WORKER's worktree — the
  // child's cwd is the directory its session was created with (#85), so
  // the session attach inside the child finds its own cwd and the worker
  // journals land with the worker.
  let workerShellRoot: string | undefined;
  let workerShell: ReturnType<typeof allowlistedShell> | undefined;
  // Per-worker approvals (issue #105): the seat a TTY run attaches, and the
  // live approvals layer once the CLI constructs it (so the child's own env
  // can carry its mailbox path). The prod default is the interactive seat when
  // this process has a terminal — the same `process.stdin.isTTY` test the
  // shipped merge prompt uses — so a worker's challenged call reaches the user
  // on a real `kubic orchestrate` run. A caller may inject a seat instead
  // (tests do); headless keeps NO seat and denies closed on the bound.
  const optionsSeat =
    options.approvalsSeat ?? workerSeatForRun(process.stdin.isTTY === true);
  const questionSeat =
    options.questionSeat ??
    workerQuestionSeatForRun(process.stdin.isTTY === true);
  let approvalsActive: WorkerApprovalsRun | undefined;
  let approvalsBoundMs = ORCHESTRATE_APPROVAL_BOUND_MS;
  const shellForWorktree = (worktreePath: string): WorkerShell => {
    if (workerShell === undefined || workerShellRoot !== worktreePath) {
      workerShell = allowlistedShell(new NodeExecutionEnv(worktreePath).shell);
      workerShellRoot = worktreePath;
    }
    return workerShell;
  };
  const launchedByAgent = new Map<string, ReturnType<typeof launchWorker>>();
  // Workers the run cancelled (issue #206 fail-fast): remembered separately
  // from the signal guard, because the cancellation is per AGENT and may
  // arrive before that agent's child exists.
  const cancelRequested = new Set<string>();
  const guard = liveWorkerGuard(options.signals ?? processSignals);
  const throwIfCancelled = (agentId: string): void => {
    const signal = guard.cancelledBy();
    if (signal !== undefined) {
      throw new WorkerRunFailure(
        'cancelled',
        `worker '${agentId}' cancelled by ${signal}`,
      );
    }
    if (cancelRequested.has(agentId)) {
      throw new WorkerRunFailure(
        'cancelled',
        `worker '${agentId}' cancelled by the run`,
      );
    }
  };
  // reap() kills synchronously before it awaits, so this is safe to call
  // from a process 'exit' handler.
  const trackLive = (launched: ReturnType<typeof launchWorker>): (() => void) =>
    guard.track(() => {
      void launched.reap().catch(() => undefined);
    });
  // The orchestrator session this process is running (issue #106): the CLI
  // creates every worker session through `createWorkerSession`, so the session
  // id it carries is the run's own. The resolver seam below derives its own
  // session id from it rather than inventing one.
  let orchestratorSessionId: string | undefined;
  // Issue #164: in-flight manager-session ensures by run id (see
  // createWorkerSession) — concurrent spawns share one attach-or-create.
  const managerSessionEnsured = new Map<string, Promise<void>>();
  // Issue #431: unique invocation ids for the lane's git inspections, so
  // the op registry can tell one `git_diff` from the next.
  let gitInvocationCounter = 0;
  // Worktree creation time per agent, so a launch sample can assert the
  // §61 worktree budget alongside its own spawn/teardown legs.
  // §61 (issue #158): worktree creation duration and session attach duration
  // per agent, measured where each really happens (creation here, attach in
  // `createWorkerSession`) and handed to the launch sample as-is.
  const worktreeMsByAgent = new Map<string, number>();
  const attachMsByAgent = new Map<string, number>();
  // Extension startup (issue #93): the MANAGER lane loads the first-party
  // bundle set through the same trust gates before it plans any worker — a
  // missing/refused bundle refuses the whole orchestration (the named
  // ExtensionStartupError escapes to the CLI's failure path) instead of
  // managing a run whose extensions never loaded. The receipt is reported,
  // never swallowed.
  await loadExtensionStartup('orchestrate', cwd, {
    receipt: (line) => debug(line),
    ...(options.extensionOptions === undefined
      ? {}
      : { options: options.extensionOptions }),
  });
  const top = await runGit(
    cwd,
    ['rev-parse', '--show-toplevel'],
    'cli',
    'manager',
    'repo-root',
  );
  const root = top.exitCode === 0 ? top.stdout.trim() : undefined;
  // Issue #290: manager-side worker spans — one RunSpans for the run,
  // one worker.start (+ nested startup) span per launch, appended per
  // settled worker to <root>/.kubic/orchestrator/<session>.spans.jsonl.
  // Shared across concurrent runWorker calls: span ids are unique per
  // launch, so workers never share spans. The run's debug channel
  // carries the span lines (issue #246), so `kubic orchestrate --debug`
  // names each worker start and end.
  const managerSpans = new RunSpans(Date.now, debug);

  const needRoot = (): string => {
    if (root === undefined) throw new Error('not a git repository');
    return root;
  };

  // The approvals identity + mailbox a spawned child (worker OR resolver)
  // needs to raise an ask the user can answer (issues #105, #149, #156, #159):
  // the mailbox, the manager's public verification key, the child's bound,
  // and the two session ids §23 attribution needs — the worker's OWN session
  // (`<orch>-<agent>`) and the orchestration it belongs to. Absent when the
  // run carries no approval layer: a child then gets no half-wired surface.
  const approvalsChildEnv = (
    childSession: string,
    orchestrationSession: string,
  ): Record<string, string> =>
    approvalsActive === undefined
      ? {}
      : {
          KUBIC_APPROVALS_DIR: approvalsActive.mailboxDir(),
          // The child accepts an answer only with a matching MAC — the mailbox
          // directory is one a worker can write, so its contents are bytes
          // until this key says otherwise (issue #149).
          KUBIC_APPROVALS_VERIFY_KEY: approvalsActive.verifyKey(),
          KUBIC_ORCHESTRATOR_SESSION: orchestrationSession,
          KUBIC_WORKER_SESSION: childSession,
          // Issue #230: the child's bound, below the manager's.
          KUBIC_APPROVALS_BOUND_MS: String(
            workerApprovalBoundMs(approvalsBoundMs),
          ),
        };

  // Issue #222: a worker child runs in its own worktree, which holds only
  // tracked files — so it is told the manager's repo root and resolves the
  // SAME project models.json (still behind the inherited trust decision).
  // An outer pin (a manager that is itself a child) is kept as-is.
  const modelsRootEnv = (): Record<string, string> => {
    const pinned = process.env.KUBIC_MODELS_ROOT;
    if (pinned !== undefined && pinned !== '') return {};
    return root === undefined ? {} : { KUBIC_MODELS_ROOT: root };
  };

  // Issue #228: the decision for the models root the run loads travels to the
  // children as the same env opt-in the operator would export. A child runs
  // in its own worktree, whose path is not the key the decision is recorded
  // under — without this, a committed `.kubic/config.toml` (which IS in the
  // worktree) would refuse every worker while the manager loads trusted.
  // The opt-in follows THAT root's decision only: the launch cwd's decision
  // (`/repo/pkg`) never stands in for the root's (`/repo`), or a grant for a
  // subdirectory would let every worker load an untrusted repo-root
  // models.json and hand it the operator's key.
  const modelsRootTrusted =
    options.projectTrust?.(
      modelsProjectRootFor(root ?? cwd, process.env, homedir()),
    ) === true;
  const trustEnv = (): Record<string, string> =>
    modelsRootTrusted && process.env.KUBIC_TRUST_PROJECT === undefined
      ? { KUBIC_TRUST_PROJECT: '1' }
      : {};

  // The orchestrator writes its state under `<repo>/.kubic/` from the very
  // first save (and adds worktrees under the configured `[orchestrator].root`
  // — `.kubic/wt` by default). Make sure that dir never dirties the tree it
  // sits in (§35: `.kubic/` is gitignored) BEFORE the first write —
  // otherwise a fresh scratch repo shows `?? .kubic/` and the pre-merge
  // guard refuses every merge, so no run can ever settle. Best-effort here:
  // a repo we cannot write into fails later with its own named code.
  if (root !== undefined) {
    try {
      ensureStateIgnored(root, debug, excludeEntries);
    } catch {
      // Intentionally swallowed — the named failure comes from the write path.
    }
  }

  // Issue #363: baseline `.git/config` + `.git/hooks` before any worker
  // runs. Verified after each worker settle and each merge — drift is
  // reported on the run log (the worker journal already records the
  // offending tool call; these lines name what it left behind). Best
  // effort: an unreadable gitdir degrades to no baseline, never a failure.
  let gitGuardBefore: ReturnType<typeof snapshotGitGuard> | undefined;
  if (root !== undefined) {
    try {
      gitGuardBefore = snapshotGitGuard(root);
    } catch {
      gitGuardBefore = undefined;
    }
  }
  const verifyGitGuard = (label: string): void => {
    if (gitGuardBefore === undefined || root === undefined) return;
    try {
      for (const line of diffGitGuardSnapshots(
        gitGuardBefore,
        snapshotGitGuard(root),
      )) {
        debug(`${label}: ${line}`);
      }
    } catch {
      // Best effort — reporting drift must never fail a settle.
    }
  };

  // Crash recovery (§51): a previous manager that died hard (SIGKILL,
  // crash past the signal guard) left rows claiming live workers. Reconcile
  // them before this run spawns anything: an orphan still running under
  // its own `--session` is killed, a dead one is marked crashed.
  if (root !== undefined) {
    try {
      const bridge = createNodeFileBridge(join(root, '.kubic', 'orchestrator'));
      const stale = readWorkerRows(bridge, WORKER_ROWS_FILE);
      if (stale.length > 0) {
        const reconciled = await reconcileWorkerRows(stale, {
          alive: pidAlive,
          killGroup: killProcessGroup,
          command: async (pid) => {
            const ps = await new NodeExecutionEnv(root).shell
              .spawn('ps', ['-ww', '-o', 'command=', '-p', String(pid)], {
                provenance: provenanceFor('cli', 'manager', 'orphan-probe'),
              })
              .wait();
            return ps.exitCode === 0 ? ps.stdout.trim() : undefined;
          },
        });
        for (const id of reconciled.reaped) {
          debug(
            `workers: killed orphaned worker '${id}' left by a dead manager`,
          );
        }
        for (const id of reconciled.marked) {
          debug(`workers: marked '${id}' crashed (its manager is gone)`);
        }
        if (reconciled.reaped.length + reconciled.marked.length > 0) {
          // Re-read at write time (the `ps` awaits above can interleave with
          // another run): only rows still exactly as we judged them change.
          const judged = new Map(
            reconciled.rows.map((row) => [
              `${row.workerId}:${row.generation}:${row.pid ?? '-'}`,
              row,
            ]),
          );
          updateWorkerRowsFile(workerRowsPath(root), (current) =>
            current.map((row) => {
              const next = judged.get(
                `${row.workerId}:${row.generation}:${row.pid ?? '-'}`,
              );
              // §13 (issue #151): the AGENT state decides whether the row
              // still claims live work — the process phase alone cannot (a
              // settling agent's process is already gone).
              return next !== undefined &&
                !isTerminalAgentStatus(row.agentStatus)
                ? next
                : row;
            }),
          );
        }
      }
    } catch (error) {
      debug(
        `workers: orphan reconciliation skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // The session branch at start is the merge target and the hunk base.
  // Resolved lazily (only inside a repo) and cached per process.
  let baseRef: string | undefined;
  const resolveBase = async (
    repo: string,
    sessionId: string,
  ): Promise<string> => {
    if (baseRef !== undefined) return baseRef;
    const branch = await runGit(
      repo,
      ['branch', '--show-current'],
      sessionId,
      'manager',
      'base-branch',
    );
    const name = branch.stdout.trim();
    if (branch.exitCode === 0 && name.length > 0) {
      baseRef = name;
      return baseRef;
    }
    const head = await runGit(
      repo,
      ['rev-parse', 'HEAD'],
      sessionId,
      'manager',
      'base-head',
    );
    baseRef = head.stdout.trim();
    return baseRef;
  };

  const storeName = (sessionId: string): string => `${sessionId}.json`;

  // The lifecycle rows live beside the run state under the repo's runtime
  // dir (§35 keeps `.kubic/` out of the commit path).
  const persistWorkerRowsNow = (): void => {
    if (root === undefined) return;
    try {
      const ours = workerRegistry
        .list()
        .map((row) => ({ ...row, managerPid: process.pid }));
      const mine = new Set(ours.map((row) => row.workerId));
      // Locked read-modify-write against the file AS IT IS NOW: rows another
      // run wrote stay in the record (never clobbered), atomically.
      updateWorkerRowsFile(workerRowsPath(root), (current) => [
        ...current.filter((row) => !mine.has(row.workerId)),
        ...ours,
      ]);
    } catch (error) {
      // Best-effort: a status listing must never fail a run.
      debug(
        `workers: could not persist lifecycle rows: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  // Worker sessions live in the user sessions root (one store for the whole
  // CLI, `kubic sessions`/`diff --session` read the same place). Injected
  // in tests; the real run uses the default root.
  const sessionsRoot = options.sessionsRoot ?? defaultSessionsRoot();
  const sessionBridge = createNodeFileBridge(sessionsRoot);
  const sessionStore = openSessionStore(sessionsRoot, sessionBridge);

  // Pre-merge guard (issue #76 fix a): a kill-during-merge can leave a
  // stale MERGE_HEAD behind, so a resume would merge onto a half-merged
  // tree. Abort the stale merge first, then refuse a dirty tree — the
  // merge never runs unless the tree is provably clean.
  const ensureCleanMergeState = async (
    repo: string,
    agentId: string,
  ): Promise<void> => {
    const merging = await runGit(
      repo,
      ['rev-parse', '--verify', 'MERGE_HEAD'],
      'cli',
      'manager',
      'merge-guard',
    );
    if (merging.exitCode === 0) {
      debug(
        `merge: stale MERGE_HEAD before merging '${agentId}' — aborting first`,
      );
      const abort = await runGit(
        repo,
        ['merge', '--abort'],
        'cli',
        'manager',
        'merge-abort-stale',
      );
      if (abort.exitCode !== 0) {
        throw new Error(
          `stale merge in progress (MERGE_HEAD) and 'git merge --abort' failed: ${abort.stderr.trim().slice(0, 200)}`,
        );
      }
    }
    const status = await runGit(
      repo,
      ['status', '--porcelain=v1'],
      'cli',
      'manager',
      'merge-status',
    );
    if (status.exitCode !== 0) {
      throw new Error(
        `pre-merge status check failed: ${status.stderr.trim().slice(0, 200)}`,
      );
    }
    if (status.stdout.trim().length > 0) {
      throw new Error(
        `working tree not clean — refusing merge for worker '${agentId}': ${status.stdout.trim().slice(0, 200)}`,
      );
    }
  };

  // The §59.1 honest-limits notice travels with the FIRST spawn of a run
  // (issue #95 wired the pure-string module at its spawn site): every worker
  // gets one worktree and one process, and that separates concurrent
  // writers only — it is not isolation and not containment. Printed once so
  // the operator sees it before any worker runs, never per worker.
  let noticeEmitted = false;
  const emitWorktreeNotice = (): void => {
    if (noticeEmitted) return;
    noticeEmitted = true;
    for (const line of buildOrchestratorWorktreeNotice()) debug(line);
  };

  // The manager's live approval snapshot (issue #106, §45.2): a resolver is
  // spawned UNDER this snapshot — same route, same auto-approve set, same
  // pending timeout — so there is no second policy on the delegation path.
  // main.ts threads the loaded config's policy in; absent one (an embedder
  // that wires no config) the resolver path is simply not delegated and the
  // conflict terminates exactly as it did before delegation existed.
  const approvalSnapshot = options.approvalPolicy;
  // The interactive merge seat (issue #130, §41.2/§45.2): bounded by the
  // same `approvalPolicy.maxPendingMs` snapshot the resolver path carries
  // (issue #106) — the bound every other ask already uses. An elapse settles
  // the TIMEOUT verdict (not a refusal), so a walked-away user never holds
  // sessions, worktrees and the terminal open — and is never mislabelled as
  // a decided no. A run that holds no snapshot has no bound to enforce: no
  // seat is attached and the shipped deny-closed path (exit 4, "rerun with
  // --yes") is what runs.
  //
  // Built as an IIFE so the async seat is a returned expression: Babel's
  // TypeScript parser, which the mutation runner instruments with, rejects a
  // type-annotated `async` arrow directly inside a conditional
  // (`cond ? async (input: { … }) => … : undefined`).
  const mergeApprovalSeat = ((): OrchestrateCommandDeps['requestApproval'] => {
    // An embedder that owns the terminal decides for itself (issue #327).
    if (options.mergeApproval !== undefined) return options.mergeApproval;
    if (process.stdin.isTTY !== true || approvalSnapshot === undefined) {
      return undefined;
    }
    const snapshot = approvalSnapshot;
    return async (input) =>
      boundedAskUser(
        `approve merge of '${input.agentId}' (${input.branch})? [y/N] `,
        {
          maxPendingMs: snapshot.maxPendingMs,
          candidate: input.agentId,
        },
      );
  })();

  // §36.3 worker provider credentials (issue #200). The manager's models are
  // assembled ONCE — provider key env names plus the first usable provider
  // the workers fall back to — and every worker/resolver grant is resolved
  // from that same view. The preflight below and the launches share one
  // memoized lookup, so what the preflight approves is exactly what a launch
  // delivers. Values never leave this closure except through the role grant
  // (redacted on every log surface by key provenance).
  //
  // The manager loads the project models.json under the SAME per-root trust
  // decision every worker child receives (issue #200/#222): a `kubic trust`
  // grant for the models root reaches the child as the env opt-in, so the
  // manager must not treat the file as untrusted while the worker loads it —
  // that left the manager's grant empty and the worker exiting 6 `Provider
  // is not configured`. The check is the per-root one (never the launch
  // cwd's boolean); without a grant the file stays ignored (the env opt-in
  // itself is honoured inside assembleModels).
  const assembledModels =
    options.models ??
    (await assembleModels(root ?? cwd, process.env, {
      ...(options.projectTrust === undefined
        ? {}
        : { projectTrust: options.projectTrust }),
    }));
  for (const note of assembledModels.notes) debug(note);
  const credentialBrokerOption =
    options.requireCredentialBroker === true
      ? { requireCredentialBroker: true as const }
      : {};
  // The fallback the workers land on must be one whose credential this host
  // can actually deliver (issue #200). A fallback candidate whose key is not
  // in this environment is SKIPPED rather than turned into a pre-run refusal:
  // the host only GUESSES the child's implicit pick here, and refusing a run
  // on a guess is worse than the child naming the provider it really picked.
  // Explicit pins (the operator's KUBIC_MODEL, the role's resolved model, the
  // manager's `[model]`) are not guesses — their undeliverable credential IS
  // a preflight refusal.
  const fallbackProvider = firstDeliverableProvider(
    assembledModels.fallbackProviders,
    {
      keyEnv: assembledModels.keyEnv,
      env: process.env,
      ...credentialBrokerOption,
    },
  );
  const modelFrozen = options.modelPinFrozen === true;
  const credentialResolution = {
    ...(modelFrozen ? { modelFrozen: true } : {}),
    ...(process.env.KUBIC_MODEL === undefined || process.env.KUBIC_MODEL === ''
      ? {}
      : { envModel: process.env.KUBIC_MODEL }),
    ...(options.model === undefined
      ? {}
      : { managerModel: `${options.model.provider}/${options.model.id}` }),
    ...(fallbackProvider === undefined ? {} : { fallbackProvider }),
  };
  const credentialCache = new Map<string, ProviderGrantResult>();
  const workerGrant = (
    agentId: string,
    role: string,
    modelRef: string | undefined,
  ):
    | { grant: Record<string, string>; refusal: undefined }
    | {
        grant: undefined;
        refusal: WorkerCredentialRefusal;
      } => {
    const cacheKey = `${agentId}|${modelRef ?? ''}`;
    let resolved = credentialCache.get(cacheKey);
    if (resolved === undefined) {
      const provider = resolveWorkerProvider({
        ...credentialResolution,
        ...(modelRef === undefined ? {} : { modelRef }),
      });
      resolved = resolveProviderGrant(provider, {
        keyEnv: assembledModels.keyEnv,
        env: process.env,
        ...credentialBrokerOption,
      });
      credentialCache.set(cacheKey, resolved);
    }
    if (resolved.kind === 'refusal') {
      return {
        grant: undefined,
        refusal: {
          agentId,
          role,
          provider: resolved.provider,
          message: resolved.message,
        },
      };
    }
    return { grant: resolved.grant, refusal: undefined };
  };
  // Issue #282: the worktree's base revision for the §60 rows — HEAD at
  // creation (or at resume), best-effort. A failed probe keeps the honest
  // unknown instead of failing the spawn.
  const captureWorktreeBase = async (
    agentId: string,
    worktreePath: string,
    ownerSession: string | undefined,
  ): Promise<void> => {
    try {
      const head = await runGit(
        worktreePath,
        ['rev-parse', 'HEAD'],
        ownerSession ?? 'cli',
        agentId,
        'worktree-base',
      );
      const sha = head.stdout.trim();
      if (head.exitCode === 0 && sha !== '') baseByAgent.set(agentId, sha);
    } catch (error) {
      debug(
        `audit: base revision probe failed for '${agentId}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  // §60 privileged-action rows (issue #284): one row per worker spawn /
  // terminate and per worktree creation, with the same provenance block as
  // the ask rows. Best-effort: a failed append surfaces on the debug
  // channel (stderr) and never fails the run. The ledger is the repo
  // runtime root's (issue #279), like the merge rows.
  const appendPrivileged = (
    record: ReturnType<typeof workerSpawnAudit>,
    kind: string,
  ): void => {
    appendToLedger(auditLedgerDirFor(needRoot()), record, (message) =>
      debug(`audit: ${kind} not recorded — ${message}`),
    );
  };
  const privilegedPosture = (): string =>
    approvalsActive?.fullAccessGrant() === undefined
      ? POSTURE_APPROVALS
      : POSTURE_FULL_ACCESS;
  const workerLedgerBase = (input: {
    agentId: string;
    role: string;
    worktree: string;
    model?: string;
    pid?: number;
    generation: number;
  }): {
    sessionId: string;
    agentId: string;
    role: string;
    worktree: string;
    model?: string;
    thinking?: string;
    base?: string;
    pid?: number;
    generation: number;
    posture: string;
  } => {
    const thinking = thinkingByAgent.get(input.agentId);
    const base = baseByAgent.get(input.agentId);
    return {
      sessionId: orchestratorSessionId ?? 'orch',
      agentId: input.agentId,
      role: input.role,
      worktree: input.worktree,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(thinking === undefined ? {} : { thinking }),
      ...(base === undefined ? {} : { base }),
      ...(input.pid === undefined ? {} : { pid: input.pid }),
      generation: input.generation,
      posture: privilegedPosture(),
    };
  };
  const auditWorkerSpawn = (input: {
    agentId: string;
    role: string;
    worktree: string;
    model?: string;
    pid?: number;
    generation: number;
  }): void => {
    appendPrivileged(workerSpawnAudit(workerLedgerBase(input)), 'worker:spawn');
  };
  const auditWorkerTerminate = (input: {
    agentId: string;
    role: string;
    worktree: string;
    model?: string;
    pid?: number;
    generation: number;
    reason: string;
    result: 'ok' | 'error';
  }): void => {
    appendPrivileged(
      workerTerminateAudit({
        ...workerLedgerBase(input),
        reason: input.reason,
        result: input.result,
      }),
      'worker:terminate',
    );
  };
  return {
    out: options.out,
    err: options.err,
    ...(options.theme === undefined ? {} : { theme: options.theme }),
    ...(options.errTheme === undefined ? {} : { errTheme: options.errTheme }),
    debug,
    // Issue #133: the configured worker cap is the run's own admission
    // surface — the same scheduler the CLI would default to, constructed
    // with the validated `[orchestrator].maxWorkers` as its default. Unset
    // builds no scheduler and the CLI's shipped default cap of four stands;
    // the run's `--concurrency` override (issue #206) is applied to whichever
    // scheduler it gets.
    ...(maxWorkers === undefined
      ? {}
      : {
          scheduler: new ParallelScheduler(undefined, {
            configured: { maxWorkers },
          }),
        }),
    isGitRepo: () => root !== undefined,
    // §44.1 retained-worktree status (issue #106): the run retained these
    // worktrees as evidence, so the operator is told which of them are dirty
    // and where. Real `git -C <path> status --porcelain=v2 -z -b` through the
    // exec Shell seam, anchored to the repo root so a foreign path can never
    // be reported as a spawned worktree.
    worktreeStatus: async (path, options) => {
      const repo = root;
      const env = new NodeExecutionEnv(repo ?? path);
      return getWorktreeStatus(env, path, {
        sessionId: options.sessionId,
        ...(repo === undefined ? {} : { repoRoot: repo }),
        ...(worktreeRoot === undefined ? {} : { worktreeRoot }),
      });
    },
    // Step 7 (issue #431): the manager lane's prod seams. The lane drives
    // only under the L-D34 opt-in (`--manager-lane` or `[orchestrator]
    // manager = "lane"`) AND a resolved manager model — the explicit
    // `--model` pin, or the first model of the first deliverable fallback
    // provider (already auth-filtered, so the lane never boots on a model
    // it cannot call). Otherwise the run keeps the deterministic template
    // path, and a debug note says why the lane stayed off.
    managerLaneOptIn:
      options.managerLane === true || options.orchestrator?.manager === 'lane',
    managerModels: assembledModels.models,
    ...(() => {
      if (options.model !== undefined) {
        return {
          managerModel: {
            provider: options.model.provider,
            id: options.model.id,
          },
        };
      }
      if (fallbackProvider !== undefined) {
        const first = assembledModels.models.getModels(fallbackProvider).at(0);
        if (first !== undefined) {
          return {
            managerModel: { provider: fallbackProvider, id: first.id },
          };
        }
      }
      debug(
        'manager lane off: no manager model resolved (no --model pin and no deliverable fallback provider) — the run keeps the template path',
      );
      return {};
    })(),
    // The manager conversation's session (issue #431): attach-or-create on
    // the run's own session store, returned HELD — the router releases it
    // after the lane closes, so a later `--resume` re-attaches.
    openManagerSession: async (sessionId: string) => {
      try {
        return await attachSession(sessionStore, sessionId, BACKGROUND_CONTEXT);
      } catch (error) {
        if (!(error instanceof SessionAttachError)) throw error;
        return await createSession(
          sessionStore,
          { id: sessionId, cwd: root ?? cwd },
          BACKGROUND_CONTEXT,
        );
      }
    },
    // The manager's `ask_user` seat (issue #431): an injected seat wins
    // (tests do), else a TTY run asks on the terminal and a headless run
    // denies closed. The router races the seat against the ask bound, so
    // an abandoned prompt resolves unanswered instead of hanging the turn.
    askUserSeat:
      options.askUserSeat ??
      (process.stdin.isTTY === true
        ? async (question: string) => {
            const rl = createInterface({
              input: process.stdin,
              output: process.stderr,
            });
            try {
              const answer: string = await new Promise((resolveAnswer) => {
                rl.question(`manager asks: ${question}\n> `, resolveAnswer);
                rl.on('close', () => resolveAnswer(''));
              });
              const text = answer.trim();
              return text === ''
                ? {
                    answered: false as const,
                    code: QUESTION_UNANSWERED_CODE,
                    reason: 'no answer was typed (empty line)',
                  }
                : { answered: true as const, text };
            } finally {
              rl.close();
            }
          }
        : async () => ({
            answered: false as const,
            code: QUESTION_UNANSWERED_CODE,
            reason: 'no ask seat is wired for this run (headless)',
          })),
    // Read-only git inspection for the lane (issue #431): the three reader
    // ops over the op registry, rooted at the repo the run orchestrates.
    // Bounded at the adapter (32k); failures refuse by name, never raw.
    inspectGit: async (tool, args) => {
      const repoRoot = root ?? cwd;
      const invocationId = `manager-git-${gitInvocationCounter++}`;
      const outcome = await callOperation(
        tool,
        args,
        {
          invocationId,
          operationId: 'manager',
          turnId: 'manager',
          keepEffectMemo: false,
          getMemo: () => Promise.resolve(undefined),
          setMemo: () => Promise.resolve(undefined),
          memoOnce: (_name, candidate) => Promise.resolve(candidate),
        },
        {
          env: new NodeExecutionEnv(repoRoot),
          sessionId: orchestratorSessionId ?? 'orch',
          agentId: 'manager',
        },
      );
      if (!outcome.ok) {
        throw new Error(
          `${tool} failed: ${outcome.error?.message ?? outcome.error?.code ?? 'unknown error'}`,
        );
      }
      const result = (outcome as { result?: unknown }).result as
        | { status?: unknown; diff?: unknown; log?: unknown }
        | undefined;
      const text =
        tool === 'git_status'
          ? result?.status
          : tool === 'git_diff'
            ? result?.diff
            : result?.log;
      if (typeof text !== 'string') {
        throw new Error(`${tool} returned no text`);
      }
      return text;
    },
    trajectoryEvent:
      options.trajectoryEvent ??
      ((event: ParallelTrajectoryEvent): void => {
        // §49.1 trajectory record (issue #106): appended next to the run
        // state, best-effort — a telemetry write must never fail a run.
        if (root === undefined) return;
        try {
          // The EVENT carries the session id, and the sink reads that one:
          // the first spawn's admission request happens before this run has
          // created any worker session, so a sink keyed on the run's
          // captured id silently dropped exactly the event it exists to
          // record (measured: the queue event fired, the file never
          // appeared).
          createNodeFileBridge(join(root, '.kubic', 'orchestrator')).appendFile(
            `${event.sessionId}.trajectory.jsonl`,
            `${JSON.stringify(event)}\n`,
          );
        } catch (error) {
          debug(
            `trajectory: could not append the parallel event: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }),
    ...(approvalSnapshot === undefined
      ? {}
      : {
          approvalPolicy: approvalSnapshot,
          policyHash: hashApprovalPolicy(approvalSnapshot),
        }),
    launches: launchesView(workerRegistry, launchedByAgent),
    // §12 role assignment on the delegation path (issue #104): the real
    // `.kubic/roles/*.md` documents are read through the exec FileBridge at
    // orchestrator startup, resolved by the live loader (roles-boot.ts), and
    // projected to one role per worker. The refusal is fail-closed in the
    // CLI (role_refused) with the resolver's named reason; this hook only
    // reports what the documents say — it never invents a role.
    loadWorkerRoles: (agents: readonly string[], binding?) => {
      const cwd = options.cwd ?? process.cwd();
      return planWorkerRoles({
        bridge: createNodeFileBridge(cwd),
        cwd,
        // Issue #229: worker roles resolve at the manager's project
        // root, not wherever the manager was launched from.
        projectRoot: findProjectRoot(createNodeFileBridge(cwd), cwd, homedir()),
        agents,
        // §38.1 (#202): the manager's own effective model is the fallback
        // level under each role's `[roles.<r>].model`, and the run's explicit
        // thinking level (`KUBIC_MODEL_THINKING`) outranks the role default.
        ...(options.model === undefined
          ? {}
          : { parentModel: `${options.model.provider}/${options.model.id}` }),
        ...(thinkingOverride === undefined ? {} : { thinkingOverride }),
        // The explicit per-agent binding (issue #178): the role each worker
        // was told on the command line, and its own model pin.
        ...(binding === undefined || Object.keys(binding.roles).length === 0
          ? {}
          : { roles: binding.roles }),
        ...(binding === undefined || Object.keys(binding.models).length === 0
          ? {}
          : { models: binding.models }),
        ...(options.toolPolicy === undefined
          ? {}
          : { toolPolicy: options.toolPolicy }),
        ...(options.roleLayers === undefined
          ? {}
          : { layers: options.roleLayers }),
        // Issue #430 (§33, L-D27): worker roles resolve under the same
        // per-path trust check as the run — the manager refuses an
        // untrusted root's overrides before any worktree exists. The
        // KUBIC_TRUST_PROJECT opt-in travels to the children as env
        // (issue #228), so a trusted manager keeps trusted workers.
        ...(options.projectTrust === undefined
          ? {}
          : { trustProject: options.projectTrust }),
      });
    },
    // §36.3 credential preflight (issue #200): the same memoized lookup the
    // launches use, so an approved plan is exactly the delivered grant. The
    // CLI fails the run closed (exit 6, provider named) before any state
    // write, worktree or session when this returns a refusal.
    preflightWorkerCredentials: (requests) => {
      let refusal: WorkerCredentialRefusal | undefined;
      for (const request of requests) {
        const resolved = workerGrant(
          request.agentId,
          request.role,
          request.modelRef,
        );
        refusal ??= resolved.refusal;
      }
      return refusal;
    },
    ensureWorktree: async (
      agentId: string,
      context?: WorktreeRequest,
    ): Promise<OrchestrateWorktree> => {
      const repo = needRoot();
      emitWorktreeNotice();
      const env = new NodeExecutionEnv(repo);
      ensureStateIgnored(repo, debug, excludeEntries);
      const worktreeStarted = Date.now();
      // Issue #144: the worktree and branch are scoped by the owning
      // orchestrator session (`kubic/<session>/<agent>`), so a retained tree
      // from another run is never this run's worktree.
      const ownerSession = context?.sessionId;
      try {
        const added = await addWorktree(env, repo, agentId, {
          sessionId: ownerSession ?? 'cli',
          ...(ownerSession === undefined ? {} : { ownerSession }),
          ...(worktreeRoot === undefined ? {} : { worktreeRoot }),
        });
        // §61 (issue #158): the duration ends when creation RETURNS — the
        // launch sample must report the creation leg, not the gap until the
        // child is spawned.
        worktreeMsByAgent.set(agentId, Date.now() - worktreeStarted);
        for (const warning of added.warnings) debug(`gap: ${warning.message}`);
        // Issue #282: the worktree's base revision for the §60 rows — HEAD
        // at creation, best-effort (a failed probe keeps the honest
        // unknown rather than failing the spawn).
        await captureWorktreeBase(agentId, added.path, ownerSession);
        // §60 privileged-action row (issue #284): the fresh creation, with
        // the base just captured above. A resumed tree is not a creation —
        // it records nothing here.
        const createdBase = baseByAgent.get(agentId);
        appendPrivileged(
          worktreeCreateAudit({
            sessionId: ownerSession ?? orchestratorSessionId ?? 'cli',
            agentId,
            path: added.path,
            branch: added.branch,
            ...(createdBase === undefined ? {} : { base: createdBase }),
            posture: privilegedPosture(),
          }),
          'worktree:create',
        );
        return { path: added.path, branch: added.branch };
      } catch (error) {
        if (!isWorktreeError(error) || error.code !== 'already_exists') {
          throw error;
        }
        const path = pathForAgent(repo, agentId, worktreeRoot, ownerSession);
        const branch = branchForAgent(agentId, ownerSession);
        // Only a --resume of the SAME session may reuse the tree: the names
        // carry the session, so an existing tree under them is that
        // session's own. A fresh run that finds one fails closed — the tree
        // may be dirty or unmerged, and the worker commit would take its
        // leftovers as this run's work.
        if (context?.resume !== true) {
          const session = ownerSession ?? '<id>';
          throw new WorktreeError(
            'worktree_exists',
            `worktree ${path} (branch ${branch}) is retained from an earlier run of session '${session}' — continue it with \`kubic orchestrate --resume --session ${session}\` or dispose it with \`kubic clean --session ${session}\``,
            1,
          );
        }
        // Resume tolerance: the worktree/branch from a killed run is
        // reused — never rebuilt over, never silently dropped. The
        // directory must really be there: handing a vanished path to the
        // child spawn dies as a raw `spawn … ENOENT` uncaught event with
        // no §78 code (issue #85), so fail closed with a named error.
        let present = false;
        try {
          present = env.fs.stat(path).isDirectory;
        } catch {
          present = false;
        }
        if (!present) throw worktreeMissingError(path, branch);
        debug(`worktree: resuming '${agentId}' in its own ${path}`);
        worktreeMsByAgent.set(agentId, Date.now() - worktreeStarted);
        // Issue #282: a resumed tree's base is HEAD at resume time.
        await captureWorktreeBase(agentId, path, ownerSession);
        return { path, branch };
      }
    },
    // Per-worker approvals (issue #105): the run constructs ONE approvals
    // layer when the CLI asked for one. Its mailbox path travels to each child
    // through the §3.8 allowlist (KUBIC_APPROVALS_DIR), so a challenged call
    // the child cannot answer is published for the manager to route to the
    // user — never stopped at a missing surface.
    approvals: (approvalOptions: {
      sessionId: string;
      maxPendingMs: number;
      budget?: unknown;
      budgetForAgent?: (agentId: string) => unknown;
      fullAccess?: boolean;
      fresh?: boolean;
    }): WorkerApprovalsRun => {
      // §41.4 (issue #308): the shared enable path — one §60 row naming the
      // orchestration session and the command, and the common stderr
      // warning. The posture itself is the run's own skip record below.
      if (approvalOptions.fullAccess === true) {
        const grant = enableSessionFullAccess({
          sessionId: approvalOptions.sessionId,
          command: 'orchestrate',
          workspace: needRoot(),
          mode: 'orchestrator',
          onAuditError: (message) =>
            debug(`audit: ledger append failed: ${message}`),
        });
        options.err(`warning: ${grant.warning}`);
      }
      const run = createOrchestratorApprovalsRun({
        // The router's §60 decisions land in `<dir>/approvals/audit.jsonl`:
        // the repo runtime root's ledger (issue #279), the one `kubic audit`
        // reads, whichever checkout the run started from.
        dir: join(resolveRepoRuntimeRoot(needRoot()), '.kubic', 'orchestrator'),
        sessionId: approvalOptions.sessionId,
        maxPendingMs: approvalOptions.maxPendingMs,
        ...(questionSeat === undefined ? {} : { questionSeat }),
        ...(approvalOptions.budget === undefined
          ? {}
          : { budget: approvalOptions.budget }),
        // Per-spawn budget spec (§71, issue #105): the CLI decodes
        // `--budget <agent>:<dims>` and this hands it to the spawn's own gate,
        // so an override never widens another worker's limit.
        ...(approvalOptions.budgetForAgent === undefined
          ? {}
          : { budgetForAgent: approvalOptions.budgetForAgent }),
        ...(approvalOptions.fullAccess ? { fullAccess: true } : {}),
        ...(approvalOptions.fresh ? { fresh: true } : {}),
        // §13 WAITING (issue #151): the router's ask-state changes become the
        // worker row's waiting/running state.
        onAskState: workerAskStateObserver(
          workerRegistry,
          persistWorkerRowsNow,
        ),
        // The TTY seat when this run has a user attached; without one a
        // worker ask denies closed on the router's own bound (never a silent
        // hang). `--yes` never replaces it (issue #323): the standing answer
        // is the merge gate's only.
        ...(optionsSeat === undefined ? {} : { seat: optionsSeat }),
        // §60 audit provenance (issue #282): the registry row (pid,
        // generation), the resolved thinking level and the worktree base —
        // read at record time, so a respawn records the new generation.
        provenanceFor: askProvenanceForWorker(workerRegistry, {
          thinkingByAgent,
          baseByAgent,
          ...(thinkingOverride === undefined
            ? {}
            : { thinkingFallback: thinkingOverride }),
        }),
        debug: (line) => debug(line),
      });
      approvalsActive = run;
      approvalsBoundMs = approvalOptions.maxPendingMs;
      return run;
    },
    createWorkerSession: async (input) => {
      orchestratorSessionId = input.sessionId;
      // Issue #164 (§22–§23): the spawnAgent parent-linkage rule, enforced
      // where sessions are actually created — a worker session id that IS
      // the run id would parent the tree to itself.
      if (input.workerSessionId === input.sessionId) {
        throw new Error(
          `spawn failed for worker '${input.agentId}': sessionId must differ from parentSessionId (parent linkage)`,
        );
      }
      // The manager session record: the tree root every worker session
      // parents to. Attach-or-create (a resumed run reuses it); a record
      // only, never booted — its cwd is the run's repo root. Spawns admit
      // concurrently (#206), and the Kubic lock refuses even a same-process
      // second attach, so concurrent ensures share ONE in-flight task:
      // the winner attaches-or-creates while the rest await it, and a
      // failure drops the entry so the next spawn retries instead of
      // awaiting a rejected promise forever.
      const live = managerSessionEnsured.get(input.sessionId);
      if (live !== undefined) {
        await live;
      } else {
        const task = (async (): Promise<void> => {
          try {
            const manager = await attachSession(
              sessionStore,
              input.sessionId,
              BACKGROUND_CONTEXT,
            );
            await manager.release(BACKGROUND_CONTEXT);
          } catch (error) {
            // A live holder proves the record exists: on the lane path the
            // manager conversation itself holds the run session (issue
            // #431), so the ensure is already satisfied — never a spawn
            // failure.
            if (error instanceof SessionLockError) return;
            if (!(error instanceof SessionAttachError)) throw error;
            const manager = await createSession(
              sessionStore,
              {
                id: input.sessionId,
                cwd: root ?? cwd,
                // Issue #278 (§19): the run's mode on the manager record.
                mode: input.mode,
              },
              BACKGROUND_CONTEXT,
            );
            await manager.release(BACKGROUND_CONTEXT);
          }
        })();
        managerSessionEnsured.set(input.sessionId, task);
        try {
          await task;
        } finally {
          if (managerSessionEnsured.get(input.sessionId) === task) {
            managerSessionEnsured.delete(input.sessionId);
          }
        }
      }
      // §61 (issue #158): time the create/attach leg — the sample's attachMs.
      const attachStartedAt = Date.now();
      // Create the worker's session before the child spawns (issue #85):
      // `kubic run --session <id>` only ATTACHES, so without this the child
      // dies at attach (exit 5 "unknown session") before any model call.
      // The cwd is the worker's WORKTREE, so worker journals, usage, and
      // session state land with the worker — never in the parent repo.
      // Resume tolerance: a session left by a killed run is re-attached
      // (one chain), never recreated into a "Session already exists" fail.
      try {
        const existing = await attachSession(
          sessionStore,
          input.workerSessionId,
          BACKGROUND_CONTEXT,
        );
        // The worker's whole point is that its state travels with its
        // worktree: a session recorded against a different cwd (a hand
        // re-pointed id, a worktree moved and re-added) would silently
        // journal somewhere else. Fail closed rather than misuse it.
        const recorded = existing.meta.cwd;
        // Issue #147 (§21): a turn the killed worker left open is resumed by
        // the child itself — its `kubic run -p` carries the same plan-step
        // prompt, so the pending run is resumed AS this run, never
        // re-prompted. Named here so the resume is observable; the probe is
        // a read of the session's own storage (#396), no harness boot.
        let pending: string[] = [];
        try {
          const report = await inspectStoredWork(
            existing.storage,
            BACKGROUND_CONTEXT,
          );
          pending = report.summary === undefined ? [] : [report.summary];
        } finally {
          await existing.release(BACKGROUND_CONTEXT);
        }
        if (recorded !== input.worktree.path) {
          throw new Error(
            `session '${input.workerSessionId}' belongs to ${recorded ?? '(no cwd)'}, not the worker worktree ${input.worktree.path}`,
          );
        }
        debug(
          `session: reusing '${input.workerSessionId}' from the killed run${
            pending.length === 0
              ? ''
              : ` (${pending.join('; ')} will be resumed by the worker)`
          }`,
        );
        attachMsByAgent.set(input.agentId, Date.now() - attachStartedAt);
        return { sessionId: input.workerSessionId };
      } catch (error) {
        if (!(error instanceof SessionAttachError)) throw error;
      }
      const session = await createSession(
        sessionStore,
        {
          id: input.workerSessionId,
          cwd: input.worktree.path,
          parentSessionId: input.sessionId,
          ...(input.role === undefined ? {} : { role: input.role }),
          agentId: input.agentId,
          // Issue #278 (§19): the run's mode on the worker record.
          mode: input.mode,
        },
        BACKGROUND_CONTEXT,
      );
      const id = session.id;
      try {
        // The session dir exists; create the journal dir the worker's
        // file effects will land in (same layout as `kubic run`, E3) so
        // `journal:<id>` resolves for the worker's worktree effects.
        sessionBridge.createDir(join(id, 'journal'));
      } finally {
        await session.release(BACKGROUND_CONTEXT);
      }
      debug(
        `session: created '${id}' for worker '${input.agentId}' (cwd ${input.worktree.path})`,
      );
      attachMsByAgent.set(input.agentId, Date.now() - attachStartedAt);
      return { sessionId: id };
    },
    runWorker: async (
      agentId: string,
      worktree: OrchestrateWorktree,
      prompt: string,
      info?: WorkerSpawnInfo,
    ): Promise<WorkerRunOutput> => {
      const workerSession =
        info?.workerSessionId ??
        workerSessionFor(info?.sessionId ?? 'orch', agentId);
      // §68 provenance (issue #185): the model the child was pinned to (its
      // own report names the one it actually ran, and wins) and thinking.
      // §38.1 (#202): the pin is the role's own `[roles.<r>].model` when its
      // worker got one, then the manager's effective model — the same value
      // the child's `KUBIC_MODEL` carries below.
      const modelPin = modelFrozen
        ? options.model === undefined
          ? undefined
          : `${options.model.provider}/${options.model.id}`
        : (info?.modelRef ?? process.env.KUBIC_MODEL);
      // Issue #202: the child's thinking level is the resolved per-worker one
      // (the run's explicit `KUBIC_MODEL_THINKING`, else the role's default);
      // the manager's ambient value is the fallback.
      const thinking = info?.thinking ?? process.env.KUBIC_MODEL_THINKING;
      // Issue #282: the resolved level for this worker's §60 rows.
      if (thinking !== undefined) thinkingByAgent.set(agentId, thinking);
      // Issue #94: the worker starts through the lifecycle layer, never by
      // reaching for the exec Shell here. launchWorker refuses a stale
      // generation, registers the row `kubic workers` reads, builds the
      // §3.8 allowlisted child env, waits for the readiness marker under a
      // timeout (a silent child is terminal SPAWN_FAILED, not a raw exit
      // code), records the §61 startup latency, and classifies a failed
      // child through the §52 codes.
      throwIfCancelled(agentId);
      // §71 (issue #208): the resolved budget for THIS spawn drives both the
      // child env handoff and the host's wall-clock watchdog. Read once so
      // the two can never disagree about which spec is in force.
      const budgetForSpawn = approvalsActive?.budgetFor(agentId);
      // §36.3 (issue #200): the worker's provider credential is the grant the
      // preflight approved — computed from the SAME role model pin the child
      // is told (`info.role`/`info.modelRef`), keyed under the role the child
      // reads back (its `--role`, or the 'worker' fallback when unassigned).
      const credentialGrant = workerGrant(
        agentId,
        info?.role ?? 'worker',
        info?.modelRef,
      );
      // §67 task resources (issue #170): the run's `--skill` values, resolved
      // against the manager's cwd. Issue #237: the manager's own settings
      // skills ride the same channel (already absolute from the config
      // load), ahead of the run flags so explicit intent wins conflicts.
      const skills = resolveSkillPaths(
        [...(options.settingsSkills ?? []), ...(info?.skills ?? [])],
        cwd,
      );
      // §67 (issue #191): the task and the capability grant travel together.
      // The manager builds and VALIDATES the worker's task before the child
      // exists — a task whose worktree is not absolute or whose tool set is
      // empty refuses the spawn by name — and writes it into the worker's
      // session dir, so the child registers exactly `task.toolNames` instead
      // of re-deriving a role from its own worktree (a checkout of HEAD, not
      // the working tree the plan was composed from). No role assignment
      // means no grant to transmit: no task file, and the child keeps its own
      // default lane.
      const taskFile = ((): string | undefined => {
        // No role assignment means no grant to transmit (the child keeps its
        // own default lane). An assignment with an EMPTY tool set is a task
        // that cannot validate — refused below, never silently widened to the
        // full solo set.
        if (info?.role === undefined) return undefined;
        const model = modelOfRef(info.modelRef);
        const built = buildAgentTask({
          taskId: `${workerSession}:${agentId}`,
          parentSessionId: info.sessionId,
          role: info.role,
          objective: prompt,
          worktree: worktree.path,
          toolNames: info.tools ?? [],
          ...(budgetForSpawn === undefined ? {} : { budget: budgetForSpawn }),
          ...(model === undefined ? {} : { model }),
          // Issue #196 (§40.2/§41.1): the role's classes and approval
          // obligations ride the §67 resources channel with the skills
          // (already absolute) — the child merges the classes with its
          // own config, most restrictive wins, and challenges the
          // requires on its triggers.
          resources: {
            ...(skills.length === 0 ? {} : { skills }),
            ...(info.classes === undefined
              ? {}
              : { classes: { ...info.classes } }),
            ...(info.requires === undefined || info.requires.length === 0
              ? {}
              : { requires: [...info.requires] }),
          },
        });
        if (!built.valid) {
          throw new AgentTaskRefusedError(agentId, built.errors);
        }
        return writeAgentTask(sessionBridge, workerSession, built.task);
      })();
      if (credentialGrant.refusal !== undefined) {
        // Defence in depth: the preflight checks this same memoized lookup
        // for every pending agent before any worktree exists, so reaching
        // here means the plan changed under the run — fail closed anyway.
        throw new Error(
          `worker '${agentId}': ${credentialGrant.refusal.message}`,
        );
      }
      const launched = launchWorker(
        {
          workerId: agentId,
          sessionId: workerSession,
          // §12.1 role on the worker lane (issue #104): the child `kubic run`
          // loads `.kubic/roles/<name>.md` from its own worktree and registers
          // exactly that role's resolved tool set — a withheld tool is never
          // registered (absence, not approval). The lifecycle row keeps the
          // role name too (§50: who started, as what).
          role: info?.role ?? 'worker',
          // §36.3 (issue #200): the grant is namespaced under the role the
          // child can read itself; `--role` is passed exactly when the role
          // is defined above, so the two agree by construction.
          grantRole: info?.role ?? 'worker',
          credentials: credentialGrant.grant,
          owner: `orchestrate:${info?.sessionId ?? 'orch'}`,
          // The child's base env is the parent's, filtered by the §3.8
          // allowlist inside the layer — never inherited wholesale. What
          // rides on top: the worker's resolved model and thinking level
          // (§38.1, issues #202/#178) and the approvals mailbox (issue #105).
          // The model is the role's `[roles.<r>].model` pin, the explicit
          // per-agent pin, or the manager's effective model — a real §38.1
          // level, not a default: it travels through the EXISTING
          // `KUBIC_MODEL` pin (the child's own selectModel honours it, so no
          // new model plumbing is introduced) and OVERWRITES an ambient
          // value, so the manager's env pin never outranks the role's pin.
          // Only a frozen enterprise pin drops it, because the child's own
          // load drops it too. The mailbox is added here, not inherited: the
          // child learns where to publish an ask it cannot answer, and which
          // orchestrator session it belongs to.
          baseEnv: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(
                (entry): entry is [string, string] =>
                  entry[1] !== undefined &&
                  // A frozen enterprise pin makes the operator's KUBIC_MODEL
                  // dead weight in the child (its own load drops it).
                  !(modelFrozen && entry[0] === 'KUBIC_MODEL'),
              ),
            ),
            // §38.1 (issue #202): the resolved worker model — the role's
            // `[roles.<r>].model` pin, else the manager's effective model —
            // rides the existing `KUBIC_MODEL` pin, OVERWRITING any ambient
            // value so a role pin is not outranked by the manager's env pin.
            // No level resolved one: no pin is invented, and the child keeps
            // its own selection default.
            ...(modelFrozen || info?.modelRef === undefined
              ? {}
              : { KUBIC_MODEL: info.modelRef }),
            // The role's thinking default (or the run's explicit level) is
            // per worker; absent leaves the child's own `[model].thinking`
            // (and the manager's ambient value, when it has one) in force.
            ...(info?.thinking === undefined
              ? {}
              : { KUBIC_MODEL_THINKING: info.thinking }),
            // §67 (issue #191): the worker's task — the capability grant the
            // child's lane registers. ALWAYS written, cleared when this
            // spawn has none (the KUBIC_BUDGET rule below): an ambient value
            // inherited from an outer worker would otherwise be read by a
            // child the manager handed no task, and its worktree check would
            // fail the inner run. Non-secret (tool names, worktree, the
            // objective it already runs), the same class as the pins above.
            KUBIC_TASK_FILE: taskFile ?? '',
            ...approvalsChildEnv(
              workerSession,
              info?.sessionId ?? orchestratorSessionId ?? 'orch',
            ),
            ...modelsRootEnv(),
            // §71 child-side budget (issue #208): ALWAYS written from the
            // resolved plan — set when one exists, cleared otherwise — so an
            // ambient KUBIC_BUDGET in the manager's own environment can never
            // leak into a child the manager did not budget. The child
            // enforces toolCalls/tokens/cost from this spec; maxRuntimeMs is
            // stripped (wall clock belongs to the WATCHDOG below, never to
            // the child — one owner per dimension).
            KUBIC_BUDGET:
              budgetForSpawn === undefined
                ? ''
                : JSON.stringify(childBudgetOf(budgetForSpawn)),
            // Issue #228: the trust decision the child's project layers
            // (config, models.json, skills) are gated on, per resolved root.
            ...trustEnv(),
          },
          cmd: options.workerEntry?.cmd ?? process.execPath,
          args: [
            // §82 (issue #163): the per-worker heap bound travels as a node
            // flag ahead of the entry script.
            ...(options.workerMemoryLimitMb === undefined
              ? []
              : [`--max-old-space-size=${options.workerMemoryLimitMb}`]),
            ...(options.workerEntry?.args ?? [entryScript()]),
            'run',
            '-p',
            prompt,
            '--session',
            workerSession,
            ...(info?.role === undefined ? [] : ['--role', info.role]),
            '--json',
            '--timeout',
            String(options.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS),
            // §67 task resources (issue #170): the child's own `--skill`
            // surface, absolute so it resolves in its worktree too.
            ...skills.flatMap((skill) => ['--skill', skill]),
          ],
          provenance: provenanceFor(workerSession, agentId, 'worker-run'),
          ...(options.readyTimeoutMs === undefined
            ? {}
            : { readyTimeoutMs: options.readyTimeoutMs }),
          // §51 cancellation grace (issue #249): the worker's own settle is
          // not a tool call, so it gets its own (longer) grace.
          ...(options.workerCancelGraceMs === undefined
            ? {}
            : { cancelGraceMs: options.workerCancelGraceMs }),
          // §82 runtime limits (issue #163): the cap the manager samples and
          // the quota it checks, with the probes that make them enforceable.
          ...(options.workerMemoryLimitMb === undefined
            ? {}
            : { memoryLimitMb: options.workerMemoryLimitMb }),
          ...(options.worktreeDiskQuotaMb === undefined
            ? {}
            : { diskQuotaMb: options.worktreeDiskQuotaMb }),
          // §61 (issue #158): creation duration measured at creation return —
          // the host's own measurement (around `ensureWorktree`) when it
          // supplied one, else this seam's. Never a launch-time subtraction.
          worktreeMs: info?.worktreeMs ?? worktreeMsByAgent.get(agentId),
          // §61 (issue #158): how long the session create/attach leg took.
          attachMs: attachMsByAgent.get(agentId),
          worktree: worktree.path,
          ...(modelPin === undefined ? {} : { model: modelPin }),
          ...(thinking === undefined ? {} : { thinking }),
          // §67 task resources (issue #170): the registry row `kubic workers`
          // reads prints them as `skills=…`.
          ...(skills.length === 0 ? {} : { resources: { skills } }),
        },
        {
          shell: shellForWorktree(worktree.path),
          registry: workerRegistry,
          debug: (line) => debug(line),
          // §82 (issue #163): the probes are LAUNCHER deps (they sample the
          // running child), wired only when a limit is configured — a limit
          // with no probe is not enforced, and `kubic doctor` says so.
          ...(options.workerMemoryLimitMb === undefined &&
          options.worktreeDiskQuotaMb === undefined
            ? {}
            : {
                resourceProbes: {
                  memoryMb: (pid: number) => processMemoryMb(root ?? cwd, pid),
                  diskMb: (path: string) => worktreeDiskMb(root ?? cwd, path),
                },
              }),
        },
      );
      launchedByAgent.set(agentId, launched);
      // Issue #290: the worker.start span (with its nested startup span)
      // opens at launch — startup begins when the child is spawned.
      const workerSpan = managerSpans.startWorker(workerSession);
      // Issue #290: settle the worker's spans and append its artifact.
      // The startup duration is the registry's startupMs (pinned by endAt,
      // never a second wall-clock read); a launch that never became ready
      // reports startupMs null and gets a zero-duration startup, with the
      // failure on the worker.start span. Best-effort: telemetry never
      // fails a worker.
      const settleWorkerSpans = (error?: string): void => {
        try {
          managerSpans.endWorkerStartup(
            workerSpan,
            launched.perf().sample.startupMs ?? null,
          );
          managerSpans.endWorker(workerSpan, error);
          if (root === undefined || orchestratorSessionId === undefined) return;
          createNodeFileBridge(join(root, '.kubic', 'orchestrator')).appendFile(
            `${orchestratorSessionId}.spans.jsonl`,
            serializeSpanArtifact(
              managerSpans.flushWorker(workerSpan),
              workerSpan,
              workerSession,
            ),
          );
        } catch (spanError) {
          debug(
            `spans: could not record the worker span: ${spanError instanceof Error ? spanError.message : String(spanError)}`,
          );
        }
      };
      // §60 privileged-action row (issue #284): the spawn half of the
      // spawn/terminate pair bracketing this child's process lifetime.
      // Snapshot once — the terminate half below spreads this, so the two
      // halves can never disagree about pid, generation or model.
      const spawnPid = launched.pid ?? workerRegistry.get(agentId)?.pid;
      const ledgerWorker = {
        agentId,
        role: info?.role ?? 'worker',
        worktree: worktree.path,
        ...(modelPin === undefined ? {} : { model: modelPin }),
        ...(spawnPid === undefined ? {} : { pid: spawnPid }),
        generation: launched.generation,
      };
      auditWorkerSpawn(ledgerWorker);
      // A cancel that arrived between the readiness check above and this
      // launch (issue #206): the handle exists now, so the kill lands instead
      // of waiting out the child's own bound. `throwIfCancelled` still turns
      // the settled child into this worker's named terminus.
      if (cancelRequested.has(agentId)) {
        void launched.reap().catch(() => undefined);
      }
      const launchedAt = Date.now();
      const observation = (): Omit<
        WorkerObservation,
        'filesChanged' | 'diff'
      > => ({
        wallMs: Math.max(0, Date.now() - launchedAt),
        latencyMs: launched.perf().sample.startupMs ?? 0,
        provenance: {
          sessionId: workerSession,
          pid: launched.pid ?? null,
          generation: launched.generation,
          worktree: worktree.path,
          role: info?.role ?? 'worker',
          ...(modelPin === undefined ? {} : { model: modelPin }),
          ...(thinking === undefined ? {} : { thinking }),
        },
      });
      // Every terminus carries a §68 result (issue #185): a failure is
      // re-thrown as a WorkerRunFailure holding the AgentResult built from
      // what the child reported before it stopped.
      let finished:
        | { exitCode: number; stdout: string; stderr: string }
        | undefined;
      const withResult = (error: unknown): WorkerRunFailure => {
        const failure =
          error instanceof WorkerRunFailure
            ? error
            : new WorkerRunFailure(
                'worker_failed',
                error instanceof Error ? error.message : String(error),
              );
        if (failure.result === undefined) {
          try {
            failure.result = workerFailureResult(
              agentId,
              failure,
              finished,
              observation(),
              launched.failure(),
            );
          } catch (buildError) {
            debug(
              `result: could not build the failure result for '${agentId}': ${buildError instanceof Error ? buildError.message : String(buildError)}`,
            );
          }
        }
        return failure;
      };
      try {
        const untrack = trackLive(launched);
        // The row is written out the moment the worker is registered, so a
        // concurrent/next `kubic workers` invocation lists it (§50) even if
        // this launch later fails.
        persistWorkerRowsNow();
        // §71 wall-clock watchdog (issue #208): maxRuntimeMs bounds the
        // worker once it is UP. On elapse the child's process group is
        // killed and the run ends BUDGET_EXHAUSTED (exit 3) with
        // limit=wallClock — distinct from the child's own --timeout, which
        // bounds one drive.
        const maxRuntimeMs = budgetForSpawn?.maxRuntimeMs;
        let wallClockWatchdog: ReturnType<typeof setTimeout> | undefined;
        const wallClockExceeded =
          maxRuntimeMs === undefined
            ? undefined
            : new Promise<never>((_resolve, reject) => {
                wallClockWatchdog = setTimeout(() => {
                  // Kill first: a sleeping worker must die, not be reported
                  // at its leisure. reap() kills the detached process group.
                  void launched.reap().catch(() => undefined);
                  reject(
                    new WorkerRunFailure(
                      'worker_failed',
                      wallClockBudgetMessage(agentId, maxRuntimeMs),
                      { code: BUDGET_EXHAUSTED, exitCode: RUN_EXIT_BUDGET },
                    ),
                  );
                }, maxRuntimeMs);
              });
        // A watchdog that lost the race (the worker settled first) never
        // rejects; this keeps its abandoned promise from becoming an
        // unhandled rejection.
        wallClockExceeded?.catch(() => undefined);
        // A launch that never became ready is already terminal; the read
        // below is what turns it into the run's §78 `spawn_failed` code.
        let done: { exitCode: number; stdout: string; stderr: string };
        try {
          done =
            wallClockExceeded === undefined
              ? await launched.wait()
              : await Promise.race([launched.wait(), wallClockExceeded]);
        } catch (error) {
          persistWorkerRowsNow();
          // The process ended by kill (watchdog, cancel): the terminate
          // half names the failure, and the throw below still carries it.
          auditWorkerTerminate({
            ...ledgerWorker,
            reason: terminateReasonOf(error, launched.failure()),
            result: 'error',
          });
          throw error;
        } finally {
          if (wallClockWatchdog !== undefined) clearTimeout(wallClockWatchdog);
          untrack();
        }
        finished = done;
        // The process ended: the terminate half. Later funnels (exit-code
        // throw, settle throw) must not record again — one spawn, one
        // terminate per child.
        const endReason =
          done.exitCode === 0 && launched.agentStatus() !== 'spawn_failed'
            ? 'ok'
            : (launched.failure()?.code ?? `exit-${done.exitCode}`);
        auditWorkerTerminate({
          ...ledgerWorker,
          reason: endReason,
          result: endReason === 'ok' ? 'ok' : 'error',
        });
        throwIfCancelled(agentId);
        if (done.exitCode !== 0 || launched.agentStatus() === 'spawn_failed') {
          persistWorkerRowsNow();
          // §13 (issue #151): the child's report names a terminus the exit
          // code cannot — a `--timeout` run exits 1 with status `timeout`
          // (issue #280), and a cancelled one says so. Correct the row before
          // the failure travels.
          const reportStatus = childReportOf(done.stdout)?.status;
          if (
            reportStatus === 'timeout' ||
            reportStatus === 'cancelled' ||
            reportStatus === 'budget_exhausted'
          ) {
            launched.settleFromReport(reportStatus);
          }
          throw workerRunError(agentId, done, launched.failure());
        }
        await launched.reap().catch(() => undefined);
        persistWorkerRowsNow();
        // The worker does not commit; the orchestrator stages what it left and
        // commits on its behalf. The invariant is that the manager lane never
        // authors the change content (see assertManagerZeroWrites).
        const status = await runGit(
          worktree.path,
          ['status', '--porcelain=v1'],
          workerSession,
          agentId,
          'worker-status',
        );
        if (status.exitCode === 0 && status.stdout.trim().length > 0) {
          const add = await runGit(
            worktree.path,
            ['add', '-A'],
            workerSession,
            agentId,
            'worker-stage',
          );
          if (add.exitCode !== 0)
            throw new Error(
              `worker stage failed: ${add.stderr.trim().slice(0, 200)}`,
            );
          const commit = await runGit(
            worktree.path,
            [
              '-c',
              'user.name=kubic-worker',
              '-c',
              'user.email=kubic-worker@local',
              'commit',
              '-m',
              `worker ${agentId}: ${prompt.slice(0, 120)}`,
            ],
            workerSession,
            agentId,
            'worker-commit',
          );
          if (commit.exitCode !== 0)
            throw new Error(
              `worker commit failed: ${commit.stderr.trim().slice(0, 200)}`,
            );
        }
        // Issue #363: the worker just wrote through its worktree — surface
        // any `.git/config` / `.git/hooks` drift before the merge runs.
        verifyGitGuard(`worker '${agentId}' settle`);
        // §61 (issue #158): time the branch-diff read — the telemetry's
        // `diffMs` leg, measured where the work really happens.
        const diffStartedAt = Date.now();
        const base = await resolveBase(needRoot(), workerSession);
        const names = await runGit(
          worktree.path,
          ['diff', '--name-only', `${base}...HEAD`, '--'],
          workerSession,
          agentId,
          'worker-diff',
        );
        if (names.exitCode !== 0)
          throw new Error(
            `worker diff failed: ${names.stderr.trim().slice(0, 200)}`,
          );
        const hunks: MergedHunk[] = [];
        for (const path of names.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0)) {
          const diff = await runGit(
            worktree.path,
            ['diff', `${base}...HEAD`, '--', path],
            workerSession,
            agentId,
            'worker-hunk',
          );
          hunks.push({ path, hunk: diff.stdout });
        }
        // §68: the exit code alone never settles a worker — its own report
        // must build a valid AgentResult, or the run fails typed.
        const contract = workerResultFromRun(agentId, workerSession, done, {
          ...observation(),
          filesChanged: hunks.map((hunk) => hunk.path),
          // The worker's change set is the worker branch against the run's
          // base: a reference, never the diff text (§69).
          diff: { diffId: `${base}...${worktree.branch}` },
        });
        if (!contract.ok) {
          // A clean exit whose §68 report does not parse is a FAILED agent
          // (issue #151): the process exited, the work did not settle.
          launched.settleAgent('failed');
          debug(contract.error.message);
          throw new WorkerRunFailure(
            contract.error.code,
            contract.error.message,
          );
        }
        // The report validated: the agent is COMPLETED, not merely exited.
        launched.settleAgent('completed');
        settleWorkerSpans();
        return {
          hunks,
          result: contract.result,
          diffMs: Date.now() - diffStartedAt,
        };
      } catch (error) {
        // A worker whose clean exit was followed by a failed settle (stage,
        // commit, diff or report) is a FAILED agent, never a settling one
        // (issue #151). A launch that never became ready keeps its own
        // SPAWN_FAILED terminus, and an already-settled agent is left alone.
        // The PER-AGENT handle (issue #151 review): `runWorker` is one shared
        // closure and workers run concurrently, so a run-scoped pointer would
        // hold whichever worker launched last — settling a sibling, or none.
        const settlingHandle = launchedByAgent.get(agentId);
        if (settlingHandle?.agentStatus() === 'settling') {
          try {
            settlingHandle.settleAgent('failed');
          } catch {
            // The agent settled concurrently — its own verdict stands.
          }
        }
        settleWorkerSpans(
          error instanceof Error ? error.message : String(error),
        );
        throw withResult(error);
      }
    },
    mergeBranch: async (
      agentId: string,
      worktree: OrchestrateWorktree,
    ): Promise<void> => {
      const repo = needRoot();
      // Guard first (fix a): never merge onto a half-merged tree — the
      // CLI also calls prepareMerge, this covers direct callers too.
      await ensureCleanMergeState(repo, agentId);
      const merged = await runGit(
        repo,
        ['merge', '--no-ff', worktree.branch, '-m', `kubic: merge ${agentId}`],
        'cli',
        'manager',
        'merge',
      );
      if (merged.exitCode !== 0) {
        // Abort first: the tree is never left half-merged.
        await runGit(
          repo,
          ['merge', '--abort'],
          'cli',
          'manager',
          'merge-abort',
        );
        const output = `${merged.stdout}\n${merged.stderr}`;
        if (/conflict/i.test(output)) {
          // §45.2 (issue #106): the resolver spec promises BOTH DIFFS. The
          // merge's own stdout/stderr carry git's conflict MESSAGES, not
          // diffs, so the real ones are read here: each side's changes since
          // the common ancestor. Best-effort with a named fallback — a
          // conflict must still be reported as a conflict if a diff read
          // fails, never crash the merge path.
          const base = await runGit(
            repo,
            ['merge-base', 'HEAD', worktree.branch],
            'cli',
            'manager',
            'conflict-base',
          );
          const baseRev = base.exitCode === 0 ? base.stdout.trim() : undefined;
          const sideDiff = async (
            spec: string,
            tool: string,
          ): Promise<string | undefined> => {
            const diff = await runGit(
              repo,
              ['diff', '--no-color', spec],
              'cli',
              'manager',
              tool,
            );
            return diff.exitCode === 0 ? diff.stdout.slice(0, 8000) : undefined;
          };
          const ours =
            baseRev === undefined
              ? undefined
              : await sideDiff(`${baseRev}..HEAD`, 'conflict-ours');
          const theirs =
            baseRev === undefined
              ? undefined
              : await sideDiff(
                  `${baseRev}..${worktree.branch}`,
                  'conflict-theirs',
                );
          throw new MergeConflictError(agentId, {
            oursDiff: ours ?? merged.stdout.slice(0, 2000),
            theirsDiff: theirs ?? merged.stderr.slice(0, 2000),
          });
        }
        throw new Error(
          `git merge ${worktree.branch} failed (exit ${merged.exitCode}): ${merged.stderr.trim().slice(0, 200)}`,
        );
      }
      // Issue #363: the merge just touched the shared checkout — surface
      // any `.git/config` / `.git/hooks` drift while it is still attributable.
      verifyGitGuard(`merge '${agentId}'`);
    },
    prepareMerge: async (agentId: string): Promise<void> => {
      await ensureCleanMergeState(needRoot(), agentId);
    },
    isBranchMerged: async (
      agentId: string,
      worktree: OrchestrateWorktree,
    ): Promise<boolean> => {
      // Write-ahead intent reconciliation (issue #76 fix b): exit 0
      // means the worker branch is already an ancestor of the merge
      // target, so resume marks it merged without re-running the worker.
      // Any other exit (branch missing, not merged) means retry.
      void agentId;
      const repo = needRoot();
      const done = await runGit(
        repo,
        ['merge-base', '--is-ancestor', worktree.branch, 'HEAD'],
        'cli',
        'manager',
        'merge-check',
      );
      return done.exitCode === 0;
    },
    readBranchTip: async (
      agentId: string,
      worktree: OrchestrateWorktree,
    ): Promise<string | undefined> => {
      // Branch-tip probe (issue #429): HEAD of the worker's own checkout
      // at settle, persisted with the completion so resume can tell a
      // same-name rewrite apart. A failed probe is an unknown tip (the
      // lane reuses on branch match), never a failed run.
      void agentId;
      const tipped = await runGit(
        worktree.path,
        ['rev-parse', 'HEAD'],
        'cli',
        'manager',
        'tip-check',
      );
      if (tipped.exitCode !== 0) return undefined;
      const sha = tipped.stdout.trim();
      return sha.length > 0 ? sha : undefined;
    },
    // §45.2 conflict delegation (issue #106): the resolver is a REAL child
    // process, launched through the same lifecycle layer as every worker — the
    // one difference is the prompt it runs and the branch it settles on. The
    // manager never resolves; this seam exists so a genuine conflict gets an
    // agent with the writer tool set instead of a stop.
    runResolver: async (request: ResolverRequest): Promise<ResolverOutcome> => {
      const repo = needRoot();
      const sessionId = orchestratorSessionId ?? 'orch';
      const workerSession = workerSessionFor(sessionId, request.agentId);
      // §45.2 says the resolver runs under the implementer/debugger tool set.
      // The spec carries that set; the child can only be handed a ROLE (its
      // own `.kubic/roles/<name>.md` is what selects tools). So the resolver
      // asks for the role the spec names when the document exists, and says
      // so on the debug channel when it does not — the child then runs the
      // default writer set, and the gap is reported rather than implied away.
      const roleDoc = join(repo, '.kubic', 'roles', `${request.spec.role}.md`);
      let roleDocPresent = false;
      try {
        roleDocPresent = new NodeExecutionEnv(repo).fs.stat(roleDoc).isFile;
      } catch {
        roleDocPresent = false;
      }
      if (!roleDocPresent) {
        debug(
          `gap: resolver '${request.agentId}' runs without --role (${roleDoc} is absent) — the child uses its default writer tool set`,
        );
      }
      throwIfCancelled(request.agentId);
      // §36.3 (issue #200): the resolver is a child like any other, so it
      // needs the same provider credential its role resolves to. The resolver
      // carries no role model pin (nothing injects KUBIC_MODEL into it), so
      // its provider follows the operator/manager pin or the manager's
      // fallback — and the grant is namespaced under the role the child is
      // TOLD: its spec role only when the document exists (`--role`), the
      // 'worker' default otherwise, never a namespace the child cannot read.
      const resolverGrant = workerGrant(
        request.agentId,
        request.spec.role,
        undefined,
      );
      if (resolverGrant.refusal !== undefined) {
        return { resolved: false, reason: resolverGrant.refusal.message };
      }
      // §67 (issue #191): the resolver gets an explicit task too — its spec's
      // tool set (the implementer/debugger writer set) travels as
      // `task.toolNames`, so a worktree without the role document no longer
      // drops the resolver onto a default lane. Its session dir is the
      // conflicted worker's (same session id), so the file is named apart
      // from that worker's own task.
      // §67 task resources (issue #170): the resolver gets the run's
      // `--skill` values, resolved against the manager's cwd like a worker's.
      const resolverSkills = resolveSkillPaths(request.skills, cwd);
      const resolverTask = buildAgentTask({
        taskId: `${workerSession}:${request.agentId}:resolver`,
        parentSessionId: sessionId,
        role: request.spec.role,
        objective: request.prompt,
        worktree: request.worktree.path,
        toolNames: request.spec.tools,
        constraints: request.spec.constraints,
        ...(resolverSkills.length === 0
          ? {}
          : { resources: { skills: resolverSkills } }),
      });
      if (!resolverTask.valid) {
        return {
          resolved: false,
          reason: `resolver '${request.agentId}' task refused: ${resolverTask.errors.join('; ')}`,
        };
      }
      const resolverTaskFile = ((): string => {
        const relative = join(workerSession, RESOLVER_TASK_FILE);
        sessionBridge.writeFile(
          relative,
          `${JSON.stringify(resolverTask.task)}\n`,
        );
        return sessionBridge.absolutePath(relative);
      })();
      const launched = launchWorker(
        {
          workerId: request.agentId,
          sessionId: workerSession,
          role: request.spec.role,
          grantRole: roleDocPresent ? request.spec.role : 'worker',
          credentials: resolverGrant.grant,
          owner: `orchestrate:${sessionId}`,
          baseEnv: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(
                (entry): entry is [string, string] => entry[1] !== undefined,
              ),
            ),
            // Issue #156: the resolver is a delegated child too, so it gets
            // the SAME approval surface its workers got — without this it
            // raised a challenged call into a mailbox it was never told about
            // and denied closed, while the docs promised the same rules.
            ...approvalsChildEnv(workerSession, sessionId),
            ...modelsRootEnv(),
            ...trustEnv(),
            // §67 (issue #191): the resolver's task — explicit toolNames, so
            // it never falls back to the child's default writer set.
            KUBIC_TASK_FILE: resolverTaskFile,
            // No per-spawn budget is resolved for a resolver: cleared rather
            // than inherited from an outer worker (the KUBIC_BUDGET rule,
            // issue #208), so it cannot enforce a limit nobody configured
            // for it.
            KUBIC_BUDGET: '',
          },
          cmd:
            options.resolverEntry?.cmd ??
            options.workerEntry?.cmd ??
            process.execPath,
          args: [
            ...(options.resolverEntry?.args ??
              options.workerEntry?.args ?? [entryScript()]),
            'run',
            '-p',
            request.prompt,
            '--session',
            workerSession,
            ...(roleDocPresent ? ['--role', request.spec.role] : []),
            '--json',
            '--timeout',
            String(options.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS),
            // §67 task resources (issue #170): the resolver's own `--skill`.
            ...resolverSkills.flatMap((skill) => ['--skill', skill]),
          ],
          provenance: provenanceFor(
            workerSession,
            request.agentId,
            'resolver-run',
          ),
          ...(resolverSkills.length === 0
            ? {}
            : { resources: { skills: resolverSkills } }),
          ...(options.readyTimeoutMs === undefined
            ? {}
            : { readyTimeoutMs: options.readyTimeoutMs }),
          // §51 cancellation grace (issue #249): the worker's own settle is
          // not a tool call, so it gets its own (longer) grace.
          ...(options.workerCancelGraceMs === undefined
            ? {}
            : { cancelGraceMs: options.workerCancelGraceMs }),
          // §82 runtime limits (issue #163): the cap the manager samples and
          // the quota it checks, with the probes that make them enforceable.
          ...(options.workerMemoryLimitMb === undefined
            ? {}
            : { memoryLimitMb: options.workerMemoryLimitMb }),
          ...(options.worktreeDiskQuotaMb === undefined
            ? {}
            : { diskQuotaMb: options.worktreeDiskQuotaMb }),
          ...(options.workerMemoryLimitMb === undefined &&
          options.worktreeDiskQuotaMb === undefined
            ? {}
            : {
                resourceProbes: {
                  memoryMb: (pid: number) => processMemoryMb(root ?? cwd, pid),
                  diskMb: (path: string) => worktreeDiskMb(root ?? cwd, path),
                },
              }),
        },
        {
          shell: shellForWorktree(request.worktree.path),
          registry: workerRegistry,
          debug: (line) => debug(line),
        },
      );
      const untrack = trackLive(launched);
      persistWorkerRowsNow();
      // §60 privileged-action rows (issue #284): the resolver is a
      // delegated child too, so its process lifetime brackets the same
      // spawn/terminate pair (no model pin: it inherits the ambient one).
      const resolverPid =
        launched.pid ?? workerRegistry.get(request.agentId)?.pid;
      const ledgerResolver = {
        agentId: request.agentId,
        role: request.spec.role,
        worktree: request.worktree.path,
        ...(resolverPid === undefined ? {} : { pid: resolverPid }),
        generation: launched.generation,
      };
      auditWorkerSpawn(ledgerResolver);
      let done: { exitCode: number; stdout: string; stderr: string };
      try {
        done = await launched.wait();
      } catch (error) {
        auditWorkerTerminate({
          ...ledgerResolver,
          reason: terminateReasonOf(error, launched.failure()),
          result: 'error',
        });
        throw error;
      } finally {
        untrack();
        persistWorkerRowsNow();
      }
      const resolverReason =
        done.exitCode === 0 && launched.agentStatus() !== 'spawn_failed'
          ? 'ok'
          : (launched.failure()?.code ?? `exit-${done.exitCode}`);
      auditWorkerTerminate({
        ...ledgerResolver,
        reason: resolverReason,
        result: resolverReason === 'ok' ? 'ok' : 'error',
      });
      throwIfCancelled(request.agentId);
      if (done.exitCode !== 0 || launched.agentStatus() === 'spawn_failed') {
        const failure = launched.failure();
        return {
          resolved: false,
          reason: `resolver child exited ${done.exitCode}${failure === undefined ? '' : ` (${failure.code})`}`,
        };
      }
      await launched.reap().catch(() => undefined);
      // The resolver's own tool set is the spec's — the implementer set from
      // the merge path. The child commits its settlement on the worker branch
      // (kubic-run style staging below), so the manager can re-merge without
      // ever authoring a line.
      const status = await runGit(
        request.worktree.path,
        ['status', '--porcelain=v1'],
        workerSession,
        request.agentId,
        'resolver-status',
      );
      if (status.exitCode === 0 && status.stdout.trim().length > 0) {
        const stage = await runGit(
          request.worktree.path,
          ['add', '-A'],
          workerSession,
          request.agentId,
          'resolver-stage',
        );
        if (stage.exitCode !== 0) {
          return {
            resolved: false,
            reason: `resolver stage failed: ${stage.stderr.trim().slice(0, 200)}`,
          };
        }
        const commit = await runGit(
          request.worktree.path,
          [
            '-c',
            'user.name=kubic-resolver',
            '-c',
            'user.email=kubic-resolver@local',
            'commit',
            '-m',
            `resolver ${request.agentId}: settle conflict`,
          ],
          workerSession,
          request.agentId,
          'resolver-commit',
        );
        if (commit.exitCode !== 0) {
          return {
            resolved: false,
            reason: `resolver commit failed: ${commit.stderr.trim().slice(0, 200)}`,
          };
        }
      }
      // The resolver's report is not the settlement: the manager re-merges and
      // only a successful merge settles the candidate. What the resolver did
      // to the tree is what this reports.
      const probe = await runGit(
        request.worktree.path,
        ['status', '--porcelain=v1'],
        workerSession,
        request.agentId,
        'resolver-clean',
      );
      if (probe.exitCode !== 0 || probe.stdout.trim().length > 0) {
        return {
          resolved: false,
          reason: 'resolver left the worktree dirty — refusing to re-merge',
        };
      }
      debug(
        `resolver: '${request.agentId}' settled the conflict in ${request.worktree.path}`,
      );
      return { resolved: true };
    },
    reapWorker: (agentId: string): void => {
      // The child process was reaped at wait() inside runWorker; the
      // worktree + branch stay retained as evidence (§44.1 — only
      // `kubic clean` disposes). The lifecycle row is written out so a
      // separate `kubic workers` invocation can list it (§50).
      persistWorkerRowsNow();
      const launched = launchedByAgent.get(agentId);
      if (launched !== undefined) {
        const perf = launched.perf();
        if (!perf.ok) {
          // §61 is asserted, not merely recorded: a launch that blew a
          // budget names the breach on the debug channel.
          debug(
            `perf: worker '${agentId}' budget breach — ${perf.breaches.join('; ')}`,
          );
        }
      }
      debug(`reaped: ${agentId} (worktree + branch retained)`);
    },
    // Fail-fast cancellation (issue #206): a sibling still in flight when a
    // concurrent worker failed is killed through the lifecycle layer's reap
    // (SIGTERM, then the detached process group). The running `runWorker`
    // sees the child exit and settles its own promise; a cancel that arrives
    // BEFORE the child launched is remembered, and the launch path checks it
    // as soon as the handle exists — so a cancelled worker never survives
    // the window between the request and the spawn.
    cancelWorker: (agentId: string): void => {
      cancelRequested.add(agentId);
      const launched = launchedByAgent.get(agentId);
      if (launched !== undefined) {
        void launched.reap().catch(() => undefined);
      }
    },
    // §81 worker replacement (issue #175): a crash-class worker is terminated
    // (its detached group is already gone — reap is idempotent), its session
    // is reopened to prove it can be resumed, and the registry allocates the
    // next generation for the retry the host then starts. A launch that never
    // became ready, or a budget/approval/workspace/provider terminus, is not
    // replaceable and returns undefined: a fresh child cannot fix a decision
    // or a setup failure.
    replaceWorker: async (
      agentId: string,
    ): Promise<{ from: number; to: number } | undefined> => {
      const crashed = launchedByAgent.get(agentId);
      if (crashed === undefined) return undefined;
      // §82 (issue #163): a resource stop is the MANAGER's own decision, not
      // a crash a fresh child can fix — a replacement would start in the same
      // over-quota worktree and be killed by the first poll. Skip it and say
      // so, so the retry budget is never spent on predictable churn.
      const failure = crashed.failure();
      if (
        crashed.agentStatus() !== 'failed' ||
        failure?.kind !== 'process' ||
        failure.code.startsWith('resource_')
      ) {
        debug(
          `replace: worker '${agentId}' is not replaceable (agent ${crashed.agentStatus()}, ${failure?.code ?? 'no failure'})`,
        );
        return undefined;
      }
      const from = crashed.generation;
      const workerSession = crashed.sessionId;
      const outcome = await replaceWorker(
        { workerId: agentId, sessionId: workerSession, oldGeneration: from },
        {
          allocateGeneration: () =>
            (workerRegistry.get(agentId)?.generation ?? from) + 1,
          terminate: async () => {
            await crashed.reap().catch(() => undefined);
          },
          // The session must still be openable: the replacement child
          // attaches it, and a session that cannot be resumed must fail here
          // rather than at the child's attach (exit 5).
          openSession: async (sessionId) => {
            const session = await attachSession(
              sessionStore,
              sessionId,
              BACKGROUND_CONTEXT,
            );
            await session.release(BACKGROUND_CONTEXT);
            return { laneId: sessionId };
          },
          resumeLane: async () => ({ resumed: true }),
        },
      );
      debug(
        `replace: worker '${agentId}' generation ${from} → ${outcome.generation} (session ${workerSession} reopened)`,
      );
      return { from, to: outcome.generation };
    },
    requestApproval: mergeApprovalSeat,
    // §41.1/issue #277: an over-cap spawn asks the USER only when this run has
    // one — a TTY (the seat the merge gate already carries) or the TUI's own
    // overlay (which injects its seat). Headless runs, and `--yes` runs, stay
    // autonomous and keep the queueing rule.
    interactive: optionsSeat !== undefined || process.stdin.isTTY === true,
    // A run-level ask belongs to no worker worktree: its §60 row names the
    // manager's own checkout (issue #277). Absent outside a git repository —
    // the CLI never gets that far without one, and a test that builds these
    // deps elsewhere must not throw.
    ...(root === undefined ? {} : { repoRoot: root }),
    ...(options.yesHint === false ? { yesHint: false } : {}),
    // Every settled merge decision lands in the §60 ledger (issue #323),
    // naming who decided: `--yes` for the standing answer, `user` otherwise.
    auditMerge: (record): void => {
      const repo = needRoot();
      // The repo runtime root's ledger (issue #279): a run started from a
      // LINKED worktree still records where the workers' own records and
      // `kubic audit` look — the main checkout — not in its own `.kubic/`.
      appendToLedger(
        auditLedgerDirFor(repo),
        mergeDecisionAudit({
          ...record,
          workspace: repo,
          posture:
            approvalsActive?.fullAccessGrant() === undefined
              ? POSTURE_APPROVALS
              : POSTURE_FULL_ACCESS,
        }),
        (message) => debug(`audit: merge decision not recorded — ${message}`),
      );
    },
    // The run's start names the §19 mode in the §60 ledger (issue #278).
    // Best-effort like every other row: a dead ledger never fails the run.
    auditRunStart: (record): void => {
      appendToLedger(
        auditLedgerDirFor(needRoot()),
        runStartAudit({
          sessionId: record.sessionId,
          command: `kubic ${record.command}`,
          mode: record.mode,
          runMode: record.runMode,
          workspace: record.workspace,
          posture: record.posture,
          autonomous: record.autonomous,
        }),
        (message) => debug(`audit: run start not recorded — ${message}`),
      );
    },
    loadState: (sessionId: string): OrchestratorRunState | undefined => {
      try {
        const repo = needRoot();
        const bridge = createNodeFileBridge(
          join(repo, '.kubic', 'orchestrator'),
        );
        if (!bridge.exists(storeName(sessionId))) return undefined;
        const raw = bridge.readTextFile(storeName(sessionId));
        // Structural validation (issue #76 fix): torn writes, hand
        // edits, or newer versions fail closed as missing state —
        // never a half-shaped object the resume path crashes on.
        return parseOrchestratorRunState(JSON.parse(raw), sessionId);
      } catch {
        return undefined;
      }
    },
    saveState: (state: OrchestratorRunState): void => {
      // Atomic + fail-closed (issue #76 fix c): write to a temp file in
      // the same directory and rename over the target, so a kill can
      // never leave a torn state file behind. Write errors propagate
      // (the CLI maps them to state_save_failed) — never swallowed to
      // debug-only.
      const repo = needRoot();
      const bridge = createNodeFileBridge(join(repo, '.kubic', 'orchestrator'));
      const target = storeName(state.sessionId);
      const tmp = `${target}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
      try {
        bridge.writeFile(tmp, JSON.stringify(state, null, 2));
        bridge.renameFile(tmp, target);
      } catch (error) {
        try {
          bridge.remove(tmp);
        } catch {
          // Best-effort temp cleanup — the original error is what matters.
        }
        const message = error instanceof Error ? error.message : String(error);
        debug(
          `state: save failed for session '${state.sessionId}': ${message}`,
        );
        throw new Error(
          `orchestrator state save failed for session '${state.sessionId}': ${message}`,
        );
      }
    },
  };
}
