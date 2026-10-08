// The TUI header's workspace facts: the project name,
// the current branch and the changed-file count. Git runs through the exec
// shell seam with explicit argv and the agent's porcelain v2 parser — the
// one `git_status` uses. `--no-optional-locks` keeps
// the read from taking the index lock a running tool's own git may need.
// Never throws: outside a repository (or without git) the header shows the
// directory name alone.

import { basename } from 'node:path';
import { parsePorcelainStatus } from '@kubic/agent/ops/git';
import type { Shell } from '@kubic/exec/env';
import type { TuiWorkspace } from '@kubic/tui/tui-app';

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
