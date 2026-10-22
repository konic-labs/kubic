// Structured git operations.
// Git runs THROUGH the shell seam (spawn('git', ...) — no shell, no
// string commands), so provenance and the Fake script map apply as usual.
// This module never runs `git init`: repos are never created on the
// agent's behalf. Outside a repository every git op fails with the
// structured code `not_a_repo` (unavailable-with-reason) — the
// journal path keeps working without git (VCS-independent).

export { parsePorcelainStatus } from './porcelain.js';
export type {
  GitConflictStatusResult,
  GitDiffResult,
  GitLogResult,
  GitShowResult,
  GitStatusResult,
  GitWorktreeListResult,
} from './read-ops.js';
export {
  gitConflictStatusOperation,
  gitDiffOperation,
  gitLogOperation,
  gitShowOperation,
  gitStatusOperation,
  gitWorktreeListOperation,
} from './read-ops.js';

export type {
  GitBranchResult,
  GitCheckpointResult,
  GitCommitResult,
  GitMergeResult,
  GitStageResult,
} from './write-ops.js';
export {
  gitBranchOperation,
  gitCheckpointOperation,
  gitCommitOperation,
  gitMergeOperation,
  gitStageOperation,
} from './write-ops.js';
