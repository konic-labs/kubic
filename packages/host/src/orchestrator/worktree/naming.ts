// Worktree naming (issue #45; §44; issue #133: the parent is configurable;
// issue #144: names are scoped by the owning orchestrator session).
// One worktree per writer: branch `kubic/<session>/<agent>` at
// `<root>/<worktreeRoot>/<session>/<agent>` — `.kubic/wt` unless
// `[orchestrator].root` names another workspace-relative parent. The legacy
// unscoped `kubic/<agent>` shape still parses, so `kubic clean` disposes
// trees retained by older runs. Pure — no I/O, no git.

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

// The owning orchestrator session scopes both names (issue #144): worktrees
// are retained until `kubic clean` (§44.1), so a name keyed on the agent id
// alone hands a later run the previous run's stale tree. The session id
// shares the agent id's charset, so it is one path segment and one ref
// component — never a slash or a traversal.
function assertSessionScope(sessionId: string): void {
  if (!AGENT_ID_PATTERN.test(sessionId)) {
    throw new WorktreeError(
      'invalid_agent',
      'invalid session scope: must match [A-Za-z0-9_-]+ (no slashes or traversal)',
      1,
    );
  }
}

// `kubic/<session>/<agent>` when the owning session is named (every
// orchestrate run); the legacy `kubic/<agent>` shape otherwise.
export function branchForAgent(agentId: string, sessionId?: string): string {
  assertAgentId(agentId);
  if (sessionId === undefined) return `${WORKTREE_BRANCH_PREFIX}${agentId}`;
  assertSessionScope(sessionId);
  return `${WORKTREE_BRANCH_PREFIX}${sessionId}/${agentId}`;
}

// `<root>/<worktreeRoot>/<session>/<agent>` when the owning session is named;
// the legacy `<root>/<worktreeRoot>/<agent>` shape otherwise.
export function pathForAgent(
  repoRoot: string,
  agentId: string,
  worktreeRoot: string = DEFAULT_WORKTREE_ROOT,
  sessionId?: string,
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
  if (sessionId === undefined) return resolve(repoRoot, worktreeRoot, agentId);
  assertSessionScope(sessionId);
  return resolve(repoRoot, worktreeRoot, sessionId, agentId);
}

export interface SpawnedBranch {
  agentId: string;
  sessionId?: string;
}

// Both shapes Kubic names: `kubic/<session>/<agent>` and the legacy
// `kubic/<agent>`. Anything deeper, empty, or outside `kubic/` is foreign.
export function parseSpawnedBranch(branch: string): SpawnedBranch | null {
  if (!branch.startsWith(WORKTREE_BRANCH_PREFIX)) return null;
  const parts = branch.slice(WORKTREE_BRANCH_PREFIX.length).split('/');
  if (parts.length === 1) {
    const agentId = parts[0] ?? '';
    return validateAgentId(agentId).length === 0 ? { agentId } : null;
  }
  if (parts.length !== 2) return null;
  const [sessionId = '', agentId = ''] = parts;
  if (!AGENT_ID_PATTERN.test(sessionId)) return null;
  if (validateAgentId(agentId).length > 0) return null;
  return { agentId, sessionId };
}

export function parseBranchAgent(branch: string): string | null {
  return parseSpawnedBranch(branch)?.agentId ?? null;
}
