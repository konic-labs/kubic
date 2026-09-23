// AgentBudget + ReplayPin contracts (issue #9; design §71, §72).
// Kubic ships with NO budgets by default: createBudget never injects limits.
// Budget exhaustion is a distinct termination status, never a generic failure.

export interface RetryBudget {
  maxAttempts: number;
  maxCostUsd: number;
}

export interface AgentBudget {
  maxTokens?: number;
  maxCostUsd?: number;
  maxRuntimeMs?: number;
  maxToolCalls?: number;
  retryBudget?: RetryBudget;
}

export function createBudget(partial: AgentBudget): AgentBudget {
  const budget: AgentBudget = { ...partial };
  if (partial.retryBudget !== undefined) {
    budget.retryBudget = { ...partial.retryBudget };
  }
  return budget;
}

export const BUDGET_LIMITS = [
  'tokens',
  'cost',
  'wallClock',
  'toolCalls',
  'retries',
] as const;

export type BudgetLimit = (typeof BUDGET_LIMITS)[number];

export interface BudgetEnforcer {
  enforcedBy: string;
  mechanism: string;
}

export const BUDGET_OWNERSHIP: Record<BudgetLimit, BudgetEnforcer> = {
  tokens: { enforcedBy: 'harness', mechanism: 'context accounting' },
  cost: { enforcedBy: 'host', mechanism: 'usage roll-up' },
  wallClock: { enforcedBy: 'host', mechanism: 'watchdog' },
  toolCalls: { enforcedBy: 'before_tool hook', mechanism: 'per-call gate' },
  retries: {
    enforcedBy: 'separate retry budget',
    mechanism: 'attempt + cost caps',
  },
};

export type RunMode = 'autonomous' | 'interactive';

export type BlockedSpawnOutcome =
  | { outcome: 'queued' }
  | { outcome: 'failed'; reason: string };

export function resolveBlockedSpawn(
  mode: RunMode,
  reason: string,
): BlockedSpawnOutcome {
  if (mode === 'autonomous') return { outcome: 'queued' };
  return { outcome: 'failed', reason };
}

export interface BudgetTermination {
  status: 'budget_exhausted';
  limit: BudgetLimit;
}

export function terminateForBudget(limit: BudgetLimit): BudgetTermination {
  return { status: 'budget_exhausted', limit };
}

export const REPLAY_PIN_DIMS = [
  'task',
  'model+thinking',
  'toolSet',
  'worktree',
  'baseRevision',
  'prompt+resources',
] as const;

export type ReplayPinDim = (typeof REPLAY_PIN_DIMS)[number];

export interface ReplayPin {
  task: string;
  model: string;
  thinking: string;
  toolSet: string[];
  worktree: string;
  baseRevision: string;
  systemPrompt: string;
  resources: string[];
}

// Closed-world field coverage: adding or removing a ReplayPin field breaks
// compilation here, so the shape cannot drift silently.
export const REPLAY_PIN_FIELDS = {
  task: true,
  model: true,
  thinking: true,
  toolSet: true,
  worktree: true,
  baseRevision: true,
  systemPrompt: true,
  resources: true,
} satisfies Record<keyof ReplayPin, true>;

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function diffReplayPin(
  before: ReplayPin,
  after: ReplayPin,
): ReplayPinDim[] {
  const dims: ReplayPinDim[] = [];
  if (before.task !== after.task) dims.push('task');
  if (before.model !== after.model || before.thinking !== after.thinking) {
    dims.push('model+thinking');
  }
  if (!arraysEqual(before.toolSet, after.toolSet)) dims.push('toolSet');
  if (before.worktree !== after.worktree) dims.push('worktree');
  if (before.baseRevision !== after.baseRevision) dims.push('baseRevision');
  if (
    before.systemPrompt !== after.systemPrompt ||
    !arraysEqual(before.resources, after.resources)
  ) {
    dims.push('prompt+resources');
  }
  return dims;
}
