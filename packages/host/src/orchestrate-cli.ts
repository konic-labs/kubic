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
import { BUILTIN_ROLE_NAMES, isBuiltinRole } from './roles/roles-data.js';
import type { WorkerRolesPlan } from './roles/worker-roles.js';
import {
  applyRolesToPlan,
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

// The `provider/id` shape an explicit per-agent model pin must carry.
function isModelRef(raw: string): boolean {
  const slash = raw.indexOf('/');
  return slash > 0 && slash < raw.length - 1;
}

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
  // The worker's §68 result (issue #185): status, summary, provenance and
  // metrics — persisted with the run so resume, handoff and replay can read
  // what each worker did and cost. Absent on state written before #185.
  result?: AgentResult;
}

// What a worker run hands back (issue #185): the hunks it produced plus its
// validated §68 result. A bare hunk list is still accepted (older seams and
// fakes) and simply carries no result.
export interface WorkerRunOutput {
  hunks: MergedHunk[];
  result?: AgentResult;
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
  // The worker-failure policy this run started with (issue #169 review):
  // persisted so `--on-failure continue` survives a kill + `--resume`
  // instead of silently reverting to all-or-nothing. A state written before
  // the policy existed has none, and `stop` is the default it implies.
  onFailure?: 'stop' | 'continue';
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
  if (!Array.isArray(value.records)) return undefined;
  for (const record of value.records) {
    if (typeof record !== 'object' || record === null) return undefined;
    const entry = record as Record<string, unknown>;
    if (typeof entry.agentId !== 'string') return undefined;
    if (typeof entry.branch !== 'string') return undefined;
    if (!Array.isArray(entry.hunks)) return undefined;
    if (
      entry.result !== undefined &&
      !validateAgentResult(entry.result).valid
    ) {
      return undefined;
    }
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
  /** §38.1 (issue #202): the thinking level this worker's child is told. */
  thinking?: string;
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

// One settled merge-gate decision, as the §60 ledger records it (issue
// #323). `by` is `--yes` for the run's standing answer and `user` for a
// decider's answer (or the deny-closed absence of one).
export interface MergeDecisionRecord {
  sessionId: string;
  agentId: string;
  branch: string;
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
  // Whether a merge-gate refusal points the operator at `--yes` (default
  // true). A surface with no such flag — the TUI, whose merge asks go through
  // its own approval overlay — passes false so the message never names a flag
  // that does not exist there (issue #327).
  yesHint?: boolean;
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
  // Issue #185: each worker that produced a §68 result also carries its
  // role, status, summary, usage and provenance (WorkerResultView).
  workers: ({
    agentId: string;
    branch: string;
    hunks: number;
  } & Partial<WorkerResultView>)[];
  mergeOrder: string[];
  attribution: AttributedHunk[];
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
  json: boolean;
  // Opt-in budgets (§71, issue #105): absent means NO budget is applied to a
  // spawn. Per-worker overrides arrive as --budget <agent>=<dims>; the shared
  // --budget <dims> applies to every worker of the run.
  budget?: Record<string, number>;
  budgetsByAgent: Record<string, Record<string, number>>;
  fullAccess: boolean;
  // This run's admission override (issue #206): absent means the scheduler's
  // own resolution (explicit limits cap > configured maxWorkers > 4) stands.
  concurrency?: number;
  // This run's worker-failure policy (issue #169), when the flag was given.
  // Absent means the stored policy (on --resume) or the shipped `stop`.
  onFailure?: 'stop' | 'continue';
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

function storedBudgetDims(raw: unknown): Record<string, number> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const dims: Record<string, number> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!BUDGET_DIMENSIONS.includes(name)) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) || !(value > 0)) {
      return undefined;
    }
    if (name === 'maxRuntimeMs' && value > MAX_RUN_TIMEOUT_MS) return undefined;
    dims[name] = value;
  }
  return Object.keys(dims).length === 0 ? undefined : dims;
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
    Object.keys(record).some((key) => key !== 'shared' && key !== 'byAgent')
  ) {
    return undefined;
  }
  const shared = storedBudgetDims(record.shared);
  if (record.shared !== undefined && shared === undefined) return undefined;
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
  if (shared === undefined && Object.keys(byAgent).length === 0) {
    return undefined;
  }
  return {
    ...(shared === undefined ? {} : { shared }),
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
    Object.keys(parsed.budgetsByAgent).length === 0
      ? undefined
      : {
          ...(parsed.budget === undefined ? {} : { shared: parsed.budget }),
          byAgent: { ...parsed.budgetsByAgent },
        };
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
      // The explicit assignment travels with the state (issue #178):
      // --resume replays it instead of falling back to a default role.
      ...(bindingIsEmpty(parsed.binding)
        ? {}
        : {
            roles: { ...parsed.binding.roles },
            models: { ...parsed.binding.models },
          }),
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
  // No approvals layer means no gate to enforce the spec. Refused, never
  // silently dropped — the exact false sense of cost control issue #208
  // exists to remove.
  if (effectiveBudget !== undefined && deps.approvals === undefined) {
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
  // its resolved tool set and its resolved model/thinking levels (issue
  // #202). Empty for a worker with no assignment (no role documents), so the
  // spawn info keeps its #85 shape.
  const spawnRoleInfo = (
    agentId: string,
    roles: WorkerRolesPlan,
  ): Pick<WorkerSpawnInfo, 'role' | 'tools' | 'modelRef' | 'thinking'> => {
    const assignment = workerRoleAssignment(roles, agentId);
    if (assignment === undefined) return {};
    return {
      role: assignment.role,
      tools: [...assignment.tools],
      modelRef: assignment.modelRef,
      thinking: assignment.thinking,
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
  // §45 per-session cap (issue #206): `--concurrency <n>` is this run's own
  // override, applied to the same scheduler every other admission judgement
  // goes through (an explicit limits cap and the configured
  // `[orchestrator].maxWorkers` still lose to it by resolveMaxConcurrency's
  // precedence). Applied BEFORE any request so no worker is ever admitted
  // under a cap the operator overrode.
  if (parsed.concurrency !== undefined) {
    scheduler.setSessionOverride(parsed.concurrency);
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
    // of THAT spawn only; absent, the shared spec applies. The spec read here
    // is the EFFECTIVE one: a resume re-applies what the state stored.
    budgetForAgent: (agentId: string) =>
      effectiveBudget?.byAgent[agentId] ?? effectiveBudget?.shared,
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
    // manager's §60 rows and the child's ask must name the same role.
    role: spawnRoleInfo(agentId, rolePlan).role ?? 'worker',
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
      upsertRecord({ agentId: inFlight, branch: worktree.branch, hunks: [] });
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
  const prepared = new Map<string, OrchestrateWorktree>();
  for (const agentId of state.pending) {
    // This attempt's own result: a failure record kept from an earlier run of
    // the same session is not this attempt's outcome (issue #185). Cleared
    // BEFORE any stage can fail — the worktree stage records its own failure
    // and must not inherit the earlier attempt's result.
    resultsByAgent.delete(agentId);
    // Resume may already hold this worktree (intent reconciliation
    // resolved it for the isBranchMerged probe) — never ensure twice.
    let worktree = worktrees.get(agentId);
    if (worktree === undefined) {
      try {
        worktree = await deps.ensureWorktree(agentId, worktreeRequest);
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
          // The role this worker was assigned and the tool set its lane
          // must register (§12.1/§40): the resolved set is what withholds
          // a tool — absence, never approval. Absent means no role
          // document exists for this worker, so nothing is narrowed.
          ...spawnRoleInfo(agentId, rolePlan),
        }),
      );
      if (output.result !== undefined) {
        resultsByAgent.set(agentId, output.result);
      }
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
  const releaseSlot = (agentId: string): void => {
    const woken = scheduler.complete(agentId);
    observeAdmission();
    const wakeups = woken.filter((id) => !started.has(id));
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
      'autonomous',
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

  // Every pending worker settled: enqueue the candidates in AGENT order, so
  // the merge order is deterministic whatever the settle order was (issue
  // #206) and the write-ahead intent still travels with one candidate at a
  // time. A worker the run continued past (issue #169) is never enqueued: it
  // did not succeed, so there is nothing to merge, and it stays pending for
  // `--resume` to retry.
  for (const agentId of state.pending) {
    if (partialFailures.has(agentId)) continue;
    const worktree = prepared.get(agentId) as OrchestrateWorktree;
    queue.enqueue({ agentId, branch: worktree.branch });
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
      approved: verdict.verdict === 'approve',
      by: parsed.autoApprove ? '--yes' : 'user',
      ...(verdict.verdict === 'timeout'
        ? { reason: `timed out after ${verdict.maxPendingMs}ms` }
        : verdict.verdict === 'deny'
          ? { reason: 'denied' }
          : {}),
    });
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
    const result = resultsByAgent.get(agentId);
    // An upsert: a resumed retry replaces the failure record kept from the
    // attempt that failed (issue #185) instead of listing the worker twice.
    upsertRecord({
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
    `${theme.accent('session:')} ${sessionId}`,
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
    ...(partialError === undefined
      ? [
          `${theme.success('result:')} orchestrated ${state.records.length} worker(s), merged ${state.merged.length}`,
        ]
      : [
          `${theme.error('result:')} orchestrated with ${failedWorkers.length} failed worker(s) — merged ${state.merged.length}, pending ${state.pending.length} (retry with \`--resume --session ${sessionId}\`)`,
        ]),
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
