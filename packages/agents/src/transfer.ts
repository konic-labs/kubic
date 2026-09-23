// TaskTransfer boundedness enforcement (issue #31; design §24, §71).
// The transfer schema itself is AgentTask (#6, §67) — there is no second
// schema here, only the spawn-time enforcement on top of it: the validated
// transfer is sealed to the closed AgentTask field list, so only the
// transfer object (task + worktree + grant) ever travels to the child.

import type { AgentBudget } from './budget.js';
import type { AgentTask } from './task.js';
import { AGENT_TASK_FIELDS, validateAgentTask } from './task.js';

export type TaskTransfer = AgentTask;

export type TransferValidation =
  | { valid: true; transfer: TaskTransfer }
  | { valid: false; errors: string[] };

export class TransferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransferError';
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Seal a validated transfer to the closed AgentTask field list, dropping
// anything the parent smuggled alongside it. The child receives this sealed
// object and nothing else.
function sealTransfer(input: Record<string, unknown>): TaskTransfer {
  const sealed: Record<string, unknown> = {};
  for (const field of Object.keys(AGENT_TASK_FIELDS)) {
    if (field in input && input[field] !== undefined) {
      sealed[field] = input[field];
    }
  }
  return sealed as unknown as TaskTransfer;
}

export function validateTransferSpawn(input: unknown): TransferValidation {
  if (!isObject(input)) {
    return { valid: false, errors: ['transfer must be an object'] };
  }
  // No-transcript guarantee (§24): the parent conversation history never
  // travels — only the bounded transfer object does.
  if ('transcript' in input) {
    return {
      valid: false,
      errors: ['transfer must not carry a transcript (§24)'],
    };
  }
  // §71: budgets are opt-in — a spawn without a budget key carries no
  // limits, it is not malformed. Default before delegating to the AgentTask
  // check, which requires the key to be present.
  const normalized: Record<string, unknown> =
    input.budget === undefined ? { ...input, budget: {} } : input;
  if (normalized.budget !== undefined && !isObject(normalized.budget)) {
    return {
      valid: false,
      errors: ['budget must be an object when configured'],
    };
  }
  // Worktree + grant arrive together: a task pinned to a worktree without
  // the capability grant (or vice versa) cannot spawn.
  const hasWorktree =
    typeof normalized.worktree === 'string' &&
    normalized.worktree.startsWith('/');
  const hasGrant =
    typeof normalized.workspaceMode === 'string' &&
    Array.isArray(normalized.toolNames) &&
    normalized.toolNames.length > 0;
  if (hasWorktree !== hasGrant) {
    return {
      valid: false,
      errors: [
        'worktree and grant (workspaceMode + toolNames) must arrive together (§24)',
      ],
    };
  }
  const result = validateAgentTask(normalized);
  if (!result.valid) return { valid: false, errors: result.errors };
  return { valid: true, transfer: sealTransfer(normalized) };
}

// The capability grant travels with the task: workspace mode plus the tool
// allowlist. The ref is derived deterministically so the trajectory log can
// point at the exact grant without carrying it.
export function grantRefFor(
  transfer: Pick<TaskTransfer, 'workspaceMode' | 'toolNames'>,
): string {
  return `${transfer.workspaceMode}:${[...transfer.toolNames].sort().join(',')}`;
}

// Trajectory log record for a transfer (§24): task, worktree, and grant ref
// — the audit trail that the child started from this bounded object. Plain
// JSON data by construction; the host appends it to the trajectory.
export interface TransferLogRecord {
  kind: 'transfer';
  taskId: string;
  worktree: string;
  grantRef: string;
}

export function buildTransferLog(transfer: TaskTransfer): TransferLogRecord {
  return {
    kind: 'transfer',
    taskId: transfer.taskId,
    worktree: transfer.worktree,
    grantRef: grantRefFor(transfer),
  };
}

// §71: only a configured budget travels. Absent or empty means no limits —
// never a smuggled default.
export function isBudgetConfigured(budget: AgentBudget | undefined): boolean {
  return (
    budget !== undefined && isObject(budget) && Object.keys(budget).length > 0
  );
}

// JSON-serializable copy of a transfer for the spawn path: proof that only
// plain data travels, with the budget key present only when configured.
export function serializeTransfer(
  transfer: TaskTransfer,
): Record<string, unknown> {
  let json: string | undefined;
  try {
    json = JSON.stringify(transfer);
  } catch {
    throw new TransferError('transfer must be JSON-serializable (§24)');
  }
  if (typeof json !== 'string') {
    throw new TransferError('transfer must be JSON-serializable (§24)');
  }
  const revived = JSON.parse(json) as Record<string, unknown>;
  if (!isBudgetConfigured(revived.budget as AgentBudget | undefined)) {
    delete revived.budget;
  }
  return revived;
}
