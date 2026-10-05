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
  BUDGET_DIMENSIONS,
  type RunMode,
  resolveBlockedSpawn,
  resolveRunMode,
} from '../../agents/src/budget.js';
import {
  addEdge,
  addNode,
  createGraph,
  renderDag,
} from '../../agents/src/graph.js';
import type { PermissionClasses } from '../../agents/src/policy.js';
import { createLineLogger } from '../../core/src/cli/logger.js';
import { formatJson } from '../../core/src/cli/output.js';
import { type CliTheme, createCliTheme } from '../../core/src/cli/theme.js';
import type { SessionHandle } from '../../worker/src/lane/session-store.js';
import type { MutableModels } from '../../worker/src/pi-boundary.js';
import { BACKGROUND_CONTEXT } from '../../worker/src/pi-boundary.js';
import type {
  AgentResult,
  ResultErrorKind,
  ResultStatus,
} from '../../worker/src/result.js';
import {
  buildAgentResult,
  UNRESOLVED_MODEL,
  validateAgentResult,
} from '../../worker/src/result.js';
// §36.3 provider-credential scoping (issue #200): the run's pre-state check
// names a provider and fails closed before any worktree exists. Host-local
// contract (the composition root resolves the grants); host never spawns.
import type {
  WorkerCredentialRefusal,
  WorkerCredentialRequest,
} from './config/role-credentials.js';
// The shared `provider/model` split (issue #206 review): one parser, never a
// second copy that can drift from the credential plan's.
import { providerOfModelRef } from './config/role-credentials.js';
import { BUDGET_EXHAUSTED } from './orchestrator/approvals/budgets.js';
import {
  APPROVAL_TIMEOUT_CODE,
  type WorkerApprovalScope,
  type WorkerApprovalsRun,
  type WorkerApprovalTermination,
} from './orchestrator/approvals/worker-asks.js';
import {
  QUESTION_UNANSWERED_CODE,
  type WorkerQuestionOutcome,
} from './orchestrator/approvals/worker-questions.js';
import {
  BUDGET_DIMENSIONS,
  isModelRef,
  storedBudgetDims,
} from './orchestrator/budget-spec.js';
import type { ManagerLane, ManagerPlanStep } from './orchestrator/manager.js';
import {
  buildManagerPlan,
  createManagerCallSpy,
  planStepFor,
  recordManagerLaneCall,
  registerManagerLane,
} from './orchestrator/manager.js';
import {
  assertGitRef,
  describeLaneTransportError,
  LANE_PROVIDER_UNREACHABLE_CODE,
  LaneDriveTimeoutError,
  MANAGER_DRIVE_DEADLINE_MS,
  MANAGER_MAX_SUBMISSIONS,
  MANAGER_MAX_TOOL_CALLS,
  MANAGER_TURN_BOUND_CODE,
  managerFinalMessage,
  waitLaneSubmissionWithDeadline,
  withAskTimeout,
  withManagerToolCallBound,
} from './orchestrator/manager-drive.js';
import {
  bootManagerLane,
  type ManagerLaneHandle,
} from './orchestrator/manager-lane.js';
import {
  buildManagerTools,
  ManagerToolRefusalError,
  type ManagerToolsDeps,
  managerCallsFromLane,
  managerToolRegistrations,
  type WorkerChange,
  type WorkerRowInfo,
  type WorkerSpawnRequest,
} from './orchestrator/manager-tools.js';
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
import {
  applySettlementAfterReview,
  assertManagerZeroWrites,
} from './orchestrator/merge/settle.js';
import type {
  MergeOutcome,
  MergeTelemetry,
} from './orchestrator/merge/telemetry.js';
import {
  recordMergeTelemetry,
  totalMergeMs,
} from './orchestrator/merge/telemetry.js';
import {
  type BudgetGate,
  sanitizeReasonField,
  type UsageTally,
} from './orchestrator/parallel/limits.js';
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
import {
  BUILTIN_ROLE_NAMES,
  isBuiltinRole,
  ROLE_THINKING_DEFAULTS,
} from './roles/roles-data.js';
import {
  applyRolesToPlan,
  composeWorkerPrompt,
  roleBudgetForAgent,
  type WorkerRolesPlan,
  workerRoleAssignment,
} from './roles/worker-roles.js';
import {
  MAX_RUN_TIMEOUT_MS,
  RUN_EXIT_APPROVAL_DENIED,
  RUN_EXIT_FAILED,
  RUN_EXIT_OK,
  RUN_EXIT_PARTIAL_FAILURE,
  RUN_EXIT_PROVIDER_PROBE_FAILED,
  RUN_EXIT_USAGE,
  RUN_EXIT_WORKSPACE_UNAVAILABLE,
  SESSION_ID_PATTERN,
} from './run-cli.js';
import type { WorkerListRow } from './workers-cli.js';

// The §36.3 credential contracts the preflight dep speaks (issue #200),
// re-exported so composition roots and tests import one module.
export type {
  WorkerCredentialRefusal,
  WorkerCredentialRequest,
} from './config/role-credentials.js';

export const ORCHESTRATE_DEFAULT_AGENTS: string[] = ['worker-1', 'worker-2'];

// The bounded wait for a per-worker approval ask (issue #105, §41.2). A fixed
// run-level contract rather than a caller knob: an ask that no seat can answer
// must deny closed on a human timescale, never hang the run headless.
export const ORCHESTRATE_APPROVAL_BOUND_MS = 60_000;

// The bound a worker CHILD waits for the manager's answer (issue #230): kept
// strictly BELOW the manager's own bound, so the child denies closed with its
// named status before the run that would answer it gives up. The margin is a
// tenth of the bound, capped at 5 s; a 1 ms manager bound leaves 1 ms.
export function workerApprovalBoundMs(managerBoundMs: number): number {
  const margin = Math.min(5_000, Math.floor(managerBoundMs / 10));
  return Math.max(1, managerBoundMs - Math.max(1, margin));
}

// The parsed `kubic orchestrate` options, as the commander program
// (apps/kubic/src/commands/orchestrator.ts) hands them over: argv syntax,
// `--help`, unknown flags, and malformed `--agents` / `--budget` /
// `--session` values are refused there (exit 2) before this runs — the
// value parsers below (`parseAgentBindings`, `parseBudgetSpec`) are the ones
// it calls. The cross-option rules (`-p` unless `--resume`, `--resume`
// needs `--session`) stay here, with the run.
export interface OrchestrateCliOptions {
  readonly prompt?: string;
  /**
   * The `--agents` entries as typed (issue #178): each is
   * `<id>[:<role>[:<provider/id>]]`. `parseAgentBindings` turns them into
   * the worker ids and the explicit role/model binding, and validates them
   * (a malformed entry or an unknown role is a usage error, exit 2).
   */
  readonly agents?: readonly string[];
  readonly session?: string;
  readonly resume?: boolean;
  readonly yes?: boolean;
  // Explicit autonomous mode (issue #278, §19): off by default, recorded
  // in session metadata and the §60 audit trail, driving RunMode.
  readonly autonomous?: boolean;
  readonly budget?: ParsedBudgetSpec;
  readonly fullAccess?: boolean;
  readonly json?: boolean;
  // The per-session admission override (issue #206, §45): `--concurrency
  // <n>` caps how many workers run at once for THIS run, above an explicit
  // limits cap and the configured `[orchestrator].maxWorkers` default. The
  // composition root installs it as the scheduler's session override (the
  // admission layer is built there, so the run never builds a second one).
  readonly concurrency?: number;
  // What a worker's failure does to the RUN (issue #169, §9.2): `stop` (the
  // default) keeps the all-or-nothing terminus; `continue` keeps the pending
  // workers running, merges the ones that succeeded and exits 7 with every
  // failed worker named. Always `stop` for an approval terminus — a denial is
  // the user's decision for the whole run, never a worker-local hiccup.
  readonly onFailure?: 'stop' | 'continue';
  /**
   * `--manager-lane` (issue #431, L-D34): opt the run into the
   * model-driven manager lane. Absent means the deterministic template
   * plan — the flag is the headless opt-in, never a default.
   */
  readonly managerLane?: boolean;
  /**
   * `--skill <path>` (repeatable, issue #170): skills every worker AND the
   * resolver are granted. Relative values are resolved against the manager's
   * cwd by the run (a child runs in its own worktree), so the value here is
   * whatever the operator typed.
   */
  readonly skills?: readonly string[];
}

/**
 * Explicit per-agent role/model binding (issue #178, §9.2/§38.1): the role
 * each worker runs (one of the five §12 presets) and an optional
 * `provider/id` pin, keyed by agent id. Empty records mean no binding was
 * given, so the loader's own default applies.
 */
export interface WorkerRoleBinding {
  roles: Record<string, string>;
  models: Record<string, string>;
}

export type AgentBindingsParse =
  | {
      ok: true;
      /** The entries as typed, suffixes intact (the option value shape). */
      entries: string[];
      /** The worker ids, in order — one worktree per id. */
      ids: string[];
      binding: WorkerRoleBinding;
    }
  | { ok: false; reason: string };

// Re-exported for existing importers (issue #207 moved them to a leaf module).
export { BUDGET_DIMENSIONS, isModelRef, storedBudgetDims };

// `--agents <id>[:<role>[:<provider/id>]]` (issue #178): comma-separated
// workers, each optionally bound to one of the five §12 roles and to an
// explicit model pin. Parsed and validated BEFORE anything spawns — an
// unknown role is a usage error (exit 2), never a mid-run refusal. Accepts
// the raw option string or an already-split entry list (the run's own
// programmatic callers), so both share one rule set.
export function parseAgentBindings(
  raw: string | readonly string[],
): AgentBindingsParse {
  const entries = (typeof raw === 'string' ? raw.split(',') : [...raw])
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (entries.length === 0) {
    return { ok: false, reason: 'Name at least one worker id.' };
  }
  const ids: string[] = [];
  // Null-prototype maps: an agent id is `[A-Za-z0-9_-]+`, so `__proto__` is
  // a legal id — assigning it on a plain object would set the prototype and
  // silently drop the binding (review finding, #178).
  const roles: Record<string, string> = Object.create(null);
  const models: Record<string, string> = Object.create(null);
  for (const entry of entries) {
    const parts = entry.split(':').map((part) => part.trim());
    if (parts.length > 3 || parts.some((part) => part === '')) {
      return {
        ok: false,
        reason: `Use <id>[:<role>[:<provider/id>]] (got ${JSON.stringify(entry)}).`,
      };
    }
    const [id = '', role, model] = parts;
    const invalid = validateAgentId(id);
    if (invalid.length > 0) {
      return {
        ok: false,
        reason: `Worker id ${JSON.stringify(id)}: ${invalid.join('; ')}.`,
      };
    }
    if (ids.includes(id)) {
      return {
        ok: false,
        reason: `Worker id ${JSON.stringify(id)} is named twice (one worktree per writer).`,
      };
    }
    if (role !== undefined && !isBuiltinRole(role)) {
      return {
        ok: false,
        reason: `Unknown role ${JSON.stringify(role)} (one of ${BUILTIN_ROLE_NAMES.join(', ')}).`,
      };
    }
    if (model !== undefined && !isModelRef(model)) {
      return {
        ok: false,
        reason: `Model pin ${JSON.stringify(model)} must be 'provider/id'.`,
      };
    }
    ids.push(id);
    if (role !== undefined) roles[id] = role;
    if (model !== undefined) models[id] = model;
  }
  return { ok: true, entries, ids, binding: { roles, models } };
}

// A stored binding's structural check (issue #178): the keys must name
// workers of the run, a role must be one of the five, a model must be
// `provider/id`. Undefined means the record is malformed — the state is
// refused rather than half-read.
function parseStoredBinding(
  raw: unknown,
  agents: readonly string[],
  kind: 'roles' | 'models',
): Record<string, string> | undefined {
  // An array is an object too, but never a record of agent ids.
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  // Null-prototype, like the parser: a stored `__proto__` key must stay an
  // own key, never become the record's prototype.
  const out: Record<string, string> = Object.create(null);
  for (const [agent, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string') return undefined;
    if (!agents.includes(agent)) return undefined;
    if (kind === 'roles' && !isBuiltinRole(value)) return undefined;
    if (kind === 'models' && !isModelRef(value)) return undefined;
    out[agent] = value;
  }
  return out;
}

function bindingIsEmpty(binding: WorkerRoleBinding): boolean {
  return (
    Object.keys(binding.roles).length === 0 &&
    Object.keys(binding.models).length === 0
  );
}

function bindingsEqual(a: WorkerRoleBinding, b: WorkerRoleBinding): boolean {
  const same = (left: Record<string, string>, right: Record<string, string>) =>
    JSON.stringify(Object.entries(left).sort()) ===
    JSON.stringify(Object.entries(right).sort());
  return same(a.roles, b.roles) && same(a.models, b.models);
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
  // The branch tip sha at settle (issue #429): resume compares it against
  // the current tip and refuses a completion recorded before a same-name
  // rewrite. Absent on state written before #429 (unknown, not a refusal).
  // The worker's §68 result (issue #185): status, summary, provenance and
  // metrics — persisted with the run so resume, handoff and replay can read
  // what each worker did and cost. Absent on state written before #185.
  result?: AgentResult;
  tipSha?: string;
}

// What a worker run hands back (issue #185): the hunks it produced plus its
// validated §68 result. A bare hunk list is still accepted (older seams and
// fakes) and simply carries no result.
export interface WorkerRunOutput {
  hunks: MergedHunk[];
  result?: AgentResult;
  /**
   * §61 (issue #158): how long the worker's own branch-diff read took. The
   * production seam measures it; a legacy seam that omits it contributes 0 ms
   * to the merge telemetry's diff leg.
   */
  diffMs?: number;
}

function runOutputOf(output: MergedHunk[] | WorkerRunOutput): WorkerRunOutput {
  return Array.isArray(output) ? { hunks: output } : output;
}

// The per-worker view the envelope and the text line carry (issue #185).
export interface WorkerResultView {
  role: string;
  status: string;
  summary: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    toolCalls: number;
    wallMs: number;
    costUsd?: number;
  };
  provenance: AgentResult['provenance'];
  error?: AgentResult['error'];
}

export function workerResultView(result: AgentResult): WorkerResultView {
  return {
    role: result.provenance.role ?? 'worker',
    status: result.status,
    summary: result.summary,
    usage: {
      inputTokens: result.metrics.inputTokens,
      outputTokens: result.metrics.outputTokens,
      cachedTokens: result.metrics.cachedTokens,
      toolCalls: result.metrics.toolCalls,
      wallMs: result.metrics.wallMs,
      ...(result.metrics.costUsd === undefined
        ? {}
        : { costUsd: result.metrics.costUsd }),
    },
    provenance: result.provenance,
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

// One human line per worker: `<agent> (<role>): <summary>`.
export function workerSummaryLine(
  agentId: string,
  result: AgentResult,
): string {
  // The summary is untrusted model text drawn on the operator's terminal: an
  // ESC / CR / C1 control in it could clear or repaint the screen or
  // overwrite this line from column 0. The same strip set the scheduler's
  // reasons and the retained-file lines use, applied to what is DRAWN — so
  // the 200-character budget counts visible characters.
  const firstLine = sanitizeReasonField(
    result.summary.split('\n')[0] ?? '',
  ).trim();
  const summary =
    firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine;
  return `${agentId} (${sanitizeReasonField(result.provenance.role ?? 'worker')}): ${summary}`;
}

export interface OrchestratorRunState {
  version: 1;
  sessionId: string;
  prompt: string;
  agents: string[];
  // Explicit per-agent role/model binding (issue #178), persisted so
  // --resume replays the assignment the run was launched with instead of
  // re-deriving a default. Absent when the run carried no binding.
  roles?: Record<string, string>;
  models?: Record<string, string>;
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
  // The opt-in budget this run started with (issue #208, §71): persisted so
  // --resume re-applies exactly the spec the run was launched under instead
  // of re-deriving (or dropping) it. A state written before #208 has none,
  // and a resume may then supply one.
  budget?: ParsedBudgetSpec;
  // The `--skill` grants this run started with (issue #170): persisted for
  // the same reason — a resume with no flags must not silently retry the
  // pending workers without the skills the run was launched with. A state
  // written before #170 has none, and a resume may then supply them.
  skills?: string[];
  // The worker-failure policy this run started with (issue #169 review):
  // persisted so `--on-failure continue` survives a kill + `--resume`
  // instead of silently reverting to all-or-nothing. A state written before
  // the policy existed has none, and `stop` is the default it implies.
  onFailure?: 'stop' | 'continue';
  // The spawn CAP this run started with (issue #413): the `--agents` entry
  // count on a fresh run. A model-driven manager lane may spawn at most
  // this many workers; the template path spawns exactly the listed agents,
  // so the cap never binds there. A state written before #413 has none,
  // and the resume path adopts the stored agent count.
  spawnCap?: number;
  // The lane drove this run (issue #431, step 7 of the #204 split): the
  // manager lane (not the template plan) spawned the workers, so a
  // `--resume` re-attaches the manager session and continues the lane —
  // never re-plans silently. Absent means the template path owns the run.
  laneDriven?: true;
  // The manager conversation's session (issue #431): the run's own id —
  // the manager session IS the ancestry tree's root (#164). Present only
  // with laneDriven.
  managerSessionId?: string;
  // The manager's final message (issue #431): its last transcript text,
  // carried for the #418 envelope. Absent until the lane finishes.
  managerSummary?: string;
  // Write-ahead worker completions (issue #160): one entry per worker that
  // settled successfully but is not merged yet — branch + hunks (+ the §68
  // result when the worker reported one). Persisted as soon as the worker
  // settles, BEFORE the merge gate runs, so an approval deny/timeout, a
  // failed merge or a kill never loses the work: --resume skips re-running
  // a completed worker whose worktree branch still matches and enqueues it
  // for merge instead. `records` keeps meaning "merged"; a merge success
  // moves the entry there. A state written before #160 has none.
  completed?: OrchestratedWorkerRecord[];
}

// One stored per-worker record, merged or merely completed (issue #160):
// agent + branch + hunks (+ an optional validated §68 result). Stored state
// is untrusted JSON, so anything else fails closed.
function validStoredWorkerRecord(record: unknown): boolean {
  if (typeof record !== 'object' || record === null) return false;
  const entry = record as Record<string, unknown>;
  if (typeof entry.agentId !== 'string') return false;
  if (typeof entry.branch !== 'string') return false;
  if (!Array.isArray(entry.hunks)) return false;
  // Review #429: the tip rides a debug line on resume, so anything but
  // lowercase hex fails the state closed — a hand-crafted rows file cannot
  // smuggle newlines/control chars into the log. Real tips are always hex
  // (`rev-parse HEAD`); a non-hex tip means a crafted state, never a
  // legacy one (pre-#429 states simply omit the field).
  if (
    entry.tipSha !== undefined &&
    (typeof entry.tipSha !== 'string' || !/^[0-9a-f]+$/.test(entry.tipSha))
  ) {
    return false;
  }
  if (entry.result !== undefined && !validateAgentResult(entry.result).valid) {
    return false;
  }
  for (const hunk of entry.hunks) {
    if (typeof hunk !== 'object' || hunk === null) return false;
    const part = hunk as Record<string, unknown>;
    if (typeof part.path !== 'string') return false;
    if (typeof part.hunk !== 'string') return false;
  }
  return true;
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
  const agents = value.agents as string[];
  // Explicit per-agent binding (issue #178): a record whose keys do not name
  // this run's workers, whose role is outside the five, or whose model is
  // not `provider/id` is refused, never half-applied.
  let roles: Record<string, string> | undefined;
  if (value.roles !== undefined) {
    roles = parseStoredBinding(value.roles, agents, 'roles');
    if (roles === undefined) return undefined;
  }
  let models: Record<string, string> | undefined;
  if (value.models !== undefined) {
    models = parseStoredBinding(value.models, agents, 'models');
    if (models === undefined) return undefined;
  }
  if (value.skills !== undefined) {
    if (
      !Array.isArray(value.skills) ||
      value.skills.length === 0 ||
      value.skills.some(
        (entry) => typeof entry !== 'string' || entry.trim() === '',
      )
    ) {
      return undefined;
    }
  }
  if (value.budget !== undefined) {
    const budget = parseStoredBudgetSpec(value.budget);
    if (budget === undefined) return undefined;
    // A per-agent clause for a worker this run never spawns would look
    // configured while enforcing nothing (issue #208).
    for (const agent of Object.keys(budget.byAgent)) {
      if (!agents.includes(agent)) return undefined;
    }
  }
  if (typeof value.stopped !== 'boolean') return undefined;
  if (
    value.onFailure !== undefined &&
    value.onFailure !== 'stop' &&
    value.onFailure !== 'continue'
  ) {
    return undefined;
  }
  // The spawn cap (issue #413): a non-negative integer when present —
  // anything else is a torn or hand-edited state and fails closed.
  if (value.spawnCap !== undefined) {
    if (
      typeof value.spawnCap !== 'number' ||
      !Number.isSafeInteger(value.spawnCap) ||
      value.spawnCap < 0
    ) {
      return undefined;
    }
  }
  if (!Array.isArray(value.records)) return undefined;
  for (const record of value.records) {
    if (!validStoredWorkerRecord(record)) return undefined;
  }
  // Write-ahead completions (issue #160) ride the same shape: anything
  // that is not exactly a list of per-worker records fails closed here.
  if (value.completed !== undefined) {
    if (!Array.isArray(value.completed)) return undefined;
    for (const record of value.completed) {
      if (!validStoredWorkerRecord(record)) return undefined;
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
  // The lane-driving marks (issue #431): strictly shaped or refused — a
  // laneDriven flag without its session, or a non-string summary, is not
  // a state --resume may continue.
  if (value.laneDriven !== undefined && value.laneDriven !== true) {
    return undefined;
  }
  if (
    value.managerSessionId !== undefined &&
    (typeof value.managerSessionId !== 'string' ||
      value.managerSessionId.trim() === '')
  ) {
    return undefined;
  }
  if (
    value.managerSummary !== undefined &&
    typeof value.managerSummary !== 'string'
  ) {
    return undefined;
  }
  if (value.laneDriven === true && value.managerSessionId === undefined) {
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

// What the run tells the worktree seam (issue #144): the owning session
// scopes the names, and `resume` is the only licence to reuse a tree that
// already exists under them.
export interface WorktreeRequest {
  sessionId: string;
  resume: boolean;
}

// A fresh run that finds its own session-scoped worktree already on disk is
// refused with this named code, never silently reused (issue #144).
export const WORKTREE_EXISTS_CODE = 'worktree_exists';

// §68 provenance needs a non-empty worktree; a worker that failed before a
// worktree was handed to it names this instead of inventing a path
// (issue #185).
const NO_WORKTREE = '(no worktree)';

function worktreeFailureCode(error: unknown): string {
  return typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === WORKTREE_EXISTS_CODE
    ? WORKTREE_EXISTS_CODE
    : 'spawn_failed';
}

// Worker-session naming (issue #85): one session per (orchestrator session,
// agent), so a worker's journals/usage/trajectory resolve inside its own
// worktree. The id must satisfy SESSION_ID_PATTERN — the child refuses
// anything else with exit 2 before it can attach.
export function workerSessionFor(sessionId: string, agentId: string): string {
  return `${sessionId}-${agentId}`;
}

/** The lane merge cursor: names each staged head exactly once. */
export interface MergeHeadCursor {
  /** The next staged head, advancing past it; undefined when drained. */
  nextHead(): string | undefined;
}

/**
 * A cursor over the router's live staged list (issue #431 review): the
 * router's `applyStaged` peeked `stagedForMerge[0]` without consuming,
 * so consecutive `workspace_merge` calls re-reported the same head as
 * 'merged'. Each call now advances past the head it names; stages that
 * land later stay reachable because the list is read live.
 */
export function createMergeHeadCursor(
  staged: readonly string[],
): MergeHeadCursor {
  let index = 0;
  return {
    nextHead: () => {
      const head = staged[index];
      if (head === undefined) return undefined;
      index += 1;
      return head;
    },
  };
}

// What the manager must do before spawning a worker (issue #85): `kubic run
// --session <id>` only ATTACHES, so the manager creates the session with an
// explicit id first. The spawn then happens with the same id.
export interface WorkerSessionRequest {
  sessionId: string;
  agentId: string;
  workerSessionId: string;
  worktree: OrchestrateWorktree;
  // Issue #164 (§23): the role the worker spawns as, recorded on the
  // worker session beside the parent linkage. Absent means unassigned.
  role?: string;
  // Issue #278 (§19): the run's mode, recorded on the manager and worker
  // session records.
  mode: RunMode;
}

// The id the child attaches to, handed to runWorker so the create step and
// the spawn cannot drift apart. Issue #104 adds the worker's assigned role
// and the role's resolved tool set + model pin: what the lane registers is
// the role's own set (§12.1/§40 — absence, not approval, withholds a tool),
// and the model default travels through the existing model pin.
export interface WorkerSpawnInfo {
  sessionId: string;
  workerSessionId: string;
  /**
   * §61 (issue #158): how long THIS run's worktree creation took, measured by
   * the host around the `ensureWorktree` call — the launch sample reports the
   * creation leg only, never the time between creation and launch.
   */
  worktreeMs?: number;
  role?: string;
  tools?: string[];
  modelRef?: string;
  /** §38.1 (issue #202): the thinking level this worker's child is told. */
  thinking?: string;
  /** §67 task resources (issue #170): the `--skill` values this worker gets. */
  skills?: string[];
  /**
   * Issue #196 (§40.2/§41.1): the assigned role's resolved classes and
   * approval obligations — the spawn writes them into the task resources
   * (the child merges the classes with its own config, most restrictive
   * wins). Absent when the worker has no role assignment.
   */
  classes?: PermissionClasses;
  requires?: string[];
  /**
   * Issue #198 (§71, #431 follow-up): the assigned role document's own
   * budget dims, when it declares any — the fallback tier under an
   * explicit spawn budget. Carried for lane mints exactly like
   * classes/requires so the per-spawn gate enforces them.
   */
  budget?: Record<string, number>;
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

// One run's start, as the §60 ledger records it (issue #278, §19): the
// §19 mode the run resolved, the command that started it and whether
// `--autonomous` was explicit.
export interface RunStartRecord {
  sessionId: string;
  command: 'orchestrate';
  mode: 'orchestrator';
  runMode: RunMode;
  workspace: string;
  posture: string;
  autonomous: boolean;
}

// One settled merge-gate decision, as the §60 ledger records it (issue
// #323). `by` is `--yes` for the run's standing answer and `user` for a
// decider's answer (or the deny-closed absence of one).
export interface MergeDecisionRecord {
  sessionId: string;
  agentId: string;
  branch: string;
  /** The worker worktree merged from (issue #284): named in the row. */
  worktree?: string;
  approved: boolean;
  by: '--yes' | 'user';
  reason?: string;
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
  // Issue #144: the run names the owning session and whether it is a
  // --resume, so the worktree is scoped to this session and an existing
  // one is reused ONLY when this run resumes that same session.
  ensureWorktree: (
    agentId: string,
    context?: WorktreeRequest,
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
  ) => MergedHunk[] | WorkerRunOutput | Promise<MergedHunk[] | WorkerRunOutput>;
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
  // Branch-tip probe (issue #429): the HEAD sha of the worker branch at
  // settle is persisted with the completion; on resume a different tip
  // means the branch was rewritten under the same name, so the stored
  // hunks must not merge against it. Optional so older fakes keep
  // working; absent (or throwing, or a state written before #429) means
  // unknown — resume reuses on branch match as before (#160), and a
  // positive mismatch is the only refusal.
  readBranchTip?: (
    agentId: string,
    worktree: OrchestrateWorktree,
  ) => string | undefined | Promise<string | undefined>;
  reapWorker: (agentId: string) => void | Promise<void>;
  // Fail-fast cancellation (issue #206): a worker still in flight when the
  // run stops — a sibling failed, or the admission layer refused a spawn —
  // is stopped through this seam before the run returns, so the manager
  // never exits leaving a child spending tokens behind it. Absent means the
  // run can only wait for the sibling to settle on its own bound; prod
  // always wires it (the lifecycle layer's reap, which kills the detached
  // process group first).
  cancelWorker?: (agentId: string) => void | Promise<void>;
  // §81 worker replacement (issue #175). Called when a worker failed with the
  // run-level failure code (exit 1) — never for a budget/approval/workspace/
  // provider terminus — and returns the generations the replacement spans
  // (`from` → `to`), or undefined when THIS worker is not replaceable (a
  // launch that never became ready, a missing lifecycle row). The run then
  // retries the worker in the SAME session and worktree through `runWorker`,
  // up to WORKER_REPLACEMENT_LIMIT times, and the failure message names the
  // generations when the retries are exhausted. Absent means no replacement —
  // the shipped behaviour for an embedder that does not wire the lifecycle
  // layer.
  replaceWorker?: (
    agentId: string,
  ) =>
    | { from: number; to: number }
    | undefined
    | Promise<{ from: number; to: number } | undefined>;
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
  loadWorkerRoles?: (
    agents: readonly string[],
    binding?: WorkerRoleBinding,
  ) => WorkerRolesPlan;
  // §36.3 worker provider credentials (issue #200): called ONCE, with every
  // pending worker's role and resolved model pin, BEFORE any state write,
  // worktree or session exists. Returning a refusal fails the run closed
  // with exit 6 and `code=credential_unavailable` naming the provider — a
  // worker that could not authenticate must never cost a worktree. Absent
  // (legacy callers/tests) means no preflight: the existing path is
  // unchanged, and the child's own provider probe still fails its run.
  preflightWorkerCredentials?: (
    requests: readonly WorkerCredentialRequest[],
  ) => WorkerCredentialRefusal | undefined;
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
  // The merge gate's §60 audit hook (issue #323). Called once per settled
  // merge decision; `by` tells a `--yes` standing answer apart from a user
  // who answered the prompt, so the ledger never records an inferred
  // approval as a user decision.
  auditMerge?: (record: MergeDecisionRecord) => void;
  // The run-start §60 audit hook (issue #278, §19). Called once per run,
  // before any worktree, session or child exists; the composition root
  // appends the run:start row. Absent means no run-start row (older fakes
  // keep working).
  auditRunStart?: (record: RunStartRecord) => void;
  // Whether a merge-gate refusal points the operator at `--yes` (default
  // true). A surface with no such flag — the TUI, whose merge asks go through
  // its own approval overlay — passes false so the message never names a flag
  // that does not exist there (issue #327).
  yesHint?: boolean;
  /**
   * Whether this run has a USER attached (a TTY, or the TUI's own overlay) —
   * issue #277; §41.1. An interactive run asks before spawning more workers
   * than the concurrency cap; a headless run (or one passing `--yes`) keeps
   * the autonomous queueing rule. Absent means headless.
   */
  interactive?: boolean;
  /**
   * The manager's own checkout (issue #277). A run-level ask belongs to no
   * worker worktree, so its §60 row names this path; absent falls back to the
   * process cwd.
   */
  repoRoot?: string;
  // Per-worker approvals + opt-in budgets (issue #105, §41.1/§41.2/§71).
  // The CLI owns the RUN OPTIONS (session, bound, budget, full-access) and the
  // composition root owns construction (its dir, its TTY seat, its debug
  // sink), so the host side declares only the factory it calls. Absent means
  // no approval layer: worker asks then never reach a user — which is exactly
  // the defect this issue fixes, so prod always supplies it.
  approvals?: (options: {
    sessionId: string;
    maxPendingMs: number;
    budget?: unknown;
    /** Per-spawn override: the budget for THAT worker's gate (§71). */
    budgetForAgent?: (agentId: string) => unknown;
    fullAccess?: boolean;
    /** A fresh (non-`--resume`) run: start with an empty approvals state, so
     *  an earlier run of the same id's full-access record is never inherited. */
    fresh?: boolean;
  }) => WorkerApprovalsRun;
  loadState?: (
    sessionId: string,
  ) =>
    | OrchestratorRunState
    | undefined
    | Promise<OrchestratorRunState | undefined>;
  saveState?: (state: OrchestratorRunState) => void | Promise<void>;
  /**
   * The model catalog for the manager lane (issue #431): the composition
   * root's assembled pi-ai models. Absent means no manager model can
   * resolve, so the run keeps the deterministic template path.
   */
  managerModels?: MutableModels;
  /**
   * The resolved manager model pin (issue #431): what the manager lane
   * boots on. Absent with managerModels means template, like a run with
   * no usable provider.
   */
  managerModel?: { provider: string; id: string };
  /**
   * Wall-clock bound for one lane drive (issue #431, L-D34 fail-fast):
   * unset means the shipped `MANAGER_DRIVE_DEADLINE_MS`. Tests inject a
   * small bound to watch a hung provider fail fast by name.
   */
  managerDriveDeadlineMs?: number;
  /**
   * The L-D34 opt-in (issue #431): true only when the operator asked for
   * the lane (`--manager-lane` or `[orchestrator] manager = "lane"`).
   * The lane never engages on a resolved model alone — a resolvable
   * provider without the opt-in keeps the deterministic template path.
   */
  managerLaneOptIn?: boolean;
  /**
   * Attach-or-create the manager conversation's session (issue #431):
   * the lane boots its harness over the adopted storage, and a `--resume`
   * re-attaches the same session so the model continues its transcript
   * instead of re-planning. A refusal fails the run by name.
   */
  openManagerSession?: (sessionId: string) => Promise<SessionHandle>;
  /**
   * The seat the manager's `ask_user` reaches (issue #431): interactive
   * presents on the run's TUI/terminal seat, headless denies closed. The
   * router races it against the ask bound, so a hanging seat resolves
   * unanswered instead of hanging the turn. Absent means no seat — every
   * ask resolves unanswered (fail-closed).
   */
  askUserSeat?: (question: string) => Promise<WorkerQuestionOutcome>;
  /**
   * Run one read-only git inspection over the op registry (issue #431):
   * the lane's `git_status`/`git_diff`/`git_log` adapters and the
   * `readWorkerChange` seam call through here. The builder wires the
   * real op calls; absent, the lane's git tools refuse by name.
   */
  inspectGit?: (
    tool: 'git_status' | 'git_diff' | 'git_log',
    args: unknown,
  ) => Promise<string>;
}

// The role an approval scope names for one worker (issue #159): the assigned
// §12 role when the plan has one, the shipped `worker` label otherwise. It is
// the FALLBACK for an ask whose own envelope carries no role (inputFromRequest
// prefers `request.role`), and it is exported so that fallback is pinned by a
// test instead of being unobservable behind a child that always sets one.
export function assignedApprovalRole(
  roles: WorkerRolesPlan,
  agentId: string,
): string {
  return workerRoleAssignment(roles, agentId)?.role ?? 'worker';
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
  | 'merge_conflict'
  | 'workspace_unavailable'
  // Some workers failed while the run continued (issue #169): the merge that
  // did land is reported, and the failed ones are named with their codes.
  | 'partial';

export interface OrchestrateEnvelope {
  ok: boolean;
  exitCode: number;
  sessionId: string;
  status: OrchestrateStatus;
  // The run's §19 mode (issue #278): explicit `--autonomous` or off by
  // default. The status already names the stop condition that ended it.
  mode: RunMode;
  // Issue #185: each worker that produced a §68 result also carries its
  // role, status, summary, usage and provenance (WorkerResultView).
  workers: ({
    agentId: string;
    branch: string;
    hunks: number;
  } & Partial<WorkerResultView>)[];
  mergeOrder: string[];
  attribution: AttributedHunk[];
  // The manager's final message (issue #418): present only on
  // lane-driven runs whose drive produced one — the text `result:` line
  // and this field report the same sentence, so the two surfaces cannot
  // disagree. Absent on the template path (the mechanical counts stand).
  managerSummary?: string;
  // The §54 delegation DAG of this run (§49.1 projection), rendered by
  // `delegationGraphLines`. Present on every envelope — a run that never
  // spawned still has a manager node, so the shape is stable for consumers.
  graph: string[];
  // The §49.1/§50 admission surface of this run (issue #106): the running and
  // queued counts the scheduler actually held, plus the cap they are measured
  // against. Reported AND a gate (issue #206): workers past the cap wait in
  // the scheduler's FIFO queue, so `queued` above zero means a slot was
  // genuinely occupied and a release woke the worker.
  parallel?: ParallelWorkersExtra;
  // §44.1 retained-worktree status (issue #106): one row per worktree the run
  // retained, with the measured dirtiness and the files that made it dirty.
  // Same lines as the text output, so the two surfaces cannot disagree.
  retained?: RetainedWorktreeRow[];
  error?: { kind: string; message: string; code: string };
  // §61 per-agent merge telemetry (issue #158): the phases the run measured
  // for each settled candidate — queue wait, the worker's own diff read, the
  // merge, the resolver's rework and the apply/bookkeeping leg. `totalMergeMs`
  // is their sum, and the text view prints one line per agent.
  mergeTelemetry?: MergeTelemetry[];
  // §78 reap_failed evidence (issue #171): every reap error the run collected
  // on a FAILURE path, where the primary terminus wins. A run that exits on
  // `reap_failed` itself carries the first error in `error`, and the rest
  // here. Absent when every reap succeeded.
  reapErrors?: { agentId: string; message: string }[];
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

// The bounded §81 replacement count (issue #175): a crash-class worker
// failure is retried ONCE. A second crash is the worker's terminus, named
// with both generations — a run that retried forever would spend the user's
// budget on a crash loop.
export const WORKER_REPLACEMENT_LIMIT = 1;

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
  // The explicit per-agent binding (issue #178) the `--agents` entries
  // carried; empty records mean none was given.
  binding: WorkerRoleBinding;
  sessionId?: string;
  resume: boolean;
  autoApprove: boolean;
  // Explicit autonomous mode (issue #278, §19): drives RunMode with the
  // shipped --yes/headless rule.
  autonomous: boolean;
  json: boolean;
  // Opt-in budgets (§71, issue #105): absent means NO budget is applied to a
  // spawn. Per-worker overrides arrive as --budget <agent>=<dims>; the shared
  // --budget <dims> applies to every worker of the run.
  budget?: Record<string, number>;
  budgetsByAgent: Record<string, Record<string, number>>;
  // The aggregate task budget (issue #207): `--budget total:<dims>` caps
  // spend across all workers of the task, mapped to the admission layer's
  // budgetGate. Threaded beside the per-spawn spec above.
  budgetTotal?: Record<string, number>;
  fullAccess: boolean;
  // This run's admission override (issue #206): absent means the scheduler's
  // own resolution (explicit limits cap > configured maxWorkers > 4) stands.
  concurrency?: number;
  // This run's worker-failure policy (issue #169), when the flag was given.
  // Absent means the stored policy (on --resume) or the shipped `stop`.
  onFailure?: 'stop' | 'continue';
  // `--skill` values (issue #170), as typed: the run resolves relative paths
  // against the manager's cwd before they reach a child.
  skills: string[];
}

// Session ids that would collide with the orchestrator dir's fixed entries
// (issue #174): `workers` IS `<repo>/.kubic/orchestrator/workers.json` —
// the lifecycle rows a run under that id would overwrite on its first
// save — and `approvals` IS the `approvals/` ledger directory. Reserved
// on fresh runs and resumes alike, before anything loads or saves.
export const RESERVED_SESSION_IDS: ReadonlySet<string> = new Set([
  'workers',
  'approvals',
]);

export interface ParsedBudgetSpec {
  shared?: Record<string, number>;
  /**
   * The aggregate task budget (issue #207): a `total:<dims>` clause caps
   * spend across ALL workers of the task (mapped to the admission layer's
   * budgetGate). `total` is a reserved keyword — it never names a worker,
   * so a per-agent clause for a worker literally named `total` is not
   * expressible (that worker still runs under the shared spec).
   */
  total?: Record<string, number>;
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
    // setTimeout's 32-bit ceiling (same rule as --timeout): a larger "bound"
    // would clamp to 1ms and the watchdog would fire, misreporting
    // limit=wallClock, almost immediately — refused at parse time, never
    // clamped.
    if (name === 'maxRuntimeMs' && value > MAX_RUN_TIMEOUT_MS) return undefined;
    dims[name] = value;
  }
  return Object.keys(dims).length === 0 ? undefined : dims;
}

export function parseBudgetSpec(raw: string): ParsedBudgetSpec | undefined {
  // Per-agent entries are `<agent>:<dims>` clauses separated by ';' so a
  // comma stays inside one agent's dimension list. The accumulator is
  // null-prototype (issue #208 review): `__proto__` is a legal agent id, and
  // on a plain {} accumulator it would set the prototype instead of an own
  // key, so the clause would vanish from Object.keys and the JSON state.
  const byAgent: Record<string, Record<string, number>> = Object.create(
    null,
  ) as Record<string, Record<string, number>>;
  let shared: Record<string, number> | undefined;
  // The aggregate task budget (issue #207): `total:<dims>` caps the whole
  // task. Claimed before the agent check below — `total` is reserved, never
  // a worker id — and merged across repeated clauses like the shared spec.
  let total: Record<string, number> | undefined;
  for (const clause of raw.split(';')) {
    const trimmed = clause.trim();
    if (trimmed.length === 0) continue;
    const colon = trimmed.indexOf(':');
    const head = colon > 0 ? trimmed.slice(0, colon).trim() : '';
    if (head === 'total') {
      const dims = parseBudgetDims(trimmed.slice(colon + 1));
      if (dims === undefined) return undefined;
      total = { ...(total ?? {}), ...dims };
      continue;
    }
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
  if (
    shared === undefined &&
    total === undefined &&
    Object.keys(byAgent).length === 0
  ) {
    return undefined;
  }
  return {
    ...(shared === undefined ? {} : { shared }),
    ...(total === undefined ? {} : { total }),
    byAgent,
  };
}

// The stored form of a ParsedBudgetSpec (OrchestratorRunState.budget). Unlike
// the flag parser this receives parsed JSON: anything that is not exactly a
// positive, known-dimension spec fails closed, so resume reports
// no_orchestrator_state instead of handing garbage to the budget layer.
export function parseStoredBudgetSpec(
  raw: unknown,
): ParsedBudgetSpec | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => key !== 'shared' && key !== 'total' && key !== 'byAgent',
    )
  ) {
    return undefined;
  }
  const shared = storedBudgetDims(record.shared);
  if (record.shared !== undefined && shared === undefined) return undefined;
  // The aggregate task budget travels with the state like the rest of the
  // spec (issue #207): a resume re-applies the stored gate, and a flag
  // naming a different aggregate is refused by budgetSpecsEqual below.
  const total =
    record.total === undefined ? undefined : storedBudgetDims(record.total);
  if (record.total !== undefined && total === undefined) return undefined;
  // Null-prototype for the same reason as parseBudgetSpec (issue #208
  // review): a stored `__proto__` clause must survive as data.
  const byAgent: Record<string, Record<string, number>> = Object.create(
    null,
  ) as Record<string, Record<string, number>>;
  if (record.byAgent !== undefined) {
    if (
      typeof record.byAgent !== 'object' ||
      record.byAgent === null ||
      Array.isArray(record.byAgent)
    ) {
      return undefined;
    }
    for (const [agent, dims] of Object.entries(
      record.byAgent as Record<string, unknown>,
    )) {
      if (validateAgentId(agent).length > 0) return undefined;
      const parsed = storedBudgetDims(dims);
      if (parsed === undefined) return undefined;
      byAgent[agent] = parsed;
    }
  }
  if (
    shared === undefined &&
    total === undefined &&
    Object.keys(byAgent).length === 0
  ) {
    return undefined;
  }
  return {
    ...(shared === undefined ? {} : { shared }),
    ...(total === undefined ? {} : { total }),
    byAgent,
  };
}

// Canonical equality for two parsed specs (issue #208): resume re-applies the
// STORED budget, so a flag that differs in any dimension — or names a
// different agent — is refused rather than silently mixed in.
export function budgetSpecsEqual(
  a: ParsedBudgetSpec,
  b: ParsedBudgetSpec,
): boolean {
  const dimsEqual = (
    x: Record<string, number>,
    y: Record<string, number>,
  ): boolean => {
    const xKeys = Object.keys(x).sort();
    const yKeys = Object.keys(y).sort();
    if (xKeys.length !== yKeys.length) return false;
    return xKeys.every(
      (key, index) => key === yKeys[index] && x[key] === y[key],
    );
  };
  const sharedEqual =
    a.shared === undefined || b.shared === undefined
      ? a.shared === undefined && b.shared === undefined
      : dimsEqual(a.shared, b.shared);
  if (!sharedEqual) return false;
  // The aggregate gate is part of the spec (issue #207): a resume flag
  // naming a different aggregate is refused, like any other difference.
  const totalEqual =
    a.total === undefined || b.total === undefined
      ? a.total === undefined && b.total === undefined
      : dimsEqual(a.total, b.total);
  if (!totalEqual) return false;
  const aAgents = Object.keys(a.byAgent).sort();
  const bAgents = Object.keys(b.byAgent).sort();
  if (aAgents.length !== bAgents.length) return false;
  return aAgents.every((agent, index) => {
    const other = bAgents[index] as string;
    return (
      agent === other &&
      dimsEqual(
        a.byAgent[agent] as Record<string, number>,
        b.byAgent[other] as Record<string, number>,
      )
    );
  });
}

// `--agents a,b`: comma-separated workers, each a valid agent id and unique
// (one worktree per writer) with an optional `:role[:provider/id]` binding.
// `parseAgentBindings` is the one parser; `validAgentSet` was its id-only
// predecessor and is gone with the syntax it validated.

function parsedFrom(options: OrchestrateCliOptions): ParsedArgs {
  const parsed = parseAgentBindings(
    options.agents ?? ORCHESTRATE_DEFAULT_AGENTS,
  );
  return {
    agents: parsed.ok ? parsed.ids : [],
    binding: parsed.ok ? parsed.binding : { roles: {}, models: {} },
    resume: options.resume === true,
    autoApprove: options.yes === true,
    autonomous: options.autonomous === true,
    json: options.json === true,
    // §71 opt-in budget, per spawn. Opt-in means exactly that: no flag →
    // nothing configured → no limit applied.
    ...(options.budget?.shared === undefined
      ? {}
      : { budget: options.budget.shared }),
    budgetsByAgent: options.budget?.byAgent ?? {},
    ...(options.budget?.total === undefined
      ? {}
      : { budgetTotal: options.budget.total }),
    fullAccess: options.fullAccess === true,
    skills: [...(options.skills ?? [])],
    ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
    ...(options.session === undefined ? {} : { sessionId: options.session }),
    ...(options.concurrency === undefined
      ? {}
      : { concurrency: options.concurrency }),
    ...(options.onFailure === undefined
      ? {}
      : { onFailure: options.onFailure }),
  };
}

function statusForExit(exitCode: number, code: string): OrchestrateStatus {
  if (exitCode === RUN_EXIT_OK) return 'completed';
  if (exitCode === RUN_EXIT_USAGE) return 'usage';
  // Issue #372: outside a git repository is workspace-unavailable (§78
  // code 5), its own terminus — never the usage code.
  if (exitCode === RUN_EXIT_WORKSPACE_UNAVAILABLE) {
    return 'workspace_unavailable';
  }
  // Exit 7 is one code, one terminus (issue #169): the run continued past a
  // worker failure and merged what it could.
  if (exitCode === RUN_EXIT_PARTIAL_FAILURE) return 'partial';
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

// The refused-config envelope (issue #244): the same shape a pre-lane
// failure emits — no session, no workers — so a `--json` consumer still
// parses exactly one document. The reason is the config refusal's own.
export function refusedOrchestrateEnvelope(
  message: string,
): OrchestrateEnvelope {
  return {
    ok: false,
    exitCode: RUN_EXIT_FAILED,
    sessionId: 'unassigned',
    status: 'failed',
    // Issue #278 (§19): the run never started, so no flag was ever
    // parsed — the §19 default (off) is the honest mode.
    mode: 'interactive',
    workers: [],
    mergeOrder: [],
    attribution: [],
    graph: [],
    error: { kind: 'failed', message, code: 'config_refused' },
  };
}

export async function runOrchestrateCommand(
  options: OrchestrateCliOptions,
  deps: OrchestrateCommandDeps,
): Promise<number> {
  const now = deps.now ?? Date.now;
  const debug = deps.debug ?? (() => undefined);
  const parsed = parsedFrom(options);
  // The run's §19 mode (issue #278): explicit `--autonomous` wins,
  // otherwise the shipped rule (`--yes` or headless is autonomous).
  // It drives the spawn-cap ask below; the admission layer keeps the
  // queueing rule past the gate (see the requestSpawn call).
  const runMode: RunMode = resolveRunMode({
    interactive: deps.interactive === true,
    autoApprove: parsed.autoApprove,
    autonomous: parsed.autonomous,
  });
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
  // the CLI's own --agents / --session checks. An unknown role in an entry is
  // the same usage error here (issue #178): nothing spawns, nothing is saved.
  if (options.agents !== undefined) {
    const parsedAgents = parseAgentBindings(options.agents);
    if (!parsedAgents.ok) {
      log.error(`invalid --agents: ${parsedAgents.reason}`);
      return RUN_EXIT_USAGE;
    }
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
          // Issue #278: this refusal bypasses emit, so it names the
          // §19 mode itself.
          mode: runMode,
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

  // Issue #278 (§19): every envelope names the run's §19 mode — injected
  // here so no exit path (usage refusals, pre-loop failures, the success
  // and partial termini) can emit a modeless envelope.
  const emit = (
    envelope: Omit<OrchestrateEnvelope, 'mode'>,
    textLines: string[],
  ): number => {
    const full: OrchestrateEnvelope = { ...envelope, mode: runMode };
    // stdout is data (the envelope, or the report lines); the failure
    // line is a diagnostic on stderr in both modes.
    if (parsed.json) {
      deps.out(formatJson(full));
    } else {
      for (const line of textLines) deps.out(line);
    }
    if (envelope.error !== undefined) {
      log.error(`${envelope.error.message} code=${envelope.error.code}`);
    }
    return envelope.exitCode;
  };
  const reapErrors: { agentId: string; message: string }[] = [];
  // §61 (issue #158): one record per candidate the merge loop measured.
  // Declared before the failure helpers: a pre-loop refusal (not-a-repo,
  // usage) reaches `fail()` too, and its envelope must still be buildable.
  const mergeTelemetry: MergeTelemetry[] = [];
  // §61 (issue #158): the measured merge phases, one line per candidate. Used
  // by the success view AND the failure envelope — a candidate whose gate
  // denied it, or whose merge threw, was measured too, and the operator reads
  // why it stopped instead of a row that vanished.
  const mergeTelemetryLines = (): string[] =>
    mergeTelemetry.map(
      (record) =>
        `merge telemetry: ${record.agentId} queue=${record.queueMs}ms diff=${record.diffMs}ms merge=${record.mergeMs}ms resolve=${record.resolveMs}ms apply=${record.applyMs}ms total=${totalMergeMs(record)}ms outcome=${record.outcome}`,
    );
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
        ...(reapErrors.length === 0 ? {} : { reapErrors: [...reapErrors] }),
        // Present only when the loop recorded a candidate before it failed —
        // never an empty array claiming measurements that did not happen.
        ...(mergeTelemetry.length === 0 ? {} : { mergeTelemetry }),
      },
      [
        // Issue #278 (§19): the terminal status line names the §19 mode.
        `${theme.accent('session:')} ${sessionId} mode=${runMode}`,
        ...mergeTelemetryLines(),
      ],
    );
  };

  if (parsed.prompt === undefined && !parsed.resume) {
    log.error(
      'missing -p, --prompt <text> (the objective), or --resume --session <id>',
    );
    return RUN_EXIT_USAGE;
  }
  if (!(await deps.isGitRepo())) {
    // Issue #372: outside a git repository is §78 code 5
    // (workspace_unavailable), not the usage code — the invocation is
    // well-formed, the workspace is not usable for orchestration.
    // --json: the envelope names it (and `fail` logs the one-line code);
    // text: the full refusal with the way out.
    if (parsed.json) {
      return fail(
        RUN_EXIT_WORKSPACE_UNAVAILABLE,
        'not_a_repo',
        'not a git repository',
      );
    }
    log.error(
      'orchestrator mode needs a git repository — run solo here (`kubic run -p <prompt>`) or retry inside a git checkout (orchestrator never falls back to solo)',
    );
    return RUN_EXIT_WORKSPACE_UNAVAILABLE;
  }
  // Issue #278 (§19): the run's start names the §19 mode through the
  // audit hook — the composition root appends the run:start row to the
  // §60 ledger. After the §78 workspace gate (a refused run never starts,
  // so it leaves no run:start row) and before any worktree, session or
  // child exists.
  deps.auditRunStart?.({
    sessionId,
    command: 'orchestrate',
    mode: 'orchestrator',
    runMode,
    workspace: deps.repoRoot ?? process.cwd(),
    posture: parsed.fullAccess ? 'full-access' : 'approvals',
    autonomous: parsed.autonomous,
  });

  // Resume: re-attach to the stored session. The stored payload is
  // untrusted JSON — anything malformed fails closed here as
  // no_orchestrator_state. A stopped queue also fails closed here —
  // blocked candidates are re-reported, never retried silently.
  //
  // §71 budget ownership (issue #208): the requested spec is reconstructed
  // once here; it is persisted below on a fresh run and re-applied from the
  // state on --resume (a differing flag is refused after the state loads).
  const requestedBudget: ParsedBudgetSpec | undefined =
    parsed.budget === undefined &&
    parsed.budgetTotal === undefined &&
    Object.keys(parsed.budgetsByAgent).length === 0
      ? undefined
      : {
          ...(parsed.budget === undefined ? {} : { shared: parsed.budget }),
          ...(parsed.budgetTotal === undefined
            ? {}
            : { total: parsed.budgetTotal }),
          byAgent: { ...parsed.budgetsByAgent },
        };
  let state: OrchestratorRunState;
  // A reserved session id (issue #174) never names a run — not fresh, not
  // resumed — so the rows file and the ledger dir stay what they are.
  if (RESERVED_SESSION_IDS.has(sessionId)) {
    return fail(
      RUN_EXIT_USAGE,
      'session_reserved',
      `session id '${sessionId}' is reserved (it names the orchestrator's own record) — choose another --session id`,
    );
  }
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
            ...(record.result === undefined
              ? {}
              : workerResultView(record.result)),
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
    // A fresh run never adopts a session name that already holds state
    // (issue #144): the first save below would overwrite the stored run
    // (prompt, merged list, records) BEFORE the worktree stage fails closed
    // on the retained tree — leaving a corrupted session that `--resume`
    // would then continue as the wrong run. Refused here, before anything is
    // saved. State that does not parse is not state (the same reading
    // `--resume` gives it), so a torn file is replaced, not a dead end.
    if ((await deps.loadState?.(sessionId)) !== undefined) {
      return fail(
        RUN_EXIT_USAGE,
        'session_exists',
        `session '${sessionId}' already has orchestrator state — continue it with \`kubic orchestrate --resume --session ${sessionId}\`, choose another --session id, or dispose it with \`kubic clean --session ${sessionId}\` (a fresh run never overwrites a stored session)`,
      );
    }
    state = {
      version: 1,
      sessionId,
      prompt: parsed.prompt as string,
      agents: parsed.agents,
      // The --agents entry count is the run's spawn cap (issue #413).
      spawnCap: parsed.agents.length,
      // The explicit assignment travels with the state (issue #178):
      // --resume replays it instead of falling back to a default role.
      ...(bindingIsEmpty(parsed.binding)
        ? {}
        : {
            roles: { ...parsed.binding.roles },
            models: { ...parsed.binding.models },
          }),
      // The skills the run was launched with travel with it (issue #170).
      ...(parsed.skills.length === 0 ? {} : { skills: [...parsed.skills] }),
      merged: [],
      pending: [...parsed.agents],
      stopped: false,
      records: [],
    };
  }
  // --resume re-applies the STORED assignment; a flag naming a DIFFERENT one
  // is refused rather than silently mixed in (the --budget rule, issue
  // #208). Two carve-outs (review finding, #178): a state written before the
  // binding persisted has nothing to differ from — the flag is adopted
  // below — and a bare `--agents a,b` carries no assignment at all (the ids
  // are ignored on resume regardless).
  const stateStoresBinding =
    state.roles !== undefined || state.models !== undefined;
  const flagCarriesBinding = !bindingIsEmpty(parsed.binding);
  if (
    parsed.resume &&
    options.agents !== undefined &&
    stateStoresBinding &&
    flagCarriesBinding &&
    !bindingsEqual(
      { roles: state.roles ?? {}, models: state.models ?? {} },
      parsed.binding,
    )
  ) {
    log.error(
      `--agents differs from the assignment stored for session '${sessionId}': --resume re-applies the stored one — drop the flag to continue`,
    );
    return RUN_EXIT_USAGE;
  }
  // The skills in force: the stored ones on a resume — never re-derived from
  // the CLI defaults — the parsed ones otherwise. A state written before
  // #170 has none and adopts the flag (the budget rule, issue #208), and a
  // flag naming a DIFFERENT list than the stored one is refused rather than
  // silently mixed in.
  const stateSkills = state.skills ?? [];
  if (
    parsed.resume &&
    options.skills !== undefined &&
    options.skills.length > 0 &&
    stateSkills.length > 0 &&
    JSON.stringify(stateSkills) !== JSON.stringify(parsed.skills)
  ) {
    log.error(
      `--skill differs from the skills stored for session '${sessionId}': --resume re-applies the stored ones — drop the flag to continue`,
    );
    return RUN_EXIT_USAGE;
  }
  if (parsed.resume && stateSkills.length === 0 && parsed.skills.length > 0) {
    state = { ...state, skills: [...parsed.skills] };
  }
  // A state written before #413 carries no cap: the stored agent count is
  // the cap the run was launched under — adopted (and persisted below),
  // the same adoption the skills and the binding get.
  if (state.spawnCap === undefined) {
    state = { ...state, spawnCap: state.agents.length };
  }
  // Issue #422: a run a previous attempt capped has a repair path —
  // `--resume --agents <larger list>` raises the stored cap to the flag's
  // count, so a worker refused by the old cap is admitted instead of
  // refused again. Only the COUNT is adopted (the ids stay ignored on
  // resume, as before), and the cap never shrinks: a shorter or equal
  // list leaves the stored cap in force.
  if (
    parsed.resume &&
    options.agents !== undefined &&
    parsed.agents.length > (state.spawnCap ?? state.agents.length)
  ) {
    const raisedFrom = state.spawnCap ?? state.agents.length;
    state = { ...state, spawnCap: parsed.agents.length };
    debug(
      `resume: --agents raises the spawn cap ${raisedFrom} → ${parsed.agents.length} — a worker refused by the old cap is admitted`,
    );
  }
  const effectiveSkills = state.skills ?? parsed.skills;
  // A pre-#178 state adopts the flag's assignment, so a later resume replays
  // it (the budget rule's adoption, issue #208).
  if (parsed.resume && !stateStoresBinding && flagCarriesBinding) {
    state = {
      ...state,
      roles: { ...parsed.binding.roles },
      models: { ...parsed.binding.models },
    };
  }
  // The binding in force: the stored (or just adopted) one on a resume —
  // never re-derived from the CLI defaults — the parsed one otherwise.
  const stateBinding: WorkerRoleBinding = {
    roles: { ...(state.roles ?? {}) },
    models: { ...(state.models ?? {}) },
  };
  // A per-agent clause must name an agent of THIS run: the stored session's
  // list on resume, the parsed --agents list otherwise. A clause for a worker
  // that never spawns would look configured while enforcing nothing
  // (issue #208).
  const unknownBudgetAgent =
    requestedBudget === undefined
      ? undefined
      : Object.keys(requestedBudget.byAgent).find(
          (agent) => !state.agents.includes(agent),
        );
  if (unknownBudgetAgent !== undefined) {
    log.error(
      `--budget names worker '${unknownBudgetAgent}', which is not part of this run (agents: ${state.agents.join(', ')})`,
    );
    return RUN_EXIT_USAGE;
  }
  // --resume re-applies the STORED spec; a flag naming a different one is
  // refused rather than silently mixed in (issue #208). A state written
  // before the budget persisted has nothing to differ from — the flag is
  // adopted and persisted below.
  if (
    parsed.resume &&
    state.budget !== undefined &&
    requestedBudget !== undefined &&
    !budgetSpecsEqual(state.budget, requestedBudget)
  ) {
    log.error(
      `--budget differs from the budget stored for session '${sessionId}': --resume re-applies the stored spec — drop the flag to continue`,
    );
    return RUN_EXIT_USAGE;
  }
  const effectiveBudget = state.budget ?? requestedBudget;
  // The spec this run started with travels with its state (issue #208): a
  // fresh run adopts the requested spec here, a pre-#208 stored state adopts
  // one supplied on resume.
  if (effectiveBudget !== undefined && state.budget === undefined) {
    state = { ...state, budget: effectiveBudget };
  }
  // The worker-failure policy travels with the state too (issue #169
  // review): a fresh run adopts the flag (or `stop`), and `--resume`
  // re-applies the stored policy — an explicit flag still wins, so a user can
  // opt out of `continue` on the retry.
  const effectiveOnFailure: 'stop' | 'continue' =
    parsed.onFailure ?? state.onFailure ?? 'stop';
  if (state.onFailure !== effectiveOnFailure) {
    state = { ...state, onFailure: effectiveOnFailure };
  }
  // Step 7 (issue #431): the model-driven manager lane drives the run when
  // a manager model resolves — a catalog plus a pin naming a model in it
  // (the composition root resolves the pin-or-first-usable default;
  // absence is the deterministic template fallback). A resume follows the
  // STORED path: a lane-driven run re-attaches its manager session below,
  // a template run replays its plan. A lane run whose model no longer
  // resolves refuses by name (never re-plans silently), a template run
  // never jumps to the lane, and a pin naming nothing refuses loudly —
  // silently driving a run the operator did not ask to drive is worse than
  // refusing it.
  const laneModelPin = deps.managerModel;
  const laneCatalog = deps.managerModels;
  const laneModel =
    laneCatalog === undefined || laneModelPin === undefined
      ? undefined
      : laneCatalog.getModel(laneModelPin.provider, laneModelPin.id);
  // L-D34 opt-in (issue #431): a fresh run lanes only when the operator
  // asked (`--manager-lane` / `[orchestrator] manager = "lane"`) AND a
  // manager model resolves. A `--resume` continues the marked lane it
  // started under (the mark is the record of that opt-in) — it never
  // re-plans as template, and never lanes an unmarked run.
  const laneOptIn = deps.managerLaneOptIn === true;
  const laneMode =
    state.laneDriven === true
      ? true
      : laneOptIn && laneModel !== undefined && !parsed.resume;
  // The two lane refusals live after role + credential validation (issue
  // #431): a contradictory role document or an undeliverable credential
  // fails first, so the operator fixes roles/keys before the manager
  // model is even considered — the lane never outranks a `role_refused`.
  // The mode itself is committed there too (the lane owns spawning: minted
  // ids arrive as it spawns, so the run starts with nothing pending).
  // No approvals layer means no gate to enforce the per-spawn spec.
  // Refused, never silently dropped — the exact false sense of cost control
  // issue #208 exists to remove. A `total`-only spec is exempt (issue
  // #207): the aggregate gate lives in the admission layer, which needs no
  // approvals wiring, so there is nothing unenforced to refuse.
  const needsSpawnEnforcement =
    effectiveBudget !== undefined &&
    (effectiveBudget.shared !== undefined ||
      Object.keys(effectiveBudget.byAgent).length > 0);
  if (needsSpawnEnforcement && deps.approvals === undefined) {
    log.error(
      '--budget cannot be enforced: this run has no approvals layer wired — refusing rather than dropping the limit',
    );
    return RUN_EXIT_USAGE;
  }
  // Role documents on the delegation path (issue #104, §12/§12.1). The
  // loader runs BEFORE anything spawns or merges: a contradictory document
  // (§40.3) or a role with no `## Prompt` instructions refuses the run with
  // the resolver's named reason — never a silent fallback to an
  // instruction-less prompt. Keyed on the STATE's agent list (not the
  // parsed one), because a --resume run carries no --agents and the workers
  // it retries are the stored session's: the explicit per-agent binding
  // (issue #178) is the stored one, so every worker keeps the role it had.
  const rolePlan: WorkerRolesPlan = deps.loadWorkerRoles?.(
    state.agents,
    stateBinding,
  ) ?? {
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
  // shared `-p` text. Never on the lane path (issue #431): the lane-driven
  // run has no steps, and re-deriving a plan for it would silently mix the
  // two drivers.
  if (state.plan === undefined && !laneMode) {
    state = {
      ...state,
      plan: composeRoles(buildManagerPlan(prompt, state.agents)),
    };
  }
  // The lane path states its steps as it mints (no template plan exists
  // there); the fallback keeps `promptForWorker` total — a mint without
  // a recorded step runs the objective, never a crash.
  const plan = (state.plan ?? []) as ManagerPlanStep[];
  const promptForWorker = (agentId: string): string => {
    const step = planStepFor(plan, agentId);
    return step === undefined ? prompt : step.prompt;
  };
  // The lane's minted roles (issue #431): `onSpawned` records each mint's
  // role here, so `spawnRoleInfo` (session linkage, worker rows) and the
  // role registry resolve a minted id exactly like a planned one. Declared
  // before `spawnRoleInfo` — the preflight below already reads it.
  const laneSpawnRoles = new Map<
    string,
    Pick<
      WorkerSpawnInfo,
      | 'role'
      | 'tools'
      | 'modelRef'
      | 'thinking'
      | 'classes'
      | 'requires'
      | 'budget'
    >
  >();
  // The role half of a worker's spawn info (issue #104): the assigned role,
  // its resolved tool set and its resolved model/thinking levels (issue
  // #202). Empty for a worker with no assignment (no role documents), so the
  // spawn info keeps its #85 shape.
  const spawnRoleInfo = (
    agentId: string,
    roles: WorkerRolesPlan,
  ): Pick<
    WorkerSpawnInfo,
    | 'role'
    | 'tools'
    | 'modelRef'
    | 'thinking'
    | 'classes'
    | 'requires'
    | 'budget'
  > => {
    // The lane's mints (issue #431): minted ids carry no plan assignment —
    // their role travels in the lane map the spawn adapter fills (role
    // documents included, so classes/requires ride along per #196).
    const lane = laneSpawnRoles.get(agentId);
    if (lane !== undefined) return { ...lane };
    const assignment = workerRoleAssignment(roles, agentId);
    if (assignment === undefined) return {};
    return {
      role: assignment.role,
      tools: [...assignment.tools],
      modelRef: assignment.modelRef,
      thinking: assignment.thinking,
      // Issue #196 (§40.2/§41.1): the role's classes and obligations
      // travel to the spawn — the task carries them to the child.
      classes: { ...assignment.classes },
      requires: [...assignment.requires],
    };
  };
  // §36.3 credential preflight (issue #200): the same role/model inputs
  // every launch below gets, checked ONCE before the first state write,
  // worktree or session exists. A refusal is exit 6 (`provider`-bound) and
  // names the provider; a run that cannot authenticate its workers must not
  // create any work first. The hook is the composition root's — the host
  // side never reads process.env or a provider catalog.
  if (deps.preflightWorkerCredentials !== undefined) {
    const requests: WorkerCredentialRequest[] = state.agents.map((agentId) => {
      const info = spawnRoleInfo(agentId, rolePlan);
      return {
        agentId,
        role: info.role ?? 'worker',
        ...(info.modelRef === undefined ? {} : { modelRef: info.modelRef }),
      };
    });
    const refusal = deps.preflightWorkerCredentials(requests);
    if (refusal !== undefined) {
      return fail(
        RUN_EXIT_PROVIDER_PROBE_FAILED,
        'credential_unavailable',
        `worker '${refusal.agentId}' (${refusal.role}): ${refusal.message}`,
        undefined,
        state.agents,
      );
    }
  }
  if (parsed.resume && state.laneDriven === true && laneModel === undefined) {
    return fail(
      RUN_EXIT_FAILED,
      'lane_resume_failed',
      `cannot resume the lane-driven run '${sessionId}': the manager model is not in the catalog — refusing rather than re-planning the run as a template`,
      undefined,
      state.agents,
    );
  }
  // L-D34 opt-in: only an opted-in run refuses over its manager model —
  // without the opt-in a bad pin is the template path's business (worker
  // preflight names it), never a loud lane refusal.
  if (
    laneOptIn &&
    !parsed.resume &&
    laneCatalog !== undefined &&
    laneModelPin !== undefined &&
    laneModel === undefined
  ) {
    return fail(
      RUN_EXIT_FAILED,
      'lane_model_unresolved',
      `the manager model '${laneModelPin.provider}/${laneModelPin.id}' is not in the model catalog — refusing rather than driving the run as a template`,
      undefined,
      state.agents,
    );
  }
  if (laneMode && !parsed.resume) {
    // The lane owns spawning: minted ids arrive as it spawns, so the run
    // starts with nothing pending (the template loops below no-op on an
    // empty pending list) and the lane mark travels with the state.
    state = {
      ...state,
      laneDriven: true,
      managerSessionId: sessionId,
      pending: [],
    };
  }
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
    // The lane path records its REAL calls after the drive (issue #431) —
    // the template trace must never mix into them.
    if (laneMode) return;
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
  // §45 per-session cap (issue #206): `--concurrency <n>` is this run's own
  // override, applied to the same scheduler every other admission judgement
  // goes through (an explicit limits cap and the configured
  // `[orchestrator].maxWorkers` still lose to it by resolveMaxConcurrency's
  // precedence). Applied BEFORE any request so no worker is ever admitted
  // under a cap the operator overrode.
  if (parsed.concurrency !== undefined) {
    scheduler.setSessionOverride(parsed.concurrency);
  }
  // The aggregate task budget (issue #207, §71): `--budget total:<dims>`
  // caps spend across ALL workers of the task through the admission
  // layer's budgetGate. Installed only when the run carries one — absent
  // means no aggregate limit (whatever the scheduler was constructed with
  // stands). The effective spec travels with the state, so a resume
  // re-applies the stored gate.
  if (effectiveBudget?.total !== undefined) {
    const total = effectiveBudget.total;
    const gate: BudgetGate = {
      ...(typeof total.maxCostUsd === 'number'
        ? { maxCostUsd: total.maxCostUsd }
        : {}),
      ...(typeof total.maxTokens === 'number'
        ? { maxTokens: total.maxTokens }
        : {}),
      ...(typeof total.maxToolCalls === 'number'
        ? { maxToolCalls: total.maxToolCalls }
        : {}),
      ...(typeof total.maxRuntimeMs === 'number'
        ? { maxRuntimeMs: total.maxRuntimeMs }
        : {}),
    };
    scheduler.setBudgetGate(gate);
  }
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
  // §61 (issue #158): when each candidate was enqueued (the queue leg) and the
  // branch-diff duration the worker's own run reported (the diff leg).
  const enqueuedAtMs = new Map<string, number>();
  const diffMsByAgent = new Map<string, number>();
  const worktrees = new Map<string, OrchestrateWorktree>();
  const hunksByAgent = new Map<string, MergedHunk[]>();
  // §68 results per worker (issue #185), successes and failures alike.
  const resultsByAgent = new Map<string, AgentResult>();
  for (const record of state.records) {
    hunksByAgent.set(record.agentId, record.hunks);
    if (record.result !== undefined) {
      resultsByAgent.set(record.agentId, record.result);
    }
  }
  // Aggregate usage roll-up (issue #207, §71): the previous attempt's
  // records seed the tally below, so a resume never forgets what the run
  // already spent — the gate judges the retry against real spend. Both
  // lists seed it: `records` (merged) AND `completed` (issue #160
  // write-ahead completions not yet merged when the attempt ended — a
  // stopped run's settled workers live there, and their spend counts).
  const aggregateUsage: UsageTally = {};
  const accumulateUsage = (result: AgentResult | undefined): void => {
    if (result === undefined) return;
    // The stored payload is untrusted JSON: only finite numbers enter the
    // tally, so a crafted record can never poison the gate fail-open
    // (NaN comparisons are false, which would read as "under budget").
    const num = (value: unknown): number =>
      typeof value === 'number' && Number.isFinite(value) ? value : 0;
    const metrics = result.metrics;
    aggregateUsage.costUsd =
      (aggregateUsage.costUsd ?? 0) + num(metrics.costUsd);
    aggregateUsage.tokens =
      (aggregateUsage.tokens ?? 0) +
      num(metrics.inputTokens) +
      num(metrics.outputTokens);
    aggregateUsage.toolCalls =
      (aggregateUsage.toolCalls ?? 0) + num(metrics.toolCalls);
    aggregateUsage.runtimeMs =
      (aggregateUsage.runtimeMs ?? 0) + num(metrics.wallMs);
  };
  for (const result of resultsByAgent.values()) accumulateUsage(result);
  for (const record of state.completed ?? []) {
    accumulateUsage(record.result);
  }
  scheduler.updateUsage({ ...aggregateUsage });

  // Per-worker approvals + opt-in budgets (issue #105; §41.1, §41.2, §71).
  // One approvals run for the whole orchestration: the router, its durable
  // decision store, the ask mailbox the workers publish to, the per-spawn
  // budget gates and the session-scoped full-access posture. Constructed only
  // when the composition root wired the factory — a caller with no approval
  // layer keeps the old behaviour instead of a half-wired one.
  const approvalsRun = deps.approvals?.({
    sessionId,
    // The bound is the config `[approvals] maxPendingMs` snapshot (issue
    // #230) — the same one the merge gate and the conflict resolver carry —
    // falling back to the run-level default when no config was loaded. A
    // headless ask still denies closed on it, never hangs.
    maxPendingMs:
      deps.approvalPolicy?.maxPendingMs ?? ORCHESTRATE_APPROVAL_BOUND_MS,
    // No `--yes` here (issue #323): the standing answer is the MERGE gate's,
    // never a worker-ask seat.
    ...(effectiveBudget?.shared === undefined
      ? {}
      : { budget: effectiveBudget.shared }),
    // Per-spawn overrides (`--budget worker-1:maxToolCalls=5`) reach the gate
    // of THAT spawn only; absent, the shared spec applies; absent that, the
    // worker's role DOCUMENT applies when it declares a budget (issue #198:
    // spawn/CLI > document — the role pin is the fallback tier, reported by
    // the approvals layer's own debug line when it is the spec in force).
    // The spec read here is the EFFECTIVE one: a resume re-applies what
    // the state stored.
    budgetForAgent: (agentId: string) =>
      effectiveBudget?.byAgent[agentId] ??
      effectiveBudget?.shared ??
      // Lane mints (#431 follow-up): a minted id has no roster
      // assignment, so the roster lookup below never fires for it — the
      // mint's role-document dims travel in the lane map instead. Issue
      // #198 precedence holds: both CLI tiers already won above.
      laneSpawnRoles.get(agentId)?.budget ??
      roleBudgetForAgent(rolePlan, agentId),
    ...(parsed.fullAccess ? { fullAccess: true } : {}),
    // A fresh run of a reused id must not find the old run's full-access
    // record or memoized decisions; only `--resume` continues them.
    ...(parsed.resume ? {} : { fresh: true }),
  });
  const approvalScopeFor = (
    agentId: string,
    worktree: OrchestrateWorktree,
  ): WorkerApprovalScope => ({
    sessionId,
    agentId,
    worktree: worktree.path,
    // Issue #159: the role this worker was ASSIGNED (the same plan the spawn
    // info and the credential preflight read), never a hardcoded label — the
    // manager's §60 rows and the child's ask must name the same role. It is
    // the FALLBACK for an ask that carries no role of its own, so it is
    // exported and unit-tested (assignedApprovalRole) rather than trusted to
    // the child always supplying one (#159 review finding 1).
    role: assignedApprovalRole(rolePlan, agentId),
  });

  // One row per agent of the run, in AGENT order whatever order the records
  // were written in (a resumed retry or a continued failure can upsert later
  // than its neighbours — issue #169). Shared by every envelope terminus, so
  // the report, `--json` and the error paths cannot disagree about a worker.
  const workerRows = (): OrchestrateEnvelope['workers'] =>
    state.agents.map((agentId) => {
      const record = state.records.find((entry) => entry.agentId === agentId);
      const hunks = hunksByAgent.get(agentId) ?? [];
      const result = resultsByAgent.get(agentId);
      return {
        agentId,
        branch:
          record?.branch ??
          worktrees.get(agentId)?.branch ??
          `kubic/${sessionId}/${agentId}`,
        hunks: hunks.length,
        ...(result === undefined ? {} : workerResultView(result)),
      };
    });

  const partial = (): Pick<
    OrchestrateEnvelope,
    'workers' | 'mergeOrder' | 'attribution'
  > => ({
    workers: workerRows(),
    mergeOrder: [...state.merged],
    attribution: state.records.flatMap((record) =>
      attributeMergedHunks(record.hunks, record.agentId),
    ),
  });

  // Every spawned worker is reaped even when one reap fails (issue #171): the
  // first failure used to return early, leaving the remaining children
  // unreaped. All errors are collected, reported on the debug channel, and
  // carried on the envelope — a failure path that drops them leaves an
  // operator with a child that was never reaped and no evidence.
  const reaped = new Set<string>();
  const reapSpawned = async (
    spawned: string[],
  ): Promise<{ agentId: string; message: string } | undefined> => {
    const errors: { agentId: string; message: string }[] = [];
    for (const agentId of spawned) {
      if (reaped.has(agentId)) continue;
      reaped.add(agentId);
      try {
        await deps.reapWorker(agentId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ agentId, message });
      }
    }
    for (const error of errors) {
      debug(`reap: worker '${error.agentId}' failed — ${error.message}`);
      reapErrors.push(error);
    }
    return errors[0];
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

  // §68 failure results in the SAVED state (issue #185). A worker's failure
  // used to reach only the run's envelope: its `records` entry never existed,
  // so a failing run left `records: 0`, and a worker that never launched (the
  // worktree stage, admission, session creation) had no result at all. Every
  // worker-stage failure now records what the worker reported — or, when it
  // reported nothing, a result synthesized in the same AgentResult shape —
  // next to the run state. The record is an upsert keyed by agent: a resumed
  // retry replaces it instead of listing the worker twice. The worker stays
  // `pending`: it was not merged, and `--resume` retries it.
  // The result a manager-side approval/budget termination stands for: a
  // budget hit is a `budget_exhausted` result of kind `budget`, anything else
  // (a denial, a bound that elapsed) a failed result of kind `approval`.
  const terminationOutcome = (termination: {
    code: string;
    message: string;
  }) => ({
    status: (termination.code === BUDGET_EXHAUSTED
      ? 'budget_exhausted'
      : 'failed') as ResultStatus,
    kind: (termination.code === BUDGET_EXHAUSTED
      ? 'budget'
      : 'approval') as ResultErrorKind,
    code: termination.code,
    message: termination.message,
    override: true,
  });
  const upsertRecord = (record: OrchestratedWorkerRecord): void => {
    const at = state.records.findIndex(
      (entry) => entry.agentId === record.agentId,
    );
    if (at === -1) state.records.push(record);
    else state.records[at] = record;
  };
  // Write-ahead completion (issue #160): the worker settled successfully
  // but is not merged yet. An upsert keyed by agent, like the merge record
  // above — a retried worker replaces its earlier completion.
  const upsertCompleted = (record: OrchestratedWorkerRecord): void => {
    const completed = state.completed ?? [];
    const at = completed.findIndex((entry) => entry.agentId === record.agentId);
    if (at === -1) completed.push(record);
    else completed[at] = record;
    if (state.completed === undefined) state = { ...state, completed };
  };
  // A merge success moves the completion to the merge records (issue #160):
  // `records` keeps meaning "merged", `completed` only the still-pending.
  const moveCompletedToRecords = (record: OrchestratedWorkerRecord): void => {
    upsertRecord(record);
    if (state.completed !== undefined) {
      const rest = state.completed.filter(
        (entry) => entry.agentId !== record.agentId,
      );
      state = { ...state, completed: rest };
    }
  };
  const recordFailure = async (
    agentId: string,
    worktree: OrchestrateWorktree | undefined,
    fallback: {
      status: ResultStatus;
      kind: ResultErrorKind;
      code: string;
      message: string;
      // A manager-side termination decided the run's outcome: what the worker
      // itself reported (provenance, metrics) is kept, but the status and
      // error say what the run exits on.
      override?: boolean;
    },
  ): Promise<void> => {
    let result = resultsByAgent.get(agentId);
    if (result !== undefined && fallback.override === true) {
      result = {
        ...result,
        status: fallback.status,
        summary: fallback.message,
        error: {
          kind: fallback.kind,
          message: fallback.message,
          details: { code: fallback.code },
        },
      };
      resultsByAgent.set(agentId, result);
    }
    if (result === undefined) {
      try {
        result = buildAgentResult({
          status: fallback.status,
          summary: fallback.message,
          provenance: {
            workerId: agentId,
            sessionId: workerSessionFor(sessionId, agentId),
            // No process ever existed for a worker that never launched.
            pid: null,
            generation: 0,
            worktree: worktree?.path ?? NO_WORKTREE,
            model: UNRESOLVED_MODEL,
          },
          metrics: { wallMs: 0, latencyMs: 0 },
          error: {
            kind: fallback.kind,
            message: fallback.message,
            details: { code: fallback.code },
          },
        });
      } catch (error) {
        debug(
          `result: could not build the failure result for '${agentId}': ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      resultsByAgent.set(agentId, result);
    }
    upsertRecord({
      agentId,
      branch: worktree?.branch ?? `kubic/${sessionId}/${agentId}`,
      hunks: [],
      result,
    });
    try {
      await deps.saveState?.(state);
    } catch (error) {
      // Best-effort: the failure already owns the run's exit and envelope;
      // an unsaved record must not replace it with a save error.
      debug(
        `state: failure record for '${agentId}' not saved — ${error instanceof Error ? error.message : String(error)}`,
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
  const worktreeRequest: WorktreeRequest = {
    sessionId,
    resume: parsed.resume,
  };
  const reconcileMergeIntent = async (): Promise<number | undefined> => {
    const inFlight = state.merging;
    if (inFlight === undefined || inFlight === null) return undefined;
    if (!state.pending.includes(inFlight)) {
      state = { ...state, merging: undefined };
      return undefined;
    }
    // The in-flight worker's earlier failure result is not this attempt's
    // (issue #185): the worktree stage below records its own.
    resultsByAgent.delete(inFlight);
    let worktree: OrchestrateWorktree;
    try {
      worktree = await deps.ensureWorktree(inFlight, worktreeRequest);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await recordFailure(inFlight, undefined, {
        status: 'spawn_failed',
        kind: 'workspace',
        code: worktreeFailureCode(error),
        message: `spawn failed for worker '${inFlight}': ${message}`,
      });
      return fail(
        RUN_EXIT_FAILED,
        worktreeFailureCode(error),
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
    // A failure record (issue #185) is not a merge record: an earlier failed
    // attempt of this worker is replaced by the merge record (its result
    // unknown — the process that produced it died before the save).
    const existing = state.records.find(
      (record) => record.agentId === inFlight,
    );
    if (
      existing === undefined ||
      (existing.result !== undefined && existing.result.status !== 'completed')
    ) {
      resultsByAgent.delete(inFlight);
      // The reconciled merge keeps the persisted hunks (issue #160): the
      // worker settled before the kill, so its completion — not an empty
      // hunk list — is what attribution reports. Without one (a state
      // written before #160) the empty record stands, as before.
      const completedEntry = state.completed?.find(
        (record) => record.agentId === inFlight,
      );
      if (completedEntry?.result !== undefined) {
        resultsByAgent.set(inFlight, completedEntry.result);
      }
      moveCompletedToRecords({
        agentId: inFlight,
        branch: worktree.branch,
        hunks: completedEntry === undefined ? [] : [...completedEntry.hunks],
        ...(completedEntry?.result === undefined
          ? {}
          : { result: completedEntry.result }),
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

  // Worker admission + run (issue #206, §9.3/§45). The admission layer is a
  // GATE: workers admitted up to the scheduler's resolved cap run
  // concurrently, and the rest wait in its FIFO queue until a settle releases
  // a slot. Phase 1 prepares every pending worker's worktree first (a
  // worktree is not a worker, and the admission layer judges each request
  // against the real path); phase 2 admits and runs them; the merge phase
  // below is the shipped one and enqueues candidates in AGENT order, so the
  // merge order — and the write-ahead intent per candidate — stays
  // deterministic whatever the settle order was.

  // One worker's whole spawn → run → settle leg. It never throws: every
  // terminus is an outcome the driver turns into the run's result, so a
  // concurrent sibling can never reject into an unhandled rejection.
  type WorkerOutcome =
    | { ok: true }
    | { ok: false; exitCode: number; code: string; message: string };
  // One worker's failure, as the driver reports it: the run's terminus under
  // `stop`, one entry in `partialFailures` under `continue`.
  type WorkerFailureOutcome = Extract<WorkerOutcome, { ok: false }>;

  const spawned: string[] = [];
  {
    const reconcileFailure = await reconcileMergeIntent();
    if (reconcileFailure !== undefined) return reconcileFailure;
  }
  {
    const saveFailure = await saveOrFail(state);
    if (saveFailure !== undefined) return saveFailure;
  }
  // §41.1/issue #277: a run that requests MORE workers than the concurrency
  // cap is a decision the user makes on an interactive run — one `spawn-agents`
  // ask naming the requested count, the cap and the excess ids — instead of a
  // silent queue. The autonomous run keeps the shipped rule (the shared
  // resolveBlockedSpawn contract): the cap bounds concurrency, it never asks.
  const concurrencyCap = scheduler.maxConcurrency();
  // Issue #207 (§71): the mode the admission layer judges every spawn
  // under — a TTY run without --yes is interactive (pressure fails
  // immediately with a reason), --yes or headless is autonomous (pressure
  // queues). The #277 spawn-agents ask below is the interactive decision
  // for the concurrency cap itself: approving it proceeds under the
  // queueing rule, so an approval flips back to autonomous for the
  // per-worker requests — the user already decided, no second ask per
  // worker and no fail-fast betraying the approval.
  // Seeded from the run's §19 mode (issue #278: explicit --autonomous wins,
  // else --yes / headless is autonomous) so the admission layer honours it.
  let spawnMode: RunMode = runMode;
  // The --agents spawn cap (issue #413): adopted from stored state when the
  // run predates it, so a resume never runs uncapped.
  const spawnCap = state.spawnCap ?? state.agents.length;
  // Workers refused by the spawn cap in the prepare loop below — skipped by
  // the spawn loop, mirroring deniedSpawns.
  const cappedSpawns = new Set<string>();
  const excessAgents =
    state.agents.length <= concurrencyCap
      ? []
      : state.agents
          .slice(concurrencyCap)
          .filter((agentId) => state.pending.includes(agentId));
  const deniedSpawns = new Set<string>();
  const refusalReasonFor = (agentId: string): string =>
    `spawn-agents denied: worker '${agentId}' is beyond the concurrency cap (${concurrencyCap}) and the user refused the request`;
  if (excessAgents.length > 0 && approvalsRun !== undefined) {
    // `--yes` is the run's standing answer: it makes the run autonomous, so
    // the cap never asks (issue #323's rule, applied to this ask too).
    const blocked = resolveBlockedSpawn(
      spawnMode,
      `${state.agents.length} workers requested with a concurrency cap of ${concurrencyCap}`,
    );
    if (blocked.outcome === 'ask') {
      const verdict = await approvalsRun.decisions.ask({
        trigger: 'spawn-agents',
        toolName: 'spawn_agent',
        args: {
          agents: [...state.agents],
          cap: concurrencyCap,
          excess: [...excessAgents],
        },
        justification: `this run requests ${state.agents.length} workers with a concurrency cap of ${concurrencyCap}; approving proceeds under the queueing rule, denying fails the excess workers (${excessAgents.join(', ')})`,
        sessionId,
        agentId: 'manager',
        role: 'manager',
        worktree: deps.repoRoot ?? process.cwd(),
        provenance: { parentSessionId: sessionId },
      });
      if (!verdict.approved) {
        for (const agentId of excessAgents) deniedSpawns.add(agentId);
        debug(
          `admission: spawn-agents ask denied — ${excessAgents.join(', ')} will not spawn (${verdict.reason})`,
        );
      } else {
        // The approval is the queueing decision (issue #207): the excess
        // proceeds under the queueing rule, so the per-worker requests
        // below judge under autonomous even on an interactive run.
        spawnMode = 'autonomous';
        debug(
          `admission: spawn-agents ask approved — ${excessAgents.join(', ')} proceed under the queueing rule`,
        );
      }
    }
  }
  const prepared = new Map<string, OrchestrateWorktree>();
  // Pending workers whose write-ahead completion (issue #160) this resume
  // reuses: prepared like the rest, but never spawned or run again.
  const resumedCompleted = new Set<string>();
  // §61 worktree creation duration per agent (issue #158).
  const worktreeMsByAgent = new Map<string, number>();
  for (const agentId of state.pending) {
    // Issue #277: a worker beyond the cap whose ask the user REFUSED fails
    // before any worktree is created, with the denial as its result — the
    // failed-worker contract every other spawn failure follows. The run
    // itself ends only once every candidate INSIDE the cap has settled (the
    // partial-failure contract below), so a denial never discards work the
    // user did approve.
    if (deniedSpawns.has(agentId)) {
      await recordFailure(agentId, undefined, {
        status: 'spawn_failed',
        kind: 'approval',
        code: 'spawn_agents_denied',
        message: refusalReasonFor(agentId),
      });
      continue;
    }
    // Issue #413: --agents is the run's spawn CAP, not just its roster — a
    // worker past the cap fails before any worktree is created, with the
    // refusal as its result (the same failed-worker contract as the denial
    // above). The count is DISTINCT preparations: denials never reach this
    // loop, so they never consume a slot, and a re-prepared worker (issue
    // #175) spends the slot it already holds. On the template path the
    // pending set is the agent list, so the cap never binds — the guard is
    // live for the manager lane's spawn_agent adapter (issue #414).
    if (!prepared.has(agentId) && prepared.size >= spawnCap) {
      cappedSpawns.add(agentId);
      await recordFailure(agentId, undefined, {
        status: 'spawn_failed',
        kind: 'process',
        code: 'spawn_cap_exceeded',
        message: `spawn refused for worker '${agentId}': the run's --agents cap is ${spawnCap} and ${prepared.size} worker(s) are already prepared`,
      });
      continue;
    }
    // This attempt's own result: a failure record kept from an earlier run of
    // the same session is not this attempt's outcome (issue #185). Cleared
    // BEFORE any stage can fail — the worktree stage records its own failure
    // and must not inherit the earlier attempt's result.
    resultsByAgent.delete(agentId);
    // Resume may already hold this worktree (intent reconciliation
    // resolved it for the isBranchMerged probe) — never ensure twice.
    let worktree = worktrees.get(agentId);
    if (worktree === undefined) {
      // §61 (issue #158): time the CREATION leg here, so the launch sample
      // reports creation only — never the gap until the child is launched.
      const creationStartedAt = now();
      try {
        worktree = await deps.ensureWorktree(agentId, worktreeRequest);
        worktreeMsByAgent.set(agentId, Math.max(0, now() - creationStartedAt));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await recordFailure(agentId, undefined, {
          status: 'spawn_failed',
          kind: 'workspace',
          code: worktreeFailureCode(error),
          message: `spawn failed for worker '${agentId}': ${message}`,
        });
        return fail(
          RUN_EXIT_FAILED,
          worktreeFailureCode(error),
          `spawn failed for worker '${agentId}': ${message}`,
          partial(),
        );
      }
      worktrees.set(agentId, worktree);
    }
    prepared.set(agentId, worktree);
    // Write-ahead completion reuse (issue #160): this resume continues a run
    // whose worker already settled — when the retained worktree is still on
    // the completion's branch, the recorded hunks (+ result) are restored
    // and the worker is queued for merge WITHOUT re-running it (a second
    // run would spend tokens and mix a second commit into the same branch).
    // A completion on any other branch is stale (recreated out-of-band) and
    // is dropped, so the worker runs again.
    const completedEntry = state.completed?.find(
      (entry) => entry.agentId === agentId,
    );
    if (completedEntry !== undefined) {
      // Tip check (issue #429): a branch rewritten under the same name
      // must not receive the hunks recorded before the rewrite. Only a
      // positive mismatch refuses — an unknown tip (no probe, a throwing
      // probe, a state written before #429) reuses on branch match (#160).
      let tipMoved = false;
      if (completedEntry.tipSha !== undefined) {
        let current: string | undefined;
        try {
          current = await deps.readBranchTip?.(agentId, worktree);
        } catch {
          current = undefined;
        }
        tipMoved = current !== undefined && current !== completedEntry.tipSha;
        if (tipMoved) {
          debug(
            `resume: worker '${agentId}' completion tip moved (recorded ${completedEntry.tipSha}, worktree tip ${current}) — running again`,
          );
        }
      }
      if (tipMoved) {
        state = {
          ...state,
          completed: (state.completed ?? []).filter(
            (entry) => entry.agentId !== agentId,
          ),
        };
      } else if (completedEntry.branch === worktree.branch) {
        hunksByAgent.set(agentId, [...completedEntry.hunks]);
        if (completedEntry.result !== undefined) {
          resultsByAgent.set(agentId, completedEntry.result);
        }
        resumedCompleted.add(agentId);
        debug(
          `resume: worker '${agentId}' already completed on ${worktree.branch} — skipping re-run, queued for merge`,
        );
      } else {
        state = {
          ...state,
          completed: (state.completed ?? []).filter(
            (entry) => entry.agentId !== agentId,
          ),
        };
        debug(
          `resume: worker '${agentId}' completion is stale (recorded on ${completedEntry.branch}, worktree is ${worktree.branch}) — running again`,
        );
      }
    }
  }

  const runWorkerOnce = async (
    agentId: string,
    worktree: OrchestrateWorktree,
  ): Promise<WorkerOutcome> => {
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
        // Issue #278 (§19): the run's mode travels to the session records.
        mode: runMode,
        // Issue #164 (§23): the assignment travels to the session record
        // so the worker session names its role beside its parent.
        ...(() => {
          const role = spawnRoleInfo(agentId, rolePlan).role;
          return role === undefined ? {} : { role };
        })(),
      });
      if (created === undefined) {
        const noHook = `spawn failed for worker '${agentId}': no session-creation hook is wired for session '${workerSessionId}' — a spawned child could only die at attach ("unknown session")`;
        await recordFailure(agentId, worktree, {
          status: 'spawn_failed',
          kind: 'process',
          code: 'spawn_failed',
          message: noHook,
        });
        return {
          ok: false,
          exitCode: RUN_EXIT_FAILED,
          code: 'spawn_failed',
          message: noHook,
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const notCreated = `spawn failed for worker '${agentId}': could not create session '${workerSessionId}': ${message}`;
      await recordFailure(agentId, worktree, {
        status: 'spawn_failed',
        kind: 'process',
        code: 'spawn_failed',
        message: notCreated,
      });
      return {
        ok: false,
        exitCode: RUN_EXIT_FAILED,
        code: 'spawn_failed',
        message: notCreated,
      };
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
      const output = runOutputOf(
        await deps.runWorker(agentId, worktree, promptForWorker(agentId), {
          sessionId,
          workerSessionId,
          ...(worktreeMsByAgent.get(agentId) === undefined
            ? {}
            : { worktreeMs: worktreeMsByAgent.get(agentId) as number }),
          // The role this worker was assigned and the tool set its lane
          // must register (§12.1/§40): the resolved set is what withholds
          // a tool — absence, never approval. Absent means no role
          // document exists for this worker, so nothing is narrowed.
          ...spawnRoleInfo(agentId, rolePlan),
          // §67 task resources (issue #170): the run's `--skill` values reach
          // every worker (the STORED ones on a resume), and the run resolves
          // them against its own cwd.
          ...(effectiveSkills.length === 0
            ? {}
            : { skills: [...effectiveSkills] }),
        }),
      );
      if (output.result !== undefined) {
        resultsByAgent.set(agentId, output.result);
      }
      if (output.diffMs !== undefined)
        diffMsByAgent.set(agentId, output.diffMs);
      const hunks = output.hunks;
      // The worker settled: route any ask that raced its exit, then read the
      // terminal outcome its run produced (a denial or a budget hit is NOT a
      // spawn failure — it carries its own named code and exit).
      if (approvalsRun !== undefined) {
        const scope = approvalScopeFor(agentId, worktree);
        const raced = await approvalsRun.pump(scope);
        approvalsRun.endWorker(agentId);
        const termination = raced ?? approvalsRun.takeTermination(agentId);
        if (termination !== undefined) {
          await recordFailure(
            agentId,
            worktree,
            terminationOutcome(termination),
          );
          return {
            ok: false,
            exitCode: termination.exitCode,
            code: termination.code,
            message: termination.message,
          };
        }
      }
      hunksByAgent.set(agentId, [...hunks]);
      // Write-ahead completion (issue #160): the worker settled, so its
      // branch + hunks persist BEFORE the merge gate runs — a deny, a
      // timeout or a kill must not lose them. Best-effort here (siblings
      // are still in flight); the merge phase re-saves fail-closed.
      // The branch tip travels with it (issue #429): a throwing probe is
      // an unknown tip, never a failed settle.
      let tipSha: string | undefined;
      try {
        tipSha = await deps.readBranchTip?.(agentId, worktree);
      } catch {
        tipSha = undefined;
      }
      upsertCompleted({
        agentId,
        branch: worktree.branch,
        hunks: [...hunks],
        ...(output.result === undefined ? {} : { result: output.result }),
        ...(tipSha === undefined ? {} : { tipSha }),
      });
      try {
        await deps.saveState?.(state);
      } catch (error) {
        debug(
          `state: completion record for '${agentId}' not saved — ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      // The lane drove this worker to completion — its spawn → wait →
      // collect is part of the manager's real call record (issue #103).
      recordLaneSequence();
    } catch (error) {
      // Every terminus carries its §68 result (issue #185): a failure's
      // provenance and error.kind reach the envelope and the saved state.
      const failed = (error as { result?: unknown }).result;
      if (failed !== undefined && validateAgentResult(failed).valid) {
        resultsByAgent.set(agentId, failed as AgentResult);
      }
      // The manager-side terminus is decided FIRST: when the approvals layer
      // ended this worker on a named code, the run exits on that code and the
      // saved result must say the same (issue #185) — not the generic process
      // failure the child's own report may carry.
      let termination: WorkerApprovalTermination | undefined;
      if (approvalsRun !== undefined) {
        approvalsRun.endWorker(agentId);
        termination = approvalsRun.takeTermination(agentId);
      }
      // The result reaches the SAVED state whichever named terminus below the
      // run then ends on. When the worker reported none, a result is
      // synthesized from the failure itself.
      const failureMessage =
        error instanceof Error ? error.message : String(error);
      const failureApproval = (
        error as { approval?: { code: string; exitCode: number } }
      ).approval;
      const failureCode =
        failureApproval?.code ??
        (typeof (error as { code?: unknown }).code === 'string'
          ? (error as { code: string }).code
          : 'worker_failed');
      await recordFailure(
        agentId,
        worktree,
        termination !== undefined
          ? terminationOutcome(termination)
          : {
              status:
                failureCode === 'spawn_failed' ? 'spawn_failed' : 'failed',
              kind: failureApproval === undefined ? 'process' : 'approval',
              code: failureCode,
              message: `worker '${agentId}' failed: ${failureMessage}`,
            },
      );
      // A worker that exited non-zero because the USER denied it (or because a
      // configured budget ran out) reports the approval layer's named status in
      // the child's own §78 terminus; that code wins over the generic
      // worker_failed so the run's exit stays 3/4-bound instead of 1-bound.
      if (termination !== undefined) {
        return {
          ok: false,
          exitCode: termination.exitCode,
          code: termination.code,
          message: termination.message,
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      // The child's own approval terminus (issue #105) wins over the generic
      // worker_failed: a worker that denied itself closed on a bounded wait
      // (or on its configured budget) ended on a named approval/budget code,
      // and reporting it as a crash would misstate what the user decided.
      const approval = (
        error as { approval?: { code: string; exitCode: number } }
      ).approval;
      if (approval !== undefined) {
        return {
          ok: false,
          exitCode: approval.exitCode,
          code: approval.code,
          message: `worker '${agentId}': ${message}`,
        };
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
      return {
        ok: false,
        exitCode: RUN_EXIT_FAILED,
        code: named,
        message: `worker '${agentId}' failed: ${message}`,
      };
    }
    return { ok: true };
  };

  // Phase 2: admit every pending worker, then run the admitted ones
  // concurrently and drain the queue on release. Fail-fast: the first
  // failed outcome stops the run — siblings still in flight are cancelled
  // and awaited, never left spending tokens behind it.
  const finished = new Map<string, WorkerOutcome>();
  const inFlight = new Map<string, Promise<void>>();
  const started = new Set<string>();
  const handled = new Set<string>();
  const queued = new Set<string>();
  // The lane's settle observer (issue #431): set by the lane section when
  // the manager lane drives the run (undefined on the template path), and
  // invoked from `startWorker`'s completion tail for every worker that
  // settles — however it was launched.
  let laneSettleHook: ((agentId: string) => void) | undefined;
  // Worker-level failures the run continued past (issue #169): keyed by
  // agent, in agent order, each with the named terminus the envelope and the
  // partial-failure exit report.
  const partialFailures = new Map<string, WorkerFailureOutcome>();
  // §81 replacement bookkeeping (issue #175): per agent, how many times the
  // run has replaced it (compared against WORKER_REPLACEMENT_LIMIT) and the
  // generations it has seen, in order (for the failure message only — the
  // count is the bound, not a list length).
  const replacementCount = new Map<string, number>();
  const replacementGenerations = new Map<string, number[]>();
  let denied: WorkerFailureOutcome | undefined;

  // A worker-level failure is exactly that unless the run must stop. Under
  // `--on-failure continue` (issue #169) everything but an approval terminus
  // keeps the run going: a crash, a spawn failure and an exhausted budget are
  // the worker's own terminus, never the run's. An approval terminus (exit 4)
  // is the user's decision for the whole run and stops it either way.
  const failWorker = (
    agentId: string,
    outcome: WorkerFailureOutcome,
  ): 'stop' | 'continue' => {
    if (
      effectiveOnFailure === 'continue' &&
      outcome.exitCode !== RUN_EXIT_APPROVAL_DENIED
    ) {
      partialFailures.set(agentId, outcome);
      return 'continue';
    }
    denied = outcome;
    return 'stop';
  };

  // One §49.1 trajectory record per admission transition (issue #106): the
  // queue depth when a spawn is queued (`wakeups` empty — nothing was woken
  // by a request), and the FIFO wakeup that admitted it (`wakeups` names
  // exactly the agents this drain admitted, never one that did not move).
  const recordAdmission = (wakeups: string[]): void => {
    deps.trajectoryEvent?.(
      buildParallelTrajectoryEvent({
        sessionId,
        ...parallelExtra(),
        wakeups,
      }),
    );
  };

  // Release a settled worker's slot, then start whatever the scheduler's FIFO
  // drain woke — shared by the success and the `continue` failure paths, so a
  // failed worker frees its slot exactly like a completed one (issue #206).
  // The settled worker's reported usage feeds the admission layer FIRST
  // (issue #207, §71): the drain that wakes the next worker judges under
  // the fresh tally, so a spawn the run can no longer afford stays queued
  // (or is denied outright in interactive mode) instead of starting blind.
  const releaseSlot = (agentId: string): void => {
    accumulateUsage(resultsByAgent.get(agentId));
    const woken = scheduler.updateUsage({ ...aggregateUsage });
    const usageWakeups = woken.filter((id) => !started.has(id));
    for (const id of usageWakeups) startWorker(id);
    if (usageWakeups.length > 0) recordAdmission(usageWakeups);
    const drained = scheduler.complete(agentId);
    observeAdmission();
    const wakeups = drained.filter((id) => !started.has(id));
    for (const id of wakeups) startWorker(id);
    if (wakeups.length > 0) recordAdmission(wakeups);
  };

  const startWorker = (agentId: string): void => {
    // The agent is no longer waiting in the queue (issue #206 review):
    // `queued` is the run's view of the scheduler's queue, and a started
    // worker is out of it however it got out (a wakeup, or a drain the run
    // did not observe).
    queued.delete(agentId);
    if (started.has(agentId) || finished.has(agentId)) return;
    const worktree = prepared.get(agentId) as OrchestrateWorktree;
    started.add(agentId);
    // A replaced worker (issue #175) starts a second time: `spawned` is the
    // set of agents this run launched, so it must not list it twice.
    if (!spawned.includes(agentId)) spawned.push(agentId);
    const task = (async () => {
      // `runWorkerOnce` converts every terminus into an outcome; this outer
      // guard is the belt for a bug in that conversion, so a concurrent
      // sibling's promise can never reject into an unhandled one.
      let outcome: WorkerOutcome;
      try {
        outcome = await runWorkerOnce(agentId, worktree);
      } catch (error) {
        outcome = {
          ok: false,
          exitCode: RUN_EXIT_FAILED,
          code: 'worker_failed',
          message: `worker '${agentId}' failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      inFlight.delete(agentId);
      finished.set(agentId, outcome);
      // The lane's settle hook (issue #431): the router observes the same
      // settlement the run merges — the hook releases the scheduler slot
      // and settles the registry, so `wait_for_agent` wakes on the run's
      // own bookkeeping, not a copy. Guarded: a hook bug must never break
      // the task the siblings await on. Undefined on the template path.
      if (laneSettleHook !== undefined) {
        try {
          laneSettleHook(agentId);
        } catch (error) {
          debug(
            `lane: settle hook for '${agentId}' failed — ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    })();
    inFlight.set(agentId, task);
  };

  // §206 review F1/F2: the scheduler drops an entry it queued past its own
  // maxPendingMs bound, and both `complete()` and `requestSpawn` discard the
  // ids their internal sweeps deny (the deny is logged, never returned). The
  // run therefore reconciles its own queue view after every scheduler
  // interaction: an entry that is gone, never started and not running
  // EXPIRED — a named denial naming the same bound the sweep used, never the
  // "can never admit" fall-through. An entry the scheduler admitted in a
  // drain this call site did not observe is started here, so a wakeup is
  // never lost. Returns false when the run must stop.
  const reconcileQueue = async (): Promise<boolean> => {
    const pending = new Set(scheduler.pendingIds());
    const running = new Set(scheduler.runningIds());
    const woken: string[] = [];
    const expired: string[] = [];
    for (const agentId of [...queued]) {
      if (pending.has(agentId)) continue;
      if (running.has(agentId)) {
        const wasStarted = started.has(agentId);
        startWorker(agentId);
        if (!wasStarted && started.has(agentId)) woken.push(agentId);
        continue;
      }
      queued.delete(agentId);
      if (!started.has(agentId)) expired.push(agentId);
    }
    if (woken.length > 0) recordAdmission(woken);
    for (const agentId of expired) {
      const worktree = prepared.get(agentId) as OrchestrateWorktree;
      const message = `spawn denied for worker '${agentId}': queued past the admission layer's ${scheduler.maxPendingMs()}ms bound before a slot freed`;
      await recordFailure(agentId, worktree, {
        status: 'spawn_failed',
        kind: 'process',
        code: 'spawn_denied',
        message,
      });
      if (
        failWorker(agentId, {
          ok: false,
          exitCode: RUN_EXIT_FAILED,
          code: 'spawn_denied',
          message,
        }) === 'stop'
      ) {
        return false;
      }
    }
    return true;
  };

  for (const agentId of state.pending) {
    // Issue #277: a worker the user refused to admit past the cap never got a
    // worktree — its failure result was recorded when the run reached it — so
    // it is skipped here rather than dereferencing a missing preparation.
    // A worker past the --agents spawn cap (issue #413) is skipped the same
    // way: refused in the prepare loop above, never spawned here. A worker
    // whose completion this resume reuses (issue #160) is skipped too: it
    // is already prepared above and goes straight to the merge queue.
    if (deniedSpawns.has(agentId) || cappedSpawns.has(agentId)) continue;
    if (resumedCompleted.has(agentId)) continue;
    const worktree = prepared.get(agentId) as OrchestrateWorktree;
    // §45 provider caps: the worker's own model pin names the provider its
    // child will call, so the admission layer judges the right one. The pin
    // here is the ROLE's (`spawnRoleInfo`), which is the child's own pin
    // precedence minus the operator/manager pins the host cannot see: with no
    // role document the request carries no provider and the scheduler's
    // `default` bucket applies. Documented in the architecture page —
    // provider caps are live, the credential plan's resolution is wider.
    // `memMb`/`diskMb` are deliberately NOT passed (issue #206 review): no
    // production estimate source exists, and a fabricated number would make
    // the aggregate caps enforce fiction. The architecture page records that
    // the aggregates stay opt-in and estimate-driven only for callers that
    // supply estimates themselves.
    const provider = providerOfModelRef(
      spawnRoleInfo(agentId, rolePlan).modelRef,
    );
    const admission = scheduler.requestSpawn(
      {
        agentId,
        sessionId,
        worktree: worktree.path,
        ...(provider === undefined ? {} : { provider }),
      },
      spawnMode,
    );
    // The admission layer's own numbers, sampled right after the request
    // (issue #106, §49.1/§50) — the point at which running/queued are the
    // truth the operator was previously never shown.
    observeAdmission();
    if (admission.outcome === 'denied') {
      const message = `spawn denied for worker '${agentId}': ${admission.reason}`;
      await recordFailure(agentId, worktree, {
        status: 'spawn_failed',
        kind: 'process',
        code: 'spawn_denied',
        message,
      });
      if (
        failWorker(agentId, {
          ok: false,
          exitCode: RUN_EXIT_FAILED,
          code: 'spawn_denied',
          message,
        }) === 'continue'
      ) {
        continue;
      }
      break;
    }
    if (admission.outcome === 'queued') {
      // A request refused against an EMPTY running set can never be woken by
      // a release: the cap it exceeds belongs to the request itself (an
      // aggregate or budget gate), so waiting would hang the run. Refused by
      // name, before any child exists.
      if (scheduler.runningCount() === 0) {
        const message = `spawn denied for worker '${agentId}': queued with no worker running — the admission layer can never admit this spawn (${admission.position} in queue)`;
        await recordFailure(agentId, worktree, {
          status: 'spawn_failed',
          kind: 'process',
          code: 'spawn_denied',
          message,
        });
        if (
          failWorker(agentId, {
            ok: false,
            exitCode: RUN_EXIT_FAILED,
            code: 'spawn_denied',
            message,
          }) === 'continue'
        ) {
          continue;
        }
        break;
      }
      queued.add(agentId);
      debug(
        `admission: worker '${agentId}' queued at position ${admission.position} — waiting for a slot`,
      );
      recordAdmission([]);
      continue;
    }
    startWorker(agentId);
  }
  // The requests' own internal sweeps/drains can have dropped or admitted
  // queued entries without telling this call site (issue #206 review): a
  // dropped entry is a named expiry denial (`denied`), and the failure path
  // below then reaps and reports it.
  await reconcileQueue();

  while (denied === undefined) {
    // Expiries during a worker's run are noticed here, before anything else
    // is decided (issue #206 review).
    if (!(await reconcileQueue())) break;
    let advanced = false;
    // Settled workers are consumed in AGENT order — deterministic, and the
    // order the merge phase expects (the enqueue below is one pass over
    // state.pending).
    for (const agentId of state.pending) {
      if (!started.has(agentId) || handled.has(agentId)) continue;
      if (inFlight.has(agentId)) continue;
      const outcome = finished.get(agentId);
      if (outcome === undefined) continue;
      handled.add(agentId);
      advanced = true;
      if (!outcome.ok) {
        // §81 replacement (issue #175): a crash-class failure is retried
        // through the composition root's replacement seam, bounded by
        // WORKER_REPLACEMENT_LIMIT. The seam decides whether this worker is
        // replaceable at all (it knows the lifecycle status); the run owns
        // the count and the retry.
        const generations = replacementGenerations.get(agentId) ?? [];
        const replacements = replacementCount.get(agentId) ?? 0;
        if (
          deps.replaceWorker !== undefined &&
          outcome.exitCode === RUN_EXIT_FAILED &&
          replacements < WORKER_REPLACEMENT_LIMIT
        ) {
          const replaced = await deps.replaceWorker(agentId);
          if (replaced !== undefined) {
            replacementCount.set(agentId, replacements + 1);
            replacementGenerations.set(agentId, [
              ...(generations.length === 0 ? [replaced.from] : generations),
              replaced.to,
            ]);
            debug(
              `replace: worker '${agentId}' generation ${replaced.from} → ${replaced.to} — retrying in the same session`,
            );
            // The retry IS this worker's next attempt: clear the settled
            // bookkeeping (its failure record is upserted by the attempt
            // that follows) and start it again.
            finished.delete(agentId);
            handled.delete(agentId);
            started.delete(agentId);
            startWorker(agentId);
            continue;
          }
        }
        const failure =
          generations.length === 0
            ? outcome
            : {
                ...outcome,
                message: `${outcome.message} (generations ${generations.join(' → ')})`,
              };
        if (failWorker(agentId, failure) === 'stop') break;
        // The run continues (issue #169): free the failed worker's slot so
        // the queue keeps draining, and move on to the next settled worker.
        releaseSlot(agentId);
        continue;
      }
      releaseSlot(agentId);
    }
    if (denied !== undefined) break;
    if (inFlight.size > 0) {
      await Promise.race([...inFlight.values()]);
      continue;
    }
    if (advanced) continue;
    // Nothing settled and nothing is in flight: every worker either ran, or
    // the queue holds entries no release can ever wake (a request refused
    // against an empty running set, or a gate nothing can free). `handled`
    // keeps this idempotent: under `--on-failure continue` the same agent
    // must not be found and re-recorded forever (issue #206/#169 review).
    const stuck = state.pending.find(
      (agentId) =>
        queued.has(agentId) && !started.has(agentId) && !handled.has(agentId),
    );
    if (stuck === undefined) break;
    const worktree = prepared.get(stuck) as OrchestrateWorktree;
    const message = `spawn denied for worker '${stuck}': queued with no worker left running — the admission layer can never admit this spawn`;
    await recordFailure(stuck, worktree, {
      status: 'spawn_failed',
      kind: 'process',
      code: 'spawn_denied',
      message,
    });
    handled.add(stuck);
    if (
      failWorker(stuck, {
        ok: false,
        exitCode: RUN_EXIT_FAILED,
        code: 'spawn_denied',
        message,
      }) === 'stop'
    ) {
      break;
    }
  }

  if (denied !== undefined) {
    // Stop the siblings still in flight before reporting: the run is failing,
    // so no child may keep spending tokens behind it. `cancelWorker` kills
    // (the lifecycle layer's reap takes the process group), and the awaited
    // promises are the ones already in flight — never a worker that had
    // settled.
    if (inFlight.size > 0) {
      for (const agentId of [...inFlight.keys()]) {
        try {
          await deps.cancelWorker?.(agentId);
        } catch (error) {
          debug(
            `cancel: worker '${agentId}' could not be stopped — ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      await Promise.all([...inFlight.values()]);
    }
    const failure = await reapSpawned(spawned);
    // A reap error must never mask the failure that stopped the run (#171
    // owns collecting them all); the primary code still wins.
    if (failure !== undefined) {
      debug(`reap: worker '${failure.agentId}' failed — ${failure.message}`);
    }
    return fail(denied.exitCode, denied.code, denied.message, partial());
  }

  // Every pending worker settled: persist the write-ahead completions
  // fail-closed (issue #160) — the run never proceeds merge-side without
  // them saved, so a kill at the gate still resumes without re-running.
  {
    const saveFailure = await saveOrFail(state);
    if (saveFailure !== undefined) {
      await reapSpawned(spawned);
      return saveFailure;
    }
  }
  // Every pending worker settled: enqueue the candidates in AGENT order, so
  // the merge order is deterministic whatever the settle order was (issue
  // #206) and the write-ahead intent still travels with one candidate at a
  // time. A worker the run continued past (issue #169) is never enqueued: it
  // did not succeed, so there is nothing to merge, and it stays pending for
  // `--resume` to retry. Skipped on the lane path (issue #431): the lane
  // stages its own queue through `workspace_apply` — the template pass
  // below breaks out immediately instead.
  for (const agentId of state.pending) {
    if (laneMode) break;
    // A worker the run continued past (issue #169), and — issue #277 — one the
    // user refused past the concurrency cap: neither succeeded, so there is
    // nothing to merge; both stay pending for `--resume` to retry. A worker
    // past the --agents spawn cap (issue #413) never spawned either.
    if (
      partialFailures.has(agentId) ||
      deniedSpawns.has(agentId) ||
      cappedSpawns.has(agentId)
    ) {
      continue;
    }
    const worktree = prepared.get(agentId) as OrchestrateWorktree;
    queue.enqueue({ agentId, branch: worktree.branch });
    enqueuedAtMs.set(agentId, now());
    debug(`spawn: worker '${agentId}' in ${worktree.path}`);
  }

  // Step 7 (issue #431): the model-driven manager lane. The template path
  // above no-ops here (empty pending, empty in-flight), and the merge phase
  // below runs unchanged — the lane stages the same queue the template
  // enqueue would have, settles the same registries the merge asserts
  // over, and records the same write-ahead completions a kill resumes
  // from. The faux/template fallback stays: this whole section runs only
  // when a manager model resolved.
  if (laneMode) {
    if (laneModel === undefined || laneCatalog === undefined) {
      return fail(
        RUN_EXIT_FAILED,
        'lane_resume_failed',
        `cannot drive the lane run '${sessionId}': no manager model is wired — refusing rather than re-planning as a template`,
        undefined,
        state.agents,
      );
    }
    if (deps.openManagerSession === undefined) {
      return fail(
        RUN_EXIT_FAILED,
        'lane_session_failed',
        `cannot drive the lane run '${sessionId}': no manager-session seam is wired — refusing rather than running without a transcript`,
        undefined,
        state.agents,
      );
    }
    const managerSessionId = state.managerSessionId ?? sessionId;
    let managerSession: SessionHandle;
    try {
      managerSession = await deps.openManagerSession(managerSessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(
        RUN_EXIT_FAILED,
        'lane_session_failed',
        `cannot drive the lane run '${sessionId}': the manager session '${managerSessionId}' refused to attach — ${message}`,
        undefined,
        state.agents,
      );
    }
    // Minted ids are unique across the roster AND the run's own mints
    // (issue #431): a resume re-seeds from the stored agents, so a
    // re-driven lane never re-mints an id the first drive already used —
    // and a roster id shaped like a mint is skipped, never collided with.
    const takenIds = new Set(state.agents);
    let mintCounter = 0;
    for (const agentId of state.agents) {
      const match = /^worker-(\d+)$/.exec(agentId);
      if (match !== null) {
        mintCounter = Math.max(mintCounter, Number(match[1]));
      }
    }
    const preflighted = new Set<string>();
    const cancelledByManager = new Set<string>();
    const releasedSlots = new Set<string>();
    const stagedForMerge: string[] = [];
    const mergeHeads = createMergeHeadCursor(stagedForMerge);
    const consumedFailures = new Set<string>();
    // The drive's view of the run: restored settlements (a resume's
    // completions and merge records) plus every mint the lane spawns.
    const tracked = new Set<string>();
    const settledAgentResult = (agentId: string): AgentResult => {
      const settled = resultsByAgent.get(agentId);
      if (settled !== undefined) return settled;
      // Belt: `runWorkerOnce` always records a result (its own or a
      // synthesized failure), so a settlement without one is a bug in
      // that conversion — synthesized here in the same shape rather than
      // wedging `collect_result` on `collect_before_settle` forever.
      const synthesized = buildAgentResult({
        status: 'completed',
        summary: `worker '${agentId}' settled without a report`,
        provenance: {
          workerId: agentId,
          sessionId: workerSessionFor(sessionId, agentId),
          pid: null,
          generation: 0,
          worktree: worktrees.get(agentId)?.path ?? NO_WORKTREE,
          model: UNRESOLVED_MODEL,
        },
        metrics: { wallMs: 0, latencyMs: 0 },
      });
      resultsByAgent.set(agentId, synthesized);
      return synthesized;
    };
    const releaseSlotOnce = (agentId: string): void => {
      if (releasedSlots.has(agentId)) return;
      releasedSlots.add(agentId);
      releaseSlot(agentId);
    };
    const routerDeps: ManagerToolsDeps = {
      sessionId,
      // The run's derived §19 mode (issues #278/#207) — never a fixed
      // value. The template path hardcodes 'autonomous' past its
      // spawn-cap ask (that ask owns the interactive branch); the lane
      // has no such ask, so admission follows the mode the operator
      // chose: an interactive run fail-fasts a blocked spawn, an
      // autonomous one queues it.
      runMode,
      scheduler,
      spawnCap,
      // Settlement is guaranteed by `startWorker`'s never-rejecting
      // tasks: every launch settles into `finished`, so the wait needs no
      // clock of its own — the lane's own tool-call bound is the backstop.
      waitTimeoutMs: Number.POSITIVE_INFINITY,
      validRoles: [
        ...BUILTIN_ROLE_NAMES,
        ...new Set(rolePlan.assignments.map((assignment) => assignment.role)),
      ],
      resolveRole: (roleName) => {
        if (isBuiltinRole(roleName)) {
          // The role's tools are role-level, never per-agent: any roster
          // assignment resolved under the same documents carries them
          // (the embedded §12 presets ship with the binary, issue #203,
          // so this works with no repo documents). Only tools and prompt
          // travel — a matched agent's personal model pin never leaks
          // onto a mint (#202 precedence stays per-agent).
          const match = rolePlan.assignments.find(
            (entry) => entry.role === roleName,
          );
          return {
            promptText: match?.promptText ?? '',
            tools: [...(match?.tools ?? [])],
            modelRef: undefined,
            thinking: ROLE_THINKING_DEFAULTS[roleName],
            // Issue #196: the mint runs under this role's documents, so
            // its classes and obligations travel — never a bare spawn.
            ...(match?.classes === undefined
              ? {}
              : { classes: { ...match.classes } }),
            ...(match?.requires === undefined
              ? {}
              : { requires: [...match.requires] }),
            // Issue #198 (#431 follow-up): the same documents' budget
            // dims travel as the fallback tier under an explicit
            // spawn_agent(budget=…) — absent stays absent.
            ...(match?.budget === undefined
              ? {}
              : { budget: { ...match.budget } }),
          };
        }
        const assignment = rolePlan.assignments.find(
          (entry) => entry.role === roleName,
        );
        if (assignment === undefined) return undefined;
        return {
          promptText: assignment.promptText,
          tools: [...assignment.tools],
          modelRef: assignment.modelRef,
          thinking: assignment.thinking,
          // Issue #196: same documents as the tools above.
          ...(assignment.classes === undefined
            ? {}
            : { classes: { ...assignment.classes } }),
          ...(assignment.requires === undefined
            ? {}
            : { requires: [...assignment.requires] }),
          // Issue #198 (#431 follow-up): the fallback tier, as above.
          ...(assignment.budget === undefined
            ? {}
            : { budget: { ...assignment.budget } }),
        };
      },
      spawnedIds: () => [...spawned],
      noteSpawned: () => undefined,
      mintAgentId: () => {
        let candidate = '';
        do {
          mintCounter += 1;
          candidate = `worker-${mintCounter}`;
        } while (takenIds.has(candidate));
        takenIds.add(candidate);
        return candidate;
      },
      onSpawned: (agentId, role, task) => {
        const spec = routerDeps.resolveRole(role);
        laneSpawnRoles.set(agentId, {
          role,
          tools: [...(spec?.tools ?? [])],
          modelRef: spec?.modelRef,
          thinking: spec?.thinking,
          ...(spec?.classes === undefined
            ? {}
            : { classes: { ...spec.classes } }),
          ...(spec?.requires === undefined
            ? {}
            : { requires: [...spec.requires] }),
          // Issue #198 (#431 follow-up): the document dims ride the
          // mint so the per-spawn gate finds them by minted id.
          ...(spec?.budget === undefined ? {} : { budget: { ...spec.budget } }),
        });
        tracked.add(agentId);
        // The lane has no template plan: the mint's plan step IS its
        // worker prompt — the role text composed with the task, exactly
        // as `applyRolesToPlan` composes the template's steps — so the
        // child runs what the manager asked, never the bare objective.
        const plan = [...(state.plan ?? [])];
        plan.push({
          agentId,
          step: 1,
          total: 1,
          prompt: composeWorkerPrompt(spec?.promptText ?? '', task),
          role,
        });
        state = { ...state, plan };
      },
      prepareWorker: async (agentId) => {
        // The §36.3 preflight (issue #200) per mint, once per
        // role+model: the template preflight above only saw the roster,
        // so a mint's credentials are probed at its first spawn — a
        // refusal names the provider before any worktree exists.
        const info = laneSpawnRoles.get(agentId);
        const preflightKey = `${info?.role ?? 'worker'}::${info?.modelRef ?? ''}`;
        if (!preflighted.has(preflightKey)) {
          preflighted.add(preflightKey);
          if (deps.preflightWorkerCredentials !== undefined) {
            const refusal = deps.preflightWorkerCredentials([
              {
                agentId,
                role: info?.role ?? 'worker',
                ...(info?.modelRef === undefined
                  ? {}
                  : { modelRef: info.modelRef }),
              },
            ]);
            if (refusal !== undefined) {
              throw new Error(
                `worker '${agentId}' (${refusal.role}): ${refusal.message}`,
              );
            }
          }
        }
        // The template prepare loop, minus its roster guards: the cap
        // already bound at mint time, and denials never reach the lane.
        // Resume reuses the retained worktree, never ensures twice.
        resultsByAgent.delete(agentId);
        let worktree = worktrees.get(agentId);
        if (worktree === undefined) {
          const creationStartedAt = now();
          worktree = await deps.ensureWorktree(agentId, worktreeRequest);
          worktreeMsByAgent.set(
            agentId,
            Math.max(0, now() - creationStartedAt),
          );
          worktrees.set(agentId, worktree);
        }
        prepared.set(agentId, worktree);
        return { agentId, worktreePath: worktree.path };
      },
      launchWorker: async (request: WorkerSpawnRequest) => {
        startWorker(request.agentId);
        const task = inFlight.get(request.agentId);
        if (task === undefined) {
          throw new Error(
            `lane: worker '${request.agentId}' was never launched — the spawn adapter's launch did not start it`,
          );
        }
        await task;
        observeAdmission();
        return settledAgentResult(request.agentId);
      },
      inspectWorker: (agentId) => {
        if (!spawned.includes(agentId)) return undefined;
        const worktree = prepared.get(agentId) ?? worktrees.get(agentId);
        const result = resultsByAgent.get(agentId);
        const outcome = finished.get(agentId);
        const info = laneSpawnRoles.get(agentId);
        const row: WorkerRowInfo = {
          agentId,
          branch: worktree?.branch ?? `kubic/${sessionId}/${agentId}`,
          role: info?.role ?? 'worker',
          status: cancelledByManager.has(agentId)
            ? 'cancelled'
            : outcome === undefined
              ? 'running'
              : outcome.ok
                ? 'completed'
                : 'failed',
          summary:
            result?.summary ??
            (outcome === undefined
              ? 'still running'
              : `settled: ${outcome.ok ? 'ok' : outcome.code}`),
        };
        return row;
      },
      cancelWorker: async (agentId) => {
        cancelledByManager.add(agentId);
        try {
          await deps.cancelWorker?.(agentId);
        } finally {
          releaseSlotOnce(agentId);
        }
      },
      runFollowUp: async (agentId, promptText) => {
        const worktree = prepared.get(agentId);
        if (worktree === undefined) {
          throw new ManagerToolRefusalError(
            'unknown_agent',
            `no worker '${agentId}' was prepared by this run`,
          );
        }
        const output = runOutputOf(
          await deps.runWorker(agentId, worktree, promptText, {
            sessionId,
            workerSessionId: workerSessionFor(sessionId, agentId),
            ...(worktreeMsByAgent.get(agentId) === undefined
              ? {}
              : { worktreeMs: worktreeMsByAgent.get(agentId) as number }),
            ...spawnRoleInfo(agentId, rolePlan),
            ...(effectiveSkills.length === 0
              ? {}
              : { skills: [...effectiveSkills], skillsCwd: process.cwd() }),
          }),
        );
        if (output.result !== undefined) {
          resultsByAgent.set(agentId, output.result);
        }
        const result = output.result ?? settledAgentResult(agentId);
        upsertCompleted({
          agentId,
          branch: worktree.branch,
          hunks: [...output.hunks],
          result,
        });
        try {
          await deps.saveState?.(state);
        } catch (error) {
          debug(
            `state: follow-up completion for '${agentId}' not saved — ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return result;
      },
      readWorkerChange: async (agentId, worktreePath, base) => {
        // Issue #416's `(agentId, worktree, base?)` contract: the adapter
        // passes the worktree path it tracked at spawn as the second
        // positional (a pre-#431 two-arg implementation read it as the
        // base ref — every diff failed `ambiguous argument`). The branch
        // always resolves from the run's own maps: the adapter tracks
        // paths, never branch names.
        const entry = prepared.get(agentId) ?? worktrees.get(agentId);
        if (entry === undefined) {
          throw new ManagerToolRefusalError(
            'unknown_agent',
            `no worker '${agentId}' was prepared by this run`,
          );
        }
        const worktree =
          typeof worktreePath === 'string' && worktreePath !== ''
            ? { path: worktreePath, branch: entry.branch }
            : entry;
        // Gap 1 (#416 review): the model-supplied base is validated as a
        // git ref BEFORE it reaches git — never a flag, never a range
        // escape. The default base is the merge-base the run branched
        // from... unknown here, so HEAD names the comparison point.
        const revision = base ?? 'HEAD';
        assertGitRef(revision);
        assertGitRef(worktree.branch);
        const seam = deps.inspectGit;
        if (seam === undefined) {
          throw new ManagerToolRefusalError(
            'git_failed',
            `no git inspection seam is wired for worker '${agentId}' — the builder did not provide one`,
          );
        }
        const patch = await seam('git_diff', {
          range: `${revision}...${worktree.branch}`,
        });
        const filesChanged: string[] = [];
        for (const line of patch.split('\n')) {
          const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
          if (header === null) continue;
          const name = (header[2] ?? '').replace(/^"|"$/g, '');
          if (name !== '' && !filesChanged.includes(name)) {
            filesChanged.push(name);
          }
        }
        const change: WorkerChange = { agentId, filesChanged, patch };
        return change;
      },
      stageWorker: async (agentId, branch) => {
        // An already-merged worker is never re-staged (issue #431): a
        // resumed lane whose transcript still says "merge" after the
        // merge already landed gets a named refusal, never a double
        // merge. FIFO order is the stage order — the manager cannot
        // reorder the queue, only choose what enters it.
        if (state.merged.includes(agentId)) {
          throw new ManagerToolRefusalError(
            'already_merged',
            `worker '${agentId}' is already merged — refusing to stage it again`,
          );
        }
        const worktree = prepared.get(agentId) ?? worktrees.get(agentId);
        if (worktree === undefined || worktree.branch !== branch) {
          throw new ManagerToolRefusalError(
            'unknown_agent',
            `no worker '${agentId}' on branch '${branch}' was prepared by this run`,
          );
        }
        if (!stagedForMerge.includes(agentId)) {
          stagedForMerge.push(agentId);
          queue.enqueue({ agentId, branch });
          enqueuedAtMs.set(agentId, now());
        }
        return { position: stagedForMerge.indexOf(agentId) + 1 };
      },
      applyStaged: async () => {
        const agentId = mergeHeads.nextHead();
        if (agentId === undefined) return undefined;
        return { agentId };
      },
      askSeat: (question) =>
        withAskTimeout(
          deps.askUserSeat?.(question) ??
            Promise.resolve({
              answered: false,
              code: QUESTION_UNANSWERED_CODE,
              reason: 'no ask seat is wired for this run',
            }),
          deps.approvalPolicy?.maxPendingMs ?? ORCHESTRATE_APPROVAL_BOUND_MS,
        ),
      inspectGit: async (tool, args) => {
        const seam = deps.inspectGit;
        if (seam === undefined) {
          throw new ManagerToolRefusalError(
            'git_failed',
            `no git inspection seam is wired — the builder did not provide one`,
          );
        }
        return seam(tool, args);
      },
    };
    const toolset = buildManagerTools(routerDeps);
    // The settle hook: every launch settles through `startWorker`, so the
    // registry observes the run's own bookkeeping — `wait_for_agent` wakes
    // on what the run will merge, and the slot is freed exactly once.
    const settleTools = toolset.settle;
    laneSettleHook = (agentId: string): void => {
      releaseSlotOnce(agentId);
      observeAdmission();
      try {
        settleTools.noteSettled(agentId, settledAgentResult(agentId));
      } catch (error) {
        debug(
          `lane: settle note for '${agentId}' failed — ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
    // A resume restores the prior drive's settlements into the fresh
    // registry (issue #160 write-ahead, completed or merged): the lane
    // continues from what already settled instead of re-running it.
    // Restored entries re-prepare their worktrees (retained on disk) so
    // rows, diffs and stages all resolve.
    const restoreSettled = async (agentId: string): Promise<void> => {
      const completed = state.completed?.find(
        (entry) => entry.agentId === agentId,
      );
      const record = state.records.find((entry) => entry.agentId === agentId);
      const result = completed?.result ?? record?.result;
      if (result === undefined && completed === undefined) return;
      let worktree = worktrees.get(agentId);
      if (worktree === undefined) {
        try {
          worktree = await deps.ensureWorktree(agentId, worktreeRequest);
        } catch {
          return;
        }
        worktrees.set(agentId, worktree);
      }
      prepared.set(agentId, worktree);
      if (completed !== undefined) {
        hunksByAgent.set(agentId, [...completed.hunks]);
      }
      const settled = result ?? settledAgentResult(agentId);
      resultsByAgent.set(agentId, settled);
      settleTools.seedSettled(agentId, settled);
      tracked.add(agentId);
    };
    // Restored mints keep their role narrowing (issue #431): the plan
    // step recorded the mint's role, so a resumed follow-up resolves the
    // same tools/model the first drive launched with.
    for (const step of (state.plan ?? []) as ManagerPlanStep[]) {
      if (step.role !== undefined) {
        const spec = routerDeps.resolveRole(step.role);
        laneSpawnRoles.set(step.agentId, {
          role: step.role,
          tools: [...(spec?.tools ?? [])],
          modelRef: spec?.modelRef,
          thinking: spec?.thinking,
          ...(spec?.classes === undefined
            ? {}
            : { classes: { ...spec.classes } }),
          ...(spec?.requires === undefined
            ? {}
            : { requires: [...spec.requires] }),
          // Issue #198 (#431 follow-up): re-resolved, so a resumed
          // drive keeps the same document fallback as the first.
          ...(spec?.budget === undefined ? {} : { budget: { ...spec.budget } }),
        });
      }
    }
    for (const agentId of state.agents) {
      await restoreSettled(agentId);
    }
    let boundTripped = false;
    let currentSubmission:
      | Awaited<ReturnType<ManagerLaneHandle['conversation']['submit']>>
      | undefined;
    const bounded = withManagerToolCallBound(toolset, {
      maxToolCalls: MANAGER_MAX_TOOL_CALLS,
      onTrip: () => {
        boundTripped = true;
      },
      abortCurrent: () => {
        void currentSubmission
          ?.abort(BACKGROUND_CONTEXT)
          .catch(() => undefined);
      },
    });
    const lane = await bootManagerLane({
      session: managerSession,
      models: laneCatalog,
      model: laneModel,
      sessionId: managerSessionId,
      cwd: process.cwd(),
      tools: managerToolRegistrations(bounded),
    });
    try {
      // A fresh drive never inherits a transcript (issue #431): the
      // state-exists guard above already refuses a stored run, so a
      // non-empty manager session here is an orphan — refused, never
      // silently continued.
      if (!parsed.resume) {
        const existing = await lane.conversation.entries(
          {},
          1,
          undefined,
          BACKGROUND_CONTEXT,
        );
        if (existing.items.length > 0) {
          return fail(
            RUN_EXIT_FAILED,
            'lane_session_failed',
            `cannot drive the lane run '${sessionId}': the manager session '${managerSessionId}' already has a transcript — dispose it first, it belongs to no stored run`,
            undefined,
            state.agents,
          );
        }
      }
      if (state.spawnCap === 0) {
        return fail(
          RUN_EXIT_USAGE,
          'no_workers',
          `cannot drive the lane run '${sessionId}': --agents names no workers and the lane mints against a zero cap — name at least one worker`,
          undefined,
          state.agents,
        );
      }
      let submissions = 0;
      const objective = parsed.prompt ?? state.prompt;
      if (objective === undefined || objective.trim() === '') {
        return fail(
          RUN_EXIT_USAGE,
          'no_prompt',
          `cannot drive the lane run '${sessionId}': no prompt objective — pass --prompt`,
          undefined,
          state.agents,
        );
      }
      const driveStatus = (): string => {
        const ids = [...tracked].sort();
        const settled = ids.filter(
          (agentId) => settleTools.resultOf(agentId) !== undefined,
        );
        const running = ids.filter(
          (agentId) =>
            started.has(agentId) &&
            !finished.has(agentId) &&
            !cancelledByManager.has(agentId),
        );
        return `lane status: ${settled.length}/${ids.length} settled${running.length === 0 ? '' : `, running: ${running.join(', ')}`}. Continue driving the run: wait for settlements, collect results, stage and merge finished work, then give your final summary.`;
      };
      const driveComplete = (): boolean => {
        for (const agentId of tracked) {
          if (settleTools.resultOf(agentId) === undefined) return false;
        }
        return true;
      };
      // A resume continues the restored transcript — re-submitting the
      // full objective would duplicate the transcript's first input — so
      // the first post-resume input is the status nudge, not the objective.
      // L-D34 fail-fast (issue #431): the drive carries a wall-clock
      // deadline — a provider that never answers (or answers with a
      // transport failure) ends the run with `lane_provider_unreachable`,
      // never a hang inside durable retries. The deadline is a drive
      // total: each turn races only its remainder.
      const driveDeadlineBoundMs =
        deps.managerDriveDeadlineMs ?? MANAGER_DRIVE_DEADLINE_MS;
      const driveDeadlineAt = Date.now() + driveDeadlineBoundMs;
      const failUnreachable = async (
        detail: string,
      ): Promise<ReturnType<typeof fail>> => {
        const failure = await reapSpawned(spawned);
        if (failure !== undefined) {
          debug(
            `reap: worker '${failure.agentId}' failed — ${failure.message}`,
          );
        }
        return fail(
          RUN_EXIT_FAILED,
          LANE_PROVIDER_UNREACHABLE_CODE,
          detail,
          partial(),
        );
      };
      // Aborts the live submission when a wait outlives the deadline —
      // best-effort (an abort rejection never masks the timeout itself),
      // and clears the slot so the next turn starts clean.
      const abortCurrentSubmission = async (): Promise<void> => {
        const live = currentSubmission;
        currentSubmission = undefined;
        if (live === undefined) return;
        try {
          await live.abort(BACKGROUND_CONTEXT);
        } catch {
          // Best-effort: the timeout below is what the drive reports.
        }
      };
      // A submit/wait rejection that names the network (or the deadline
      // itself) ends the run by name; anything else keeps its own
      // handling — a model or usage error is never misclassified.
      const unreachableIfTransport = async (
        error: unknown,
      ): Promise<number | undefined> => {
        const transport =
          error instanceof LaneDriveTimeoutError
            ? error.message
            : describeLaneTransportError(error);
        if (transport === undefined) return undefined;
        return failUnreachable(
          `${transport} — refusing with '${LANE_PROVIDER_UNREACHABLE_CODE}' rather than hanging the run`,
        );
      };
      let input = parsed.resume ? driveStatus() : objective;
      for (;;) {
        const remainingMs = driveDeadlineAt - Date.now();
        if (remainingMs <= 0) {
          return failUnreachable(
            `the manager provider did not answer within the drive deadline (${driveDeadlineBoundMs}ms) — refusing with '${LANE_PROVIDER_UNREACHABLE_CODE}' rather than hanging the run`,
          );
        }
        try {
          currentSubmission = await waitLaneSubmissionWithDeadline(
            lane.conversation.submit(
              { type: 'input', content: input },
              BACKGROUND_CONTEXT,
            ),
            { remainingMs, onTimeout: abortCurrentSubmission },
          );
        } catch (error) {
          currentSubmission = undefined;
          const unreachable = await unreachableIfTransport(error);
          if (unreachable !== undefined) return unreachable;
          throw error;
        }
        let settledSubmission: Awaited<
          ReturnType<NonNullable<typeof currentSubmission>['wait']>
        >;
        try {
          settledSubmission = await waitLaneSubmissionWithDeadline(
            (currentSubmission as NonNullable<typeof currentSubmission>).wait(
              BACKGROUND_CONTEXT,
            ),
            {
              remainingMs: driveDeadlineAt - Date.now(),
              onTimeout: abortCurrentSubmission,
            },
          );
        } catch (error) {
          const unreachable = await unreachableIfTransport(error);
          if (unreachable !== undefined) return unreachable;
          throw error;
        }
        currentSubmission = undefined;
        submissions += 1;
        // A turn that settles without an answer is a provider-side failure
        // (a working provider always places one): the run names the
        // provider, never succeeds vacuously on its silence.
        if (settledSubmission.status !== 'done') {
          return failUnreachable(
            `the manager provider left the turn unanswered — refusing with '${LANE_PROVIDER_UNREACHABLE_CODE}' rather than succeeding vacuously on its silence`,
          );
        }
        // The run's own policy still binds the lane (issues #169/#175): a
        // newly settled failure goes through `failWorker` — under `stop`
        // the drive ends here and the run fails below; under `continue`
        // the slot is already freed by the settle hook. No automatic
        // replacement: the manager owns the retry (re-spawn or follow-up).
        for (const agentId of [...tracked]) {
          if (consumedFailures.has(agentId)) continue;
          const outcome = finished.get(agentId);
          if (outcome === undefined || outcome.ok) continue;
          consumedFailures.add(agentId);
          if (failWorker(agentId, outcome) === 'stop') {
            denied = outcome;
            break;
          }
        }
        if (denied !== undefined || boundTripped) break;
        if (driveComplete()) break;
        if (submissions >= MANAGER_MAX_SUBMISSIONS) {
          boundTripped = true;
          break;
        }
        observeAdmission();
        input = driveStatus();
      }
      const entries = await lane.conversation.entries(
        {},
        1000,
        undefined,
        BACKGROUND_CONTEXT,
      );
      const realCalls = managerCallsFromLane([...entries.items].reverse());
      for (const step of realCalls) laneCalls.push(step);
      const finalText = managerFinalMessage([...entries.items].reverse());
      if (finalText !== undefined) {
        state = { ...state, managerSummary: finalText };
      }
      if (boundTripped || denied !== undefined) {
        const tripCode = boundTripped ? MANAGER_TURN_BOUND_CODE : denied?.code;
        const tripMessage = boundTripped
          ? `the manager lane exceeded its turn backstop (${MANAGER_MAX_TOOL_CALLS} tool calls / ${MANAGER_MAX_SUBMISSIONS} submissions) — stopping the drive with ${state.merged.length} merged; settled work is saved, retry with \`--resume --session ${sessionId}\``
          : (denied?.message ?? 'the run was stopped');
        if (inFlight.size > 0) {
          for (const agentId of [...inFlight.keys()]) {
            try {
              await deps.cancelWorker?.(agentId);
            } catch (error) {
              debug(
                `cancel: worker '${agentId}' could not be stopped — ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
          await Promise.all([...inFlight.values()]);
        }
        {
          const saveFailure = await saveOrFail(state);
          if (saveFailure !== undefined) {
            await reapSpawned(spawned);
            return saveFailure;
          }
        }
        const failure = await reapSpawned(spawned);
        if (failure !== undefined) {
          debug(
            `reap: worker '${failure.agentId}' failed — ${failure.message}`,
          );
        }
        return fail(
          RUN_EXIT_FAILED,
          tripCode ?? 'manager_turn_bound',
          tripMessage,
          partial(),
        );
      }
      // The drive settled everything it tracked: pending names the
      // unmerged remainder for the merge loop and `--resume`, and the
      // minted ids join the run's agents so rows, graph and state agree.
      state.agents.push(
        ...[...tracked].filter((agentId) => !state.agents.includes(agentId)),
      );
      state.pending = [...tracked].filter(
        (agentId) =>
          !state.merged.includes(agentId) && !partialFailures.has(agentId),
      );
      {
        const saveFailure = await saveOrFail(state);
        if (saveFailure !== undefined) {
          await reapSpawned(spawned);
          return saveFailure;
        }
      }
    } finally {
      laneSettleHook = undefined;
      // Fail-fast hygiene (issue #431, L-D34): a drive that died on an
      // unreachable provider leaves a hung generation behind — abort the
      // conversation before closing so the shutdown never waits on it.
      // Best-effort and idle-safe: on the happy path there is nothing
      // live to abort.
      try {
        await lane.conversation.abort(BACKGROUND_CONTEXT);
      } catch {
        // The abort is hygiene; the close below owns the outcome.
      }
      await lane.close(BACKGROUND_CONTEXT);
      // The session lock is the only cross-process guard (the durable
      // store has none): handing it back lets a later `--resume`
      // re-attach. After the harness closed — never before.
      await managerSession.release(BACKGROUND_CONTEXT);
    }
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
    // Issue #156 (§45.2, §41.2): the sequence now includes the approval
    // surface — the resolver is a delegated child like any other, so its
    // challenged calls are ROUTED to the user through the run's router (the
    // same one its workers used) instead of denying closed on a mailbox it was
    // never told about. The scope names the worktree it reworks and the role
    // the spec assigned, and a termination ends THIS resolution with the
    // named denial, so the operator reads it in the merge_conflict note.
    const resolverApprovals =
      approvalsRun === undefined
        ? undefined
        : {
            run: approvalsRun,
            scope: {
              sessionId,
              agentId,
              worktree: worktree.path,
              role: spec.role,
            } satisfies WorkerApprovalScope,
          };
    recordLaneSequence();
    if (resolverApprovals !== undefined) {
      resolverApprovals.run.beginWorker(resolverApprovals.scope);
    }
    let outcome: ResolverOutcome;
    try {
      outcome = await deps.runResolver({
        agentId,
        worktree: { path: worktree.path, branch: worktree.branch },
        spec,
        prompt: resolverPromptFor(spec),
        // §67 task resources (issue #170): the resolver is a child like any
        // other, so it gets the same skills (L-D9).
        ...(effectiveSkills.length === 0
          ? {}
          : { skills: [...effectiveSkills] }),
      });
    } catch (error) {
      // A resolver that throws may still have ended on a named approval
      // termination (its ask was denied while the child died): prefer that
      // outcome over the raw exception, and take it out of the map so a later
      // resolution does not inherit it (issue #156 review).
      const message = error instanceof Error ? error.message : String(error);
      const termination = resolverApprovals?.run.takeTermination(agentId);
      resolverApprovals?.run.endWorker(agentId);
      if (termination !== undefined) {
        debug(
          `resolution: resolver '${agentId}' ended on ${termination.code} — ${termination.message}`,
        );
        return { outcome: 'failed', message: termination.message };
      }
      debug(`resolution: resolver failed for '${agentId}' — ${message}`);
      return { outcome: 'failed', message };
    }
    if (resolverApprovals !== undefined) {
      // The settle-time pump is the resolver's last chance to be heard: an ask
      // that raced its exit is routed now, and the resolver's terminal
      // outcome is read after every ask has been answered.
      const raced = await resolverApprovals.run.pump(resolverApprovals.scope);
      resolverApprovals.run.endWorker(agentId);
      const termination =
        raced ?? resolverApprovals.run.takeTermination(agentId);
      if (termination !== undefined) {
        debug(
          `resolution: resolver '${agentId}' ended on ${termination.code} — ${termination.message}`,
        );
        return { outcome: 'failed', message: termination.message };
      }
    }
    if (outcome.resolved !== true) {
      debug(
        `resolution: resolver could not settle '${agentId}' — ${outcome.reason}`,
      );
      return { outcome: 'failed', message: outcome.reason };
    }
    debug(
      `resolved: ${agentId} by a ${spec.role} resolver (${spec.conflict.files.length} conflicted file(s)) — re-merging`,
    );
    return { outcome: 'delegated' };
  };

  // The `--yes` pointer on a merge-gate refusal exists only where that flag
  // does (issue #327).
  const yesHintText =
    deps.yesHint === false ? '' : ' — rerun with --yes to auto-approve merges';

  // Settle FIFO: approve → persist the write-ahead merge intent →
  // pre-merge guard → prove the manager trace write-free → merge →
  // attribute → record. Each merge is atomic per candidate and recorded
  // before the next dequeues, so a kill between merges resumes cleanly.
  let candidate = queue.dequeue();
  while (candidate !== undefined) {
    const { agentId } = candidate;
    const worktree = worktrees.get(agentId) as OrchestrateWorktree;
    // §61 (issue #158): the merge phases this loop owns. `diffMs` is the
    // worker's own branch-diff read, reported through `runWorker`; the queue
    // leg is the wait from enqueue to this dequeue.
    const queuedAtMs = enqueuedAtMs.get(agentId) ?? now();
    const queueMs = Math.max(0, now() - queuedAtMs);
    const diffMs = diffMsByAgent.get(agentId) ?? 0;
    let resolveMs = 0;
    let outcome: MergeOutcome = 'merged';
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
    deps.auditMerge?.({
      sessionId,
      agentId,
      branch: worktree.branch,
      worktree: worktree.path,
      approved: verdict.verdict === 'approve',
      by: parsed.autoApprove ? '--yes' : 'user',
      ...(verdict.verdict === 'timeout'
        ? { reason: `timed out after ${verdict.maxPendingMs}ms` }
        : verdict.verdict === 'deny'
          ? { reason: 'denied' }
          : {}),
    });
    if (verdict.verdict !== 'approve') {
      // The gate's verdict ends this candidate before any merge leg ran: the
      // record still names it (the queue wait was measured) with every merge
      // phase at 0, so the operator reads the denial instead of a candidate
      // that silently vanished from the table.
      mergeTelemetry.push(
        recordMergeTelemetry({
          agentId,
          queueMs,
          diffMs,
          mergeMs: 0,
          resolveMs: 0,
          applyMs: 0,
          outcome:
            verdict.verdict === 'timeout'
              ? 'approval-timeout'
              : 'approval-denied',
        }),
      );
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
          `approval timed out after ${verdict.maxPendingMs}ms for worker '${agentId}': nobody answered the merge gate${yesHintText}`,
          partial(),
        );
      }
      return fail(
        RUN_EXIT_APPROVAL_DENIED,
        'approval_denied',
        `approval denied for worker '${agentId}': the decider is the user${yesHintText}`,
        partial(),
      );
    }
    state = { ...state, merging: agentId };
    // §61 (issue #158): the merge leg starts HERE, after the gate. The gate is
    // a human-paced wait (a bounded seat can hold it for tens of seconds) and
    // §61 budgets the merge itself, so that wait belongs to no phase — mergeMs
    // covers workspace_merge only, exactly as resolveMs is kept apart from it.
    const mergeStartedAt = now();
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
      // L-D33 (issue #431): the lane's settle handoff runs through the
      // settle apply path — the recorded trace is proven write-free a
      // second time (the shipped guard, which no injected seam can stub
      // out) and the merge gate's approval above is the review verdict
      // routing to apply (deny/timeout already returned; a reviewer role
      // under #188 will supply its own verdict here). The registry's
      // `apply` is sync while the branch merge is async — and must stay
      // inside this try/catch so a conflict routes to the resolver — so
      // the decision gates the merge below instead of performing it.
      const decision = applySettlementAfterReview(
        managerCallsForMerge(laneCalls),
        { verdict: 'accept' },
        () => undefined,
      );
      if (decision !== 'apply') {
        // Unreachable today: the verdict above is literally accept. A
        // reviewer that can refuse (#188) will handle discard here —
        // skipping the merge while recording the candidate as merged
        // would be a silent loss, so this fails loud instead.
        throw new Error(
          `merge for worker '${agentId}' discarded by review — no discard path yet (issue #188)`,
        );
      }
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
      const resolveStartedAt = now();
      const attempt = await delegateConflict(agentId, worktree, conflict);
      resolveMs += Math.max(0, now() - resolveStartedAt);
      if (attempt.outcome === 'delegated') outcome = 'resolved-merged';
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
      mergeTelemetry.push(
        recordMergeTelemetry({
          agentId,
          queueMs,
          diffMs,
          mergeMs: Math.max(0, now() - mergeStartedAt - resolveMs),
          resolveMs,
          applyMs: 0,
          outcome: 'stopped-unresolvable',
        }),
      );
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
      mergeTelemetry.push(
        recordMergeTelemetry({
          agentId,
          queueMs,
          diffMs,
          mergeMs: Math.max(0, now() - mergeStartedAt - resolveMs),
          resolveMs,
          applyMs: 0,
          // Nothing is discarded: the branch and worktree stay as evidence
          // (§44.1) and `state.pending` keeps the worker for `--resume`.
          outcome: 'merge-failed',
        }),
      );
      await reapSpawned(spawned);
      return fail(
        RUN_EXIT_FAILED,
        'merge_failed',
        `merge failed for worker '${agentId}': ${message}`,
        partial(),
      );
    }
    const hunks = hunksByAgent.get(agentId) ?? [];
    const result = resultsByAgent.get(agentId);
    // §61 (issue #158): the apply leg starts here — attribute the hunks,
    // record the worker and persist the state.
    const appliedAtMs = now();
    // An upsert: a resumed retry replaces the failure record kept from the
    // attempt that failed (issue #185) instead of listing the worker twice.
    // The write-ahead completion moves to the merge records (issue #160),
    // so `completed` never names a merged worker.
    moveCompletedToRecords({
      agentId,
      branch: worktree.branch,
      hunks,
      ...(result === undefined ? {} : { result }),
    });
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
    // §61 (issue #158): the apply/bookkeeping leg — attribute, record and
    // persist the merge — then the per-agent record.
    mergeTelemetry.push(
      recordMergeTelemetry({
        agentId,
        queueMs,
        diffMs,
        // The merge leg ENDS where the apply leg begins: the bookkeeping that
        // follows is applyMs, never merge time.
        mergeMs: Math.max(0, appliedAtMs - mergeStartedAt - resolveMs),
        resolveMs,
        applyMs: Math.max(0, now() - appliedAtMs),
        outcome,
      }),
    );
    candidate = queue.dequeue();
  }

  // Issue #277: the refused over-cap spawn is this run's terminus, reported
  // after every in-cap candidate settled — the same partial-failure shape a
  // worker failure takes, with the denial named.
  if (deniedSpawns.size > 0) {
    const refused = state.agents.find((agentId) => deniedSpawns.has(agentId));
    const reason = refusalReasonFor(refused ?? 'worker');
    return fail(RUN_EXIT_FAILED, 'spawn_agents_denied', reason, partial());
  }

  // Issue #413: a spawn refused by the --agents cap ends the run on the
  // refusal once every in-cap candidate settled — the same terminus shape
  // as the denial above, with the cap named.
  if (cappedSpawns.size > 0) {
    const refused = state.agents.find((agentId) => cappedSpawns.has(agentId));
    return fail(
      RUN_EXIT_FAILED,
      'spawn_cap_exceeded',
      `spawn refused for worker '${refused ?? 'worker'}': the run's --agents cap is ${spawnCap}`,
      partial(),
    );
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
  // --- #169 additions --- The partial terminus: workers the run continued
  // past, in agent order, each with the code it failed on. The envelope is the
  // ordinary report (whatever merged is reported) plus the named failures and
  // exit 7 — never a bare exit 1 that hides the work that landed.
  const failedWorkers = state.agents
    .filter((agentId) => partialFailures.has(agentId))
    .map((agentId) => {
      const outcome = partialFailures.get(agentId) as WorkerFailureOutcome;
      return { agentId, code: outcome.code, message: outcome.message };
    });
  const partialError =
    failedWorkers.length === 0
      ? undefined
      : {
          kind: 'partial',
          code: 'partial_failure',
          message: `orchestrated ${state.records.length} worker(s), merged ${state.merged.length}; failed: ${failedWorkers
            .map((failure) => `${failure.agentId} (${failure.code})`)
            .join(', ')}`,
        };
  const textLines = [
    // Issue #278 (§19): the terminal status line names the §19 mode.
    `${theme.accent('session:')} ${sessionId} mode=${runMode}`,
    ...state.records.map(
      (record) =>
        `worker: ${record.agentId} branch=${record.branch} hunks=${record.hunks.length}`,
    ),
    // Issue #185: what each worker did, in its own words (§68 summary).
    ...state.records.flatMap((record) =>
      record.result === undefined
        ? []
        : [workerSummaryLine(record.agentId, record.result)],
    ),
    `merge order: ${state.merged.join(' -> ')}`,
    `attribution: ${perAgent}`,
    ...state.merged.map((agentId) => `${theme.success('merged:')} ${agentId}`),
    // §61 (issue #158): the measured merge phases, one line per candidate.
    ...mergeTelemetryLines(),
    ...failedWorkers.map(
      (failure) =>
        `${theme.error('failed:')} ${failure.agentId} code=${failure.code}`,
    ),
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
    // The manager's final message (issue #418) replaces the mechanical
    // counts on lane-driven runs — it lived through the merges,
    // conflicts and worker results, so it reports them. The fallback
    // (no summary: template path) keeps the shipped wording untouched.
    ...(state.managerSummary === undefined
      ? [
          ...(partialError === undefined
            ? [
                `${theme.success('result:')} orchestrated ${state.records.length} worker(s), merged ${state.merged.length}`,
              ]
            : [
                `${theme.error('result:')} orchestrated with ${failedWorkers.length} failed worker(s) — merged ${state.merged.length}, pending ${state.pending.length} (retry with \`--resume --session ${sessionId}\`)`,
              ]),
        ]
      : [`${theme.success('result:')} ${state.managerSummary}`]),
  ];
  return emit(
    {
      ok: partialError === undefined,
      exitCode:
        partialError === undefined ? RUN_EXIT_OK : RUN_EXIT_PARTIAL_FAILURE,
      sessionId,
      status: partialError === undefined ? 'completed' : 'partial',
      workers: workerRows(),
      mergeOrder: [...state.merged],
      attribution,
      ...(state.managerSummary === undefined
        ? {}
        : { managerSummary: state.managerSummary }),
      // §61 per-agent merge telemetry (issue #158). Present only when the
      // loop recorded at least one candidate — an empty array would claim the
      // run measured merges it never had.
      ...(mergeTelemetry.length === 0 ? {} : { mergeTelemetry }),

      graph: delegationGraphLines(sessionId, state.agents),
      parallel,
      // Only present when a status reader is wired: an empty array would
      // claim "no worktree was retained", which is not what happened.
      ...(deps.worktreeStatus === undefined ? {} : { retained }),
      ...(partialError === undefined ? {} : { error: partialError }),
    },
    textLines,
  );
}
