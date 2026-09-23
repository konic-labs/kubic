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

export interface RoleModelDefault {
  provider: string;
  model: string;
  thinking: string;
}

export const ROLE_MODEL_DEFAULTS: Record<BuiltinRoleName, RoleModelDefault> = {
  planner: { provider: 'local', model: 'llama3', thinking: 'medium' },
  implementer: { provider: 'local', model: 'llama3', thinking: 'medium' },
  tester: { provider: 'local', model: 'llama3', thinking: 'low' },
  debugger: { provider: 'local', model: 'llama3', thinking: 'high' },
  reviewer: { provider: 'local', model: 'llama3', thinking: 'low' },
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
): { model: ModelSelection } | { error: string } {
  const slash = ref.indexOf('/');
  if (slash <= 0 || slash === ref.length - 1) {
    return {
      error:
        `[roles.${role}].model must be 'provider/id' ` +
        `(got ${JSON.stringify(ref)}): refusing spawn`,
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
  isGitWorktree?: (path: string) => boolean;
}

// Role-aware spawn: unknown roles fail with SPAWN_FAILED (§38.2 scoped
// set, fixed-in-v1 role list — the manager composes from the five, never
// invents). Model precedence: spawn_agent({model}) beats
// [roles.<r>].model beats the role default; the winner always lands in
// the scoped set so the spawn contract below can verify it.
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
  const fallback = ROLE_MODEL_DEFAULTS[request.role];
  let model: ModelSelection = {
    provider: fallback.provider,
    model: fallback.model,
    thinking: fallback.thinking,
  };
  if (request.configModel !== undefined) {
    const parsed = parseConfigModel(request.role, request.configModel);
    if ('error' in parsed) return spawnFailed(parsed.error);
    model = { ...parsed.model, thinking: fallback.thinking };
  }
  if (request.taskModel !== undefined) {
    model = { ...request.taskModel };
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
