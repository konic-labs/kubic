// The committed/ignored split a workspace needs: the runtime state paths
// must be ignored, by .gitignore or by git itself, and `.kubic/` must not.

import type { FileBridge } from '@kubic/exec/file-bridge';
import { RUNTIME_EXCLUDE_ENTRIES } from '@kubic/exec/runtime-exclude';
import { safeExists, safeReadTextFile } from './bridge-reads.js';

// The rule set is owned by the module that writes it:
// @kubic/exec `runtime-exclude.ts` is what `kubic run` ships into a user
// repo, so this list is a projection of
// that module — never a second hand-maintained copy. `config.test.ts`
// pins the two together, so a rule added there cannot go unchecked here.
/** @internal */
export const GITIGNORE_REQUIRED_ENTRIES = [...RUNTIME_EXCLUDE_ENTRIES] as const;

/** @internal */
export function checkGitignoreSplit(gitignoreText: string): {
  missing: string[];
} {
  return {
    missing: GITIGNORE_REQUIRED_ENTRIES.filter(
      (entry) => !gitignoreText.includes(entry),
    ),
  };
}

export function checkWorkspaceIgnoreSplit(
  bridge: Pick<FileBridge, 'exists' | 'readTextFile'>,
  cwd: string,
  git?: IgnoreSplitGit,
): { missing: string[]; checked: string[]; applicable: boolean } {
  // When a git runner is injected the toplevel and the exclude
  // resolve the way the writer resolves them — `${cwd}/.git` is a FILE in
  // a linked worktree (so `${cwd}/.git/info/exclude` fails ENOTDIR) and is
  // absent from a subdirectory. Without a runner this module stays
  // process-free and keeps the legacy bridge probe.
  if (git !== undefined) {
    return checkWorkspaceIgnoreSplitViaGit(bridge, cwd, git);
  }
  // Outside a git repository there is nothing to ignore: `kubic run` ships
  // its exclude rules into `.git/info/exclude`, which does not exist, and
  // runtime state stays local wherever it is written. Reporting a missing
  // split there would be a false alarm, so `applicable` is false and no
  // rules are claimed to be absent.
  const applicable = safeExists(bridge, `${cwd}/.git`);
  const candidates = [`${cwd}/.gitignore`, `${cwd}/.git/info/exclude`];
  const checked: string[] = [];
  let text = '';
  for (const path of candidates) {
    if (!safeExists(bridge, path)) continue;
    const content = safeReadTextFile(bridge, path);
    if (content === undefined) continue;
    checked.push(path);
    text += `${content}\n`;
  }
  return {
    missing: applicable ? checkGitignoreSplit(text).missing : [],
    checked,
    applicable,
  };
}

// The git seam for the ignore-split check. Injected so this
// module never spawns a process; the prod caller passes a spawnSync runner
// mirroring the writer's.
export type IgnoreSplitGit = (
  cwd: string,
  args: readonly string[],
) => { code: number; out: string };

// The writer's own resolution (`git rev-parse --show-toplevel` +
// `--git-path info/exclude`): in a linked worktree the exclude is the
// common dir's file, unreachable through the worktree's `.git` file. Only
// a failed toplevel (not a repository) reports inapplicable.
function checkWorkspaceIgnoreSplitViaGit(
  bridge: Pick<FileBridge, 'exists' | 'readTextFile'>,
  cwd: string,
  git: IgnoreSplitGit,
): { missing: string[]; checked: string[]; applicable: boolean } {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0 || top.out === '') {
    return { missing: [], checked: [], applicable: false };
  }
  const probe = git(cwd, ['rev-parse', '--git-path', 'info/exclude']);
  const exclude =
    probe.code === 0 && probe.out !== ''
      ? joinGitPath(cwd, probe.out)
      : undefined;
  const candidates = [
    `${top.out}/.gitignore`,
    ...(exclude === undefined ? [] : [exclude]),
  ];
  const checked: string[] = [];
  let text = '';
  for (const path of candidates) {
    if (!safeExists(bridge, path)) continue;
    const content = safeReadTextFile(bridge, path);
    if (content === undefined) continue;
    checked.push(path);
    text += `${content}\n`;
  }
  return {
    missing: checkGitignoreSplit(text).missing,
    checked,
    applicable: true,
  };
}

// `rev-parse --show-toplevel` prints absolute; `--git-path` prints
// relative to the invocation cwd. No node:path import (this module stays
// import-light like the `${cwd}/.git` probes above).
function joinGitPath(cwd: string, out: string): string {
  return out.startsWith('/') ? out : `${cwd}/${out}`;
}
