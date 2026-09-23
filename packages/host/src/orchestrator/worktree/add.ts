// Worktree add (issue #45; §44, §11.1, §61, §78).
// Mandatory one-worktree-per-writer: preflight (repo, writable, shared
// object store), untracked-gap warnings (.env*/node_modules — never a
// silent phantom loop), then `git worktree add <path> -b kubic/<agent>`
// through the exec Shell seam with explicit argv (never shell-interpolated).

import type { ExecutionEnv, Provenance } from '../../../../exec/src/env.js';
import { notARepoError, WorktreeError } from './errors.js';
import { branchForAgent, pathForAgent } from './naming.js';

export const COLD_ADD_BUDGET_MS = 300;

export type GapKind = 'env' | 'node_modules';

export interface UntrackedGapWarning {
  kind: GapKind;
  path: string;
  message: string;
}

export interface AddWorktreeResult {
  agentId: string;
  path: string;
  branch: string;
  warnings: UntrackedGapWarning[];
  elapsedMs: number;
}

export interface AddWorktreeOptions {
  now?: () => number;
  sessionId?: string;
}

export function isColdAddWithinBudget(elapsedMs: number): boolean {
  return elapsedMs < COLD_ADD_BUDGET_MS;
}

function isNotARepo(stderr: string): boolean {
  return /not a git repository/i.test(stderr);
}

function isPermissionFailure(output: string): boolean {
  return /permission denied|EACCES|EROFS|read-only/i.test(output);
}

function provenanceFor(agentId: string, sessionId: string): Provenance {
  return {
    sessionId,
    agentId,
    toolCallId: 'worktree-add',
    turnId: 0,
    operation: 'worktree_add',
  };
}

async function runGit(
  env: ExecutionEnv,
  args: string[],
  provenance: Provenance,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const handle = env.shell.spawn('git', args, { provenance });
  const done = await handle.wait();
  return { exitCode: done.exitCode, stdout: done.stdout, stderr: done.stderr };
}

function exists(env: ExecutionEnv, path: string): boolean {
  try {
    env.fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

// Untracked files never follow `git worktree add`: flag the gaps with an
// actionable remediation so the agent loop never runs silently misconfigured.
export function detectUntrackedGaps(
  env: ExecutionEnv,
  repoRoot: string,
  worktreePath: string,
): UntrackedGapWarning[] {
  const warnings: UntrackedGapWarning[] = [];
  for (const name of ['.env.local', '.env']) {
    const repoFile = `${repoRoot}/${name}`;
    if (exists(env, repoFile) && !exists(env, `${worktreePath}/${name}`)) {
      warnings.push({
        kind: 'env',
        path: repoFile,
        message:
          `untracked gap: ${repoFile} exists in the parent checkout but is not carried ` +
          `into the new worktree ${worktreePath} — copy it over or the agent loop will ` +
          `run without local config (never silently: fill or explicitly skip it first)`,
      });
    }
  }
  const repoModules = `${repoRoot}/node_modules`;
  if (
    exists(env, repoModules) &&
    !exists(env, `${worktreePath}/node_modules`)
  ) {
    warnings.push({
      kind: 'node_modules',
      path: repoModules,
      message:
        `untracked gap: ${repoModules} exists in the parent checkout but is not carried ` +
        `into the new worktree ${worktreePath} — run npm ci inside the worktree before ` +
        `starting the agent loop (never silently: install or explicitly skip it first)`,
    });
  }
  return warnings;
}

export async function addWorktree(
  env: ExecutionEnv,
  repoRoot: string,
  agentId: string,
  options?: AddWorktreeOptions,
): Promise<AddWorktreeResult> {
  const now = options?.now ?? Date.now;
  const started = now();
  const branch = branchForAgent(agentId);
  const path = pathForAgent(repoRoot, agentId);
  const provenance = provenanceFor(agentId, options?.sessionId ?? 'cli');

  const top = await runGit(env, ['rev-parse', '--show-toplevel'], provenance);
  if (top.exitCode !== 0 || isNotARepo(top.stderr)) {
    throw notARepoError(repoRoot);
  }

  const common = await runGit(
    env,
    ['rev-parse', '--git-common-dir'],
    provenance,
  );
  if (common.exitCode !== 0 || common.stdout.trim().length === 0) {
    throw new WorktreeError(
      'object_store_unavailable',
      `orchestrator worktree needs the shared git object store at ${repoRoot} — run in solo mode here (\`kubic run -p\`) or retry inside a git worktree`,
      5,
    );
  }

  try {
    env.fs.stat(repoRoot);
  } catch {
    throw new WorktreeError(
      'not_writable',
      `worktree parent ${repoRoot} is not accessible or writable — retry inside a writable git checkout`,
      5,
    );
  }

  const warnings = detectUntrackedGaps(env, repoRoot, path);

  const added = await runGit(
    env,
    ['worktree', 'add', path, '-b', branch],
    provenance,
  );
  if (added.exitCode !== 0) {
    const output = `${added.stdout}\n${added.stderr}`;
    if (isNotARepo(added.stderr)) throw notARepoError(repoRoot);
    if (/already exists/i.test(output)) {
      throw new WorktreeError(
        'already_exists',
        `worktree ${path} or branch ${branch} already exists — remove it with \`kubic clean\` first`,
        1,
      );
    }
    if (isPermissionFailure(output)) {
      throw new WorktreeError(
        'not_writable',
        `git worktree add failed at ${path}: target is not writable (${added.stderr.trim().slice(0, 160)})`,
        5,
      );
    }
    throw new WorktreeError(
      'add_failed',
      `git worktree add ${path} failed (exit ${added.exitCode}): ${added.stderr.trim().slice(0, 200)}`,
      1,
    );
  }

  return { agentId, path, branch, warnings, elapsedMs: now() - started };
}
