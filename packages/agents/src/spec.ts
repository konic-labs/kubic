// SubagentSpec + spawn contract (issue #41; design §6.2, §11, §22.3–§24,
// §38.2, §67, §68, §71).
// Single spawn contract: fork/isolate the session, assign a generation, bind
// the worktree + grant, return a handle. Pure data plus injected checks: the
// agents package never touches the filesystem or the network (faux-only), so
// the git-worktree probe arrives as a callback that tests back with a fake.
//
// Self-contained on purpose: agents must not import host, worker, or
// trajectory (dep-lint), so WorkerProvenance and the spawn-side result live
// here. The worker-owned AgentResult (§68, issue #7) remains the wire
// payload; the spawn-side result below is field-compatible with it by
// construction (status, summary, provenance).

import type { AgentBudget } from './budget.js';
import type {
  AgentRole,
  AgentTask,
  ModelSelection,
  ScopedModel,
  TaskResources,
} from './task.js';
import { isBudgetConfigured } from './transfer.js';

export interface SubagentSpec {
  sessionId: string;
  parentSessionId: string;
  role: AgentRole;
  model: ModelSelection;
  systemPrompt?: string;
  resources?: TaskResources;
  toolNames: string[];
  budget?: AgentBudget;
  worktreePath: string;
  generation: number;
}

// Closed-world field coverage: adding or removing a SubagentSpec field breaks
// compilation here, so the contract cannot drift from §6.2 silently.
export const SUBAGENT_SPEC_FIELDS = {
  sessionId: true,
  parentSessionId: true,
  role: true,
  model: true,
  systemPrompt: true,
  resources: true,
  toolNames: true,
  budget: true,
  worktreePath: true,
  generation: true,
} satisfies Record<keyof SubagentSpec, true>;

export type SpecValidation =
  | { valid: true; spec: SubagentSpec }
  | { valid: false; errors: string[] };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateSubagentSpec(input: unknown): SpecValidation {
  const errors: string[] = [];
  if (!isObject(input))
    return { valid: false, errors: ['spec must be an object'] };

  for (const field of ['sessionId', 'parentSessionId', 'role'] as const) {
    if (!isNonEmptyString(input[field]))
      errors.push(`${field} must be a non-empty string`);
  }
  if (
    isNonEmptyString(input.sessionId) &&
    input.sessionId === input.parentSessionId
  ) {
    errors.push('sessionId must differ from parentSessionId (parent linkage)');
  }

  const model = input.model;
  if (!isObject(model)) {
    errors.push('model must be present (§38.2)');
  } else {
    if (!isNonEmptyString(model.provider))
      errors.push('model.provider must be a non-empty string');
    if (!isNonEmptyString(model.model))
      errors.push('model.model must be a non-empty string');
  }

  if (
    !Array.isArray(input.toolNames) ||
    input.toolNames.length === 0 ||
    input.toolNames.some((t) => !isNonEmptyString(t))
  ) {
    errors.push('toolNames must be a non-empty array of non-empty strings');
  }

  // Worktree is mandatory (§6.2): the spawn path fails without one, never a
  // shared fallback onto the parent worktree.
  if (!isNonEmptyString(input.worktreePath)) {
    errors.push('worktreePath must be a non-empty string');
  } else if (!input.worktreePath.startsWith('/')) {
    errors.push('worktreePath must be an absolute path');
  }

  if (
    typeof input.generation !== 'number' ||
    !Number.isInteger(input.generation) ||
    input.generation < 1
  ) {
    errors.push('generation must be a positive integer (§11)');
  }

  if (
    input.systemPrompt !== undefined &&
    !isNonEmptyString(input.systemPrompt)
  ) {
    errors.push('systemPrompt must be a non-empty string when configured');
  }
  if (input.resources !== undefined && !isObject(input.resources)) {
    errors.push('resources must be an object when configured');
  }
  // §71: budgets are opt-in — absent means no limits, never a default.
  if (input.budget !== undefined && !isObject(input.budget)) {
    errors.push('budget must be an object when configured');
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, spec: input as unknown as SubagentSpec };
}

// (sessionId, generation) keying (§6.2, §11): every send from a child
// carries this key so the parent can reject anything stale.
export interface SessionKey {
  sessionId: string;
  generation: number;
}

export function specKeyOf(
  spec: Pick<SubagentSpec, 'sessionId' | 'generation'>,
): SessionKey {
  return { sessionId: spec.sessionId, generation: spec.generation };
}

// Generation ledger (§11): the first spawn for a session starts at 1, every
// respawn moves monotonically. The ledger lives with the parent. The map is
// null-prototype: sessionIds are caller-supplied, so '__proto__' must behave
// like any other key instead of corrupting allocation.
export interface GenerationState {
  lastBySession: Record<string, number>;
}

export function createGenerationState(): GenerationState {
  return { lastBySession: Object.create(null) };
}

export function allocateGeneration(
  state: GenerationState,
  sessionId: string,
): number {
  const next = (state.lastBySession[sessionId] ?? 0) + 1;
  state.lastBySession[sessionId] = next;
  return next;
}

export type GenerationCheck =
  | { ok: true }
  | { ok: false; code: 'STALE_GENERATION'; reason: string };

export function validateGenerationSend(
  state: GenerationState,
  key: SessionKey,
): GenerationCheck {
  const latest = state.lastBySession[key.sessionId];
  if (latest === undefined) {
    return {
      ok: false,
      code: 'STALE_GENERATION',
      reason: `unknown session '${key.sessionId}': no generation allocated`,
    };
  }
  if (key.generation < latest) {
    return {
      ok: false,
      code: 'STALE_GENERATION',
      reason: `stale generation ${key.generation} for session '${key.sessionId}': latest is ${latest}`,
    };
  }
  if (key.generation > latest) {
    return {
      ok: false,
      code: 'STALE_GENERATION',
      reason: `unknown generation ${key.generation} for session '${key.sessionId}': latest is ${latest}`,
    };
  }
  return { ok: true };
}

export interface SpawnRequest {
  task: AgentTask;
  sessionId: string;
  systemPrompt?: string;
  scopedModels: ScopedModel[];
  isGitWorktree: (path: string) => boolean;
}

export interface SpawnHandle {
  sessionId: string;
  generation: number;
  worktreePath: string;
}

export type SpawnOutcome =
  | { ok: true; spec: SubagentSpec; handle: SpawnHandle }
  | { ok: false; code: 'SPAWN_FAILED'; reason: string };

function spawnFailed(reason: string): SpawnOutcome {
  return { ok: false, code: 'SPAWN_FAILED', reason };
}

// Single spawn contract: fork/isolate the session from the §67 task, assign
// a generation, bind the worktree + grant, return the spec and its handle.
export function spawnAgent(
  request: SpawnRequest,
  generations: GenerationState,
): SpawnOutcome {
  const task = request.task;
  if (!isNonEmptyString(request.sessionId)) {
    return spawnFailed('sessionId must be a non-empty string');
  }
  if (request.sessionId === task.parentSessionId) {
    return spawnFailed(
      'sessionId must differ from parentSessionId (parent linkage)',
    );
  }
  // Worktree is mandatory (§6.2): missing, relative, or non-git fails the
  // spawn outright — never a shared fallback onto the parent worktree.
  if (typeof task.worktree !== 'string' || task.worktree.trim() === '') {
    return spawnFailed(
      'worktree is required for spawn (§6.2): no shared fallback',
    );
  }
  if (!task.worktree.startsWith('/')) {
    return spawnFailed(
      `worktree must be an absolute path (got ${JSON.stringify(task.worktree)})`,
    );
  }
  if (!request.isGitWorktree(task.worktree)) {
    return spawnFailed(
      `worktree '${task.worktree}' is not a git worktree: refusing spawn (§6.2)`,
    );
  }
  // The model must sit in the scoped set (§38.2): the task model travels,
  // never a silent substitute, and an absent model cannot spawn.
  const model = task.model;
  if (model === undefined) {
    return spawnFailed(
      "model 'absent' is outside the scoped set (§38.2): refusing spawn",
    );
  }
  const inScope = request.scopedModels.some(
    (scoped) =>
      scoped.provider === model.provider && scoped.model === model.model,
  );
  if (!inScope) {
    return spawnFailed(
      `model '${model.provider}/${model.model}' is outside the scoped set (§38.2): refusing spawn`,
    );
  }
  if (
    !Array.isArray(task.toolNames) ||
    task.toolNames.length === 0 ||
    task.toolNames.some((t) => !isNonEmptyString(t))
  ) {
    return spawnFailed('toolNames grant must be non-empty (§24)');
  }
  // Fail closed on a malformed budget (parity with validateTransferSpawn):
  // a non-object budget must reject the spawn, never ride along as no
  // limits.
  if (task.budget !== undefined && !isObject(task.budget)) {
    return spawnFailed('budget must be an object when configured (§71)');
  }

  const generation = allocateGeneration(generations, request.sessionId);
  const spec: SubagentSpec = {
    sessionId: request.sessionId,
    parentSessionId: task.parentSessionId,
    role: task.role,
    model: { ...model },
    toolNames: [...task.toolNames],
    worktreePath: task.worktree,
    generation,
  };
  if (request.systemPrompt !== undefined) {
    spec.systemPrompt = request.systemPrompt;
  }
  if (task.resources !== undefined) {
    spec.resources = copyResources(task.resources);
  }
  // §71: only a configured budget travels. Omitted or empty means no
  // limits — never a smuggled default.
  if (isBudgetConfigured(task.budget)) {
    spec.budget = copyBudget(task.budget);
  }
  return {
    ok: true,
    spec,
    handle: {
      sessionId: spec.sessionId,
      generation,
      worktreePath: spec.worktreePath,
    },
  };
}

// Fork semantics (§22.3): the child inherits a copy of the session config;
// in-flight state (transcript, pending tool calls) is excluded, never copied.
export interface SessionSnapshot {
  sessionId: string;
  model: ModelSelection;
  systemPrompt?: string;
  resources?: TaskResources;
  toolNames: string[];
  budget?: AgentBudget;
  worktreePath: string;
  transcript: unknown[];
  pendingCalls: unknown[];
}

export interface SessionConfig {
  model: ModelSelection;
  systemPrompt?: string;
  resources?: TaskResources;
  toolNames: string[];
  budget?: AgentBudget;
  worktreePath: string;
}

function copyResources(resources: TaskResources): TaskResources {
  const copy: TaskResources = { ...resources };
  if (resources.skills !== undefined) copy.skills = [...resources.skills];
  if (resources.promptTemplates !== undefined) {
    copy.promptTemplates = [...resources.promptTemplates];
  }
  return copy;
}

// Budgets carry a nested retryBudget object: a top-level spread alone lets
// the child mutate the parent's retry caps, so copy the nested object too.
function copyBudget(budget: AgentBudget): AgentBudget {
  const copy: AgentBudget = { ...budget };
  if (budget.retryBudget !== undefined) {
    copy.retryBudget = { ...budget.retryBudget };
  }
  return copy;
}

export function forkSessionConfig(snapshot: SessionSnapshot): SessionConfig {
  const config: SessionConfig = {
    model: { ...snapshot.model },
    toolNames: [...snapshot.toolNames],
    worktreePath: snapshot.worktreePath,
  };
  if (snapshot.systemPrompt !== undefined) {
    config.systemPrompt = snapshot.systemPrompt;
  }
  if (snapshot.resources !== undefined) {
    config.resources = copyResources(snapshot.resources);
  }
  if (snapshot.budget !== undefined) {
    // Fail closed on a malformed budget (parity with spawnAgent): a
    // non-object budget must reject the fork, never spread into garbage.
    if (!isObject(snapshot.budget)) {
      throw new Error('budget must be an object when configured (§71)');
    }
    config.budget = copyBudget(snapshot.budget);
  }
  return config;
}

// Independent child storage (§23): the child starts with its own empty
// transcript. Only the §24 transfer object travels — never the parent
// conversation history.
export interface ChildSession {
  sessionId: string;
  generation: number;
  parentSessionId: string;
  worktreePath: string;
  transcript: unknown[];
}

export function openChildSession(
  spec: Pick<
    SubagentSpec,
    'sessionId' | 'generation' | 'parentSessionId' | 'worktreePath'
  >,
): ChildSession {
  return {
    sessionId: spec.sessionId,
    generation: spec.generation,
    parentSessionId: spec.parentSessionId,
    worktreePath: spec.worktreePath,
    transcript: [],
  };
}

// Spawn-side provenance: who ran, as which generation, forked from whom.
// Required on every result, including failures.
export interface WorkerProvenance {
  sessionId: string;
  generation: number;
  parentSessionId: string;
}

export function provenanceFor(
  spec: Pick<SubagentSpec, 'sessionId' | 'generation' | 'parentSessionId'>,
): WorkerProvenance {
  return {
    sessionId: spec.sessionId,
    generation: spec.generation,
    parentSessionId: spec.parentSessionId,
  };
}

export const SUBAGENT_RESULT_STATUSES = ['completed', 'failed'] as const;

export type SubagentResultStatus = (typeof SUBAGENT_RESULT_STATUSES)[number];

export interface SubagentResult {
  status: SubagentResultStatus;
  summary: string;
  provenance: WorkerProvenance;
  error?: string;
}

export type SubagentResultValidation =
  | { valid: true; result: SubagentResult }
  | { valid: false; errors: string[] };

export function buildSubagentResult(
  spec: Pick<SubagentSpec, 'sessionId' | 'generation' | 'parentSessionId'>,
  status: SubagentResultStatus,
  summary: string,
  error?: string,
): SubagentResult {
  const result: SubagentResult = {
    status,
    summary,
    provenance: provenanceFor(spec),
  };
  if (error !== undefined) result.error = error;
  return result;
}

export function validateSubagentResult(
  input: unknown,
): SubagentResultValidation {
  const errors: string[] = [];
  if (!isObject(input))
    return { valid: false, errors: ['result must be an object'] };

  // Results never carry transcripts (§69): summary + refs travel, history
  // does not.
  if ('transcript' in input) {
    errors.push('result must not carry a transcript (§69)');
  }
  if (
    typeof input.status !== 'string' ||
    !(SUBAGENT_RESULT_STATUSES as readonly string[]).includes(input.status)
  ) {
    errors.push(`status must be one of ${SUBAGENT_RESULT_STATUSES.join(', ')}`);
  }
  if (!isNonEmptyString(input.summary)) {
    errors.push('summary must be a non-empty string');
  }
  const provenance = input.provenance;
  if (!isObject(provenance)) {
    errors.push('provenance is required on every result, including failures');
  } else {
    if (!isNonEmptyString(provenance.sessionId)) {
      errors.push('provenance.sessionId must be a non-empty string');
    }
    if (
      typeof provenance.generation !== 'number' ||
      !Number.isInteger(provenance.generation) ||
      provenance.generation < 1
    ) {
      errors.push('provenance.generation must be a positive integer');
    }
    if (!isNonEmptyString(provenance.parentSessionId)) {
      errors.push('provenance.parentSessionId must be a non-empty string');
    }
  }
  if (input.status === 'failed' && !isNonEmptyString(input.error)) {
    errors.push('error is required when status is failed');
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, result: input as unknown as SubagentResult };
}
