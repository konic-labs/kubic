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
import { answerHelp } from '../../core/src/cli-help.js';
import type {
  WorkerApprovalScope,
  WorkerApprovalsRun,
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
import { createMergeQueue } from './orchestrator/merge/queue.js';
import { assertManagerZeroWrites } from './orchestrator/merge/settle.js';
import { ParallelScheduler } from './orchestrator/parallel/scheduler.js';
import { validateAgentId } from './orchestrator/worktree/naming.js';
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

export const ORCHESTRATE_USAGE =
  'usage: kubic orchestrate -p <prompt> [--agents <a,b>] [--session <id>] [--resume] [--yes] [--budget <dims>] [--full-access] [--json]';

export function orchestrateUsage(out: (line: string) => void): number {
  out(ORCHESTRATE_USAGE);
  return RUN_EXIT_USAGE;
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
// the spawn cannot drift apart.
export interface WorkerSpawnInfo {
  sessionId: string;
  workerSessionId: string;
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

export interface OrchestrateCommandDeps {
  out: (line: string) => void;
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
  requestApproval?: (input: ApprovalInput) => boolean | Promise<boolean>;
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

function parseAgents(raw: string): string[] | undefined {
  const agents = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (agents.length === 0) return undefined;
  if (new Set(agents).size !== agents.length) return undefined;
  for (const agent of agents) {
    if (validateAgentId(agent).length > 0) return undefined;
  }
  return agents;
}

function parseArgs(args: string[]): ParsedArgs | undefined {
  const parsed: ParsedArgs = {
    agents: [...ORCHESTRATE_DEFAULT_AGENTS],
    resume: false,
    autoApprove: false,
    json: false,
    budgetsByAgent: {},
    fullAccess: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '-p' || arg === '--prompt') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) return undefined;
      parsed.prompt = value;
      i += 1;
    } else if (arg === '--agents') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) return undefined;
      const agents = parseAgents(value);
      if (agents === undefined) return undefined;
      parsed.agents = agents;
      i += 1;
    } else if (arg === '--session') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) return undefined;
      parsed.sessionId = value;
      i += 1;
    } else if (arg === '--resume') {
      parsed.resume = true;
    } else if (arg === '--yes') {
      parsed.autoApprove = true;
    } else if (arg === '--full-access') {
      // §41.4: the user's explicit per-session opt-in to skip approvals. The
      // posture stays session-scoped — this flag cannot make it global.
      parsed.fullAccess = true;
    } else if (arg === '--budget') {
      // §71 opt-in budget, per spawn. Opt-in means exactly that: no flag →
      // nothing configured → no limit applied. A malformed spec is refused
      // (usage), never silently dropped.
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) return undefined;
      const spec = parseBudgetSpec(value);
      if (spec === undefined) return undefined;
      parsed.budget = spec.shared;
      parsed.budgetsByAgent = spec.byAgent;
      i += 1;
    } else if (arg === '--json') {
      parsed.json = true;
    } else {
      return undefined;
    }
  }
  return parsed;
}

function statusForExit(exitCode: number, code: string): OrchestrateStatus {
  if (exitCode === RUN_EXIT_OK) return 'completed';
  if (exitCode === RUN_EXIT_USAGE) return 'usage';
  if (exitCode === RUN_EXIT_APPROVAL_DENIED) return 'approval_denied';
  if (code === 'merge_conflict') return 'merge_conflict';
  return 'failed';
}

export async function runOrchestrateCommand(
  args: string[],
  deps: OrchestrateCommandDeps,
): Promise<number> {
  // `--help`/`-h` is answered before argv parsing (issue #100).
  const help = answerHelp(args, deps.out, ORCHESTRATE_USAGE);
  if (help !== null) return help;
  const now = deps.now ?? Date.now;
  const debug = deps.debug ?? (() => undefined);
  const parsed = parseArgs(args);
  if (parsed === undefined) return orchestrateUsage(deps.out);
  if (parsed.resume && parsed.sessionId === undefined) {
    return orchestrateUsage(deps.out);
  }
  if (
    parsed.sessionId !== undefined &&
    !SESSION_ID_PATTERN.test(parsed.sessionId)
  ) {
    deps.out(
      `error: invalid --session id ${JSON.stringify(parsed.sessionId)} (use [A-Za-z0-9_-])`,
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
    if (parsed.json) {
      const status = statusForExit(RUN_EXIT_FAILED, 'manager_toolset_refused');
      deps.out(
        JSON.stringify({
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
    deps.out(`error: ${message} code=manager_toolset_refused`);
    return RUN_EXIT_FAILED;
  }

  const emit = (envelope: OrchestrateEnvelope, textLines: string[]): number => {
    if (parsed.json) {
      deps.out(JSON.stringify(envelope));
    } else {
      for (const line of textLines) deps.out(line);
      if (envelope.error !== undefined) {
        deps.out(
          `error: ${envelope.error.message} code=${envelope.error.code}`,
        );
      }
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
      [`session: ${sessionId}`],
    );
  };

  if (parsed.prompt === undefined && !parsed.resume) {
    return orchestrateUsage(deps.out);
  }
  if (!(await deps.isGitRepo())) {
    deps.out(
      'error: orchestrator mode needs a git repository — run solo here (`kubic run -p <prompt>`) or retry inside a git checkout (orchestrator never falls back to solo)',
    );
    if (parsed.json) {
      return fail(RUN_EXIT_USAGE, 'not_a_repo', 'not a git repository');
    }
    deps.out(ORCHESTRATE_USAGE);
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
      plan: buildManagerPlan(parsed.prompt as string, parsed.agents),
    };
  }
  const prompt = parsed.prompt ?? state.prompt;
  // The manager's plan (issue #103): one step per worker, each carrying that
  // worker's prompt. A resumed state written before #103 (or by a caller
  // that dropped it) re-derives the plan from the stored objective and agent
  // list, so --resume replays per-worker prompts either way — never the
  // shared `-p` text.
  if (state.plan === undefined) {
    state = { ...state, plan: buildManagerPlan(prompt, state.agents) };
  }
  const plan = state.plan as ManagerPlanStep[];
  const promptForWorker = (agentId: string): string => {
    const step = planStepFor(plan, agentId);
    return step === undefined ? prompt : step.prompt;
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
  const scheduler = new ParallelScheduler();
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
    ...(parsed.fullAccess ? { fullAccess: true } : {}),
  });
  const budgetForAgent = (agentId: string): unknown =>
    // A per-agent spec is the budget for THAT spawn: it replaces the shared
    // spec for the named worker only, and never widens it.
    parsed.budgetsByAgent[agentId] ?? parsed.budget;
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

  // Settle FIFO: approve → persist the write-ahead merge intent →
  // pre-merge guard → prove the manager trace write-free → merge →
  // attribute → record. Each merge is atomic per candidate and recorded
  // before the next dequeues, so a kill between merges resumes cleanly.
  let candidate = queue.dequeue();
  while (candidate !== undefined) {
    const { agentId } = candidate;
    const worktree = worktrees.get(agentId) as OrchestrateWorktree;
    const approved = parsed.autoApprove
      ? true
      : await deps.requestApproval?.({ agentId, branch: worktree.branch });
    if (approved !== true) {
      const saveFailure = await saveOrFail(state);
      if (saveFailure !== undefined) {
        await reapSpawned(spawned);
        return saveFailure;
      }
      await reapSpawned(spawned);
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
    try {
      // Pre-merge guard (fix a): a kill-during-merge can leave a stale
      // MERGE_HEAD behind — abort it and refuse a dirty tree BEFORE the
      // merge runs, so resume never merges onto a half-merged tree.
      await deps.prepareMerge?.(agentId, worktree);
      // The trace holds the merge plumbing plus the lane's own recorded
      // delegation calls (issue #103) — the manager's real call record over
      // this run. A tainted trace throws and the merge never runs.
      assertWrites(managerCallsForMerge(laneCalls));
      await deps.mergeBranch(agentId, worktree);
    } catch (error) {
      if (error instanceof MergeConflictError) {
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
        return fail(
          RUN_EXIT_FAILED,
          'merge_conflict',
          `merge conflict for worker '${agentId}': unresolvable automatically — queue stopped, candidates preserved`,
          partial(),
        );
      }
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
  const perAgent = state.records
    .map((record) => `${record.agentId}=${record.hunks.length} hunk(s)`)
    .join(', ');
  const textLines = [
    `session: ${sessionId}`,
    ...state.records.map(
      (record) =>
        `worker: ${record.agentId} branch=${record.branch} hunks=${record.hunks.length}`,
    ),
    `merge order: ${state.merged.join(' -> ')}`,
    `attribution: ${perAgent}`,
    ...state.merged.map((agentId) => `merged: ${agentId}`),
    ...spawned.map((agentId) => `reaped: ${agentId}`),
    // §54: the delegation shape, one line per node/edge of the run's DAG.
    ...delegationGraphLines(sessionId, state.agents).map(
      (line) => `dag: ${line}`,
    ),
    `result: orchestrated ${state.records.length} worker(s), merged ${state.merged.length}`,
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
    },
    textLines,
  );
}
