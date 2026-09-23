// Worktree lifecycle surface (issue #45; §44).
// Re-exports only — no CLI wiring here (composition root owns that).

export type {
  AddWorktreeOptions,
  AddWorktreeResult,
  GapKind,
  UntrackedGapWarning,
} from './add.js';
export {
  addWorktree,
  COLD_ADD_BUDGET_MS,
  detectUntrackedGaps,
  isColdAddWithinBudget,
} from './add.js';
export type {
  CleanDeps,
  CleanOptions,
  CleanPlan,
  JournalPruneResult,
} from './clean.js';
export {
  CLEAN_EXIT_OK,
  CLEAN_EXIT_USAGE,
  parseCleanArgs,
  planClean,
  runCleanCommand,
} from './clean.js';
export {
  isOutsideWorktree,
  OUTSIDE_WRITE_CAPABILITY,
  requireInsideWorktree,
} from './confinement.js';
export type { WorktreeErrorCode } from './errors.js';
export {
  isWorktreeError,
  notARepoError,
  WORKTREE_EXIT_NOT_A_REPO,
  WORKTREE_EXIT_USAGE,
  WorktreeError,
} from './errors.js';
export type { WorktreeEntry } from './list.js';
export { listWorktrees, parseWorktreePorcelain } from './list.js';
export {
  AGENT_ID_PATTERN,
  branchForAgent,
  parseBranchAgent,
  pathForAgent,
  validateAgentId,
  WORKTREE_BRANCH_PREFIX,
} from './naming.js';
export type { RemoveWorktreeResult } from './remove.js';
export { removeWorktree } from './remove.js';
export type {
  MergedWorktree,
  SettledWorktree,
  WorktreeStatus,
} from './status.js';
export { getWorktreeStatus, markMerged, settleWorktree } from './status.js';
