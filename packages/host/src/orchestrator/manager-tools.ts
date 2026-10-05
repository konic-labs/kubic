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
import {
  defineTool,
  type EntryRecord,
  type ToolRegistration,
  ToolResultEntry,
  Type,
} from '../../../worker/src/pi-boundary.js';
import type { AgentResult, ResultStatus } from '../../../worker/src/result.js';
import { buildAgentResult } from '../../../worker/src/result.js';
import { composeWorkerPrompt } from '../roles/worker-roles.js';
import { MAX_RUN_TIMEOUT_MS } from '../run-cli.js';
import { MANAGER_ALLOWLIST } from './manager.js';
import { managerToolStubs } from './manager-lane.js';
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
}

export interface PreparedWorker {
  agentId: string;
  worktreePath: string;
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
      const timer = setTimeout(() => {
        const index = record.waiters.indexOf(wake);
        if (index >= 0) record.waiters.splice(index, 1);
        reject(
          new ManagerToolRefusalError(
            'wait_timeout',
            `'${what}' for worker '${agentId}' exceeded ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      const wake = (): void => {
        const result = this.resultOf(agentId);
        if (result === undefined) return;
        clearTimeout(timer);
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
  settle: {
    resultOf(agentId: string): AgentResult | undefined;
  };
}

/** Build the step-2 (spawn/wait/collect) and step-3 (inspect/cancel/send) adapters over the run's seams. */
export function buildManagerTools(deps: ManagerToolsDeps): ManagerToolset {
  const settle = new SettleRegistry();
  const worktrees = new Map<string, string>();

  /**
   * Track a background worker promise (launch or follow-up): settlement
   * records the result and frees the scheduler slot; a launch that never
   * produces one fails closed with a synthesized `failed` result, never a
   * hang `wait_for_agent` cannot observe.
   */
  const trackBackground = (
    agentId: string,
    worked: Promise<AgentResult>,
    what: string,
  ): void => {
    void worked.then(
      (result) => {
        settle.noteSettled(agentId, result);
        deps.scheduler.complete(agentId);
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
        deps.scheduler.complete(agentId);
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
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timeout = new Promise<void>((resolve) => {
            timer = setTimeout(resolve, Math.max(0, remaining));
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
          ...(dims === undefined ? {} : { budget: dims }),
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
      return {
        content: [{ type: 'text', text: JSON.stringify(row) }],
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
      // wait/collect observe it and the scheduler slot frees — the run
      // continues with its siblings.
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
      deps.scheduler.complete(agentId);
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

  return {
    spawnAgent,
    waitForAgent,
    collectResult,
    inspectAgent,
    cancelAgent,
    sendToAgent,
    settle: {
      resultOf: (agentId) => settle.resultOf(agentId),
    },
  };
}

/**
 * The lane's 13 tools in allowlist order: the step-2 and step-3 adapters
 * plus the remaining stubs (steps 4–5 replace them). The lane boots this
 * set.
 */
export function managerToolsWithStubs(
  deps: ManagerToolsDeps,
): ToolRegistration[] {
  const tools = buildManagerTools(deps);
  const real = new Map([
    ['spawn_agent', tools.spawnAgent],
    ['send_to_agent', tools.sendToAgent],
    ['wait_for_agent', tools.waitForAgent],
    ['cancel_agent', tools.cancelAgent],
    ['inspect_agent', tools.inspectAgent],
    ['collect_result', tools.collectResult],
  ]);
  const stubs = new Map(managerToolStubs().map((tool) => [tool.name, tool]));
  return MANAGER_ALLOWLIST.map((name) => {
    const tool = real.get(name) ?? stubs.get(name);
    if (tool === undefined) throw new Error(`no manager tool '${name}'`);
    return tool;
  });
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
