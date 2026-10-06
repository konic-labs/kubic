// Git-guard snapshot (issue #363): hash `.git/config` and every hook file
// so an orchestrated run can name drift at settle.
//
// Lives in exec because only packages/exec touches node:fs (I/O
// confinement, §9, issue #12): host code consumes the snapshot through
// `packages/host/src/orchestrator/worktree/git-guard.ts`, which never
// touches the filesystem itself.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface GitGuardSnapshot {
  /** Resolved gitdir (follows a `.git` pointer file). */
  gitDir: string;
  /** sha256 of `<gitDir>/config`, or undefined when absent/unreadable. */
  configHash: string | undefined;
  /** Hook file name → sha256 (regular files only). */
  hooks: Record<string, string>;
  /** True when `<gitDir>/hooks` is absent (nothing to hash). */
  hooksDirMissing: boolean;
}

function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Resolve the gitdir for a repo root: `<root>/.git`, following a linked
 * worktree's pointer file (`gitdir: <path>`, relative to the root).
 */
export function resolveGitDir(repoRoot: string): string {
  const dotGit = join(repoRoot, '.git');
  try {
    if (statSync(dotGit).isFile()) {
      const match = /^gitdir:\s*(.+?)\s*$/.exec(
        readFileSync(dotGit, 'utf8').trim(),
      );
      if (match?.[1] !== undefined && match[1] !== '') {
        return resolve(repoRoot, match[1]);
      }
    }
  } catch {
    // Unreadable/missing .git: fall through to the conventional path; the
    // snapshot below records absence instead of throwing.
  }
  return dotGit;
}

/** Hash `.git/config` and every hook file; never throws (issue #363). */
export function snapshotGitGuard(repoRoot: string): GitGuardSnapshot {
  const gitDir = resolveGitDir(repoRoot);
  let configHash: string | undefined;
  try {
    configHash = sha256Hex(readFileSync(join(gitDir, 'config')));
  } catch {
    configHash = undefined;
  }
  const hooks: Record<string, string> = {};
  let hooksDirMissing = false;
  try {
    for (const name of readdirSync(join(gitDir, 'hooks'))) {
      try {
        const path = join(gitDir, 'hooks', name);
        if (!statSync(path).isFile()) continue;
        hooks[name] = sha256Hex(readFileSync(path));
      } catch {
        // A hook that vanishes mid-read is reported as removed by the diff.
      }
    }
  } catch {
    hooksDirMissing = true;
  }
  return { gitDir, configHash, hooks, hooksDirMissing };
}
