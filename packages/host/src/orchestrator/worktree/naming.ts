// Worktree naming (issue #45; §44).
// One worktree per writer: branch `kubic/<agent>` at
// `<root>/.kubic/wt/<agent>`. Pure — no I/O, no git.

import { WorktreeError } from './errors.js';

export const AGENT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export const WORKTREE_BRANCH_PREFIX = 'kubic/';

export function validateAgentId(agentId: unknown): string[] {
  if (typeof agentId !== 'string' || agentId.length === 0) {
    return ['agentId must be a non-empty string'];
  }
  if (!AGENT_ID_PATTERN.test(agentId)) {
    return ['agentId must match [A-Za-z0-9_-]+ (no slashes or traversal)'];
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

export function branchForAgent(agentId: string): string {
  assertAgentId(agentId);
  return `${WORKTREE_BRANCH_PREFIX}${agentId}`;
}

export function pathForAgent(repoRoot: string, agentId: string): string {
  if (!repoRoot.startsWith('/')) {
    throw new WorktreeError(
      'invalid_agent',
      'repoRoot must be an absolute path',
      1,
    );
  }
  assertAgentId(agentId);
  return `${repoRoot}/.kubic/wt/${agentId}`;
}

export function parseBranchAgent(branch: string): string | null {
  if (!branch.startsWith(WORKTREE_BRANCH_PREFIX)) return null;
  const agent = branch.slice(WORKTREE_BRANCH_PREFIX.length);
  return validateAgentId(agent).length === 0 ? agent : null;
}
