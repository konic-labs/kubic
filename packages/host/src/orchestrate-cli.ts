// `kubic orchestrate` (issue #76; §5.2, §9/§9.1, §44, §41.1, §78).
// Opt-in orchestrator entry: the manager lane registers through the §40
// toolset allowlist (issue #103 — a lane carrying an exec tool refuses to
// start), authors a plan whose steps become the prompt each worker actually
// runs (never a copy of -p), spawns them in git worktrees, settles/merges
// FIFO through the merge queue with per-agent attribution, routes merge
// approvals to the user, and reaps. Session-scoped with crash-resume: merge
// state persists per session, so a kill mid-run re-attaches and continues
// (or fails closed) — merges apply strictly one-at-a-time in queue order, so
// the tree is never half-merged, and --resume replays each worker's stored
// plan prompt. The manager authors nothing: every merge passes
// assertManagerZeroWrites over the merge-path trace plus the lane's own
// spawn/wait/collect calls first. Solo stays the default — this command
// never falls back to solo (outside a git repo it refuses with exit 2).
// Host owns presentation + orchestration only: git, processes, and files
// arrive injected (fakes in tests, the exec seam in prod via
// apps/kubic/src/orchestrate-run.ts).

import {
  addEdge,
  addNode,
  createGraph,
  renderDag,
} from '../../agents/src/graph.js';
import { createLineLogger } from '../../core/src/cli/logger.js';
import { formatJson } from '../../core/src/cli/output.js';
import { type CliTheme, createCliTheme } from '../../core/src/cli/theme.js';
import {
  APPROVAL_TIMEOUT_CODE,
  type WorkerApprovalScope,
  type WorkerApprovalsRun,
} from './orchestrator/approvals/worker-asks.js';
import type { ManagerLane, ManagerPlanStep } from './orchestrator/manager.js';
import {
  buildManagerPlan,
  createManagerCallSpy,
  planStepFor,
  recordManagerLaneCall,
  registerManagerLane,
} from './orchestrator/manager.js';
import type {
  AttributedHunk,
  MergedHunk,
} from './orchestrator/merge/attribution.js';
import { attributeMergedHunks } from './orchestrator/merge/attribution.js';
import type {
  ApprovalSnapshot,
  ResolverRequest,
  ResolverSpawnSpec,
} from './orchestrator/merge/conflicts.js';
import {
  dispatchResolverSpec,
  hashApprovalPolicy,
  resolverPromptFor,
} from './orchestrator/merge/conflicts.js';
import { createMergeQueue } from './orchestrator/merge/queue.js';
import { REVIEWER_READONLY_TOOLS } from './orchestrator/merge/review.js';
import { assertManagerZeroWrites } from './orchestrator/merge/settle.js';
import { sanitizeReasonField } from './orchestrator/parallel/limits.js';
import { ParallelScheduler } from './orchestrator/parallel/scheduler.js';
import type {
  ParallelTrajectoryEvent,
  ParallelWorkersExtra,
} from './orchestrator/parallel/visibility.js';
import {
  buildParallelTrajectoryEvent,
  buildParallelTreeLine,
  buildParallelWorkersExtra,
} from './orchestrator/parallel/visibility.js';
import { validateAgentId } from './orchestrator/worktree/naming.js';
import type { WorktreeStatus } from './orchestrator/worktree/status.js';
import type { WorkerRolesPlan } from './roles/worker-roles.js';
import {
  applyRolesToPlan,
  workerRoleAssignment,
} from './roles/worker-roles.js';
import {
  RUN_EXIT_APPROVAL_DENIED,
  RUN_EXIT_FAILED,
  RUN_EXIT_OK,
  RUN_EXIT_USAGE,
  SESSION_ID_PATTERN,
} from './run-cli.js';
import type { WorkerListRow } from './workers-cli.js';

export const ORCHESTRATE_DEFAULT_AGENTS: string[] = ['worker-1', 'worker-2'];

// The bounded wait for a per-worker approval ask (issue #105, §41.2). A fixed
// run-level contract rather than a caller knob: an ask that no seat can answer
// must deny closed on a human timescale, never hang the run headless.
export const ORCHESTRATE_APPROVAL_BOUND_MS = 60_000;

// The parsed `kubic orchestrate` options, as the commander program
// (apps/kubic/src/commands/orchestrator.ts) hands them over: argv syntax,
// `--help`, unknown flags, and malformed `--agents` / `--budget` /
// `--session` values are refused there (exit 2) before this runs — the
// value parsers below (`parseAgentList`, `parseBudgetSpec`) are the ones
// it calls. The cross-option rules (`-p` unless `--resume`, `--resume`
// needs `--session`) stay here, with the run.
export interface OrchestrateCliOptions {
  readonly prompt?: string;
  readonly agents?: readonly string[];
  readonly session?: string;
  readonly resume?: boolean;
  readonly yes?: boolean;
  readonly budget?: ParsedBudgetSpec;
  readonly fullAccess?: boolean;
  readonly json?: boolean;
}

export class MergeConflictError extends Error {
  agentId: string;
  oursDiff: string;
  theirsDiff: string;

  constructor(
    agentId: string,
    diffs: { oursDiff: string; theirsDiff: string },
  ) {
    super(
      `merge conflict for worker '${agentId}': unresolvable automatically — queue stopped, candidates preserved`,
    );
    this.name = 'MergeConflictError';
    this.agentId = agentId;
    this.oursDiff = diffs.oursDiff;
    this.theirsDiff = diffs.theirsDiff;
  }
}

export interface OrchestratedWorkerRecord {
  agentId: string;
  branch: string;
  hunks: MergedHunk[];
}

export interface OrchestratorRunState {
  version: 1;
  sessionId: string;
  prompt: string;
  agents: string[];
  merged: string[];
  pending: string[];
  stopped: boolean;
  blocked?: { agentId: string; oursDiff: string; theirsDiff: string };
  records: OrchestratedWorkerRecord[];
  // The manager-authored plan (issue #103, §9.2): one step per worker,
  // carrying the prompt that worker runs. Persisted with the run so
  // --resume replays each worker's own prompt instead of re-deriving one
  // shared -p. Optional: state written before #103 has none, and the resume
  // path then derives the plan from the stored objective and agent list.
  plan?: ManagerPlanStep[];
  // Write-ahead merge intent (issue #76 fix): set to the agent being
  // merged BEFORE the merge runs, cleared after the outcome is recorded.
  // A kill between merge success and the post-merge save leaves the
  // branch merged on disk but still pending in state — on resume the
  // intent identifies the in-flight agent so the branch is checked with
  // isBranchMerged and marked merged WITHOUT re-running the worker.
  merging?: string | null;
}

// Stored resume state is untrusted JSON (a torn write, a hand edit, or
// a newer version could land here). Structural validation: anything
// that is not exactly a v1 state for this session is rejected, so
// resume fails closed with no_orchestrator_state instead of crashing
// on undefined.map / .push mid-run.
export function parseOrchestratorRunState(
  raw: unknown,
  sessionId: string,
): OrchestratorRunState | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  if (value.version !== 1 || value.sessionId !== sessionId) return undefined;
  if (typeof value.prompt !== 'string') return undefined;
  if (
    !Array.isArray(value.agents) ||
    !value.agents.every((entry) => typeof entry === 'string')
  ) {
    return undefined;
  }
  if (
    !Array.isArray(value.merged) ||
    !value.merged.every((entry) => typeof entry === 'string')
  ) {
    return undefined;
  }
  if (
    !Array.isArray(value.pending) ||
    !value.pending.every((entry) => typeof entry === 'string')
  ) {
    return undefined;
  }
  if (typeof value.stopped !== 'boolean') return undefined;
  if (!Array.isArray(value.records)) return undefined;
  for (const record of value.records) {
    if (typeof record !== 'object' || record === null) return undefined;
    const entry = record as Record<string, unknown>;
    if (typeof entry.agentId !== 'string') return undefined;
    if (typeof entry.branch !== 'string') return undefined;
    if (!Array.isArray(entry.hunks)) return undefined;
    for (const hunk of entry.hunks) {
      if (typeof hunk !== 'object' || hunk === null) return undefined;
      const part = hunk as Record<string, unknown>;
      if (typeof part.path !== 'string') return undefined;
      if (typeof part.hunk !== 'string') return undefined;
    }
  }
  // The stored plan (issue #103) is untrusted JSON like everything else: a
  // step that is not exactly id/step/total/prompt would reach runWorker as
  // a non-string prompt, so anything malformed fails closed here.
  if (value.plan !== undefined) {
    if (!Array.isArray(value.plan)) return undefined;
    for (const step of value.plan) {
      if (typeof step !== 'object' || step === null) return undefined;
      const entry = step as Record<string, unknown>;
      if (typeof entry.agentId !== 'string') return undefined;
      if (typeof entry.step !== 'number') return undefined;
      if (typeof entry.total !== 'number') return undefined;
      if (typeof entry.prompt !== 'string') return undefined;
    }
  }
  if (value.blocked !== undefined) {
    if (typeof value.blocked !== 'object' || value.blocked === null) {
      return undefined;
    }
    const blocked = value.blocked as Record<string, unknown>;
    if (typeof blocked.agentId !== 'string') return undefined;
    if (typeof blocked.oursDiff !== 'string') return undefined;
    if (typeof blocked.theirsDiff !== 'string') return undefined;
  }
  if (
    value.merging !== undefined &&
    value.merging !== null &&
    typeof value.merging !== 'string'
  ) {
    return undefined;
  }
  return raw as OrchestratorRunState;
}

export class OrchestratorStateSaveError extends Error {
  reason: string;

  constructor(sessionId: string, reason: string) {
    super(
      `orchestrator state save failed for session '${sessionId}': ${reason}`,
    );
    this.name = 'OrchestratorStateSaveError';
    this.reason = reason;
  }
}

export interface OrchestrateWorktree {
  path: string;
  branch: string;
}

// Worker-session naming (issue #85): one session per (orchestrator session,
// agent), so a worker's journals/usage/trajectory resolve inside its own
// worktree. The id must satisfy SESSION_ID_PATTERN — the child refuses
// anything else with exit 2 before it can attach.
export function workerSessionFor(sessionId: string, agentId: string): string {
  return `${sessionId}-${agentId}`;
}

// What the manager must do before spawning a worker (issue #85): `kubic run
// --session <id>` only ATTACHES, so the manager creates the session with an
// explicit id first. The spawn then happens with the same id.
export interface WorkerSessionRequest {
  sessionId: string;
  agentId: string;
  workerSessionId: string;
  worktree: OrchestrateWorktree;
}

// The id the child attaches to, handed to runWorker so the create step and
// the spawn cannot drift apart. Issue #104 adds the worker's assigned role
// and the role's resolved tool set + model pin: what the lane registers is
// the role's own set (§12.1/§40 — absence, not approval, withholds a tool),
// and the model default travels through the existing model pin.
export interface WorkerSpawnInfo {
  sessionId: string;
  workerSessionId: string;
  role?: string;
  tools?: string[];
  modelRef?: string;
}

// The §54 delegation DAG (§49.1 projection): the shipped run is one manager
// fanning out to N workers, so the manager→worker edges are projected
// through the agents-package graph module instead of being re-drawn here.
// §54's point is that this is a DAG, not a tree — a worker can feed a
// reviewer and a reviewer can serve two producers — so the projection is
// generated from explicit edge records over real session ids (the
// orchestrator session is the manager node; each worker's node is the
// session its child attaches to, `workerSessionFor`) rather than assumed
// from the fan-out shape. Refs only: an edge carries no transcript
// (§25.2/§69).
export function delegationGraphLines(
  sessionId: string,
  agents: readonly string[],
): string[] {
  const store = createGraph();
  const manager = addNode(store, sessionId);
  for (const agentId of agents) {
    const worker = addNode(store, workerSessionFor(sessionId, agentId));
    addEdge(store, { from: manager, to: worker, kind: 'delegated' });
  }
  return renderDag(store);
}

export interface ApprovalInput {
  agentId: string;
  branch: string;
}

// The verdict a merge approval settles on (issue #130, §41.2/§45.2). A
// decider's answer is `approve` or `deny`; `timeout` is the run's bound
// elapsing with nobody answering — a walked-away user, NOT a refusal — and
// the bound that elapsed travels with the verdict, so the run's message
// names the bound that was actually in force rather than re-deriving one.
// The seam stays backward-compatible: a plain `true` approves and a plain
// `false` is an explicit deny, the pre-#130 contract.
export type MergeApprovalVerdict =
  | { verdict: 'approve' }
  | { verdict: 'deny' }
  | { verdict: 'timeout'; maxPendingMs: number };

// One retained worktree, as reported after the run (issue #106, §44.1).
// `clean` is `undefined` when the status could not be read — a distinct state
// from `false`, because "unreadable" must never render as "dirty" OR "clean".
export interface RetainedWorktreeRow {
  agentId: string;
  branch: string;
  worktree: string;
  clean?: boolean;
  staged?: string[];
  unstaged?: string[];
  untracked?: string[];
  statusUnreadable?: string;
}

// How many file names one retained line lists before it summarizes. A
// worktree can hold thousands of untracked files (`node_modules`, a build
// dir), and a line that long is unreadable AND unbounded — the count is what
// the operator acts on, so the tail is summarized rather than dropped
// silently.
export const RETAINED_FILES_PER_LINE = 20;

// One file list for a retained line, bounded and sanitized. Names come from
// `git status` inside a worktree the WORKERS wrote, so a name carrying
// control bytes (ANSI/CSI/bidi) must render inert rather than drive the
// terminal that reads the line — the same strip set the scheduler's deny
// reasons use.
function fileList(label: string, files: readonly string[]): string | undefined {
  if (files.length === 0) return undefined;
  const shown = files
    .slice(0, RETAINED_FILES_PER_LINE)
    .map((file) => sanitizeReasonField(file))
    .join(', ');
  const hidden = files.length - RETAINED_FILES_PER_LINE;
  return hidden > 0
    ? `${label}=[${shown}] (+${hidden} more)`
    : `${label}=[${shown}]`;
}

// One retained-worktree row, rendered as the operator's line (issue #106,
// §44.1). A dirty row NAMES its files; an unreadable one says so instead of
// claiming clean. Pure, so the text and the JSON row are the same fact.
export function retainedRowLines(
  rows: readonly RetainedWorktreeRow[],
): string[] {
  const lines = rows.map((row) => {
    const prefix = `retained: ${row.agentId} branch=${row.branch} worktree=${row.worktree}`;
    if (row.statusUnreadable !== undefined) {
      return `${prefix} clean=unknown status-unreadable=${sanitizeReasonField(row.statusUnreadable)}`;
    }
    const parts = [`clean=${row.clean === true}`];
    for (const part of [
      fileList('staged', row.staged ?? []),
      fileList('unstaged', row.unstaged ?? []),
      fileList('untracked', row.untracked ?? []),
    ]) {
      if (part !== undefined) parts.push(part);
    }
    return `${prefix} ${parts.join(' ')}`;
  });
  if (lines.length > 0) {
    // The retain semantics, stated where the operator reads the evidence.
    lines.push(
      'retain: worktree + branch kept as evidence — only `kubic clean` disposes',
    );
  }
  return lines;
}

// What a resolver spawn reports back (issue #106). `resolved: true` is a
// claim about the WORKTREE (the resolver committed its settlement there) and
// is never taken as a claim about the merge: the manager re-runs the merge
// and only a successful merge settles the candidate.
export type ResolverOutcome =
  | { resolved: true }
  | { resolved: false; reason: string };

export interface OrchestrateCommandDeps {
  // stdout: the report lines or the one `--json` envelope.
  out: (line: string) => void;
  // stderr: `error: … code=<code>` and usage diagnostics (shared logger).
  err: (line: string) => void;
  // Colours the report labels; colourless when absent and under --json.
  theme?: CliTheme;
  // Colour of the stderr diagnostics, from stderr's own TTY state (never
  // stdout's); absent means plain.
  errTheme?: CliTheme;
  debug?: (line: string) => void;
  now?: () => number;
  isGitRepo: () => boolean | Promise<boolean>;
  ensureWorktree: (
    agentId: string,
  ) => OrchestrateWorktree | Promise<OrchestrateWorktree>;
  // Session creation (issue #85): the manager creates the worker session
  // (explicit id, cwd = the worker worktree) BEFORE the child spawns,
  // because `kubic run --session <id>` only attaches. Required for a run:
  // omitted means the spawn path cannot produce an attachable session, so
  // the run fails closed as `spawn_failed` instead of spawning a child
  // that dies at attach (exit 5 "unknown session").
  createWorkerSession: (
    input: WorkerSessionRequest,
  ) =>
    | { sessionId: string }
    | undefined
    | Promise<{ sessionId: string } | undefined>;
  runWorker: (
    agentId: string,
    worktree: OrchestrateWorktree,
    prompt: string,
    info?: WorkerSpawnInfo,
  ) => MergedHunk[] | Promise<MergedHunk[]>;
  mergeBranch: (
    agentId: string,
    worktree: OrchestrateWorktree,
  ) => void | Promise<void>;
  // Pre-merge guard (issue #76 fix a): abort a stale MERGE_HEAD left by
  // a kill-during-merge and refuse a dirty tree BEFORE the merge runs,
  // so resume never merges onto a half-merged tree. Optional so older
  // fakes keep working; absent means no guard (prod always provides it).
  prepareMerge?: (
    agentId: string,
    worktree: OrchestrateWorktree,
  ) => void | Promise<void>;
  // Already-merged probe (issue #76 fix b): true when the worker branch
  // is an ancestor of the merge target (git merge-base --is-ancestor in
  // prod). Used on resume to reconcile a leftover merging intent.
  // Absent means unknown — resume retries the worker (fail-closed
  // toward redoing work, never toward skipping a merge).
  isBranchMerged?: (
    agentId: string,
    worktree: OrchestrateWorktree,
  ) => boolean | Promise<boolean>;
  reapWorker: (agentId: string) => void | Promise<void>;
  // Lifecycle observations for an embedder (issue #94): the live rows, the
  // §78 code a failed worker reported, and the §61 launch samples with
  // their budget verdict. The composition root (apps/kubic) supplies these
  // from the worker lifecycle layer; the host side declares only the view
  // it reads, so host keeps no implementation import (dep-lint).
  launches?: OrchestrateLaunchObservations;
  // §12 role assignment on the delegation path (issue #104): returns the
  // plan of per-worker role assignments, composed from `.kubic/roles/*.md`
  // through the live loader (roles-boot.ts). The run composes each worker's
  // prompt as the role's `## Prompt` text + that worker's plan step, and
  // hands the role's resolved tool set down the spawn. A refusal
  // (`refused` non-empty) fails the run closed as `role_refused` with the
  // resolver's named reason BEFORE anything spawns. Omitted means no role
  // documents (the plan prompt stands, unchanged). Synchronous so the
  // composition root can read the directory with the real FileBridge.
  loadWorkerRoles?: (agents: readonly string[]) => WorkerRolesPlan;
  // The manager lane's registration seam (issue #103, §40). The run calls
  // this BEFORE it spawns anything; the lane it returns is the toolset the
  // root runs with. Defaults to `registerManagerLane()` — the §40 allowlist
  // — and a caller that supplies anything else with an exec tool registered
  // makes the registration throw, so the run refuses to start (exit 1,
  // code=manager_toolset_refused) rather than running with exec tools.
  registerManagerLane?: (tools?: readonly string[]) => ManagerLane;
  // The zero-writes assertion the merge path runs (issue #103, criterion 3).
  // Defaults to the shipped `assertManagerZeroWrites`; injectable so a test
  // can observe the exact trace the run asserts over. A wrapper that throws
  // on a tainted trace still fails the run closed — this is the gate, not a
  // notification.
  assertManagerZeroWrites?: (managerCalls: readonly string[]) => void;
  // The admission surface the run consults per spawn (issue #106, §49.1/§50).
  // Defaults to `new ParallelScheduler()` — the shipped default cap of four.
  // Injectable because the schedule is the thing being SURFACED now: a test
  // that wants a genuinely queued spawn hands in a scheduler whose slots are
  // already taken, instead of asserting a bookkeeping state the sequential
  // loop cannot produce on its own.
  scheduler?: ParallelScheduler;
  // Where the §49.1 trajectory record of a queued spawn goes (issue #106).
  // Absent means the event is built and reported on the debug channel only —
  // the CLI owns no trajectory store, so the composition root supplies the
  // sink. Only a QUEUED admission emits one: nothing else has a parallel
  // event to record.
  trajectoryEvent?: (event: ParallelTrajectoryEvent) => void;
  // Live status of a retained worktree (issue #106, §44.1). The run retains
  // every worktree and branch as evidence; without this seam an operator
  // cannot tell a clean retain from one still holding uncommitted work. It is
  // the composition root's `git status` reader (`getWorktreeStatus`), so host
  // stays free of an exec import. Absent means no retained-worktree lines —
  // the run is otherwise unchanged, and nothing is guessed.
  worktreeStatus?: (
    path: string,
    options: { sessionId: string; agentId: string },
  ) => Promise<WorktreeStatus> | WorktreeStatus;
  // The manager's live approval snapshot (issue #106, §45.2). A resolver is
  // spawned UNDER this snapshot — never a second policy — so a run that has
  // no snapshot to carry cannot delegate: it stops the queue exactly as it
  // did before delegation existed. The composition root supplies it from the
  // installed policy; there is deliberately no default, because a fabricated
  // snapshot would be a policy the manager never held.
  approvalPolicy?: ApprovalSnapshot;
  // The integrity hash of that snapshot. Absent means it is computed from the
  // snapshot here; a caller may carry one to prove the stale-hash refusal.
  policyHash?: string;
  // The resolver spawn seam (issue #106, §45.2). Called with the built spec
  // (both diffs, the writer tool set, the constraints, the frozen snapshot)
  // when a merge conflict is genuine. `resolved: true` means the resolver
  // reworked the tree and the manager should re-merge; anything else — a
  // refusal, a failure, or no seam at all — keeps the pre-existing
  // fail-closed terminus: the queue stops and the candidates are preserved.
  runResolver?: (
    request: ResolverRequest,
  ) => Promise<ResolverOutcome> | ResolverOutcome;
  // The merge gate's decider (issue #130). Settles a MergeApprovalVerdict:
  // the bounded seat's elapse is a `timeout` — labelled as such end to end —
  // while plain booleans keep their shipped meaning (`true` approves, `false`
  // denies). Absent means no decider: the run denies closed, exit 4.
  requestApproval?: (
    input: ApprovalInput,
  ) => MergeApprovalVerdict | boolean | Promise<MergeApprovalVerdict | boolean>;
  // Per-worker approvals + opt-in budgets (issue #105, §41.1/§41.2/§71).
  // The CLI owns the RUN OPTIONS (session, bound, budget, full-access) and the
  // composition root owns construction (its dir, its TTY seat, its debug
  // sink), so the host side declares only the factory it calls. Absent means
  // no approval layer: worker asks then never reach a user — which is exactly
  // the defect this issue fixes, so prod always supplies it.
  approvals?: (options: {
    sessionId: string;
    maxPendingMs: number;
    autoApprove: boolean;
    budget?: unknown;
    /** Per-spawn override: the budget for THAT worker's gate (§71). */
    budgetForAgent?: (agentId: string) => unknown;
    fullAccess?: boolean;
  }) => WorkerApprovalsRun;
  loadState?: (
    sessionId: string,
  ) =>
    | OrchestratorRunState
    | undefined
    | Promise<OrchestratorRunState | undefined>;
  saveState?: (state: OrchestratorRunState) => void | Promise<void>;
}

// Launch accounting of this run's workers (issue #94), as the host sees it:
// rows are registry rows (shape-only — host never imports worker), failure
// is the §78 code the lifecycle layer reported, and perf carries the §61
// sample with its budget verdict. All optional: an embedder that does not
// care reads none of it.
export interface OrchestrateLaunchFailureView {
  code: string;
  message: string;
}
export interface OrchestrateLaunchPerfView {
  ok: boolean;
  breaches: string[];
  sample: {
    spawnMs: number;
    startupMs?: number;
    attachMs?: number;
    worktreeMs?: number;
    teardownInitiateMs: number;
    teardownSettledMs: number;
  };
}
export interface OrchestrateLaunchObservations {
  rows: () => WorkerListRow[];
  failureOf: (agentId: string) => OrchestrateLaunchFailureView | undefined;
  perf: () => OrchestrateLaunchPerfView[];
}

export type OrchestrateStatus =
  | 'completed'
  | 'failed'
  | 'usage'
  | 'approval_denied'
  | 'approval_timeout'
  | 'merge_conflict';

export interface OrchestrateEnvelope {
  ok: boolean;
  exitCode: number;
  sessionId: string;
  status: OrchestrateStatus;
  workers: { agentId: string; branch: string; hunks: number }[];
  mergeOrder: string[];
  attribution: AttributedHunk[];
  // The §54 delegation DAG of this run (§49.1 projection), rendered by
  // `delegationGraphLines`. Present on every envelope — a run that never
  // spawned still has a manager node, so the shape is stable for consumers.
  graph: string[];
  // The §49.1/§50 admission surface of this run (issue #106): the running and
  // queued counts the scheduler actually held, plus the cap they are measured
  // against. Reported, never a gate — the shipped loop is strictly sequential,
  // so `queued` above zero means a slot was genuinely occupied.
  parallel?: ParallelWorkersExtra;
  // §44.1 retained-worktree status (issue #106): one row per worktree the run
  // retained, with the measured dirtiness and the files that made it dirty.
  // Same lines as the text output, so the two surfaces cannot disagree.
  retained?: RetainedWorktreeRow[];
  error?: { kind: string; message: string; code: string };
}

// The manager-side merge-path trace (§9.2, issue #46): spawn, diff, merge,
// apply only — every entry is on MANAGER_MERGE_ALLOWLIST, so the manager
// merges worker-produced diffs but never authors. Pinned here so the
// zero-writes invariant is observable without running a session.
//
// Issue #103 adds the lane's own delegation calls (`managerLaneCalls`) on
// top: a run that reaches the merge path has already spawned, waited on and
// collected from its workers, so the trace asserted at every merge is the
// merge plumbing PLUS that lane trace — the manager's real call record, not
// just the four merge-path names.
export function managerCallsForMerge(
  laneCalls: readonly string[] = [],
): string[] {
  return [
    'spawn_agent',
    'workspace_diff',
    'workspace_merge',
    'workspace_apply',
    ...laneCalls,
  ];
}

// The delegation calls the lane records as it runs a worker to completion
// (issue #103): spawn → wait → collect is the shipped per-worker sequence,
// every name on the §40 allowlist and none of them authoring. The merge path
// asserts over the recorded trace, so a manager that tried to author mid-lane
// would taint it and the merge would refuse.
export const MANAGER_LANE_SEQUENCE = [
  'spawn_agent',
  'wait_for_agent',
  'collect_result',
] as const;

// The §45.2 inspect-before-dispatch toolset (issue #106): the manager reads
// the conflict with the reviewer's read-only set, and that same set is what
// `dispatchResolverSpec` proves read-only before the writer-resolver is
// spawned. One list, re-exported from the merge path — a second copy here
// could drift wider and make the read-only assert prove a filtered list
// instead of the tools the inspection actually uses.
export const MANAGER_INSPECTION_SEQUENCE = REVIEWER_READONLY_TOOLS;

// What the manager tells the resolver it may not do. The resolver reworks the
// conflicted tree (that is the whole point of §45.2) but stays inside the
// settlement it was spawned for.
export const RESOLVER_CONSTRAINTS: readonly string[] = [
  'stay inside the worker worktree — never touch the manager repo tree',
  'settle only the conflicted files listed in this spec',
  'no network installs, no dependency changes',
  'commit the resolution on this branch so the manager can re-merge',
];

interface ParsedArgs {
  prompt?: string;
  agents: string[];
  sessionId?: string;
  resume: boolean;
  autoApprove: boolean;
  json: boolean;
  // Opt-in budgets (§71, issue #105): absent means NO budget is applied to a
  // spawn. Per-worker overrides arrive as --budget <agent>=<dims>; the shared
  // --budget <dims> applies to every worker of the run.
  budget?: unknown;
  budgetsByAgent: Record<string, unknown>;
  fullAccess: boolean;
}

// --budget maxToolCalls=10                                  (every worker)
// --budget worker-1:maxToolCalls=10;worker-2:maxCostUsd=1   (per spawn)
// Opt-in only: a malformed value is a usage error, never a silently dropped
// limit (a dropped limit would run a worker unbounded while looking bounded).
export const BUDGET_DIMENSIONS: readonly string[] = [
  'maxTokens',
  'maxCostUsd',
  'maxRuntimeMs',
  'maxToolCalls',
];

export interface ParsedBudgetSpec {
  shared?: Record<string, number>;
  byAgent: Record<string, Record<string, number>>;
}

function parseBudgetDims(raw: string): Record<string, number> | undefined {
  const dims: Record<string, number> = {};
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const equals = trimmed.indexOf('=');
    if (equals <= 0) return undefined;
    const name = trimmed.slice(0, equals).trim();
    const value = Number(trimmed.slice(equals + 1));
    if (!Number.isFinite(value) || !(value > 0)) return undefined;
    if (!BUDGET_DIMENSIONS.includes(name)) return undefined;
    dims[name] = value;
  }
  return Object.keys(dims).length === 0 ? undefined : dims;
}

export function parseBudgetSpec(raw: string): ParsedBudgetSpec | undefined {
  // Per-agent entries are `<agent>:<dims>` clauses separated by ';' so a
  // comma stays inside one agent's dimension list.
  const byAgent: Record<string, Record<string, number>> = {};
  let shared: Record<string, number> | undefined;
  for (const clause of raw.split(';')) {
    const trimmed = clause.trim();
    if (trimmed.length === 0) continue;
    const colon = trimmed.indexOf(':');
    const head = colon > 0 ? trimmed.slice(0, colon).trim() : '';
    if (head.length > 0 && !BUDGET_DIMENSIONS.includes(head)) {
      if (validateAgentId(head).length > 0) return undefined;
      const dims = parseBudgetDims(trimmed.slice(colon + 1));
      if (dims === undefined) return undefined;
      byAgent[head] = dims;
      continue;
    }
    const dims = parseBudgetDims(trimmed);
    if (dims === undefined) return undefined;
    shared = { ...(shared ?? {}), ...dims };
  }
  if (shared === undefined && Object.keys(byAgent).length === 0) {
    return undefined;
  }
  return {
    ...(shared === undefined ? {} : { shared }),
    byAgent,
  };
}

// `--agents a,b`: comma-separated worker ids, each a valid agent id and
// unique (one worktree per writer). Undefined when the list is malformed.
// A worker set is non-empty, duplicate-free, and every id is a valid agent id.
export function validAgentSet(agents: readonly string[]): boolean {
  return (
    agents.length > 0 &&
    new Set(agents).size === agents.length &&
    agents.every((agent) => validateAgentId(agent).length === 0)
  );
}

export function parseAgentList(raw: string): string[] | undefined {
  const agents = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return validAgentSet(agents) ? agents : undefined;
}

function parsedFrom(options: OrchestrateCliOptions): ParsedArgs {
  return {
    agents:
      options.agents === undefined
        ? [...ORCHESTRATE_DEFAULT_AGENTS]
        : [...options.agents],
    resume: options.resume === true,
    autoApprove: options.yes === true,
    json: options.json === true,
    // §71 opt-in budget, per spawn. Opt-in means exactly that: no flag →
    // nothing configured → no limit applied.
    ...(options.budget?.shared === undefined
      ? {}
      : { budget: options.budget.shared }),
    budgetsByAgent: options.budget?.byAgent ?? {},
    fullAccess: options.fullAccess === true,
    ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
    ...(options.session === undefined ? {} : { sessionId: options.session }),
  };
}

function statusForExit(exitCode: number, code: string): OrchestrateStatus {
  if (exitCode === RUN_EXIT_OK) return 'completed';
  if (exitCode === RUN_EXIT_USAGE) return 'usage';
  // Exit 4 is one code, two termini (issues #129/#130): a refusal is
  // `approval_denied`; a bounded wait running out is `approval_timeout`.
  // The exit alone cannot tell them apart — the failure CODE names which,
  // and the envelope's status/kind follow it so all three agree.
  if (exitCode === RUN_EXIT_APPROVAL_DENIED) {
    return code === APPROVAL_TIMEOUT_CODE
      ? 'approval_timeout'
      : 'approval_denied';
  }
  if (code === 'merge_conflict') return 'merge_conflict';
  return 'failed';
}

export async function runOrchestrateCommand(
  options: OrchestrateCliOptions,
  deps: OrchestrateCommandDeps,
): Promise<number> {
  const now = deps.now ?? Date.now;
  const debug = deps.debug ?? (() => undefined);
  const parsed = parsedFrom(options);
  // --json keeps every stream colourless; stdout carries one document.
  const theme =
    parsed.json || deps.theme === undefined
      ? createCliTheme('none')
      : deps.theme;
  const log = createLineLogger(deps.err, {
    theme:
      parsed.json || deps.errTheme === undefined
        ? createCliTheme('none')
        : deps.errTheme,
  });
  if (parsed.resume && parsed.sessionId === undefined) {
    log.error('--resume needs --session <id> (the run to re-attach to)');
    return RUN_EXIT_USAGE;
  }
  // Defence in depth: agent ids name worktrees and branches, the session id
  // a state file under .kubic/orchestrator — a library caller cannot bypass
  // the CLI's own --agents / --session checks.
  if (options.agents !== undefined && !validAgentSet(options.agents)) {
    log.error(
      `invalid --agents ${JSON.stringify(options.agents)} (unique ids of [A-Za-z0-9_-])`,
    );
    return RUN_EXIT_USAGE;
  }
  if (
    parsed.sessionId !== undefined &&
    !SESSION_ID_PATTERN.test(parsed.sessionId)
  ) {
    log.error(
      `invalid --session id ${JSON.stringify(parsed.sessionId)} (use [A-Za-z0-9_-])`,
    );
    return RUN_EXIT_USAGE;
  }
  const sessionId = parsed.sessionId ?? `orch-${now()}`;

  // The manager lane registers BEFORE anything spawns (issue #103, §40).
  // Registration validates the requested toolset against the allowlist, so
  // a lane carrying an exec tool refuses to START here — the named
  // ManagerToolsetError becomes `manager_toolset_refused`, exit 1, with
  // nothing created. `registerManagerLane` is also the lane the run's
  // manager calls are attributed to.
  const registerLane = deps.registerManagerLane ?? registerManagerLane;
  const assertWrites = deps.assertManagerZeroWrites ?? assertManagerZeroWrites;
  let managerLane: ManagerLane;
  try {
    managerLane = registerLane();
  } catch (error) {
    // A refused lane is a run failure like any other, so it honours the
    // output contract: one parseable envelope under --json (the failure
    // happens before `fail()` exists, which is why this is built inline),
    // prose plus the named code otherwise.
    const message = error instanceof Error ? error.message : String(error);
    log.error(`${message} code=manager_toolset_refused`);
    if (parsed.json) {
      const status = statusForExit(RUN_EXIT_FAILED, 'manager_toolset_refused');
      deps.out(
        formatJson({
          ok: false,
          exitCode: RUN_EXIT_FAILED,
          sessionId,
          status,
          workers: [],
          mergeOrder: [],
          attribution: [],
          graph: delegationGraphLines(sessionId, parsed.agents),
          error: {
            kind: status,
            message,
            code: 'manager_toolset_refused',
          },
        }),
      );
      return RUN_EXIT_FAILED;
    }
    return RUN_EXIT_FAILED;
  }

  const emit = (envelope: OrchestrateEnvelope, textLines: string[]): number => {
    // stdout is data (the envelope, or the report lines); the failure
    // line is a diagnostic on stderr in both modes.
    if (parsed.json) {
      deps.out(formatJson(envelope));
    } else {
      for (const line of textLines) deps.out(line);
    }
    if (envelope.error !== undefined) {
      log.error(`${envelope.error.message} code=${envelope.error.code}`);
    }
    return envelope.exitCode;
  };
  const fail = (
    exitCode: number,
    code: string,
    message: string,
    partial?: Pick<
      OrchestrateEnvelope,
      'workers' | 'mergeOrder' | 'attribution'
    >,
    // The agents the envelope should describe. Defaults to the parsed list,
    // which is right for the pre-state failures (usage/non-git refusals) —
    // but a resume run has no -p/--agents, so its parsed list is the CLI
    // default and the graph would name workers that are not in the run while
    // `workers` described the stored session (review finding F5).
    graphAgents?: readonly string[],
  ): number => {
    const status = statusForExit(exitCode, code);
    return emit(
      {
        ok: false,
        exitCode,
        sessionId,
        status,
        workers: partial?.workers ?? [],
        mergeOrder: partial?.mergeOrder ?? [],
        attribution: partial?.attribution ?? [],
        graph: delegationGraphLines(sessionId, graphAgents ?? parsed.agents),
        error: { kind: status, message, code },
      },
      [`${theme.accent('session:')} ${sessionId}`],
    );
  };

  if (parsed.prompt === undefined && !parsed.resume) {
    log.error(
      'missing -p, --prompt <text> (the objective), or --resume --session <id>',
    );
    return RUN_EXIT_USAGE;
  }
  if (!(await deps.isGitRepo())) {
    // --json: the envelope names it (and `fail` logs the one-line code);
    // text: the full refusal with the way out.
    if (parsed.json) {
      return fail(RUN_EXIT_USAGE, 'not_a_repo', 'not a git repository');
    }
    log.error(
      'orchestrator mode needs a git repository — run solo here (`kubic run -p <prompt>`) or retry inside a git checkout (orchestrator never falls back to solo)',
    );
    return RUN_EXIT_USAGE;
  }

  // Resume: re-attach to the stored session. The stored payload is
  // untrusted JSON — anything malformed fails closed here as
  // no_orchestrator_state. A stopped queue also fails closed here —
  // blocked candidates are re-reported, never retried silently.
  let state: OrchestratorRunState;
  if (parsed.resume) {
    const loaded = await deps.loadState?.(sessionId);
    const resumed =
      loaded === undefined
        ? undefined
        : parseOrchestratorRunState(loaded, sessionId);
    if (resumed === undefined) {
      return fail(
        RUN_EXIT_FAILED,
        'no_orchestrator_state',
        `no orchestrator state for session '${sessionId}' — start a run first, then --resume to continue it`,
      );
    }
    if (resumed.stopped) {
      return fail(
        RUN_EXIT_FAILED,
        'merge_conflict',
        `merge queue stopped by the unresolvable conflict on '${resumed.blocked?.agentId ?? 'unknown'}': candidates preserved, nothing merged on resume`,
        {
          workers: resumed.records.map((record) => ({
            agentId: record.agentId,
            branch: record.branch,
            hunks: record.hunks.length,
          })),
          mergeOrder: resumed.merged,
          attribution: resumed.records.flatMap((record) =>
            attributeMergedHunks(record.hunks, record.agentId),
          ),
        },
        // The stored session's agents: workers above describe this run, so
        // the graph must too (review finding F5).
        resumed.agents,
      );
    }
    state = resumed;
  } else {
    state = {
      version: 1,
      sessionId,
      prompt: parsed.prompt as string,
      agents: parsed.agents,
      merged: [],
      pending: [...parsed.agents],
      stopped: false,
      records: [],
    };
  }
  // Role documents on the delegation path (issue #104, §12/§12.1). The
  // loader runs BEFORE anything spawns or merges: a contradictory document
  // (§40.3) or a role with no `## Prompt` instructions refuses the run with
  // the resolver's named reason — never a silent fallback to an
  // instruction-less prompt. Keyed on the STATE's agent list (not the
  // parsed one), because a --resume run carries no --agents and the workers
  // it retries are the stored session's: assignment is a deterministic
  // function of that order, so every worker keeps the role it had.
  const rolePlan: WorkerRolesPlan = deps.loadWorkerRoles?.(state.agents) ?? {
    assignments: [],
    refused: [],
  };
  if (rolePlan.refused.length > 0) {
    const reasons = rolePlan.refused.map((entry) => entry.reason).join('; ');
    return fail(
      RUN_EXIT_FAILED,
      'role_refused',
      `role document refused the run: ${reasons}`,
      undefined,
      state.agents,
    );
  }
  // Each worker prompt is composed as the assigned role's `## Prompt` text
  // PLUS that worker's plan step — never one replacing the other. The
  // composed plan is what persists, so `--resume` replays each worker's own
  // composed prompt. With no role documents this is the identity, so the
  // plan prompt stands unchanged.
  const composeRoles = (steps: ManagerPlanStep[]): ManagerPlanStep[] =>
    applyRolesToPlan(rolePlan.assignments, steps);
  const prompt = parsed.prompt ?? state.prompt;
  // The manager's plan (issue #103): one step per worker, each carrying that
  // worker's prompt. A resumed state written before #103 (or by a caller
  // that dropped it) re-derives the plan from the stored objective and agent
  // list, so --resume replays per-worker prompts either way — never the
  // shared `-p` text.
  if (state.plan === undefined) {
    state = {
      ...state,
      plan: composeRoles(buildManagerPlan(prompt, state.agents)),
    };
  }
  const plan = state.plan as ManagerPlanStep[];
  const promptForWorker = (agentId: string): string => {
    const step = planStepFor(plan, agentId);
    return step === undefined ? prompt : step.prompt;
  };
  // The role half of a worker's spawn info (issue #104): the assigned role,
  // its resolved tool set and its model default. Empty for a worker with no
  // assignment (no role documents), so the spawn info keeps its #85 shape.
  const spawnRoleInfo = (
    agentId: string,
    roles: WorkerRolesPlan,
  ): Pick<WorkerSpawnInfo, 'role' | 'tools' | 'modelRef'> => {
    const assignment = workerRoleAssignment(roles, agentId);
    if (assignment === undefined) return {};
    return {
      role: assignment.role,
      tools: [...assignment.tools],
      modelRef: assignment.modelRef,
    };
  };
  // The lane's own call trace (issue #103): the manager drives each worker
  // through spawn → wait → collect, and each driven worker contributes its
  // own sequence — recorded through the allowlist-checking recorder as the
  // worker settles, so the trace the merge path asserts over is the
  // manager's real record of what it did. Each step must be on the lane the
  // registration handed back; a step the lane does not register would make
  // the trace a claim about calls the lane cannot make, so it refuses.
  const laneSpy = createManagerCallSpy();
  const laneCalls: string[] = [];
  // The lane must register every step the trace will claim — checked once,
  // before anything spawns, so a lane that cannot make these calls refuses
  // rather than recording a trace it cannot honour.
  for (const step of MANAGER_LANE_SEQUENCE) {
    if (!managerLane.tools.includes(step)) {
      return fail(
        RUN_EXIT_FAILED,
        'manager_toolset_refused',
        `manager lane does not register '${step}' — the delegation trace cannot be recorded`,
      );
    }
  }
  const recordLaneSequence = (): void => {
    for (const step of MANAGER_LANE_SEQUENCE) {
      recordManagerLaneCall(laneSpy, step);
      laneCalls.push(step);
    }
  };
  const queue = createMergeQueue();
  // The admission surface (issue #106, §49.1/§50): the scheduler was already
  // consulted per spawn, but nothing it computed reached the operator. The
  // counts are kept as a HIGH-WATER over the run — the most the admission
  // layer ever held — so a run that drained every slot still reports what it
  // reached, and `queued` above zero can only come from a slot that was
  // genuinely occupied at the time of the request.
  const scheduler = deps.scheduler ?? new ParallelScheduler();
  let runningHighWater = 0;
  let queuedHighWater = 0;
  const observeAdmission = (): void => {
    runningHighWater = Math.max(runningHighWater, scheduler.runningCount());
    queuedHighWater = Math.max(queuedHighWater, scheduler.queuedCount());
  };
  // The workers-extra row for the surfaces (§50). `usage` is deliberately
  // absent: a worker is a separate process whose usage rows land in its own
  // session store, so a number this process never measured is not reported.
  const parallelExtra = (): ParallelWorkersExtra =>
    buildParallelWorkersExtra({
      running: runningHighWater,
      queued: queuedHighWater,
      maxConcurrency: scheduler.maxConcurrency(),
    });
  const worktrees = new Map<string, OrchestrateWorktree>();
  const hunksByAgent = new Map<string, MergedHunk[]>();
  for (const record of state.records) {
    hunksByAgent.set(record.agentId, record.hunks);
  }

  // Per-worker approvals + opt-in budgets (issue #105; §41.1, §41.2, §71).
  // One approvals run for the whole orchestration: the router, its durable
  // decision store, the ask mailbox the workers publish to, the per-spawn
  // budget gates and the session-scoped full-access posture. Constructed only
  // when the composition root wired the factory — a caller with no approval
  // layer keeps the old behaviour instead of a half-wired one.
  const approvalsRun = deps.approvals?.({
    sessionId,
    // The bound is a fixed run-level contract, not a caller knob: a headless
    // ask must deny closed on a human timescale, never hang.
    maxPendingMs: ORCHESTRATE_APPROVAL_BOUND_MS,
    autoApprove: parsed.autoApprove,
    ...(parsed.budget === undefined ? {} : { budget: parsed.budget }),
    // Per-spawn overrides (`--budget worker-1:maxToolCalls=5`) reach the gate
    // of THAT spawn only; absent, the shared spec applies.
    budgetForAgent: (agentId: string) =>
      parsed.budgetsByAgent[agentId] ?? parsed.budget,
    ...(parsed.fullAccess ? { fullAccess: true } : {}),
  });
  const approvalScopeFor = (
    agentId: string,
    worktree: OrchestrateWorktree,
  ): WorkerApprovalScope => ({
    sessionId,
    agentId,
    worktree: worktree.path,
    role: 'worker',
  });

  const partial = (): Pick<
    OrchestrateEnvelope,
    'workers' | 'mergeOrder' | 'attribution'
  > => ({
    workers: state.agents.map((agentId) => {
      const record = state.records.find((entry) => entry.agentId === agentId);
      const hunks = hunksByAgent.get(agentId) ?? [];
      return {
        agentId,
        branch: record?.branch ?? `kubic/${agentId}`,
        hunks: hunks.length,
      };
    }),
    mergeOrder: [...state.merged],
    attribution: state.records.flatMap((record) =>
      attributeMergedHunks(record.hunks, record.agentId),
    ),
  });

  const reapSpawned = async (
    spawned: string[],
  ): Promise<{ agentId: string; message: string } | undefined> => {
    for (const agentId of spawned) {
      try {
        await deps.reapWorker(agentId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { agentId, message };
      }
    }
    return undefined;
  };

  // Fail-closed state save (issue #76 fix c): a store throw used to
  // escape as an unhandled rejection (or, in prod, be swallowed to
  // debug-only). Now every save maps to a machine-readable
  // state_save_failed envelope — the run never proceeds merge-side
  // without its state persisted.
  const saveOrFail = async (
    next: OrchestratorRunState,
  ): Promise<number | undefined> => {
    try {
      await deps.saveState?.(next);
      return undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(
        RUN_EXIT_FAILED,
        'state_save_failed',
        `orchestrator state save failed for session '${next.sessionId}': ${message}`,
        partial(),
      );
    }
  };

  // Reconcile a leftover write-ahead merge intent (issue #76 fix b).
  // A kill between merge success and the post-merge save leaves the
  // branch merged on disk but still pending in state. When the intent
  // names such a branch (merge-base --is-ancestor in prod), mark it
  // merged WITHOUT re-running the worker — no double-merge. When the
  // branch is not merged (kill before the merge, or a failed merge),
  // drop the stale intent so the normal path retries the worker behind
  // the pre-merge guard. Unknown (no isBranchMerged probe) retries.
  const reconcileMergeIntent = async (): Promise<number | undefined> => {
    const inFlight = state.merging;
    if (inFlight === undefined || inFlight === null) return undefined;
    if (!state.pending.includes(inFlight)) {
      state = { ...state, merging: undefined };
      return undefined;
    }
    let worktree: OrchestrateWorktree;
    try {
      worktree = await deps.ensureWorktree(inFlight);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(
        RUN_EXIT_FAILED,
        'spawn_failed',
        `spawn failed for worker '${inFlight}': ${message}`,
        partial(),
      );
    }
    worktrees.set(inFlight, worktree);
    let alreadyMerged = false;
    try {
      alreadyMerged =
        (await deps.isBranchMerged?.(inFlight, worktree)) === true;
    } catch {
      alreadyMerged = false;
    }
    if (!alreadyMerged) {
      state = { ...state, merging: undefined };
      return undefined;
    }
    if (!state.records.some((record) => record.agentId === inFlight)) {
      state.records.push({
        agentId: inFlight,
        branch: worktree.branch,
        hunks: [],
      });
    }
    state.merged.push(inFlight);
    state.pending = state.pending.filter((entry) => entry !== inFlight);
    state = { ...state, merging: undefined };
    debug(
      `reconciled: ${inFlight} (branch ${worktree.branch}) already merged — skipped re-run`,
    );
    const saveFailure = await saveOrFail(state);
    if (saveFailure !== undefined) return saveFailure;
    return undefined;
  };

  // Spawn + run every pending worker, then enqueue in agent order. A kill
  // here leaves pending intact in the saved state, so resume retries the
  // workers that never reported — merged workers are never re-run.
  const spawned: string[] = [];
  {
    const reconcileFailure = await reconcileMergeIntent();
    if (reconcileFailure !== undefined) return reconcileFailure;
  }
  {
    const saveFailure = await saveOrFail(state);
    if (saveFailure !== undefined) return saveFailure;
  }
  for (const agentId of state.pending) {
    // Resume may already hold this worktree (intent reconciliation
    // resolved it for the isBranchMerged probe) — never ensure twice.
    let worktree = worktrees.get(agentId);
    if (worktree === undefined) {
      try {
        worktree = await deps.ensureWorktree(agentId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failure = await reapSpawned(spawned);
        void failure;
        return fail(
          RUN_EXIT_FAILED,
          'spawn_failed',
          `spawn failed for worker '${agentId}': ${message}`,
          partial(),
        );
      }
      worktrees.set(agentId, worktree);
    }
    spawned.push(agentId);
    const admission = scheduler.requestSpawn(
      { agentId, sessionId, worktree: worktree.path },
      'autonomous',
    );
    // The admission layer's own numbers, sampled right after the request
    // (issue #106, §49.1/§50) — the point at which running/queued are the
    // truth the operator was previously never shown.
    observeAdmission();
    if (admission.outcome === 'denied') {
      const failure = await reapSpawned(spawned);
      void failure;
      return fail(
        RUN_EXIT_FAILED,
        'spawn_denied',
        `spawn denied for worker '${agentId}': ${admission.reason}`,
        partial(),
      );
    }
    if (admission.outcome === 'queued') {
      // Review finding F2: this loop is strictly sequential — it awaits each
      // worker before requesting the next admission — so concurrency is 1 and
      // no slot is ever contended. A `queued` outcome can therefore only come
      // from bookkeeping that was never released, and reporting it would tell
      // an operator that a cap is gating the run when nothing is. The slot is
      // released as soon as the worker settles (below), so the admission layer
      // stays truthful if the loop ever becomes concurrent.
      debug(
        `admission: worker '${agentId}' queued at position ${admission.position} despite sequential spawn — releasing and proceeding`,
      );
      // A queued spawn is the one admission outcome that HAS a parallel
      // event to record (issue #106, §49.1): the §49.1 tree line carries the
      // queue depth, and the plain JSON record goes to the trajectory sink
      // the composition root wires. `wakeups` is empty by construction here:
      // the sequential loop releases the worker's slot only after it settles
      // and nothing else is waiting, so the drain has nothing to admit —
      // naming a wakeup that never happened would be a fabricated record.
      if (deps.trajectoryEvent !== undefined) {
        deps.trajectoryEvent(
          buildParallelTrajectoryEvent({
            sessionId,
            ...parallelExtra(),
            wakeups: [],
          }),
        );
      }
    }
    // Create the worker session BEFORE spawning the child (issue #85):
    // `kubic run --session <id>` only attaches, so a child spawned without
    // a session dies at attach (exit 5 "unknown session"). The session is
    // created with the worker's worktree as cwd, so the worker's journals
    // and session state land with the worker. Omitted hook or a failed
    // create fails closed as spawn_failed — never a doomed spawn.
    const workerSessionId = workerSessionFor(sessionId, agentId);
    try {
      const created = await deps.createWorkerSession?.({
        sessionId,
        agentId,
        workerSessionId,
        worktree,
      });
      if (created === undefined) {
        const failure = await reapSpawned(spawned);
        void failure;
        return fail(
          RUN_EXIT_FAILED,
          'spawn_failed',
          `spawn failed for worker '${agentId}': no session-creation hook is wired for session '${workerSessionId}' — a spawned child could only die at attach ("unknown session")`,
          partial(),
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failure = await reapSpawned(spawned);
      void failure;
      return fail(
        RUN_EXIT_FAILED,
        'spawn_failed',
        `spawn failed for worker '${agentId}': could not create session '${workerSessionId}': ${message}`,
        partial(),
      );
    }
    try {
      // The worker runs ITS plan step's prompt (issue #103) — never the
      // shared `-p` text.
      // Approvals (issue #105): the pump routes whatever this worker publishes
      // to the user while it runs, and the budget gate for this spawn is the
      // one its own --budget (or the shared spec) configured.
      if (approvalsRun !== undefined) {
        approvalsRun.beginWorker(approvalScopeFor(agentId, worktree));
      }
      const hunks = await deps.runWorker(
        agentId,
        worktree,
        promptForWorker(agentId),
        {
          sessionId,
          workerSessionId,
          // The role this worker was assigned and the tool set its lane
          // must register (§12.1/§40): the resolved set is what withholds
          // a tool — absence, never approval. Absent means no role
          // document exists for this worker, so nothing is narrowed.
          ...spawnRoleInfo(agentId, rolePlan),
        },
      );
      // The worker settled: route any ask that raced its exit, then read the
      // terminal outcome its run produced (a denial or a budget hit is NOT a
      // spawn failure — it carries its own named code and exit).
      if (approvalsRun !== undefined) {
        const scope = approvalScopeFor(agentId, worktree);
        const raced = await approvalsRun.pump(scope);
        approvalsRun.endWorker(agentId);
        const termination = raced ?? approvalsRun.takeTermination(agentId);
        if (termination !== undefined) {
          await reapSpawned(spawned);
          return fail(
            termination.exitCode,
            termination.code,
            termination.message,
            partial(),
          );
        }
      }
      hunksByAgent.set(agentId, [...hunks]);
      // The lane drove this worker to completion — its spawn → wait →
      // collect is part of the manager's real call record (issue #103).
      recordLaneSequence();
    } catch (error) {
      // A worker that exited non-zero because the USER denied it (or because a
      // configured budget ran out) reports the approval layer's named status in
      // the child's own §78 terminus; that code wins over the generic
      // worker_failed so the run's exit stays 3/4-bound instead of 1-bound.
      if (approvalsRun !== undefined) {
        approvalsRun.endWorker(agentId);
        const termination = approvalsRun.takeTermination(agentId);
        if (termination !== undefined) {
          await reapSpawned(spawned);
          return fail(
            termination.exitCode,
            termination.code,
            termination.message,
            partial(),
          );
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      await reapSpawned(spawned);
      // The child's own approval terminus (issue #105) wins over the generic
      // worker_failed: a worker that denied itself closed on a bounded wait
      // (or on its configured budget) ended on a named approval/budget code,
      // and reporting it as a crash would misstate what the user decided.
      const approval = (
        error as { approval?: { code: string; exitCode: number } }
      ).approval;
      if (approval !== undefined) {
        return fail(
          approval.exitCode,
          approval.code,
          `worker '${agentId}': ${message}`,
          partial(),
        );
      }
      // The lifecycle layer names the §78 code for the failure it saw
      // (issue #94): a worker that never became ready is `spawn_failed`,
      // anything else keeps `worker_failed`. The error is duck-typed here
      // so host stays free of an implementation import.
      const named =
        typeof (error as { code?: unknown }).code === 'string'
          ? ((error as { code: string }).code as
              | 'spawn_failed'
              | 'worker_failed')
          : 'worker_failed';
      return fail(
        RUN_EXIT_FAILED,
        named,
        `worker '${agentId}' failed: ${message}`,
        partial(),
      );
    }
    queue.enqueue({ agentId, branch: worktree.branch });
    // Release the admission slot now that this worker has settled (review
    // finding F2: `complete` was never called, so `running` grew unbounded and
    // every worker past the cap was reported queued — a signal that could not
    // be true for a loop that awaits each worker before requesting the next).
    scheduler.complete(agentId);
    debug(`spawn: worker '${agentId}' in ${worktree.path}`);
  }

  // §45.2 conflict delegation (issue #106). The manager never resolves a
  // conflict itself: on a genuine conflict it builds the writer-resolver spec
  // (`dispatchResolverSpec` — both diffs, the implementer/debugger tool set,
  // the settlement constraints), hands it to the composition root's resolver
  // spawn seam, and re-merges. The spec is built from the manager's OWN live
  // snapshot (`deps.approvalPolicy`), so the resolver runs under the same
  // approval rules — the carried hash is recomputed inside the spec builder
  // and the snapshot is frozen there, never widened. A run with no snapshot
  // and no spawn seam cannot delegate: it reports why and falls through to
  // the unchanged fail-closed terminus.
  type DelegationAttempt =
    | { outcome: 'delegated' }
    | { outcome: 'unavailable'; reason: string }
    | { outcome: 'failed'; message: string };
  const delegateConflict = async (
    agentId: string,
    worktree: OrchestrateWorktree,
    conflict: MergeConflictError,
  ): Promise<DelegationAttempt> => {
    const snapshot: ApprovalSnapshot | undefined = deps.approvalPolicy;
    if (snapshot === undefined) {
      const reason =
        'the run carries no manager approval snapshot to delegate under';
      debug(`resolution: ${agentId} not delegated — ${reason}`);
      return { outcome: 'unavailable', reason };
    }
    if (deps.runResolver === undefined) {
      const reason = 'no resolver spawn seam is wired for this run';
      debug(`resolution: ${agentId} not delegated — ${reason}`);
      return { outcome: 'unavailable', reason };
    }
    let spec: ResolverSpawnSpec;
    try {
      spec = dispatchResolverSpec(
        {
          agentId,
          role: 'implementer',
          constraints: [...RESOLVER_CONSTRAINTS],
          oursDiff: conflict.oursDiff,
          theirsDiff: conflict.theirsDiff,
          approvalPolicy: snapshot,
          policyHash: deps.policyHash ?? hashApprovalPolicy(snapshot),
        },
        [...MANAGER_INSPECTION_SEQUENCE],
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debug(`resolution: ${agentId} spec refused — ${message}`);
      return { outcome: 'failed', message };
    }
    // The manager drives the resolver through the same delegation sequence it
    // drives any worker with (spawn → wait → collect), so the merge-path
    // trace asserted below still describes what the manager actually did.
    recordLaneSequence();
    try {
      const outcome = await deps.runResolver({
        agentId,
        worktree: { path: worktree.path, branch: worktree.branch },
        spec,
        prompt: resolverPromptFor(spec),
      });
      if (outcome.resolved !== true) {
        debug(
          `resolution: resolver could not settle '${agentId}' — ${outcome.reason}`,
        );
        return { outcome: 'failed', message: outcome.reason };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debug(`resolution: resolver failed for '${agentId}' — ${message}`);
      return { outcome: 'failed', message };
    }
    debug(
      `resolved: ${agentId} by a ${spec.role} resolver (${spec.conflict.files.length} conflicted file(s)) — re-merging`,
    );
    return { outcome: 'delegated' };
  };

  // Settle FIFO: approve → persist the write-ahead merge intent →
  // pre-merge guard → prove the manager trace write-free → merge →
  // attribute → record. Each merge is atomic per candidate and recorded
  // before the next dequeues, so a kill between merges resumes cleanly.
  let candidate = queue.dequeue();
  while (candidate !== undefined) {
    const { agentId } = candidate;
    const worktree = worktrees.get(agentId) as OrchestrateWorktree;
    // The gate's verdict (issue #130). A plain boolean from an older seam
    // keeps its shipped meaning (`true` approves, `false` denies — as does
    // no seam at all); the bounded seat's timeout verdict keeps its own
    // label, so a walked-away user is never reported as a refusal.
    const settled = parsed.autoApprove
      ? true
      : await deps.requestApproval?.({ agentId, branch: worktree.branch });
    const verdict: MergeApprovalVerdict =
      settled === true
        ? { verdict: 'approve' }
        : settled === false || settled === undefined
          ? { verdict: 'deny' }
          : settled;
    if (verdict.verdict !== 'approve') {
      const saveFailure = await saveOrFail(state);
      if (saveFailure !== undefined) {
        await reapSpawned(spawned);
        return saveFailure;
      }
      await reapSpawned(spawned);
      if (verdict.verdict === 'timeout') {
        // The bound elapsed with nobody answering — a TIMEOUT, not a
        // refusal (issue #129's rule applied to this gate). Exit 4 either
        // way; the code names which, and status/kind follow it.
        return fail(
          RUN_EXIT_APPROVAL_DENIED,
          APPROVAL_TIMEOUT_CODE,
          `approval timed out after ${verdict.maxPendingMs}ms for worker '${agentId}': nobody answered the merge gate — rerun with --yes to auto-approve merges`,
          partial(),
        );
      }
      return fail(
        RUN_EXIT_APPROVAL_DENIED,
        'approval_denied',
        `approval denied for worker '${agentId}': the decider is the user — rerun with --yes to auto-approve merges`,
        partial(),
      );
    }
    state = { ...state, merging: agentId };
    {
      const saveFailure = await saveOrFail(state);
      if (saveFailure !== undefined) {
        await reapSpawned(spawned);
        return saveFailure;
      }
    }
    // §45.2 conflict delegation (issue #106): a conflict the merge reports may
    // be handed to a spawned resolver. Bounded to ONE resolver attempt per
    // candidate — a second conflict on the re-merge is the terminus, never a
    // retry loop. Both merge legs run the same guard → trace → merge sequence
    // as the pre-#106 path, so the merge plumbing itself is unchanged.
    const mergeAttempt = async (): Promise<void> => {
      await deps.prepareMerge?.(agentId, worktree);
      assertWrites(managerCallsForMerge(laneCalls));
      await deps.mergeBranch(agentId, worktree);
    };
    let conflict: MergeConflictError | undefined;
    let mergeFailure: unknown;
    try {
      await mergeAttempt();
    } catch (error) {
      if (error instanceof MergeConflictError) {
        conflict = error;
      } else {
        mergeFailure = error;
      }
    }
    let delegationNote: string | undefined;
    if (conflict !== undefined) {
      const attempt = await delegateConflict(agentId, worktree, conflict);
      delegationNote =
        attempt.outcome === 'unavailable'
          ? attempt.reason
          : attempt.outcome === 'failed'
            ? attempt.message
            : undefined;
      if (attempt.outcome === 'delegated') {
        // The resolver reworked the worker's worktree; only a successful
        // re-merge settles the candidate, so the outcome is re-derived here
        // rather than trusted from the resolver's own report.
        conflict = undefined;
        try {
          await mergeAttempt();
        } catch (error) {
          if (error instanceof MergeConflictError) {
            conflict = error;
            debug(
              `resolution: '${agentId}' still conflicted after the resolver — stopping the queue`,
            );
          } else {
            mergeFailure = error;
          }
        }
      } else {
        debug(
          `resolution: '${agentId}' not settled (${attempt.outcome === 'unavailable' ? attempt.reason : attempt.message})`,
        );
      }
    }
    if (conflict !== undefined) {
      const error = conflict;
      queue.markUnresolvable(agentId, {
        oursDiff: error.oursDiff,
        theirsDiff: error.theirsDiff,
      });
      state = {
        ...state,
        stopped: true,
        merging: undefined,
        blocked: {
          agentId,
          oursDiff: error.oursDiff,
          theirsDiff: error.theirsDiff,
        },
        // The failed candidate was already dequeued, so the queue no
        // longer lists it — pending keeps every unmerged agent in the
        // original order instead (resume retries exactly this set).
        pending: state.pending,
      };
      const saveFailure = await saveOrFail(state);
      if (saveFailure !== undefined) {
        await reapSpawned(spawned);
        return saveFailure;
      }
      await reapSpawned(spawned);
      // The shipped sentence is unchanged; the delegation outcome is appended
      // so an operator reads WHY no resolver settled it (issue #106) instead
      // of a silence that is indistinguishable from "delegation never ran".
      return fail(
        RUN_EXIT_FAILED,
        'merge_conflict',
        `merge conflict for worker '${agentId}': unresolvable automatically — queue stopped, candidates preserved${delegationNote === undefined ? '' : ` (resolver: ${delegationNote})`}`,
        partial(),
      );
    }
    if (mergeFailure !== undefined) {
      const error = mergeFailure;
      const message = error instanceof Error ? error.message : String(error);
      // The merge may have succeeded on disk before the throw (kill
      // window) — keep the write-ahead intent so resume reconciles via
      // isBranchMerged instead of double-merging.
      const saveFailure = await saveOrFail(state);
      if (saveFailure !== undefined) {
        await reapSpawned(spawned);
        return saveFailure;
      }
      await reapSpawned(spawned);
      return fail(
        RUN_EXIT_FAILED,
        'merge_failed',
        `merge failed for worker '${agentId}': ${message}`,
        partial(),
      );
    }
    const hunks = hunksByAgent.get(agentId) ?? [];
    state.records.push({ agentId, branch: worktree.branch, hunks });
    state.merged.push(agentId);
    state.pending = state.pending.filter((entry) => entry !== agentId);
    state = { ...state, merging: undefined };
    {
      const saveFailure = await saveOrFail(state);
      if (saveFailure !== undefined) {
        await reapSpawned(spawned);
        return saveFailure;
      }
    }
    debug(`merged: ${agentId} (branch ${worktree.branch})`);
    candidate = queue.dequeue();
  }

  const reapError = await reapSpawned(spawned);
  if (reapError !== undefined) {
    return fail(
      RUN_EXIT_FAILED,
      'reap_failed',
      `reap failed for worker '${reapError.agentId}': ${reapError.message}`,
      partial(),
    );
  }

  const attribution = state.records.flatMap((record) =>
    attributeMergedHunks(record.hunks, record.agentId),
  );
  // §44.1 retained-worktree status (issue #106): every worktree this run
  // created stayed on disk (that is the retain rule — only `kubic clean`
  // disposes), so each one gets one line stating whether it is dirty and, if
  // it is, WHICH files. The reader is measured: a status that cannot be read
  // is reported as `clean=unknown`, never as a false clean.
  const retained: RetainedWorktreeRow[] = [];
  if (deps.worktreeStatus !== undefined) {
    for (const agentId of spawned) {
      const worktree = worktrees.get(agentId);
      if (worktree === undefined) continue;
      try {
        const status = await deps.worktreeStatus(worktree.path, {
          sessionId,
          agentId,
        });
        retained.push({
          agentId,
          branch: worktree.branch,
          worktree: worktree.path,
          clean: status.clean,
          staged: [...status.staged],
          unstaged: [...status.unstaged],
          untracked: [...status.untracked],
        });
      } catch (error) {
        // Best-effort: an unreadable status is reported, never a false clean
        // and never a run failure — the run already settled.
        const message = error instanceof Error ? error.message : String(error);
        retained.push({
          agentId,
          branch: worktree.branch,
          worktree: worktree.path,
          statusUnreadable: message.slice(0, 200),
        });
      }
    }
  }
  const retainedLines = retainedRowLines(retained);
  // The admission surface of the whole run (issue #106): one snapshot, read
  // by the text lines, the JSON envelope and (per queued spawn) the
  // trajectory event, so the three can never disagree.
  const parallel = parallelExtra();
  const perAgent = state.records
    .map((record) => `${record.agentId}=${record.hunks.length} hunk(s)`)
    .join(', ');
  const textLines = [
    `${theme.accent('session:')} ${sessionId}`,
    ...state.records.map(
      (record) =>
        `worker: ${record.agentId} branch=${record.branch} hunks=${record.hunks.length}`,
    ),
    `merge order: ${state.merged.join(' -> ')}`,
    `attribution: ${perAgent}`,
    ...state.merged.map((agentId) => `${theme.success('merged:')} ${agentId}`),
    ...spawned.map((agentId) => `${theme.muted('reaped:')} ${agentId}`),
    // §54: the delegation shape, one line per node/edge of the run's DAG.
    ...delegationGraphLines(sessionId, state.agents).map(
      (line) => `${theme.muted('dag:')} ${line}`,
    ),
    // §49.1/§50 (issue #106): the admission surface, measured. The counters
    // are the high-water the scheduler held; the cap is the one it judged
    // against. The tree line is the same snapshot in the §49.1 shape.
    `parallel: running ${parallel.running} queued ${parallel.queued} cap ${parallel.maxConcurrency}`,
    `tree: ${buildParallelTreeLine({
      sessionId,
      running: parallel.running,
      queued: parallel.queued,
      maxConcurrency: parallel.maxConcurrency,
    })}`,
    // §44.1 retained-worktree status (issue #106) — after the run, one line
    // per retained worktree, dirty ones naming their files.
    ...retainedLines,
    `${theme.success('result:')} orchestrated ${state.records.length} worker(s), merged ${state.merged.length}`,
  ];
  return emit(
    {
      ok: true,
      exitCode: RUN_EXIT_OK,
      sessionId,
      status: 'completed',
      workers: state.records.map((record) => ({
        agentId: record.agentId,
        branch: record.branch,
        hunks: record.hunks.length,
      })),
      mergeOrder: [...state.merged],
      attribution,
      graph: delegationGraphLines(sessionId, state.agents),
      parallel,
      // Only present when a status reader is wired: an empty array would
      // claim "no worktree was retained", which is not what happened.
      ...(deps.worktreeStatus === undefined ? {} : { retained }),
    },
    textLines,
  );
}
