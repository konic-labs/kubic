// Worktree naming (issue #45; §44; issue #133: the parent is configurable).
// One worktree per writer: branch `kubic/<agent>` at
// `<root>/<worktreeRoot>/<agent>` — `.kubic/wt` unless `[orchestrator].root`
// names another workspace-relative parent. Pure — no I/O, no git.

import { resolve } from 'node:path';
import { WorktreeError } from './errors.js';

export const AGENT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export const WORKTREE_BRANCH_PREFIX = 'kubic/';

// The shipped worktree parent, relative to the repo root (§35). The
// configured `[orchestrator].root` replaces it for the spawned set.
export const DEFAULT_WORKTREE_ROOT = '.kubic/wt';

export function validateAgentId(agentId: unknown): string[] {
  if (typeof agentId !== 'string' || agentId.length === 0) {
    return ['agentId must be a non-empty string'];
  }
  if (!AGENT_ID_PATTERN.test(agentId)) {
    return ['agentId must match [A-Za-z0-9_-]+ (no slashes or traversal)'];
  }
  return [];
}

// The configured root is a workspace-relative parent: it never names an
// absolute path, never climbs out with `..`, and never ends in `/`. The
// config load validates first (checkOrchestratorRoot); this guard is the
// path builder's own defense for direct callers.
export function validateWorktreeRoot(worktreeRoot: unknown): string[] {
  if (typeof worktreeRoot !== 'string' || worktreeRoot.length === 0) {
    return ['worktreeRoot must be a non-empty string'];
  }
  if (worktreeRoot.startsWith('/')) {
    return ['worktreeRoot must be a workspace-relative path (no leading /)'];
  }
  if (worktreeRoot.split('/').includes('..')) {
    return ["worktreeRoot must not contain '..' segments"];
  }
  if (worktreeRoot.endsWith('/')) {
    return ["worktreeRoot must not end with '/'"];
  }
  return [];
}

function assertAgentId(agentId: string): void {
  const errors = validateAgentId(agentId);
  if (errors.length > 0) {
    throw new WorktreeError(
      'invalid_agent',
      `invalid agent id: ${errors[0]}`,
      1,
    );
  }
}

function assertWorktreeRoot(worktreeRoot: string): void {
  const errors = validateWorktreeRoot(worktreeRoot);
  if (errors.length > 0) {
    throw new WorktreeError(
      'invalid_root',
      `invalid worktree root: ${errors[0]}`,
      1,
    );
  }
}

export function branchForAgent(agentId: string): string {
  assertAgentId(agentId);
  return `${WORKTREE_BRANCH_PREFIX}${agentId}`;
}

export function pathForAgent(
  repoRoot: string,
  agentId: string,
  worktreeRoot: string = DEFAULT_WORKTREE_ROOT,
): string {
  if (!repoRoot.startsWith('/')) {
    throw new WorktreeError(
      'invalid_agent',
      'repoRoot must be an absolute path',
      1,
    );
  }
  assertAgentId(agentId);
  assertWorktreeRoot(worktreeRoot);
  return resolve(repoRoot, worktreeRoot, agentId);
}

export function parseBranchAgent(branch: string): string | null {
  if (!branch.startsWith(WORKTREE_BRANCH_PREFIX)) return null;
  const agent = branch.slice(WORKTREE_BRANCH_PREFIX.length);
  return validateAgentId(agent).length === 0 ? agent : null;
}
