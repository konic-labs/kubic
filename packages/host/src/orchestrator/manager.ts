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

export function resolveOrchestratorMode(sources: ModeSources): OrchestratorMode {
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
    super(`manager policy block: tool '${toolName}' is not registered on the manager lane`);
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
