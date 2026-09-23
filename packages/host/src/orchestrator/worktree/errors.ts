// Shared worktree error (issue #45; §44, §78).
// Non-git refusal carries exit 5 and points at solo; solo itself is
// unaffected (the worktree path is never consulted in solo mode).

export const WORKTREE_EXIT_NOT_A_REPO = 5;

export const WORKTREE_EXIT_USAGE = 1;

export type WorktreeErrorCode =
  | 'not_a_repo'
  | 'not_writable'
  | 'object_store_unavailable'
  | 'invalid_agent'
  | 'add_failed'
  | 'already_exists'
  | 'list_failed'
  | 'status_failed'
  | 'remove_failed'
  | 'outside_worktree';

export class WorktreeError extends Error {
  code: WorktreeErrorCode;
  exitCode: number;
  approval: string | undefined;

  constructor(
    code: WorktreeErrorCode,
    message: string,
    exitCode: number,
    approval?: string,
  ) {
    super(message);
    this.name = 'WorktreeError';
    this.code = code;
    this.exitCode = exitCode;
    this.approval = approval;
  }
}

export function notARepoError(repoRoot: string): WorktreeError {
  return new WorktreeError(
    'not_a_repo',
    `orchestrator worktree needs a git repository at ${repoRoot} — run in solo mode here (\`kubic run -p\`) or retry inside a git worktree`,
    WORKTREE_EXIT_NOT_A_REPO,
  );
}

export function isWorktreeError(value: unknown): value is WorktreeError {
  return value instanceof WorktreeError;
}
