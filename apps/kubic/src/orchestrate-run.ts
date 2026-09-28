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
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { CliTheme } from '../../../packages/core/src/cli/theme.js';
import type { ShellResult } from '../../../packages/exec/src/env.js';
import { NodeExecutionEnv } from '../../../packages/exec/src/env.js';
import { createNodeFileBridge } from '../../../packages/exec/src/file-bridge.js';
import { ensureRuntimeExcludeRules } from '../../../packages/exec/src/runtime-exclude.js';
import type { PostureOptions } from '../../../packages/extensions/src/startup.js';
import { enableSessionFullAccess } from '../../../packages/host/src/approvals.js';
import type { RuntimeOrchestrator } from '../../../packages/host/src/config/runtime.js';
import { buildOrchestratorWorktreeNotice } from '../../../packages/host/src/limits/orchestrator-notice.js';
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
  type WorkerAskSeat,
  workerSeatForRun,
} from '../../../packages/host/src/orchestrator/approvals/worker-asks.js';
import type { MergedHunk } from '../../../packages/host/src/orchestrator/merge/attribution.js';
import type {
  ApprovalSnapshot,
  ResolverRequest,
} from '../../../packages/host/src/orchestrator/merge/conflicts.js';
import { hashApprovalPolicy } from '../../../packages/host/src/orchestrator/merge/conflicts.js';
import { ParallelScheduler } from '../../../packages/host/src/orchestrator/parallel/scheduler.js';
import type { ParallelTrajectoryEvent } from '../../../packages/host/src/orchestrator/parallel/visibility.js';
import { addWorktree } from '../../../packages/host/src/orchestrator/worktree/add.js';
import {
  isWorktreeError,
  WorktreeError,
  worktreeMissingError,
} from '../../../packages/host/src/orchestrator/worktree/errors.js';
import {
  branchForAgent,
  pathForAgent,
} from '../../../packages/host/src/orchestrator/worktree/naming.js';
import { getWorktreeStatus } from '../../../packages/host/src/orchestrator/worktree/status.js';
import {
  appendToLedger,
  auditLedgerDir,
  mergeDecisionAudit,
} from '../../../packages/host/src/policy/audit-ledger.js';
import { planWorkerRoles } from '../../../packages/host/src/roles/worker-roles.js';
import { defaultSessionsRoot } from '../../../packages/host/src/sessions-cli.js';
import {
  inspectOpenOperations,
  pendingHead,
} from '../../../packages/worker/src/lane/pending.js';
import {
  attachSession,
  createSession,
  openSessionStore,
  SessionAttachError,
} from '../../../packages/worker/src/lane/session-store.js';
import type { WorkerFailure } from '../../../packages/worker/src/lifecycle/launch.js';
import { launchWorker } from '../../../packages/worker/src/lifecycle/launch.js';
import {
  killProcessGroup,
  pidAlive,
  reconcileWorkerRows,
} from '../../../packages/worker/src/lifecycle/orphans.js';
import { WorkerRegistry } from '../../../packages/worker/src/lifecycle/registry.js';
import {
  readWorkerRows,
  updateWorkerRowsFile,
  WORKER_ROWS_FILE,
  workerRowsPath,
} from '../../../packages/worker/src/lifecycle/rows.js';
import { allowlistedShell } from '../../../packages/worker/src/lifecycle/shell.js';
import type { WorkerShell } from '../../../packages/worker/src/lifecycle/spawn.js';
import { TERMINAL_STATUSES } from '../../../packages/worker/src/lifecycle/status.js';
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
   * Where the §49.1 parallel trajectory records go (issue #106). Absent
   * defaults to `<repo>/.kubic/orchestrator/<session>.trajectory.jsonl`
   * (appended, best-effort — telemetry never fails a run).
   */
  trajectoryEvent?: (event: ParallelTrajectoryEvent) => void;
  /** Where the user's verdict on a worker ask is collected (issue #105).
   *  Absent means no surface is attached: every ask denies closed on its
   *  bound, which is what a non-interactive run keeps. */
  approvalsSeat?: WorkerAskSeat;
  /**
   * The runtime `[orchestrator]` projection (issue #133), validated at
   * config load: `root` is the worktree parent the spawned set lives under
   * (`.kubic/wt` when absent) and `maxWorkers` is the admission cap the run
   * scheduler resolves through resolveMaxConcurrency (the shipped four when
   * absent). One projection, two consumers — never a second config read.
   */
  orchestrator?: RuntimeOrchestrator;
  /**
   * The process-signal seam the live-worker guard hangs off. Prod uses the
   * real process (SIGINT/SIGTERM/SIGHUP + 'exit'); tests inject a fake so
   * the test runner itself is never signalled.
   */
  signals?: OrchestrateSignals;
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

function provenanceFor(sessionId: string, agentId: string, tool: string) {
  return {
    sessionId,
    agentId,
    toolCallId: tool,
    turnId: 0,
    operation: 'orchestrate',
  };
}

async function runGit(
  cwd: string,
  args: string[],
  sessionId: string,
  agentId: string,
  tool: string,
): Promise<ShellResult> {
  const env = new NodeExecutionEnv(cwd);
  return env.shell
    .spawn('git', args, { provenance: provenanceFor(sessionId, agentId, tool) })
    .wait();
}

function entryScript(): string {
  const argv1 = process.argv[1];
  if (typeof argv1 === 'string' && argv1.endsWith('.js')) return argv1;
  return resolve(process.cwd(), 'bin', 'kubic.js');
}

// Wall-clock bound handed to each child `kubic run` (issue #94). A worker
// that never settles is the failure mode with no named code: the child's
// own guard turns it into exit 3 (budget_exhausted), which the lifecycle
// layer reports as the §52 budget code — never a hang.
const DEFAULT_WORKER_TIMEOUT_MS = 600_000;

// The readiness marker the child prints before its prompt is submitted
// (§13, issue #94) lives on the CHILD side (headless-run.ts) — a worker
// announces itself the moment its session is attached, so the launch
// handshake times the real startup instead of prompt construction.

export class WorkerRunFailure extends Error {
  readonly code:
    | 'spawn_failed'
    | 'worker_failed'
    | 'result_invalid'
    | 'cancelled';
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
    code: 'spawn_failed' | 'worker_failed' | 'result_invalid' | 'cancelled',
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
      `the last output line is not a JSON report object: ${last.slice(0, 120)}`,
    );
  if (report.ok !== true || report.status !== 'completed')
    return invalid(
      `the report is not a completed run (status ${String(report.status)})`,
    );
  if (report.sessionId !== workerSession)
    return invalid(
      `the report names session '${String(report.sessionId)}', not '${workerSession}'`,
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
  const status: ResultStatus =
    failure.code === 'spawn_failed'
      ? 'spawn_failed'
      : failure.code === 'cancelled'
        ? 'cancelled'
        : approval === 'BUDGET_EXHAUSTED'
          ? 'budget_exhausted'
          : report?.status === 'budget_exhausted'
            ? 'timeout'
            : 'failed';
  const kind: ResultErrorKind =
    approval === 'BUDGET_EXHAUSTED'
      ? 'budget'
      : approval !== undefined
        ? 'approval'
        : failure.code === 'worker_failed'
          ? (launchFailure?.kind ?? 'process')
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
        code: approval ?? launchFailure?.code ?? failure.code,
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
  const suffix = failure === undefined ? '' : ` [${failure.code}]`;
  return new WorkerRunFailure(
    'worker_failed',
    `worker run exited ${done.exitCode}: ${detail.slice(0, 300)}${suffix}`,
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
  // Issue #133: the runtime `[orchestrator]` projection — the worktree
  // parent and the worker cap, both already validated at config load. The
  // shipped defaults apply when the config sets neither: `.kubic/wt` for
  // the spawned set, the scheduler's own cap of four for admissions.
  const worktreeRoot = options.orchestrator?.root;
  const maxWorkers = options.orchestrator?.maxWorkers;
  const excludeEntries = runtimeExcludeEntriesFor(worktreeRoot);
  const workerRegistry = options.registry ?? new WorkerRegistry();
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
  const guard = liveWorkerGuard(options.signals ?? processSignals);
  const throwIfCancelled = (agentId: string): void => {
    const signal = guard.cancelledBy();
    if (signal !== undefined) {
      throw new WorkerRunFailure(
        'cancelled',
        `worker '${agentId}' cancelled by ${signal}`,
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
  // Worktree creation time per agent, so a launch sample can assert the
  // §61 worktree budget alongside its own spawn/teardown legs.
  const worktreeStartedAt = new Map<string, number>();
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

  const needRoot = (): string => {
    if (root === undefined) throw new Error('not a git repository');
    return root;
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
              return next !== undefined &&
                !TERMINAL_STATUSES.includes(row.status)
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
  return {
    out: options.out,
    err: options.err,
    ...(options.theme === undefined ? {} : { theme: options.theme }),
    ...(options.errTheme === undefined ? {} : { errTheme: options.errTheme }),
    debug,
    // Issue #133: the configured worker cap is the run's own admission
    // surface — the same scheduler the CLI would default to, constructed
    // with the validated `[orchestrator].maxWorkers` as its default. Unset
    // builds no scheduler and the CLI's shipped default cap of four stands.
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
    // and where. Real `git -C <path> status --porcelain=v1 -b` through the
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
    loadWorkerRoles: (agents: readonly string[]) => {
      const cwd = options.cwd ?? process.cwd();
      return planWorkerRoles({
        bridge: createNodeFileBridge(cwd),
        cwd,
        agents,
      });
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
        worktreeStartedAt.set(agentId, worktreeStarted);
        for (const warning of added.warnings) debug(`gap: ${warning.message}`);
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
        worktreeStartedAt.set(agentId, worktreeStarted);
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
        dir: join(needRoot(), '.kubic', 'orchestrator'),
        sessionId: approvalOptions.sessionId,
        maxPendingMs: approvalOptions.maxPendingMs,
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
        // The TTY seat when this run has a user attached; without one a
        // worker ask denies closed on the router's own bound (never a silent
        // hang). `--yes` never replaces it (issue #323): the standing answer
        // is the merge gate's only.
        ...(optionsSeat === undefined ? {} : { seat: optionsSeat }),
        debug: (line) => debug(line),
      });
      approvalsActive = run;
      approvalsBoundMs = approvalOptions.maxPendingMs;
      return run;
    },
    createWorkerSession: async (input) => {
      orchestratorSessionId = input.sessionId;
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
        const recorded = existing.metadata.cwd;
        // Issue #147 (§21): a turn the killed worker left open is resumed by
        // the child itself — its `kubic run -p` carries the same plan-step
        // prompt, so the pending run is resumed AS this run, never
        // re-prompted. Named here so the resume is observable.
        let pending: string[] = [];
        try {
          pending = (
            await inspectOpenOperations(existing, BACKGROUND_CONTEXT)
          ).map((op) => pendingHead(op));
        } finally {
          await existing.close(BACKGROUND_CONTEXT);
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
        return { sessionId: input.workerSessionId };
      } catch (error) {
        if (!(error instanceof SessionAttachError)) throw error;
      }
      const session = await createSession(
        sessionStore,
        input.worktree.path,
        BACKGROUND_CONTEXT,
        input.workerSessionId,
      );
      const id = session.metadata.id;
      try {
        // The session dir exists; create the journal dir the worker's
        // file effects will land in (same layout as `kubic run`, E3) so
        // `journal:<id>` resolves for the worker's worktree effects.
        sessionBridge.createDir(join(id, 'journal'));
      } finally {
        await session.close(BACKGROUND_CONTEXT);
      }
      debug(
        `session: created '${id}' for worker '${input.agentId}' (cwd ${input.worktree.path})`,
      );
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
      const modelPin = process.env.KUBIC_MODEL ?? info?.modelRef;
      const thinking = process.env.KUBIC_MODEL_THINKING;
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
          owner: `orchestrate:${info?.sessionId ?? 'orch'}`,
          // The child's base env is the parent's, filtered by the §3.8
          // allowlist inside the layer — never inherited wholesale. Two
          // additions ride on top: the role's model default (issue #104,
          // §12.1) travels through the EXISTING `KUBIC_MODEL` pin — the
          // child's own selectModel honours it, so no new model plumbing is
          // introduced, and a default is the LOWEST-precedence choice, so it
          // is only sent when the operator has not pinned a model of their
          // own — and the approvals mailbox (issue #105) is added here, not
          // inherited: the child learns where to publish an ask it cannot
          // answer, and which orchestrator session it belongs to.
          baseEnv: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(
                (entry): entry is [string, string] => entry[1] !== undefined,
              ),
            ),
            ...(info?.modelRef === undefined ||
            process.env.KUBIC_MODEL !== undefined
              ? {}
              : { KUBIC_MODEL: info.modelRef }),
            ...(approvalsActive === undefined
              ? {}
              : {
                  KUBIC_APPROVALS_DIR: approvalsActive.mailboxDir(),
                  KUBIC_ORCHESTRATOR_SESSION: workerSession,
                  // Issue #230: the child's bound, below the manager's.
                  KUBIC_APPROVALS_BOUND_MS: String(
                    workerApprovalBoundMs(approvalsBoundMs),
                  ),
                }),
            ...modelsRootEnv(),
            // §71 child-side budget (issue #208): the child's own lane
            // enforces toolCalls/tokens/cost from this spec. maxRuntimeMs is
            // stripped — wall clock belongs to the WATCHDOG below, never to
            // the child (one owner per dimension).
            ...(budgetForSpawn === undefined
              ? {}
              : {
                  KUBIC_BUDGET: JSON.stringify(childBudgetOf(budgetForSpawn)),
                }),
          },
          cmd: options.workerEntry?.cmd ?? process.execPath,
          args: [
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
          ],
          provenance: provenanceFor(workerSession, agentId, 'worker-run'),
          ...(options.readyTimeoutMs === undefined
            ? {}
            : { readyTimeoutMs: options.readyTimeoutMs }),
          worktreeMs: (() => {
            const started = worktreeStartedAt.get(agentId);
            return started === undefined ? undefined : Date.now() - started;
          })(),
          worktree: worktree.path,
          ...(modelPin === undefined ? {} : { model: modelPin }),
          ...(thinking === undefined ? {} : { thinking }),
        },
        {
          shell: shellForWorktree(worktree.path),
          registry: workerRegistry,
          debug: (line) => debug(line),
        },
      );
      launchedByAgent.set(agentId, launched);
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
          throw error;
        } finally {
          if (wallClockWatchdog !== undefined) clearTimeout(wallClockWatchdog);
          untrack();
        }
        finished = done;
        throwIfCancelled(agentId);
        if (done.exitCode !== 0 || launched.status() === 'spawn_failed') {
          persistWorkerRowsNow();
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
          debug(contract.error.message);
          throw new WorkerRunFailure(
            contract.error.code,
            contract.error.message,
          );
        }
        return { hunks, result: contract.result };
      } catch (error) {
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
      const launched = launchWorker(
        {
          workerId: request.agentId,
          sessionId: workerSession,
          role: request.spec.role,
          owner: `orchestrate:${sessionId}`,
          baseEnv: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(
                (entry): entry is [string, string] => entry[1] !== undefined,
              ),
            ),
            ...modelsRootEnv(),
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
          ],
          provenance: provenanceFor(
            workerSession,
            request.agentId,
            'resolver-run',
          ),
          ...(options.readyTimeoutMs === undefined
            ? {}
            : { readyTimeoutMs: options.readyTimeoutMs }),
        },
        {
          shell: shellForWorktree(request.worktree.path),
          registry: workerRegistry,
          debug: (line) => debug(line),
        },
      );
      const untrack = trackLive(launched);
      persistWorkerRowsNow();
      let done: { exitCode: number; stdout: string; stderr: string };
      try {
        done = await launched.wait();
      } finally {
        untrack();
        persistWorkerRowsNow();
      }
      throwIfCancelled(request.agentId);
      if (done.exitCode !== 0 || launched.status() === 'spawn_failed') {
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
    requestApproval: mergeApprovalSeat,
    // Every settled merge decision lands in the §60 ledger (issue #323),
    // naming who decided: `--yes` for the standing answer, `user` otherwise.
    auditMerge: (record): void => {
      const repo = needRoot();
      appendToLedger(
        auditLedgerDir(repo),
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
