// Opt-in orchestrator budgets (issue #48; §71 enforcement table).
// No defaults: an empty budget is valid and enforces nothing. Each dim
// (maxTokens/maxCostUsd/maxRuntimeMs/maxToolCalls/retryBudget) is
// validated positive when present. Burn-down tracks spend; the before_tool
// gate blocks with budget_exhausted — a distinct status from failure that
// maps to exit 3 (RUN_EXIT_BUDGET). Above-task raises need user approval:
// a worker self-raise of its own budget is refused, never applied.
import { RUN_EXIT_BUDGET } from '../../run-cli.js';

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
