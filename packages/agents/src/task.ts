// AgentTask agent-context contract (issue #6; design §67).
// The task and the capability grant travel together: there is no way to hand
// an agent work without also deciding what it may touch.
//
// Dependent types refined by their owning issues: AgentRole becomes a closed
// union in #44 (role presets); ModelSelection/ScopedModel gain provider
// catalog fields in #20; TaskArtifactRef grows transfer metadata in #32.

import type { AgentBudget } from './budget.js';

export type AgentRole = string;

export interface ModelSelection {
  provider: string;
  model: string;
  thinking?: string;
}

export interface ScopedModel {
  scope: string;
  provider: string;
  model: string;
}

export interface TaskResources {
  skills?: string[];
  promptTemplates?: string[];
}

export interface TaskArtifactRef {
  artifactId: string;
}

export const WORKSPACE_MODES = ['shared', 'worktree', 'copy'] as const;

export type WorkspaceMode = (typeof WORKSPACE_MODES)[number];

export interface AgentTask {
  taskId: string;
  parentSessionId: string;
  role: AgentRole;
  objective: string;
  worktree: string;
  constraints?: string[];
  relevantFiles?: string[];
  previousFindings?: string;
  expectedOutput?: string;
  model?: ModelSelection;
  scopedModels?: ScopedModel[];
  workspaceMode: WorkspaceMode;
  toolNames: string[];
  budget: AgentBudget;
  resources?: TaskResources;
  artifacts?: TaskArtifactRef[];
}

// Closed-world field coverage: adding or removing an AgentTask field breaks
// compilation here, so the contract cannot drift from §67 silently.
export const AGENT_TASK_FIELDS = {
  taskId: true,
  parentSessionId: true,
  role: true,
  objective: true,
  worktree: true,
  constraints: true,
  relevantFiles: true,
  previousFindings: true,
  expectedOutput: true,
  model: true,
  scopedModels: true,
  workspaceMode: true,
  toolNames: true,
  budget: true,
  resources: true,
  artifacts: true,
} satisfies Record<keyof AgentTask, true>;

export type TaskValidation =
  | { valid: true; task: AgentTask }
  | { valid: false; errors: string[] };

/**
 * What the manager knows when it hands a worker its work (issue #191): the
 * §67 task's identity, the objective the worker runs, its worktree and the
 * capability grant — the tool names its lane may register.
 */
export interface AgentTaskInput {
  taskId: string;
  parentSessionId: string;
  role: string;
  objective: string;
  worktree: string;
  toolNames: readonly string[];
  budget?: AgentBudget;
  constraints?: readonly string[];
  expectedOutput?: string;
  model?: ModelSelection;
}

// Build AND validate in one call (§67, issue #191): the manager builds the
// task it transmits to a worker child, and an invalid task is a named
// refusal before any process exists. `workspaceMode` is always 'worktree' on
// this path — §11.1 gives every subagent its own worktree, and the shared /
// copy modes are not implemented.
export function buildAgentTask(input: AgentTaskInput): TaskValidation {
  return validateAgentTask({
    taskId: input.taskId,
    parentSessionId: input.parentSessionId,
    role: input.role,
    objective: input.objective,
    worktree: input.worktree,
    workspaceMode: 'worktree',
    toolNames: [...input.toolNames],
    budget: input.budget ?? {},
    ...(input.constraints === undefined
      ? {}
      : { constraints: [...input.constraints] }),
    ...(input.expectedOutput === undefined
      ? {}
      : { expectedOutput: input.expectedOutput }),
    ...(input.model === undefined ? {} : { model: input.model }),
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateAgentTask(input: unknown): TaskValidation {
  const errors: string[] = [];
  if (!isObject(input))
    return { valid: false, errors: ['task must be an object'] };

  for (const field of [
    'taskId',
    'parentSessionId',
    'role',
    'objective',
  ] as const) {
    if (!isNonEmptyString(input[field]))
      errors.push(`${field} must be a non-empty string`);
  }

  if (!isNonEmptyString(input.worktree)) {
    errors.push('worktree must be a non-empty string');
  } else if (!input.worktree.startsWith('/')) {
    errors.push('worktree must be an absolute path');
  }

  if (
    typeof input.workspaceMode !== 'string' ||
    !(WORKSPACE_MODES as readonly string[]).includes(input.workspaceMode)
  ) {
    errors.push(`workspaceMode must be one of ${WORKSPACE_MODES.join(', ')}`);
  }

  if (
    !Array.isArray(input.toolNames) ||
    input.toolNames.length === 0 ||
    input.toolNames.some((t) => !isNonEmptyString(t))
  ) {
    errors.push('toolNames must be a non-empty array of non-empty strings');
  }

  if (!isObject(input.budget)) errors.push('budget must be present');

  if (errors.length > 0) return { valid: false, errors };
  // Validated above: required fields are present with the right shapes.
  // Optional fields keep their declared types via the AgentTask annotation.
  return { valid: true, task: input as unknown as AgentTask };
}
