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
  | 'invalid_root'
  | 'add_failed'
  | 'already_exists'
  | 'worktree_missing'
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

// Resume tolerance path (issue #85): the branch survived a killed run but
// the worktree directory is gone (`rm -rf .kubic && git worktree prune`).
// Without this check the caller hands a non-existent cwd to the child
// spawn, which dies as a raw `spawn … ENOENT` uncaught event — no §78
// code, no usable message. Fail closed with a named code instead.
export function worktreeMissingError(
  path: string,
  branch: string,
): WorktreeError {
  return new WorktreeError(
    'worktree_missing',
    `worktree ${path} is gone but branch ${branch} exists — recreate it with \`kubic orchestrate\` in a clean checkout or remove the branch first (nothing was spawned)`,
    1,
  );
}

export function isWorktreeError(value: unknown): value is WorktreeError {
  return value instanceof WorktreeError;
}
