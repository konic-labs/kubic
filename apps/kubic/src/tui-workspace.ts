// The TUI header's workspace facts (EPIC N, issue #453): the project name,
// the current branch and the changed-file count. Git runs through the exec
// shell seam with explicit argv and the worker's porcelain v2 parser — the
// one the orchestrator's worktree status uses. `--no-optional-locks` keeps
// the read from taking the index lock a running tool's own git may need.
// Never throws: outside a repository (or without git) the header shows the
// directory name alone.

import { basename } from 'node:path';
import type { Shell } from '../../../packages/exec/src/env.js';
import type { TuiWorkspace } from '../../../packages/tui/src/tui-app.js';
import { parsePorcelainStatus } from '../../../packages/worker/src/ops/git.js';

const PROVENANCE = {
  sessionId: '',
  agentId: 'root',
  toolCallId: 'tui:workspace',
  turnId: 0,
  operation: 'tui',
} as const;

/** The header facts from `git status --porcelain=v2 -z -b` output. */
export function workspaceFromStatus(root: string, out: string): TuiWorkspace {
  const status = parsePorcelainStatus(out);
  const changed = new Set([
    ...status.staged,
    ...status.unstaged,
    ...status.untracked,
    ...status.conflicts,
  ]);
  const branch =
    status.branch === null
      ? 'detached'
      : status.branch === '(unknown)'
        ? undefined
        : status.branch;
  return {
    project: basename(root),
    ...(branch === undefined ? {} : { branch }),
    dirty: changed.size,
  };
}

export async function readTuiWorkspace(
  shell: Shell,
  cwd: string,
): Promise<TuiWorkspace> {
  const fallback: TuiWorkspace = { project: basename(cwd) };
  try {
    const top = await shell
      .spawn('git', ['rev-parse', '--show-toplevel'], {
        provenance: PROVENANCE,
      })
      .wait();
    if (top.exitCode !== 0) return fallback;
    const root = top.stdout.trim();
    const status = await shell
      .spawn(
        'git',
        ['--no-optional-locks', 'status', '--porcelain=v2', '-z', '-b'],
        { provenance: PROVENANCE },
      )
      .wait();
    if (status.exitCode !== 0) return { project: basename(root) };
    return workspaceFromStatus(root, status.stdout);
  } catch {
    return fallback;
  }
}

/** Untracked files a worker diff shows in full, at most. */
export const WORKER_DIFF_NEW_FILES = 20;

/**
 * Issue #465: a worker's change in its worktree for the dashboard's `^O` —
 * everything since its branch left `base` (committed or not), plus the files
 * it created and has not committed yet (each shown whole, at most
 * WORKER_DIFF_NEW_FILES of them). Reads only: the worker's index is never
 * touched. Undefined when the worktree cannot be read.
 */
export async function readWorkerDiff(
  shell: Shell,
  base: string | undefined,
): Promise<string | undefined> {
  const git = (args: readonly string[]) =>
    shell
      .spawn('git', ['--no-optional-locks', ...args], {
        provenance: PROVENANCE,
      })
      .wait();
  try {
    const fork =
      base === undefined || base === 'detached'
        ? undefined
        : await git(['merge-base', 'HEAD', base]);
    const from =
      fork !== undefined && fork.exitCode === 0 && fork.stdout.trim() !== ''
        ? fork.stdout.trim()
        : 'HEAD';
    const tracked = await git(['diff', from, '--']);
    if (tracked.exitCode !== 0) return undefined;
    const untracked = await git(['ls-files', '--others', '--exclude-standard']);
    const created =
      untracked.exitCode === 0
        ? untracked.stdout
            .split('\n')
            .filter((path) => path !== '')
            .slice(0, WORKER_DIFF_NEW_FILES)
        : [];
    const parts = [tracked.stdout];
    for (const path of created) {
      // `--no-index` exits 1 when the files differ — which they always do.
      const whole = await git(['diff', '--no-index', '--', '/dev/null', path]);
      if (whole.exitCode === 0 || whole.exitCode === 1)
        parts.push(whole.stdout);
    }
    return parts.filter((part) => part !== '').join('\n');
  } catch {
    return undefined;
  }
}
