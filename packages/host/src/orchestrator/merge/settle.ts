// Manager-side settlement guard (issue #46; §9.2).
// The manager merges through workspace_diff / workspace_merge /
// workspace_apply only (+ spawn_agent to launch the writer-resolver).
// Read-only inspection (read/ls/find/grep, git status/diff/log/show)
// authors nothing, so it passes. Everything else — write, edit, bash,
// the git_* authoring tools, or any unknown tool — is a policy block:
// the guard is an ALLOWLIST (fail-closed), never a blocklist. The
// writer resolver owns authoring tools, never the manager. Pure — no I/O.
//
// Layering note: the authoritative production gate is checkManagerCall
// in ../manager.ts (owned by another issue — do NOT widen this file to
// duplicate it). This allowlist is a second-layer merge-path guard
// scoped to AUTHORING: reads pass BY DESIGN — the assert is named
// ZeroWrites because writes are what it forbids. DIVERGENCES, stated
// explicitly: manager.ts forbids read/ls/find/grep on the manager lane
// entirely and allows lane plumbing (send_to_agent, wait_for_agent,
// collect_result, ask_user, ...) that this guard historically did not
// list, while this guard allows reads manager.ts rejects. Both are
// intended: reads author nothing (safe to pass here), and the lane
// plumbing authors nothing either.
//
// Issue #103 (the manager lane goes live): the merge path now asserts over
// the manager's REAL call record — the merge plumbing PLUS the lane's own
// spawn → wait → collect sequence for every worker it drove. Lane plumbing
// is therefore listed here (it never authors), so a completed run's trace
// passes; every authoring tool is still refused, whether or not plumbing
// appears alongside it. Enforcement lives on the real settle apply path
// below, not just in the helper.

import {
  type ApplyDecision,
  decideApplyAfterReview,
  type ReviewResult,
} from './review.js';

export const MANAGER_MERGE_ALLOWLIST: readonly string[] = [
  'spawn_agent',
  'workspace_diff',
  'workspace_merge',
  'workspace_apply',
  // §40 lane plumbing a live manager records while driving its workers
  // (issue #103). Delegation calls only — none of them author.
  'send_to_agent',
  'wait_for_agent',
  'cancel_agent',
  'inspect_agent',
  'collect_result',
  // §70 (issue #188): the verdict routes the merge but authors no
  // workspace bytes — metadata, like a collected result.
  'review_verdict',
  'ask_user',
  'read',
  'ls',
  'find',
  'grep',
  'git_status',
  'git_diff',
  'git_log',
  'git_show',
] as const;

// The explicit authoring set the manager must never touch. Kept as
// documentation and a test anchor — the enforceable gate is
// MANAGER_MERGE_ALLOWLIST above (fail-closed: anything not listed
// throws, whether or not it appears here).
export const MANAGER_WRITE_TOOLS: readonly string[] = [
  'write',
  'edit',
  'bash',
  'git_stage',
  'git_commit',
  'git_checkpoint',
  'git_branch',
] as const;

export class ManagerAuthoringError extends Error {
  constructor(toolName: string) {
    super(
      `manager policy block: '${toolName}' authors — the resolver writes, never the manager`,
    );
    this.name = 'ManagerAuthoringError';
  }
}

export function assertManagerZeroWrites(managerCalls: readonly string[]): void {
  for (const call of managerCalls) {
    if (!MANAGER_MERGE_ALLOWLIST.includes(call)) {
      throw new ManagerAuthoringError(call);
    }
  }
}

// The settle apply path: the ONLY merge-path entry to workspace_apply.
// The recorded manager call trace is proven write-free BEFORE the
// verdict routes to apply — a tainted trace throws and apply never
// runs. (Outer gate: checkManagerCall in ../manager.ts owns the
// production lane; this enforces the merge path itself.) Pure — the
// caller owns the actual workspace_apply call behind `apply`.
export function applySettlementAfterReview(
  managerCalls: readonly string[],
  review: ReviewResult,
  apply: () => void,
): ApplyDecision {
  assertManagerZeroWrites(managerCalls);
  const decision = decideApplyAfterReview(review);
  if (decision === 'apply') {
    apply();
  }
  return decision;
}
