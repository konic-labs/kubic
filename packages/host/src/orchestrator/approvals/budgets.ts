// Opt-in orchestrator budgets (issue #48; §71 enforcement table).
// No defaults: an empty budget is valid and enforces nothing. Each dim
// (maxTokens/maxCostUsd/maxRuntimeMs/maxToolCalls/retryBudget) is
// validated positive when present. Burn-down tracks spend; the beforeTool
// gate blocks with budget_exhausted — a distinct status from failure that
// maps to exit 3 (RUN_EXIT_BUDGET). Above-task raises need user approval:
// a worker self-raise of its own budget is refused, never applied.

import type { HookRegistration } from '../../../../worker/src/pi-boundary.js';
import { hook, ToolTask } from '../../../../worker/src/pi-boundary.js';
import type { KubicUsageRow } from '../../../../worker/src/usage.js';
import { MAX_RUN_TIMEOUT_MS, RUN_EXIT_BUDGET } from '../../run-cli.js';

export const BUDGET_EXHAUSTED = 'BUDGET_EXHAUSTED';

export { RUN_EXIT_BUDGET };

export interface RetryBudgetConfig {
  maxAttempts: number;
  maxCostUsd: number;
}

export interface OrchestratorBudget {
  maxTokens?: number;
  maxCostUsd?: number;
  maxRuntimeMs?: number;
  maxToolCalls?: number;
  retryBudget?: RetryBudgetConfig;
}

export class OrchestratorBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrchestratorBudgetError';
  }
}

function assertPositive(name: string, value: unknown): void {
  // Number.isFinite closes the Infinity evasion: an unbounded limit would
  // disable the dimension while looking configured.
  if (typeof value !== 'number' || !Number.isFinite(value) || !(value > 0)) {
    throw new OrchestratorBudgetError(`${name} must be a positive number`);
  }
}

// The keys a budget object may carry (the validator's own set).
const BUDGET_KEYS: readonly string[] = [
  'maxTokens',
  'maxCostUsd',
  'maxRuntimeMs',
  'maxToolCalls',
  'retryBudget',
];

export function validateOrchestratorBudget(input: unknown): OrchestratorBudget {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new OrchestratorBudgetError('orchestrator budget must be an object');
  }
  const record = input as Record<string, unknown>;
  const budget: OrchestratorBudget = {};
  if (record.maxTokens !== undefined) {
    assertPositive('maxTokens', record.maxTokens);
    budget.maxTokens = record.maxTokens as number;
  }
  if (record.maxCostUsd !== undefined) {
    assertPositive('maxCostUsd', record.maxCostUsd);
    budget.maxCostUsd = record.maxCostUsd as number;
  }
  if (record.maxRuntimeMs !== undefined) {
    assertPositive('maxRuntimeMs', record.maxRuntimeMs);
    // setTimeout stores its delay in a 32-bit signed int: above this the
    // "bound" clamps to 1ms and the wall-clock watchdog would fire (and
    // misreport limit=wallClock) almost immediately. Refused, never clamped.
    if ((record.maxRuntimeMs as number) > MAX_RUN_TIMEOUT_MS) {
      throw new OrchestratorBudgetError(
        `maxRuntimeMs must be no more than ${MAX_RUN_TIMEOUT_MS}`,
      );
    }
    budget.maxRuntimeMs = record.maxRuntimeMs as number;
  }
  if (record.maxToolCalls !== undefined) {
    assertPositive('maxToolCalls', record.maxToolCalls);
    budget.maxToolCalls = record.maxToolCalls as number;
  }
  if (record.retryBudget !== undefined) {
    const retry = record.retryBudget as Record<string, unknown>;
    if (typeof retry !== 'object' || retry === null) {
      throw new OrchestratorBudgetError('retryBudget must be an object');
    }
    assertPositive('retryBudget.maxAttempts', retry.maxAttempts);
    assertPositive('retryBudget.maxCostUsd', retry.maxCostUsd);
    budget.retryBudget = {
      maxAttempts: retry.maxAttempts as number,
      maxCostUsd: retry.maxCostUsd as number,
    };
  }
  return budget;
}

export interface BudgetUsage {
  tokens: number;
  costUsd: number;
  runtimeMs: number;
  toolCalls: number;
  retries: number;
}

export interface BurnDownState extends BudgetUsage {
  startedAt: number;
}

export function createBurnDown(
  _budget: OrchestratorBudget,
  clock: () => number = Date.now,
): BurnDownState {
  return {
    tokens: 0,
    costUsd: 0,
    runtimeMs: 0,
    toolCalls: 0,
    retries: 0,
    startedAt: clock(),
  };
}

export type BudgetLimit =
  | 'tokens'
  | 'cost'
  | 'wallClock'
  | 'toolCalls'
  | 'retries';

export interface BudgetTermination {
  status: 'budget_exhausted';
  limit: BudgetLimit;
}

export function checkBudgetExhaustion(
  budget: OrchestratorBudget,
  usage: BudgetUsage,
): BudgetTermination | undefined {
  if (budget.maxTokens !== undefined && usage.tokens >= budget.maxTokens) {
    return { status: 'budget_exhausted', limit: 'tokens' };
  }
  if (budget.maxCostUsd !== undefined && usage.costUsd >= budget.maxCostUsd) {
    return { status: 'budget_exhausted', limit: 'cost' };
  }
  if (
    budget.maxRuntimeMs !== undefined &&
    usage.runtimeMs >= budget.maxRuntimeMs
  ) {
    return { status: 'budget_exhausted', limit: 'wallClock' };
  }
  if (
    budget.maxToolCalls !== undefined &&
    usage.toolCalls >= budget.maxToolCalls
  ) {
    return { status: 'budget_exhausted', limit: 'toolCalls' };
  }
  if (
    budget.retryBudget !== undefined &&
    (usage.retries >= budget.retryBudget.maxAttempts ||
      usage.costUsd >= budget.retryBudget.maxCostUsd)
  ) {
    return { status: 'budget_exhausted', limit: 'retries' };
  }
  return undefined;
}

export interface BeforeToolEvent {
  toolCallId: string;
  toolName: string;
}

export interface BeforeToolVerdict {
  block: { reason: string; terminate: false };
}

export interface BudgetGate {
  (event: BeforeToolEvent): BeforeToolVerdict | undefined;
  usage: BudgetUsage;
}

// Spend lives behind the gate, never in the caller's hands: `usage` is a
// read-only snapshot getter (each read returns a copy), so mutating the
// returned object cannot reset burn-down. recordToolCall is the only
// writer, and it reaches the ledger through this registry.
const gateLedgers = new WeakMap<BudgetGate, BudgetUsage>();

function assertSpend(name: string, value: number | undefined): number {
  const amount = value ?? 0;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
    throw new OrchestratorBudgetError(
      `${name} spend must be a finite, non-negative number`,
    );
  }
  return amount;
}

export function createBudgetGate(budget: OrchestratorBudget): BudgetGate {
  const ledger: BudgetUsage = {
    tokens: 0,
    costUsd: 0,
    runtimeMs: 0,
    toolCalls: 0,
    retries: 0,
  };
  const gate = ((event: BeforeToolEvent): BeforeToolVerdict | undefined => {
    const hit = checkBudgetExhaustion(budget, ledger);
    if (hit === undefined) return undefined;
    return {
      block: {
        reason: `budget_exhausted (${hit.limit}): call ${event.toolCallId} blocked — ${BUDGET_EXHAUSTED}, exit ${RUN_EXIT_BUDGET}`,
        terminate: false as const,
      },
    };
  }) as BudgetGate;
  gateLedgers.set(gate, ledger);
  Object.defineProperty(gate, 'usage', {
    enumerable: true,
    get: (): BudgetUsage => ({ ...ledger }),
  });
  return gate;
}

export function recordToolCall(
  gate: BudgetGate,
  spend: { tokens?: number; costUsd?: number; runtimeMs?: number } = {},
): void {
  const ledger = gateLedgers.get(gate);
  if (ledger === undefined) {
    throw new OrchestratorBudgetError('unknown budget gate');
  }
  ledger.toolCalls += 1;
  ledger.tokens += assertSpend('tokens', spend.tokens);
  ledger.costUsd += assertSpend('costUsd', spend.costUsd);
  ledger.runtimeMs += assertSpend('runtimeMs', spend.runtimeMs);
}

// ---------------------------------------------------------------------------
// Child-side run enforcement (issue #208, §71)
// ---------------------------------------------------------------------------

// The manager hands each worker its resolved budget through this §3.8
// allowlisted env var; the child's lane then runs under the meter below.
// maxRuntimeMs is deliberately NOT part of the handoff: wall clock is the
// manager's watchdog (host ownership, §71), never the child's.
export const AGENT_BUDGET_ENV = 'KUBIC_BUDGET';

// The meter the child's lane runs under: maxToolCalls counts every tool
// ATTEMPT (brokered or not), tokens/cost come from the lane's own usage
// roll-up. Every refused attempt and every accumulated row is checked against
// the SAME budget via checkBudgetExhaustion, so the child and the parent can
// never disagree about which dimension tripped.
export interface RunBudgetMeter {
  usage: () => BudgetUsage;
  /**
   * Consulted BEFORE each tool attempt: the returned termination blocks the
   * attempt; undefined admits it (and counts it).
   */
  nextToolCall: () => BudgetTermination | undefined;
  /** Adds one usage row; the returned termination ends the run. */
  recordUsage: (spend: {
    tokens?: number;
    costUsd?: number;
  }) => BudgetTermination | undefined;
}

export function createRunBudgetMeter(
  budget: OrchestratorBudget,
): RunBudgetMeter {
  const usage: BudgetUsage = {
    tokens: 0,
    costUsd: 0,
    runtimeMs: 0,
    toolCalls: 0,
    retries: 0,
  };
  const exhausted = (): BudgetTermination | undefined =>
    checkBudgetExhaustion(budget, usage);
  return {
    usage: () => ({ ...usage }),
    nextToolCall: () => {
      const hit = exhausted();
      if (hit !== undefined) return hit;
      // The attempt is counted only once it is admitted, so the cap admits
      // exactly maxToolCalls calls and refuses the next.
      usage.toolCalls += 1;
      return undefined;
    },
    recordUsage: (spend) => {
      usage.tokens += assertSpend('tokens', spend.tokens);
      usage.costUsd += assertSpend('costUsd', spend.costUsd);
      return exhausted();
    },
  };
}

// The minimal row shape the child reads. Structural on purpose: the meter
// understands a usage row without this module importing the harness types.
export interface BudgetUsageRowLike {
  usage: { input: number; output: number; cost: { total: number } };
}

// Tokens are input+output (the count the run's own readout prints); cost is
// the row's own total. Cache reads/writes are excluded from the token count
// so a cache-heavy turn is not billed twice against the window.
export function usageSpendOf(row: BudgetUsageRowLike): {
  tokens: number;
  costUsd: number;
} {
  return {
    tokens: row.usage.input + row.usage.output,
    costUsd: row.usage.cost.total,
  };
}

// The child's half of a resolved budget: wall clock belongs to the manager's
// watchdog, so it never travels in KUBIC_BUDGET.
export function childBudgetOf(budget: OrchestratorBudget): OrchestratorBudget {
  const child = { ...budget };
  delete child.maxRuntimeMs;
  return child;
}

// Parse the env handoff, fail closed: a malformed payload is a usage error at
// the child (never a silently-dropped limit). Absent/empty means no budget.
export function parseWorkerBudgetEnv(
  raw: string | undefined,
): OrchestratorBudget | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new OrchestratorBudgetError(
      `worker budget env (${AGENT_BUDGET_ENV}) is not valid JSON`,
    );
  }
  // Every refusal names the variable, and an unknown key is refused: the
  // validator copies only the keys it knows, so a typo'd `maxToolcalls`
  // would otherwise run with NO limit while looking configured.
  try {
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      for (const key of Object.keys(parsed)) {
        if (!BUDGET_KEYS.includes(key)) {
          throw new OrchestratorBudgetError(
            `unknown budget key ${JSON.stringify(key)} (known: ${BUDGET_KEYS.join(', ')})`,
          );
        }
      }
    }
    return validateOrchestratorBudget(parsed);
  } catch (error) {
    if (!(error instanceof OrchestratorBudgetError)) throw error;
    throw new OrchestratorBudgetError(`${AGENT_BUDGET_ENV}: ${error.message}`);
  }
}

// The harness seams the child enforcement attaches to. Structural (never a
// harness import) so the wiring itself is unit-testable with fakes.

/**
 * The run's budget enforcer as one pi-durable `ToolTask` hook plus a usage
 * sink (issue #397). The gate is registered as the `kubic.budget` extension,
 * BEFORE `kubic.policy`: a beforeTool chain stops at the FIRST block, so the
 * attempt counter must subscribe before the policy guards — a later
 * subscriber never sees a blocked/denied call and would undercount (#208).
 * `onUsage(row)` is fed from the lane's routed usage events (#398).
 */
export interface RunBudgetEnforcer {
  /** The `kubic.budget` extension's hooks: beforeTool counts every attempt. */
  hooks(): HookRegistration[];
  /** USAGE sink: accumulates spend and reports the breach. */
  onUsage: (row: KubicUsageRow) => void;
}

export function budgetBlockReason(termination: BudgetTermination): string {
  return `budget ${BUDGET_EXHAUSTED} (limit=${termination.limit}): the call is blocked, exit ${RUN_EXIT_BUDGET}`;
}

// One meter behind both seams: every beforeTool ATTEMPT counts (including
// one a later policy handler blocks) and every usage row accumulates; the
// FIRST termination calls onBreach exactly once (the run ends on it) and
// every later attempt is still blocked.
export function createRunBudgetEnforcer(
  budget: OrchestratorBudget,
  onBreach: (termination: BudgetTermination) => void,
): RunBudgetEnforcer {
  const meter = createRunBudgetMeter(budget);
  let breached: BudgetTermination | undefined;
  const stop = (termination: BudgetTermination): { block: string } => {
    if (breached === undefined) {
      breached = termination;
      onBreach(termination);
    }
    return { block: budgetBlockReason(termination) };
  };
  const onToolAttempt = (): { block: string } | undefined => {
    const hit = meter.nextToolCall();
    return hit === undefined ? undefined : stop(hit);
  };
  // Built once: `hooks()` hands the same registrations to every caller, so a
  // read-twice wiring cannot manufacture a second beforeTool handler over
  // the same meter (which would count every attempt twice).
  const registrations: HookRegistration[] = [
    hook(ToolTask, { beforeTool: () => onToolAttempt() }),
  ];
  return {
    hooks: () => registrations,
    onUsage: (row) => {
      const hit = meter.recordUsage(usageSpendOf(row));
      if (hit !== undefined) stop(hit);
    },
  };
}

export interface SelfRaiseRefusal {
  refused: true;
  reason: string;
}

export type BudgetRaiseResult =
  | { applied: true; budget: OrchestratorBudget }
  | { applied: false; reason: string };

// Lawful raises need user approval, proven by capability — not by string.
// A bare approver:'user' string carries no authority (any caller can utter
// it) and is refused. The only lawful approver is a UserBudgetApproval
// minted by mintUserBudgetApproval, which only the user-dialog path may
// call: the module-held grant symbol cannot be forged by workers, the
// manager, or config input.
const USER_BUDGET_GRANT = Symbol('kubic:user-budget-grant');

export interface UserBudgetApproval {
  readonly decider: 'user';
  readonly grant: symbol;
}

export function mintUserBudgetApproval(): UserBudgetApproval {
  return { decider: 'user', grant: USER_BUDGET_GRANT };
}

export function applyBudgetRaise(input: {
  approver: string | UserBudgetApproval;
  owner: string;
  current: OrchestratorBudget;
  proposed: OrchestratorBudget;
}): BudgetRaiseResult {
  const approver = input.approver;
  const lawful =
    typeof approver === 'object' &&
    approver !== null &&
    approver.decider === 'user' &&
    approver.grant === USER_BUDGET_GRANT;
  if (!lawful) {
    const named =
      typeof approver === 'string'
        ? approver
        : (approver as { decider?: unknown }).decider === 'user'
          ? 'user (invalid grant)'
          : 'unknown';
    const refusal = refuseSelfRaise({
      caller: named,
      owner: input.owner,
      current: input.current,
      proposed: input.proposed,
    });
    return { applied: false, reason: refusal.reason };
  }
  try {
    return {
      applied: true,
      budget: validateOrchestratorBudget({
        ...input.current,
        ...input.proposed,
      }),
    };
  } catch (error) {
    return {
      applied: false,
      reason:
        error instanceof Error
          ? error.message
          : 'proposed budget failed validation',
    };
  }
}
export function refuseSelfRaise(input: {
  caller: string;
  owner: string;
  current: OrchestratorBudget;
  proposed: OrchestratorBudget;
}): SelfRaiseRefusal {
  void input.current;
  void input.proposed;
  if (input.caller === input.owner) {
    return {
      refused: true,
      reason: `self-raise refused: agent ${input.caller} cannot raise its own budget — above-task needs user approval`,
    };
  }
  return {
    refused: true,
    reason: `self-raise refused: agent ${input.caller} cannot raise budget for ${input.owner} — above-task needs user approval`,
  };
}

export interface BudgetTrajectoryEvent {
  type: 'budget';
  agentId: string;
  spent: BudgetUsage;
  remaining: {
    maxTokens?: number;
    maxCostUsd?: number;
    maxRuntimeMs?: number;
    maxToolCalls?: number;
  };
  exhausted?: BudgetTermination;
}

export function buildBudgetTrajectoryEvent(
  agentId: string,
  budget: OrchestratorBudget,
  usage: BudgetUsage,
): BudgetTrajectoryEvent {
  return {
    type: 'budget',
    agentId,
    spent: { ...usage },
    remaining: {
      ...(budget.maxTokens !== undefined
        ? { maxTokens: Math.max(0, budget.maxTokens - usage.tokens) }
        : {}),
      ...(budget.maxCostUsd !== undefined
        ? { maxCostUsd: Math.max(0, budget.maxCostUsd - usage.costUsd) }
        : {}),
      ...(budget.maxRuntimeMs !== undefined
        ? { maxRuntimeMs: Math.max(0, budget.maxRuntimeMs - usage.runtimeMs) }
        : {}),
      ...(budget.maxToolCalls !== undefined
        ? { maxToolCalls: Math.max(0, budget.maxToolCalls - usage.toolCalls) }
        : {}),
    },
    ...(checkBudgetExhaustion(budget, usage) === undefined
      ? {}
      : {
          exhausted: checkBudgetExhaustion(budget, usage) as BudgetTermination,
        }),
  };
}
