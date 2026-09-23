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
  const result = validateAgentTask(normalized);
  if (!result.valid) return { valid: false, errors: result.errors };
  return { valid: true, transfer: sealTransfer(normalized) };
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
