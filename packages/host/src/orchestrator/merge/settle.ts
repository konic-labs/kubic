// Manager-side settlement guard (issue #46; §9.2).
// The manager merges through workspace_diff / workspace_merge /
// workspace_apply only (+ spawn_agent to launch the writer-resolver).
// Read-only inspection (read/ls/find/grep, git status/diff/log/show)
// authors nothing, so it passes. Everything else — write, edit, bash,
// the git_* authoring tools, or any unknown tool — is a policy block:
// the guard is an ALLOWLIST (fail-closed), never a blocklist. The
// writer resolver owns authoring tools, never the manager. Pure — no I/O.

export const MANAGER_MERGE_ALLOWLIST: readonly string[] = [
  'spawn_agent',
  'workspace_diff',
  'workspace_merge',
  'workspace_apply',
  'read',
  'ls',
  'find',
  'grep',
  'git_status',
  'git_diff',
  'git_log',
  'git_show',
] as const;

// The explicit authoring set the manager must never touch. Kept as
// documentation and a test anchor — the enforceable gate is
// MANAGER_MERGE_ALLOWLIST above (fail-closed: anything not listed
// throws, whether or not it appears here).
export const MANAGER_WRITE_TOOLS: readonly string[] = [
  'write',
  'edit',
  'bash',
  'git_stage',
  'git_commit',
  'git_checkpoint',
  'git_branch',
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
    if (!MANAGER_MERGE_ALLOWLIST.includes(call)) {
      throw new ManagerAuthoringError(call);
    }
  }
}
