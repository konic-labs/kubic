// Built-in role presets as data (issue #44; §12 table, §38.2, §71).
// The five `.kubic/roles/*.md` documents are the reviewable source of
// prompts, tool sets, and model defaults. This module adds only the tiny
// data shape the resolver must not own: the closed role list spawn
// validates against plus per-role model defaults. The resolver (issue
// #43) is consumed read-only — this file never modifies it.
import {
  createGenerationState,
  type SpawnOutcome,
  spawnAgent,
} from '../../../agents/src/spec.js';
import type {
  AgentTask,
  ModelSelection,
  ScopedModel,
} from '../../../agents/src/task.js';
import type { ParsedRoleDoc } from './resolver.js';

export const BUILTIN_ROLE_NAMES = [
  'planner',
  'implementer',
  'tester',
  'debugger',
  'reviewer',
] as const;

export type BuiltinRoleName = (typeof BUILTIN_ROLE_NAMES)[number];

// §12/§38.1: the preset's THINKING half only. The role table's "model
// default" column names a capability ("strongest reasoning", "fast
// coding"), never a provider: the model itself resolves from
// spawn_agent({model}) > [roles.<r>].model > the manager's effective model
// (issue #202), so a role preset can no longer force `local/llama3` on every
// worker of a repo that configured its own model.
export const ROLE_THINKING_DEFAULTS: Record<BuiltinRoleName, string> = {
  planner: 'medium',
  implementer: 'medium',
  tester: 'low',
  debugger: 'high',
  reviewer: 'low',
};

export function isBuiltinRole(name: string): name is BuiltinRoleName {
  return (BUILTIN_ROLE_NAMES as readonly string[]).includes(name);
}

function spawnFailed(reason: string): SpawnOutcome {
  return { ok: false, code: 'SPAWN_FAILED', reason };
}

function parseConfigModel(
  role: string,
  ref: string,
  source: string = `[roles.${role}].model`,
): { model: ModelSelection } | { error: string } {
  const slash = ref.indexOf('/');
  if (slash <= 0 || slash === ref.length - 1) {
    return {
      error: `${source} must be 'provider/id' (got ${JSON.stringify(ref)}): refusing spawn`,
    };
  }
  return {
    model: {
      provider: ref.slice(0, slash),
      model: ref.slice(slash + 1),
    },
  };
}

export interface RoleSpawnRequest {
  role: string;
  docs: ParsedRoleDoc[];
  sessionId: string;
  parentSessionId: string;
  worktree: string;
  taskId?: string;
  objective?: string;
  configModel?: string;
  taskModel?: ModelSelection;
  /**
   * The manager's effective model pin (`provider/id`, issue #202): the
   * fallback level under the role's own `[roles.<r>].model` and the
   * spawn override.
   */
  parentModel?: string;
  isGitWorktree?: (path: string) => boolean;
}

// Role-aware spawn: unknown roles fail with SPAWN_FAILED (§38.2 scoped
// set, fixed-in-v1 role list — the manager composes from the five, never
// invents). Model precedence (§38.1, issue #202): spawn_agent({model}) beats
// [roles.<r>].model beats the manager's own model; a caller that resolved
// none of them is refused by name rather than handed a hardcoded provider.
// The role's thinking default rides the winning model.
export function spawnForRole(request: RoleSpawnRequest): SpawnOutcome {
  if (!isBuiltinRole(request.role)) {
    return spawnFailed(
      `unknown role '${request.role}' (not one of ${BUILTIN_ROLE_NAMES.join(', ')}): refusing spawn`,
    );
  }
  const doc = request.docs.find((entry) => entry.name === request.role);
  if (doc === undefined) {
    return spawnFailed(
      `role '${request.role}' has no loaded document: refusing spawn`,
    );
  }
  if (doc.tools === undefined || doc.tools.length === 0) {
    return spawnFailed(
      `role '${request.role}' declares no tool set: refusing spawn`,
    );
  }
  const thinking = ROLE_THINKING_DEFAULTS[request.role];
  let model: ModelSelection | undefined;
  if (request.configModel !== undefined) {
    const parsed = parseConfigModel(request.role, request.configModel);
    if ('error' in parsed) return spawnFailed(parsed.error);
    model = { ...parsed.model, thinking };
  } else if (request.parentModel !== undefined) {
    const parsed = parseConfigModel(
      request.role,
      request.parentModel,
      'the manager model',
    );
    if ('error' in parsed) return spawnFailed(parsed.error);
    model = { ...parsed.model, thinking };
  }
  if (request.taskModel !== undefined) {
    model = { ...request.taskModel };
  }
  if (model === undefined) {
    return spawnFailed(
      `no model for role '${request.role}': set [roles.${request.role}].model, pass spawn_agent({model}), or pin the run's model — refusing spawn`,
    );
  }
  const scopedModels: ScopedModel[] = [
    { scope: 'spawn', provider: model.provider, model: model.model },
  ];
  const task: AgentTask = {
    taskId: request.taskId ?? `task-${request.role}-1`,
    parentSessionId: request.parentSessionId,
    role: request.role,
    objective: request.objective ?? `${request.role} objective`,
    worktree: request.worktree,
    workspaceMode: 'worktree',
    toolNames: [...doc.tools],
    budget: {},
    model,
  };
  return spawnAgent(
    {
      task,
      sessionId: request.sessionId,
      scopedModels,
      isGitWorktree: request.isGitWorktree ?? (() => true),
    },
    createGenerationState(),
  );
}
