// Manager tool adapters, step 2/6 of the #204 split (issue #414): the
// model-driven `spawn_agent` / `wait_for_agent` / `collect_result` as real
// pi-durable tool registrations. Every prod seam arrives through
// `ManagerToolsDeps`, so tests drive the adapters with fakes and a real
// ParallelScheduler while the later routing step passes the live run's
// own seams. The remaining allowlist tools stay stubs until steps 3–5
// (`managerToolsWithStubs` keeps allowlist order).
//
// Concurrency: spawns admit through the scheduler's existing cap (#206 is
// merged — parallel, never forced sequential); same-block tool calls run
// sequentially (the lane boots `toolExecution: 'sequential'`), so admission
// follows call order. Spawns also respect the run's `--agents` spawn cap
// (issue #413): the adapter refuses past it with the same
// `spawn_cap_exceeded` code the template path uses.
import type { RunMode } from '../../../agents/src/budget.js';
import type { PermissionClasses } from '../../../agents/src/policy.js';
import {
  gitDiffOperation,
  gitLogOperation,
  gitStatusOperation,
} from '../../../worker/src/ops/git.js';
import { OPERATION_PARAMETERS } from '../../../worker/src/ops/registry.js';
import {
  defineTool,
  type EntryRecord,
  type JsonValue,
  type ToolRegistration,
  ToolResultEntry,
  Type,
} from '../../../worker/src/pi-boundary.js';
import type { AgentResult, ResultStatus } from '../../../worker/src/result.js';
import { buildAgentResult } from '../../../worker/src/result.js';
import { composeWorkerPrompt } from '../roles/worker-roles.js';
import { MAX_RUN_TIMEOUT_MS } from '../run-cli.js';
import {
  QUESTION_UNANSWERED_CODE,
  type WorkerQuestionOutcome,
} from './approvals/worker-questions.js';
import {
  MANAGER_ALLOWLIST,
  rejectAuthoring,
  validateWorkspaceApply,
  validateWorkspaceDiff,
} from './manager.js';
import { managerToolStubs } from './manager-lane.js';
import { QueueStoppedError } from './merge/queue.js';
import type { ParallelScheduler } from './parallel/scheduler.js';

/** A refusal the model can act on: a stable code plus the reason. */
export class ManagerToolRefusalError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'ManagerToolRefusalError';
    this.code = code;
  }
}

/** The role half of a spawn, resolved through the run's role registry. */
export interface SpawnRoleSpec {
  promptText: string;
  tools: string[];
  modelRef?: string;
  thinking?: string;
  /**
   * Issue #198 (§71): the role document's own budget dims, if it declares
   * any — the fallback tier under an explicit `spawn_agent(budget=…)`.
   */
  budget?: Record<string, number>;
  /** Issue #196: the role's classes and obligations, when the registry
   * resolves them — the mint carries them to the spawn like any plan
   * assignment. */
  classes?: PermissionClasses;
  requires?: string[];
}

export interface PreparedWorker {
  agentId: string;
  worktreePath: string;
}

/**
 * A worker's pending change as its own bytes: what `workspace_diff`
 * shows and `workspace_apply` stages. The patch travels worker → lane,
 * never model → lane (`rejectAuthoring` refuses the reverse).
 */
export interface WorkerChange {
  agentId: string;
  filesChanged: string[];
  patch: string;
}

/**
 * The worker row `inspect_agent` reports: identity, placement and current
 * status — never transcript, prompt or tool content (§14.1, §69). The deps
 * own the row universe (the run's worker rows); the adapter passes the row
 * through verbatim, so nothing outside this shape can cross.
 */
export interface WorkerRowInfo {
  agentId: string;
  branch: string;
  role: string;
  status: 'running' | ResultStatus;
  summary: string;
}

export interface WorkerSpawnRequest {
  agentId: string;
  role: string;
  /** The composed prompt: the role's `## Prompt` text plus the task. */
  prompt: string;
  tools: string[];
  modelRef?: string;
  thinking?: string;
  /** Validated budget dims for #207 to enforce (accepted, not applied). */
  budget?: Record<string, number>;
  worktreePath: string;
}

export interface ManagerToolsDeps {
  sessionId: string;
  runMode: RunMode;
  scheduler: ParallelScheduler;
  /** The run's `--agents` spawn cap (issue #413). */
  spawnCap: number;
  /** Bound (ms) for `wait_for_agent` and queued-admission waits. */
  waitTimeoutMs: number;
  validRoles: readonly string[];
  /** The run's role registry: undefined names an unknown role. */
  resolveRole(roleName: string): SpawnRoleSpec | undefined;
  spawnedIds(): readonly string[];
  noteSpawned(agentId: string): void;
  mintAgentId(): string;
  /**
   * Observe a successful mint (issue #431): the adapter calls this with
   * the minted id, its role and its task right after minting, before
   * preparing — one synchronous call, so concurrent spawns cannot
   * interleave it. The router records the role for its worker rows and
   * session linkage, and the role-composed task as the worker's plan step
   * (the lane has no template plan; the step is what the child runs).
   */
  onSpawned?(agentId: string, role: string, task: string): void;
  /** Create the worker's worktree (no session, no child yet). */
  prepareWorker(agentId: string): Promise<PreparedWorker>;
  /** Create the worker session and run the child to settlement. */
  launchWorker(request: WorkerSpawnRequest): Promise<AgentResult>;
  /**
   * The run's worker rows, or undefined for an id this run never spawned.
   * Covers every worker the lane spawns (step-2 launches register there).
   */
  inspectWorker(agentId: string): WorkerRowInfo | undefined;
  /**
   * The run's existing cancellation path (`cancelWorker` in
   * orchestrate-cli: the lifecycle reap kills the detached process group).
   * Resolves once the child can spend no more tokens; rejects when it
   * could not be stopped.
   */
  cancelWorker(agentId: string): void | Promise<void>;
  /**
   * Deliver a follow-up prompt to a settled worker session and run it to a
   * new settlement. The returned result supersedes the previous one for
   * `wait_for_agent` / `collect_result`.
   */
  runFollowUp(agentId: string, prompt: string): Promise<AgentResult>;
  /**
   * Read a worker's pending change (its bytes, for review): the file list
   * plus the patch text. Read-only — the manager reviews these bytes
   * through `workspace_diff` but never supplies its own.
   */
  readWorkerChange(
    agentId: string,
    worktree: string,
    base?: string,
  ): Promise<WorkerChange>;
  /**
   * Enqueue a settled worker's change into the run's merge queue (FIFO).
   * Returns the queue position (1-based).
   */
  stageWorker(agentId: string, branch: string): Promise<{ position: number }>;
  /**
   * Dequeue the queue head and merge it into the main worktree. Returns
   * the merged worker, or undefined when nothing is staged. Throws
   * QueueStoppedError once the queue stopped on an unresolvable conflict.
   */
  applyStaged(): Promise<{ agentId: string } | undefined>;
  /**
   * Ask the run's seat one question on the manager's behalf. The prod
   * contract: an interactive run presents it on the TUI/terminal seat and
   * returns the answer; a headless run denies closed within the bound
   * (the `boundedAskUser` shape — a timeout/EOF verdict, never a hang).
   * The bound lives here in deps, never in the adapter: an unanswered
   * seat resolves unanswered, so the manager proceeds on assumptions.
   */
  askSeat(question: string): Promise<WorkerQuestionOutcome>;
  /**
   * Run one read-only git inspection over the op registry and return its
   * full text. Throws `ManagerToolRefusalError` with a named code
   * (`invalid_args`, `not_a_repo`, `git_failed`) — the adapter bounds the
   * text, so deps returns it whole. Writer ops are unreachable: the lane
   * toolset offers only the three readers.
   */
  inspectGit(
    tool: 'git_status' | 'git_diff' | 'git_log',
    args: unknown,
  ): Promise<string>;
}

// The `--budget` dimension names a `spawn_agent(budget=…)` map may carry
// (issue #208): the same closed set the CLI flag accepts, so a model cannot
// invent a dimension the enforcement step (#207) would not understand.
const SPAWN_BUDGET_DIMENSIONS: readonly string[] = [
  'maxTokens',
  'maxCostUsd',
  'maxRuntimeMs',
  'maxToolCalls',
];

/** The `provider/id` shape an explicit model pin must carry (issue #178). */
function isModelRef(raw: string): boolean {
  const slash = raw.indexOf('/');
  return slash > 0 && slash < raw.length - 1;
}

function parseSpawnBudget(raw: unknown): Record<string, number> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const dims: Record<string, number> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!SPAWN_BUDGET_DIMENSIONS.includes(name)) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) || !(value > 0)) {
      return undefined;
    }
    if (name === 'maxRuntimeMs' && value > MAX_RUN_TIMEOUT_MS) {
      return undefined;
    }
    dims[name] = value;
  }
  return Object.keys(dims).length === 0 ? undefined : dims;
}

interface SettleRecord {
  result?: AgentResult;
  waiters: Array<() => void>;
}

/**
 * The adapter-owned settle registry: spawns register, launches resolve,
 * waits observe. One primitive serves `wait_for_agent` and the queued
 * admission loop — no sleeps, no polling, just promise chaining off the
 * settle events the launches themselves produce.
 */
class SettleRegistry {
  private readonly records = new Map<string, SettleRecord>();

  register(agentId: string): void {
    this.records.set(agentId, { waiters: [] });
  }

  known(agentId: string): boolean {
    return this.records.has(agentId);
  }

  noteSettled(agentId: string, result: AgentResult): void {
    const record = this.records.get(agentId);
    if (record === undefined || record.result !== undefined) return;
    record.result = result;
    for (const wake of record.waiters.splice(0)) wake();
  }

  /**
   * Seed a settlement the lane never launched (issue #431): a resume
   * restores the prior drive's completions into a fresh registry, so the
   * continued lane observes them without re-running the workers. A
   * present record keeps its result (first settlement wins, as ever).
   */
  seedSettled(agentId: string, result: AgentResult): void {
    const record = this.records.get(agentId);
    if (record === undefined) {
      this.records.set(agentId, { result, waiters: [] });
      return;
    }
    this.noteSettled(agentId, result);
  }

  resultOf(agentId: string): AgentResult | undefined {
    return this.records.get(agentId)?.result;
  }

  /**
   * Reopen a settled record for a new cycle (`send_to_agent`): waiters and
   * collectors observe the follow-up's settlement, never the stale result.
   */
  reopen(agentId: string): boolean {
    const record = this.records.get(agentId);
    if (record === undefined || record.result === undefined) return false;
    record.result = undefined;
    return true;
  }

  waitForSettle(
    agentId: string,
    timeoutMs: number,
    what: string,
  ): Promise<AgentResult> {
    const settled = this.resultOf(agentId);
    if (settled !== undefined) return Promise.resolve(settled);
    return new Promise<AgentResult>((resolve, reject) => {
      const record = this.records.get(agentId);
      if (record === undefined) {
        reject(
          new ManagerToolRefusalError(
            'unknown_agent',
            `no worker '${agentId}' was spawned by this run`,
          ),
        );
        return;
      }
      // A non-finite timeout waits without a timer: `setTimeout` overflows
      // past ~24 days to 1ms (issue #431 — a prod `Infinity` wait timed out
      // instantly), so an unbounded wait simply never arms one. The lane
      // drive's own wall-clock deadline still bounds the turn.
      const timer =
        Number.isFinite(timeoutMs) && timeoutMs >= 0
          ? setTimeout(() => {
              const index = record.waiters.indexOf(wake);
              if (index >= 0) record.waiters.splice(index, 1);
              reject(
                new ManagerToolRefusalError(
                  'wait_timeout',
                  `'${what}' for worker '${agentId}' exceeded ${timeoutMs}ms`,
                ),
              );
            }, timeoutMs)
          : undefined;
      const wake = (): void => {
        const result = this.resultOf(agentId);
        if (result === undefined) return;
        if (timer !== undefined) clearTimeout(timer);
        resolve(result);
      };
      record.waiters.push(wake);
    });
  }

  /** Resolve on the next settlement of ANY worker (the admission loop). */
  waitForAnySettle(): { promise: Promise<void>; cancel(): void } {
    let cancel: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
      const wake = (): void => resolve();
      for (const record of this.records.values()) record.waiters.push(wake);
      cancel = () => {
        for (const record of this.records.values()) {
          const index = record.waiters.indexOf(wake);
          if (index >= 0) record.waiters.splice(index, 1);
        }
      };
    });
    return { promise, cancel };
  }
}

export interface ManagerToolset {
  spawnAgent: ToolRegistration;
  waitForAgent: ToolRegistration;
  collectResult: ToolRegistration;
  inspectAgent: ToolRegistration;
  cancelAgent: ToolRegistration;
  sendToAgent: ToolRegistration;
  workspaceDiff: ToolRegistration;
  workspaceApply: ToolRegistration;
  workspaceMerge: ToolRegistration;
  askUser: ToolRegistration;
  gitStatus: ToolRegistration;
  gitDiff: ToolRegistration;
  gitLog: ToolRegistration;
  settle: {
    resultOf(agentId: string): AgentResult | undefined;
    /**
     * Record a launch's settlement from the outside (issue #431): the
     * router's settle hook calls this when the run's own worker machinery
     * finishes, so `wait_for_agent`/`collect_result` observe the same
     * settlement the run merges. Unknown ids are ignored — only launched
     * workers settle.
     */
    noteSettled(agentId: string, result: AgentResult): void;
    /**
     * Seed a settlement the lane never launched (issue #431): the
     * router's resume path restores the prior drive's completions.
     */
    seedSettled(agentId: string, result: AgentResult): void;
  };
}

/**
 * Build the step-2 (spawn/wait/collect), step-3 (inspect/cancel/send) and
 * step-4 (workspace diff/apply/merge) adapters over the run's seams.
 */
export function buildManagerTools(deps: ManagerToolsDeps): ManagerToolset {
  const settle = new SettleRegistry();
  const worktrees = new Map<string, string>();

  /**
   * Scheduler slot ownership (issue #425): a launch holds its admission
   * slot from the spawn until its settlement (or its cancellation) frees
   * it. A follow-up holds none — the worker's process already ended and
   * its slot freed at the initial settlement — so neither a follow-up's
   * settlement nor a cancel aimed at a pending follow-up touches the
   * scheduler. If a follow-up ever respawns a process, it must re-enter
   * through ParallelScheduler.requestSpawn like any other spawn instead
   * of reusing the freed slot.
   */
  const slotsHeld = new Set<string>();
  const releaseSlot = (agentId: string): void => {
    if (slotsHeld.delete(agentId)) deps.scheduler.complete(agentId);
  };

  /**
   * Track a background worker promise (launch or follow-up): settlement
   * records the result and frees the scheduler slot when the tracked work
   * holds one (a launch — never a follow-up, see slotsHeld above); a
   * launch that never produces one fails closed with a synthesized
   * `failed` result, never a hang `wait_for_agent` cannot observe.
   */
  const trackBackground = (
    agentId: string,
    worked: Promise<AgentResult>,
    what: string,
  ): void => {
    void worked.then(
      (result) => {
        settle.noteSettled(agentId, result);
        releaseSlot(agentId);
      },
      (error) => {
        settle.noteSettled(
          agentId,
          buildAgentResult({
            status: 'failed',
            summary: `worker '${agentId}' ${what}: ${error instanceof Error ? error.message : String(error)}`,
            filesChanged: [],
            provenance: {
              workerId: agentId,
              sessionId: deps.sessionId,
              pid: null,
              generation: 0,
              worktree: worktrees.get(agentId) ?? agentId,
              model: 'unresolved',
            },
            metrics: { wallMs: 0, latencyMs: 0 },
            error: {
              kind: 'process',
              message: error instanceof Error ? error.message : String(error),
              details: {
                code:
                  what === 'failed to launch'
                    ? 'spawn_failed'
                    : 'follow_up_failed',
              },
            },
          }),
        );
        releaseSlot(agentId);
      },
    );
  };
  // Slots the cap counts: launched workers (via deps) PLUS queued claims
  // below. A queued `spawn_agent` holds its claim until admitted — otherwise
  // a later call would see only launched workers and over-admit past the
  // cap while its sibling still waits for a slot.
  const claimed = new Set<string>();

  const spawnAgent = defineTool({
    name: 'spawn_agent',
    description:
      'Spawn a role-typed worker to perform a task; returns its agent id once launched.',
    parameters: Type.Object({
      role: Type.String(),
      task: Type.String(),
      model: Type.Optional(Type.String()),
      budget: Type.Optional(Type.Record(Type.String(), Type.Number())),
    }),
    execute: async (args) => {
      const { role, task, model, budget } = args as {
        role?: unknown;
        task?: unknown;
        model?: unknown;
        budget?: unknown;
      };
      if (
        typeof role !== 'string' ||
        role.trim() === '' ||
        typeof task !== 'string' ||
        task.trim() === ''
      ) {
        throw new ManagerToolRefusalError(
          'invalid_args',
          'spawn_agent needs a non-empty role and task',
        );
      }
      const spec = deps.resolveRole(role);
      if (spec === undefined) {
        throw new ManagerToolRefusalError(
          'unknown_role',
          `unknown role '${role}' (one of ${deps.validRoles.join(', ')})`,
        );
      }
      if (
        model !== undefined &&
        (typeof model !== 'string' || !isModelRef(model))
      ) {
        throw new ManagerToolRefusalError(
          'invalid_model',
          `model pin ${JSON.stringify(model)} must be 'provider/id'`,
        );
      }
      const dims = budget === undefined ? undefined : parseSpawnBudget(budget);
      if (budget !== undefined && dims === undefined) {
        throw new ManagerToolRefusalError(
          'invalid_budget',
          `budget ${JSON.stringify(budget)} must map ${SPAWN_BUDGET_DIMENSIONS.join(', ')} to positive numbers`,
        );
      }
      // The --agents cap binds here, where the manager chooses: past it the
      // spawn is refused before any worktree exists (issue #413's code).
      // Claims count: a queued sibling already holds its slot.
      const held = deps.spawnedIds().length + claimed.size;
      if (held >= deps.spawnCap) {
        throw new ManagerToolRefusalError(
          'spawn_cap_exceeded',
          `spawn refused for role '${role}': the run's --agents cap is ${deps.spawnCap} and ${held} worker(s) already spawned or queued`,
        );
      }
      const agentId = deps.mintAgentId();
      claimed.add(agentId);
      deps.onSpawned?.(agentId, role, task);
      const prepared = await deps.prepareWorker(agentId);
      const admission = deps.scheduler.requestSpawn(
        {
          agentId,
          sessionId: deps.sessionId,
          worktree: prepared.worktreePath,
        },
        deps.runMode,
      );
      if (admission.outcome === 'denied') {
        claimed.delete(agentId);
        throw new ManagerToolRefusalError(
          'spawn_denied',
          `spawn denied for worker '${agentId}': ${admission.reason}`,
        );
      }
      if (admission.outcome === 'queued') {
        // Wait for a slot, driven by the settle events our own launches
        // produce: every settlement completes its scheduler entry (which
        // drains the queue) and wakes this loop. The scheduler's own
        // maxPendingMs expiry is the abandonment bound — a queued entry the
        // sweep drops surfaces as a named denial, never a silent hang —
        // with the run's wait bound as the belt.
        const deadline = Date.now() + deps.waitTimeoutMs;
        for (;;) {
          if (deps.scheduler.runningIds().includes(agentId)) break;
          if (!deps.scheduler.pendingIds().includes(agentId)) {
            claimed.delete(agentId);
            throw new ManagerToolRefusalError(
              'spawn_denied',
              `spawn denied for worker '${agentId}': queued past the admission layer's bound before a slot freed`,
            );
          }
          if (Date.now() >= deadline) {
            // Withdraw first: the scheduler must never admit a ghost no
            // one will launch or complete. Just-admitted (running)
            // proceeds to launch below instead of throwing.
            if (deps.scheduler.withdraw(agentId) === 'running') break;
            claimed.delete(agentId);
            throw new ManagerToolRefusalError(
              'spawn_queue_timeout',
              `spawn for worker '${agentId}' waited ${deps.waitTimeoutMs}ms for a slot — both slots freed, settle a worker and retry`,
            );
          }
          const wait = settle.waitForAnySettle();
          const remaining = deadline - Date.now();
          // A non-finite wait bound arms no timer (`setTimeout(Infinity)`
          // overflows to 1ms — issue #431): the loop waits on the next
          // settlement alone, and `Date.now() >= deadline` above stays
          // false, so an unbounded admission wait never times out here.
          // The lane drive's wall-clock deadline still bounds the turn.
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timeout = new Promise<void>((resolve) => {
            if (Number.isFinite(remaining) && remaining >= 0) {
              timer = setTimeout(resolve, remaining);
            }
          });
          await Promise.race([wait.promise, timeout]);
          wait.cancel();
          // A settle win must not leave the bound timer lingering.
          if (timer !== undefined) clearTimeout(timer);
        }
      }
      // A minted id must never overwrite a live record: refuse instead.
      // Reachable when a minter repeats an id after its worker settled
      // (the scheduler forgot it, the lane must not). The held scheduler
      // slot frees through complete, which may fairly admit a queued
      // sibling — the claim and the worktree record stay untouched.
      if (settle.known(agentId)) {
        deps.scheduler.complete(agentId);
        claimed.delete(agentId);
        throw new ManagerToolRefusalError(
          'duplicate_agent',
          `agent id '${agentId}' is already spent by this run — mint a fresh id and retry`,
        );
      }
      // The spawn half is synchronous (admission is held); the child runs
      // in the background — the model waits or collects later, so one turn
      // can launch the whole team without forcing sequential runs. The
      // claim converts to a launched worker here.
      claimed.delete(agentId);
      settle.register(agentId);
      // The launch holds its admission slot from here (issue #425).
      slotsHeld.add(agentId);
      worktrees.set(agentId, prepared.worktreePath);
      deps.noteSpawned(agentId);
      trackBackground(
        agentId,
        deps.launchWorker({
          agentId,
          role,
          prompt: composeWorkerPrompt(spec.promptText, task),
          tools: [...spec.tools],
          // The spawn pin outranks the role's pin (issue #202's precedence).
          ...(model === undefined && spec.modelRef === undefined
            ? {}
            : { modelRef: model ?? spec.modelRef }),
          ...(spec.thinking === undefined ? {} : { thinking: spec.thinking }),
          // Issue #198 (§71): an explicit spawn budget outranks the role
          // document's; absent, the document's dims ride the spawn, and
          // absent those the spawn is unbounded (opt-in only).
          ...(dims === undefined
            ? spec.budget === undefined
              ? {}
              : { budget: spec.budget }
            : { budget: dims }),
          worktreePath: prepared.worktreePath,
        }),
        'failed to launch',
      );
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ agentId, status: 'running' }),
          },
        ],
      };
    },
  });

  const waitForAgent = defineTool({
    name: 'wait_for_agent',
    description:
      'Wait for a spawned worker to settle; returns its agent id and status.',
    parameters: Type.Object({ agentId: Type.String() }),
    execute: async (args) => {
      const { agentId } = args as { agentId?: unknown };
      if (typeof agentId !== 'string' || agentId === '') {
        throw new ManagerToolRefusalError(
          'invalid_args',
          'wait_for_agent needs a spawned agent id',
        );
      }
      const result = await settle.waitForSettle(
        agentId,
        deps.waitTimeoutMs,
        'wait_for_agent',
      );
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ agentId, status: result.status }),
          },
        ],
      };
    },
  });

  const collectResult = defineTool({
    name: 'collect_result',
    description:
      'Collect a settled worker result: its summary, changed files and status only.',
    parameters: Type.Object({ agentId: Type.String() }),
    execute: async (args) => {
      const { agentId } = args as { agentId?: unknown };
      if (typeof agentId !== 'string' || agentId === '') {
        throw new ManagerToolRefusalError(
          'invalid_args',
          'collect_result needs a spawned agent id',
        );
      }
      const result = settle.resultOf(agentId);
      if (result === undefined) {
        if (!settle.known(agentId)) {
          throw new ManagerToolRefusalError(
            'unknown_agent',
            `no worker '${agentId}' was spawned by this run`,
          );
        }
        throw new ManagerToolRefusalError(
          'collect_before_settle',
          `worker '${agentId}' has not settled — wait_for_agent first`,
        );
      }
      // §14.1: the summary crosses the boundary, never the transcript — a
      // fresh object, so transcript keys cannot leak by construction.
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              summary: result.summary,
              filesChanged: [...result.filesChanged],
              status: result.status,
            }),
          },
        ],
      };
    },
  });

  // Control actions (inspect excepted) operate on the lane's own spawned
  // set: only settle-known workers have the bookkeeping a cancel or a
  // follow-up cycle needs. Inspection is read-only over the run's rows.
  const inspectAgent = defineTool({
    name: 'inspect_agent',
    description:
      'Report a worker row (branch, role, status, summary) — never transcript content.',
    parameters: Type.Object({ agentId: Type.String() }),
    execute: async (args) => {
      const { agentId } = args as { agentId?: unknown };
      if (typeof agentId !== 'string' || agentId === '') {
        throw new ManagerToolRefusalError(
          'invalid_args',
          'inspect_agent needs a spawned agent id',
        );
      }
      const row = deps.inspectWorker(agentId);
      if (row === undefined) {
        throw new ManagerToolRefusalError(
          'unknown_agent',
          `no worker '${agentId}' was spawned by this run`,
        );
      }
      // §14.1 by construction: exactly the five contract keys cross, so a
      // richer prod row (spread/cast with transcript, prompt, tools) can
      // never serialize into model context — as collect_result already does.
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              agentId: row.agentId,
              branch: row.branch,
              role: row.role,
              status: row.status,
              summary: row.summary,
            }),
          },
        ],
      };
    },
  });

  const cancelAgent = defineTool({
    name: 'cancel_agent',
    description:
      'Cancel a running worker through the run cancellation path; the run continues.',
    parameters: Type.Object({ agentId: Type.String() }),
    execute: async (args) => {
      const { agentId } = args as { agentId?: unknown };
      if (typeof agentId !== 'string' || agentId === '') {
        throw new ManagerToolRefusalError(
          'invalid_args',
          'cancel_agent needs a spawned agent id',
        );
      }
      if (!settle.known(agentId)) {
        throw new ManagerToolRefusalError(
          'unknown_agent',
          `no worker '${agentId}' was spawned by this run`,
        );
      }
      if (settle.resultOf(agentId) !== undefined) {
        throw new ManagerToolRefusalError(
          'already_settled',
          `worker '${agentId}' already settled — nothing to cancel`,
        );
      }
      try {
        await deps.cancelWorker(agentId);
      } catch (error) {
        throw new ManagerToolRefusalError(
          'cancel_failed',
          `worker '${agentId}' could not be stopped — ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      // The kill ends the child; the lane records the cancellation so
      // wait/collect observe it and the run continues with its siblings.
      // The scheduler slot frees only when this cancel ends work that
      // still holds one (issue #425): a running launch — never a pending
      // follow-up, whose slot freed at the initial settlement.
      const cancelled = buildAgentResult({
        status: 'cancelled',
        summary: `worker '${agentId}' cancelled by the manager`,
        filesChanged: [],
        provenance: {
          workerId: agentId,
          sessionId: deps.sessionId,
          pid: null,
          generation: 0,
          worktree: worktrees.get(agentId) ?? agentId,
          model: 'unresolved',
        },
        metrics: { wallMs: 0, latencyMs: 0 },
        error: {
          kind: 'process',
          message: `worker '${agentId}' cancelled by the manager`,
          details: { code: 'cancelled_by_manager' },
        },
      });
      settle.noteSettled(agentId, cancelled);
      releaseSlot(agentId);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ agentId, status: 'cancelled' }),
          },
        ],
      };
    },
  });

  const sendToAgent = defineTool({
    name: 'send_to_agent',
    description:
      'Send a follow-up prompt to a settled worker session; it runs to a new settlement.',
    parameters: Type.Object({
      agentId: Type.String(),
      prompt: Type.String(),
    }),
    execute: async (args) => {
      const { agentId, prompt } = args as {
        agentId?: unknown;
        prompt?: unknown;
      };
      if (
        typeof agentId !== 'string' ||
        agentId === '' ||
        typeof prompt !== 'string' ||
        prompt.trim() === ''
      ) {
        throw new ManagerToolRefusalError(
          'invalid_args',
          'send_to_agent needs a spawned agent id and a non-empty prompt',
        );
      }
      if (!settle.known(agentId)) {
        throw new ManagerToolRefusalError(
          'unknown_agent',
          `no worker '${agentId}' was spawned by this run`,
        );
      }
      if (settle.resultOf(agentId) === undefined) {
        throw new ManagerToolRefusalError(
          'send_before_settle',
          `worker '${agentId}' is still running — wait_for_agent first`,
        );
      }
      // A new settle cycle over the same record: the follow-up's result
      // supersedes the previous one. No scheduler slot: the worker's
      // process already ended; the follow-up re-enters its session.
      settle.reopen(agentId);
      trackBackground(
        agentId,
        deps.runFollowUp(agentId, prompt),
        'follow-up failed',
      );
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ agentId, status: 'running' }),
          },
        ],
      };
    },
  });

  // Workspace tools (issue #416): the manager merges worker-produced
  // bytes it references, never bytes it supplies. `rejectAuthoring` runs
  // first in every one (schemas omit the fields; a direct call still
  // hits the guard). Like the control tools they operate on the lane's
  // spawned set, whose worktrees the lane tracked at spawn.
  const workspaceDiff = defineTool({
    name: 'workspace_diff',
    description:
      'Show a worker change (files and patch, read-only) — never author file contents.',
    parameters: Type.Object({
      agentId: Type.String(),
      base: Type.Optional(Type.String()),
    }),
    execute: async (args) => {
      rejectAuthoring(args as Record<string, unknown>);
      const { agentId, base } = args as {
        agentId?: unknown;
        base?: unknown;
      };
      if (typeof agentId !== 'string' || agentId === '') {
        throw new ManagerToolRefusalError(
          'invalid_args',
          'workspace_diff needs a spawned agent id',
        );
      }
      if (base !== undefined && typeof base !== 'string') {
        throw new ManagerToolRefusalError(
          'invalid_args',
          'workspace_diff base must be a ref when provided',
        );
      }
      const worktree = worktrees.get(agentId);
      if (worktree === undefined) {
        throw new ManagerToolRefusalError(
          'unknown_agent',
          `no worker '${agentId}' was spawned by this run`,
        );
      }
      const checked = validateWorkspaceDiff(
        base === undefined ? { worktree } : { worktree, base },
      );
      if (!checked.valid) {
        throw new ManagerToolRefusalError(
          'invalid_args',
          `workspace_diff: ${checked.errors.join('; ')}`,
        );
      }
      const change = await deps.readWorkerChange(agentId, worktree, base);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              agentId: change.agentId,
              filesChanged: [...change.filesChanged],
              patch: change.patch,
            }),
          },
        ],
      };
    },
  });

  const workspaceApply = defineTool({
    name: 'workspace_apply',
    description:
      'Stage a settled worker change into the merge queue — references only, never file contents.',
    parameters: Type.Object({ agentId: Type.String() }),
    execute: async (args) => {
      rejectAuthoring(args as Record<string, unknown>);
      const { agentId } = args as { agentId?: unknown };
      if (typeof agentId !== 'string' || agentId === '') {
        throw new ManagerToolRefusalError(
          'invalid_args',
          'workspace_apply needs a spawned agent id',
        );
      }
      const worktree = worktrees.get(agentId);
      if (worktree === undefined) {
        throw new ManagerToolRefusalError(
          'unknown_agent',
          `no worker '${agentId}' was spawned by this run`,
        );
      }
      if (settle.resultOf(agentId) === undefined) {
        throw new ManagerToolRefusalError(
          'apply_before_settle',
          `worker '${agentId}' is still running — stage only settled changes`,
        );
      }
      // The staged bytes are the worker's own, re-read here: the model
      // never supplies a patch, so there is nothing to smuggle through.
      const change = await deps.readWorkerChange(agentId, worktree);
      const checked = validateWorkspaceApply({
        worktree,
        patch: change.patch,
      });
      if (!checked.valid) {
        throw new ManagerToolRefusalError(
          'invalid_args',
          `workspace_apply: ${checked.errors.join('; ')}`,
        );
      }
      const row = deps.inspectWorker(agentId);
      if (row === undefined) {
        throw new ManagerToolRefusalError(
          'unknown_agent',
          `no worker '${agentId}' was spawned by this run`,
        );
      }
      const staged = await deps.stageWorker(agentId, row.branch);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ agentId, position: staged.position }),
          },
        ],
      };
    },
  });

  const workspaceMerge = defineTool({
    name: 'workspace_merge',
    description:
      'Merge the merge-queue head into the main worktree (FIFO — the queue owns the order).',
    parameters: Type.Object({}),
    execute: async (args) => {
      rejectAuthoring(args as Record<string, unknown>);
      let staged: { agentId: string } | undefined;
      try {
        staged = await deps.applyStaged();
      } catch (error) {
        if (error instanceof QueueStoppedError) {
          throw new ManagerToolRefusalError('merge_blocked', error.message);
        }
        throw error;
      }
      if (staged === undefined) {
        throw new ManagerToolRefusalError(
          'merge_queue_empty',
          'merge queue is empty — stage a worker change first',
        );
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ agentId: staged.agentId, status: 'merged' }),
          },
        ],
      };
    },
  });

  // ask_user (issue #417): the manager's free-text question to the run's
  // seat. Same outcome vocabulary as the worker-side tool
  // (createAskUserTool): an answered seat returns its text, an unanswered
  // one returns a named error the model acts on — never a throw, never a
  // hang (the bound is the deps' contract).
  const askUser = defineTool({
    name: 'ask_user',
    description:
      'Ask the user one short free-text question when you cannot proceed without their answer. Returns their answer, or an error when nobody answers in time — then continue with your best assumption and say so.',
    parameters: Type.Object({
      question: Type.String({ minLength: 1, maxLength: 2000 }),
    }),
    constrainedSampling: { type: 'json_schema', strict: 'prefer' },
    // Asking twice is not harmful, but the answer is a human's: a replayed
    // call re-reads the same answer by its memo key instead of asking again.
    replay: 'safe',
    execute: async (args) => {
      const { question } = args as { question?: unknown };
      if (typeof question !== 'string' || question.trim() === '') {
        throw new ManagerToolRefusalError(
          'invalid_args',
          'ask_user needs a non-empty question',
        );
      }
      const outcome = await deps.askSeat(question);
      const text = outcome.answered
        ? outcome.text
        : `error ${QUESTION_UNANSWERED_CODE}: ${outcome.reason}`;
      const details: JsonValue = outcome.answered
        ? { ok: true }
        : { ok: false, code: QUESTION_UNANSWERED_CODE };
      return { content: [{ type: 'text' as const, text }], details };
    },
  });

  // git_status / git_diff / git_log (issue #431): read-only repo
  // inspection over the op registry. Schemas and argument validation are
  // the ops' own (single source — a guessed arg fails here with the real
  // names in view, never reaching git); the text is bounded at the
  // adapter so no caller can hand the model an unbounded diff.
  const gitTool = (
    name: 'git_status' | 'git_diff' | 'git_log',
    description: string,
  ): ToolRegistration => {
    const op =
      name === 'git_status'
        ? gitStatusOperation
        : name === 'git_diff'
          ? gitDiffOperation
          : gitLogOperation;
    return defineTool({
      name,
      description,
      parameters: OPERATION_PARAMETERS[name],
      execute: async (args) => {
        let validated: unknown;
        try {
          validated = op.validateArgs(args);
        } catch (error) {
          throw new ManagerToolRefusalError(
            'invalid_args',
            error instanceof Error ? error.message : String(error),
          );
        }
        let text: string;
        try {
          text = await deps.inspectGit(name, validated);
        } catch (error) {
          if (error instanceof ManagerToolRefusalError) throw error;
          throw new ManagerToolRefusalError(
            'git_failed',
            error instanceof Error ? error.message : String(error),
          );
        }
        return {
          content: [{ type: 'text' as const, text: boundGitText(text) }],
        };
      },
    });
  };
  const gitStatus = gitTool('git_status', 'Read-only git status of the repo.');
  const gitDiff = gitTool('git_diff', 'Read-only git diff of the repo.');
  const gitLog = gitTool('git_log', 'Read-only git log of the repo.');

  return {
    spawnAgent,
    waitForAgent,
    collectResult,
    inspectAgent,
    cancelAgent,
    sendToAgent,
    workspaceDiff,
    workspaceApply,
    workspaceMerge,
    askUser,
    gitStatus,
    gitDiff,
    gitLog,
    settle: {
      resultOf: (agentId) => settle.resultOf(agentId),
      noteSettled: (agentId, result) => {
        settle.noteSettled(agentId, result);
      },
      seedSettled: (agentId, result) => {
        settle.seedSettled(agentId, result);
      },
    },
  };
}

/** The bound on one git inspection's text: a full diff never floods the lane. */
export const MANAGER_GIT_MAX_CHARS = 32_768;

/**
 * Bound one git result: whole when small, head plus a named marker when
 * not. The marker names the dropped count so the manager knows it saw a
 * prefix, never a silently cut diff.
 */
export function boundGitText(text: string): string {
  if (text.length <= MANAGER_GIT_MAX_CHARS) return text;
  return `${text.slice(0, MANAGER_GIT_MAX_CHARS)}\n…[truncated ${text.length - MANAGER_GIT_MAX_CHARS} chars of git output]`;
}

/**
 * The lane's 13 tools in allowlist order from a built toolset (issue
 * #431): the router wraps the toolset with the drive bound first, then
 * resolves the same order — one mapping, two callers.
 */
export function managerToolRegistrations(
  tools: ManagerToolset,
): ToolRegistration[] {
  const real = new Map([
    ['spawn_agent', tools.spawnAgent],
    ['send_to_agent', tools.sendToAgent],
    ['wait_for_agent', tools.waitForAgent],
    ['cancel_agent', tools.cancelAgent],
    ['inspect_agent', tools.inspectAgent],
    ['collect_result', tools.collectResult],
    ['workspace_diff', tools.workspaceDiff],
    ['workspace_apply', tools.workspaceApply],
    ['workspace_merge', tools.workspaceMerge],
    ['ask_user', tools.askUser],
    ['git_status', tools.gitStatus],
    ['git_diff', tools.gitDiff],
    ['git_log', tools.gitLog],
  ]);
  const stubs = new Map(managerToolStubs().map((tool) => [tool.name, tool]));
  return MANAGER_ALLOWLIST.map((name) => {
    const tool = real.get(name) ?? stubs.get(name);
    if (tool === undefined) throw new Error(`no manager tool '${name}'`);
    return tool;
  });
}

/**
 * The lane's 13 tools in allowlist order: every §9.2 adapter real
 * (#414–#417, #431) — no stubs remain. The lane boots this set.
 */
export function managerToolsWithStubs(
  deps: ManagerToolsDeps,
): ToolRegistration[] {
  return managerToolRegistrations(buildManagerTools(deps));
}

/**
 * The lane's real call record: the tool names the manager actually called,
 * oldest first. Replaces the literal-name recording
 * (`managerCallsForMerge`'s lane tail) on the lane path — the merge asserts
 * over calls that happened, not names the template wrote down.
 */
export function managerCallsFromLane(entries: EntryRecord[]): string[] {
  const calls: string[] = [];
  for (const entry of entries) {
    if (!ToolResultEntry.is(entry)) continue;
    const message = (
      entry.model as unknown as
        | Array<{ role?: string; toolName?: string }>
        | undefined
    )?.[0];
    if (
      message?.role === 'toolResult' &&
      typeof message.toolName === 'string'
    ) {
      calls.push(message.toolName);
    }
  }
  return calls;
}
