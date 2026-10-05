// Manager lane slice 1 (issue #40; §5.2, §9.2, §81).
// Pure host-side contracts: the 10-tool allowlist, exec fail-closed policy,
// mode resolution, and the non-git --orchestrator refusal (exit 5 → solo).
// No CLI wiring here (flag parsing lands separately); no worker imports.

export const MANAGER_ALLOWLIST = [
  'spawn_agent',
  'send_to_agent',
  'wait_for_agent',
  'cancel_agent',
  'inspect_agent',
  'collect_result',
  'workspace_diff',
  'workspace_apply',
  'workspace_merge',
  'ask_user',
  // §43.1 (issue #205): read-only git inspection for the manager — how it
  // reads the repo without being able to author. The WRITER git tools
  // (git_commit/git_stage/git_branch/git_checkpoint) stay out: a lane
  // carrying one refuses to start through the exact-equality gate below,
  // and `checkManagerCall` refuses the name outright.
  'git_status',
  'git_diff',
  'git_log',
] as const;

export type ManagerToolName = (typeof MANAGER_ALLOWLIST)[number];

export const EXEC_FORBIDDEN_TOOLS = [
  'bash',
  'read',
  'write',
  'edit',
  'grep',
  'find',
  'ls',
] as const;

export type ExecForbiddenTool = (typeof EXEC_FORBIDDEN_TOOLS)[number];

export const MANAGER_EXIT_WORKSPACE_UNAVAILABLE = 5;

export type OrchestratorMode = 'solo' | 'orchestrator';

export interface ModeSources {
  cliFlag?: boolean;
  configValue?: boolean;
  toggle?: boolean;
}

export function resolveOrchestratorMode(
  sources: ModeSources,
): OrchestratorMode {
  if (sources.cliFlag === true) return 'orchestrator';
  if (sources.toggle === true) return 'orchestrator';
  if (sources.configValue === true) return 'orchestrator';
  return 'solo';
}

export class ManagerToolsetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManagerToolsetError';
  }
}

export class ManagerPolicyBlockedError extends Error {
  constructor(toolName: string) {
    super(
      `manager policy block: tool '${toolName}' is not registered on the manager lane`,
    );
    this.name = 'ManagerPolicyBlockedError';
  }
}

export function assertManagerToolset(activeTools: readonly string[]): void {
  const active = [...activeTools].sort();
  const expected = [...MANAGER_ALLOWLIST].sort();
  const same =
    active.length === expected.length &&
    active.every((name, index) => name === expected[index]);
  if (!same) {
    const extra = active.filter(
      (name) => !(expected as readonly string[]).includes(name),
    );
    const missing = (expected as readonly string[]).filter(
      (name) => !active.includes(name),
    );
    const detail = [
      extra.length > 0 ? `extra: ${extra.join(', ')}` : '',
      missing.length > 0 ? `missing: ${missing.join(', ')}` : '',
    ]
      .filter((part) => part.length > 0)
      .join('; ');
    throw new ManagerToolsetError(
      `manager toolset must equal the allowlist exactly (${detail || 'mismatch'})`,
    );
  }
  for (const forbidden of EXEC_FORBIDDEN_TOOLS) {
    if (active.includes(forbidden)) {
      throw new ManagerToolsetError(
        `manager toolset must equal the allowlist exactly (extra: ${forbidden})`,
      );
    }
  }
}

export function checkManagerCall(toolName: string): void {
  if ((EXEC_FORBIDDEN_TOOLS as readonly string[]).includes(toolName)) {
    throw new ManagerPolicyBlockedError(toolName);
  }
  if (!(MANAGER_ALLOWLIST as readonly string[]).includes(toolName)) {
    throw new ManagerPolicyBlockedError(toolName);
  }
}

export interface OrchestratorRefusal {
  exitCode: number;
  message: string;
}

export function buildOrchestratorRefusal(): OrchestratorRefusal {
  return {
    exitCode: MANAGER_EXIT_WORKSPACE_UNAVAILABLE,
    message:
      'orchestrator mode needs a git repository — run in solo mode here (`kubic run -p`) or retry inside a git worktree',
  };
}

// Slice 2: workspace_diff/apply/merge contracts (§5.2). The manager merges
// worker-produced diffs but never authors: any request carrying inline file
// contents is a policy block, never a validation warning.

export interface WorkspaceValidation {
  valid: boolean;
  errors: string[];
}

function isAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/');
}

function rejectAuthoring(input: Record<string, unknown>): void {
  if (input.contents !== undefined || input.content !== undefined) {
    throw new ManagerPolicyBlockedError('write (inline authoring)');
  }
}

export interface WorkspaceDiffInput {
  worktree: string;
  base?: string;
}

export function validateWorkspaceDiff(
  input: WorkspaceDiffInput,
): WorkspaceValidation {
  rejectAuthoring(input as unknown as Record<string, unknown>);
  const errors: string[] = [];
  if (!isAbsolutePath(input.worktree)) {
    errors.push('worktree must be an absolute path');
  }
  if (input.base !== undefined && input.base.trim().length === 0) {
    errors.push('base must be a non-empty ref when provided');
  }
  return { valid: errors.length === 0, errors };
}

export interface WorkspaceApplyInput {
  worktree: string;
  patch: string;
  contents?: string;
}

export function validateWorkspaceApply(
  input: WorkspaceApplyInput,
): WorkspaceValidation {
  rejectAuthoring(input as unknown as Record<string, unknown>);
  const errors: string[] = [];
  if (!isAbsolutePath(input.worktree)) {
    errors.push('worktree must be an absolute path');
  }
  if (typeof input.patch !== 'string' || input.patch.length === 0) {
    errors.push('patch must be a non-empty diff');
  }
  return { valid: errors.length === 0, errors };
}

export interface WorkspaceMergeInput {
  worktree: string;
  source: string;
  contents?: string;
}

export function validateWorkspaceMerge(
  input: WorkspaceMergeInput,
): WorkspaceValidation {
  rejectAuthoring(input as unknown as Record<string, unknown>);
  const errors: string[] = [];
  if (!isAbsolutePath(input.worktree)) {
    errors.push('worktree must be an absolute path');
  }
  if (typeof input.source !== 'string' || input.source.trim().length === 0) {
    errors.push('source must be a non-empty agent or ref id');
  }
  return { valid: errors.length === 0, errors };
}

// Slice 2: session-scoped toggle + indicator + session/audit surface.
// The toggle never leaves the session: fresh sessions start solo, the state
// round-trips through JSON persistence, and the indicator vocabulary mirrors
// the TUI StatusMode without importing it.

export interface OrchestratorToggleState {
  on: boolean;
  scope: 'session';
  persisted: boolean;
}

export function setOrchestratorToggle(
  previous: OrchestratorToggleState,
  on: boolean,
): OrchestratorToggleState {
  return { on, scope: previous.scope, persisted: true };
}

export function serializeOrchestratorToggle(
  state: OrchestratorToggleState,
): string {
  return JSON.stringify(state);
}

export function parseOrchestratorToggle(raw: string): OrchestratorToggleState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // Invalid JSON (a bare string, truncated model output) is the equally
    // likely sibling of a wrong shape: the same named toolset error, with
    // the parse message folded in — never a raw SyntaxError escaping as an
    // unclassified harness fault (issue #132).
    throw new ManagerToolsetError(
      `invalid orchestrator toggle payload: not JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { on?: unknown }).on !== 'boolean'
  ) {
    throw new ManagerToolsetError('invalid orchestrator toggle payload');
  }
  return {
    on: (parsed as { on: boolean }).on,
    scope: 'session',
    persisted: true,
  };
}

export function formatModeIndicator(mode: OrchestratorMode): string {
  return mode;
}

export type ModeSource = 'cli' | 'config' | 'toggle';

export interface SessionModeRecord {
  sessionId: string;
  mode: OrchestratorMode;
  source: ModeSource;
  scope: 'session';
  persisted: boolean;
}

export function buildSessionModeRecord(
  sessionId: string,
  mode: OrchestratorMode,
  source: ModeSource,
): SessionModeRecord {
  return { sessionId, mode, source, scope: 'session', persisted: true };
}

export interface ModeStatusJson {
  sessionId: string;
  mode: OrchestratorMode;
}

export function buildModeStatusJson(
  sessionId: string,
  mode: OrchestratorMode,
): ModeStatusJson {
  return { sessionId, mode };
}

export interface ModeAuditEvent {
  type: 'mode';
  sessionId: string;
  mode: OrchestratorMode;
  source: ModeSource;
}

export function buildModeAuditEvent(input: {
  sessionId: string;
  mode: OrchestratorMode;
  source: ModeSource;
}): ModeAuditEvent {
  return {
    type: 'mode',
    sessionId: input.sessionId,
    mode: input.mode,
    source: input.source,
  };
}

// Slice 2: faux stub delegation. The spy classifies every call so tests
// prove zero exec traffic; the stub routes each planned tool through the
// same fail-closed check the lane enforces.

export interface ManagerCallSpy {
  calls: string[];
  execCalls: string[];
  record: (toolName: string) => void;
}

export function createManagerCallSpy(): ManagerCallSpy {
  const spy: ManagerCallSpy = {
    calls: [],
    execCalls: [],
    record: (toolName: string): void => {
      spy.calls.push(toolName);
      if ((EXEC_FORBIDDEN_TOOLS as readonly string[]).includes(toolName)) {
        spy.execCalls.push(toolName);
      }
    },
  };
  return spy;
}

export function runManagerStub(spy: ManagerCallSpy, plan: string[]): string[] {
  const done: string[] = [];
  for (const toolName of plan) {
    checkManagerCall(toolName);
    spy.record(toolName);
    done.push(toolName);
  }
  return done;
}

// Slice 3 (issue #103): the live manager lane. Registration is the gate the
// §40 allowlist is enforced at: a lane that asks for anything but the exact
// ten-tool set refuses to START (assertManagerToolset throws the named
// ManagerToolsetError) rather than running with an exec tool registered.
// Exec tools are absent by construction — the caller cannot get a lane back
// that carries one.
export interface ManagerLane {
  mode: OrchestratorMode;
  /** The tools the lane actually runs with (the §40 set, in allowlist order). */
  tools: readonly string[];
  /** The allowlist the registration was validated against. */
  allowlist: readonly string[];
}

export function registerManagerLane(tools?: readonly string[]): ManagerLane {
  const laneTools = tools === undefined ? [...MANAGER_ALLOWLIST] : [...tools];
  assertManagerToolset(laneTools);
  return {
    mode: 'orchestrator',
    tools: laneTools,
    allowlist: [...MANAGER_ALLOWLIST],
  };
}

// The lane's own call trace (issue #103, §9.2/§40): every lane action is
// classified by the same fail-closed policy the lane enforces, so an exec
// name is refused BEFORE it can reach the spy — the trace can never show a
// call the allowlist forbids.
export function recordManagerLaneCall(
  spy: ManagerCallSpy,
  toolName: string,
): void {
  checkManagerCall(toolName);
  spy.record(toolName);
}

// Slice 3 (issue #103): plan → N distinct worker prompts (§9.2, §5.2).
// The manager authors one step per worker, in agent order, and each step
// carries its own prompt. The shape is deterministic (worker id → step →
// prompt) so a replay — a faux provider, a --resume, a test — derives the
// same prompts from the same objective and agent list, never a copy of -p.
export interface ManagerPlanStep {
  agentId: string;
  /** 1-based position of this step in the plan. */
  step: number;
  /** Total steps in the plan. */
  total: number;
  prompt: string;
}

function planPrompt(
  step: number,
  total: number,
  agentId: string,
  objective: string,
): string {
  return `Plan step ${step} of ${total} for agent '${agentId}': ${objective}`;
}

export function buildManagerPlan(
  objective: string,
  agents: readonly string[],
): ManagerPlanStep[] {
  const total = agents.length;
  return agents.map((agentId, index) => {
    const step = index + 1;
    return {
      agentId,
      step,
      total,
      prompt: planPrompt(step, total, agentId, objective),
    };
  });
}

export function planStepFor(
  plan: readonly ManagerPlanStep[],
  agentId: string,
): ManagerPlanStep | undefined {
  return plan.find((entry) => entry.agentId === agentId);
}

// Slice 2: one-paragraph trade statement (§9.3).
export const MANAGER_TRADE_DOC =
  'Orchestrator mode trades solo directness for auditable delegation: the root becomes a pure manager with only the ten §9.2 tools (spawn, message, wait, cancel, inspect, collect, workspace diff/apply/merge, ask_user), so every change arrives as a worker-produced diff the manager can review and merge but never silently author, while solo keeps the full exec lane for fast single-agent work at the cost of that separation; choose orchestrator when parallel reviewable work matters and solo when speed and direct control matter.';
