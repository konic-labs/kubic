// TaskTransfer boundedness enforcement (issue #31; design §24, §71).
// The transfer schema itself is AgentTask (#6, §67) — there is no second
// schema here, only the spawn-time enforcement on top of it: the validated
// transfer is sealed to the closed AgentTask field list, so only the
// transfer object (task + worktree + grant) ever travels to the child.

import type { AgentTask } from './task.js';
import { AGENT_TASK_FIELDS, validateAgentTask } from './task.js';

export type TaskTransfer = AgentTask;

export type TransferValidation =
  | { valid: true; transfer: TaskTransfer }
  | { valid: false; errors: string[] };

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
  const result = validateAgentTask(input);
  if (!result.valid) return { valid: false, errors: result.errors };
  return { valid: true, transfer: sealTransfer(input) };
}
