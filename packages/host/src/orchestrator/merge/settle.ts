// Manager-side settlement guard (issue #46; §9.2).
// The manager merges through workspace_diff / workspace_merge /
// workspace_apply only. Any direct authoring call (write, edit, bash,
// and the rest of the exec lane) is a policy block — the writer
// resolver owns those tools, never the manager. Pure — no I/O.

export const MANAGER_WRITE_TOOLS: readonly string[] = [
  'bash',
  'read',
  'write',
  'edit',
  'grep',
  'find',
  'ls',
] as const;

export class ManagerAuthoringError extends Error {
  constructor(toolName: string) {
    super(
      `manager policy block: '${toolName}' authors — the resolver writes, never the manager`,
    );
    this.name = 'ManagerAuthoringError';
  }
}

export function assertManagerZeroWrites(managerCalls: readonly string[]): void {
  for (const call of managerCalls) {
    if (MANAGER_WRITE_TOOLS.includes(call)) {
      throw new ManagerAuthoringError(call);
    }
  }
}
